// Instrument maths that does not depend on the UI: power meter, logic analyzer,
// AC/DC multimeter modes and the curve tracer's test fixtures.
import { isVirtual, placedPins, type Doc, type Part } from "@/editor/model"
import type { Netlist } from "@/editor/netlist"
import type { JobResult } from "@/lib/engine"
import { db } from "@/lib/measure"
import type { AcResult } from "@/lib/engine"
import { optionsLine, parseValue, resolveSim, type SpiceNetlist } from "@/lib/spice"

// ---------------------------------------------------------------- multimeter modes

export type MeterMode = "vdc" | "vac" | "adc" | "aac"

/** Time-weighted mean over the run (trapezoids, so uneven steps are fair). */
export function mean(t: number[], y: number[]): number {
  if (t.length < 2) return y[0] ?? NaN
  let s = 0
  for (let i = 1; i < t.length; i++) s += ((y[i] + y[i - 1]) / 2) * (t[i] - t[i - 1])
  return s / (t[t.length - 1] - t[0])
}

/** RMS of the AC part (what a true-RMS meter shows in V~ / A~). */
export function acRms(t: number[], y: number[]): number {
  if (t.length < 2) return 0
  const m = mean(t, y)
  let s = 0
  for (let i = 1; i < t.length; i++) {
    const a = y[i - 1] - m, b = y[i] - m
    s += ((a * a + a * b + b * b) / 3) * (t[i] - t[i - 1])
  }
  return Math.sqrt(s / (t[t.length - 1] - t[0]))
}

// ---------------------------------------------------------------- power meter

export interface PowerRow {
  ref: string
  kind: string
  /** dissipated (+) or delivered (−, sources), W */
  avg: number
  peak: number
  rating?: number
  /** avg / rating */
  load?: number
}

/** Voltage of a pin's net at every sample (0 for ground). */
function pinWave(r: Extract<JobResult, { type: "tran" | "dc" }> | Extract<JobResult, { type: "op" }>, net: string | undefined): number[] | null {
  if (!net) return null
  const n = r.type === "op" ? 1 : r.type === "tran" ? r.time.length : r.sweep.length
  if (net === "0") return new Array(n).fill(0)
  const k = r.names.indexOf(`V(${net})`)
  if (k < 0) return null
  return r.type === "op" ? [r.values[k]] : r.data[k]
}

/**
 * Power of every part with a known current: two-terminal parts (V × I),
 * BJTs (Vce·Ic + Vbe·Ib) and FETs (Vds·Id). Sources report delivered power as negative.
 */
export function powerTable(doc: Doc, nl: Netlist, r: JobResult | null): PowerRow[] {
  if (!r || r.type === "ac") return []
  const rows: PowerRow[] = []
  const t = r.type === "tran" ? r.time : null
  const sig = (name: string) => {
    const k = r.names.indexOf(name)
    if (k < 0) return null
    return r.type === "op" ? [r.values[k]] : r.data[k]
  }
  const seen = new Set<string>()
  for (const part of doc.parts) {
    if (isVirtual(part) || seen.has(part.ref)) continue
    const sim = resolveSim(part)
    if (!sim || "error" in sim) continue
    seen.add(part.ref)
    const pinNet = (role: string) => {
      const pin = Object.entries(sim.pins).find(([, v]) => v === role)?.[0]
      return pin ? nl.pinNet.get(`${part.ref}.${pin}`) : undefined
    }
    let p: number[] | null = null
    if (["R", "C", "L", "D", "V", "I"].includes(sim.kind)) {
      const pins = placedPins(part)
      if (pins.length !== 2) continue
      const i = sig(`I(${part.ref})`)
      // SPICE pin order: positive role first (1, A, +)
      const roles = Object.values(sim.pins)
      const posRole = roles.find((x) => /^(1|A|\+|pos)$/i.test(x)) ?? roles[0]
      const negRole = roles.find((x) => x !== posRole) ?? roles[1]
      const va = pinWave(r as never, pinNet(posRole)), vb = pinWave(r as never, pinNet(negRole))
      if (!i || !va || !vb) continue
      p = i.map((x, j) => (va[j] - vb[j]) * x)
    } else if (sim.kind === "NPN" || sim.kind === "PNP") {
      const ic = sig(`Ic(${part.ref})`), ib = sig(`Ib(${part.ref})`)
      const vc = pinWave(r as never, pinNet("C")), vb = pinWave(r as never, pinNet("B")), ve = pinWave(r as never, pinNet("E"))
      if (!ic || !vc || !ve) continue
      p = ic.map((x, j) => (vc[j] - ve[j]) * x + (ib && vb ? (vb[j] - ve[j]) * ib[j] : 0))
    } else if (/MOS|JFET/.test(sim.kind)) {
      const id = sig(`Id(${part.ref})`)
      const vd = pinWave(r as never, pinNet("D")), vs = pinWave(r as never, pinNet("S"))
      if (!id || !vd || !vs) continue
      p = id.map((x, j) => (vd[j] - vs[j]) * x)
    }
    if (!p) continue
    const avg = t ? mean(t, p) : p[0]
    const peak = p.reduce((m, x) => (Math.abs(x) > Math.abs(m) ? x : m), 0)
    const rating = sim.kind === "R" ? parseValue(part.fields?.Power ?? "0.25") ?? 0.25 : undefined
    rows.push({ ref: part.ref, kind: sim.kind, avg, peak, rating, load: rating ? Math.abs(avg) / rating : undefined })
  }
  return rows.sort((a, b) => Math.abs(b.avg) - Math.abs(a.avg))
}

