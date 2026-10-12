import { describe, expect, it } from "vitest"

import { explainFailure, getRuns, refsInMessage, startRun } from "./runlog"
import { runAll, type RunSpec } from "./runs"
import { emptyDoc } from "@/editor/model"

describe("run records", () => {
  it("records stages, spans, log and events, and closes open spans on finish", () => {
    const h = startRun({ label: "Transient", analysis: "tran", live: false, total: 2 })
    h.stage("erc", { ms: 3, status: "done", lines: ["3 parts · 2 nets"] })
    const end = h.span("run R2=1k")
    h.span("run R2=2k")
    end("done")
    h.log("hello")
    h.event({ kind: "recovered", title: "Recovered", detail: "retry" })
    h.finish("stopped")
    const r = getRuns().find((x) => x.id === h.id)!
    expect(r.n).toBeGreaterThan(0)
    expect(r.stages.erc.status).toBe("done")
    expect(r.spans.map((s) => s.status)).toEqual(["done", "stopped"])
    expect(r.spans.every((s) => s.end !== undefined)).toBe(true)
    expect(r.log[0].text).toBe("hello")
    expect(r.events[0].kind).toBe("recovered")
    expect(r.status).toBe("stopped")
  })
  it("live runs replace each other and are not numbered", () => {
    startRun({ label: "a", analysis: "op", live: true, total: 1 })
    startRun({ label: "b", analysis: "op", live: true, total: 1 })
    const live = getRuns().filter((r) => r.live)
    expect(live).toHaveLength(1)
    expect(live[0].label).toBe("b")
    expect(live[0].n).toBe(0)
  })
})

describe("failure mapping", () => {
  it("finds the parts an ngspice message points at", () => {
    const elements = new Map([["R1", "R1"], ["C1", "C1"], ["QQ1", "Q1"]])
    const nodes = new Map([["out", "OUT"], ["n003", "N003"]])
    const on = (n: string) => (n === "N003" ? ["C1", "R2"] : [])
    expect(refsInMessage("singular matrix: check node n003", elements, nodes, on)).toEqual({ refs: ["C1", "R2"], nets: ["N003"] })
    expect(refsInMessage("Error on line 4 : r1 out 0 abc", elements, nodes, on).refs).toEqual(["R1"])
  })
  it("explains common failures", () => {
    expect(explainFailure("doAnalyses: singular matrix").title).toMatch(/singular matrix/)
    expect(explainFailure("Timestep too small").title).toMatch(/timestep/)
    expect(explainFailure("ngspice was not found. Install it").title).toMatch(/not found/)
  })
})

describe("run control", () => {
  it("a cancelled batch reports every run as stopped", async () => {
    const doc = emptyDoc()
    const specs: RunSpec[] = [1, 2, 3].map((k) => ({ label: `run ${k}`, params: {}, doc }))
    const out = await runAll(doc, "op", specs, 2, {}, { paused: false, cancelled: true })
    expect(out.map((o) => o.error)).toEqual(["stopped", "stopped", "stopped"])
  })
  it("a paused batch waits until resumed", async () => {
    const doc = emptyDoc()
    const specs: RunSpec[] = [{ label: "only", params: {}, doc }]
    const control = { paused: true, cancelled: false }
    const started: number[] = []
    const p = runAll(doc, "op", specs, 1, { onStart: (i) => started.push(i) }, control)
    await new Promise((r) => setTimeout(r, 250))
    expect(started).toEqual([])
    control.paused = false
    await p
    expect(started).toEqual([0])
  })
})
