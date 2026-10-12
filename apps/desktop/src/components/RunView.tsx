// Simulation process view: how a run turns the schematic into data —
// pipeline stages with timings, a timeline of every run, the solver console, and run
// states (progress, complete, recovered, failed) that link back to the parts involved.
import { useEffect, useMemo, useRef, useState } from "react"
import {
  Activity, Check, ChevronRight, CircleAlert, Copy, Cpu, Download, FileText, Gauge, LineChart, Loader2, Pause, Play, RotateCw, Spline, Square, TriangleAlert, Zap,
} from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { STAGES, stamp, useRuns, type RunRecord, type Stage, type StageId } from "@/lib/runlog"
import { cn } from "@/lib/utils"
import { RUN_COLORS } from "./AnalysisView"

const STAGE_ICON: Record<StageId, typeof Zap> = { erc: Spline, ir: FileText, models: Cpu, solver: Zap, vectors: Activity, measure: Gauge, export: Download }
const STAGE_COLOR: Record<StageId, string> = { erc: "#2563eb", ir: "#2563eb", models: "#7c3aed", solver: "#e11d48", vectors: "#16a34a", measure: "#d97706", export: "#d97706" }

interface Props {
  selectedId: string | null
  setSelectedId: (id: string) => void
  onRerun: () => void
  onViewResults: (setId: string) => void
  onExport: (setId: string) => void
  onShowRefs: (refs: string[]) => void
  onPause: (pause: boolean) => void
  onStop: () => void
  /** the run a user can pause / stop (the one in progress) */
  activeId: string | null
}