// ---------------------------------------------------------------- logic analyzer

export interface LogicChannel {
  signal: string
  threshold: number
  /** level changes: [time, level] starting at t0 */
  steps: [number, 0 | 1][]
  edges: number
  freq: number
  duty: number
}

/** Threshold a waveform into 0/1 with hysteresis (±5 % of the swing). */
export function toLogic(signal: string, t: number[], y: number[], threshold?: number): LogicChannel {
  const lo = Math.min(...y), hi = Math.max(...y)
  const th = threshold ?? (lo + hi) / 2
  const hyst = Math.max((hi - lo) * 0.05, 1e-9)
  let level: 0 | 1 = y[0] > th ? 1 : 0
  const steps: [number, 0 | 1][] = [[t[0], level]]
  const rising: number[] = []
  let highTime = 0, lastT = t[0]
  for (let i = 1; i < t.length; i++) {
    const next: 0 | 1 = level ? (y[i] < th - hyst ? 0 : 1) : (y[i] > th + hyst ? 1 : 0)
    if (next !== level) {
      // interpolate the crossing time
      const f = (th - y[i - 1]) / (y[i] - y[i - 1] || 1)
      const tc = t[i - 1] + Math.min(1, Math.max(0, f)) * (t[i] - t[i - 1])
      if (level) highTime += tc - lastT
      lastT = tc
      level = next
      steps.push([tc, level])
      if (level) rising.push(tc)
    }
  }
  if (level) highTime += t[t.length - 1] - lastT
  const periods = rising.length >= 2 ? (rising[rising.length - 1] - rising[0]) / (rising.length - 1) : NaN
  // duty over whole periods only, when there are some
  let duty = highTime / (t[t.length - 1] - t[0])
  if (rising.length >= 2) {
    let hiT = 0
    for (let k = 0; k < steps.length; k++) {
      const [ts, lv] = steps[k]
      const te = steps[k + 1]?.[0] ?? t[t.length - 1]
      const a = Math.max(ts, rising[0]), b = Math.min(te, rising[rising.length - 1])
      if (lv && b > a) hiT += b - a
    }
    duty = hiT / (rising[rising.length - 1] - rising[0])
  }
  return { signal, threshold: th, steps, edges: steps.length - 1, freq: 1 / periods, duty }
}

// ---------------------------------------------------------------- curve tracer

export type TracerKind = "R" | "D" | "Z" | "NPN" | "PNP" | "NMOS" | "PMOS" | "NJFET" | "PJFET"

export interface TracerDeck {
  ref: string
  kind: TracerKind
  /** netlist for ngspice, nodes / elements for name mapping */
  net: SpiceNetlist
  x: string
  y: string
  /** multiply y by this (branch currents point into the source) */
  ySign: number
  xUnit: string
  yUnit: string
  xLabel: string
  yLabel: string
  /** one label per curve (outer sweep), or a single curve */
  curves: string[]
}

