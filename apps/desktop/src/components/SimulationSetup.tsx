import { useEffect, useMemo, useState } from "react"
import { Activity, AudioWaveform, ChartSpline, Copy, Dices, Gauge, Plus, Sigma, SlidersHorizontal, Thermometer, Trash2, Waves, X, Zap } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Kbd } from "@/components/ui/kbd"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { defaultSetup, displayRef, isVirtual, type Doc, type Measure, type SimSetup, type SweepSetup } from "@/editor/model"
import type { Netlist } from "@/editor/netlist"
import { generateKirk } from "@/kirk/generate"
import { siText } from "@/kirk/kinds"
import { checkExpr } from "@/kirk/measure"
import { planRuns, sweepValues } from "@/lib/runs"
import { parseValue, resolveSim } from "@/lib/spice"
import { formatSI, parseSI } from "@/lib/units"
import { cn } from "@/lib/utils"

export type SetupSection = "op" | "tran" | "ac" | "dc" | "noise" | "fft" | "sweep" | "montecarlo" | "temp"
export interface SetupPatch { analyses: Doc["analyses"]; defaultAnalysis: Doc["defaultAnalysis"]; setup: SimSetup; measures: Measure[]; asserts: string[] }

interface Props {
  open: boolean
  onOpenChange: (o: boolean) => void
  doc: Doc
  netlist: Netlist
  section?: SetupSection
  sweepTarget?: string
  /** last single-run time (ms), for estimates */
  lastMs: number | null
  onApply: (p: SetupPatch) => void
  onRun: (p: SetupPatch) => void
}

const NAV: { id: SetupSection; label: string; icon: typeof Activity; group: "a" | "s"; soon?: boolean }[] = [
  { id: "op", label: "Operating point", icon: Gauge, group: "a" },
  { id: "tran", label: "Transient", icon: Activity, group: "a" },
  { id: "ac", label: "AC sweep", icon: ChartSpline, group: "a" },
  { id: "dc", label: "DC sweep", icon: SlidersHorizontal, group: "a" },
  { id: "noise", label: "Noise", icon: Waves, group: "a", soon: true },
  { id: "fft", label: "FFT · THD", icon: AudioWaveform, group: "a" },
  { id: "sweep", label: "Parameter sweep", icon: SlidersHorizontal, group: "s" },
  { id: "montecarlo", label: "Monte Carlo", icon: Dices, group: "s" },
  { id: "temp", label: "Temperature", icon: Thermometer, group: "s" },
]
const CHIP_COLORS = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5"]

function SIInput({ label, value, unit, onChange }: { label: string; value: number; unit: string; onChange: (v: number) => void }) {
  const [text, setText] = useState<string | null>(null)
  const commit = () => { if (text !== null) { const v = parseSI(text); if (v !== null && Number.isFinite(v)) onChange(v) } setText(null) }
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="relative">
        <Input value={text ?? formatSI(value, "").replace(/\s/g, "")} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} className="pr-10 font-mono" />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{unit}</span>
      </div>
    </label>
  )
}

function Section({ title, desc, on, onToggle, children }: { title: string; desc: string; on?: boolean; onToggle?: (v: boolean) => void; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <div className="font-medium">{title}</div>
          <div className="text-xs text-muted-foreground">{desc}</div>
        </div>
        {onToggle && <Switch checked={!!on} onCheckedChange={onToggle} />}
      </div>
      {children}
    </div>
  )
}

