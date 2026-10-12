import { useMemo, useState } from "react"
import { Activity, AudioWaveform, ChartSpline, CircleCheck, CircleDot, CircleX, Cpu, X, Download, Ellipsis, Gauge, LayoutGrid, ListTree, Maximize2, Minimize2, Plus, Ruler, Sigma, SquareTerminal, Waves, Zap } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { exportCsv } from "@/editor/file"
import { displayRef, symbolFor, type Doc, type Part } from "@/editor/model"
import type { Issue } from "@/editor/netlist"
import type { AcResult, JobResult } from "@/lib/engine"
import type { Netlist } from "@/editor/netlist"
import { CliTerminal } from "./CliTerminal"
import { Bench, CurveTracer, LogicAnalyzer, PowerMeter, SpectrumAnalyzer, type InstrumentCtx } from "./Instruments"
import type { AssertOutcome, MeasureOutcome } from "@/kirk/measure"
import type { RunOutcome } from "@/lib/runs"
import { corner, db, duty, riseTime, stats } from "@/lib/measure"
import { parseValue } from "@/lib/spice"
import { genPatch, readGen, shapeOf, SHAPES, type Shape } from "@/lib/fgen"
import { formatSI } from "@/lib/units"
import { Plot, type Marker, type Trace } from "./Plot"
import type { AnalysisType } from "./Chrome"

export const CHANNEL_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"]
const cssColor = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v.slice(4, -1)).trim()
const unitOf = (s: string) => (s.startsWith("I") ? "A" : "V")

/** Round a span to a 1-2-5 per-division scale (10 divisions). */
function perDiv(span: number): number {
  const raw = Math.max(span, 1e-15) / 8
  const p = 10 ** Math.floor(Math.log10(raw))
  const m = raw / p
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p
}

interface Props {
  doc: Doc
  result: JobResult | null
  error: string | null
  probes: string[]
  setProbes: (p: string[]) => void
  /** values at the playback time (or the operating point) */
  values: Record<string, number>
  time: number | null
  onSeek: (t: number) => void
  dmm: string | null
  setDmm: (s: string | null) => void
  analysis: AnalysisType
  setAnalysis: (a: AnalysisType) => void
  onChangePart: (id: string, patch: Partial<Part>) => void
  log: string[]
  issues: Issue[]
  tab: string
  /** show the Terminal tab (AI assistant through the Claude Code CLI) */
  terminal?: boolean
  setTab: (t: string) => void
  themeKey: string
  maximized: boolean
  onToggleMax: () => void
  /** multi-run results (sweep / Monte Carlo / temperature) */
  runs: RunOutcome[] | null
  overlay: boolean
  onClearRuns: () => void
  /** measurements and asserts of the last single run */
  measures: Record<string, MeasureOutcome>
  asserts: AssertOutcome[]
  netlist: Netlist
  lastAc: AcResult | null
  onSweepAc: () => void
  sweeping: boolean
}

