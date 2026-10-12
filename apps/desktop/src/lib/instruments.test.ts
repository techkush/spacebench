import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
import { beforeAll, describe, expect, it } from "vitest"

import { loadExample } from "@/editor/examples"
import type { Doc } from "@/editor/model"
import { deriveNetlist } from "@/editor/netlist"
import { remap, type JobResult } from "@/lib/engine"
import { setLoader } from "@/lib/kicad"
import { buildNetlist, type SpiceNetlist } from "@/lib/spice"
import { run } from "../../vite-ngspice"
import { acRms, mean, powerTable, response, toLogic, tracerCurves, tracerDeck } from "./instruments"

const KICAD = path.resolve(import.meta.dirname, "../../public/kicad")
setLoader(async (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(KICAD, `${f}.gz`))).toString()))
const ngspice = ["/opt/homebrew/bin/ngspice", "/usr/local/bin/ngspice", "/usr/bin/ngspice"].find((p) => fs.existsSync(p))

async function sim(net: SpiceNetlist): Promise<JobResult> {
  const r = await run(net.text)
  if (r.status !== 200) throw new Error(r.body)
  return remap(JSON.parse(r.body) as JobResult, net)
}

const docs: Record<string, Doc> = {}
beforeAll(async () => { for (const id of ["led", "ce-amp", "555-astable", "half-wave"]) docs[id] = await loadExample(id) })

describe("meter maths", () => {
  const t = Array.from({ length: 2001 }, (_, i) => i * 1e-5) // 20 ms = 20 periods of 1 kHz
  it("AC RMS of a 1 V sine on a 2 V offset is 0.707 V; the mean is 2 V", () => {
    const y = t.map((x) => 2 + Math.sin(2 * Math.PI * 1e3 * x))
    expect(acRms(t, y)).toBeCloseTo(Math.SQRT1_2, 3)
    expect(mean(t, y)).toBeCloseTo(2, 3)
  })
  it("logic analyzer: 1 kHz square at 25 % duty", () => {
    const y = t.map((x) => ((x * 1e3) % 1 < 0.25 ? 5 : 0))
    const ch = toLogic("V(x)", t, y)
    expect(ch.threshold).toBeCloseTo(2.5)
    expect(ch.freq).toBeCloseTo(1000, -1)
    expect(ch.duty).toBeCloseTo(0.25, 2)
    expect(ch.edges).toBeGreaterThanOrEqual(38)
  })
})

describe("Bode response", () => {
  const f = Array.from({ length: 241 }, (_, i) => 10 ** (1 + i / 40)) // 10 Hz … 1 MHz
  const tf = (h: (s: { re: number; im: number }) => { re: number; im: number }) => {
    const re: number[] = [], im: number[] = []
    for (const x of f) { const v = h({ re: 0, im: x }); re.push(v.re); im.push(v.im) }
    return { re: [re], im: [im] }
  }
  it("first-order low-pass: f_H = fc, −20 dB/dec, phase → −90°", () => {
    // H = 1 / (1 + j f / 1 kHz)
    const r = response(f, tf((s) => { const d = 1 + (s.im / 1e3) ** 2; return { re: 1 / d, im: -(s.im / 1e3) / d } }), 0)
    expect(r.fH).toBeGreaterThan(980); expect(r.fH).toBeLessThan(1020)
    expect(Number.isNaN(r.fL)).toBe(true)
    expect(r.slope).toBeGreaterThan(-21); expect(r.slope).toBeLessThan(-18)
    expect(r.order).toBe(1)
    expect(r.phase[r.phase.length - 1]).toBeLessThan(-85)
  })
  it("inverting band-pass: both edges, and the phase does not jump by 360°", () => {
    // H = −10 · (j f/100) / (1 + j f/100) · 1 / (1 + j f/100k)
    const mul = (a: { re: number; im: number }, b: { re: number; im: number }) => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re })
    const div = (a: { re: number; im: number }, b: { re: number; im: number }) => { const d = b.re ** 2 + b.im ** 2; return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d } }
    const r = response(f, tf((s) => {
      const hp = div({ re: 0, im: s.im / 100 }, { re: 1, im: s.im / 100 })
      const lp = div({ re: 1, im: 0 }, { re: 1, im: s.im / 1e5 })
      return mul({ re: -10, im: 0 }, mul(hp, lp))
    }), 0)
    expect(r.peak).toBeCloseTo(20, 0)
    expect(r.fL).toBeGreaterThan(95); expect(r.fL).toBeLessThan(106)
    expect(r.fH).toBeGreaterThan(95e3); expect(r.fH).toBeLessThan(106e3)
    for (let j = 1; j < r.phase.length; j++) expect(Math.abs(r.phase[j] - r.phase[j - 1])).toBeLessThan(30)
  })
})

