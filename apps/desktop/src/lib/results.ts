// Result sets (one per Simulate press / sweep) and table building for the
// Analysis view and the Data export dialog.
import type { Doc } from "@/editor/model"
import { evalSignal } from "@/kirk/measure"
import type { JobResult } from "@/lib/engine"
import type { RunOutcome } from "@/lib/runs"
import type { AnalysisKind } from "@/lib/spice"

export interface ResultSet {
  id: string
  label: string
  /** ms since epoch */
  time: number
  analysis: AnalysisKind
  runs: RunOutcome[]
  /** the circuit as simulated (for reports and embedding) */
  doc: Doc
  netlist?: string
}

export const unitOfSignal = (s: string) => (/^I/.test(s) ? "A" : /^V\(/.test(s) ? "V" : "")
export const isMath = (s: string) => !/^(V|I[a-z]*)\([^()]*\)$/.test(s)

/** A real-valued series of a run: x axis + values (AC: magnitude in dB or phase in degrees). */
export function series(r: JobResult | null, signal: string, part: "mag" | "phase" = "mag"): { x: number[]; y: number[]; unit: string } | { error: string } {
  if (!r) return { error: "no result" }
  if (r.type === "op") return { error: "operating point has no waveform" }
  const xs = r.type === "tran" ? r.time : r.type === "dc" ? r.sweep : r.freq
  if (!isMath(signal)) {
    const k = r.names.indexOf(signal)
    if (k < 0) return { error: `no ${signal}` }
    if (r.type === "ac") {
      const y = r.re[k].map((v, j) => (part === "mag" ? 20 * Math.log10(Math.max(Math.hypot(v, r.im[k][j]), 1e-300)) : (Math.atan2(r.im[k][j], v) * 180) / Math.PI))
      return { x: xs, y, unit: part === "mag" ? "dB" : "°" }
    }
    return { x: xs, y: r.data[k], unit: unitOfSignal(signal) }
  }
  const v = evalSignal(signal, r)
  if ("error" in v) return v
  if (v.kind === "ac") {
    const y = v.re.map((a, j) => (part === "mag" ? 20 * Math.log10(Math.max(Math.hypot(a, v.im[j]), 1e-300)) : (Math.atan2(v.im[j], a) * 180) / Math.PI))
    return { x: v.f, y, unit: part === "mag" ? "dB" : "°" }
  }
  return { x: v.x, y: v.y, unit: v.unit }
}

export const xUnitOf = (r: JobResult | null) => (r?.type === "ac" ? "Hz" : r?.type === "dc" ? "V" : "s")
export const xNameOf = (r: JobResult | null) => (r?.type === "ac" ? "freq" : r?.type === "dc" ? "sweep" : "time")

function interp(xs: number[], ys: number[], x: number): number {
  if (x <= xs[0]) return ys[0]
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1]
  let lo = 0, hi = xs.length - 1
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m }
  return ys[lo] + ((x - xs[lo]) / (xs[hi] - xs[lo] || 1)) * (ys[hi] - ys[lo])
}

export interface TableSpec {
  set: ResultSet
  signals: string[]
  runs: number[]
  from?: number
  to?: number
  /** resample step; 0/undefined = the simulator's own points (resampled anyway when runs differ) */
  dt?: number
  /** wide: one column per signal × run; long: a run column */
  wide: boolean
}
export interface Column { name: string; unit: string; signal?: string; run?: number }
export interface Table { columns: Column[]; rows: number[][]; resampled: boolean }

const runTag = (set: ResultSet, i: number) => {
  const r = set.runs[i]
  const v = Object.values(r.params)
  return v.length ? v.join("_").replace(/\s+/g, "") : r.label === "nominal" ? "" : r.label
}