export function InstrumentDock(p: Props) {
  const { result, error, probes, setProbes, tab, setTab, themeKey } = p
  const [cursors, setCursors] = useState<{ a: number | null; b: number | null }>({ a: null, b: null })
  const [chan, setChan] = useState(0)
  // channels switched off stay connected (flag on the schematic) but aren't drawn
  const signals = useMemo(() => (result && result.type !== "op" ? result.names.filter((n) => /^(V|I[a-z]*)\(/.test(n)) : Object.keys(p.values)), [result, p.values])

  const scopeTab = tab === "scope" || tab === "bode"
  const onTab = (t: string) => {
    setTab(t)
    if (t === "scope" && p.analysis !== "tran") p.setAnalysis("tran")
    if (t === "bode" && p.analysis !== "ac") p.setAnalysis("ac")
    // the multimeter reads DC or time-domain values; an AC sweep has neither
    if (t === "dmm" && p.analysis === "ac") p.setAnalysis("tran")
    // spectrum and logic analyzers read a transient; the power meter a transient or OP
    if ((t === "spectrum" || t === "logic" || t === "bench") && p.analysis !== "tran") p.setAnalysis("tran")
    if (t === "power" && p.analysis === "ac") p.setAnalysis("tran")
  }

  // ---- traces
  const plot = useMemo(() => {
    if (!result || result.type === "op") return null
    const chosen = probes.filter((s) => result.names.includes(s))
    const family = p.overlay && p.runs && p.runs.length > 1 ? p.runs.filter((r) => r.result && r.result.type === result.type).slice(0, 60) : null
    if (family && (result.type === "tran" || result.type === "dc")) {
      // trace family: every run of the first channels, one colour per run
      const x = result.type === "tran" ? (family[0].result as typeof result).time : (family[0].result as typeof result).sweep
      const traces: Trace[] = []
      chosen.slice(0, 2).forEach((s, ci) => family.forEach((r, ri) => {
        const rr = r.result as typeof result
        const k = rr.names.indexOf(s)
        if (k < 0) return
        // runs have their own time points: resample onto the first run's axis
        const xs = rr.type === "tran" ? rr.time : rr.sweep
        const y = xs.length === x.length ? rr.data[k] : x.map((t) => { let j = 1; while (j < xs.length - 1 && xs[j] < t) j++; const f = (t - xs[j - 1]) / (xs[j] - xs[j - 1] || 1); return rr.data[k][j - 1] + f * (rr.data[k][j] - rr.data[k][j - 1]) })
        traces.push({ label: `${s} · ${r.label}`, y, color: cssColor(CHANNEL_COLORS[ri % CHANNEL_COLORS.length]), dash: ci ? [5, 4] : undefined })
      }))
      return { x, traces, logX: false, xUnit: result.type === "tran" ? "s" : "V", yUnit: chosen.every((s) => s.startsWith("I")) ? "A" : "V" }
    }
    if (family && result.type === "ac") {
      const x = (family[0].result as typeof result).freq
      const traces: Trace[] = []
      for (const s of chosen.slice(0, 1)) family.forEach((r, ri) => {
        const rr = r.result as typeof result
        const k = rr.names.indexOf(s)
        if (k < 0 || rr.freq.length !== x.length) return
        traces.push({ label: `|${s}| · ${r.label}`, y: rr.re[k].map((v, j) => db(v, rr.im[k][j])), color: cssColor(CHANNEL_COLORS[ri % CHANNEL_COLORS.length]) })
      })
      return { x, traces, logX: true, xUnit: "Hz", yUnit: "dB" }
    }
    if (result.type === "tran" || result.type === "dc") {
      const traces: Trace[] = chosen.map((s, i) => ({ label: s, y: result.data[result.names.indexOf(s)], color: cssColor(CHANNEL_COLORS[i % CHANNEL_COLORS.length]) }))
      return { x: result.type === "tran" ? result.time : result.sweep, traces, logX: false, xUnit: result.type === "tran" ? "s" : "V", yUnit: chosen.every((s) => s.startsWith("I")) ? "A" : "V" }
    }
    const traces: Trace[] = []
    chosen.forEach((s, i) => {
      const k = result.names.indexOf(s)
      const color = cssColor(CHANNEL_COLORS[i % CHANNEL_COLORS.length])
      traces.push({ label: `|${s}|`, y: result.re[k].map((r, j) => db(r, result.im[k][j])), color })
      traces.push({ label: `∠${s}`, y: result.re[k].map((r, j) => (Math.atan2(result.im[k][j], r) * 180) / Math.PI), color, scale: "phase", dash: [5, 4] })
    })
    return { x: result.freq, traces, logX: true, xUnit: "Hz", yUnit: "dB" }
    // themeKey re-reads CSS colours after a light/dark switch
  }, [result, probes, themeKey, p.runs, p.overlay]) // eslint-disable-line react-hooks/exhaustive-deps

  const markers: Marker[] = useMemo(() => {
    const m: Marker[] = []
    if (result?.type === "tran" && p.time !== null) m.push({ x: p.time, label: "", color: cssColor("var(--canvas-selection)") })
    if (cursors.a !== null) m.push({ x: cursors.a, label: `A ${formatSI(cursors.a, result?.type === "ac" ? "Hz" : "s", 4)}`, color: cssColor("var(--muted-foreground)") })
    if (cursors.b !== null) m.push({ x: cursors.b, label: `B ${formatSI(cursors.b, result?.type === "ac" ? "Hz" : "s", 4)}`, color: cssColor("var(--muted-foreground)") })
    return m
  }, [result, p.time, cursors, themeKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const channels = probes.filter((s) => result && result.type !== "op" && result.names.includes(s))
  const active = channels[Math.min(chan, channels.length - 1)]

  // ---- measurements of the selected channel
  const meas = useMemo(() => {
    if (!result || result.type === "op" || !active) return []
    const k = result.names.indexOf(active)
    if (result.type === "tran" || result.type === "dc") {
      const x = result.type === "tran" ? result.time : result.sweep
      const y = result.data[k]
      const s = stats(x, y)
      const u = unitOf(active)
      return [
        ["Frequency", Number.isFinite(s.freq) ? formatSI(s.freq, "Hz", 4) : "—"],
        ["Duty", Number.isFinite(duty(x, y)) ? `${(duty(x, y) * 100).toFixed(1)} %` : "—"],
        ["P-P", formatSI(s.pp, u)],
        ["Max / min", `${formatSI(s.max, u)} / ${formatSI(s.min, u)}`],
        ["RMS", formatSI(s.rms, u)],
        ["Rise 10–90 %", Number.isFinite(riseTime(x, y)) ? formatSI(riseTime(x, y), "s") : "—"],
      ]
    }
    const mag = result.re[k].map((r, j) => db(r, result.im[k][j]))
    const fc = corner(result.freq, mag)
    const j = Number.isFinite(fc) ? result.freq.findIndex((f) => f >= fc) : -1
    const ph = j >= 0 ? (Math.atan2(result.im[k][j], result.re[k][j]) * 180) / Math.PI : NaN
    const peak = Math.max(...mag)
    return [
      ["Gain @ low f", `${mag[0].toFixed(2)} dB`], ["Peak gain", `${peak.toFixed(2)} dB`],
      ["f −3 dB", Number.isFinite(fc) ? formatSI(fc, "Hz", 4) : "—"], ["Phase @ fc", Number.isFinite(ph) ? `${ph.toFixed(1)}°` : "—"],
    ]
  }, [result, active])

  const exportData = async () => {
    if (!result || result.type === "op") return
    const chosen = channels.length ? channels : result.names
    if (result.type === "ac") {
      const header = ["freq_Hz", ...chosen.flatMap((s) => [`${s}_dB`, `${s}_deg`])]
      const rows = result.freq.map((f, j) => [f, ...chosen.flatMap((s) => { const k = result.names.indexOf(s); return [db(result.re[k][j], result.im[k][j]), (Math.atan2(result.im[k][j], result.re[k][j]) * 180) / Math.PI] })])
      await exportCsv(`${p.doc.title} - AC`, header, rows)
    } else {
      const x = result.type === "tran" ? result.time : result.sweep
      const header = [result.type === "tran" ? "time_s" : "sweep", ...chosen]
      const rows = x.map((v, j) => [v, ...chosen.map((s) => result.data[result.names.indexOf(s)][j])])
      await exportCsv(`${p.doc.title} - ${result.type}`, header, rows)
    }
  }

  const xUnit = result?.type === "ac" ? "Hz" : result?.type === "dc" ? "V" : "s"
  const span = plot ? plot.x[plot.x.length - 1] - plot.x[0] : 0
  const delta = cursors.a !== null && cursors.b !== null ? Math.abs(cursors.b - cursors.a) : null

  return (
    <Tabs value={tab} onValueChange={onTab} className="@container flex h-full flex-col gap-0">
      <div className="flex items-center gap-2 overflow-hidden whitespace-nowrap border-b px-2 py-1">
        <TabsList className="min-w-0 shrink overflow-x-auto [scrollbar-width:none] [&_[data-slot=tabs-trigger]_.lbl]:hidden @[760px]:[&_[data-slot=tabs-trigger]_.lbl]:inline">
          <TabsTrigger value="bench" title="Bench view: every instrument at once"><LayoutGrid /> <span className="lbl">Bench</span></TabsTrigger>
          <TabsTrigger value="scope" title="Oscilloscope"><Activity /> <span className="lbl">Oscilloscope</span></TabsTrigger>
          <TabsTrigger value="dmm" title="Multimeter"><Gauge /> <span className="lbl">Multimeter</span></TabsTrigger>
          <TabsTrigger value="fgen" title="Function generator"><AudioWaveform /> <span className="lbl">Function gen</span></TabsTrigger>
          <TabsTrigger value="bode" title="Bode plotter"><ChartSpline /> <span className="lbl">Bode plotter</span></TabsTrigger>
          <TabsTrigger value="spectrum" title="Spectrum analyzer"><Waves /> <span className="lbl">Spectrum</span></TabsTrigger>
          <TabsTrigger value="logic" title="Logic analyzer"><CircleDot /> <span className="lbl">Logic</span></TabsTrigger>
          <TabsTrigger value="power" title="Power meter"><Zap /> <span className="lbl">Power</span></TabsTrigger>
          <TabsTrigger value="tracer" title="Curve tracer"><Cpu /> <span className="lbl">Curve tracer</span></TabsTrigger>
          <TabsTrigger value="results" title="Results"><Sigma /> <span className="lbl">Results</span>{p.runs && p.runs.length > 1 && <Badge variant="secondary" className="ml-1 h-4 px-1">{p.runs.length}</Badge>}</TabsTrigger>
          <TabsTrigger value="log" title="Console"><ListTree /> <span className="lbl">Console</span>{p.issues.length > 0 && <Badge variant="secondary" className="ml-1 h-4 bg-destructive-subtle px-1 text-destructive">{p.issues.length}</Badge>}</TabsTrigger>
          {p.terminal && <TabsTrigger value="terminal" title="Terminal: the claude command behind the AI assistant"><SquareTerminal /> <span className="lbl">Terminal</span></TabsTrigger>}
        </TabsList>
        <div className="flex-1" />
        <span className="hidden font-mono text-xs text-muted-foreground @[900px]:inline">{probes.length + (p.dmm ? 1 : 0)} probe{probes.length + (p.dmm ? 1 : 0) === 1 ? "" : "s"} connected</span>
        <Button variant="ghost" size="icon-sm" onClick={p.onToggleMax} title={p.maximized ? "Restore" : "Maximize"}>{p.maximized ? <Minimize2 /> : <Maximize2 />}</Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm"><Ellipsis /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => { setProbes([]); p.setDmm(null) }}>Remove all probes</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setCursors({ a: null, b: null })}>Clear cursors</DropdownMenuItem>
            <DropdownMenuItem onClick={exportData} disabled={!result || result.type === "op"}>Export data (CSV)…</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* ---------------- oscilloscope / Bode ---------------- */}
      {scopeTab && (
        <div className="flex min-h-0 flex-1 gap-3 p-3">
          <div className="flex min-w-0 flex-1 flex-col rounded-lg border bg-scope">
            <div className="min-h-0 flex-1 p-2">
              {error ? (
                <div className="flex h-full items-center justify-center px-6 text-center text-sm text-destructive">{error}</div>
              ) : plot && plot.traces.length && (tab === "bode") === (result?.type === "ac") ? (
                <Plot {...plot} markers={markers} onPick={(x, shift) => setCursors((c) => (shift || (c.a !== null && c.b === null) ? { ...c, b: x } : { a: x, b: null }))} />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
                  {tab === "scope" && p.analysis !== "tran" ? (<>
                    <span>The oscilloscope shows a transient run; the current analysis is {p.analysis === "ac" ? "an AC sweep" : "the operating point"}.</span>
                    <Button size="sm" variant="outline" onClick={() => p.setAnalysis("tran")}><Activity /> Run transient</Button>
                  </>) : tab === "bode" && p.analysis !== "ac" ? (<>
                    <span>The Bode plotter shows an AC sweep.</span>
                    <Button size="sm" variant="outline" onClick={() => p.setAnalysis("ac")}><ChartSpline /> Run AC sweep</Button>
                  </>) : !probes.length ? "Probe a wire or part (P) to connect a channel." : "Press Simulate (F5) to run the circuit."}
                </div>
              )}
            </div>
            <div className="flex items-center gap-4 border-t px-3 py-1 font-mono text-[11px] text-muted-foreground">
              {plot && <span>{result?.type === "ac" ? "log f" : `${formatSI(span / 10, xUnit, 3)}/div`}</span>}
              {result?.type !== "ac" && channels.map((s, i) => {
                const y = result && (result.type === "tran" || result.type === "dc") && result.names.includes(s) ? result.data[result.names.indexOf(s)] : []
                const sp = y.length ? Math.max(...y) - Math.min(...y) : 0
                return <span key={s} style={{ color: CHANNEL_COLORS[i % CHANNEL_COLORS.length] }}>CH{i + 1} {formatSI(perDiv(sp), unitOf(s), 2)}/div</span>
              })}
              <div className="flex-1" />
              {delta !== null ? <span>ΔA–B {formatSI(delta, xUnit, 4)}{result?.type === "tran" ? ` · 1/Δ ${formatSI(1 / delta, "Hz", 4)}` : ""}</span> : <span>click: cursor A · shift-click: cursor B</span>}
            </div>
          </div>
          <div className="flex w-64 shrink-0 flex-col gap-2">
            <ScrollArea className="max-h-[45%] rounded-lg border bg-card">
              <div className="flex flex-col p-1">
                <div className="divide-y">
                {probes.map((s, i) => (
                  <div key={s} role="button" tabIndex={0} onClick={() => setChan(channels.indexOf(s))} onKeyDown={(e) => e.key === "Enter" && setChan(channels.indexOf(s))} className={`flex cursor-pointer items-center gap-2 px-2 py-1.5 text-left hover:bg-accent/60 ${active === s ? "bg-accent" : ""}`}>
                    <span className="size-2 shrink-0 rounded-full" style={{ background: CHANNEL_COLORS[i % CHANNEL_COLORS.length] }} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-xs font-medium">CH{i + 1} · {s}</span>
                      <span className="block font-mono text-[10px] text-muted-foreground">{p.values[s] !== undefined ? formatSI(p.values[s], unitOf(s), 4) : "—"} · DC · ×1</span>
                    </span>
                    <button title="Remove probe" onClick={(e) => { e.stopPropagation(); setProbes(probes.filter((q) => q !== s)); if (p.dmm === s) p.setDmm(null) }} className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"><X className="size-3.5" /></button>
                  </div>
                ))}
                </div>
                <Select value="" onValueChange={(v) => v && setProbes([...probes, v])}>
                  <SelectTrigger size="sm" className={`${probes.length ? "mt-1" : ""} h-7 w-full text-xs`}><Plus className="size-3.5" /><SelectValue placeholder="Add channel" /></SelectTrigger>
                  <SelectContent>
                    {signals.filter((s) => !probes.includes(s)).map((s) => <SelectItem key={s} value={s} className="font-mono text-xs">{s}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </ScrollArea>
            <ScrollArea className="min-h-0 flex-1 rounded-lg border bg-card">
              <div className="p-2">
                {active ? (<>
                  <div className="mb-1 font-mono text-[11px] text-muted-foreground">Measurements · {active}</div>
                  {meas.map(([k, v]) => (
                    <div key={k} className="flex justify-between px-1 py-0.5 text-xs"><span className="text-muted-foreground">{k}</span><span className="font-mono">{v}</span></div>
                  ))}
                </>) : <div className="text-xs text-muted-foreground">Measurements appear for the selected channel.</div>}
              </div>
            </ScrollArea>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" size="sm" onClick={() => {
                if (!plot) return
                const x0 = plot.x[0], x1 = plot.x[plot.x.length - 1]
                setCursors(result?.type === "ac" ? { a: Math.sqrt(x0 * x1) / 3, b: Math.sqrt(x0 * x1) * 3 } : { a: x0 + (x1 - x0) * 0.25, b: x0 + (x1 - x0) * 0.75 })
              }}><Ruler /> Measure</Button>
              <Button variant="outline" size="sm" onClick={exportData} disabled={!result || result.type === "op"}><Download /> Export</Button>
            </div>
          </div>
        </div>
      )}

      {/* ---------------- multimeter ---------------- */}
      {(["bench", "spectrum", "logic", "power", "tracer"] as const).map((t) => (
        <TabsContent key={t} value={t} className="min-h-0 flex-1 overflow-hidden p-3">
          {tab === t && (() => {
            const ctx: InstrumentCtx = { doc: p.doc, netlist: p.netlist, result, probes, values: p.values, dmm: p.dmm, setDmm: p.setDmm, time: p.time, themeKey, onChangePart: p.onChangePart, lastAc: p.lastAc, onSweepAc: p.onSweepAc, sweeping: p.sweeping }
            return t === "bench" ? <Bench {...ctx} /> : t === "spectrum" ? <SpectrumAnalyzer {...ctx} /> : t === "logic" ? <LogicAnalyzer {...ctx} /> : t === "power" ? <PowerMeter {...ctx} /> : <CurveTracer {...ctx} />
          })()}
        </TabsContent>
      ))}
      <TabsContent value="dmm" className="min-h-0 flex-1 overflow-auto p-3">
        <Multimeter {...p} signals={signals} />
      </TabsContent>

      {/* ---------------- function generator ---------------- */}
      <TabsContent value="fgen" className="min-h-0 flex-1 overflow-auto p-3">
        <FunctionGen doc={p.doc} onChangePart={p.onChangePart} />
      </TabsContent>

      {p.terminal && (
        <TabsContent value="terminal" className="min-h-0 flex-1 overflow-hidden bg-scope p-3 font-mono text-xs">
          <CliTerminal />
        </TabsContent>
      )}

      <TabsContent value="results" className="min-h-0 flex-1 overflow-auto p-3">
        <Results runs={p.runs} measures={p.measures} asserts={p.asserts} doc={p.doc} onClear={p.onClearRuns} />
      </TabsContent>

      <TabsContent value="log" className="min-h-0 flex-1 overflow-auto bg-scope p-3 font-mono text-xs">
        {p.issues.map((i, k) => (
          <div key={`i${k}`} className={i.severity === "error" ? "text-destructive" : "text-warning"}>{i.severity === "error" ? "ERC error" : "ERC warning"} · {i.message}</div>
        ))}
        {p.issues.length > 0 && <div className="my-2 border-t" />}
        {p.log.map((l, i) => (
          <div key={i} className={`whitespace-pre ${l.includes("error") || l.includes("failed") ? "text-destructive" : "text-muted-foreground"}`}>{l}</div>
        ))}
        {!p.log.length && <Badge variant="outline">No runs yet</Badge>}
      </TabsContent>
    </Tabs>
  )
}

// ---------------------------------------------------------------- multimeter

function Multimeter({ values, dmm, setDmm, result, time, signals }: Props & { signals: string[] }) {
  const sig = dmm && values[dmm] !== undefined ? dmm : signals[0] ?? null
  const v = sig ? values[sig] : undefined
  const range = useMemo(() => {
    if (!sig || !result || result.type !== "tran") return null
    const k = result.names.indexOf(sig)
    if (k < 0) return null
    const y = result.data[k]
    return { min: Math.min(...y), max: Math.max(...y) }
  }, [sig, result])
  const all = Object.entries(values).filter(([k]) => /^(V|I[a-z]*)\(/.test(k)).sort((a, b) => a[0].localeCompare(b[0]))
  return (
    <div className="flex h-full gap-3">
      <div className="flex w-80 shrink-0 flex-col gap-3 rounded-lg border bg-card p-4">
        <div className="flex items-center gap-2">
          <Select value={sig ?? ""} onValueChange={(s) => setDmm(s)}>
            <SelectTrigger className="flex-1 font-mono text-xs"><SelectValue placeholder="Choose a signal" /></SelectTrigger>
            <SelectContent>{signals.map((s) => <SelectItem key={s} value={s} className="font-mono text-xs">{s}</SelectItem>)}</SelectContent>
          </Select>
          <Badge variant="secondary">{sig ? (sig.startsWith("I") ? "A ⎓" : "V ⎓") : "—"}</Badge>
        </div>
        <div className="rounded-lg bg-scope px-4 py-5 text-right font-mono text-4xl tabular-nums">{v !== undefined ? formatSI(v, sig?.startsWith("I") ? "A" : "V", 4) : "—"}</div>
        <div className="flex justify-between font-mono text-xs text-muted-foreground">
          <span>{time !== null ? `transient · t = ${formatSI(time, "s", 4)}` : result?.type === "tran" ? "transient · end of run" : "DC operating point"}</span>
          {range && <span>min {formatSI(range.min, sig!.startsWith("I") ? "A" : "V")} · max {formatSI(range.max, sig!.startsWith("I") ? "A" : "V")}</span>}
        </div>
        <p className="text-xs text-muted-foreground">Tip: probe a part with P to read its current here.</p>
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-2 text-xs font-medium text-muted-foreground">All readings</div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-2">
          {all.map(([n, x]) => (
            <button key={n} onClick={() => setDmm(n)} className={`rounded-lg border bg-card px-3 py-2 text-left hover:border-ring ${n === sig ? "border-ring" : ""}`}>
              <div className="font-mono text-xs text-muted-foreground">{n}</div>
              <div className="font-mono text-sm">{formatSI(x, n.startsWith("I") ? "A" : "V", 4)}</div>
            </button>
          ))}
          {!all.length && <div className="text-sm text-muted-foreground">Press Simulate to measure.</div>}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- function generator

export function NumField({ label, value, unit, onCommit }: { label: string; value: number; unit: string; onCommit: (v: number) => void }) {
  const [text, setText] = useState<string | null>(null)
  const shown = text ?? formatSI(value, "").replace(/\s/g, "")
  const commit = () => { const v = parseValue(text ?? ""); if (text !== null && v !== null) onCommit(v); setText(null) }
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="relative">
        <Input value={shown} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} className="pr-9 font-mono" />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{unit}</span>
      </div>
    </label>
  )
}

function FunctionGen({ doc, onChangePart }: { doc: Doc; onChangePart: Props["onChangePart"] }) {
  const sources = doc.parts.filter((q) => /^Simulation_SPICE:V(SIN|PULSE|DC)$/.test(q.lib))
  const [id, setId] = useState<string | null>(null)
  const part = sources.find((s) => s.id === id) ?? sources.find((s) => !/VDC$/.test(s.lib)) ?? sources[0]
  if (!part) return <div className="text-sm text-muted-foreground">Place a voltage source (V) — the function generator drives it.</div>
  const shape = shapeOf(part)
  const g = readGen(part)
  const set = (s: Shape, patch: Partial<typeof g>) => onChangePart(part.id, genPatch(part, s, { ...g, ...patch }))
  const enabled = part.sim?.Exclude !== "1"
  return (
    <div className="flex gap-4">
      <div className="flex w-[560px] flex-col gap-4 rounded-lg border bg-card p-4">
        <div className="flex items-center gap-3">
          <Select value={part.id} onValueChange={setId}>
            <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
            <SelectContent>{sources.map((s) => <SelectItem key={s.id} value={s.id}>{displayRef(s)} · {symbolFor(s)?.name}</SelectItem>)}</SelectContent>
          </Select>
          <div className="flex rounded-lg bg-muted p-[3px]">
            {SHAPES.map(([s, l]) => (
              <button key={s} onClick={() => set(s, {})} className={`h-7 rounded-md px-3 text-sm ${shape === s ? "bg-background shadow-sm" : "text-muted-foreground"}`}>{l}</button>
            ))}
          </div>
          <div className="flex-1" />
          <label className="flex items-center gap-2 text-sm">Output <Switch checked={enabled} onCheckedChange={(c) => onChangePart(part.id, { sim: { ...part.sim, Exclude: c ? undefined : "1" } })} /></label>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <NumField label="Frequency" value={g.f} unit="Hz" onCommit={(v) => set(shape, { f: v })} />
          <NumField label={shape === "dc" ? "—" : "Amplitude"} value={g.amp} unit="V" onCommit={(v) => set(shape, { amp: v })} />
          <NumField label={shape === "dc" ? "Level" : "Offset"} value={g.off} unit="V" onCommit={(v) => set(shape, { off: v })} />
        </div>
        <p className="text-xs text-muted-foreground">Drives {displayRef(part)} on the schematic. Square and triangle use a PULSE source; changes re-simulate in real-time mode.</p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- results (measurements per run)

const fmtQ = (m: MeasureOutcome | undefined) => (!m ? "—" : m.ok ? formatSI(m.value.value, m.value.unit === "deg" ? "°" : m.value.unit, 4) : "error")

function Results({ runs, measures, asserts, doc, onClear }: { runs: RunOutcome[] | null; measures: Record<string, MeasureOutcome>; asserts: AssertOutcome[]; doc: Doc; onClear: () => void }) {
  const names = (doc.measures ?? []).map((m) => m.name)
  const multi = runs && runs.length > 1 ? runs : null
  if (!names.length && !(doc.asserts ?? []).length && !multi) {
    return <div className="text-sm text-muted-foreground">No measurements yet — add them in Simulation setup (⚙ in the toolbar) or with <span className="font-mono">measure f = frequency(V(out))</span> in the Kirk code.</div>
  }
  const assertCell = (a: AssertOutcome | undefined) => !a ? "—" : !a.ok ? <span className="text-destructive" title={a.error}>error</span> : a.pass ? <CircleCheck className="inline size-4 text-success" /> : <CircleX className={`inline size-4 ${a.severity === "warning" ? "text-warning" : "text-destructive"}`} />
  if (!multi) {
    return (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2">
        {names.map((n) => (
          <div key={n} className="rounded-lg border bg-card px-3 py-2" title={measures[n] && !measures[n].ok ? (measures[n] as { error: string }).error : (doc.measures ?? []).find((m) => m.name === n)?.expr}>
            <div className="font-mono text-xs text-muted-foreground">{n}</div>
            <div className={`font-mono text-sm ${measures[n] && !measures[n].ok ? "text-destructive" : ""}`}>{measures[n] && !measures[n].ok ? (measures[n] as { error: string }).error : fmtQ(measures[n])}</div>
          </div>
        ))}
        {(doc.asserts ?? []).map((a, i) => (
          <div key={a + i} className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 font-mono text-xs">{assertCell(asserts[i])}<span className="truncate">{a}</span></div>
        ))}
      </div>
    )
  }
  // statistics over runs
  const stat = (n: string) => {
    const v = multi.map((r) => r.measures[n]).filter((m): m is Extract<MeasureOutcome, { ok: true }> => !!m && m.ok).map((m) => m.value.value)
    if (!v.length) return null
    const mean = v.reduce((a, b) => a + b, 0) / v.length
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, v.length - 1))
    const unit = multi.find((r) => r.measures[n]?.ok)?.measures[n]
    return { mean, sd, min: Math.min(...v), max: Math.max(...v), unit: unit && unit.ok ? unit.value.unit : "" }
  }
  const passing = multi.filter((r) => r.asserts.length && r.asserts.every((a) => a.ok && (a.pass || a.severity === "warning"))).length
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 text-sm">
        <span className="font-medium">{multi.length} runs</span>
        {(doc.asserts ?? []).length > 0 && <Badge variant="secondary" className={passing === multi.length ? "bg-success-subtle text-success" : "bg-warning-subtle text-warning"}>Yield {((passing / multi.length) * 100).toFixed(1)} %</Badge>}
        <div className="flex-1" />
        <Button variant="outline" size="sm" onClick={async () => {
          const header = ["run", ...Object.keys(multi[0].params), ...names]
          await exportCsv(`${doc.title} - runs`, header, multi.map((r, i) => [i + 1, ...Object.values(r.params).map((v) => parseValue(v) ?? NaN), ...names.map((n) => (r.measures[n]?.ok ? (r.measures[n] as { value: { value: number } }).value.value : NaN))]))
        }}><Download /> CSV</Button>
        <Button variant="ghost" size="sm" onClick={onClear}>Clear runs</Button>
      </div>
      {names.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
          {names.map((n) => { const s = stat(n); return (
            <div key={n} className="rounded-lg border bg-card px-3 py-2 font-mono text-xs">
              <div className="text-muted-foreground">{n}</div>
              {s ? <div>μ {formatSI(s.mean, s.unit, 4)} · σ {formatSI(s.sd, s.unit, 3)}<br /><span className="text-muted-foreground">{formatSI(s.min, s.unit, 4)} … {formatSI(s.max, s.unit, 4)}</span></div> : <div className="text-destructive">no values</div>}
            </div>
          ) })}
        </div>
      )}
      <table className="w-full font-mono text-xs">
        <thead className="text-left text-muted-foreground"><tr><th className="py-1 font-normal">#</th><th className="py-1 font-normal">Run</th>{names.map((n) => <th key={n} className="py-1 text-right font-normal">{n}</th>)}{(doc.asserts ?? []).map((a, i) => <th key={i} className="py-1 text-center font-normal" title={a}>A{i + 1}</th>)}<th className="py-1 text-right font-normal">time</th></tr></thead>
        <tbody>
          {multi.map((r, i) => (
            <tr key={i} className="border-t">
              <td className="py-1"><span className="mr-1 inline-block size-2 rounded-full" style={{ background: CHANNEL_COLORS[i % CHANNEL_COLORS.length] }} />{i + 1}</td>
              <td className="py-1">{r.label}{r.error && <span className="ml-2 text-destructive" title={r.error}>failed</span>}</td>
              {names.map((n) => <td key={n} className={`py-1 text-right ${r.measures[n] && !r.measures[n].ok ? "text-destructive" : ""}`} title={r.measures[n] && !r.measures[n].ok ? (r.measures[n] as { error: string }).error : undefined}>{fmtQ(r.measures[n])}</td>)}
              {(doc.asserts ?? []).map((_, k) => <td key={k} className="py-1 text-center">{assertCell(r.asserts[k])}</td>)}
              <td className="py-1 text-right text-muted-foreground">{Math.round(r.ms)} ms</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
