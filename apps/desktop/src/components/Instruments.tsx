// Instruments: the bench view, spectrum analyzer, logic analyzer,
// power meter, curve tracer, and the "Instruments & data" panel with data collection.
import { useEffect, useMemo, useState } from "react"
import {
  Activity, AudioWaveform, ChartSpline, CircleDot, Cpu, Download, Gauge, Loader2, Play, Radio, Square, Waves, Zap,
} from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { saveExport } from "@/editor/file"
import { displayRef, type Doc, type Part } from "@/editor/model"
import type { Netlist } from "@/editor/netlist"
import { simulate, type AcResult, type JobResult } from "@/lib/engine"
import { spectrum, type Window } from "@/lib/fft"
import { genPatch, readGen, shapeOf, SHAPES, type Shape } from "@/lib/fgen"
import { acRms, mean, powerTable, response, toLogic, tracerCurves, tracerDeck, tracerKind } from "@/lib/instruments"
import { stats } from "@/lib/measure"
import { bufferBytes, recordingCsv, setSignals, setTrigger, startRecording, stopRecording, useRecorder } from "@/lib/recorder"
import { buildNetlist, parseValue, resolveSim } from "@/lib/spice"
import { formatSI } from "@/lib/units"
import { cn } from "@/lib/utils"
import { Plot, type Trace } from "./Plot"

export interface InstrumentCtx {
  doc: Doc
  netlist: Netlist
  result: JobResult | null
  probes: string[]
  values: Record<string, number>
  dmm: string | null
  setDmm: (s: string | null) => void
  time: number | null
  themeKey: string
  onChangePart: (id: string, patch: Partial<Part>) => void
  /** the last AC sweep (for the Bode plotter while the scope shows a transient) */
  lastAc: AcResult | null
  onSweepAc: () => void
  sweeping: boolean
}

const cssColor = (v: string) => (v.startsWith("var(") ? getComputedStyle(document.documentElement).getPropertyValue(v.slice(4, -1)).trim() || "#888" : v)
const COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"]
const unitOf = (s: string) => (s.startsWith("I") ? "A" : "V")

