// What happened to every part during a run: voltage across it, current through it, power, and
// a stress check against its maximum ratings (like PSpice "Smoke"): value ÷ (rating × derating)
// → ok below 90 %, warn 90–100 %, over above 100 %.
import { displayRef, isVirtual, type Doc, type Part } from "@/editor/model"
import type { Netlist } from "@/editor/netlist"
import type { JobResult } from "./engine"
import { outputKind } from "@/editor/outputs"
import { SENSOR_MODELS } from "./sensors"
import { parseValue, resolveSim } from "./spice"

export interface Stats { min: number; max: number; avg: number; rms: number; peak: number }
export type Status = "ok" | "warn" | "over"
export interface Check { what: string; value: number; limit: number; unit: string; pct: number; status: Status; basis: string }
export interface PartReport {
  ref: string
  label: string
  /** voltage across the part (Vce / Vds for transistors) */
  v: Stats | null
  /** current through it (Ic / Id for transistors) */
  i: Stats | null
  /** power it dissipates (a source: power it delivers, negative) */
  p: Stats | null
  checks: Check[]
  worst: Status | null
}

export function stats(y: number[], time?: number[]): Stats {
  const n = y.length
  if (!n) return { min: NaN, max: NaN, avg: NaN, rms: NaN, peak: NaN }
  let min = Infinity, max = -Infinity
  for (const v of y) { if (v < min) min = v; if (v > max) max = v }
  // time-weighted average and rms (ngspice steps are uneven)
  let avg = y[0], rms = Math.abs(y[0])
  if (time && n > 1 && time[n - 1] > time[0]) {
    let a = 0, q = 0
    for (let k = 1; k < n; k++) { const dt = time[k] - time[k - 1]; a += ((y[k] + y[k - 1]) / 2) * dt; q += ((y[k] ** 2 + y[k - 1] ** 2) / 2) * dt }
    const T = time[n - 1] - time[0]
    avg = a / T; rms = Math.sqrt(q / T)
  } else if (n > 1) {
    avg = y.reduce((s, v) => s + v, 0) / n; rms = Math.sqrt(y.reduce((s, v) => s + v * v, 0) / n)
  }
  return { min, max, avg, rms, peak: Math.max(Math.abs(min), Math.abs(max)) }
}

// ---------------------------------------------------------------- ratings (typical datasheet maxima)

const BJT: Record<string, [ic: number, vce: number, pd: number]> = {
  "2N3904": [0.2, 40, 0.625], "2N3906": [0.2, 40, 0.625], "2N2222": [0.6, 40, 0.5], "2N2907": [0.6, 40, 0.4], "2N4401": [0.6, 40, 0.625], "2N4403": [0.6, 40, 0.625],
  BC547: [0.1, 45, 0.5], BC557: [0.1, 45, 0.5], BD139: [1.5, 80, 12.5], BD140: [1.5, 80, 12.5], TIP31: [3, 40, 40], TIP32: [3, 40, 40],
}
/** MOSFETs: free-air power (no heatsink) */
const MOS: Record<string, [id: number, vds: number, pd: number]> = {
  "2N7000": [0.2, 60, 0.4], BS170: [0.5, 60, 0.83], BSS138: [0.22, 50, 0.36], BSS84: [0.13, 50, 0.36],
  IRF540N: [33, 100, 2], IRFZ44N: [49, 55, 2], IRLZ44N: [47, 55, 2], IRF9540: [23, 100, 2], IRF9Z34N: [19, 55, 2],
}
function diodeLimits(p: Part, led: boolean): [ifMax: number, vr: number] {
  if (led) return [0.03, 5]
  const v = `${p.value} ${p.lib}`.toUpperCase()
  const m = /1N400([1-7])/.exec(v)
  if (m) return [1, [50, 100, 200, 400, 600, 800, 1000][Number(m[1]) - 1]]
  if (/1N4148|1N914/.test(v)) return [0.3, 75]
  if (/1N581([7-9])/.test(v)) return [1, { 7: 20, 8: 30, 9: 40 }[Number(/1N581([7-9])/.exec(v)![1]) as 7 | 8 | 9]]
  if (/BAT54/.test(v)) return [0.2, 30]
  return [1, 50]
}

// ---------------------------------------------------------------- reports