export function SimulationSetup({ open, onOpenChange, doc, netlist, section = "tran", sweepTarget, lastMs, onApply, onRun }: Props) {
  const fresh = (): SetupPatch => ({
    analyses: structuredClone(doc.analyses), defaultAnalysis: doc.defaultAnalysis,
    setup: structuredClone(doc.setup ?? defaultSetup()), measures: structuredClone(doc.measures ?? []), asserts: [...(doc.asserts ?? [])],
  })
  const [d, setD] = useState<SetupPatch>(fresh)
  const [sec, setSec] = useState<SetupSection>(section)
  const [newValue, setNewValue] = useState("")
  const [newTemp, setNewTemp] = useState("")

  // each time the dialog opens, start from the document (and an optional "Add to sweep" target)
  useEffect(() => {
    if (!open) return
    const f = fresh()
    if (sweepTarget) {
      const ref = sweepTarget.split(".")[0]
      const part = doc.parts.find((p) => p.ref === ref)
      const v = part ? parseValue(part.value) : null
      f.setup.sweep = { enabled: true, target: sweepTarget, mode: "list", values: v ? [0.47, 1, 2.2, 4.7].map((m) => siText(Number((v * m).toPrecision(3)))) : [], start: v ? siText(v / 10) : "1k", stop: v ? siText(v * 10) : "100k", points: 5 }
    }
    setD(f); setSec(sweepTarget ? "sweep" : section)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const setA = (a: Partial<Doc["analyses"]>) => setD((x) => ({ ...x, analyses: { ...x.analyses, ...a } }))
  const setS = (s: Partial<SimSetup>) => setD((x) => ({ ...x, setup: { ...x.setup, ...s } }))
  const sweep: SweepSetup = d.setup.sweep ?? { enabled: false, target: "", mode: "list", values: [], start: "1k", stop: "100k", points: 5 }
  const setSweep = (s: Partial<SweepSetup>) => setS({ sweep: { ...sweep, ...s } })

  // sweepable parts: R, C, L and sources with a numeric value
  const targets = useMemo(() => {
    const seen = new Set<string>()
    return doc.parts.filter((p) => !isVirtual(p) && !seen.has(p.ref) && (seen.add(p.ref), true)).flatMap((p) => {
      const sim = resolveSim(p)
      if (!sim || "error" in sim || parseValue(p.value) === null) return []
      const unit = sim.kind === "R" ? "Ω" : sim.kind === "C" ? "F" : sim.kind === "L" ? "H" : sim.kind === "V" ? "V" : sim.kind === "I" ? "A" : ""
      const name = sim.kind === "R" ? "Resistance" : sim.kind === "C" ? "Capacitance" : sim.kind === "L" ? "Inductance" : sim.kind === "V" ? "Voltage" : "Value"
      return [{ id: `${p.ref}.value`, label: `${displayRef(p)} · ${name} (${formatSI(parseValue(p.value)!, unit)})`, unit }]
    })
  }, [doc.parts])
  const target = targets.find((t) => t.id === sweep.target)
  /** starting values around a part's current value: ×0.47, ×1, ×2.2, ×4.7 */
  const seed = (id: string): Partial<SweepSetup> => {
    const v = parseValue(doc.parts.find((p) => p.ref === id.split(".")[0])?.value ?? "")
    return v ? { values: [0.47, 1, 2.2, 4.7].map((m) => siText(Number((v * m).toPrecision(3)))), start: siText(v / 10), stop: siText(v * 10) } : {}
  }
  const sources = doc.parts.filter((p) => { const s = resolveSim(p); return s && !("error" in s) && (s.kind === "V" || s.kind === "I") })

  const draftDoc: Doc = { ...doc, ...d }
  const runs = useMemo(() => planRuns(draftDoc), [draftDoc]) // eslint-disable-line react-hooks/exhaustive-deps
  const kirk = useMemo(() => {
    const full = generateKirk(draftDoc, netlist)
    const start = full.indexOf("\n}\n") + 3
    const end = full.indexOf("\nlayout {")
    return `// ${doc.title} — analyses & measurements\n${full.slice(start, end).trim()}`
  }, [draftDoc, netlist, doc.title]) // eslint-disable-line react-hooks/exhaustive-deps
  const analysisForRuns = d.defaultAnalysis === "dc" && !d.analyses.dc ? "tran" : d.defaultAnalysis
  const pointsPerRun = analysisForRuns === "tran" ? Math.round(d.analyses.tran.stop / d.analyses.tran.step) + 1 : analysisForRuns === "ac" ? Math.round(Math.log10(d.analyses.ac.stop / d.analyses.ac.start) * (d.analyses.ac.points ?? 60)) + 1 : 1
  const signals = Math.max(1, netlist.nets.length)
  const threads = d.setup.parallel ? Math.min(4, runs.length) : 1
  const est = lastMs !== null ? (lastMs * runs.length) / threads : null
  const measureErrors = d.measures.map((m) => (m.expr.trim() ? checkExpr(m.expr) : "empty"))
  const nameErrors = d.measures.map((m, i) => (!/^[A-Za-z_]\w*$/.test(m.name) ? "use letters, digits, _" : d.measures.findIndex((x) => x.name === m.name) !== i ? "duplicate name" : null))
  const valid = measureErrors.every((e) => !e) && nameErrors.every((e) => !e)
  const run = () => { if (!valid) { toast.error("Fix the measurements first"); return } onRun(d); onOpenChange(false) }

  const enabled: Partial<Record<SetupSection, boolean>> = {
    op: true, [d.defaultAnalysis]: true, sweep: !!d.setup.sweep?.enabled, montecarlo: !!d.setup.montecarlo?.enabled, temp: !!d.setup.temp?.enabled,
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(780px,88vh)] max-w-[min(1100px,94vw)] flex-col gap-0 p-0 sm:max-w-[min(1100px,94vw)]"
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); run() } }}>
        <div className="border-b px-6 pb-4 pt-5">
          <DialogTitle>Simulation setup</DialogTitle>
          <DialogDescription>Configure analyses for “{doc.title}”. Space Bench runs the circuit on ngspice, one job per sweep point, in parallel.</DialogDescription>
        </div>
        <div className="flex min-h-0 flex-1">
          {/* navigation */}
          <div className="w-56 shrink-0 border-r p-3">
            {(["a", "s"] as const).map((g) => (
              <div key={g} className="mb-4">
                <div className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{g === "a" ? "Analyses" : "Sweeps & statistics"}</div>
                {NAV.filter((n) => n.group === g).map((n) => (
                  <button key={n.id} onClick={() => !n.soon && setSec(n.id)} disabled={n.soon}
                    className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm", sec === n.id ? "bg-accent" : "hover:bg-accent/60", n.soon && "opacity-50")}>
                    <n.icon className="size-4 text-muted-foreground" />
                    <span className="flex-1">{n.label}</span>
                    {n.soon ? <span className="text-[10px] text-muted-foreground">soon</span> : enabled[n.id] ? <Badge variant="secondary" className="h-4 bg-success-subtle px-1.5 text-[10px] text-success">On</Badge> : null}
                  </button>
                ))}
              </div>
            ))}
          </div>

          {/* section editor */}
          <ScrollArea className="min-w-0 flex-1">
            <div className="flex flex-col gap-5 p-6">
              {sec === "op" && <Section title="Operating point" desc="DC solution with capacitors open and inductors shorted. Space Bench always computes it for wire colours, voltage tags and the multimeter.">
                <label className="flex items-center gap-2 text-sm"><Checkbox checked={d.defaultAnalysis === "op"} onCheckedChange={(c) => c && setD((x) => ({ ...x, defaultAnalysis: "op" }))} /> Use as the main analysis</label>
              </Section>}
              {sec === "tran" && <Section title="Transient" desc="Time-domain simulation from 0 to the stop time.">
                <div className="grid grid-cols-2 gap-3">
                  <SIInput label="Stop time" value={d.analyses.tran.stop} unit="s" onChange={(v) => setA({ tran: { ...d.analyses.tran, stop: v } })} />
                  <SIInput label="Max step" value={d.analyses.tran.step} unit="s" onChange={(v) => setA({ tran: { ...d.analyses.tran, step: v } })} />
                </div>
                <label className="flex items-center gap-2 text-sm"><Checkbox checked={d.defaultAnalysis === "tran"} onCheckedChange={(c) => c && setD((x) => ({ ...x, defaultAnalysis: "tran" }))} /> Use as the main analysis</label>
              </Section>}
              {sec === "ac" && <Section title="AC sweep" desc="Small-signal frequency response around the operating point. Sources need an AC magnitude (ac=1).">
                <div className="grid grid-cols-3 gap-3">
                  <SIInput label="From" value={d.analyses.ac.start} unit="Hz" onChange={(v) => setA({ ac: { ...d.analyses.ac, start: v } })} />
                  <SIInput label="To" value={d.analyses.ac.stop} unit="Hz" onChange={(v) => setA({ ac: { ...d.analyses.ac, stop: v } })} />
                  <SIInput label="Points / decade" value={d.analyses.ac.points ?? 60} unit="" onChange={(v) => setA({ ac: { ...d.analyses.ac, points: Math.max(1, Math.round(v)) } })} />
                </div>
                <label className="flex items-center gap-2 text-sm"><Checkbox checked={d.defaultAnalysis === "ac"} onCheckedChange={(c) => c && setD((x) => ({ ...x, defaultAnalysis: "ac" }))} /> Use as the main analysis</label>
              </Section>}
              {sec === "dc" && <Section title="DC sweep" desc="Step a source and solve the operating point at each value (transfer curves, I–V curves).">
                {sources.length ? (<>
                  <div className="grid grid-cols-4 gap-3">
                    <label className="flex flex-col gap-1.5">
                      <span className="text-xs text-muted-foreground">Source</span>
                      <Select value={d.analyses.dc?.source ?? ""} onValueChange={(v) => setA({ dc: { source: v, start: d.analyses.dc?.start ?? 0, stop: d.analyses.dc?.stop ?? 5, step: d.analyses.dc?.step ?? 0.05 } })}>
                        <SelectTrigger><SelectValue placeholder="Choose" /></SelectTrigger>
                        <SelectContent>{sources.map((p) => <SelectItem key={p.id} value={/^[VI]/i.test(p.ref) ? p.ref : `V${p.ref}`}>{p.ref}</SelectItem>)}</SelectContent>
                      </Select>
                    </label>
                    <SIInput label="From" value={d.analyses.dc?.start ?? 0} unit={d.analyses.dc?.source?.startsWith("I") ? "A" : "V"} onChange={(v) => d.analyses.dc && setA({ dc: { ...d.analyses.dc, start: v } })} />
                    <SIInput label="To" value={d.analyses.dc?.stop ?? 5} unit={d.analyses.dc?.source?.startsWith("I") ? "A" : "V"} onChange={(v) => d.analyses.dc && setA({ dc: { ...d.analyses.dc, stop: v } })} />
                    <SIInput label="Step" value={d.analyses.dc?.step ?? 0.05} unit={d.analyses.dc?.source?.startsWith("I") ? "A" : "V"} onChange={(v) => d.analyses.dc && setA({ dc: { ...d.analyses.dc, step: v } })} />
                  </div>
                  <label className="flex items-center gap-2 text-sm"><Checkbox disabled={!d.analyses.dc} checked={d.defaultAnalysis === "dc"} onCheckedChange={(c) => c && setD((x) => ({ ...x, defaultAnalysis: "dc" }))} /> Use as the main analysis</label>
                </>) : <p className="text-sm text-muted-foreground">Place a voltage or current source to sweep.</p>}
              </Section>}

              {sec === "fft" && <Section title="FFT · THD" desc="Spectrum, fundamental, harmonics and total harmonic distortion of a transient signal.">
                <div className="flex flex-col gap-2 rounded-lg border p-4 text-sm">
                  <p>The FFT is computed from the transient result — open <b>Analysis → FFT</b> after a run and pick the signal, window (Hann, Blackman, rectangular) and run.</p>
                  <p className="text-muted-foreground">The second half of the run is analysed so start-up transients don't smear the spectrum. Simulate at least ~10 periods; a smaller max step gives a wider usable spectrum.</p>
                  <label className="flex items-center gap-2"><Checkbox checked={d.defaultAnalysis === "tran"} onCheckedChange={(c) => c && setD((x) => ({ ...x, defaultAnalysis: "tran" }))} /> Use transient as the main analysis</label>
                </div>
              </Section>}
              {sec === "sweep" && <Section title="Parameter sweep" desc="Re-run the main analysis for each value and overlay the results as a trace family." on={sweep.enabled} onToggle={(v) => { const t = sweep.target || targets[0]?.id || ""; setSweep({ enabled: v, target: t, ...(v && !sweep.values.length && t ? seed(t) : {}) }) }}>
                <div className={cn("flex flex-col gap-4 rounded-lg border p-4", !sweep.enabled && "opacity-60")}>
                  <div className="grid grid-cols-[1fr_auto] gap-3">
                    <label className="flex flex-col gap-1.5">
                      <span className="text-xs text-muted-foreground">Sweep</span>
                      <Select value={sweep.target} onValueChange={(v) => setSweep({ target: v, ...seed(v) })}>
                        <SelectTrigger><SelectValue placeholder="Choose a part" /></SelectTrigger>
                        <SelectContent>{targets.map((t) => <SelectItem key={t.id} value={t.id}>{t.label}</SelectItem>)}</SelectContent>
                      </Select>
                    </label>
                    <label className="flex flex-col gap-1.5">
                      <span className="text-xs text-muted-foreground">Spacing</span>
                      <div className="flex rounded-lg bg-muted p-[3px]">
                        {(["list", "lin", "dec", "oct"] as const).map((m) => (
                          <button key={m} onClick={() => setSweep({ mode: m })} className={cn("h-7 rounded-md px-3 text-sm", sweep.mode === m ? "bg-background shadow-sm" : "text-muted-foreground")}>{m === "list" ? "List" : m === "lin" ? "Linear" : m === "dec" ? "Decade" : "Octave"}</button>
                        ))}
                      </div>
                    </label>
                  </div>
                  {sweep.mode === "list" ? (
                    <div className="flex flex-col gap-1.5">
                      <span className="text-xs text-muted-foreground">Values</span>
                      <div className="flex flex-wrap items-center gap-2">
                        {sweep.values.map((v, i) => (
                          <span key={`${v}${i}`} className="flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-xs">
                            <span className={cn("size-2 rounded-full", CHIP_COLORS[i % CHIP_COLORS.length])} />{formatSI(parseValue(v) ?? 0, target?.unit ?? "")}
                            <button onClick={() => setSweep({ values: sweep.values.filter((_, k) => k !== i) })} className="text-muted-foreground hover:text-foreground"><X className="size-3" /></button>
                          </span>
                        ))}
                        <div className="flex items-center gap-1">
                          <Input value={newValue} onChange={(e) => setNewValue(e.target.value)} placeholder="e.g. 22k" className="h-7 w-24 font-mono text-xs"
                            onKeyDown={(e) => { if (e.key === "Enter" && parseValue(newValue) !== null) { setSweep({ values: [...sweep.values, newValue.trim()] }); setNewValue("") } }} />
                          <Button variant="ghost" size="sm" disabled={parseValue(newValue) === null} onClick={() => { setSweep({ values: [...sweep.values, newValue.trim()] }); setNewValue("") }}><Plus /> Add</Button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-3 gap-3">
                      <SIInput label="From" value={parseValue(sweep.start) ?? 0} unit={target?.unit ?? ""} onChange={(v) => setSweep({ start: siText(v) })} />
                      <SIInput label="To" value={parseValue(sweep.stop) ?? 0} unit={target?.unit ?? ""} onChange={(v) => setSweep({ stop: siText(v) })} />
                      <SIInput label={sweep.mode === "lin" ? "Points" : sweep.mode === "dec" ? "Points / decade" : "Points / octave"} value={sweep.points} unit="" onChange={(v) => setSweep({ points: Math.max(1, Math.round(v)) })} />
                      <div className="col-span-3 font-mono text-xs text-muted-foreground">{sweepValues(sweep).slice(0, 12).map((v) => formatSI(v, target?.unit ?? "")).join(" · ")}{sweepValues(sweep).length > 12 ? " …" : ""}</div>
                    </div>
                  )}
                </div>
              </Section>}

              {sec === "montecarlo" && <Section title="Monte Carlo" desc="Random part values within their tolerances (±tol = 3σ, Gaussian). Set tolerances in the Inspector; defaults R 1 %, C/L 10 %." on={!!d.setup.montecarlo?.enabled}
                onToggle={(v) => setS({ montecarlo: { runs: d.setup.montecarlo?.runs ?? 50, seed: d.setup.montecarlo?.seed ?? 42, enabled: v } })}>
                <div className={cn("grid grid-cols-2 gap-3", !d.setup.montecarlo?.enabled && "opacity-60")}>
                  <SIInput label="Runs" value={d.setup.montecarlo?.runs ?? 50} unit="" onChange={(v) => setS({ montecarlo: { ...(d.setup.montecarlo ?? { enabled: true, seed: 42 }), runs: Math.max(1, Math.min(2000, Math.round(v))) } })} />
                  <SIInput label="Seed" value={d.setup.montecarlo?.seed ?? 42} unit="" onChange={(v) => setS({ montecarlo: { ...(d.setup.montecarlo ?? { enabled: true, runs: 50 }), seed: Math.round(v) } })} />
                </div>
              </Section>}

              {sec === "temp" && <Section title="Temperature" desc="Repeat the analysis at each temperature (device models follow ngspice's temperature equations)." on={!!d.setup.temp?.enabled}
                onToggle={(v) => setS({ temp: { values: d.setup.temp?.values ?? ["-40", "27", "85"], enabled: v } })}>
                <div className={cn("flex flex-wrap items-center gap-2", !d.setup.temp?.enabled && "opacity-60")}>
                  {(d.setup.temp?.values ?? []).map((t, i) => (
                    <span key={`${t}${i}`} className="flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-xs">{t} °C
                      <button onClick={() => setS({ temp: { ...d.setup.temp!, values: d.setup.temp!.values.filter((_, k) => k !== i) } })} className="text-muted-foreground"><X className="size-3" /></button>
                    </span>
                  ))}
                  <Input value={newTemp} onChange={(e) => setNewTemp(e.target.value)} placeholder="°C" className="h-7 w-20 font-mono text-xs"
                    onKeyDown={(e) => { if (e.key === "Enter" && parseValue(newTemp) !== null) { setS({ temp: { enabled: true, values: [...(d.setup.temp?.values ?? []), newTemp.trim()] } }); setNewTemp("") } }} />
                </div>
              </Section>}

              {(sec === "sweep" || sec === "montecarlo" || sec === "temp") && (
                <div className="flex flex-col gap-3 rounded-lg border p-4">
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs text-muted-foreground">Run for each value</span>
                    <Select value={d.defaultAnalysis} onValueChange={(v) => setD((x) => ({ ...x, defaultAnalysis: v as Doc["defaultAnalysis"] }))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="tran">Transient · 0 → {formatSI(d.analyses.tran.stop, "s")} · step {formatSI(d.analyses.tran.step, "s")}</SelectItem>
                        <SelectItem value="ac">AC sweep · {formatSI(d.analyses.ac.start, "Hz")} → {formatSI(d.analyses.ac.stop, "Hz")}</SelectItem>
                        <SelectItem value="op">Operating point</SelectItem>
                        {d.analyses.dc && <SelectItem value="dc">DC sweep · {d.analyses.dc.source}</SelectItem>}
                      </SelectContent>
                    </Select>
                  </label>
                  <label className="flex items-center gap-2 text-sm"><Checkbox checked={d.setup.overlay} onCheckedChange={(c) => setS({ overlay: !!c })} /> Overlay results as a trace family</label>
                  <label className="flex items-center gap-2 text-sm"><Checkbox checked={d.setup.parallel} onCheckedChange={(c) => setS({ parallel: !!c })} /> Run in parallel (4 ngspice processes)</label>
                  <label className="flex items-center gap-2 text-sm"><Checkbox checked={d.setup.keepRaw} onCheckedChange={(c) => setS({ keepRaw: !!c })} /> Keep raw data for every run</label>
                </div>
              )}

              {/* measurements: always visible under the section */}
              <div className="rounded-lg border">
                <div className="flex items-center gap-2 border-b px-4 py-2.5">
                  <Sigma className="size-4 text-muted-foreground" />
                  <span className="flex-1 text-sm font-medium">Measurements per run (.meas)</span>
                  <Button variant="outline" size="sm" onClick={() => setD((x) => ({ ...x, measures: [...x.measures, { name: `m${x.measures.length + 1}`, expr: "max(V(out))" }] }))}><Plus /> Add</Button>
                </div>
                {d.measures.length === 0 && <p className="px-4 py-3 text-xs text-muted-foreground">e.g. <span className="font-mono">frequency(V(out), at: 2.5 V)</span> · <span className="font-mono">pp(V(out), from: 2 ms)</span> · <span className="font-mono">fc(V(out) / V(in))</span></p>}
                {d.measures.map((m, i) => (
                  <div key={i} className="grid grid-cols-[110px_1fr_auto] items-start gap-2 border-b px-4 py-2 last:border-b-0">
                    <Input value={m.name} aria-invalid={!!nameErrors[i]} onChange={(e) => setD((x) => ({ ...x, measures: x.measures.map((q, k) => (k === i ? { ...q, name: e.target.value } : q)) }))} className="h-8 font-mono text-xs" />
                    <div>
                      <Input value={m.expr} aria-invalid={!!measureErrors[i]} onChange={(e) => setD((x) => ({ ...x, measures: x.measures.map((q, k) => (k === i ? { ...q, expr: e.target.value } : q)) }))} className="h-8 font-mono text-xs" />
                      {(measureErrors[i] || nameErrors[i]) && <div className="mt-1 text-[11px] text-destructive">{nameErrors[i] ?? measureErrors[i]}</div>}
                    </div>
                    <Button variant="ghost" size="icon-sm" onClick={() => setD((x) => ({ ...x, measures: x.measures.filter((_, k) => k !== i) }))}><Trash2 /></Button>
                  </div>
                ))}
              </div>
              <div className="rounded-lg border">
                <div className="flex items-center gap-2 border-b px-4 py-2.5">
                  <Zap className="size-4 text-muted-foreground" />
                  <span className="flex-1 text-sm font-medium">Asserts (pass / fail)</span>
                  <Button variant="outline" size="sm" onClick={() => setD((x) => ({ ...x, asserts: [...x.asserts, `${x.measures[0]?.name ?? "m1"} > 0`] }))}><Plus /> Add</Button>
                </div>
                {d.asserts.map((a, i) => (
                  <div key={i} className="grid grid-cols-[1fr_auto] gap-2 border-b px-4 py-2 last:border-b-0">
                    <Input value={a} onChange={(e) => setD((x) => ({ ...x, asserts: x.asserts.map((q, k) => (k === i ? e.target.value : q)) }))} className="h-8 font-mono text-xs" />
                    <Button variant="ghost" size="icon-sm" onClick={() => setD((x) => ({ ...x, asserts: x.asserts.filter((_, k) => k !== i) }))}><Trash2 /></Button>
                  </div>
                ))}
              </div>
            </div>
          </ScrollArea>

          {/* generated Kirk + estimates */}
          <div className="flex w-80 shrink-0 flex-col gap-3 border-l p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Generated Kirk</span>
              <Button variant="ghost" size="icon-sm" onClick={() => { navigator.clipboard.writeText(kirk); toast("Copied") }}><Copy /></Button>
            </div>
            <ScrollArea className="min-h-0 flex-1 rounded-lg bg-muted/60">
              <pre className="whitespace-pre-wrap p-3 font-mono text-[11px] leading-relaxed">{kirk.split("\n").map((l, i) => (
                <div key={i} className={l.startsWith("//") ? "text-muted-foreground" : /^(simulate|sweep|montecarlo|temp)/.test(l) ? "text-chart-1" : /^(measure|assert)/.test(l) ? "text-chart-3" : ""}>{l || " "}</div>
              ))}</pre>
            </ScrollArea>
            <div className="grid grid-cols-2 gap-y-1.5 rounded-lg border p-3 text-xs">
              <span className="text-muted-foreground">Runs</span><span className="text-right font-mono">{runs.length} × {analysisForRuns === "tran" ? "transient" : analysisForRuns === "ac" ? "AC" : analysisForRuns === "dc" ? "DC" : "OP"}</span>
              <span className="text-muted-foreground">Est. time</span><span className="text-right font-mono">{est !== null ? `≈ ${formatSI(est / 1000, "s", 2)}${threads > 1 ? " (parallel)" : ""}` : "—"}</span>
              <span className="text-muted-foreground">Raw data</span><span className="text-right font-mono">≈ {formatSI(pointsPerRun * signals * 8 * runs.length * (analysisForRuns === "ac" ? 2 : 1), "B", 2)}</span>
              <span className="text-muted-foreground">Points / run</span><span className="text-right font-mono">{pointsPerRun.toLocaleString()}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 border-t px-6 py-3">
          <Button variant="ghost" onClick={() => setD({ ...fresh(), setup: defaultSetup(), measures: [], asserts: [] })}>Restore defaults</Button>
          <div className="flex-1" />
          <span className="text-xs text-muted-foreground">Run with <Kbd>⌘↵</Kbd></span>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="outline" disabled={!valid} onClick={() => { onApply(d); onOpenChange(false) }}>Apply</Button>
          <Button disabled={!valid} onClick={run}>{runs.length > 1 ? `Run ${runs.length} runs` : "Run"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
