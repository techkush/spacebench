// Multi-run simulation: parameter sweep × temperature × Monte Carlo, each run a
// separate ngspice job (run in parallel), with Kirk measurements per run.
import type { Doc, Part } from "@/editor/model"
import { deriveNetlist } from "@/editor/netlist"
import { runAsserts, runMeasures, type AssertOutcome, type MeasureOutcome } from "@/kirk/measure"
import { siText } from "@/kirk/kinds"
import { simulate, type JobResult } from "@/lib/engine"
import { buildNetlist, parseValue, resolveSim, type AnalysisKind } from "@/lib/spice"

export interface RunSpec { label: string; params: Record<string, string>; doc: Doc; temp?: number }
export interface RunOutcome {
  label: string
  params: Record<string, string>
  result: JobResult | null
  error?: string
  measures: Record<string, MeasureOutcome>
  asserts: AssertOutcome[]
  ms: number
}

/** Values of a sweep: list, linear, decade or octave spacing. */
export function sweepValues(sw: NonNullable<NonNullable<Doc["setup"]>["sweep"]>): number[] {
  if (sw.mode === "list") return sw.values.map((v) => parseValue(v)).filter((v): v is number => v !== null)
  const a = parseValue(sw.start), b = parseValue(sw.stop)
  if (a === null || b === null || sw.points < 1) return []
  if (sw.mode === "lin") {
    const n = Math.max(2, Math.round(sw.points))
    return Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1))
  }
  if (a <= 0 || b <= 0) return []
  const per = sw.mode === "dec" ? Math.log10(b / a) : Math.log2(b / a)
  const n = Math.max(2, Math.round(per * sw.points) + 1)
  return Array.from({ length: n }, (_, i) => Number((a * (b / a) ** (i / (n - 1))).toPrecision(4)))
}

/** Deterministic PRNG (mulberry32) + normal deviates, so Monte Carlo runs are reproducible. */
function rng(seed: number) {
  let s = seed >>> 0
  const u = () => { s += 0x6d2b79f5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  return () => Math.sqrt(-2 * Math.log(Math.max(u(), 1e-12))) * Math.cos(2 * Math.PI * u())
}

/** Default tolerance (%) by device: R 1 %, C/L 10 %. */
export const tolerance = (p: Part): number => {
  const t = p.fields?.Tolerance ? parseValue(p.fields.Tolerance) : null
  if (t !== null && t !== undefined) return t
  const sim = resolveSim(p)
  return sim && !("error" in sim) && sim.kind === "R" ? 1 : 10
}

export function planRuns(doc: Doc): RunSpec[] {
  const st = doc.setup
  let specs: RunSpec[] = [{ label: "nominal", params: {}, doc }]
  const sw = st?.sweep
  if (sw?.enabled) {
    const [ref, prop] = sw.target.split(".")
    const vals = sweepValues(sw)
    if (vals.length && (prop === "value" || prop === undefined)) {
      specs = vals.map((v) => ({
        label: `${ref}=${siText(v)}`, params: { [sw.target]: siText(v) },
        doc: { ...doc, parts: doc.parts.map((p) => (p.ref === ref ? { ...p, value: siText(v) } : p)) },
      }))
    }
  }
  if (st?.temp?.enabled && st.temp.values.length) {
    const temps = st.temp.values.map((t) => parseValue(t.replace(/°C|C$/, ""))).filter((t): t is number => t !== null)
    specs = specs.flatMap((s) => temps.map((t) => ({ ...s, temp: t, label: `${s.label === "nominal" ? "" : `${s.label} `}${t} °C`.trim(), params: { ...s.params, temp: `${t} °C` } })))
  }
  if (st?.montecarlo?.enabled && st.montecarlo.runs > 0) {
    const gauss = rng(st.montecarlo.seed)
    specs = specs.flatMap((s) => Array.from({ length: st.montecarlo!.runs }, (_, k) => ({
      ...s, label: `${s.label === "nominal" ? "" : `${s.label} · `}MC ${k + 1}`, params: { ...s.params, run: String(k + 1) },
      doc: {
        ...s.doc,
        parts: s.doc.parts.map((p) => {
          const sim = resolveSim(p)
          if (!sim || "error" in sim || !["R", "C", "L"].includes(sim.kind) || sim.type === "POT") return p
          const v = parseValue(p.value)
          if (v === null) return p
          // ±tolerance treated as a 3σ bound
          return { ...p, value: siText(Number((v * (1 + (tolerance(p) / 100 / 3) * gauss())).toPrecision(5))) }
        }),
      },
    })))
  }
  return specs
}

/** Pause / cancel a running batch (runs already inside ngspice finish first). */
export interface RunControl { paused: boolean; cancelled: boolean }
export interface RunHooks {
  onProgress?: (done: number, total: number) => void
  onStart?: (i: number, spec: RunSpec) => void
  onDone?: (i: number, out: RunOutcome) => void
}

/** Run every spec (in parallel batches) and evaluate the document's measurements on each. */
export async function runAll(doc: Doc, analysis: AnalysisKind, specs: RunSpec[], parallel = 4, hooks: RunHooks | ((done: number, total: number) => void) = {}, control: RunControl = { paused: false, cancelled: false }): Promise<RunOutcome[]> {
  const h: RunHooks = typeof hooks === "function" ? { onProgress: hooks } : hooks
  const out: RunOutcome[] = new Array(specs.length)
  let next = 0, done = 0
  const worker = async () => {
    for (;;) {
      while (control.paused && !control.cancelled) await new Promise((r) => setTimeout(r, 100))
      if (control.cancelled) return
      const i = next++
      if (i >= specs.length) return
      const s = specs[i]
      h.onStart?.(i, s)
      const t0 = performance.now()
      try {
        const net = buildNetlist(s.doc, deriveNetlist(s.doc), analysis, { temp: s.temp })
        const result = await simulate(net, { batch: true })
        const measures = runMeasures(doc.measures ?? [], result)
        out[i] = { label: s.label, params: s.params, result, measures, asserts: runAsserts(doc.asserts ?? [], measures, result), ms: performance.now() - t0 }
      } catch (e) {
        out[i] = { label: s.label, params: s.params, result: null, error: e instanceof Error ? e.message : String(e), measures: {}, asserts: [], ms: performance.now() - t0 }
      }
      h.onDone?.(i, out[i])
      h.onProgress?.(++done, specs.length)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, specs.length)) }, worker))
  // stopped: runs that never started are reported as such
  return specs.map((sp, i) => out[i] ?? { label: sp.label, params: sp.params, result: null, error: "stopped", measures: {}, asserts: [], ms: 0 })
}
