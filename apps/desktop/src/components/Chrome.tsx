import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import {
  Activity, ChartSpline, ChevronRight, Download, House, Settings, CircleAlert, CircleCheck, CircuitBoard, Copy, Crosshair, FilePlus2, FlipHorizontal2, FolderOpen, Loader2, Moon,
  FileCode2, Hand, Sparkles, MousePointer2, Pause, Settings2, Play, Plus, Redo2, RotateCw, Save, Search, Spline, Square, Sun, Tag, Trash2, TriangleAlert, Undo2, X, Zap,
  FlaskConical, Upload,
} from "lucide-react"
import { formatSI } from "@/lib/units"

import { Badge } from "@/components/ui/badge"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { getSymbol } from "@/lib/kicad"
import { SymbolThumb } from "./SymbolView"

export type AnalysisType = "tran" | "ac" | "op" | "dc"
const MOD = navigator.platform.includes("Mac") ? "⌘" : "Ctrl+"

function Tip({ label, keys, children }: { label: string; keys?: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}{keys && <Kbd className="ml-2">{keys}</Kbd>}</TooltipContent>
    </Tooltip>
  )
}

interface TitleBarProps {
  title: string
  dirty: boolean
  dark: boolean
  onToggleTheme: () => void
  onNew: () => void
  onOpen: () => void
  onSave: () => void
  onSearch: () => void
  onExamples: () => void
  onImport: () => void
  /** write the circuit as a KiCad schematic */
  onExportKicad: () => void
  onHome: () => void
  onSettings: () => void
  view: "schematic" | "split" | "code"
  setView: (v: "schematic" | "split" | "code") => void
  analysisOpen: boolean
  onAnalysis: () => void
  runOpen: boolean
  onRuns: () => void
  running: boolean
  pcbOpen: boolean
  onPcb: () => void
  aiOpen: boolean
  onAi: () => void
  /** open the Lab window; `labBlocked` says why it can't open (errors in the circuit) */
  onLab: () => void
  labBlocked: string | null
}

