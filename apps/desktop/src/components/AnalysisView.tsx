import { useEffect, useMemo, useRef, useState } from "react"
import { Crosshair, Download, FileText, Plus, Trash2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { evalNum } from "@/kirk/kinds"
import { evalSignal, type MeasureOutcome } from "@/kirk/measure"
import { parse } from "@/kirk/parser"
import { spectrum, type Window } from "@/lib/fft"
import { isMath, series, unitOfSignal, xUnitOf, type ResultSet } from "@/lib/results"
import { formatSI } from "@/lib/units"
import { cn } from "@/lib/utils"
import { BarChart, XYChart } from "./Charts"
import { Plot, type Marker, type Trace } from "./Plot"

export type PlotMode = "time" | "bode" | "fft" | "xy" | "hist"
export const RUN_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)", "#0ea5e9", "#a855f7", "#f43f5e", "#84cc16", "#f59e0b"]
const css = (v: string) => (v.startsWith("var(") ? getComputedStyle(document.documentElement).getPropertyValue(v.slice(4, -1)).trim() : v)

/** Spec limits of a measurement from its asserts: "f in a .. b", "f > a", "f < b". */
export function specLimits(asserts: string[], name: string): { lo?: number; hi?: number } {
  const out: { lo?: number; hi?: number } = {}
  for (const a of asserts) {
    const { file } = parse(`assert ${a.replace(/\s*severity\s*:\s*\w+\s*$/, "")}`)
    const it = file.items[0]
    if (!it || it.k !== "assert" || it.expr.k !== "bin" || it.expr.a.k !== "id" || it.expr.a.name !== name) continue
    const e = it.expr
    if (e.op === "in" && e.b.k === "range") { out.lo = evalNum(e.b.a)?.value; out.hi = evalNum(e.b.b)?.value }
    else if (e.op === ">" || e.op === ">=") out.lo = evalNum(e.b)?.value
    else if (e.op === "<" || e.op === "<=") out.hi = evalNum(e.b)?.value
  }
  return out
}

interface Props {
  sets: ResultSet[]
  activeId: string | null
  setActiveId: (id: string) => void
  onExport: (setId: string) => void
  onReport: (set: ResultSet, el: HTMLElement | null) => void
  themeKey: string
}

export function AnalysisView(props: Props) {
  const set = props.sets.find((s) => s.id === props.activeId) ?? props.sets[0] ?? null
  const first = set?.runs.find((r) => r.result)?.result ?? null
  if (!set || !first) {
    return (
      <div className="flex h-full items-center justify-center p-10 text-center text-sm text-muted-foreground">
        No results yet. Press Simulate (F5), or set up a sweep / Monte Carlo in Simulation setup (⚙) — every run lands here.
      </div>
    )
  }
  return <AnalysisBody {...props} set={set} first={first} />
}

