import { describe, expect, it } from "vitest"

import { emptyDoc } from "@/editor/model"
import type { TranResult } from "./engine"
import { buildTable, series, toCSV, toJSON, toMAT, type ResultSet } from "./results"

const tran = (k: number, n = 5): TranResult => ({
  type: "tran", time: Array.from({ length: n }, (_, i) => i * 1e-3), names: ["V(out)", "I(R1)"],
  data: [Array.from({ length: n }, (_, i) => k * i), Array.from({ length: n }, () => k * 1e-3)], steps_accepted: n, steps_rejected: 0,
})
const set: ResultSet = {
  id: "s", label: "Sweep R1 · 2 runs", time: 0, analysis: "tran", doc: emptyDoc(),
  runs: [1, 2].map((k) => ({ label: `R1=${k}k`, params: { "R1.value": `${k}k` }, result: tran(k), measures: {}, asserts: [], ms: 1 })),
}

describe("export tables", () => {
  it("wide: one column per signal × run", () => {
    const t = buildTable({ set, signals: ["V(out)"], runs: [0, 1], wide: true })
    expect(t.columns.map((c) => c.name)).toEqual(["time", "V(out)@1k", "V(out)@2k"])
    expect(t.rows[2]).toEqual([0.002, 2, 4])
  })
  it("long: a run column", () => {
    const t = buildTable({ set, signals: ["V(out)", "I(R1)"], runs: [0, 1], wide: false })
    expect(t.columns.map((c) => c.name)).toEqual(["run", "time", "V(out)", "I(R1)"])
    expect(t.rows.length).toBe(10)
    expect(t.rows[6]).toEqual([2, 0.001, 2, 0.002])
  })
  it("resamples runs with different time points and honours from/to", () => {
    const other: ResultSet = { ...set, runs: [set.runs[0], { ...set.runs[1], result: { ...tran(2, 9), time: Array.from({ length: 9 }, (_, i) => i * 0.5e-3) } }] }
    const t = buildTable({ set: other, signals: ["V(out)"], runs: [0, 1], wide: true, from: 1e-3, to: 3e-3 })
    expect(t.resampled).toBe(true)
    expect(t.rows.map((r) => r[0])).toEqual([0.001, 0.002, 0.003])
  })
  it("math traces evaluate per run", () => {
    const s = series(set.runs[1].result, "V(out)*I(R1)")
    expect("error" in s).toBe(false)
    if (!("error" in s)) { expect(s.unit).toBe("W"); expect(s.y[3]).toBeCloseTo(6 * 2e-3) }
  })
  it("CSV header with units and comments; JSON columns; MAT v4 layout", () => {
    const t = buildTable({ set, signals: ["V(out)"], runs: [0], wide: true })
    const csv = toCSV(t, { header: true, precision: 6, comments: ["hello"] })
    expect(csv.split("\n").slice(0, 3)).toEqual(["# hello", "time [s],V(out)@1k [V]", "0,0"])
    expect(JSON.parse(toJSON(t, { header: true, precision: 6 }, { x: 1 })).columns["V(out)@1k"]).toEqual([0, 1, 2, 3, 4])
    const mat = toMAT(t)
    const dv = new DataView(mat.buffer)
    expect([dv.getInt32(0, true), dv.getInt32(4, true), dv.getInt32(8, true), dv.getInt32(12, true), dv.getInt32(16, true)]).toEqual([0, 5, 1, 0, 5])
    expect(new TextDecoder().decode(mat.slice(20, 24))).toBe("time")
    expect(dv.getFloat64(25 + 8 * 2, true)).toBeCloseTo(0.002)
  })
})
