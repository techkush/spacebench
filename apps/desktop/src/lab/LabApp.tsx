// The Lab: a window of its own for the open circuit. It lists every input the circuit has —
// supplies and sources, sensors, controls, the room — lets you feed each one data in Kirk
// (`stimulus { }`: constants, ramps, steps, sines, random, noise, drift, recorded samples, CSV),
// runs the circuit with those feeds, and reports what happened to every part: voltage,
// current, power and a stress check against its ratings (PSpice "Smoke" style).
import { useEffect, useMemo, useRef, useState } from "react"
import { AlertTriangle, CircleCheck, CircleX, Download, FileUp, FlaskConical, Loader2, Play, Plus, Plug } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Toaster } from "@/components/ui/sonner"
import { toast } from "sonner"
import { KirkEditor } from "@/components/KirkEditor"
import { Plot, type Trace } from "@/components/Plot"
import { docSymbols, type Doc } from "@/editor/model"
import { deriveNetlist } from "@/editor/netlist"
import { exportCsv, saveExport } from "@/editor/file"
import type { Diagnostic } from "@/kirk/ast"
import { parse } from "@/kirk/parser"
import { setEngineOptions, simulate, type JobResult } from "@/lib/engine"
import { feedTargets, findTarget, resolveFeeds, type FeedTarget, type TargetKind } from "@/lib/feeds"
import { ensureSymbols } from "@/lib/kicad"
import { labChannel, type LabMessage } from "@/lib/labLink"
import { resolvedDark, useSettings } from "@/lib/settings"
import { buildNetlist, setSolverOptions } from "@/lib/spice"
import { samplePwl, type Stimulus } from "@/lib/stimulus"
import { qtyText, quantityTemplates } from "@/lib/sensors"
import { partReports, stats, type PartReport, type Status } from "@/lib/stress"
import { formatSI, parseSI } from "@/lib/units"
import { cn } from "@/lib/utils"

const GROUPS: { kind: TargetKind; title: string; hint: string }[] = [
  { kind: "source", title: "Supplies & sources", hint: "feed a voltage or current: sag, surge, ripple, noise, a recorded log" },
  { kind: "sensor", title: "Sensors", hint: "feed what each sensor senses" },
  { kind: "control", title: "Controls", hint: "move a pot or flip a switch over time" },
  { kind: "room", title: "Room (all sensors)", hint: "for every sensor without its own feed" },
]
const COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"]

/** Kirk text for a value with its unit (°C must stick to the number). */
function q(v: number, unit?: string): string {
  if (!unit) return String(Number(v.toPrecision(4)))
  if (unit === "°C") return `${Number(v.toPrecision(4))}°C`
  if (unit === "dB") return `${Number(v.toPrecision(4))} dB`
  if (unit === "lx") return `${formatSI(v, "", 3).trim()} lux`.replace(/\s+lux/, " lux")
  return formatSI(v, unit, 3)
}