export function buildTable(spec: TableSpec): Table {
  const { set, signals, runs } = spec
  const first = set.runs[runs[0]]?.result ?? null
  const xn = xNameOf(first), xu = xUnitOf(first)
  const ac = first?.type === "ac"
  // the per-run series (AC exports magnitude and phase)
  const parts: ("mag" | "phase" | "real")[] = ac ? ["mag", "phase"] : ["real"]
  const cols: Column[] = []
  const data: { x: number[]; y: number[] }[] = []
  for (const s of signals) for (const p of parts) for (const i of runs) {
    const sr = series(set.runs[i]?.result ?? null, s, p === "phase" ? "phase" : "mag")
    if ("error" in sr) continue
    const tag = runTag(set, i)
    cols.push({ name: `${p === "phase" ? `∠${s}` : s}${spec.wide && tag ? `@${tag}` : ""}`, unit: sr.unit, signal: s, run: i })
    data.push({ x: sr.x, y: sr.y })
  }
  if (!data.length) return { columns: [{ name: xn, unit: xu }], rows: [], resampled: false }
  const lo = Math.max(spec.from ?? -Infinity, data[0].x[0]), hi = Math.min(spec.to ?? Infinity, data[0].x[data[0].x.length - 1])
  const sameAxis = data.every((d) => d.x === data[0].x || (d.x.length === data[0].x.length && d.x[d.x.length - 1] === data[0].x[data[0].x.length - 1]))
  const resample = !!spec.dt || !sameAxis
  let axis: number[]
  if (spec.dt && spec.dt > 0 && !ac) {
    const n = Math.min(2_000_000, Math.floor((hi - lo) / spec.dt) + 1)
    axis = Array.from({ length: n }, (_, k) => lo + k * spec.dt!)
  } else axis = data[0].x.filter((x) => x >= lo && x <= hi)
  if (spec.wide) {
    const rows = axis.map((x) => [x, ...data.map((d) => (resample ? interp(d.x, d.y, x) : d.y[d.x.indexOf(x)] ?? interp(d.x, d.y, x)))])
    return { columns: [{ name: xn, unit: xu }, ...cols], rows, resampled: resample }
  }
  // long format: run, x, one column per signal
  const sigCols = cols.filter((c) => c.run === runs[0])
  const rows: number[][] = []
  for (const i of runs) {
    const mine = cols.map((c, k) => ({ c, d: data[k] })).filter((o) => o.c.run === i)
    for (const x of axis) rows.push([i + 1, x, ...mine.map((o) => interp(o.d.x, o.d.y, x))])
  }
  return { columns: [{ name: "run", unit: "" }, { name: xn, unit: xu }, ...sigCols.map((c) => ({ ...c, name: c.name.replace(/@.*$/, "") }))], rows, resampled: true }
}

// ---------------------------------------------------------------- writers

export interface WriteOptions { header: boolean; precision: number; comments?: string[] }

export function toCSV(t: Table, o: WriteOptions): string {
  const lines: string[] = []
  for (const c of o.comments ?? []) lines.push(`# ${c}`)
  if (o.header) lines.push(t.columns.map((c) => (c.unit ? `${c.name} [${c.unit}]` : c.name)).map((s) => (/[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)).join(","))
  for (const r of t.rows) lines.push(r.map((v) => (Number.isFinite(v) ? Number(v.toPrecision(o.precision)).toString() : "")).join(","))
  return lines.join("\n") + "\n"
}

export function toJSON(t: Table, o: WriteOptions, extra: Record<string, unknown>): string {
  const columns: Record<string, number[]> = {}
  t.columns.forEach((c, k) => { columns[c.name] = t.rows.map((r) => Number(r[k].toPrecision(o.precision))) })
  return JSON.stringify({ format: "spicebench.export", version: 1, units: Object.fromEntries(t.columns.map((c) => [c.name, c.unit])), columns, ...extra }, null, 1)
}

/** MATLAB Level 4 MAT-file (readable by MATLAB, Octave, scipy.io.loadmat): one double column per variable. */
export function toMAT(t: Table): Uint8Array {
  const used = new Set<string>()
  const varName = (s: string) => {
    let n = s.replace(/^∠/, "phase_").replace(/[^A-Za-z0-9_]/g, "_").replace(/^([^A-Za-z])/, "v$1").slice(0, 60) || "v"
    while (used.has(n)) n += "_"
    used.add(n)
    return n
  }
  const chunks: Uint8Array[] = []
  t.columns.forEach((c, k) => {
    const name = new TextEncoder().encode(varName(c.name) + "\0")
    const head = new Int32Array([0, t.rows.length, 1, 0, name.length]) // type 0000 = little-endian doubles, full matrix
    const body = new Float64Array(t.rows.map((r) => r[k]))
    chunks.push(new Uint8Array(head.buffer), name, new Uint8Array(body.buffer))
  })
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let off = 0
  for (const c of chunks) { out.set(c, off); off += c.length }
  return out
}

export function pandasSnippet(path: string, format: "csv" | "json" | "mat", t: Table): string {
  const file = path || `export.${format}`
  if (format === "csv") return `import pandas as pd\n\ndf = pd.read_csv(${JSON.stringify(file)}, comment="#")\nprint(df.describe())\ndf.plot(x=df.columns[0])`
  if (format === "json") return `import json, pandas as pd\n\nwith open(${JSON.stringify(file)}) as f:\n    data = json.load(f)\ndf = pd.DataFrame(data["columns"])\nprint(data.get("measurements"))\ndf.plot(x=${JSON.stringify(t.columns[0]?.name ?? "time")})`
  return `from scipy.io import loadmat\nimport pandas as pd\n\nm = loadmat(${JSON.stringify(file)})\ndf = pd.DataFrame({k: v.ravel() for k, v in m.items() if not k.startswith("__")})\nprint(df.head())`
}