/** Which parts the curve tracer can measure. */
export function tracerKind(part: Part): TracerKind | null {
  const sim = resolveSim(part)
  if (!sim || "error" in sim) return null
  if (sim.kind === "R" && sim.type !== "POT") return "R"
  if (sim.kind === "D") return /zener/i.test(part.lib) || /^D_Zener/i.test(part.lib.split(":")[1] ?? "") ? "Z" : "D"
  if (["NPN", "PNP", "NMOS", "PMOS", "NJFET", "PJFET"].includes(sim.kind)) return sim.kind as TracerKind
  return null
}

const range = (a: number, b: number, s: number) => { const out: number[] = []; for (let v = a; s > 0 ? v <= b + s / 2 : v >= b + s / 2; v += s) out.push(Number(v.toPrecision(6))); return out }

/**
 * A test fixture around one part of the circuit (its model and value as used in
 * the circuit): sweep sources on its pins and read the current, like a curve tracer.
 */
export function tracerDeck(circuit: SpiceNetlist, part: Part): TracerDeck | null {
  const kind = tracerKind(part)
  if (!kind) return null
  const name = [...circuit.elements].find(([, ref]) => ref === part.ref)?.[0]
  if (!name) return null
  const lines = circuit.text.split("\n")
  const el = lines.find((l) => l.split(/\s+/)[0]?.toUpperCase() === name)
  if (!el) return null
  const tok = el.split(/\s+/)
  const models = lines.filter((l) => /^\.model\s/i.test(l))
  const head = [`* curve tracer · ${part.ref}`, optionsLine("op", { saveCurrents: false }), ...models]
  const mk = (body: string[], nodes: string[], elements: string[]): SpiceNetlist => ({
    text: [...head, ...body].join("\n"),
    nodes: new Map(nodes.map((n) => [n, n])), elements: new Map(elements.map((e) => [e.toUpperCase(), e.toUpperCase()])),
    issues: [], simulated: 1,
  })
  const base = { ref: part.ref, kind }
  switch (kind) {
    case "R": {
      const body = [`${tok[0]} t 0 ${tok.slice(3).join(" ")}`, "VT t 0 0", ".dc VT -5 5 0.05"]
      return { ...base, net: mk(body, ["t"], ["VT"]), x: "V(t)", y: "I(VT)", ySign: -1, xUnit: "V", yUnit: "A", xLabel: "V", yLabel: "I", curves: [part.ref] }
    }
    case "D": case "Z": {
      // current drive (like a tracer's current limit): forward 0 → 50 mA; Zeners also in reverse
      const body = [`${tok[0]} a 0 ${tok.slice(3).join(" ")}`, "IT 0 a 0", kind === "Z" ? ".dc IT -30m 50m 0.25m" : ".dc IT 0 50m 0.1m"]
      return { ...base, net: mk(body, ["a"], ["IT"]), x: "V(a)", y: "SWEEP", ySign: 1, xUnit: "V", yUnit: "A", xLabel: "V_F", yLabel: "I_F", curves: [part.ref] }
    }
    case "NPN": case "PNP": {
      const s = kind === "NPN" ? 1 : -1
      const ib = range(10e-6, 50e-6, 10e-6)
      const body = [`${tok[0]} c b 0 ${tok.slice(4).join(" ")}`, "VCE c 0 0", "IB 0 b 0", `.dc VCE 0 ${10 * s} ${0.05 * s} IB ${10e-6 * s} ${50e-6 * s} ${10e-6 * s}`]
      return { ...base, net: mk(body, ["c", "b"], ["VCE"]), x: "SWEEP", y: "I(VCE)", ySign: -s, xUnit: "V", yUnit: "A", xLabel: "V_CE", yLabel: "I_C", curves: ib.map((v) => `I_B = ${Math.round(v * 1e6)} µA`) }
    }
    case "NMOS": case "PMOS": {
      const s = kind === "NMOS" ? 1 : -1
      const four = tok.length >= 6 && !/=/.test(tok[5]) && tok[5] !== undefined && lines.some((l) => /^\.model\s/i.test(l) && l.split(/\s+/)[1] === tok[5])
      const vgs = range(0, 10, 1)
      const body = [`${tok[0]} d g 0 ${four ? "0 " : ""}${tok.slice(four ? 5 : 4).join(" ")}`, "VDS d 0 0", "VGS g 0 0", `.dc VDS 0 ${10 * s} ${0.05 * s} VGS 0 ${10 * s} ${1 * s}`]
      return { ...base, net: mk(body, ["d", "g"], ["VDS"]), x: "SWEEP", y: "I(VDS)", ySign: -s, xUnit: "V", yUnit: "A", xLabel: "V_DS", yLabel: "I_D", curves: vgs.map((v) => `V_GS = ${v * s} V`) }
    }
    case "NJFET": case "PJFET": {
      const s = kind === "NJFET" ? 1 : -1
      const vgs = range(-3, 0, 0.5)
      const body = [`${tok[0]} d g 0 ${tok.slice(4).join(" ")}`, "VDS d 0 0", "VGS g 0 0", `.dc VDS 0 ${15 * s} ${0.1 * s} VGS ${-3 * s} 0 ${0.5 * s}`]
      return { ...base, net: mk(body, ["d", "g"], ["VDS"]), x: "SWEEP", y: "I(VDS)", ySign: -s, xUnit: "V", yUnit: "A", xLabel: "V_DS", yLabel: "I_D", curves: vgs.map((v) => `V_GS = ${v * s} V`) }
    }
  }
}