/** Ready-made feeds for an input, sized to the run length. */
function templates(t: FeedTarget, dur: number): { label: string; expr: string }[] {
  const b = t.base, u = t.unit, d = q(dur, "s"), d2 = q(dur / 2, "s"), step = q(dur / 50, "s")
  if (t.kind === "control") {
    return t.input === "pot"
      ? [{ label: "Constant", expr: "0.5" }, { label: "Sweep 0 → 1", expr: `ramp(from: 0, to: 1, over: ${d})` }, { label: "Wobble (sine)", expr: `sine(mean: 0.5, amp: 0.4, freq: ${q(4 / dur, "Hz")})` }, { label: "Random positions", expr: `random(min: 0, max: 1, every: ${q(dur / 10, "s")})` }]
      : [{ label: "On", expr: "on" }, { label: "Off", expr: "off" }, { label: "Switch on halfway", expr: `step(from: 0, to: 1, at: ${d2})` }, { label: "On / off (square)", expr: `square(low: 0, high: 1, period: ${q(dur / 4, "s")})` }, { label: "Random presses", expr: `random(min: 0, max: 1, every: ${q(dur / 20, "s")})` }]
  }
  if ((t.kind === "sensor" || t.kind === "room") && t.sense) return quantityTemplates(t.sense, dur, (s) => q(s, "s"))
  if (u === "lx") return [
    { label: "Constant", expr: q(b, u) }, { label: "Dusk (bright → dark)", expr: `ramp(from: 10k lux, to: 0.1 lux, over: ${d})` }, { label: "Lights off", expr: `step(from: 500 lux, to: 1 lux, at: ${d2})` },
    { label: "Flicker (100 Hz)", expr: `sine(mean: 300 lux, amp: 100 lux, freq: 100 Hz)` }, { label: "Clouds (random)", expr: `random(min: 2k lux, max: 20k lux, every: ${q(dur / 10, "s")}, smooth: true)` },
  ]
  if (u === "°C") return [
    { label: "Constant", expr: q(b === 27 ? 25 : b, u) }, { label: "Drift (random walk)", expr: `walk(start: 25°C, sd: 0.5°C, every: ${step}, min: -20°C, max: 80°C)` }, { label: "Random", expr: `random(min: 20°C, max: 30°C, every: ${q(dur / 20, "s")})` },
    { label: "Heat up", expr: `ramp(from: 20°C, to: 60°C, over: ${d})` }, { label: "Sensor noise", expr: `25°C + noise(sd: 0.3°C)` }, { label: "Hot / cold cycles", expr: `square(low: 15°C, high: 40°C, period: ${d2})` },
  ]
  if (u === "dB") return [{ label: "Constant", expr: q(b, u) }, { label: "Getting louder", expr: `ramp(from: 30 dB, to: 90 dB, over: ${d})` }, { label: "Clap", expr: `step(from: 30 dB, to: 95 dB, at: ${d2})` }, { label: "Random noise level", expr: `random(min: 40 dB, max: 80 dB, every: ${q(dur / 10, "s")})` }]
  if (u === "Hz") return [{ label: "Constant", expr: "1 kHz" }, { label: "440 Hz", expr: "440 Hz" }]
  // supplies and sources (V or A)
  const lo = b * 0.75, hi = b * 1.15, a = Math.abs(b) || 1
  return [
    { label: "Constant", expr: q(b, u) },
    { label: "Sag (brown-out)", expr: `ramp(from: ${q(b, u)}, to: ${q(lo, u)}, over: ${d})` },
    { label: "Drop out & recover", expr: `pwl("0 ${b} ${dur * 0.3} ${b} ${dur * 0.32} ${lo} ${dur * 0.6} ${lo} ${dur * 0.62} ${b}")` },
    { label: "Surge", expr: `step(from: ${q(b, u)}, to: ${q(hi, u)}, at: ${d2})` },
    { label: "Ripple (100 Hz)", expr: `sine(mean: ${q(b, u)}, amp: ${q(a * 0.05, u)}, freq: 100 Hz)` },
    { label: "Noise", expr: `${q(b, u)} + noise(sd: ${q(a * 0.02, u)})` },
    { label: "Random level", expr: `random(min: ${q(lo, u)}, max: ${q(hi, u)}, every: ${q(dur / 20, "s")})` },
    { label: "Recorded samples", expr: `samples([${[1, 0.98, 0.9, 0.95, 1.02, 1].map((k) => q(b * k, u)).join(", ")}], every: ${q(dur / 5, "s")})` },
  ]
}

const blockText = (st: Stimulus | undefined) => `stimulus {\n${st?.seed !== undefined ? `    seed: ${st.seed}\n` : ""}${(st?.feeds ?? []).map((f) => `    ${f.target} = ${f.expr}\n`).join("")}}\n`

/** The stimulus block in the editor → Stimulus + parse diagnostics. */
function readBlock(text: string): { stimulus: Stimulus | undefined; diagnostics: Diagnostic[]; spans: { from: number; to: number }[] } {
  const r = parse(text)
  const blocks = r.file.items.filter((i) => i.k === "stimulus")
  const others = r.file.items.filter((i) => i.k !== "stimulus")
  const diagnostics: Diagnostic[] = [...r.diagnostics]
  for (const o of others) diagnostics.push({ severity: "error", code: "V302", message: "only the stimulus { } block goes here — the circuit is edited in the main window", span: o.span })
  const feeds = blocks.flatMap((b) => (b.k === "stimulus" ? b.feeds : []))
  const seedExpr = blocks.map((b) => (b.k === "stimulus" ? b.seed : undefined)).find(Boolean)
  const seed = seedExpr?.k === "num" ? seedExpr.value : undefined
  return { stimulus: feeds.length || seed !== undefined ? { feeds: feeds.map((f) => ({ target: f.target, expr: text.slice(f.value.span.from, f.value.span.to) })), ...(seed !== undefined ? { seed } : {}) } : undefined, diagnostics, spans: feeds.map((f) => f.span) }
}