const fmtMs = (ms: number | null) => (ms === null ? "—" : ms < 1 ? "<1 ms" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`)
const duration = (r: RunRecord, now: number) => (r.ended ?? now) - r.started

/** Ticks while a run is in progress so bars and clocks move. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => performance.now())
  useEffect(() => {
    if (!active) return
    const h = setInterval(() => setNow(performance.now()), 100)
    return () => clearInterval(h)
  }, [active])
  return active ? now : performance.now()
}

export function RunView(p: Props) {
  const runs = useRuns()
  const rec = runs.find((r) => r.id === p.selectedId) ?? runs.find((r) => !r.live) ?? runs[0] ?? null
  const active = rec?.status === "running" || rec?.status === "paused"
  const now = useNow(active)
  const [netlistOpen, setNetlistOpen] = useState(false)

  if (!rec) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-background text-center">
        <Activity className="size-8 text-muted-foreground" />
        <div className="text-lg font-medium">No runs yet</div>
        <p className="max-w-md text-sm text-muted-foreground">Press Simulate (F5). Every run shows here: how the schematic became a netlist, what the solver did, and where any error came from.</p>
        <Button onClick={p.onRerun}><Play /> Simulate</Button>
      </div>
    )
  }
  const total = duration(rec, now)
  return (
    <ScrollArea className="h-full bg-background [&_[data-slot=scroll-area-viewport]>div]:!block">
      <div className="@container mx-auto flex max-w-[1760px] flex-col gap-5 px-8 py-6">
        {/* header */}
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight">{rec.live ? "Live run" : `Run #${rec.n}`} · {rec.label}</h1>
              <StatusBadge r={rec} ms={total} />
              <Select value={rec.id} onValueChange={p.setSelectedId}>
                <SelectTrigger size="sm" className="h-7 w-auto gap-1 text-xs text-muted-foreground"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {runs.map((r) => <SelectItem key={r.id} value={r.id} className="text-xs">{r.live ? "Live run" : `Run #${r.n}`} · {r.label} · {new Date(r.wall).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <p className="mt-1.5 text-sm text-muted-foreground">How Space Bench turns the schematic into data: every stage below is inspectable, and errors link back to the part that caused them.</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => setNetlistOpen(true)} disabled={!rec.netlist}><FileText /> Open netlist</Button>
            <Button variant="outline" onClick={p.onRerun} disabled={active}><RotateCw /> Re-run</Button>
            <Button onClick={() => rec.resultSetId && p.onViewResults(rec.resultSetId)} disabled={!rec.resultSetId}><LineChart /> View results</Button>
          </div>
        </div>

        {/* pipeline */}
        <div className="grid grid-cols-2 gap-3 @[900px]:grid-cols-4 @[1500px]:grid-cols-7">
          {STAGES.map((s, i) => (
            <StageCard key={s.id} n={i + 1} id={s.id} title={s.title} stage={rec.stages[s.id]} last={i === STAGES.length - 1}
              onExport={s.id === "export" && rec.resultSetId ? () => p.onExport(rec.resultSetId!) : undefined} />
          ))}
        </div>

        <div className="grid gap-5 @[1100px]:grid-cols-[minmax(0,1fr)_420px]">
          <div className="flex min-w-0 flex-col gap-5">
            <Timeline r={rec} total={total} />
            <Console r={rec} />
          </div>
          <RunStates r={rec} total={total} canControl={rec.id === p.activeId} {...p} onNetlist={() => setNetlistOpen(true)} />
        </div>
      </div>
      <Dialog open={netlistOpen} onOpenChange={setNetlistOpen}>
        <DialogContent className="flex max-h-[80vh] max-w-[min(900px,92vw)] flex-col sm:max-w-[min(900px,92vw)]">
          <DialogTitle>Netlist · {rec.live ? "live run" : `run #${rec.n}`}</DialogTitle>
          <DialogDescription>The SPICE deck sent to ngspice (the control block that runs it and writes the results is added by the engine).</DialogDescription>
          <pre className="min-h-0 flex-1 overflow-auto rounded-lg bg-muted p-4 font-mono text-xs leading-relaxed">{rec.netlist}</pre>
          <div className="flex justify-end"><Button variant="outline" onClick={() => { navigator.clipboard?.writeText(rec.netlist ?? "").then(() => toast.success("Netlist copied")).catch(() => {}) }}><Copy /> Copy</Button></div>
        </DialogContent>
      </Dialog>
    </ScrollArea>
  )
}

function StatusBadge({ r, ms }: { r: RunRecord; ms: number }) {
  const t = fmtMs(ms)
  if (r.status === "running") return <Badge variant="secondary" className="gap-1 bg-info-subtle text-info"><Loader2 className="size-3 animate-spin" /> Running{r.total > 1 ? ` · ${r.done}/${r.total}` : ""} · {t}</Badge>
  if (r.status === "paused") return <Badge variant="secondary" className="bg-warning-subtle text-warning">Paused · {r.done}/{r.total}</Badge>
  if (r.status === "failed") return <Badge variant="secondary" className="bg-destructive-subtle text-destructive">Failed · {t}</Badge>
  if (r.status === "stopped") return <Badge variant="secondary">Stopped · {t}</Badge>
  return <Badge variant="secondary" className="bg-success-subtle text-success">Completed · {t}</Badge>
}

function StageStatus({ s }: { s: Stage }) {
  const map = {
    done: ["bg-success", "text-success", "Done"], warning: ["bg-warning", "text-warning", s.note ?? "Warning"], failed: ["bg-destructive", "text-destructive", s.note ?? "Failed"],
    running: ["bg-info animate-pulse", "text-info", "Running…"], pending: ["bg-muted-foreground/40", "text-muted-foreground", "Waiting"], skipped: ["bg-muted-foreground/40", "text-muted-foreground", "Skipped"],
  } as const
  const [dot, text, label] = map[s.status]
  return <span className={cn("flex items-center gap-1.5 text-xs", text)}><span className={cn("size-1.5 rounded-full", dot)} />{s.status === "warning" || s.status === "failed" ? label : s.status === "done" ? "Done" : label}</span>
}

function StageCard({ n, id, title, stage, last, onExport }: { n: number; id: StageId; title: string; stage: Stage; last: boolean; onExport?: () => void }) {
  const Icon = STAGE_ICON[id]
  const color = STAGE_COLOR[id]
  const dim = stage.status === "pending" || stage.status === "skipped"
  return (
    <div className="relative">
      <div className={cn("flex h-full flex-col gap-1 rounded-xl border bg-card p-3.5", stage.status === "failed" && "border-destructive/60", dim && id !== "export" && "opacity-60")}>
        <div className="mb-2 flex items-center gap-2">
          <span className="flex size-6 items-center justify-center rounded-full text-xs font-medium text-white" style={{ background: color }}>{n}</span>
          <Icon className="size-4" style={{ color }} />
          <div className="flex-1" />
          <span className="font-mono text-[11px] text-muted-foreground">{stage.ms !== null ? fmtMs(stage.ms) : stage.note && stage.status !== "warning" && stage.status !== "failed" ? stage.note : "—"}</span>
        </div>
        <div className="text-sm font-medium">{title}</div>
        {stage.lines.map((l, i) => <div key={i} className="truncate text-xs text-muted-foreground" title={l}>{l}</div>)}
        <div className="flex-1" />
        <div className="mt-2 flex items-center">
          {id === "export" ? (onExport ? <button onClick={onExport} className="flex items-center gap-1 text-xs text-info hover:underline">Export… <ChevronRight className="size-3" /></button> : <span className="text-xs text-muted-foreground">When results exist</span>) : <StageStatus s={stage} />}
        </div>
      </div>
      {!last && <ChevronRight className="absolute -right-3 top-1/2 z-10 hidden size-4 -translate-y-1/2 text-muted-foreground @[1500px]:block" />}
    </div>
  )
}

function Timeline({ r, total }: { r: RunRecord; total: number }) {
  const span = Math.max(total, 1)
  let runIdx = 0
  return (
    <section className="rounded-xl border bg-card p-4">
      <div className="mb-3 flex items-center"><h3 className="flex-1 text-sm font-medium">Timeline</h3><span className="font-mono text-[11px] text-muted-foreground">0 → {fmtMs(total)}</span></div>
      <div className="flex flex-col gap-1.5">
        {r.spans.map((s, i) => {
          const color = s.kind === "stage" ? (s.label.startsWith("ERC") ? STAGE_COLOR.erc : STAGE_COLOR.measure) : RUN_COLORS[runIdx++ % RUN_COLORS.length]
          const left = (s.start / span) * 100
          const width = Math.max(0.6, (((s.end ?? total) - s.start) / span) * 100)
          return (
            <div key={i} className="flex items-center gap-3">
              <span className="w-40 shrink-0 truncate font-mono text-[11px] text-muted-foreground" title={s.label}>{s.label}</span>
              <div className="relative h-3 flex-1 rounded-full bg-muted">
                <div title={`${s.label} · ${fmtMs((s.end ?? total) - s.start)}${s.status !== "done" ? ` · ${s.status}` : ""}`}
                  className={cn("absolute top-0 h-3 rounded-full", s.status === "running" && "animate-pulse", (s.status === "failed" || s.status === "stopped") && "opacity-50")}
                  style={{ left: `${Math.min(left, 99.4)}%`, width: `${Math.min(width, 100 - Math.min(left, 99.4))}%`, background: s.status === "failed" ? "var(--destructive)" : color }} />
              </div>
              <span className="w-16 shrink-0 text-right font-mono text-[11px] text-muted-foreground">{fmtMs((s.end ?? total) - s.start)}</span>
            </div>
          )
        })}
        {!r.spans.length && <p className="text-xs text-muted-foreground">Nothing recorded yet.</p>}
      </div>
    </section>
  )
}

function Console({ r }: { r: RunRecord }) {
  const box = useRef<HTMLDivElement>(null)
  // follow the newest line inside the console only (scrollIntoView would scroll the page too)
  useEffect(() => { const b = box.current; if (b) b.scrollTop = b.scrollHeight }, [r.log.length])
  return (
    <section className="flex flex-col rounded-xl border bg-card p-4">
      <div className="mb-3 flex items-center"><h3 className="flex-1 text-sm font-medium">Solver console</h3><Badge variant="outline" className="font-normal">ngspice · {r.analysis.toUpperCase()}</Badge></div>
      <div ref={box} className="max-h-[360px] min-h-[200px] overflow-auto font-mono text-xs leading-relaxed">
        {r.log.map((l, i) => (
          <div key={i} className={cn("whitespace-pre-wrap", l.level === "error" ? "text-destructive" : l.level === "warn" ? "text-warning" : l.level === "ok" ? "text-success" : "text-muted-foreground")}>
            {l.text.startsWith("[") ? l.text : `${stamp(l.t)} ${l.text}`}
          </div>
        ))}
      </div>
    </section>
  )
}

function StateCard({ tone, icon, title, detail, children }: { tone: "info" | "ok" | "warn" | "error" | "muted"; icon: React.ReactNode; title: string; detail?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className={cn("rounded-xl border bg-card p-4", tone === "error" && "border-destructive/70")}>
      <div className="flex items-start gap-3">
        <span className={cn("mt-0.5", tone === "info" ? "text-info" : tone === "ok" ? "text-success" : tone === "warn" ? "text-warning" : tone === "error" ? "text-destructive" : "text-muted-foreground")}>{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{title}</div>
          {detail && <div className="mt-1 text-xs text-muted-foreground">{detail}</div>}
          {children && <div className="mt-3 flex flex-wrap gap-2">{children}</div>}
        </div>
      </div>
    </div>
  )
}

function RunStates({ r, total, canControl, onPause, onStop, onRerun, onViewResults, onShowRefs, onNetlist }: Props & { r: RunRecord; total: number; canControl: boolean; onNetlist: () => void }) {
  const pct = r.total > 0 ? Math.round((r.done / r.total) * 100) : 0
  const vectors = r.stages.vectors.lines[1]?.split(" · ")[1]
  const cards = useMemo(() => r.events, [r.events])
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">Run states</h3>
      {(r.status === "running" || r.status === "paused") && (
        <StateCard tone="info" icon={r.status === "paused" ? <Pause className="size-4" /> : <Activity className="size-4" />}
          title={r.status === "paused" ? `Paused · ${pct} %` : r.total > 1 ? `Simulating… ${pct} %` : "Simulating…"}
          detail={<>
            <span>{r.label} · {r.total > 1 ? `${r.done} of ${r.total} runs done` : "ngspice is running"} · {fmtMs(total)}</span>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
              {r.total > 1 ? <div className="h-full rounded-full bg-info transition-all" style={{ width: `${pct}%` }} /> : <div className="h-full w-1/3 animate-[sb-indeterminate_1.2s_ease-in-out_infinite] rounded-full bg-info" />}
            </div>
          </>}>
          {canControl && r.total > 1 && <Button size="sm" variant="outline" onClick={() => onPause(r.status !== "paused")}>{r.status === "paused" ? <><Play /> Resume</> : <><Pause /> Pause</>}</Button>}
          {canControl && <Button size="sm" variant="outline" onClick={onStop}><Square /> Stop</Button>}
        </StateCard>
      )}
      {r.status === "done" && (
        <StateCard tone="ok" icon={<Check className="size-4" />} title="Simulation complete"
          detail={`${r.total} run${r.total > 1 ? "s" : ""} · ${fmtMs(total)}${vectors ? ` · ${vectors} of vectors collected` : ""}`}>
          {r.resultSetId && <Button size="sm" onClick={() => onViewResults(r.resultSetId!)}>View results</Button>}
        </StateCard>
      )}
      {r.status === "stopped" && (
        <StateCard tone="muted" icon={<Square className="size-4" />} title="Stopped" detail={`${r.done} of ${r.total} run${r.total > 1 ? "s" : ""} finished before the stop; runs still inside ngspice were dropped.`}>
          <Button size="sm" variant="outline" onClick={onRerun}><RotateCw /> Re-run</Button>
          {r.resultSetId && <Button size="sm" variant="outline" onClick={() => onViewResults(r.resultSetId!)}>View partial results</Button>}
        </StateCard>
      )}
      {cards.map((e, i) => (
        <StateCard key={i} tone={e.kind === "failed" ? "error" : "warn"} icon={e.kind === "failed" ? <CircleAlert className="size-4" /> : <TriangleAlert className="size-4" />}
          title={e.title} detail={<>{e.detail}<span className="ml-1 font-mono">{stamp(e.t)}</span></>}>
          {e.kind === "failed" && e.refs && e.refs.length > 0 && <Button size="sm" onClick={() => onShowRefs(e.refs!)}>Show on schematic ({e.refs.slice(0, 3).join(", ")}{e.refs.length > 3 ? "…" : ""})</Button>}
          {e.kind === "failed" && r.netlist && <Button size="sm" variant="outline" onClick={onNetlist}>Open netlist</Button>}
        </StateCard>
      ))}
      {r.status === "done" && !cards.length && (
        <p className="px-1 text-xs text-muted-foreground">No warnings, recoveries or errors in this run.</p>
      )}
    </div>
  )
}