export function TitleBar({ title, dirty, dark, onToggleTheme, onNew, onOpen, onSave, onSearch, onExamples, onImport, onExportKicad, onHome, onSettings, view, setView, analysisOpen, onAnalysis, runOpen, onRuns, running, pcbOpen, onPcb, aiOpen, onAi, onLab, labBlocked }: TitleBarProps) {
  return (
    <header data-tauri-drag-region className="flex h-12 shrink-0 items-center gap-3 overflow-hidden whitespace-nowrap border-b bg-sidebar pl-[88px] pr-3">
      {/* one line, always: the circuit title shortens with … before anything wraps */}
      <div data-tauri-drag-region className="flex min-w-0 shrink items-center gap-2">
        <Tip label="Home" keys={`${MOD}⇧H`}>
          <button onClick={onHome} className="flex shrink-0 items-center gap-2 rounded-md hover:opacity-80" aria-label="Home">
            <div className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground"><Zap className="size-3.5" /></div>
            <span className="hidden text-sm font-medium lg:inline">Space Bench</span>
          </button>
        </Tip>
        <ChevronRight className="hidden size-3.5 shrink-0 text-muted-foreground lg:block" />
        <span className="min-w-0 truncate text-sm" title={title}>{title}</span>
        <Badge variant="secondary" className={`shrink-0 ${dirty ? "bg-warning-subtle text-warning" : ""}`}>{dirty ? "Unsaved" : "Saved"}</Badge>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" size="sm" className="h-7 px-2">File</Button></DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuItem onClick={onNew}><FilePlus2 /> New circuit <DropdownMenuShortcut>{MOD}N</DropdownMenuShortcut></DropdownMenuItem>
            <DropdownMenuItem onClick={onOpen}><FolderOpen /> Open… <DropdownMenuShortcut>{MOD}O</DropdownMenuShortcut></DropdownMenuItem>
            <DropdownMenuItem onClick={onSave}><Save /> Save <DropdownMenuShortcut>{MOD}S</DropdownMenuShortcut></DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onImport}><Download /> Import Kirk / KiCad / netlist… <DropdownMenuShortcut>{MOD}I</DropdownMenuShortcut></DropdownMenuItem>
            <DropdownMenuItem onClick={onExportKicad}><Upload /> Export KiCad schematic…</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onExamples}><Sparkles /> Examples… <DropdownMenuShortcut>{MOD}⇧E</DropdownMenuShortcut></DropdownMenuItem>
            <DropdownMenuItem onClick={onHome}><House /> Start screen <DropdownMenuShortcut>{MOD}⇧H</DropdownMenuShortcut></DropdownMenuItem>
            <DropdownMenuItem onClick={onSettings}><Settings /> Settings… <DropdownMenuShortcut>{MOD},</DropdownMenuShortcut></DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Tip label="New circuit" keys={`${MOD}N`}><Button variant="ghost" size="icon-sm" onClick={onNew}><FilePlus2 /></Button></Tip>
        <Tip label="Open…" keys={`${MOD}O`}><Button variant="ghost" size="icon-sm" onClick={onOpen}><FolderOpen /></Button></Tip>
        <Tip label="Save" keys={`${MOD}S`}><Button variant="ghost" size="icon-sm" onClick={onSave}><Save /></Button></Tip>
      </div>
      <div data-tauri-drag-region className="flex-1" />
      <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-muted p-[3px]">
        <Button size="sm" variant={!analysisOpen && !runOpen && !pcbOpen && view === "schematic" ? "secondary" : "ghost"} className={`h-7 ${!analysisOpen && !runOpen && !pcbOpen && view === "schematic" ? "bg-background shadow-sm" : "text-muted-foreground"}`} onClick={() => setView("schematic")}><Spline /> Schematic</Button>
        <Tip label="Kirk code ⇄ schematic" keys={`${MOD}E`}><Button size="sm" variant={!analysisOpen && !runOpen && !pcbOpen && view !== "schematic" ? "secondary" : "ghost"} className={`h-7 ${!analysisOpen && !runOpen && !pcbOpen && view !== "schematic" ? "bg-background shadow-sm" : "text-muted-foreground"}`} onClick={() => setView(view === "schematic" || analysisOpen ? (view === "schematic" ? "split" : view) : "schematic")}><FileCode2 /> Kirk</Button></Tip>
        <Tip label="Board layout: footprints, routing, DRC, Gerbers"><Button size="sm" variant={pcbOpen ? "secondary" : "ghost"} className={`h-7 ${pcbOpen ? "bg-background shadow-sm" : "text-muted-foreground"}`} onClick={onPcb}><CircuitBoard /> PCB</Button></Tip>
        <Button size="sm" variant={analysisOpen ? "secondary" : "ghost"} className={`h-7 ${analysisOpen ? "bg-background shadow-sm" : "text-muted-foreground"}`} onClick={onAnalysis}><ChartSpline /> Analysis</Button>
        <Tip label="Simulation process: stages, timeline and solver console"><Button size="sm" variant={runOpen ? "secondary" : "ghost"} className={`h-7 ${runOpen ? "bg-background shadow-sm" : "text-muted-foreground"}`} onClick={onRuns}>{running ? <Loader2 className="animate-spin" /> : <Activity />} Runs</Button></Tip>
      </div>
      <div data-tauri-drag-region className="flex-1" />
      <Tip label={labBlocked ?? "Lab (new window): feed data to every input — supplies, sensors, controls — and measure what happens to every part"}>
        <span className="shrink-0"><Button size="sm" variant="outline" className="h-8" disabled={!!labBlocked} onClick={onLab}><FlaskConical /> <span className="hidden xl:inline">Lab</span></Button></span>
      </Tip>
      <Tip label="AI assistant — design, simulate and probe by chat" keys={`${MOD}J`}>
        <Button size="sm" variant={aiOpen ? "secondary" : "outline"} className={`h-8 shrink-0 ${aiOpen ? "bg-accent" : ""}`} onClick={onAi}><Sparkles className="text-primary" /> <span className="hidden xl:inline">AI</span></Button>
      </Tip>
      <button onClick={onSearch} title="Search parts" className="flex h-8 shrink-0 items-center gap-2 rounded-md border bg-background px-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent xl:w-64">
        <Search className="size-4 shrink-0" /> <span className="hidden xl:inline">Search parts…</span> <Kbd className="ml-auto hidden xl:inline-flex">{MOD}K</Kbd>
      </button>
      <Button variant="ghost" size="icon" onClick={onToggleTheme} aria-label="Toggle theme">{dark ? <Sun /> : <Moon />}</Button>
    </header>
  )
}

