// Run records for the Simulation process view: every Simulate
// press, sweep or Monte Carlo becomes a numbered run with its pipeline stages,
// a timeline, a console and events (recovered / failed) that link back to parts.
import { useSyncExternalStore } from "react"

export type StageId = "erc" | "ir" | "models" | "solver" | "vectors" | "measure" | "export"
export type StageStatus = "pending" | "running" | "done" | "warning" | "failed" | "skipped"
export interface Stage { ms: number | null; lines: string[]; status: StageStatus; note?: string }

export type SpanStatus = "running" | "done" | "failed" | "stopped"
export interface Span { label: string; start: number; end?: number; status: SpanStatus; kind: "stage" | "run" }

export type LogLevel = "info" | "warn" | "error" | "ok"
export interface LogLine { t: number; text: string; level: LogLevel }

export interface RunEvent {
  kind: "recovered" | "failed" | "warning"
  title: string
  detail: string
  /** parts to select with "Show on schematic" */
  refs?: string[]
  t: number
}

export type RunStatus = "running" | "paused" | "done" | "failed" | "stopped"
export interface RunRecord {
  id: string
  n: number
  label: string
  analysis: string
  /** real-time re-run (replaced by the next one) */
  live: boolean
  /** performance.now() at start / end */
  started: number
  ended?: number
  wall: number
  status: RunStatus
  total: number
  done: number
  stages: Record<StageId, Stage>
  spans: Span[]
  log: LogLine[]
  events: RunEvent[]
  netlist?: string
  resultSetId?: string
}

export const STAGES: { id: StageId; title: string }[] = [
  { id: "erc", title: "Schematic & ERC" },
  { id: "ir", title: "Circuit IR" },
  { id: "models", title: "Models" },
  { id: "solver", title: "Solver" },
  { id: "vectors", title: "Vectors & probes" },
  { id: "measure", title: "Measure & instruments" },
  { id: "export", title: "Export" },
]

const MAX = 30
let runs: RunRecord[] = []
let counter = (() => { try { return Number(localStorage.getItem("sb-run-counter")) || 0 } catch { return 0 } })()
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export function useRuns(): RunRecord[] {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l) } }, () => runs)
}
export const getRuns = () => runs

export interface RunHandle {
  id: string
  rec: () => RunRecord
  stage: (id: StageId, patch: Partial<Stage>) => void
  log: (text: string, level?: LogLevel) => void
  span: (label: string, kind?: Span["kind"]) => (status?: SpanStatus) => void
  event: (e: Omit<RunEvent, "t">) => void
  update: (patch: Partial<RunRecord>) => void
  finish: (status: RunStatus) => void
  /** time since the run started, in ms */
  now: () => number
}

/** Start a run record. Live (real-time) runs replace the previous live record and are not numbered. */
export function startRun(opts: { label: string; analysis: string; live: boolean; total: number }): RunHandle {
  const started = performance.now()
  const n = opts.live ? 0 : ++counter
  if (!opts.live) try { localStorage.setItem("sb-run-counter", String(counter)) } catch { /* storage unavailable */ }
  const id = opts.live ? "live" : `run${n}`
  const stage = (): Stage => ({ ms: null, lines: [], status: "pending" })
  let rec: RunRecord = {
    id, n, label: opts.label, analysis: opts.analysis, live: opts.live, started, wall: Date.now(), status: "running",
    total: opts.total, done: 0, spans: [], log: [], events: [],
    stages: { erc: stage(), ir: stage(), models: stage(), solver: stage(), vectors: stage(), measure: stage(), export: { ms: null, lines: ["CSV · JSON · MAT", "HTML report with plots", "Data export dialog"], status: "pending", note: "on demand" } },
  }
  runs = [rec, ...runs.filter((r) => r.id !== id)].slice(0, MAX)
  emit()
  const set = (next: RunRecord) => { rec = next; runs = runs.map((r) => (r.id === id ? rec : r)); emit() }
  const now = () => performance.now() - started
  return {
    id,
    rec: () => rec,
    now,
    stage: (sid, patch) => set({ ...rec, stages: { ...rec.stages, [sid]: { ...rec.stages[sid], ...patch } } }),
    log: (text, level = "info") => set({ ...rec, log: [...rec.log, { t: now(), text, level }].slice(-500) }),
    span: (label, kind = "run") => {
      const span: Span = { label, start: now(), status: "running", kind }
      set({ ...rec, spans: [...rec.spans, span] })
      return (status = "done") => set({ ...rec, spans: rec.spans.map((s) => (s === span ? { ...s, end: now(), status } : s)) })
    },
    event: (e) => set({ ...rec, events: [...rec.events, { ...e, t: now() }] }),
    update: (patch) => set({ ...rec, ...patch }),
    finish: (status) => set({
      ...rec, status, ended: performance.now(),
      // anything still open ends with the run
      spans: rec.spans.map((s) => (s.end === undefined ? { ...s, end: now(), status: status === "done" ? "done" : status === "failed" ? "failed" : "stopped" } : s)),
      stages: Object.fromEntries(Object.entries(rec.stages).map(([k, s]) => [k, s.status === "running" ? { ...s, status: status === "done" ? "done" : status === "failed" ? "failed" : "skipped" } : s])) as RunRecord["stages"],
    }),
  }
}

/** Seconds as the console shows them: [1.051] */
export const stamp = (ms: number) => `[${(ms / 1000).toFixed(3)}]`

/**
 * Parts an ngspice error message points at: element names (r1, q2) and node
 * names it mentions, mapped back to schematic references.
 */
export function refsInMessage(msg: string, elements: Map<string, string>, nodes: Map<string, string>, partsOnNet: (net: string) => string[]): { refs: string[]; nets: string[] } {
  const words = new Set((msg.toLowerCase().match(/[a-z_][\w.#]*/g) ?? []).map((w) => w.replace(/#branch$/, "")))
  const refs = new Set<string>(), nets = new Set<string>()
  for (const [el, ref] of elements) if (words.has(el.toLowerCase())) refs.add(ref)
  for (const [node, net] of nodes) if (words.has(node.toLowerCase())) { nets.add(net); for (const r of partsOnNet(net)) refs.add(r) }
  return { refs: [...refs], nets: [...nets] }
}

/** A friendlier headline for common ngspice failures. */
export function explainFailure(msg: string): { title: string; detail: string } {
  const m = msg.toLowerCase()
  if (/ngspice was not found|ngspice not found/.test(m)) return { title: "ngspice was not found", detail: "Install ngspice (macOS: brew install ngspice) or set its path in Settings → Simulation engine." }
  if (/singular matrix|singular/.test(m)) return { title: "Simulation failed: singular matrix", detail: "A node has no DC path to ground, or two ideal sources fight (a loop of voltage sources / inductors). Check floating parts and capacitors in series." }
  if (/timestep too small/.test(m)) return { title: "Simulation failed: timestep too small", detail: "The solver could not converge in time. Try Gear integration, a smaller max step, or add a little series resistance to ideal parts." }
  if (/no convergence|iteration limit|gmin stepping failed|source stepping failed/.test(m)) return { title: "Simulation failed: no convergence", detail: "Newton's method did not find the operating point. Check component values and that every node reaches ground." }
  if (/not found|unknown (model|subckt)|unable to find definition/.test(m)) return { title: "Simulation failed: missing model", detail: "A part refers to a model or subcircuit ngspice does not know." }
  if (/fix \d+ problem/.test(m)) return { title: "Not simulated: ERC errors", detail: msg.replace(/^Fix \d+ problems? first: /, "") }
  return { title: "Simulation failed", detail: msg.split("\n")[0] }
}
