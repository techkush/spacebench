import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import zlib from "node:zlib"
import { beforeAll, describe, expect, it } from "vitest"

import { loadExample } from "@/editor/examples"
import type { Doc } from "@/editor/model"
import { deriveNetlist } from "@/editor/netlist"
import type { AcResult, JobResult, TranResult } from "@/lib/engine"
import { setLoader } from "@/lib/kicad"
import { planRuns, sweepValues } from "@/lib/runs"
import { buildNetlist } from "@/lib/spice"
import { runAsserts, runMeasures } from "./measure"

setLoader(async (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.resolve(import.meta.dirname, "../../public/kicad", `${f}.gz`))).toString()))

const sine = (f: number, amp: number, n = 4000, cycles = 5): TranResult => {
  const time = Array.from({ length: n }, (_, i) => (i / (n - 1)) * (cycles / f))
  return { type: "tran", time, names: ["V(out)", "I(R1)"], data: [time.map((t) => amp * Math.sin(2 * Math.PI * f * t)), time.map(() => 1e-3)], steps_accepted: n, steps_rejected: 0 }
}

describe("measurements", () => {
  it("levels, timing and arithmetic on a sine", () => {
    const m = runMeasures([
      { name: "f", expr: "frequency(V(out))" }, { name: "vpp", expr: "pp(V(out))" }, { name: "vr", expr: "rms(V(out))" },
      { name: "p", expr: "avg(V(out) * I(R1))" }, { name: "t", expr: "1 / f" }, { name: "bad", expr: "max(V(nope))" },
    ], sine(1000, 2))
    const v = (k: string) => (m[k].ok ? (m[k] as { value: { value: number } }).value.value : NaN)
    expect(v("f")).toBeCloseTo(1000, 0)
    expect(v("vpp")).toBeCloseTo(4, 2)
    expect(v("vr")).toBeCloseTo(2 / Math.SQRT2, 2)
    expect(Math.abs(v("p"))).toBeLessThan(1e-4)
    expect(v("t")).toBeCloseTo(1e-3, 6)
    expect(m.bad.ok).toBe(false)
  })
  it("AC: gain, phase and corner of a one-pole low-pass", () => {
    const freq = Array.from({ length: 301 }, (_, i) => 10 ** (1 + (i / 300) * 4))
    const fc = 1000
    const h = freq.map((f) => { const x = f / fc, d = 1 + x * x; return [1 / d, -x / d] })
    const r: AcResult = { type: "ac", freq, names: ["V(in)", "V(out)"], re: [freq.map(() => 1), h.map((c) => c[0])], im: [freq.map(() => 0), h.map((c) => c[1])] }
    const m = runMeasures([{ name: "fc", expr: "fc(V(out) / V(in))" }, { name: "g", expr: "gain_db(V(out), at: 1 kHz)" }, { name: "ph", expr: "phase(V(out), at: 1 kHz)" }], r)
    expect((m.fc as { value: { value: number } }).value.value).toBeCloseTo(1000, -1)
    expect((m.g as { value: { value: number } }).value.value).toBeCloseTo(-3.01, 1)
    expect((m.ph as { value: { value: number } }).value.value).toBeCloseTo(-45, 0)
  })
  it("asserts: ranges, comparisons, severity", () => {
    const r = sine(1000, 1)
    const m = runMeasures([{ name: "f", expr: "frequency(V(out))" }], r)
    const a = runAsserts(["f in 900 Hz .. 1.1 kHz", "f > 2 kHz severity: warning", "f + "], m, r)
    expect(a[0]).toEqual({ ok: true, pass: true, severity: "error" })
    expect(a[1]).toEqual({ ok: true, pass: false, severity: "warning" })
    expect(a[2].ok).toBe(false)
  })
})

