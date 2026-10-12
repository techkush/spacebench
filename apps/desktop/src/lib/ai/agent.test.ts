import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
import { describe, expect, it } from "vitest"

import type { Doc } from "@/editor/model"
import { deriveNetlist } from "@/editor/netlist"
import { remap, type JobResult } from "@/lib/engine"
import { setLoader } from "@/lib/kicad"
import { buildNetlist } from "@/lib/spice"
import { compileKirk } from "@/kirk/compile"
import { generateKirk } from "@/kirk/generate"
import { runAsserts, runMeasures } from "@/kirk/measure"
import { run } from "../../../vite-ngspice"
import { PROMPT_EXAMPLES, runAgent, systemPrompt, TOOLS, type AgentEvent, type AgentHost } from "./agent"
import type { Block, Request, Response, Transport } from "./claude"
import { summarizeResult } from "./summary"

const KICAD = path.resolve(import.meta.dirname, "../../../public/kicad")
setLoader(async (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(KICAD, `${f}.gz`))).toString()))
const ngspice = ["/opt/homebrew/bin/ngspice", "/usr/local/bin/ngspice", "/usr/bin/ngspice"].find((p) => fs.existsSync(p))

async function sim(doc: Doc, a: "tran" | "ac" | "op" | "dc"): Promise<JobResult> {
  const net = buildNetlist(doc, deriveNetlist(doc), a)
  const r = await run(net.text)
  if (r.status !== 200) throw new Error(r.body)
  return remap(JSON.parse(r.body) as JobResult, net)
}

/** A host like the app's, minus the UI: real compiler, real ngspice. */
function testHost() {
  const state = { doc: null as Doc | null, probes: [] as string[], last: null as JobResult | null, meter: "" }
  const host: AgentHost = {
    getCircuit: () => ({ kirk: state.doc ? generateKirk(state.doc, deriveNetlist(state.doc)) : "", issues: [], nets: state.doc ? deriveNetlist(state.doc).nets : [], probes: state.probes, analysis: state.doc?.defaultAnalysis ?? "tran", title: state.doc?.title ?? "Untitled" }),
    writeKirk: async (code) => {
      const r = await compileKirk(code, state.doc)
      const errors = r.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)
      if (!r.ok || !r.doc) return { ok: false, errors, warnings: [], parts: 0, nets: [] }
      state.doc = r.doc
      state.probes = r.doc.probes
      return { ok: true, errors: [], warnings: [], parts: r.doc.parts.length, nets: deriveNetlist(r.doc).nets }
    },
    simulate: async (a) => {
      if (!state.doc) return "Not simulated: no circuit"
      const res = await sim(state.doc, a)
      state.last = res
      const m = runMeasures(state.doc.measures ?? [], res)
      const as = runAsserts(state.doc.asserts ?? [], m, res)
      return summarizeResult(res, state.probes, m, (state.doc.asserts ?? []).map((expr, i) => ({ expr, outcome: as[i] })))
    },
    measure: async (expr) => { const m = runMeasures([{ name: "x", expr }], state.last!).x; return m.ok ? `${m.value.value} ${m.value.unit}` : `error: ${m.error}` },
    addProbe: (s) => { state.probes = [...state.probes, s]; return `Probe ${s} connected (CH${state.probes.length})` },
    removeProbe: (s) => { state.probes = state.probes.filter((p) => p !== s); return `Probe ${s} removed` },
    setMeter: (s) => { state.meter = s; return `Multimeter on ${s}` },
    findParts: async () => "Timer:NE555P",
    setStimulus: () => "ok",
    setInput: () => "ok",
  }
  return { host, state }
}

/** A scripted model: each call returns the next canned response and records the request. */
function script(steps: ((req: Request) => Response)[]) {
  const seen: Request[] = []
  const t: Transport = async (req) => { seen.push(structuredClone(req)); const s = steps[seen.length - 1]; if (!s) throw new Error("script ran out"); return s(req) }
  return { t, seen }
}
const use = (id: string, name: string, input: Record<string, unknown>): Block => ({ type: "tool_use", id, name, input })
const text = (t: string): Block => ({ type: "text", text: t })

describe("system prompt", () => {
  it("every example program in the prompt compiles without errors", async () => {
    for (const e of PROMPT_EXAMPLES) {
      const r = await compileKirk(e.code)
      expect(r.diagnostics.filter((d) => d.severity === "error"), e.title).toEqual([])
      const nl = deriveNetlist(r.doc!)
      expect([...nl.issues, ...buildNetlist(r.doc!, nl, r.doc!.defaultAnalysis).issues].filter((i) => i.severity === "error"), e.title).toEqual([])
    }
    expect(systemPrompt()).toContain("OpAmp pins: 1 = +in")
    expect(TOOLS.map((t) => t.name)).toEqual(["get_circuit", "write_kirk", "simulate", "measure", "add_probe", "remove_probe", "set_meter", "set_stimulus", "set_input", "get_firmware", "write_firmware", "compile_firmware", "run_with_firmware", "check_setup", "install", "find_parts"])
  })
  it.skipIf(!ngspice)("the op-amp example really has a gain of 10", async () => {
    const r = await compileKirk(PROMPT_EXAMPLES.find((e) => e.title.startsWith("Op-amp"))!.code)
    const res = await sim(r.doc!, "tran")
    const m = runMeasures(r.doc!.measures!, res)
    expect(m.gain.ok && m.gain.value.value).toBeGreaterThan(9.5)
    expect(m.gain.ok && m.gain.value.value).toBeLessThan(10.1)
  })
})