function useLabTheme() {
  const pref = useSettings().theme
  const dark = resolvedDark(pref)
  if (document.documentElement.classList.contains("dark") !== dark) document.documentElement.classList.toggle("dark", dark)
}

export function LabApp() {
  useLabTheme()
  const settings = useSettings()
  const [doc, setDoc] = useState<Doc | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const [linked, setLinked] = useState<"waiting" | "linked" | "closed">("waiting")
  const [text, setText] = useState(blockText(undefined))
  const [durText, setDurText] = useState("")
  const [derating, setDerating] = useState("1")
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ res: JobResult; reports: PartReport[]; doc: Doc; ms: number } | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const channel = useRef<ReturnType<typeof labChannel> | null>(null)
  const lastSent = useRef<string>("")
  const edited = useRef(false)

  // engine settings come from the shared settings store
  useEffect(() => {
    const n = (t: string) => parseSI(t) ?? undefined
    setSolverOptions({ reltol: n(settings.reltol), abstol: n(settings.abstol), vntol: n(settings.vntol), gmin: n(settings.gmin), method: settings.method, saveCurrents: settings.saveCurrents })
    setEngineOptions({ bin: settings.ngspicePath, autoRecover: settings.autoRecover, engine: settings.engineKind })
  }, [settings])

  // link to the main window
  useEffect(() => {
    const ch = labChannel((m: LabMessage) => {
      if (m.type === "circuit") {
        ensureSymbols(docSymbols(m.doc)).then(() => {
          setDoc(m.doc); setErrors(m.errors); setLinked("linked")
          const incoming = blockText(m.doc.stimulus)
          // keep what is being typed; take the circuit's feeds when they changed elsewhere
          if (!edited.current || JSON.stringify(m.doc.stimulus ?? null) !== lastSent.current) { setText(incoming); lastSent.current = JSON.stringify(m.doc.stimulus ?? null); edited.current = false }
          setDurText((d) => d || formatSI(m.doc.analyses.tran.stop, "s", 3))
        })
      } else if (m.type === "closed") setLinked("closed")
    })
    channel.current = ch
    ch.send({ type: "hello" })
    const again = setInterval(() => { if (!docRef.current) ch.send({ type: "hello" }) }, 1000)
    document.title = "Space Bench Lab"
    return () => { clearInterval(again); ch.close() }
  }, [])
  const docRef = useRef(doc)
  docRef.current = doc

  const dur = Math.max(1e-9, parseSI(durText) ?? doc?.analyses.tran.stop ?? 10e-3)
  const block = useMemo(() => readBlock(text), [text])
  const labDoc = useMemo<Doc | null>(() => (doc ? { ...doc, stimulus: block.stimulus, analyses: { ...doc.analyses, tran: { ...doc.analyses.tran, stop: dur, step: Math.min(doc.analyses.tran.step, dur / 500) } }, defaultAnalysis: "tran" } : null), [doc, block.stimulus, dur])
  const targets = useMemo(() => (doc ? feedTargets(doc) : []), [doc])
  const resolved = useMemo(() => (labDoc ? resolveFeeds(labDoc, dur) : null), [labDoc, dur])
  const diagnostics = useMemo<Diagnostic[]>(() => {
    const d = [...block.diagnostics]
    for (const pr of resolved?.problems ?? []) {
      const k = block.stimulus?.feeds.indexOf(pr.feed) ?? -1
      d.push({ severity: "error", code: "V301", message: pr.message, span: block.spans[k] ?? { from: 0, to: 1 } })
    }
    return d
  }, [block, resolved])

  // send the feeds back to the circuit (saved with it, shown in its Kirk code)
  useEffect(() => {
    if (!doc || block.diagnostics.some((d) => d.severity === "error")) return
    const json = JSON.stringify(block.stimulus ?? null)
    if (json === lastSent.current) return
    const t = setTimeout(() => { lastSent.current = json; channel.current?.send({ type: "stimulus", stimulus: block.stimulus }) }, 500)
    return () => clearTimeout(t)
  }, [block, doc])

  const edit = (t: string) => { edited.current = true; setText(t) }
  /** set (or replace) one feed line */
  const setFeed = (target: string, expr: string) => {
    const lines = text.trimEnd().split("\n")
    const close = lines.lastIndexOf("}")
    const at = lines.findIndex((l) => new RegExp(`^\\s*${target.replace(".", "\\.")}\\s*=`, "i").test(l))
    const line = `    ${target} = ${expr}`
    if (at >= 0) lines[at] = line
    else if (close >= 0) lines.splice(close, 0, line)
    else lines.push("stimulus {", line, "}")
    edit(lines.join("\n") + "\n")
  }
  const removeFeed = (target: string) => edit(text.split("\n").filter((l) => !new RegExp(`^\\s*${target.replace(".", "\\.")}\\s*=`, "i").test(l)).join("\n"))
  const importCsv = (target: string) => {
    const inp = document.createElement("input")
    inp.type = "file"; inp.accept = ".csv,.txt,text/csv"
    inp.onchange = async () => {
      const f = inp.files?.[0]
      if (!f) return
      const rows = (await f.text()).split(/\r?\n/).map((l) => l.split(/[,;\t ]+/).map(Number)).filter((r) => r.length && r.every(Number.isFinite))
      if (rows.length < 2) { toast.error("No numbers found — use one value per line, or time,value"); return }
      const expr = rows[0].length >= 2 ? `pwl("${rows.slice(0, 5000).map((r) => `${r[0]} ${r[1]}`).join(" ")}")` : `samples([${rows.slice(0, 5000).map((r) => r[0]).join(", ")}], every: ${q(dur / (rows.length - 1), "s")})`
      setFeed(target, expr)
      toast.success(`${rows.length} points from ${f.name} → ${target}`)
    }
    inp.click()
  }

  const canRun = !!labDoc && linked !== "closed" && !errors.length && !running
  const run = async () => {
    if (!labDoc) return
    setRunning(true); setRunError(null)
    const t0 = performance.now()
    try {
      await ensureSymbols(docSymbols(labDoc))
      const nl = deriveNetlist(labDoc)
      const net = buildNetlist(labDoc, nl, "tran")
      const errs = [...nl.issues, ...net.issues].filter((i) => i.severity === "error")
      if (errs.length) throw new Error(errs.map((e) => e.message).join("; "))
      const res = await simulate(net)
      setResult({ res, reports: partReports(labDoc, nl, res, Number(derating)), doc: labDoc, ms: performance.now() - t0 })
    } catch (e) {
      setRunError(String(e instanceof Error ? e.message : e).split("\n").slice(0, 3).join(" · "))
    } finally { setRunning(false) }
  }
  // re-score with a new derating without re-running
  useEffect(() => { setResult((r) => (r ? { ...r, reports: partReports(r.doc, deriveNetlist(r.doc), r.res, Number(derating)) } : r)) }, [derating])

  type Exportable = "signals" | "parts" | "stats" | "json"
  const exportRun = async (what: Exportable) => {
    if (!result || result.res.type !== "tran") return
    const r = result.res, base = `${result.doc.title} lab`
    const fed = [...(resolveFeeds(result.doc, dur).feeds.values())]
    const done = (path: string | null, n: string) => { if (path) toast.success(`Saved ${n}`, { description: path }) }
    if (what === "signals") {
      // time, every feed (as fed), every circuit signal
      const header = ["time (s)", ...fed.map((f) => `feed ${f.target.target}${f.target.unit ? ` (${f.target.unit})` : ""}`), ...r.names]
      const rows = r.time.map((t, k) => [t, ...fed.map((f) => f.signal.at(t)), ...r.names.map((_, j) => r.data[j][k])])
      return done(await exportCsv(`${base} signals`, header, rows), `${rows.length} rows × ${header.length} columns`)
    }
    if (what === "parts") {
      // one row per check, so the file sorts and filters well in a spreadsheet
      const header = ["part", "description", "V min (V)", "V max (V)", "I peak (A)", "I rms (A)", "P avg (W)", "P peak (W)", "status", "check", "value", "limit", "unit", "percent of limit", "check status", "limit from"]
      const rows: (string | number)[][] = []
      for (const p of result.reports) {
        const common = [p.ref, p.label, p.v?.min ?? "", p.v?.max ?? "", p.i?.peak ?? "", p.i?.rms ?? "", p.p?.avg ?? "", p.p ? Math.max(Math.abs(p.p.min), Math.abs(p.p.max)) : "", p.worst ?? ""]
        if (!p.checks.length) rows.push([...common, "", "", "", "", "", "", ""])
        for (const c of p.checks) rows.push([...common, c.what, c.value, c.limit, c.unit, Number(c.pct.toFixed(2)), c.status, c.basis])
      }
      return done(await saveExport(`${base} parts.csv`, "csv", csv(header, rows)), `${result.reports.length} parts`)
    }
    if (what === "stats") {
      const header = ["signal", "unit", "min", "max", "average", "rms", "peak"]
      const rows = r.names.map((n, j) => { const st = stats(r.data[j], r.time); return [n, n.startsWith("V(") ? "V" : "A", st.min, st.max, st.avg, st.rms, st.peak] })
      return done(await saveExport(`${base} statistics.csv`, "csv", csv(header, rows)), `${rows.length} signals`)
    }
    // everything, for scripts (Python, MATLAB, Excel Power Query …)
    const json = {
      circuit: result.doc.title, exported: new Date().toISOString(), runLength_s: dur, points: r.time.length, simulation_ms: Math.round(result.ms), derating: Number(derating),
      feeds: result.doc.stimulus?.feeds ?? [], seed: result.doc.stimulus?.seed,
      parts: result.reports,
      signals: { time: r.time, ...Object.fromEntries(r.names.map((n, j) => [n, r.data[j]])) },
      fed: Object.fromEntries(fed.map((f) => [f.target.target, r.time.map((t) => f.signal.at(t))])),
    }
    return done(await saveExport(`${base}.json`, "json", JSON.stringify(json)), "the whole run")
  }

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <Toaster position="bottom-right" />
      {/* title bar */}
      <header data-tauri-drag-region className="flex h-12 shrink-0 items-center gap-3 border-b pl-20 pr-3">
        <FlaskConical className="pointer-events-none size-4" />
        <span className="pointer-events-none text-sm font-semibold">Lab</span>
        <span className="pointer-events-none min-w-0 truncate text-sm text-muted-foreground">{doc ? doc.title : "waiting for the circuit…"}</span>
        <span className={cn("pointer-events-none size-2 rounded-full", linked === "linked" ? "bg-success" : linked === "closed" ? "bg-destructive" : "animate-pulse bg-warning")} title={linked === "linked" ? "Linked to the circuit window" : linked === "closed" ? "The circuit window was closed" : "Connecting…"} />
        <div data-tauri-drag-region className="flex-1 self-stretch" />
        <label className="flex items-center gap-2 text-xs text-muted-foreground">Run for
          <Input className="h-8 w-24 font-mono text-xs" value={durText} onChange={(e) => setDurText(e.target.value)} onBlur={() => setDurText(formatSI(dur, "s", 3))} aria-label="Run length" />
        </label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">Derating
          <Select value={derating} onValueChange={setDerating}>
            <SelectTrigger size="sm" className="h-8 w-24 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>{["1", "0.9", "0.8", "0.7", "0.5"].map((v) => <SelectItem key={v} value={v}>{Number(v) * 100} %</SelectItem>)}</SelectContent>
          </Select>
        </label>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="outline" size="sm" className="h-8" disabled={!result || result.res.type !== "tran"}><Download /> Export</Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72">
            <DropdownMenuLabel className="text-xs">Export this run</DropdownMenuLabel>
            {([
              ["signals", "Signals over time (CSV)", "time, every feed and every voltage / current"],
              ["parts", "Parts report (CSV)", "voltage, current, power and stress of every part"],
              ["stats", "Signal statistics (CSV)", "min, max, average, rms of every signal"],
              ["json", "Everything (JSON)", "feeds, parts report and all signals — for scripts"],
            ] as const).map(([k, title, sub]) => (
              <DropdownMenuItem key={k} onClick={() => exportRun(k)} className="flex-col items-start gap-0"><span className="text-xs">{title}</span><span className="text-[10px] text-muted-foreground">{sub}</span></DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="sm" className="h-8" disabled={!canRun} onClick={run}>{running ? <Loader2 className="animate-spin" /> : <Play />} Run</Button>
      </header>

      {!doc ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"><Plug className="size-4" /> Open a circuit in Space Bench and press <b>Lab</b>.</div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[340px_1fr]">
          {/* inputs */}
          <aside className="min-h-0 overflow-auto border-r">
            {errors.length > 0 && (
              <div className="m-3 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs"><b>Fix the circuit first:</b> {errors.slice(0, 3).join(" · ")}</div>
            )}
            {GROUPS.map((g) => {
              const items = targets.filter((t) => t.kind === g.kind)
              if (!items.length) return null
              return (
                <section key={g.kind} className="border-b px-3 py-3">
                  <div className="mb-2 flex items-baseline gap-2"><h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g.title}</h3><span className="text-[11px] text-muted-foreground">{items.length}</span></div>
                  <p className="mb-2 text-[11px] text-muted-foreground">{g.hint}</p>
                  <div className="flex flex-col gap-1.5">
                    {items.map((t) => {
                      const feed = block.stimulus?.feeds.find((f) => findTarget([t], f.target))
                      const sig = resolved?.feeds.get(t.target.toUpperCase())
                      const bad = resolved?.problems.find((p) => p.feed === feed)
                      return (
                        <div key={t.target} className={cn("rounded-md border px-2.5 py-2", feed && !bad ? "border-primary/40 bg-primary/5" : bad ? "border-destructive/40" : "")}>
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs font-semibold">{t.target}</span>
                            <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{t.part ? `${t.quantity}${t.unit ? ` (${t.unit})` : ""}` : t.quantity}</span>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" className="size-6" aria-label={`Feed ${t.target}`}><Plus /></Button></DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-64">
                                <DropdownMenuLabel className="text-xs">Feed {t.target}</DropdownMenuLabel>
                                {templates(t, dur).map((tp) => <DropdownMenuItem key={tp.label} onClick={() => setFeed(t.target, tp.expr)} className="flex-col items-start gap-0"><span className="text-xs">{tp.label}</span><span className="max-w-full truncate font-mono text-[10px] text-muted-foreground">{tp.expr}</span></DropdownMenuItem>)}
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={() => importCsv(t.target)}><FileUp /> Import CSV…</DropdownMenuItem>
                                {feed && <DropdownMenuItem onClick={() => removeFeed(t.target)} className="text-destructive">Remove feed</DropdownMenuItem>}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                          {feed ? (
                            <div className="mt-1 flex items-center gap-2">
                              <code className="min-w-0 flex-1 truncate text-[11px]" title={feed.expr}>{feed.expr}</code>
                              {sig && !sig.signal.constant && <Spark points={samplePwl(sig.signal, dur, 80)} />}
                            </div>
                          ) : (
                            <div className="mt-1 text-[11px] text-muted-foreground">not fed · {t.sense ? qtyText(t.sense, t.base) : t.unit ? q(t.base, t.unit) : t.base}</div>
                          )}
                          {bad && <div className="mt-1 text-[11px] text-destructive">{bad.message}</div>}
                        </div>
                      )
                    })}
                  </div>
                </section>
              )
            })}
          </aside>

          {/* feeds editor + results */}
          <main className="grid min-h-0 grid-rows-[auto_1fr]">
            <div className="flex flex-col border-b">
              <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Feeds</span> · Kirk <code className="font-mono">stimulus {"{ }"}</code> — saved with the circuit
                <div className="flex-1" />
                {diagnostics.length ? <span className="flex items-center gap-1 text-destructive"><CircleX className="size-3.5" /> {diagnostics.length} problem{diagnostics.length > 1 ? "s" : ""}</span> : <span className="flex items-center gap-1 text-success"><CircleCheck className="size-3.5" /> {block.stimulus?.feeds.length ?? 0} feed{block.stimulus?.feeds.length === 1 ? "" : "s"}</span>}
              </div>
              <div className="h-48 min-h-0">
                <KirkEditor value={text} onChange={edit} diagnostics={diagnostics} doc={doc} netlist={deriveNetlist(doc)} values={{}} measures={{}} asserts={[]} onCursorRef={() => {}} />
              </div>
            </div>
            <Results result={result} running={running} error={runError} dur={dur} feeds={resolved ? [...resolved.feeds.values()].map((f) => ({ label: f.target.target, unit: f.target.unit, sig: f.signal })) : []} probes={doc.probes} />
          </main>
        </div>
      )}
    </div>
  )
}