describe("run planning", () => {
  let blinker: Doc
  beforeAll(async () => { blinker = await loadExample("555-astable") })
  it("sweep values: list, linear, decade", () => {
    expect(sweepValues({ enabled: true, target: "R1.value", mode: "list", values: ["4.7k", "10k"], start: "", stop: "", points: 0 })).toEqual([4700, 10000])
    expect(sweepValues({ enabled: true, target: "R1.value", mode: "lin", values: [], start: "1k", stop: "5k", points: 5 })).toEqual([1000, 2000, 3000, 4000, 5000])
    expect(sweepValues({ enabled: true, target: "R1.value", mode: "dec", values: [], start: "1k", stop: "100k", points: 2 })).toEqual([1000, 3162, 10000, 31620, 100000])
  })
  it("sweep × temperature × Monte Carlo multiply, Monte Carlo is reproducible", () => {
    const doc: Doc = { ...blinker, setup: { overlay: true, parallel: true, keepRaw: false,
      sweep: { enabled: true, target: "RB.value", mode: "list", values: ["4.7k", "10k"], start: "", stop: "", points: 0 },
      temp: { enabled: true, values: ["-40", "85"] }, montecarlo: { enabled: true, runs: 3, seed: 7 } } }
    const a = planRuns(doc), b = planRuns(doc)
    expect(a.length).toBe(2 * 2 * 3)
    expect(a.map((s) => s.doc.parts.find((p) => p.ref === "RB")!.value)).toEqual(b.map((s) => s.doc.parts.find((p) => p.ref === "RB")!.value))
    expect(new Set(a.map((s) => s.doc.parts.find((p) => p.ref === "RA")!.value)).size).toBeGreaterThan(1)
    expect(a[0].temp).toBe(-40)
  })
})

// ---------------------------------------------------------------- end to end on ngspice
const ngspice = ["/opt/homebrew/bin/ngspice", "/usr/local/bin/ngspice", "/usr/bin/ngspice"].find((p) => fs.existsSync(p))

/** Minimal ASCII raw-file reader (the app does this in Rust). */
function runTran(text: string, nodes: Map<string, string>): JobResult {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbmeas-"))
  const raw = path.join(dir, "o.raw")
  fs.writeFileSync(path.join(dir, "c.cir"), `${text}\n.control\nset filetype=ascii\nrun\nwrite ${raw}\n.endc\n.end\n`)
  spawnSync(ngspice!, ["-b", path.join(dir, "c.cir")], { encoding: "utf8" })
  const lines = fs.readFileSync(raw, "utf8").split("\n")
  fs.rmSync(dir, { recursive: true, force: true })
  const nv = Number(lines.find((l) => l.startsWith("No. Variables:"))!.split(":")[1])
  const vi = lines.findIndex((l) => l.startsWith("Variables:"))
  const vars = lines.slice(vi + 1, vi + 1 + nv).map((l) => l.trim().split(/\s+/)[1])
  const vals = lines.slice(lines.findIndex((l) => l.startsWith("Values:")) + 1).map((l) => l.trim()).filter(Boolean)
  const cols: number[][] = vars.map(() => [])
  vals.forEach((l, k) => { const parts = l.split(/\s+/); cols[k % nv].push(parseFloat(parts[parts.length - 1])) })
  const names: string[] = [], data: number[][] = []
  vars.forEach((v, i) => { const m = /^v\((.*)\)$/.exec(v); if (m && nodes.has(m[1])) { names.push(`V(${nodes.get(m[1])})`); data.push(cols[i]) } })
  return { type: "tran", time: cols[0], names, data, steps_accepted: cols[0].length, steps_rejected: 0 }
}

describe.skipIf(!ngspice)("sweep on ngspice", () => {
  it("555: frequency follows 1.44/((RA+2RB)·C) across an RB sweep", async () => {
    const base = await loadExample("555-astable")
    const doc: Doc = { ...base, analyses: { ...base.analyses, tran: { stop: 0.2, step: 20e-6 } }, measures: [{ name: "f", expr: "frequency(V(out), at: 2.5 V)" }],
      setup: { overlay: true, parallel: true, keepRaw: false, sweep: { enabled: true, target: "RB.value", mode: "list", values: ["4.7k", "10k", "22k"], start: "", stop: "", points: 0 } } }
    for (const s of planRuns(doc)) {
      const net = buildNetlist(s.doc, deriveNetlist(s.doc), "tran")
      const m = runMeasures(doc.measures!, runTran(net.text, net.nodes))
      const rb = Number(s.params["RB.value"].replace("k", "")) * 1e3
      const expected = 1.44 / ((1e3 + 2 * rb) * 1e-6)
      expect(m.f.ok, JSON.stringify(m.f)).toBe(true)
      const f = (m.f as { value: { value: number } }).value.value
      expect(Math.abs(f - expected) / expected, `${s.label}: ${f} vs ${expected}`).toBeLessThan(0.06)
    }
  }, 60_000)
})
