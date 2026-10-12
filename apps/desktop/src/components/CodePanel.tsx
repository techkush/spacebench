import { useEffect, useRef, useState, type ReactNode } from "react"
import { CircleAlert, Columns2, FileCode2, PanelLeft, RefreshCw, Sparkles, Spline, WandSparkles } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { Doc } from "@/editor/model"
import type { Netlist } from "@/editor/netlist"
import type { Diagnostic } from "@/kirk/ast"
import { lineCol } from "@/kirk/lexer"
import type { AssertOutcome, MeasureOutcome } from "@/kirk/measure"
import { cn } from "@/lib/utils"
import { KirkEditor } from "./KirkEditor"
import { Splitter } from "./Splitter"

/** AI pane width: dragged by the splitter on its left edge, remembered per viewer. */
const AI_W = 400, AI_MIN = 280, EDITOR_MIN = 200
const savedAiW = () => { try { const v = Number(localStorage.getItem("sb-ai-width")); return v >= AI_MIN ? v : AI_W } catch { return AI_W } }

export type ViewMode = "schematic" | "split" | "code"

interface Props {
  view: ViewMode
  setView: (v: ViewMode) => void
  fileName: string
  dirty: boolean
  code: string
  onChange: (t: string) => void
  diagnostics: Diagnostic[]
  compileMs: number | null
  compiling: boolean
  inSync: boolean
  onFormat: () => void
  onResync: () => void
  doc: Doc
  netlist: Netlist
  values: Record<string, number>
  measures: Record<string, MeasureOutcome>
  asserts: AssertOutcome[]
  ercErrors: number
  onCursorRef: (ref: string | null) => void
  /** the AI assistant panel (shown beside the editor when open) */
  ai?: ReactNode
  aiOpen?: boolean
  onToggleAi?: () => void
}

export function CodePanel(p: Props) {
  const errors = p.diagnostics.filter((d) => d.severity === "error")
  const warnings = p.diagnostics.filter((d) => d.severity === "warning")
  const row = useRef<HTMLDivElement>(null)
  const [aiW, setAiW] = useState(savedAiW)
  const clampAi = (w: number) => Math.round(Math.min(Math.max(w, AI_MIN), Math.max(AI_MIN, (row.current?.clientWidth ?? 1200) - EDITOR_MIN)))
  useEffect(() => { try { localStorage.setItem("sb-ai-width", String(aiW)) } catch { /* private window */ } }, [aiW])
  return (
    <div className="@container flex h-full min-w-0 flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-2">
        <div className="flex min-w-0 items-center gap-2 rounded-md bg-accent px-3 py-1 text-sm" title={p.fileName}>
          <FileCode2 className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{p.fileName}</span>
          {p.dirty && <span className="size-1.5 shrink-0 rounded-full bg-foreground" />}
        </div>
        <div className="flex-1" />
        {p.onToggleAi && (
          <Button size="sm" variant={p.aiOpen ? "secondary" : "outline"} className={cn("h-7 shrink-0", p.aiOpen && "bg-accent")} onClick={p.onToggleAi} title="AI assistant: design, simulate and probe by chat">
            <Sparkles className="text-primary" /><span className="hidden @[420px]:inline">AI</span>
          </Button>
        )}
        <div className="flex shrink-0 items-center rounded-lg bg-muted p-[3px]">
          {([["code", "Code", PanelLeft], ["split", "Split", Columns2], ["schematic", "Schematic", Spline]] as const).map(([v, l, I]) => (
            <button key={v} onClick={() => p.setView(v)} title={l} className={cn("flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-sm", p.view === v ? "bg-background shadow-sm" : "text-muted-foreground")}><I className="size-3.5" /><span className="hidden @[480px]:inline">{l}</span></button>
          ))}
        </div>
      </div>
      <div className="flex h-9 shrink-0 items-center gap-3 overflow-hidden whitespace-nowrap border-b px-3 text-xs">
        {p.compiling ? <Badge variant="secondary">Compiling…</Badge>
          : errors.length ? <Badge variant="secondary" className="bg-destructive-subtle text-destructive">{errors.length} error{errors.length > 1 ? "s" : ""}</Badge>
          : <Badge variant="secondary" className="bg-success-subtle text-success">Compiled{p.compileMs !== null ? ` · ${Math.max(1, Math.round(p.compileMs))} ms` : ""}</Badge>}
        <span className="flex min-w-0 items-center gap-1 text-muted-foreground" title={`Code ⇄ Schematic ${p.inSync ? "in sync" : "out of sync"}`}>
          <span className="hidden truncate @[560px]:inline">Code ⇄ Schematic {p.inSync ? "in sync" : "out of sync"}</span>
          <span className="@[560px]:hidden">{p.inSync ? "⇄ in sync" : "⇄ out of sync"}</span>
          <button onClick={p.onResync} title="Regenerate the code from the schematic" className="rounded p-0.5 hover:bg-accent"><RefreshCw className="size-3.5" /></button>
        </span>
        <div className="flex-1" />
        <span className="hidden font-mono text-muted-foreground @[640px]:inline">{errors.length} errors · {warnings.length} warnings · ERC {p.ercErrors ? "✗" : "✓"}</span>
        <span className="font-mono text-muted-foreground @[640px]:hidden" title={`${errors.length} errors · ${warnings.length} warnings`}>{errors.length}✗ {warnings.length}△</span>
        <Button variant="ghost" size="sm" className="h-7 shrink-0" onClick={p.onFormat} title="Format"><WandSparkles /><span className="hidden @[420px]:inline">Format</span></Button>
      </div>
      {errors.length > 0 && (
        <div className="flex shrink-0 items-start gap-2 border-b bg-destructive-subtle px-3 py-1.5 text-xs text-destructive">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            Line {lineCol(p.code, errors[0].span.from).line}: {errors[0].message} — the schematic shows the last valid version.
          </span>
        </div>
      )}
      <div ref={row} className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <KirkEditor value={p.code} onChange={p.onChange} diagnostics={p.diagnostics} doc={p.doc} netlist={p.netlist} values={p.values} measures={p.measures} asserts={p.asserts} onCursorRef={p.onCursorRef} />
        </div>
        {p.aiOpen && p.ai && (<>
          <Splitter axis="x" onDrag={(d) => setAiW((w) => clampAi(w - d))} onReset={() => setAiW(clampAi(AI_W))} />
          <div className="shrink-0" style={{ width: `min(${aiW}px, calc(100% - ${EDITOR_MIN}px))` }}>{p.ai}</div>
        </>)}
      </div>
    </div>
  )
}