/** CSV text: quoted where needed, numbers at full precision. */
function csv(header: string[], rows: (string | number)[][]): string {
  const cell = (v: string | number) => (typeof v === "number" ? (Number.isFinite(v) ? String(Number(v.toPrecision(9))) : "") : /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  return [header.map(cell).join(","), ...rows.map((r) => r.map(cell).join(","))].join("\n") + "\n"
}

function Spark({ points }: { points: [number, number][] }) {
  const ys = points.map((p) => p[1])
  const lo = Math.min(...ys), hi = Math.max(...ys), w = 84, h = 22
  const t1 = points[points.length - 1][0] || 1
  const d = points.map(([t, y], k) => `${k ? "L" : "M"}${((t / t1) * w).toFixed(1)},${(h - 2 - ((y - lo) / (hi - lo || 1)) * (h - 4)).toFixed(1)}`).join(" ")
  return <svg width={w} height={h} className="shrink-0 text-primary"><path d={d} fill="none" stroke="currentColor" strokeWidth={1.4} /></svg>
}

const STATUS_STYLE: Record<Status, string> = { ok: "bg-success", warn: "bg-warning", over: "bg-destructive" }
const fmt = (v: number | undefined, u: string) => (v === undefined || !Number.isFinite(v) ? "—" : formatSI(Math.abs(v) < 1e-15 ? 0 : v, u, 3))

function Results({ result, running, error, dur, feeds, probes }: {
  result: { res: JobResult; reports: PartReport[]; ms: number } | null; running: boolean; error: string | null; dur: number
  feeds: { label: string; unit?: string; sig: { at: (t: number) => number } }[]; probes: string[]
}) {
  const [picked, setPicked] = useState<string[] | null>(null)
  if (error) return <div className="m-4 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" /><div><b>The run failed.</b> {error}</div></div>
  if (!result) return <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">{running ? <><Loader2 className="size-4 animate-spin" /> Simulating…</> : <>Add feeds on the left, then press <b className="text-foreground">Run</b> — every part's voltage, current, power and stress is collected.</>}</div>
  const { res, reports } = result
  const over = reports.filter((r) => r.worst === "over").length, warn = reports.filter((r) => r.worst === "warn").length
  const time = res.type === "tran" ? res.time : []
  const signals = res.type === "tran" ? res.names : []
  const chosen = picked ?? [...probes.filter((p) => signals.includes(p)), ...signals.filter((s) => s.startsWith("V("))].slice(0, 4)
  return (
    <Tabs defaultValue="parts" className="flex min-h-0 flex-col gap-0">
      <div className="flex items-center gap-3 border-b px-3 py-1">
        <TabsList>
          <TabsTrigger value="parts">Parts</TabsTrigger>
          <TabsTrigger value="signals">Signals</TabsTrigger>
          <TabsTrigger value="data">Data</TabsTrigger>
        </TabsList>
        <div className="flex-1" />
        {over > 0 && <Badge variant="secondary" className="bg-destructive/15 text-destructive">{over} over rating</Badge>}
        {warn > 0 && <Badge variant="secondary" className="bg-warning/15 text-warning">{warn} near rating</Badge>}
        {!over && !warn && <Badge variant="secondary" className="bg-success/15 text-success">all parts within ratings</Badge>}
        <span className="font-mono text-xs text-muted-foreground">{formatSI(dur, "s", 3)} · {time.length} points · {Math.round(result.ms)} ms</span>
      </div>

      <TabsContent value="parts" className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-10 bg-muted text-muted-foreground">
            <tr>{["Part", "Voltage (min … max)", "Current (peak · rms)", "Power (avg · peak)", "Stress vs rating"].map((h) => <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y">
            {reports.map((r) => (
              <tr key={r.ref} className={cn(r.worst === "over" && "bg-destructive/5")}>
                <td className="px-3 py-2"><div className="flex items-center gap-2"><span className={cn("size-2 shrink-0 rounded-full", r.worst ? STATUS_STYLE[r.worst] : "bg-muted-foreground/30")} /><span className="font-mono font-semibold">{r.ref}</span></div><div className="pl-4 text-muted-foreground">{r.label}</div></td>
                <td className="px-3 py-2 font-mono">{r.v ? `${fmt(r.v.min, "V")} … ${fmt(r.v.max, "V")}` : "—"}</td>
                <td className="px-3 py-2 font-mono">{r.i ? `${fmt(r.i.peak, "A")} · ${fmt(r.i.rms, "A")}` : "—"}</td>
                <td className="px-3 py-2 font-mono">{r.p ? `${fmt(r.p.avg, "W")} · ${fmt(Math.max(Math.abs(r.p.min), Math.abs(r.p.max)), "W")}` : "—"}</td>
                <td className="px-3 py-2">
                  {r.checks.length ? r.checks.map((c) => (
                    <div key={c.what} className="flex items-center gap-2 py-0.5" title={`${c.what}: ${fmt(c.value, c.unit)} of ${fmt(c.limit, c.unit)} allowed (${c.basis})`}>
                      <span className="w-36 shrink-0 truncate text-muted-foreground">{c.what}</span>
                      <div className="h-1.5 w-28 shrink-0 overflow-hidden rounded-full bg-muted"><div className={cn("h-full rounded-full", STATUS_STYLE[c.status])} style={{ width: `${Math.min(100, c.pct)}%` }} /></div>
                      <span className={cn("w-12 shrink-0 text-right font-mono", c.status === "over" ? "text-destructive" : c.status === "warn" ? "text-warning" : "")}>{c.pct >= 999 ? ">999" : Math.round(c.pct)}%</span>
                      <span className="truncate font-mono text-muted-foreground">{fmt(c.value, c.unit)} / {fmt(c.limit, c.unit)}</span>
                    </div>
                  )) : <span className="text-muted-foreground">no rating to check</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TabsContent>

      <TabsContent value="signals" className="min-h-0 flex-1 overflow-auto p-3">
        {res.type !== "tran" ? <p className="text-sm text-muted-foreground">Signals over time need a transient.</p> : (
          <div className="grid gap-3 xl:grid-cols-[1fr_1fr]">
            {feeds.map((f, k) => (
              <div key={f.label} className="rounded-md border p-2">
                <div className="mb-1 text-xs"><span className="font-mono font-semibold">{f.label}</span> <span className="text-muted-foreground">fed{f.unit ? ` (${f.unit})` : ""}</span></div>
                <div className="h-36"><Plot x={time} traces={[{ label: f.label, y: time.map((t) => f.sig.at(t)), color: COLORS[k % COLORS.length] }]} xUnit="s" yUnit={f.unit === "°C" ? "°C" : f.unit ?? ""} legend={false} /></div>
              </div>
            ))}
            <div className="rounded-md border p-2 xl:col-span-2">
              <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs">
                <span className="mr-1 font-medium">Circuit</span>
                {signals.slice(0, 40).map((s) => (
                  <button key={s} onClick={() => setPicked((p) => { const cur = p ?? chosen; return cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s].slice(-6) })}
                    className={cn("rounded-full border px-2 py-0.5 font-mono text-[11px]", chosen.includes(s) ? "border-primary bg-primary text-primary-foreground" : "hover:bg-accent")}>{s}</button>
                ))}
              </div>
              <div className="h-64">
                <Plot x={time} traces={chosen.filter((s) => signals.includes(s)).map((s, k): Trace => ({ label: s, y: res.data[signals.indexOf(s)], color: COLORS[k % COLORS.length] }))} xUnit="s" yUnit={chosen.every((s) => s.startsWith("V(")) ? "V" : chosen.every((s) => /^I/.test(s)) ? "A" : ""} />
              </div>
            </div>
          </div>
        )}
      </TabsContent>

      <TabsContent value="data" className="min-h-0 flex-1 overflow-auto">
        {res.type !== "tran" ? null : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-muted text-muted-foreground"><tr>{["Signal", "min", "max", "average", "rms"].map((h) => <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>)}</tr></thead>
            <tbody className="divide-y font-mono">
              {res.names.map((n, j) => {
                const s = stats(res.data[j], res.time), u = n.startsWith("V(") ? "V" : "A"
                return <tr key={n}><td className="px-3 py-1.5">{n}</td><td className="px-3 py-1.5">{fmt(s.min, u)}</td><td className="px-3 py-1.5">{fmt(s.max, u)}</td><td className="px-3 py-1.5">{fmt(s.avg, u)}</td><td className="px-3 py-1.5">{fmt(s.rms, u)}</td></tr>
              })}
            </tbody>
          </table>
        )}
      </TabsContent>
    </Tabs>
  )
}