/** Split a nested DC sweep (inner sweep restarts for every outer value) into curves. */
export function splitSweep(sweep: number[]): [number, number][] {
  const out: [number, number][] = []
  let start = 0
  const dir = Math.sign((sweep[1] ?? 0) - (sweep[0] ?? 0)) || 1
  for (let i = 1; i < sweep.length; i++) {
    if (Math.sign(sweep[i] - sweep[i - 1]) === -dir) { out.push([start, i]); start = i }
  }
  out.push([start, sweep.length])
  return out
}

/** Curves of a tracer run: x and y per curve. */
export function tracerCurves(deck: TracerDeck, r: JobResult): { label: string; x: number[]; y: number[] }[] {
  if (r.type !== "dc") return []
  const get = (s: string) => (s === "SWEEP" ? r.sweep : r.data[r.names.indexOf(s)] ?? null)
  const xs = get(deck.x), ys = get(deck.y)
  if (!xs || !ys) return []
  return splitSweep(r.sweep).map(([a, b], k) => ({ label: deck.curves[k] ?? `curve ${k + 1}`, x: xs.slice(a, b), y: ys.slice(a, b).map((v) => v * deck.ySign) }))
}

// ---------------------------------------------------------------- Bode

/** Gain (dB), unwrapped phase (°), passband edges and roll-off of a transfer function. */
export function response(freq: number[], ac: Pick<AcResult, "re" | "im">, ko: number, ki = -1) {
  const gain: number[] = [], phase: number[] = []
  let prev = 0
  for (let j = 0; j < freq.length; j++) {
    let re = ac.re[ko][j], im = ac.im[ko][j]
    if (ki >= 0) {
      const a = ac.re[ki][j], b = ac.im[ki][j], d = a * a + b * b || 1e-300
      ;[re, im] = [(re * a + im * b) / d, (im * a - re * b) / d]
    }
    gain.push(db(re, im))
    // unwrap: keep the phase continuous instead of jumping ±360°
    let ph = (Math.atan2(im, re) * 180) / Math.PI
    if (j) while (ph - prev > 180) ph -= 360
    if (j) while (ph - prev < -180) ph += 360
    phase.push(ph); prev = ph
  }
  const peakAt = gain.reduce((m, g, j) => (g > gain[m] ? j : m), 0)
  const target = gain[peakAt] - 3.0103
  const cross = (j0: number, j1: number) => {
    const fr = (target - gain[j0]) / (gain[j1] - gain[j0])
    return 10 ** (Math.log10(freq[j0]) + fr * (Math.log10(freq[j1]) - Math.log10(freq[j0])))
  }
  let fL = NaN, fH = NaN
  for (let j = peakAt; j > 0; j--) if (gain[j] >= target && gain[j - 1] < target) { fL = cross(j - 1, j); break }
  for (let j = peakAt; j < freq.length - 1; j++) if (gain[j] >= target && gain[j + 1] < target) { fH = cross(j, j + 1); break }
  const at = (f: number) => { let j = 1; while (j < freq.length - 1 && freq[j] < f) j++; return gain[j] }
  const slope = Number.isFinite(fH) && fH * 30 < freq[freq.length - 1] ? at(fH * 30) - at(fH * 3) : NaN
  return { gain, phase, peak: gain[peakAt], fL, fH, fc: Number.isFinite(fH) ? fH : fL, slope, order: Number.isFinite(slope) ? Math.max(1, Math.round(-slope / 20)) : NaN }
}