function Card({ icon, title, tag, action, children, className }: { icon: React.ReactNode; title: string; tag?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4", className)}>
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">{icon}</span>
        <h3 className="text-sm font-medium">{title}</h3>
        <div className="flex-1" />
        {action}
        {tag && <span className="rounded-md border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{tag}</span>}
      </div>
      {children}
    </section>
  )
}

function Seg<T extends string>({ value, options, onChange, className }: { value: T; options: [T, string][]; onChange: (v: T) => void; className?: string }) {
  return (
    <div className={cn("flex rounded-lg bg-muted p-[3px]", className)}>
      {options.map(([v, l]) => (
        <button key={v} onClick={() => onChange(v)} className={cn("h-7 flex-1 rounded-md px-2 text-sm", value === v ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground")}>{l}</button>
      ))}
    </div>
  )
}

const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <div className="flex items-baseline justify-between gap-3 text-xs"><span className="text-muted-foreground">{k}</span><span className="truncate font-mono">{v}</span></div>
)

/** Big readout split into number and unit: "1.000" + "kHz". */
function Readout({ value, unit, digits = 4 }: { value: number | undefined; unit: string; digits?: number }) {
  if (value === undefined || !Number.isFinite(value)) return <div className="font-mono text-4xl tabular-nums text-muted-foreground">—</div>
  const [num, u] = formatSI(value, unit, digits).split(/\s+/)
  return <div className="flex items-baseline gap-1.5"><span className="font-mono text-4xl tabular-nums tracking-tight">{num}</span><span className="text-sm text-muted-foreground">{u ?? unit}</span></div>
}

const tranOf = (r: JobResult | null) => (r?.type === "tran" ? r : null)

// ---------------------------------------------------------------- bench

export function Bench(p: InstrumentCtx) {
  return (
    <div className="grid h-full grid-cols-1 gap-3 overflow-auto @[760px]:grid-cols-2 @[1400px]:grid-cols-4">
      <GeneratorCard {...p} />
      <MeterCard {...p} />
      <ScopeCard {...p} />
      <BodeCard {...p} />
    </div>
  )
}

function drivenSource(doc: Doc) {
  const sources = doc.parts.filter((q) => /^Simulation_SPICE:V(SIN|PULSE|DC)$/.test(q.lib))
  return { sources, part: sources.find((s) => !/VDC$/.test(s.lib)) ?? sources[0] }
}

function GeneratorCard({ doc, netlist, onChangePart }: InstrumentCtx) {
  const { sources, part: first } = drivenSource(doc)
  const [id, setId] = useState<string | null>(null)
  const part = sources.find((s) => s.id === id) ?? first
  const [drag, setDrag] = useState<number | null>(null)
  if (!part) return <Card icon={<AudioWaveform className="size-4" />} title="Function generator"><p className="text-sm text-muted-foreground">Place a voltage source (V); the generator drives it.</p></Card>
  const shape = shapeOf(part)
  const g = readGen(part)
  const set = (s: Shape, patch: Partial<typeof g>) => onChangePart(part.id, genPatch(part, s, { ...g, ...patch }))
  const pos = netlist.pinNet.get(`${part.ref}.1`)
  const f = drag !== null ? 10 ** drag : g.f
  return (
    <Card icon={<AudioWaveform className="size-4" />} title="Function generator" tag={`${displayRef(part)} → ${pos ?? "?"}`}
      action={sources.length > 1 && (
        <Select value={part.id} onValueChange={setId}>
          <SelectTrigger size="sm" className="h-6 w-24 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>{sources.map((s) => <SelectItem key={s.id} value={s.id} className="text-xs">{displayRef(s)}</SelectItem>)}</SelectContent>
        </Select>
      )}>
      <Seg value={shape} options={SHAPES.map(([s, l]) => [s, s === "triangle" ? "Tri" : l]) as [Shape, string][]} onChange={(s) => set(s, {})} />
      <Readout value={shape === "dc" ? g.off : f} unit={shape === "dc" ? "V" : "Hz"} />
      {shape !== "dc" && (
        <Slider min={1} max={6} step={0.01} value={[Math.log10(f)]} onValueChange={([v]) => setDrag(v)}
          onValueCommit={([v]) => { setDrag(null); set(shape, { f: Number((10 ** v).toPrecision(3)) }) }} />
      )}
      <div className="flex flex-col gap-2">
        {shape !== "dc" && <NumRow label="Amplitude" value={g.amp * 2} unit="Vpp" onCommit={(v) => set(shape, { amp: v / 2 })} />}
        <NumRow label={shape === "dc" ? "Level" : "Offset"} value={g.off} unit="V" onCommit={(v) => set(shape, { off: v })} />
        <div className="flex items-center justify-between text-xs"><span className="text-muted-foreground">Output</span>
          <Switch checked={part.sim?.Exclude !== "1"} onCheckedChange={(c) => onChangePart(part.id, { sim: { ...part.sim, Exclude: c ? undefined : "1" } })} /></div>
      </div>
    </Card>
  )
}

function NumRow({ label, value, unit, onCommit }: { label: string; value: number; unit: string; onCommit: (v: number) => void }) {
  const [text, setText] = useState<string | null>(null)
  const commit = () => { const v = parseValue(text ?? ""); if (text !== null && v !== null) onCommit(v); setText(null) }
  return (
    <label className="flex items-center justify-between gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1">
        <Input value={text ?? formatSI(value, "", 3).replace(/\s/g, "")} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()}
          className="h-7 w-20 text-right font-mono text-xs" />
        <span className="w-7 text-muted-foreground">{unit}</span>
      </span>
    </label>
  )
}

type MeterMode = "vdc" | "vac" | "adc" | "aac"
/** What a bench meter shows for a signal: DC = mean, AC = true RMS of the AC part (over the second half of the run). */
export function meterReading(r: JobResult | null, values: Record<string, number>, sig: string | null, mode: MeterMode) {
  if (!sig) return { v: undefined as number | undefined, min: NaN, max: NaN, note: "no signal" }
  const tr = tranOf(r)
  if (tr && tr.names.includes(sig)) {
    const y = tr.data[tr.names.indexOf(sig)]
    const from = Math.floor(tr.time.length / 2)
    const t = tr.time.slice(from), w = y.slice(from)
    const v = mode.endsWith("ac") ? acRms(t, w) : mean(t, w)
    return { v, min: Math.min(...w), max: Math.max(...w), note: `${mode.endsWith("ac") ? "true RMS" : "average"} · last ${formatSI(t[t.length - 1] - t[0], "s")}` }
  }
  const v = values[sig]
  return { v: mode.endsWith("ac") ? (v !== undefined ? 0 : undefined) : v, min: v, max: v, note: "operating point" }
}

function MeterCard({ result, values, dmm, setDmm, probes }: InstrumentCtx) {
  const [mode, setMode] = useState<MeterMode>(() => (dmm?.startsWith("I") ? "adc" : "vdc"))
  const wantI = mode.startsWith("a")
  const all = Object.keys(values).filter((k) => (wantI ? /^I[a-z]*\(/ : /^V\(/).test(k)).sort()
  const sig = dmm && (wantI ? dmm.startsWith("I") : dmm.startsWith("V(")) && all.includes(dmm) ? dmm : probes.find((s) => all.includes(s)) ?? all[0] ?? null
  const r = meterReading(result, values, sig, mode)
  const u = wantI ? "A" : "V"
  return (
    <Card icon={<Gauge className="size-4" />} title="Multimeter" tag={sig ? `DMM → ${sig}` : "DMM"}
      action={all.length > 0 && (
        <Select value={sig ?? ""} onValueChange={setDmm}>
          <SelectTrigger size="sm" className="h-6 max-w-32 font-mono text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>{all.map((s) => <SelectItem key={s} value={s} className="font-mono text-xs">{s}</SelectItem>)}</SelectContent>
        </Select>
      )}>
      <div className="rounded-lg border bg-scope px-4 py-4">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-4xl tabular-nums tracking-tight">{r.v !== undefined && Number.isFinite(r.v) ? formatSI(r.v, u, 4).split(/\s+/)[0] : "—"}</span>
          <span className="text-sm text-muted-foreground">{r.v !== undefined && Number.isFinite(r.v) ? formatSI(r.v, u, 4).split(/\s+/)[1] ?? u : u} {mode.endsWith("ac") ? "AC rms" : "DC"}</span>
        </div>
        <div className="mt-1 font-mono text-[11px] text-muted-foreground">Auto range · 4½ digits · {r.note}</div>
      </div>
      <Seg value={mode} options={[["vdc", "V⎓"], ["vac", "V~"], ["adc", "A⎓"], ["aac", "A~"]]} onChange={setMode} />
      <div className="flex flex-col gap-1.5">
        <Row k="Min / max" v={Number.isFinite(r.min) ? `${formatSI(r.min, u, 4)} / ${formatSI(r.max, u, 4)}` : "—"} />
        <Row k="Peak-to-peak" v={Number.isFinite(r.min) ? formatSI(r.max - r.min, u, 4) : "—"} />
      </div>
    </Card>
  )
}

function ScopeCard({ result, probes, themeKey }: InstrumentCtx) {
  const tr = tranOf(result)
  const chosen = tr ? probes.filter((s) => tr.names.includes(s)).slice(0, 4) : []
  const traces: Trace[] = useMemo(() => (tr ? chosen.map((s, i) => ({ label: s, y: tr.data[tr.names.indexOf(s)], color: cssColor(COLORS[i % COLORS.length]) })) : []),
    [tr, chosen.join(), themeKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const first = tr && chosen[0] ? stats(tr.time, tr.data[tr.names.indexOf(chosen[0])]) : null
  return (
    <Card icon={<Activity className="size-4" />} title="Oscilloscope" tag={chosen.length ? chosen.map((s, i) => `CH${i + 1} ${s.replace(/^V\((.*)\)$/, "$1")}`).join(" · ") : "no channels"}>
      <div className="h-44 min-h-0 overflow-hidden rounded-lg border bg-scope">
        {tr && traces.length ? <Plot x={tr.time} traces={traces} xUnit="s" yUnit={chosen.every((s) => s.startsWith("I")) ? "A" : "V"} legend={false} />
          : <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">{tr ? "Probe a wire (P) to connect a channel." : "Run a transient to see the waveforms."}</div>}
      </div>
      <Row k={chosen[0] ? `CH1 ${chosen[0]}` : "CH1"} v={first ? `${Number.isFinite(first.freq) ? `${formatSI(first.freq, "Hz", 4)} · ` : ""}${formatSI(first.pp, unitOf(chosen[0]))} pp` : "—"} />
    </Card>
  )
}

/** Gain / phase of out over in at every frequency (in = AC source when only one probe), −3 dB points from the peak. */
export function bodeOf(ac: AcResult, probes: string[]) {
  const vs = probes.filter((s) => s.startsWith("V(") && ac.names.includes(s))
  const out = vs[1] ?? vs[0] ?? ac.names.find((n) => n.startsWith("V("))
  const inn = vs.length > 1 ? vs[0] : null
  if (!out) return null
  return { in: inn, out, ...response(ac.freq, ac, ac.names.indexOf(out), inn ? ac.names.indexOf(inn) : -1) }
}

function BodeCard({ lastAc, probes, onSweepAc, sweeping, themeKey }: InstrumentCtx) {
  const b = lastAc ? bodeOf(lastAc, probes) : null
  const traces: Trace[] = useMemo(() => (b ? [
    { label: "gain", y: b.gain, color: cssColor("var(--chart-4)") },
    { label: "phase", y: b.phase, color: cssColor("var(--chart-5)"), scale: "phase", dash: [4, 3] },
  ] : []), [b?.gain, themeKey]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Card icon={<ChartSpline className="size-4" />} title="Bode plotter" tag={b ? `${b.in?.replace(/^V\((.*)\)$/, "$1") ?? "source"} → ${b.out.replace(/^V\((.*)\)$/, "$1")}` : "in → out"}
      action={<Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={onSweepAc} disabled={sweeping}>{sweeping ? <Loader2 className="animate-spin" /> : <Play />} Sweep</Button>}>
      <div className="h-44 min-h-0 overflow-hidden rounded-lg border bg-scope">
        {lastAc && b ? <Plot x={lastAc.freq} traces={traces} logX xUnit="Hz" yUnit="dB" legend={false} markers={[b.fL, b.fH].filter(Number.isFinite).map((f) => ({ x: f, label: formatSI(f, "Hz", 3), color: cssColor("var(--muted-foreground)") }))} />
          : <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">Press Sweep to measure the frequency response (AC analysis; the scope keeps its transient).</div>}
      </div>
      <Row k="Gain (peak)" v={b ? `${b.peak.toFixed(2)} dB · ×${(10 ** (b.peak / 20)).toPrecision(3)}` : "—"} />
      <Row k="−3 dB" v={b && lastAc ? `f_L ${Number.isFinite(b.fL) ? formatSI(b.fL, "Hz", 3) : `< ${formatSI(lastAc.freq[0], "Hz", 3)}`} · f_H ${Number.isFinite(b.fH) ? formatSI(b.fH, "Hz", 3) : `> ${formatSI(lastAc.freq[lastAc.freq.length - 1], "Hz", 3)}`}` : "—"} />
      <Row k="Roll-off" v={b && Number.isFinite(b.slope) ? `${b.slope.toFixed(0)} dB/dec · ${["", "1st", "2nd", "3rd"][b.order] ?? `${b.order}th`} order` : b ? "flat in the sweep range" : "—"} />
    </Card>
  )
}

// ---------------------------------------------------------------- spectrum analyzer

export function SpectrumAnalyzer({ result, probes, themeKey }: InstrumentCtx) {
  const tr = tranOf(result)
  const signals = tr ? tr.names.filter((n) => /^(V|I[a-z]*)\(/.test(n)) : []
  const [sel, setSel] = useState<string | null>(null)
  const [win, setWin] = useState<Window>("hann")
  const sig = sel && signals.includes(sel) ? sel : probes.find((s) => signals.includes(s)) ?? signals[0] ?? null
  const sp = useMemo(() => {
    if (!tr || !sig) return null
    const y = tr.data[tr.names.indexOf(sig)]
    // skip the first fifth (start-up) like a bench analyzer that waits for a settled signal
    const t0 = tr.time[0] + (tr.time[tr.time.length - 1] - tr.time[0]) * 0.2
    return spectrum(tr.time, y, { from: t0, window: win })
  }, [tr, sig, win])
  const plot = useMemo(() => {
    if (!sp) return null
    const keep = sp.f.map((_, j) => j).filter((j) => j > 0)
    const u = sig ? unitOf(sig) : "V"
    return { x: keep.map((j) => sp.f[j]), traces: [{ label: `|${sig}| (dB${u})`, y: keep.map((j) => 20 * Math.log10(Math.max(sp.amp[j], 1e-12))), color: cssColor("var(--chart-1)") }] as Trace[] }
  }, [sp, sig, themeKey]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!tr) return <Empty icon={<Waves />} text="The spectrum analyzer needs a transient. Choose Transient and Simulate." />
  const u = sig ? unitOf(sig) : "V"
  return (
    <div className="flex h-full gap-3">
      <div className="flex min-w-0 flex-1 flex-col gap-2 rounded-lg border bg-scope p-2">
        {plot ? <Plot x={plot.x} traces={plot.traces} logX xUnit="Hz" yUnit={`dB${u}`} /> : <Empty icon={<Waves />} text="No signal." />}
      </div>
      <div className="flex w-64 shrink-0 flex-col gap-3 overflow-auto rounded-lg border bg-card p-3">
        <Select value={sig ?? ""} onValueChange={setSel}>
          <SelectTrigger size="sm" className="font-mono text-xs"><SelectValue placeholder="Signal" /></SelectTrigger>
          <SelectContent>{signals.map((s) => <SelectItem key={s} value={s} className="font-mono text-xs">{s}</SelectItem>)}</SelectContent>
        </Select>
        <Seg value={win} options={[["hann", "Hann"], ["blackman", "Blackman"], ["rect", "Rect"]]} onChange={setWin} />
        {sp && (<>
          <Row k="Fundamental" v={sp.fundamental ? formatSI(sp.fundamental.f, "Hz", 4) : "—"} />
          <Row k="Amplitude" v={sp.fundamental ? formatSI(sp.fundamental.amp, u, 4) : "—"} />
          <Row k="DC" v={formatSI(sp.dc, u, 4)} />
          <Row k="THD" v={Number.isFinite(sp.thd) ? `${(sp.thd * 100).toFixed(2)} %` : "—"} />
          <Row k="Resolution" v={`${formatSI(sp.fs / sp.n, "Hz", 3)} · ${sp.n} pts`} />
          {sp.fundamental && (sp.fundamental.f * sp.n) / sp.fs < 10 && (
            <p className="rounded-md bg-warning-subtle px-2 py-1.5 text-[11px] text-warning">Only {((sp.fundamental.f * sp.n) / sp.fs).toFixed(1)} periods in the window: THD and DC are approximate. Increase the transient stop time (Setup) for at least 10 periods.</p>
          )}
          <div className="mt-1 text-xs font-medium">Harmonics</div>
          <div className="flex flex-col gap-1">
            {sp.harmonics.slice(0, 8).map((h) => <Row key={h.k} k={`${h.k}× · ${formatSI(h.f, "Hz", 3)}`} v={sp.fundamental ? `${(20 * Math.log10(Math.max(h.amp, 1e-15) / sp.fundamental.amp)).toFixed(1)} dBc` : "—"} />)}
          </div>
        </>)}
      </div>
    </div>
  )
}

function Empty({ icon, text, children }: { icon: React.ReactNode; text: string; children?: React.ReactNode }) {
  return <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted-foreground [&_svg]:size-6">{icon}<span>{text}</span>{children}</div>
}

// ---------------------------------------------------------------- logic analyzer

export function LogicAnalyzer({ result, probes, time }: InstrumentCtx) {
  const tr = tranOf(result)
  const [th, setTh] = useState("")
  const [extra, setExtra] = useState<string[]>([])
  const signals = tr ? tr.names.filter((n) => n.startsWith("V(")) : []
  const chans = [...new Set([...probes.filter((s) => s.startsWith("V(")), ...extra])].filter((s) => signals.includes(s))
  const level = parseValue(th) ?? undefined
  const lanes = useMemo(() => (tr ? chans.map((s) => toLogic(s, tr.time, tr.data[tr.names.indexOf(s)], level)) : []), [tr, chans.join(), level]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!tr) return <Empty icon={<CircleDot />} text="The logic analyzer reads a transient. Choose Transient and Simulate." />
  const t0 = tr.time[0], t1 = tr.time[tr.time.length - 1]
  const W = 1000
  const xOf = (t: number) => ((t - t0) / (t1 - t0 || 1)) * W
  return (
    <div className="flex h-full gap-3">
      <div className="flex min-w-0 flex-1 flex-col overflow-auto rounded-lg border bg-scope p-3">
        {lanes.map((l, i) => {
          const d = l.steps.map(([t, v], k) => `${k ? "L" : "M"}${xOf(t).toFixed(1)},${v ? 4 : 26}${l.steps[k + 1] ? ` L${xOf(l.steps[k + 1][0]).toFixed(1)},${v ? 4 : 26}` : ` L${W},${v ? 4 : 26}`}`).join(" ")
          return (
            <div key={l.signal} className="flex items-center gap-3 border-b py-1.5 last:border-b-0">
              <span className="w-28 shrink-0 truncate font-mono text-xs" style={{ color: COLORS[i % COLORS.length] }}>D{i} · {l.signal}</span>
              <svg viewBox={`0 0 ${W} 30`} preserveAspectRatio="none" className="h-8 min-w-0 flex-1">
                <path d={d} fill="none" stroke={COLORS[i % COLORS.length]} strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
                {time !== null && <line x1={xOf(time)} x2={xOf(time)} y1={0} y2={30} stroke="var(--canvas-selection)" strokeWidth={1} vectorEffect="non-scaling-stroke" />}
              </svg>
            </div>
          )
        })}
        {!lanes.length && <Empty icon={<CircleDot />} text="Probe digital nets (P) or add channels on the right." />}
        <div className="mt-1 flex justify-between pl-[124px] font-mono text-[10px] text-muted-foreground">
          {[0, 0.25, 0.5, 0.75, 1].map((f) => <span key={f}>{formatSI(t0 + f * (t1 - t0), "s", 3)}</span>)}
        </div>
      </div>
      <div className="flex w-72 shrink-0 flex-col gap-3 overflow-auto rounded-lg border bg-card p-3">
        <label className="flex items-center justify-between gap-2 text-xs"><span className="text-muted-foreground">Threshold</span>
          <Input value={th} onChange={(e) => setTh(e.target.value)} placeholder="auto (mid-swing)" className="h-7 w-36 font-mono text-xs" /></label>
        <Select value="" onValueChange={(v) => v && setExtra((x) => [...x, v])}>
          <SelectTrigger size="sm" className="text-xs"><SelectValue placeholder="Add channel" /></SelectTrigger>
          <SelectContent>{signals.filter((s) => !chans.includes(s)).map((s) => <SelectItem key={s} value={s} className="font-mono text-xs">{s}</SelectItem>)}</SelectContent>
        </Select>
        <div className="divide-y">
          {lanes.map((l, i) => (
            <div key={l.signal} className="flex flex-col gap-1 py-2">
              <span className="font-mono text-xs font-medium">D{i} · {l.signal}</span>
              <Row k="Threshold" v={formatSI(l.threshold, "V", 3)} />
              <Row k="Edges" v={l.edges} />
              <Row k="Frequency" v={Number.isFinite(l.freq) ? formatSI(l.freq, "Hz", 4) : "—"} />
              <Row k="Duty" v={Number.isFinite(l.duty) ? `${(l.duty * 100).toFixed(1)} %` : "—"} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- power meter

export function PowerMeter({ doc, netlist, result }: InstrumentCtx) {
  const rows = useMemo(() => powerTable(doc, netlist, result), [doc, netlist, result])
  if (!result || result.type === "ac") return <Empty icon={<Zap />} text="The power meter reads a transient or the operating point (not an AC sweep)." />
  const supplied = -rows.filter((r) => r.kind === "V" || r.kind === "I").reduce((s, r) => s + r.avg, 0)
  const dissipated = rows.filter((r) => r.kind !== "V" && r.kind !== "I").reduce((s, r) => s + r.avg, 0)
  return (
    <div className="flex h-full gap-3">
      <div className="min-w-0 flex-1 overflow-auto rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-muted text-xs text-muted-foreground">
            <tr><th className="px-3 py-1.5 text-left font-medium">Part</th><th className="px-3 py-1.5 text-left font-medium">Type</th><th className="px-3 py-1.5 text-right font-medium">P avg</th><th className="px-3 py-1.5 text-right font-medium">P peak</th><th className="w-48 px-3 py-1.5 text-left font-medium">vs rating</th></tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((r) => (
              <tr key={r.ref}>
                <td className="px-3 py-1.5 font-mono text-xs">{r.ref}</td>
                <td className="px-3 py-1.5 text-xs text-muted-foreground">{r.kind === "V" || r.kind === "I" ? "source" : r.kind}</td>
                <td className={cn("px-3 py-1.5 text-right font-mono text-xs", r.avg < 0 && "text-success")}>{formatSI(r.avg, "W", 4)}</td>
                <td className="px-3 py-1.5 text-right font-mono text-xs">{formatSI(r.peak, "W", 3)}</td>
                <td className="px-3 py-1.5">
                  {r.load !== undefined ? (
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"><div className={cn("h-full rounded-full", r.load > 1 ? "bg-destructive" : r.load > 0.5 ? "bg-warning" : "bg-success")} style={{ width: `${Math.min(100, r.load * 100)}%` }} /></div>
                      <span className={cn("w-12 text-right font-mono text-[11px]", r.load > 1 && "text-destructive")}>{(r.load * 100).toFixed(r.load < 0.1 ? 1 : 0)} %</span>
                    </div>
                  ) : <span className="text-xs text-muted-foreground">—</span>}
                </td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={5} className="p-4 text-sm text-muted-foreground">No currents in this result. Turn on Settings → Simulation engine → Save device currents.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="flex w-64 shrink-0 flex-col gap-2 rounded-lg border bg-card p-3">
        <div className="text-xs text-muted-foreground">{result.type === "tran" ? "Average over the transient" : "Operating point"}</div>
        <Readout value={supplied} unit="W" />
        <Row k="Supplied by sources" v={formatSI(supplied, "W", 4)} />
        <Row k="Dissipated in parts" v={formatSI(dissipated, "W", 4)} />
        <Row k="Balance" v={Math.abs(supplied) > 1e-12 ? `${(Math.abs((dissipated - supplied) / supplied) < 5e-5 ? 0 : ((dissipated - supplied) / supplied) * 100).toFixed(2)} %` : "—"} />
        <p className="mt-2 text-[11px] text-muted-foreground">Resistor ratings come from the Power field (default 0.25 W). Capacitors and inductors store energy, so their average is ≈ 0 over whole periods.</p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- curve tracer

export function CurveTracer({ doc, netlist, values, themeKey }: InstrumentCtx) {
  const candidates = doc.parts.filter((q) => tracerKind(q))
  const [id, setId] = useState<string | null>(null)
  const part = candidates.find((q) => q.id === id) ?? candidates.find((q) => /NPN|PNP|MOS|JFET/.test(tracerKind(q) ?? "")) ?? candidates[0]
  const [state, setState] = useState<{ key: string; curves: { label: string; x: number[]; y: number[] }[]; deck: NonNullable<ReturnType<typeof tracerDeck>> } | { key: string; error: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const key = part ? `${part.id}:${part.value}:${part.lib}:${part.sim?.Params ?? ""}` : ""
  const trace = async () => {
    if (!part) return
    const deck = tracerDeck(buildNetlist(doc, netlist, "op"), part)
    if (!deck) { setState({ key, error: "This part cannot be traced yet." }); return }
    setBusy(true)
    try {
      const r = await simulate(deck.net)
      setState({ key, curves: tracerCurves(deck, r), deck })
    } catch (e) { setState({ key, error: e instanceof Error ? e.message : String(e) }) } finally { setBusy(false) }
  }
  // re-trace when the part changes (value / model)
  useEffect(() => { if (part && state && state.key !== key) trace() }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  const shown = state && "curves" in state && state.key === key ? state : null
  const plot = useMemo(() => {
    if (!shown || !shown.curves.length) return null
    let x = shown.curves[0].x
    let ys = shown.curves.map((c) => c.y)
    // uPlot wants increasing x (P-type sweeps run negative)
    if (x.length > 1 && x[1] < x[0]) { x = [...x].reverse(); ys = ys.map((y) => [...y].reverse()) }
    const traces: Trace[] = ys.map((y, i) => ({ label: shown.curves[i].label, y, color: cssColor(COLORS[i % COLORS.length]) }))
    return { x, traces }
  }, [shown, themeKey]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!candidates.length) return <Empty icon={<Cpu />} text="Place a resistor, diode, LED, transistor or FET to trace its curves." />
  // operating point of the part in the circuit
  const roles = pinRoles(part!)
  const pin = (role: string) => { const n = Object.entries(roles).find(([, r]) => r === role)?.[0]; return n ? netlist.pinNet.get(`${part!.ref}.${n}`) : undefined }
  const v = (net: string | undefined) => (net === "0" ? 0 : net ? values[`V(${net})`] : undefined)
  const k = tracerKind(part!)
  const op = k === "NPN" || k === "PNP" ? { x: (v(pin("C")) ?? NaN) - (v(pin("E")) ?? NaN), y: values[`Ic(${part!.ref})`], xl: "V_CE", yl: "I_C" }
    : k && /MOS|JFET/.test(k) ? { x: (v(pin("D")) ?? NaN) - (v(pin("S")) ?? NaN), y: values[`Id(${part!.ref})`], xl: "V_DS", yl: "I_D" }
    : { x: NaN, y: values[`I(${part!.ref})`], xl: "V", yl: "I" }
  return (
    <div className="flex h-full gap-3">
      <div className="flex min-w-0 flex-1 flex-col rounded-lg border bg-scope p-2">
        {plot && shown ? <Plot x={plot.x} traces={plot.traces} xUnit={shown.deck.xUnit} yUnit={shown.deck.yUnit} markers={Number.isFinite(op.x) ? [{ x: op.x, label: `op ${op.xl} ${formatSI(op.x, "V", 3)}`, color: cssColor("var(--canvas-selection)") }] : []} />
          : <Empty icon={<Cpu />} text={state && "error" in state ? state.error : "Press Trace: the part is taken out of the circuit and swept on a test fixture, with the same model."}>{busy && <Loader2 className="animate-spin" />}</Empty>}
      </div>
      <div className="flex w-64 shrink-0 flex-col gap-3 rounded-lg border bg-card p-3">
        <Select value={part!.id} onValueChange={setId}>
          <SelectTrigger size="sm" className="text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>{candidates.map((q) => <SelectItem key={q.id} value={q.id} className="text-xs">{displayRef(q)} · {q.value} ({tracerKind(q)})</SelectItem>)}</SelectContent>
        </Select>
        <Button onClick={trace} disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : <Play />} Trace</Button>
        {shown && <>
          <Row k="Sweep" v={`${shown.deck.xLabel} · ${shown.curves.length} curve${shown.curves.length > 1 ? "s" : ""}`} />
          <Row k="Model" v={part!.value} />
        </>}
        <div className="mt-1 text-xs font-medium">Operating point in the circuit</div>
        <Row k={op.xl} v={Number.isFinite(op.x) ? formatSI(op.x, "V", 4) : "—"} />
        <Row k={op.yl} v={op.y !== undefined ? formatSI(op.y, "A", 4) : "—"} />
        <p className="text-[11px] text-muted-foreground">Transistors: I_C vs V_CE for I_B = 10…50 µA. FETs: I_D vs V_DS for steps of V_GS. Diodes: forward current up to 50 mA.</p>
      </div>
    </div>
  )
}

/** Pin number → SPICE role (C, B, E, D, G, S…) of a part. */
function pinRoles(part: Part): Record<string, string> {
  const s = resolveSim(part)
  return s && !("error" in s) ? s.pins : {}
}

// ---------------------------------------------------------------- Instruments & data panel

export interface Connection { id: string; tab: string; color: string; title: string; net: string; status: "Driving" | "Live" | "Swept" | "Idle" }

export function connections(c: { doc: Doc; netlist: Netlist; probes: string[]; dmm: string | null; result: JobResult | null; lastAc: AcResult | null }): Connection[] {
  const out: Connection[] = []
  // a function generator is a sine / pulse source; plain DC supplies are not instruments
  const part = c.doc.parts.find((q) => /^Simulation_SPICE:V(SIN|PULSE)$/.test(q.lib))
  if (part) {
    const g = readGen(part), sh = shapeOf(part)
    out.push({ id: "fg", tab: "fgen", color: "#7c3aed", title: `FG · ${displayRef(part)} ${sh === "dc" ? `DC ${formatSI(g.off, "V", 3)}` : `${sh} ${formatSI(g.f, "Hz", 3)} · ${formatSI(g.amp * 2, "Vpp", 3)}`}`, net: `net → ${c.netlist.pinNet.get(`${part.ref}.1`) ?? "?"}`, status: part.sim?.Exclude === "1" ? "Idle" : "Driving" })
  }
  const live = (s: string) => !!c.result && c.result.type !== "op" && c.result.names.includes(s)
  c.probes.forEach((s, i) => out.push({ id: `ch${i}`, tab: "scope", color: COLORS[i % COLORS.length], title: `Scope CH${i + 1}`, net: s.startsWith("V(") ? `net ${s.slice(2, -1)}` : s, status: live(s) ? "Live" : "Idle" }))
  if (c.dmm) out.push({ id: "dmm", tab: "dmm", color: "var(--warning)", title: `DMM · ${c.dmm.startsWith("I") ? "A" : "V"}`, net: c.dmm.startsWith("V(") ? `net ${c.dmm.slice(2, -1)} / GND` : c.dmm, status: c.result ? "Live" : "Idle" })
  const b = c.lastAc ? bodeOf(c.lastAc, c.probes) : null
  out.push({ id: "bode", tab: "bode", color: "var(--destructive)", title: "Bode plotter", net: b ? `net ${b.in?.slice(2, -1) ?? "source"} → ${b.out.slice(2, -1)}` : "probe in & out", status: b ? "Swept" : "Idle" })
  return out
}

export const ADD_INSTRUMENTS: { tab: string; label: string; icon: typeof Activity }[] = [
  { tab: "scope", label: "Oscilloscope", icon: Activity }, { tab: "dmm", label: "Multimeter", icon: Gauge },
  { tab: "fgen", label: "Function gen", icon: AudioWaveform }, { tab: "bode", label: "Bode plotter", icon: ChartSpline },
  { tab: "spectrum", label: "Spectrum", icon: Waves }, { tab: "logic", label: "Logic analyzer", icon: CircleDot },
  { tab: "power", label: "Power meter", icon: Zap }, { tab: "tracer", label: "Curve tracer", icon: Cpu },
]

function useTick(on: boolean) {
  const [, set] = useState(0)
  useEffect(() => { if (!on) return; const h = setInterval(() => set((n) => n + 1), 250); return () => clearInterval(h) }, [on])
}

export function InstrumentsPanel(c: { doc: Doc; netlist: Netlist; probes: string[]; dmm: string | null; result: JobResult | null; lastAc: AcResult | null; onOpen: (tab: string) => void }) {
  const rec = useRecorder()
  useTick(rec.recording)
  const conns = connections(c)
  const signals = rec.recording ? rec.signals : c.probes
  const dt = c.doc.analyses.tran.step
  const bytes = bufferBytes(rec)
  const LIMIT = 64e6
  const elapsed = rec.started ? ((rec.stopped ?? Date.now()) - rec.started) / 1000 : 0
  const clock = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${(elapsed % 60).toFixed(2).padStart(5, "0")}`
  const exportRec = async () => {
    if (!rec.frames.length) { toast("Nothing recorded yet — record, then run transients"); return }
    try {
      const name = `${c.doc.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "circuit"}-recording.csv`
      const p = await saveExport(name, "csv", recordingCsv(rec))
      if (p) toast.success(`Recording saved: ${p.split("/").pop()} · ${rec.frames.length} frame${rec.frames.length > 1 ? "s" : ""}`)
    } catch (e) { toast.error(String(e instanceof Error ? e.message : e)) }
  }
  return (
    <div className="flex h-full flex-col overflow-auto">
      <div className="flex flex-col gap-3 p-4">
        <p className="text-xs text-muted-foreground">Each instrument attaches to nets on the schematic. Leads update when you move or rename nets.</p>
        {conns.map((x) => (
          <button key={x.id} onClick={() => c.onOpen(x.tab)} className="flex items-center gap-3 rounded-lg border bg-card p-3 text-left hover:border-ring">
            <span className="h-8 w-1 rounded-full" style={{ background: x.color }} />
            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{x.title}</span><span className="block truncate font-mono text-[11px] text-muted-foreground">{x.net}</span></span>
            <Badge variant="secondary" className={x.status === "Live" || x.status === "Swept" ? "bg-success-subtle text-success" : x.status === "Driving" ? "" : "text-muted-foreground"}>{x.status}</Badge>
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-2 border-t p-4">
        <div className="mb-1 flex items-center gap-2">
          <h3 className="flex-1 text-sm font-medium">Data collection</h3>
          {rec.recording ? <Badge className="gap-1 bg-destructive text-white"><Radio className="size-3" /> REC {clock}</Badge> : rec.frames.length ? <Badge variant="secondary">{rec.frames.length} frame{rec.frames.length > 1 ? "s" : ""} · {clock}</Badge> : null}
        </div>
        <Row k="Signals" v={signals.length ? signals.join(", ") : "probe nets to record"} />
        <Row k="Sample rate" v={`${formatSI(1 / dt, "S/s", 3)} · Δt ${formatSI(dt, "s", 3)}`} />
        <Row k="Buffer" v={`${rec.frames.length} frame${rec.frames.length === 1 ? "" : "s"} · ${bytes < 1e6 ? `${(bytes / 1e3).toFixed(1)} kB` : `${(bytes / 1e6).toFixed(2)} MB`}`} />
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="text-muted-foreground">Trigger</span>
          <span className="flex items-center gap-1">
            <Select value={rec.trigger.signal && c.probes.includes(rec.trigger.signal) ? rec.trigger.signal : "none"} onValueChange={(v) => setTrigger({ signal: v === "none" ? null : v })}>
              <SelectTrigger size="sm" className="h-6 w-24 font-mono text-[11px]"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="none" className="text-xs">free run</SelectItem>{c.probes.map((s, i) => <SelectItem key={s} value={s} className="font-mono text-xs">CH{i + 1} {s}</SelectItem>)}</SelectContent>
            </Select>
            <button className="h-6 rounded border px-1.5 font-mono" onClick={() => setTrigger({ rising: !rec.trigger.rising })} title="Edge">{rec.trigger.rising ? "↑" : "↓"}</button>
            <TriggerLevel value={rec.trigger.level} />
          </span>
        </div>
        <Row k="Destination" v="CSV · chosen on export" />
        <div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-info" style={{ width: `${Math.min(100, (bytes / LIMIT) * 100)}%` }} /></div>
        <div className="mt-1 grid grid-cols-2 gap-2">
          {rec.recording
            ? <Button variant="outline" size="sm" onClick={stopRecording}><Square /> Stop</Button>
            : <Button variant="outline" size="sm" disabled={!c.probes.length} onClick={() => { startRecording(c.probes, { signal: rec.trigger.signal ?? c.probes[0] ?? null }); toast("Recording — every transient run is captured") }}><Radio /> Record</Button>}
          <Button size="sm" onClick={exportRec} disabled={!rec.frames.length}><Download /> Export…</Button>
        </div>
        {rec.recording && <button className="text-left text-[11px] text-muted-foreground underline-offset-2 hover:underline" onClick={() => setSignals(c.probes)}>Use the current probes ({c.probes.length})</button>}
      </div>
      <div className="flex flex-col gap-2 border-t p-4">
        <h3 className="text-sm font-medium">Add instrument</h3>
        <div className="grid grid-cols-2 gap-2">
          {ADD_INSTRUMENTS.map((a) => (
            <button key={a.tab} onClick={() => c.onOpen(a.tab)} className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-left text-sm hover:border-ring"><a.icon className="size-4 text-muted-foreground" /> {a.label}</button>
          ))}
        </div>
      </div>
    </div>
  )
}

function TriggerLevel({ value }: { value: number }) {
  const [text, setText] = useState<string | null>(null)
  const commit = () => { const v = parseValue(text ?? ""); if (text !== null && v !== null) setTrigger({ level: v }); setText(null) }
  return <Input value={text ?? `${formatSI(value, "", 3).replace(/\s/g, "")}V`} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} className="h-6 w-16 px-1.5 text-right font-mono text-[11px]" />
}