describe.skipIf(!ngspice)("agent loop (scripted model, real compiler + ngspice)", () => {
  it("fixes a compile error, simulates, probes on request and reports", async () => {
    const { host, state } = testHost()
    const bad = "circuit Rc {\n  ground GND\n  V1 = Vsin(amp: 1 V, freq: 1 kHz, ac: 1 V)\n  R1 = R(1.6k)\n  C1 = C(100 kΩ)\n  IN -- V1 -- GND\n  IN -- R1 -- OUT -- C1 -- GND\n}\nsimulate ac(from: 10 Hz, to: 100 kHz)\n"
    const good = bad.replace("C(100 kΩ)", "C(100n)") + "measure fc = fc(V(OUT))\n"
    const { t, seen } = script([
      () => ({ stop_reason: "tool_use", content: [text("I'll design a 1 kHz RC low-pass."), use("a", "get_circuit", {}), use("b", "write_kirk", { code: bad, summary: "RC low-pass" })] }),
      () => ({ stop_reason: "tool_use", content: [use("c", "write_kirk", { code: good, summary: "RC low-pass (fixed C)" })] }),
      () => ({ stop_reason: "tool_use", content: [use("d", "add_probe", { signal: "V(OUT)" }), use("e", "simulate", { analysis: "ac" })] }),
      () => ({ stop_reason: "tool_use", content: [use("f", "measure", { expr: "fc(V(OUT))" })] }),
      () => ({ stop_reason: "end_turn", content: [text("Done: fc ≈ 995 Hz. V(OUT) is on the Bode plotter.")] }),
    ])
    const events: AgentEvent[] = []
    const history = await runAgent({ transport: t, model: "claude-sonnet-5-5", history: [{ role: "user", content: [text("Design an RC low-pass at 1 kHz and probe the output")] }], host, onEvent: (e) => events.push(e) })
    // the bad write came back as an error the model could read
    const firstResults = seen[1].messages[seen[1].messages.length - 1].content
    const badResult = firstResults.find((b) => b.type === "tool_result" && b.tool_use_id === "b") as Extract<Block, { type: "tool_result" }>
    expect(badResult.is_error).toBe(true)
    expect(badResult.content).toMatch(/unit mismatch/)
    // the good one compiled, the probe is connected, the AC result has the corner
    expect(state.doc?.parts.some((p) => p.ref === "C1" && p.value === "100n")).toBe(true)
    expect(state.probes).toContain("V(OUT)")
    const simResult = seen[3].messages[seen[3].messages.length - 1].content.find((b) => b.type === "tool_result" && b.tool_use_id === "e") as Extract<Block, { type: "tool_result" }>
    expect(simResult.content).toMatch(/^AC sweep/)
    expect(simResult.content).toMatch(/V\(OUT\): peak .* f_H 9\d\d(\.\d+)? Hz/)
    const meas = seen[4].messages[seen[4].messages.length - 1].content[0] as Extract<Block, { type: "tool_result" }>
    expect(parseFloat(meas.content)).toBeGreaterThan(950)
    expect(parseFloat(meas.content)).toBeLessThan(1040)
    // UI events: text, then tool cards with final status
    expect(events.filter((e) => e.kind === "tool" && e.status !== "running").map((e) => e.kind === "tool" && `${e.name}:${e.status}`)).toEqual(["get_circuit:ok", "write_kirk:error", "write_kirk:ok", "add_probe:ok", "simulate:ok", "measure:ok"])
    expect(history[history.length - 1].role).toBe("assistant")
    // system prompt and tools were sent with prompt caching on the big, stable parts
    expect(seen[0].system[0].type === "text" && seen[0].system[0].cache_control).toEqual({ type: "ephemeral" })
    expect(seen[0].tools[seen[0].tools.length - 1].cache_control).toEqual({ type: "ephemeral" })
  })
  it("stops when aborted", async () => {
    const { host } = testHost()
    const ac = new AbortController()
    const { t, seen } = script([() => { ac.abort(); return { stop_reason: "tool_use", content: [use("a", "get_circuit", {})] } }, () => ({ stop_reason: "end_turn", content: [] })])
    await runAgent({ transport: t, model: "m", history: [{ role: "user", content: [text("hi")] }], host, onEvent: () => {}, signal: ac.signal })
    expect(seen.length).toBe(1)
  })
})