describe.skipIf(!ngspice)("instruments on ngspice", () => {
  it("power meter: the LED circuit balances (supply = R + LED)", async () => {
    const d = docs.led, nl = deriveNetlist(d)
    const r = await sim(buildNetlist(d, nl, "op"))
    const rows = powerTable(d, nl, r)
    const src = rows.filter((x) => x.kind === "V").reduce((s, x) => s + x.avg, 0)
    const dissipated = rows.filter((x) => x.kind !== "V").reduce((s, x) => s + x.avg, 0)
    expect(rows.map((x) => x.kind).sort()).toEqual(["D", "R", "V"])
    expect(src).toBeLessThan(0) // a source delivers
    expect(dissipated).toBeGreaterThan(0.04)
    expect(Math.abs(src + dissipated)).toBeLessThan(1e-6)
    const resistor = rows.find((x) => x.kind === "R")!
    expect(resistor.load).toBeGreaterThan(0) // vs its 0.25 W rating
  })
  it("curve tracer: 2N3904 output curves — Ic ≈ β·Ib in the active region", async () => {
    const d = docs["ce-amp"], nl = deriveNetlist(d)
    const q = d.parts.find((p) => p.ref === "Q1")!
    const deck = tracerDeck(buildNetlist(d, nl, "op"), q)!
    expect(deck.kind).toBe("NPN")
    const curves = tracerCurves(deck, await sim(deck.net))
    expect(curves).toHaveLength(5)
    const at5 = curves.map((c) => c.y[c.x.findIndex((v) => v >= 5)])
    // monotonic in Ib; the 10 µA curve sits at hFE × 10 µA with hFE ≈ 100–300 (datasheet), not the
    // default-model β of exactly 100 (regression: the 2N3904 model used to be dropped from the netlist)
    for (let k = 1; k < at5.length; k++) expect(at5[k]).toBeGreaterThan(at5[k - 1])
    expect(at5[0]).toBeGreaterThan(1.2e-3)
    expect(at5[0]).toBeLessThan(3e-3)
  })
  it("the 2N3904 datasheet model reaches the netlist", () => {
    const d = docs["ce-amp"]
    expect(buildNetlist(d, deriveNetlist(d), "op").text).toMatch(/\.model 2N3904 NPN\(IS=6\.734f/)
  })
  it("curve tracer: 1N4148-style diode conducts ~0.7 V at 10 mA", async () => {
    const d = docs["half-wave"], nl = deriveNetlist(d)
    const dio = d.parts.find((p) => p.ref.startsWith("D"))!
    const deck = tracerDeck(buildNetlist(d, nl, "op"), dio)!
    const [c] = tracerCurves(deck, await sim(deck.net))
    const v10 = c.x[c.y.findIndex((i) => i >= 0.01)]
    expect(v10).toBeGreaterThan(0.55)
    expect(v10).toBeLessThan(1.0)
  })
  it("logic analyzer on the 555 output: ≈ 69 Hz", async () => {
    const d = docs["555-astable"], nl = deriveNetlist(d)
    const r = await sim(buildNetlist(d, nl, "tran"))
    if (r.type !== "tran") throw new Error("expected tran")
    const k = r.names.indexOf("V(out)")
    const ch = toLogic("V(out)", r.time, r.data[k])
    expect(ch.freq).toBeGreaterThan(60)
    expect(ch.freq).toBeLessThan(78)
    expect(ch.duty).toBeGreaterThan(0.5)
  })
})

describe("recorder", async () => {
  const { captureFrame, recordingCsv } = await import("./recorder")
  const time = Array.from({ length: 101 }, (_, i) => i * 1e-4)
  const r = { type: "tran" as const, time, names: ["V(a)", "V(b)"], data: [time.map((t) => Math.sin(2 * Math.PI * 1e3 * t - 1)), time.map(() => 1)], steps_accepted: 101, steps_rejected: 0 }
  it("cuts the frame at the trigger (rising through 0) minus the pre-trigger share", () => {
    const base = { recording: true, started: 0, stopped: null, signals: ["V(a)", "V(b)"], frames: [] }
    const f = captureFrame(r, "x", { ...base, trigger: { signal: "V(a)", level: 0, rising: true, pre: 0 } })!
    expect(f.triggered).toBe(true)
    // sin(2π·1k·t − 1) rises through 0 at t = 1/(2π·1k) ≈ 159 µs
    expect(f.time[0]).toBeGreaterThan(1.5e-4); expect(f.time[0]).toBeLessThan(2.1e-4)
    const free = captureFrame(r, "x", { ...base, trigger: { signal: null, level: 0, rising: true, pre: 0 } })!
    expect(free.triggered).toBe(false)
    expect(free.time.length).toBe(101)
    const csv = recordingCsv({ ...base, trigger: { signal: null, level: 0, rising: true, pre: 0 }, frames: [free] })
    const lines = csv.split("\n")
    expect(lines[0]).toBe("frame,label,triggered,time_s,V(a),V(b)")
    expect(lines).toHaveLength(102)
    expect(lines[1].split(",")[5]).toBe("1.00000000")
  })
})