export function partReports(doc: Doc, nl: Netlist, r: JobResult, derating = 1): PartReport[] {
  if (r.type === "ac") return []
  const time = r.type === "tran" ? r.time : undefined
  const series = (name: string): number[] | null => {
    const k = r.names.indexOf(name)
    if (k < 0) return null
    return r.type === "op" ? [r.values[k]] : r.data[k]
  }
  const node = (net: string | undefined): number[] | null => (net === undefined ? null : net === "0" ? null : series(`V(${net})`))
  const across = (a: string | undefined, b: string | undefined): number[] | null => {
    const va = a === "0" ? "zero" : node(a), vb = b === "0" ? "zero" : node(b)
    if (!va || !vb) return null
    const len = Math.max(va === "zero" ? 0 : va.length, vb === "zero" ? 0 : vb.length, 1)
    return Array.from({ length: len }, (_, k) => (va === "zero" ? 0 : va[k]) - (vb === "zero" ? 0 : vb[k]))
  }
  const mul = (a: number[] | null, b: number[] | null) => (a && b ? a.map((x, k) => x * (b[k] ?? b[b.length - 1])) : null)
  const st = (y: number[] | null) => (y ? stats(y, time) : null)
  const check = (what: string, value: number, limit: number, unit: string, basis: string): Check => {
    const pct = (Math.abs(value) / (limit * derating)) * 100
    return { what, value: Math.abs(value), limit: limit * derating, unit, pct, status: pct > 100 ? "over" : pct >= 90 ? "warn" : "ok", basis }
  }

  const out: PartReport[] = []
  const done = new Set<string>()
  for (const part of doc.parts) {
    if (isVirtual(part) || done.has(part.ref)) continue
    const sim = resolveSim(part)
    if (!sim || "error" in sim) continue
    done.add(part.ref)
    const ref = displayRef(part)
    const pinOf = (role: string) => Object.entries(sim.pins).find(([, ro]) => ro.toLowerCase() === role.toLowerCase())?.[0]
    const net = (role: string) => { const pin = pinOf(role); return pin ? nl.pinNet.get(`${part.ref}.${pin}`) : undefined }
    const roles = Object.values(sim.pins)
    const checks: Check[] = []
    let v: number[] | null = null, i: number[] | null = null, pw: number[] | null = null, label = part.value

    switch (sim.kind) {
      case "R": {
        v = sim.type === "POT" ? across(net("r0"), net("r1")) : across(net(roles[0]), net(roles[1]))
        i = series(`I(${part.ref})`)
        pw = sim.type === "POT" ? mul(across(net("r0"), net("wiper")), i) : mul(v, i)
        // loads simulated as a resistance (motor winding, lamp filament, speaker coil): power only, no resistor rating
        const load = outputKind(part)
        if (load && load !== "led") { label = { motor: "DC motor", lamp: "Lamp", speaker: "Speaker", buzzer: "Buzzer" }[load]; break }
        label = sim.type === "LDR" ? "Light sensor (LDR)" : sim.type === "NTC" ? `NTC thermistor ${part.value}` : sim.type === "PTC" ? `PTC thermistor ${part.value}` : sim.type === "POT" ? `Potentiometer ${part.value}` : `Resistor ${part.value}`
        const rated = parseValue(part.fields?.Power ?? "") ?? 0.25
        const ps = st(pw)
        if (ps) checks.push(check("Power", ps.avg, rated, "W", part.fields?.Power ? "rated power" : "typical ¼ W"))
        break
      }
      case "C": {
        v = across(net(roles[0]), net(roles[1])); i = series(`I(${part.ref})`); pw = mul(v, i)
        label = `Capacitor ${part.value}`
        const rated = parseValue(part.fields?.Voltage ?? "") ?? 50
        const vs = st(v)
        if (vs) checks.push(check("Voltage", vs.peak, rated, "V", part.fields?.Voltage ? "rated voltage" : "typical 50 V"))
        if (vs && /Polarized/.test(part.lib) && vs.min < -0.5) checks.push({ what: "Reverse voltage", value: -vs.min, limit: 0.5, unit: "V", pct: (-vs.min / 0.5) * 100, status: "over", basis: "electrolytic: no reverse voltage" })
        break
      }
      case "L": { v = across(net(roles[0]), net(roles[1])); i = series(`I(${part.ref})`); pw = mul(v, i); label = `Inductor ${part.value}`; break }
      case "D": {
        v = across(net("A"), net("K")); i = series(`I(${part.ref})`); pw = mul(v, i)
        const led = /LED/i.test(part.lib)
        label = led ? `LED ${part.value}` : /Photo/.test(part.lib) ? "Photodiode" : `Diode ${part.value}`
        const [ifMax, vr] = diodeLimits(part, led)
        const is = st(i), vs = st(v)
        if (is) checks.push(check("Forward current", Math.max(is.max, 0), ifMax, "A", led ? "typical LED 30 mA" : "datasheet"))
        if (vs) checks.push(check("Reverse voltage", Math.max(-vs.min, 0), vr, "V", led ? "typical LED 5 V" : "datasheet"))
        break
      }
      case "NPN": case "PNP": {
        v = across(net("C"), net("E")); i = series(`Ic(${part.ref})`)
        const ib = series(`Ib(${part.ref})`), vbe = across(net("B"), net("E"))
        const ic0 = i
        pw = v && ic0 ? v.map((x, k) => Math.abs(x * ic0[k]) + (ib && vbe ? Math.abs(ib[k] * vbe[k]) : 0)) : null
        const [ic, vce, pd] = BJT[part.value.toUpperCase()] ?? [0.2, 40, 0.5]
        label = `${sim.kind} ${part.value}`
        const is = st(i), vs = st(v), ps = st(pw)
        if (is) checks.push(check("Collector current", is.peak, ic, "A", BJT[part.value.toUpperCase()] ? "datasheet" : "typical small-signal"))
        if (vs) checks.push(check("Collector–emitter voltage", vs.peak, vce, "V", "datasheet"))
        if (ps) checks.push(check("Power", ps.avg, pd, "W", "datasheet"))
        break
      }
      case "NMOS": case "PMOS": {
        v = across(net("D"), net("S")); i = series(`Id(${part.ref})`); pw = mul(v, i)?.map(Math.abs) ?? null
        const [id, vds, pd] = MOS[part.value.toUpperCase()] ?? [0.2, 60, 0.4]
        label = `${sim.kind} ${part.value}`
        const is = st(i), vs = st(v), ps = st(pw)
        if (is) checks.push(check("Drain current", is.peak, id, "A", "datasheet"))
        if (vs) checks.push(check("Drain–source voltage", vs.peak, vds, "V", "datasheet"))
        if (ps) checks.push(check("Power", ps.avg, pd, "W", "free air, no heatsink"))
        break
      }
      case "V": case "I": {
        const pos = roles.includes("+") ? "+" : roles[0], neg = roles.includes("-") ? "-" : roles[1]
        v = across(net(pos), net(neg)); i = series(`I(${part.ref})`)
        // ngspice: positive current flows into + through the source, so a source delivering power has P < 0
        pw = mul(v, i)
        label = sim.env === "sound" ? "Microphone" : sim.kind === "V" ? `Voltage source ${part.value}` : `Current source ${part.value}`
        break
      }
      case "SWITCH": { v = across(net("1"), net("2")); i = series(`I(${part.ref})`); pw = mul(v, i); label = "Switch"; break }
      case "SENSOR": {
        const m = SENSOR_MODELS.find((x) => x.id === sim.type)
        label = m?.label ?? "Sensor"
        if (m?.shape === "resistive") { v = across(net(roles[0]), net(roles[1])); i = series(`I(${part.ref})`); pw = mul(v, i) }
        else if (m?.shape === "current") { v = across(net("out"), net("gnd")); i = series(`I(${part.ref})`) }
        else v = across(net("out"), net("gnd"))
        break
      }
      default: label = part.value
    }
    const report: PartReport = { ref, label, v: st(v), i: st(i), p: st(pw), checks, worst: null }
    report.worst = checks.reduce<Status | null>((w, c) => (c.status === "over" || w === "over" ? "over" : c.status === "warn" || w === "warn" ? "warn" : "ok"), null)
    out.push(report)
  }
  // most stressed first
  const rank = (r: PartReport) => (r.worst === "over" ? 0 : r.worst === "warn" ? 1 : r.worst === "ok" ? 2 : 3)
  return out.sort((a, b) => rank(a) - rank(b) || Math.max(0, ...b.checks.map((c) => c.pct)) - Math.max(0, ...a.checks.map((c) => c.pct)))
}