function AnalysisBody({ sets, set, first, setActiveId, onExport, onReport, themeKey }: Props & { set: ResultSet; first: NonNullable<ResultSet["runs"][number]["result"]> }) {
  const [mode, setMode] = useState<PlotMode>("time")
  const [hiddenRuns, setHiddenRuns] = useState<Set<number>>(new Set())
  const [chosen, setChosen] = useState<string[]>([])
  const [math, setMath] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem("sb-math") ?? "[]") } catch { return [] } })
  const [newMath, setNewMath] = useState("")
  const [cursors, setCursors] = useState<{ a: number | null; b: number | null }>({ a: null, b: null })
  const [fftWin, setFftWin] = useState<Window>("hann")
  const [fftRun, setFftRun] = useState(0)
  const [fftRange, setFftRange] = useState<"auto" | "all" | "half" | "cursors">("auto")
  const [xy, setXy] = useState<{ x: string; y: string }>({ x: "", y: "" })
  const [histMeasure, setHistMeasure] = useState("")
  const area = useRef<HTMLDivElement>(null)
  useEffect(() => { try { localStorage.setItem("sb-math", JSON.stringify(math)) } catch { /* storage unavailable */ } }, [math])

  // a new result set: pick a fitting plot mode and default signals
  useEffect(() => {
    setHiddenRuns(new Set())
    setCursors({ a: null, b: null })
    setMode((m) => (first.type === "ac" ? (m === "time" || m === "fft" ? "bode" : m) : m === "bode" ? "time" : m))
    const names = first.names
    setChosen((c) => {
      const keep = c.filter((s) => names.includes(s))
      if (keep.length) return keep
      const probes = set.doc.probes.filter((p) => names.includes(p))
      return probes.length ? probes : names.filter((n) => n.startsWith("V(")).slice(0, 2)
    })
    setXy((v) => (names.includes(v.x) && names.includes(v.y) ? v : { x: names.find((n) => n.startsWith("V(")) ?? "", y: names.filter((n) => n.startsWith("V("))[1] ?? names[0] ?? "" }))
    const ms = Object.keys(set.runs[0]?.measures ?? {})
    setHistMeasure((h) => (ms.includes(h) ? h : ms[0] ?? ""))
  }, [set.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const runs = set.runs.map((r, i) => ({ r, i })).filter(({ r }) => r.result)
  const visible = runs.filter(({ i }) => !hiddenRuns.has(i)).slice(0, 60)
  const signals = first.type === "op" ? [] : first.names.filter((n) => /^(V|I[a-z]*)\(/.test(n))
  const plotted = [...chosen.filter((c) => !c.startsWith("math:")), ...math.filter((m) => chosen.includes(`math:${m}`))]
  const xUnit = xUnitOf(first)
  const measureNames = Object.keys(set.runs.find((r) => Object.keys(r.measures).length)?.measures ?? {})
  const multi = set.runs.length > 1
  const color = (i: number) => (multi ? RUN_COLORS[i % RUN_COLORS.length] : RUN_COLORS[0])
  const runLabel = (i: number) => {
    const r = set.runs[i]
    const v = Object.entries(r.params)
    return v.length ? v.map(([k, x]) => `${k.replace(/\.value$/, "")} = ${x}`).join(" · ") : r.label
  }
  const toggle = (s: string) => setChosen((c) => (c.includes(s) ? c.filter((x) => x !== s) : [...c, s]))
  const markers: Marker[] = [
    ...(cursors.a !== null ? [{ x: cursors.a, label: `A ${formatSI(cursors.a, xUnit, 4)}`, color: css("var(--muted-foreground)") }] : []),
    ...(cursors.b !== null ? [{ x: cursors.b, label: `B ${formatSI(cursors.b, xUnit, 4)}`, color: css("var(--muted-foreground)") }] : []),
  ]
  const pick = (x: number, shift: boolean) => setCursors((c) => (shift || (c.a !== null && c.b === null) ? { ...c, b: x } : { a: x, b: null }))

  // ---- per-signal plots (time / bode)
  const plotFor = (s: string): { x: number[]; traces: Trace[]; yUnit: string } | { error: string } => {
    const out: Trace[] = []
    let x: number[] | null = null, yUnit = ""
    for (const { r, i } of visible) {
      const mag = series(r.result, s, "mag")
      if ("error" in mag) { if (!out.length && visible.indexOf(visible.find((v) => v.i === i)!) === visible.length - 1) return mag; continue }
      if (!x) x = mag.x
      // uPlot needs one x axis: resample runs that have their own time points
      const y = mag.x === x || mag.x.length === x.length ? mag.y : x.map((t) => { let j = 1; while (j < mag.x.length - 1 && mag.x[j] < t) j++; const f = (t - mag.x[j - 1]) / (mag.x[j] - mag.x[j - 1] || 1); return mag.y[j - 1] + f * (mag.y[j] - mag.y[j - 1]) })
      out.push({ label: multi ? `${s} · ${runLabel(i)}` : s, y, color: css(color(i)) })
      yUnit = mag.unit
      if (mode === "bode" && first.type === "ac") {
        const ph = series(r.result, s, "phase")
        if (!("error" in ph)) out.push({ label: `∠${multi ? ` ${runLabel(i)}` : s}`, y: ph.y, color: css(color(i)), scale: "phase", dash: [5, 4] })
      }
    }
    return x ? { x, traces: out, yUnit } : { error: "no data" }
  }

  // ---- FFT of the first plotted signal
  const fftRunIdx = visible.find((v) => v.i === fftRun)?.i ?? visible[0]?.i ?? 0
  const fft = useMemoSafe(() => {
    if (mode !== "fft" || first.type !== "tran") return null
    const s = plotted[0]
    if (!s) return null
    const sr = series(set.runs[fftRunIdx]?.result ?? null, s)
    if ("error" in sr) return { error: sr.error }
    const t0 = sr.x[0], stop = sr.x[sr.x.length - 1]
    // which part of the run: cursors, the second half (skips start-up transients) or everything
    const whole = spectrum(sr.x, sr.y, { window: fftWin })
    const f0 = whole.fundamental?.f ?? 0
    const periodsInHalf = f0 * (stop - t0) / 2
    const range = fftRange === "auto" ? (cursors.a !== null && cursors.b !== null ? "cursors" : periodsInHalf >= 8 ? "half" : "all") : fftRange
    const [from, to] = range === "cursors" && cursors.a !== null && cursors.b !== null ? [Math.min(cursors.a, cursors.b), Math.max(cursors.a, cursors.b)] : range === "half" ? [(t0 + stop) / 2, stop] : [t0, stop]
    const sp = range === "all" ? whole : spectrum(sr.x, sr.y, { from, to, window: fftWin })
    const periods = (sp.fundamental?.f ?? 0) * (to - from)
    return { s, sp, unit: sr.unit, range, from, to, periods }
  }, [mode, plotted.join("|"), fftRunIdx, fftWin, fftRange, cursors.a, cursors.b, set.id])

  // ---- histogram of a measurement over the runs
  const hist = useMemoSafe(() => {
    if (!histMeasure) return null
    const vals = set.runs.map((r) => r.measures[histMeasure]).filter((m): m is Extract<MeasureOutcome, { ok: true }> => !!m && m.ok)
    if (!vals.length) return null
    const v = vals.map((m) => m.value.value), unit = vals[0].value.unit
    const mean = v.reduce((a, b) => a + b, 0) / v.length
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, v.length - 1))
    const lim = specLimits(set.doc.asserts ?? [], histMeasure)
    const lo = Math.min(...v, lim.lo ?? Infinity), hi = Math.max(...v, lim.hi ?? -Infinity)
    const nb = Math.max(5, Math.min(40, Math.ceil(Math.sqrt(v.length) * 1.5)))
    const w = (hi - lo || Math.abs(mean) * 0.01 || 1) / nb
    const counts = new Array(nb).fill(0)
    for (const x of v) counts[Math.min(nb - 1, Math.floor((x - lo) / w))]++
    const inSpec = (x: number) => (lim.lo === undefined || x >= lim.lo) && (lim.hi === undefined || x <= lim.hi)
    const pass = v.filter(inSpec).length
    return {
      unit, mean, sd, n: v.length, pass, lim,
      bars: counts.map((c, k) => { const x = lo + (k + 0.5) * w; return { x, w, y: c, color: inSpec(x) ? "var(--chart-1)" : "var(--destructive)", label: `${c} runs around ${formatSI(x, unit, 4)}` } }),
    }
  }, [histMeasure, set.id])

  const addMath = () => {
    const t = newMath.trim()
    if (!t) return
    const check = evalSignal(t, first)
    if ("error" in check) return
    setMath((m) => (m.includes(t) ? m : [...m, t]))
    setChosen((c) => [...c, `math:${t}`])
    setNewMath("")
  }
  const mathError = newMath.trim() ? (() => { const r = evalSignal(newMath.trim(), first); return "error" in r ? r.error : null })() : null

  // cursor readout: first plotted signal of the first visible run
  const readout = (() => {
    const s = plotted[0], r = visible[0]
    if (!s || !r || cursors.a === null) return null
    const sr = series(r.r.result, s)
    if ("error" in sr) return null
    const at = (x: number) => { let j = 1; while (j < sr.x.length - 1 && sr.x[j] < x) j++; const f = (x - sr.x[j - 1]) / (sr.x[j] - sr.x[j - 1] || 1); return sr.y[j - 1] + f * (sr.y[j] - sr.y[j - 1]) }
    return { s, unit: sr.unit, a: at(cursors.a), b: cursors.b !== null ? at(cursors.b) : null }
  })()

  return (
    <div className="flex h-full min-h-0">
      {/* ---------------- results panel */}
      <div className="flex w-72 shrink-0 flex-col border-r bg-sidebar">
        <div className="px-4 pb-2 pt-3 text-sm font-medium">Results</div>
        <div className="px-3 pb-2">
          <Select value={set.id} onValueChange={setActiveId}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{sets.map((s) => <SelectItem key={s.id} value={s.id}>{s.label}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <ScrollArea className="min-h-0 flex-1 px-3">
          {multi && (
            <div className="mb-3">
              <div className="mb-1 px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Step family · {set.runs.length} runs</div>
              {set.runs.slice(0, 60).map((r, i) => (
                <label key={i} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 font-mono text-xs hover:bg-accent">
                  <Checkbox checked={!hiddenRuns.has(i)} onCheckedChange={() => setHiddenRuns((h) => { const n = new Set(h); if (n.has(i)) n.delete(i); else n.add(i); return n })} />
                  <span className="h-0.5 w-4 shrink-0 rounded" style={{ background: color(i) }} />
                  <span className="truncate">{runLabel(i)}</span>
                  {r.error && <span className="text-destructive">failed</span>}
                </label>
              ))}
              {set.runs.length > 60 && <div className="px-1 text-[11px] text-muted-foreground">+ {set.runs.length - 60} more (statistics include all runs)</div>}
            </div>
          )}
          <div className="mb-1 px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Signals</div>
          {signals.map((s) => (
            <label key={s} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 font-mono text-xs hover:bg-accent">
              <Checkbox checked={chosen.includes(s)} onCheckedChange={() => toggle(s)} />
              <span className="flex-1 truncate">{s}</span>
              <span className="text-muted-foreground">{unitOfSignal(s)}</span>
            </label>
          ))}
          {!signals.length && <div className="px-1 text-xs text-muted-foreground">Operating point only — no waveforms.</div>}
          <div className="mb-1 mt-3 px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Math</div>
          {math.map((m) => (
            <div key={m} className="group flex items-center gap-2 rounded px-1 py-0.5 font-mono text-xs hover:bg-accent">
              <Checkbox checked={chosen.includes(`math:${m}`)} onCheckedChange={() => toggle(`math:${m}`)} />
              <span className="flex-1 truncate" title={m}>{m}</span>
              <button className="opacity-0 group-hover:opacity-100" onClick={() => { setMath((x) => x.filter((y) => y !== m)); setChosen((c) => c.filter((y) => y !== `math:${m}`)) }}><Trash2 className="size-3.5" /></button>
            </div>
          ))}
          <div className="mt-1 flex items-center gap-1">
            <Input value={newMath} onChange={(e) => setNewMath(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addMath()} placeholder="V(out)*I(R1)" aria-invalid={!!mathError} className="h-7 font-mono text-xs" />
            <Button variant="ghost" size="icon-sm" onClick={addMath} disabled={!newMath.trim() || !!mathError} title="Add expression"><Plus /></Button>
          </div>
          {mathError && <div className="mt-1 px-1 text-[11px] text-destructive">{mathError}</div>}
          <div className="h-4" />
        </ScrollArea>
      </div>

      {/* ---------------- plots */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
          <div className="flex rounded-lg bg-muted p-[3px]">
            {([["time", "Time"], ["bode", "Bode"], ["fft", "FFT"], ["xy", "X–Y"], ["hist", "Histogram"]] as const).map(([m, l]) => (
              <button key={m} onClick={() => setMode(m)} disabled={(m === "bode") !== (first.type === "ac") && (m === "bode" || m === "fft" || m === "time")}
                className={cn("h-7 rounded-md px-3 text-sm disabled:opacity-40", mode === m ? "bg-background shadow-sm" : "text-muted-foreground")}>{l}</button>
            ))}
          </div>
          {mode === "fft" && (<>
            <Select value={fftWin} onValueChange={(v) => setFftWin(v as Window)}>
              <SelectTrigger size="sm" className="h-7 w-28 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="hann">Hann</SelectItem><SelectItem value="blackman">Blackman</SelectItem><SelectItem value="rect">Rectangular</SelectItem></SelectContent>
            </Select>
            <Select value={fftRange} onValueChange={(v) => setFftRange(v as typeof fftRange)}>
              <SelectTrigger size="sm" className="h-7 w-36 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Range: auto</SelectItem><SelectItem value="all">Whole run</SelectItem>
                <SelectItem value="half">Second half</SelectItem><SelectItem value="cursors" disabled={cursors.a === null || cursors.b === null}>Cursors A–B</SelectItem>
              </SelectContent>
            </Select>
            {multi && (
              <Select value={String(fftRunIdx)} onValueChange={(v) => setFftRun(Number(v))}>
                <SelectTrigger size="sm" className="h-7 w-44 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>{visible.map(({ i }) => <SelectItem key={i} value={String(i)}>{runLabel(i)}</SelectItem>)}</SelectContent>
              </Select>
            )}
          </>)}
          {mode === "xy" && (<>
            {(["x", "y"] as const).map((ax) => (
              <Select key={ax} value={xy[ax]} onValueChange={(v) => setXy((o) => ({ ...o, [ax]: v }))}>
                <SelectTrigger size="sm" className="h-7 w-36 font-mono text-xs"><span className="text-muted-foreground">{ax.toUpperCase()}:</span><SelectValue /></SelectTrigger>
                <SelectContent>{[...signals, ...math].map((s) => <SelectItem key={s} value={s} className="font-mono text-xs">{s}</SelectItem>)}</SelectContent>
              </Select>
            ))}
          </>)}
          {mode === "hist" && (
            <Select value={histMeasure} onValueChange={setHistMeasure}>
              <SelectTrigger size="sm" className="h-7 w-40 font-mono text-xs"><SelectValue placeholder="Measurement" /></SelectTrigger>
              <SelectContent>{measureNames.map((m) => <SelectItem key={m} value={m} className="font-mono text-xs">{m}</SelectItem>)}</SelectContent>
            </Select>
          )}
          <div className="flex-1" />
          <Button variant="ghost" size="icon-sm" title="Clear cursors" onClick={() => setCursors({ a: null, b: null })}><Crosshair /></Button>
          <Button variant="ghost" size="icon-sm" title="Export data…" onClick={() => onExport(set.id)}><Download /></Button>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div ref={area} className="flex flex-col gap-4 p-4">
            {(mode === "time" || mode === "bode") && (plotted.length ? plotted.map((s) => {
              const pl = plotFor(s)
              return (
                <div key={s} className="rounded-lg border bg-scope">
                  <div className="flex items-center gap-2 px-3 pt-2 font-mono text-xs"><span className="font-medium">{s}</span>{multi && <span className="text-muted-foreground">· {visible.length} runs</span>}{isMath(s) && <Badge variant="secondary" className="h-4 px-1 text-[10px]">math</Badge>}</div>
                  <div className="h-60 p-2">
                    {"error" in pl ? <div className="flex h-full items-center justify-center text-xs text-destructive">{pl.error}</div>
                      : <Plot x={pl.x} traces={pl.traces} logX={first.type === "ac"} xUnit={xUnit} yUnit={pl.yUnit} markers={markers} onPick={pick} legend={!multi} key={`${themeKey}-${s}-${set.id}`} />}
                  </div>
                </div>
              )
            }) : <div className="text-sm text-muted-foreground">Choose signals on the left.</div>)}

            {mode === "fft" && (first.type !== "tran" ? <div className="text-sm text-muted-foreground">FFT needs a transient result.</div>
              : !fft ? <div className="text-sm text-muted-foreground">Choose a signal on the left.</div>
              : "error" in fft ? <div className="text-sm text-destructive">{String(fft.error)}</div>
              : (
                <div className="rounded-lg border bg-scope">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 pt-2 font-mono text-xs">
                    <span className="font-medium">FFT · {fft.s}{multi ? ` · ${runLabel(fftRunIdx)}` : ""} · {fftWin}</span>
                    {fft.sp.fundamental && <span>f₀ {formatSI(fft.sp.fundamental.f, "Hz", 4)} · {formatSI(fft.sp.fundamental.amp, fft.unit, 3)}</span>}
                    {Number.isFinite(fft.sp.thd) && <span>THD {(fft.sp.thd * 100).toFixed(2)} %</span>}
                    <span className="text-muted-foreground">DC {formatSI(fft.sp.dc, fft.unit, 3)} · {formatSI(fft.from, "s", 3)} – {formatSI(fft.to, "s", 3)} ({fft.range === "half" ? "second half" : fft.range === "cursors" ? "cursors" : "whole run"}) · Δf {formatSI(fft.sp.fs / fft.sp.n, "Hz", 3)}</span>
                    {fft.periods < 5 && <span className="text-warning">only {fft.periods.toFixed(1)} periods — simulate longer for a clean spectrum</span>}
                  </div>
                  <div className="h-64 p-2">
                    <BarChart className="h-full w-full" xUnit="Hz" yUnit={fft.unit} x0={0} x1={(fft.sp.fundamental?.f ?? fft.sp.fs / 20) * 12}
                      bars={fft.sp.f.map((f, k) => ({ x: f, w: Math.max(fft.sp.fs / fft.sp.n * 0.35, ((fft.sp.fundamental?.f ?? fft.sp.fs / 20) * 12) / 400), y: fft.sp.amp[k], color: k <= 1 ? "var(--muted-foreground)" : "var(--chart-2)", label: `${formatSI(f, "Hz", 4)} · ${formatSI(fft.sp.amp[k], fft.unit, 3)}` })).filter((b) => b.x <= (fft.sp.fundamental?.f ?? fft.sp.fs / 20) * 12)} />
                  </div>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-1 px-3 pb-3 font-mono text-[11px]">
                    {fft.sp.harmonics.slice(0, 9).map((h) => <div key={h.k} className="rounded border px-2 py-1"><span className="text-muted-foreground">H{h.k}</span> {formatSI(h.amp, fft.unit, 3)} <span className="text-muted-foreground">({fft.sp.fundamental ? ((h.amp / fft.sp.fundamental.amp) * 100).toFixed(1) : "—"} %)</span></div>)}
                  </div>
                </div>
              ))}

            {mode === "xy" && (
              <div className="rounded-lg border bg-scope">
                <div className="px-3 pt-2 font-mono text-xs"><span className="font-medium">{xy.y} vs {xy.x}</span>{multi && <span className="text-muted-foreground"> · {visible.length} runs</span>}</div>
                <div className="h-[420px] p-2">
                  <XYChart className="h-full w-full" xUnit={unitOfSignal(xy.x)} yUnit={unitOfSignal(xy.y)}
                    series={visible.map(({ r, i }) => {
                      const a = series(r.result, xy.x), b = series(r.result, xy.y)
                      return "error" in a || "error" in b || a.x.length !== b.x.length ? { x: [], y: [], color: "", label: "" } : { x: a.y, y: b.y, color: color(i), label: runLabel(i) }
                    })} />
                </div>
              </div>
            )}

            {mode === "hist" && (!measureNames.length ? <div className="text-sm text-muted-foreground">Add measurements in Simulation setup (or <span className="font-mono">measure</span> in Kirk) and run a sweep or Monte Carlo.</div>
              : !hist ? <div className="text-sm text-muted-foreground">No values for {histMeasure}.</div>
              : (
                <div className="rounded-lg border bg-scope">
                  <div className="flex flex-wrap items-center gap-x-4 px-3 pt-2 font-mono text-xs">
                    <span className="font-medium">{histMeasure} · {hist.n} runs</span>
                    <span>μ {formatSI(hist.mean, hist.unit, 4)} · σ {formatSI(hist.sd, hist.unit, 3)}</span>
                    {(hist.lim.lo !== undefined || hist.lim.hi !== undefined) && <span>yield {((hist.pass / hist.n) * 100).toFixed(1)} %</span>}
                  </div>
                  <div className="h-72 p-2">
                    <BarChart className="h-full w-full" bars={hist.bars} xUnit={hist.unit} yUnit=""
                      markers={[
                        ...(hist.lim.lo !== undefined ? [{ x: hist.lim.lo, label: "LSL", color: "var(--destructive)" }] : []),
                        ...(hist.lim.hi !== undefined ? [{ x: hist.lim.hi, label: "USL", color: "var(--destructive)" }] : []),
                        { x: hist.mean, label: "μ", color: "var(--foreground)" },
                      ]} />
                  </div>
                </div>
              ))}
          </div>
        </ScrollArea>
      </div>

      {/* ---------------- measurements panel */}
      <div className="flex w-80 shrink-0 flex-col border-l">
        <div className="flex items-center justify-between px-4 pb-2 pt-3">
          <span className="text-sm font-medium">.meas results</span>
          <Badge variant="secondary">{set.runs.length} run{set.runs.length > 1 ? "s" : ""}</Badge>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-4 px-4 pb-4">
            {measureNames.length ? (
              <table className="w-full font-mono text-xs">
                <thead className="text-left text-muted-foreground"><tr><th className="py-1 font-normal">{multi ? "Run" : ""}</th>{measureNames.map((m) => <th key={m} className="py-1 text-right font-normal">{m}</th>)}</tr></thead>
                <tbody>
                  {set.runs.slice(0, 200).map((r, i) => (
                    <tr key={i} className="border-t">
                      <td className="py-1"><span className="mr-1.5 inline-block size-2 rounded-full" style={{ background: color(i) }} />{multi ? Object.values(r.params).join(" ") || r.label : "nominal"}</td>
                      {measureNames.map((m) => { const v = r.measures[m]; return <td key={m} className={cn("py-1 text-right", v && !v.ok && "text-destructive")} title={v && !v.ok ? v.error : undefined}>{!v ? "—" : v.ok ? formatSI(v.value.value, v.value.unit === "deg" ? "°" : v.value.unit, 4) : "error"}</td> })}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="text-xs text-muted-foreground">No measurements — add them in Simulation setup (⚙).</p>}

            <div>
              <div className="mb-1 text-sm font-medium">Cursors</div>
              <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-xs">
                <span className="text-muted-foreground">A</span><span className="text-right">{cursors.a !== null ? formatSI(cursors.a, xUnit, 4) : "click a plot"}</span>
                <span className="text-muted-foreground">B</span><span className="text-right">{cursors.b !== null ? formatSI(cursors.b, xUnit, 4) : "shift-click"}</span>
                {cursors.a !== null && cursors.b !== null && (<>
                  <span className="text-muted-foreground">Δ</span><span className="text-right">{formatSI(Math.abs(cursors.b - cursors.a), xUnit, 4)}{xUnit === "s" ? ` · 1/Δ ${formatSI(1 / Math.abs(cursors.b - cursors.a), "Hz", 4)}` : ""}</span>
                </>)}
                {readout && (<>
                  <span className="text-muted-foreground">{readout.s}</span>
                  <span className="text-right">{formatSI(readout.a, readout.unit, 4)}{readout.b !== null ? ` → ${formatSI(readout.b, readout.unit, 4)} (Δ ${formatSI(readout.b - readout.a, readout.unit, 3)})` : ""}</span>
                </>)}
              </div>
            </div>

            {multi && measureNames.length > 0 && (() => {
              const m = histMeasure || measureNames[0]
              const vals = set.runs.map((r) => r.measures[m]).filter((x): x is Extract<MeasureOutcome, { ok: true }> => !!x && x.ok).map((x) => x.value.value)
              if (!vals.length) return null
              const unit = (set.runs.find((r) => r.measures[m]?.ok)?.measures[m] as Extract<MeasureOutcome, { ok: true }>).value.unit
              const mean = vals.reduce((a, b) => a + b, 0) / vals.length
              const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, vals.length - 1))
              const lim = specLimits(set.doc.asserts ?? [], m)
              const hasLim = lim.lo !== undefined || lim.hi !== undefined
              const out = vals.filter((x) => (lim.lo !== undefined && x < lim.lo) || (lim.hi !== undefined && x > lim.hi)).length
              return (
                <div>
                  <div className="mb-2 text-sm font-medium">{set.label.startsWith("Monte") ? "Monte Carlo" : "Statistics"} · {m}</div>
                  <div className="grid grid-cols-3 gap-2">
                    {[["Mean", formatSI(mean, unit, 4)], ["σ", formatSI(sd, unit, 3)], ["Yield", hasLim ? `${(((vals.length - out) / vals.length) * 100).toFixed(1)} %` : "—"]].map(([k, v]) => (
                      <div key={k} className="rounded-lg border px-2 py-1.5"><div className="text-[11px] text-muted-foreground">{k}</div><div className="font-mono text-xs">{v}</div></div>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {hasLim ? `${out} of ${vals.length} runs fall outside ${lim.lo !== undefined ? formatSI(lim.lo, unit) : "−∞"} – ${lim.hi !== undefined ? formatSI(lim.hi, unit) : "+∞"}.` : `Add an assert (e.g. ${m} in a .. b) to see the yield.`}
                    {" "}Range {formatSI(Math.min(...vals), unit, 4)} … {formatSI(Math.max(...vals), unit, 4)}.
                  </p>
                </div>
              )
            })()}
          </div>
        </ScrollArea>
        <div className="grid grid-cols-2 gap-2 border-t p-3">
          <Button variant="outline" onClick={() => onExport(set.id)}><Download /> CSV</Button>
          <Button onClick={() => onReport(set, area.current)}><FileText /> Report</Button>
        </div>
      </div>
    </div>
  )
}

function useMemoSafe<T>(fn: () => T, deps: unknown[]): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(fn, deps)
}