/** Title bar of the full-screen views (Start, Settings): logo, breadcrumb, optional centre, theme. */
export function ShellBar({ crumb, onHome, center, dark, onToggleTheme, right }: { crumb?: string; onHome?: () => void; center?: ReactNode; dark: boolean; onToggleTheme: () => void; right?: ReactNode }) {
  return (
    <header data-tauri-drag-region className="relative z-30 flex h-12 shrink-0 items-center gap-3 whitespace-nowrap border-b bg-sidebar pl-[88px] pr-3">
      <button onClick={onHome} disabled={!onHome} className="flex shrink-0 items-center gap-2 rounded-md enabled:hover:opacity-80" aria-label="Home">
        <div className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground"><Zap className="size-3.5" /></div>
        <span className="text-sm font-medium">Space Bench</span>
      </button>
      {crumb && <><ChevronRight className="size-3.5 text-muted-foreground" /><span className="text-sm">{crumb}</span></>}
      <div data-tauri-drag-region className="flex-1" />
      {center && <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">{center}</div>}
      {right}
      <Button variant="ghost" size="icon" onClick={onToggleTheme} aria-label="Toggle theme">{dark ? <Sun /> : <Moon />}</Button>
    </header>
  )
}

export type ToolKind = "select" | "pan" | "wire" | "probe" | "noconnect"
export type SimMode = "realtime" | "accurate"

interface ToolbarProps {
  tool: string
  setTool: (t: ToolKind) => void
  onLabel: () => void
  onRotate: () => void
  onMirror: () => void
  onDuplicate: () => void
  onAddPart: () => void
  onQuickPlace: (id: string) => void
  onDelete: () => void
  onUndo: () => void
  onRedo: () => void
  canUndo: boolean
  canRedo: boolean
  hasSelection: boolean
  errors: number
  warnings: number
  analysis: AnalysisType
  setAnalysis: (a: AnalysisType) => void
  analysisDetail: Record<AnalysisType, string>
  running: boolean
  onRun: () => void
  mode: SimMode
  setMode: (m: SimMode) => void
  /** playback clock (real-time mode, transient) */
  clock: number | null
  playing: boolean
  onPlayPause: () => void
  onStop: () => void
  canStop: boolean
  onShowIssues: () => void
  onSetup: () => void
  hasDc: boolean
  /** multi-run progress "3/12" */
  progress: string | null
}

const QUICK: [string, string, string | undefined][] = [
  ["Device:R", "Resistor", "R"], ["Device:C", "Capacitor", "C"], ["Device:L", "Inductor", "L"], ["Device:D", "Diode", "D"],
  ["Transistor_BJT:2N3904", "NPN transistor", "Q"], ["Amplifier_Operational:LM358", "Op-amp (LM358)", undefined],
  ["Simulation_SPICE:VDC", "Voltage source", "V"], ["power:GND", "Ground", "G"],
]

export function Toolbar(p: ToolbarProps) {
  const toolBtn = (id: ToolKind, icon: ReactNode, label: string, key: string) => (
    <Tip label={label} keys={key}>
      <Button variant={p.tool === id ? "secondary" : "ghost"} size="icon" onClick={() => p.setTool(id)} aria-pressed={p.tool === id}>{icon}</Button>
    </Tip>
  )
  const canEdit = p.hasSelection || p.tool === "place"
  return (
    <div className="flex h-12 shrink-0 items-center gap-1 overflow-hidden whitespace-nowrap border-b px-2">
      {toolBtn("select", <MousePointer2 />, "Select / move", "Esc")}
      {toolBtn("pan", <Hand />, "Pan", "H")}
      {toolBtn("wire", <Spline />, "Draw wire", "W")}
      {toolBtn("probe", <Crosshair />, "Probe a wire or part into the scope", "P")}
      <Tip label="Net label" keys="N"><Button variant="ghost" size="icon" onClick={p.onLabel}><Tag /></Button></Tip>
      {toolBtn("noconnect", <X />, "No-connect marker", "Shift+X")}
      {/* below 1280 px the edit buttons hide (they are in the Inspector and on ⌘R / X / ⌘D / ⌫) */}
      <div className="hidden shrink-0 items-center gap-1 min-[1280px]:flex">
        <Separator orientation="vertical" className="mx-1 h-5" />
        <Tip label="Rotate 90°" keys={`${MOD}R`}><Button variant="ghost" size="icon" onClick={p.onRotate} disabled={!canEdit}><RotateCw /></Button></Tip>
        <Tip label="Mirror" keys="X"><Button variant="ghost" size="icon" onClick={p.onMirror} disabled={!canEdit}><FlipHorizontal2 /></Button></Tip>
        <Tip label="Duplicate" keys={`${MOD}D`}><Button variant="ghost" size="icon" onClick={p.onDuplicate} disabled={!p.hasSelection}><Copy /></Button></Tip>
        <Tip label="Delete" keys="⌫"><Button variant="ghost" size="icon" onClick={p.onDelete} disabled={!p.hasSelection}><Trash2 /></Button></Tip>
      </div>
      <Separator orientation="vertical" className="mx-1 h-5" />
      <Tip label="Undo" keys={`${MOD}Z`}><Button variant="ghost" size="icon" onClick={p.onUndo} disabled={!p.canUndo}><Undo2 /></Button></Tip>
      <Tip label="Redo" keys={`${MOD}⇧Z`}><Button variant="ghost" size="icon" onClick={p.onRedo} disabled={!p.canRedo}><Redo2 /></Button></Tip>
      <Separator orientation="vertical" className="mx-1 h-5" />
      <Tip label="Add part (part browser)" keys="A"><Button variant="ghost" size="icon" onClick={p.onAddPart}><Plus /></Button></Tip>
      <div className="hidden items-center gap-0.5 min-[1760px]:flex">
        {QUICK.map(([id, label, key]) => (
          <Tip key={id} label={label} keys={key}>
            <button onClick={() => p.onQuickPlace(id)} className="flex size-8 items-center justify-center rounded-md hover:bg-accent">
              <SymbolThumb sym={getSymbol(id)} className="size-6" pad={2} />
            </button>
          </Tip>
        ))}
      </div>
      <div className="flex-1" />
      {/* simulation controls: rules check · mode · analysis, one group with labels */}
      <div className="flex h-8 shrink-0 items-center rounded-lg border bg-card text-xs">
        <Tip label={p.errors ? "Electrical rules check found problems — click to see them" : "Electrical rules check: no problems — click for details"}>
          <button onClick={p.onShowIssues} className="flex h-full items-center gap-1.5 whitespace-nowrap rounded-l-lg px-2.5 hover:bg-accent">
            {p.errors ? <CircleAlert className="size-3.5 text-destructive" /> : <CircleCheck className="size-3.5 text-success" />}
            <span className={p.errors ? "font-medium text-destructive" : "hidden lg:inline"}>{p.errors ? `${p.errors} error${p.errors > 1 ? "s" : ""}` : "Circuit OK"}</span>
            {p.warnings > 0 && <span className="text-warning">· {p.warnings}</span>}
          </button>
        </Tip>
        <div className="h-4 w-px bg-border" />
        <span className="hidden pl-2.5 pr-1.5 text-muted-foreground 2xl:inline">Mode</span>
        <div className="mx-1 flex items-center rounded-md bg-muted p-0.5 2xl:ml-0">
          {(["realtime", "accurate"] as const).map((m) => (
            <Tip key={m} label={m === "realtime" ? "Live: re-simulates on every edit and animates the result" : "Manual: simulates only when you press Simulate (F5)"}>
              <button onClick={() => p.setMode(m)} className={cn("flex h-6 items-center gap-1.5 whitespace-nowrap rounded px-2", p.mode === m ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground")}>
                {m === "realtime" && <span className={cn("size-1.5 rounded-full", p.mode !== "realtime" ? "bg-muted-foreground/40" : p.running ? "animate-pulse bg-warning" : "bg-success")} />}
                {m === "realtime" ? "Live" : "Manual"}
              </button>
            </Tip>
          ))}
        </div>
        <div className="h-4 w-px bg-border" />
        <span className="hidden pl-2.5 text-muted-foreground 2xl:inline">Analysis</span>
        <Select value={p.analysis} onValueChange={(v) => p.setAnalysis(v as AnalysisType)}>
          <SelectTrigger size="sm" className="h-7 w-40 shrink-0 border-0 bg-transparent text-xs shadow-none focus-visible:ring-0 dark:bg-transparent xl:w-52 [&>span]:truncate"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="tran">Transient · {p.analysisDetail.tran}</SelectItem>
            <SelectItem value="ac">AC sweep · {p.analysisDetail.ac}</SelectItem>
            <SelectItem value="op">Operating point</SelectItem>
            {p.hasDc && <SelectItem value="dc">DC sweep · {p.analysisDetail.dc}</SelectItem>}
          </SelectContent>
        </Select>
        <Tip label="Simulation setup — sweeps, Monte Carlo, measurements"><button onClick={p.onSetup} className="flex h-full items-center rounded-r-lg border-l px-2 text-muted-foreground hover:bg-accent hover:text-foreground"><Settings2 className="size-4" /></button></Tip>
      </div>
      {p.progress && <span className="shrink-0 font-mono text-xs text-warning">{p.progress}</span>}
      {/* fixed width so the buttons next to it never move */}
      <span className="hidden w-24 shrink-0 whitespace-nowrap text-right font-mono text-xs text-muted-foreground xl:inline">{p.clock !== null ? `t = ${formatSI(p.clock, "s", 4)}` : ""}</span>
      <Tip label={p.playing ? "Pause" : p.clock === null ? "Run a transient and play it" : "Play"} keys="Space"><Button variant="ghost" size="icon" onClick={p.onPlayPause} disabled={p.running && !p.playing}>{p.playing ? <Pause /> : <Play />}</Button></Tip>
      <Tip label={p.running ? "Stop the simulation" : "Stop (back to t = 0)"}><Button variant="ghost" size="icon" onClick={p.onStop} disabled={!p.canStop}><Square /></Button></Tip>
      <Button onClick={p.onRun} disabled={p.running} className="ml-1 shrink-0">
        {p.running ? <Loader2 className="animate-spin" /> : <Zap />} Simulate <Kbd className="hidden bg-primary-foreground/15 text-primary-foreground xl:inline-flex">F5</Kbd>
      </Button>
    </div>
  )
}

interface StatusProps {
  text: string; nodes: number; parts: number; ms: number | null; path: string | null; engine: string | null; warnings: number
  step: string | null; hover: string | null; zoom: number
  onStatus?: () => void
}

export function StatusBar({ text, nodes, parts, ms, path, engine, warnings, step, hover, zoom, onStatus }: StatusProps) {
  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 border-t bg-sidebar px-3 text-xs text-muted-foreground">
      <button onClick={onStatus} title="Open the simulation process view" className="flex items-center gap-1.5 rounded px-1 hover:bg-accent hover:text-foreground"><span className={`size-1.5 rounded-full ${/fail|error/i.test(text) ? "bg-destructive" : /simulating/i.test(text) ? "bg-info animate-pulse" : "bg-success"}`} />{text}</button>
      {step && <span className="font-mono">Δt {step}</span>}
      <span className="font-mono">{parts} parts · {nodes} nets</span>
      <span className={`flex items-center gap-1 font-mono ${warnings ? "text-warning" : ""}`}>{warnings > 0 && <TriangleAlert className="size-3.5" />}{warnings} warning{warnings === 1 ? "" : "s"}</span>
      {path && <span className="truncate font-mono">{path}</span>}
      <div className="flex-1" />
      {hover && <span className="font-mono text-foreground">{hover}</span>}
      <div className="flex-1" />
      {ms !== null && <span className="font-mono">solved in {ms < 1 ? "<1" : Math.round(ms)} ms</span>}
      <span className="font-mono">{engine ?? "ngspice not found"}</span>
      <span>Grid 1.27 mm · snap on</span>
      <span className="font-mono">Zoom {zoom}%</span>
    </footer>
  )
}
