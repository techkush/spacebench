// Start screen: new / import / open, recent projects with previews,
// examples, Learn Kirk, the part library and the model database.
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  ArrowRight, Box, Cpu, Download, Trash2, File, FileCode2, FolderOpen, FolderPlus, LibraryBig, Layers, Loader2, Microchip, Search, Settings, Sparkles, Spline, X,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Kbd } from "@/components/ui/kbd"
import { ScrollArea } from "@/components/ui/scroll-area"
import { EXAMPLE_CATEGORIES, EXAMPLES, loadExample } from "@/editor/examples"
import { docSymbols, type Doc } from "@/editor/model"
import { CHEAT_SHEET, SNIPPETS } from "@/kirk/snippets"
import { ensureSymbols, getSymbol, loadIndex, loadSymbol, searchIndex, visibleRows, type IndexRow } from "@/lib/kicad"
import { modelCatalog, type ModelEntry } from "@/lib/models"
import { forgetProject, timeAgo, useProjects, type RecentProject } from "@/lib/projects"
import { cn } from "@/lib/utils"
import { ShellBar } from "./Chrome"
import { CircuitThumb } from "./CircuitThumb"
import { SymbolThumb } from "./SymbolView"
import { LibrariesPage } from "./LibrariesPage"
import { TrashPage } from "./TrashPage"
import { useRecentSketches, type RecentSketch } from "@/mcu/recent"

const McuStartPage = lazy(() => import("@/mcu/McuStartPage"))
const RecentSketchCards = lazy(() => import("@/mcu/RecentSketchCards"))

export type StartPage = "home" | "projects" | "examples" | "mcu" | "learn" | "library" | "libraries" | "models" | "trash"
const MOD = navigator.platform.includes("Mac") ? "⌘" : "Ctrl+"
const ANALYSIS: Record<string, string> = { tran: "tran", ac: "AC", op: "op", dc: "DC sweep" }

interface Props {
  page: StartPage
  setPage: (p: StartPage) => void
  dark: boolean
  onToggleTheme: () => void
  engine: string | null
  /** the circuit that is open in the workspace, if any */
  current: { title: string; dirty: boolean } | null
  onResume: () => void
  onNewSchematic: () => void
  onNewFromCode: (code?: string) => void
  onImport: () => void
  onOpen: () => void
  onOpenRecent: (p: RecentProject) => void
  onOpenExample: (id: string) => void
  onPlacePart: (lib: string) => void
  onSettings: () => void
  showAllParts: boolean
  onNewProject: () => void
  onOpenProject: () => void
  /** microcontroller sketches */
  onNewSketch: (boardType: string) => void
  onOpenMcuExample: (id: string) => void
  arduinoCliPath: string
  /** where imported (Fritzing) parts are kept */
  partsRoot: string | null
  listSketches: () => Promise<{ name: string; where: string; open: () => void }[]>
  onOpenSketch: (s: RecentSketch) => void
  /** move to the Trash (a sketch folder, or a project's folder) */
  onDeleteSketch: (s: RecentSketch) => void
  onDeleteProject: (p: RecentProject) => void
  trash: React.ComponentProps<typeof TrashPage>
  /** the Libraries page (the user's component libraries) */
  libraries: Omit<React.ComponentProps<typeof LibrariesPage>, never>
}

const NAV: { id: StartPage | "settings"; label: string; icon: typeof Box }[] = [
  { id: "home", label: "Home", icon: Box },
  { id: "projects", label: "Projects", icon: FolderOpen },
  { id: "examples", label: "Examples", icon: Sparkles },
  { id: "mcu", label: "Microcontrollers", icon: Microchip },
  { id: "learn", label: "Learn Kirk", icon: File },
  { id: "library", label: "Part Library", icon: Cpu },
  { id: "libraries", label: "My Libraries", icon: LibraryBig },
  { id: "models", label: "Model Database", icon: Layers },
  { id: "trash", label: "Trash", icon: Trash2 },
  { id: "settings", label: "Settings", icon: Settings },
]

/** Symbols for a set of documents, loaded once so thumbnails can draw. */
function useDocSymbols(docs: Doc[]) {
  const [, setTick] = useState(0)
  const key = docs.map((d) => d.parts.length).join(",")
  useEffect(() => {
    let live = true
    ensureSymbols(new Set(docs.flatMap((d) => [...docSymbols(d)]))).then(() => live && setTick((t) => t + 1)).catch(() => {})
    return () => { live = false }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
}

export function StartScreen(p: Props) {
  const projects = useProjects()
  const allSketches = useRecentSketches()
  const [index, setIndex] = useState<IndexRow[] | null>(null)
  useEffect(() => { loadIndex().then(setIndex).catch(() => setIndex([])) }, [])
  const simParts = useMemo(() => index?.filter((r) => r.sim).length ?? 0, [index])
  const models = useMemo(() => modelCatalog(), [])
  useDocSymbols(projects.map((x) => x.doc))

  return (
    <div className="flex h-full flex-col bg-background">
      <ShellBar dark={p.dark} onToggleTheme={p.onToggleTheme} onHome={() => p.setPage("home")}
        center={<GlobalSearch projects={projects} index={index} showAll={p.showAllParts} onOpenRecent={p.onOpenRecent} onOpenExample={p.onOpenExample} onPlacePart={p.onPlacePart} />}
        right={p.current && <Button size="sm" variant="outline" className="h-8" onClick={p.onResume}>Back to {p.current.title}{p.current.dirty ? " •" : ""} <ArrowRight /></Button>} />
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-60 shrink-0 flex-col gap-0.5 border-r bg-sidebar p-3">
          {NAV.map((n) => (
            <button key={n.id} onClick={() => (n.id === "settings" ? p.onSettings() : p.setPage(n.id))}
              className={cn("flex h-9 items-center gap-2.5 rounded-md px-2.5 text-left text-sm transition-colors hover:bg-accent", p.page === n.id && "bg-accent font-medium")}>
              <n.icon className="size-4 text-muted-foreground" /> {n.label}
            </button>
          ))}
          <div className="flex-1" />
          <div className="flex flex-col gap-1.5 rounded-lg border bg-card p-3 text-xs">
            <Status ok={!!p.engine} label="Solver" value={p.engine ?? "not found"} />
            <Status ok={!!index?.length} label="Library" value={index ? `${simParts.toLocaleString()} parts` : "loading…"} />
            <Status ok label="Models" value={`${models.length} models`} />
          </div>
        </nav>
        <ScrollArea className="min-h-0 min-w-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
          <main className="mx-auto max-w-[1680px] px-12 py-10">
            {p.page === "home" && <Home {...p} projects={projects} />}
            {p.page === "projects" && <Projects projects={projects} onOpen={p.onOpenRecent} onOpenFile={p.onOpen} onImport={p.onImport} onDelete={p.onDeleteProject} />}
            {p.page === "examples" && <Examples onOpen={p.onOpenExample} big />}
            {p.page === "mcu" && <Suspense fallback={<Loader2 className="size-5 animate-spin text-muted-foreground" />}><McuStartPage dark={p.dark} onNew={p.onNewSketch} onOpenExample={p.onOpenMcuExample} cliPath={p.arduinoCliPath} onSettings={p.onSettings} listSketches={p.listSketches} partsRoot={p.partsRoot} recent={allSketches.length ? <RecentSketchCards list={allSketches} dark={p.dark} onOpen={p.onOpenSketch} onDelete={p.onDeleteSketch} /> : undefined} /></Suspense>}
            {p.page === "learn" && <Learn onOpen={p.onNewFromCode} />}
            {p.page === "library" && <Library index={index} showAll={p.showAllParts} onPlace={p.onPlacePart} />}
            {p.page === "libraries" && <LibrariesPage {...p.libraries} />}
            {p.page === "models" && <Models models={models} index={index} />}
            {p.page === "trash" && <TrashPage {...p.trash} />}
          </main>
        </ScrollArea>
      </div>
    </div>
  )
}

function Status({ ok, label, value }: { ok: boolean; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className={cn("size-1.5 rounded-full", ok ? "bg-success" : "bg-destructive")} />
      <span className="font-medium">{label}</span>
      <span className="ml-auto truncate text-muted-foreground">{value}</span>
    </div>
  )
}

function PageHead({ title, desc, children }: { title: string; desc?: string; children?: ReactNode }) {
  return (
    <div className="mb-8 flex items-end gap-4">
      <div className="flex-1">
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        {desc && <p className="mt-2 text-muted-foreground">{desc}</p>}
      </div>
      {children}
    </div>
  )
}

function SectionHead({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="mb-4 mt-10 flex items-center gap-3"><h2 className="flex-1 text-lg font-semibold">{title}</h2>{children}</div>
}

// ---------------------------------------------------------------- home

function greeting() {
  const h = new Date().getHours()
  return h < 5 ? "Good evening" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"
}

function Home(p: Props & { projects: RecentProject[] }) {
  const sketches = useRecentSketches()
  const actions = [
    { icon: FolderPlus, title: "New project", desc: "A folder for circuits, boards, libraries and results", keys: `${MOD}⇧P`, onClick: p.onNewProject },
    { icon: Spline, title: "New schematic", desc: "Blank sheet with the KiCad library", keys: `${MOD}N`, onClick: p.onNewSchematic },
    { icon: FileCode2, title: "New from code", desc: "Write Kirk, the schematic draws itself", keys: `${MOD}⇧N`, onClick: () => p.onNewFromCode() },
    { icon: Microchip, title: "New Arduino sketch", desc: "Code, wire and run a microcontroller", keys: `${MOD}⇧A`, onClick: () => p.onNewSketch("wokwi-arduino-uno") },
    { icon: FolderOpen, title: "Open project", desc: "A project folder (.sbproj)", keys: `${MOD}O`, onClick: p.onOpenProject },
    { icon: Download, title: "Import", desc: "Kirk (.kirk) · KiCad (.kicad_sch) · netlists (.cir) · .sbc", keys: `${MOD}I`, onClick: p.onImport },
  ]
  return (
    <>
      <h1 className="text-[32px] font-semibold leading-tight tracking-tight">{greeting()}</h1>
      <p className="mt-2 text-muted-foreground">Design, simulate and measure circuits — by drawing or by writing Kirk code.</p>
      <div className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-3 2xl:grid-cols-6">
        {actions.map((a, i) => (
          <button key={a.title} onClick={a.onClick}
            className={cn("group flex flex-col rounded-xl border p-4 text-left transition-colors", i === 0 ? "border-primary bg-primary text-primary-foreground hover:bg-primary/90" : "bg-card hover:border-ring")}>
            <div className="flex items-start">
              <span className={cn("flex size-8 items-center justify-center rounded-md border", i === 0 ? "border-transparent bg-primary-foreground text-primary" : "bg-background")}><a.icon className="size-4" /></span>
              <div className="flex-1" />
              <Kbd className={i === 0 ? "bg-primary-foreground/15 text-primary-foreground" : ""}>{a.keys}</Kbd>
            </div>
            <span className="mt-5 text-[15px] font-medium">{a.title}</span>
            <span className={cn("mt-2 text-sm", i === 0 ? "text-primary-foreground/70" : "text-muted-foreground")}>{a.desc}</span>
          </button>
        ))}
      </div>
      <SectionHead title="Recent projects">
        {p.projects.length > 4 && <Button variant="ghost" size="sm" onClick={() => p.setPage("projects")}>View all</Button>}
      </SectionHead>
      {p.projects.length ? (
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          {p.projects.slice(0, 4).map((x) => <ProjectCard key={x.id} p={x} onOpen={() => p.onOpenRecent(x)} onDelete={x.folder ? () => p.onDeleteProject(x) : undefined} />)}
        </div>
      ) : (
        <div className="flex h-40 flex-col items-center justify-center gap-1 rounded-xl border border-dashed text-sm text-muted-foreground">
          <span>No recent projects yet.</span>
          <span>Start a new schematic, or open an example below.</span>
        </div>
      )}
      {sketches.length > 0 && (
        <>
          <SectionHead title="Recent sketches">
            <Button variant="ghost" size="sm" onClick={() => p.setPage("mcu")}>All sketches</Button>
          </SectionHead>
          <Suspense fallback={<Loader2 className="size-5 animate-spin text-muted-foreground" />}><RecentSketchCards list={sketches.slice(0, 4)} dark={p.dark} onOpen={p.onOpenSketch} onDelete={p.onDeleteSketch} /></Suspense>
        </>
      )}
      <Examples onOpen={p.onOpenExample} limit={6} />
    </>
  )
}

function ProjectCard({ p, onOpen, onForget, onDelete }: { p: RecentProject; onOpen: () => void; onForget?: () => void; onDelete?: () => void }) {
  return (
    <div role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => e.key === "Enter" && onOpen()}
      className="group relative flex cursor-pointer flex-col overflow-hidden rounded-xl border bg-card text-left transition-colors hover:border-ring">
      <div className="flex h-[150px] items-center justify-center border-b bg-canvas p-3">
        <CircuitThumb doc={p.doc} className="h-full w-full" />
      </div>
      <div className="flex flex-col gap-1 p-3">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{p.title}</span>
          <div className="flex-1" />
          <Badge variant="secondary" className={p.simulated ? "bg-success-subtle text-success" : ""}>{p.simulated ? "Simulated" : p.path ? "Saved" : "Draft"}</Badge>
        </div>
        <span className="truncate text-xs text-muted-foreground">{timeAgo(p.time)} · {p.parts} part{p.parts === 1 ? "" : "s"} · {ANALYSIS[p.analysis] ?? p.analysis}{p.path ? ` · ${p.path.split("/").pop()}` : ""}</span>
      </div>
      {onDelete && (
        <button title="Delete the project (moves its folder to the Trash)" onClick={(e) => { e.stopPropagation(); onDelete() }}
          className="absolute right-9 top-2 hidden rounded-md border bg-background p-1 text-muted-foreground hover:text-destructive group-hover:block"><Trash2 className="size-3.5" /></button>
      )}
      {onForget && (
        <button title="Remove from the list" onClick={(e) => { e.stopPropagation(); onForget() }}
          className="absolute right-2 top-2 hidden rounded-md border bg-background p-1 text-muted-foreground hover:text-foreground group-hover:block"><X className="size-3.5" /></button>
      )}
    </div>
  )
}

function Projects({ projects, onOpen, onOpenFile, onImport, onDelete }: { projects: RecentProject[]; onOpen: (p: RecentProject) => void; onOpenFile: () => void; onImport: () => void; onDelete?: (p: RecentProject) => void }) {
  const [q, setQ] = useState("")
  const shown = projects.filter((p) => !q || `${p.title} ${p.path ?? ""}`.toLowerCase().includes(q.toLowerCase()))
  return (
    <>
      <PageHead title="Projects" desc="Circuits you opened or saved recently. Drafts are kept until you remove them.">
        <Button variant="outline" onClick={onImport}><Download /> Import</Button>
        <Button onClick={onOpenFile}><FolderOpen /> Open…</Button>
      </PageHead>
      <div className="relative mb-6 w-80"><Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" /><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter projects" className="pl-8" /></div>
      {shown.length ? (
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          {shown.map((x) => <ProjectCard key={x.id} p={x} onOpen={() => onOpen(x)} onForget={() => forgetProject(x.id)} onDelete={x.folder && onDelete ? () => onDelete(x) : undefined} />)}
        </div>
      ) : <p className="text-sm text-muted-foreground">{projects.length ? "No project matches." : "No recent projects yet."}</p>}
    </>
  )
}

// ---------------------------------------------------------------- examples

function Examples({ onOpen, limit, big }: { onOpen: (id: string) => void; limit?: number; big?: boolean }) {
  const [cat, setCat] = useState<string>("All")
  const [docs, setDocs] = useState<Record<string, Doc>>({})
  useEffect(() => {
    if (!big) { ensureSymbols(EXAMPLES.map((e) => e.icon)).then(() => setDocs({})).catch(() => {}); return }
    let live = true
    for (const e of EXAMPLES) loadExample(e.id).then((d) => live && setDocs((x) => ({ ...x, [e.id]: d }))).catch(() => {})
    return () => { live = false }
  }, [big])
  const list = EXAMPLES.filter((e) => cat === "All" || e.category === cat)
  const chips = (
    <div className="flex flex-wrap gap-1.5">
      {["All", ...EXAMPLE_CATEGORIES].map((c) => (
        <button key={c} onClick={() => setCat(c)} className={cn("h-7 rounded-full border px-3 text-xs transition-colors", cat === c ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-accent")}>{c}</button>
      ))}
    </div>
  )
  if (big) {
    return (
      <>
        <PageHead title="Examples" desc="Ready-to-simulate circuits built from KiCad parts. Open one to explore, edit and simulate it.">{chips}</PageHead>
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          {list.map((e) => (
            <button key={e.id} onClick={() => onOpen(e.id)} className="flex flex-col overflow-hidden rounded-xl border bg-card text-left transition-colors hover:border-ring">
              <div className="flex h-[170px] items-center justify-center border-b bg-canvas p-3">
                {docs[e.id] ? <CircuitThumb doc={docs[e.id]} className="h-full w-full" /> : <Loader2 className="size-5 animate-spin text-muted-foreground" />}
              </div>
              <div className="flex flex-col gap-1 p-3">
                <div className="flex items-center gap-2"><span className="text-sm font-medium">{e.title}</span><div className="flex-1" /><Badge variant="outline" className="font-normal">{e.category}</Badge></div>
                <span className="line-clamp-2 text-xs text-muted-foreground">{e.description}</span>
              </div>
            </button>
          ))}
        </div>
      </>
    )
  }
  return (
    <>
      <SectionHead title="Examples">{chips}</SectionHead>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-6">
        {list.slice(0, limit).map((e) => (
          <button key={e.id} onClick={() => onOpen(e.id)} className="flex items-center gap-3 rounded-xl border bg-card p-3 text-left transition-colors hover:border-ring">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-md border bg-canvas"><SymbolThumb sym={getSymbol(e.icon)} className="size-8" pad={4} /></span>
            <span className="min-w-0"><span className="block truncate text-sm font-medium">{e.title}</span><span className="block text-xs text-muted-foreground">{e.category}</span></span>
          </button>
        ))}
      </div>
    </>
  )
}

// ---------------------------------------------------------------- learn Kirk

function Learn({ onOpen }: { onOpen: (code?: string) => void }) {
  return (
    <>
      <PageHead title="Learn Kirk" desc="Kirk describes a circuit as text: parts, how they connect, what to simulate and what to measure. The schematic and the code stay in sync both ways.">
        <Button onClick={() => onOpen()}><FileCode2 /> New from code</Button>
      </PageHead>
      <div className="rounded-xl border bg-card">
        <div className="border-b px-5 py-3 text-sm font-medium">Cheat sheet</div>
        <div className="divide-y">
          {CHEAT_SHEET.map(([code, what]) => (
            <div key={code} className="flex items-baseline gap-6 px-5 py-2.5">
              <code className="w-[340px] shrink-0 font-mono text-[13px]">{code}</code>
              <span className="text-sm text-muted-foreground">{what}</span>
            </div>
          ))}
        </div>
      </div>
      <SectionHead title="Start from a program" />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {SNIPPETS.map((s) => (
          <div key={s.id} className="flex flex-col overflow-hidden rounded-xl border bg-card">
            <div className="flex items-start gap-3 p-4">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{s.title}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">{s.summary}</div>
                <div className="mt-2 flex flex-wrap gap-1">{s.teaches.map((t) => <Badge key={t} variant="outline" className="font-normal">{t}</Badge>)}</div>
              </div>
              <Button size="sm" variant="outline" onClick={() => onOpen(s.code)}>Open in editor <ArrowRight /></Button>
            </div>
            <pre className="max-h-64 overflow-auto border-t bg-muted/50 px-4 py-3 font-mono text-[12px] leading-relaxed">{s.code}</pre>
          </div>
        ))}
      </div>
    </>
  )
}

// ---------------------------------------------------------------- part library

function Library({ index, showAll, onPlace }: { index: IndexRow[] | null; showAll: boolean; onPlace: (lib: string) => void }) {
  const [q, setQ] = useState("")
  const [sel, setSel] = useState<IndexRow | null>(null)
  const [, setTick] = useState(0)
  const rows = useMemo(() => (index ? (q.trim() ? searchIndex(visibleRows(index, showAll), q, 120) : visibleRows(index, showAll).slice(0, 120)) : []), [index, q, showAll])
  useEffect(() => {
    let live = true
    Promise.all(rows.slice(0, 48).map((r) => loadSymbol(`${r.lib}:${r.name}`).catch(() => null))).then(() => live && setTick((t) => t + 1))
    return () => { live = false }
  }, [rows])
  const pick = sel ?? rows[0] ?? null
  const sym = pick ? getSymbol(`${pick.lib}:${pick.name}`) : undefined
  return (
    <>
      <PageHead title="Part Library" desc={`${index ? visibleRows(index, showAll).length.toLocaleString() : "…"} ${showAll ? "KiCad symbols" : "simulation-ready KiCad parts"}. Place one to start a new circuit with it.`} />
      <div className="relative mb-4 w-[420px]"><Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" /><Input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setSel(null) }} placeholder="Search parts: 2N3904, op-amp, 555, regulator…" className="pl-8" /></div>
      <div className="flex h-[640px] gap-4">
        <div className="min-w-0 flex-1 overflow-auto rounded-xl border bg-card">
          {!index ? <div className="flex h-full items-center justify-center"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div> : (
            <div className="divide-y">
              {rows.map((r) => {
                const id = `${r.lib}:${r.name}`
                return (
                  <button key={id} onClick={() => setSel(r)} onDoubleClick={() => onPlace(id)}
                    className={cn("flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-accent/60", pick === r && "bg-accent")}>
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-canvas"><SymbolThumb sym={getSymbol(id)} className="size-7" pad={4} /></span>
                    <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{r.name}</span><span className="block truncate text-xs text-muted-foreground">{r.desc || r.keywords}</span></span>
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{r.lib}</span>
                  </button>
                )
              })}
              {!rows.length && <p className="p-6 text-sm text-muted-foreground">No part matches “{q}”.</p>}
            </div>
          )}
        </div>
        <div className="flex w-[380px] shrink-0 flex-col rounded-xl border bg-card">
          {pick ? (
            <>
              <div className="flex h-56 items-center justify-center border-b bg-canvas p-4"><SymbolThumb sym={sym} className="h-full w-full" /></div>
              <div className="flex flex-1 flex-col gap-2 p-4">
                <div className="flex items-center gap-2"><span className="font-medium">{pick.name}</span>{pick.sim ? <Badge variant="secondary" className="bg-success-subtle text-success">Simulates</Badge> : <Badge variant="outline">No model yet</Badge>}</div>
                <span className="font-mono text-xs text-muted-foreground">{pick.lib}:{pick.name} · {pick.ref}{pick.units > 1 ? ` · ${pick.units} units` : ""}</span>
                <p className="text-sm text-muted-foreground">{pick.desc}</p>
                {pick.keywords && <p className="text-xs text-muted-foreground">Keywords: {pick.keywords}</p>}
                <div className="flex-1" />
                <Button onClick={() => onPlace(`${pick.lib}:${pick.name}`)}><Spline /> Place in a new circuit</Button>
              </div>
            </>
          ) : <p className="p-6 text-sm text-muted-foreground">Select a part.</p>}
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------- model database

/** Generic KiCad symbol per model type (when there is no symbol for the exact part). */
const KIND_SYMBOL: Record<string, string> = {
  "BJT NPN": "Device:Q_NPN", NPN: "Device:Q_NPN", "BJT PNP": "Device:Q_PNP", PNP: "Device:Q_PNP",
  "N-MOSFET": "Device:Q_NMOS", NMOS: "Device:Q_NMOS", "P-MOSFET": "Device:Q_PMOS", PMOS: "Device:Q_PMOS",
  "N-JFET": "Device:Q_NJFET_DSG", NJFET: "Device:Q_NJFET_DSG", "P-JFET": "Device:Q_PJFET_DSG", PJFET: "Device:Q_PJFET_DSG",
  Diode: "Device:D", "Schottky diode": "Device:D_Schottky", "Rectifier diode": "Diode:1N4007", "Zener diode": "Device:D_Zener", LED: "Device:LED",
  "Op-amp": "Simulation_SPICE:OPAMP", Timer: "Timer:NE555P", Regulator: "Regulator_Linear:L7805",
}
const SYMBOL_LIBS = ["Transistor_BJT", "Transistor_FET", "Diode", "LED", "Amplifier_Operational", "Timer", "Regulator_Linear"]

/** Symbols to try for a model, best first: the exact part in the KiCad library, then the type's generic one. */
function symbolCandidates(m: ModelEntry, index: IndexRow[] | null): string[] {
  const exact = index?.filter((r) => SYMBOL_LIBS.includes(r.lib) && (r.name === m.name || r.name.startsWith(`${m.name}_`))).map((r) => `${r.lib}:${r.name}`) ?? []
  const special = /LM317/.test(m.name) ? ["Regulator_Linear:LM317_TO-220"] : /79xx|Negative/.test(m.name) ? ["Regulator_Linear:L7905", "Regulator_Linear:LM7905_TO220"] : []
  return [...exact, ...special, KIND_SYMBOL[m.kind]].filter(Boolean)
}

/** The model's schematic symbol, loaded on demand. */
function ModelSymbol({ m, index }: { m: ModelEntry; index: IndexRow[] | null }) {
  const [id, setId] = useState<string | null>(null)
  const ids = symbolCandidates(m, index)
  const key = ids.join("|")
  useEffect(() => {
    let live = true
    setId(null)
    ;(async () => {
      for (const c of ids) { try { await loadSymbol(c); if (live) setId(c); return } catch { /* try the next one */ } }
    })()
    return () => { live = false }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  const sym = id ? getSymbol(id) : undefined
  return (
    <div className="flex items-center gap-4 border-b bg-canvas p-4">
      <div className="flex h-32 w-32 shrink-0 items-center justify-center rounded-lg border bg-background">
        {sym ? <SymbolThumb sym={sym} className="h-full w-full" pad={6} /> : <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      </div>
      {sym && <div className="min-w-0 text-xs text-muted-foreground"><div className="font-mono text-foreground">{id}</div><div className="mt-1 line-clamp-3">{sym.desc || "KiCad symbol"}</div>{id === KIND_SYMBOL[m.kind] && !id.endsWith(`:${m.name}`) && <div className="mt-1">Generic {m.kind} symbol</div>}</div>}
    </div>
  )
}

function Models({ models, index }: { models: ModelEntry[]; index: IndexRow[] | null }) {
  const [q, setQ] = useState("")
  const [kind, setKind] = useState("All")
  const [sel, setSel] = useState<ModelEntry | null>(null)
  const kinds = useMemo(() => ["All", ...new Set(models.map((m) => m.kind))], [models])
  const shown = models.filter((m) => (kind === "All" || m.kind === kind) && (!q || `${m.name} ${m.kind}`.toLowerCase().includes(q.toLowerCase())))
  const pick = sel && shown.includes(sel) ? sel : shown[0] ?? null
  return (
    <>
      <PageHead title="Model Database" desc="The SPICE models Space Bench uses. Parts pick a datasheet model by their value (2N3904, 1N4148…), otherwise a generic model of the right type." />
      <div className="mb-4 flex items-center gap-3">
        <div className="relative w-80"><Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" /><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search models" className="pl-8" /></div>
        <div className="flex flex-wrap gap-1.5">
          {kinds.map((k) => <button key={k} onClick={() => setKind(k)} className={cn("h-7 rounded-full border px-3 text-xs", kind === k ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-accent")}>{k}</button>)}
        </div>
      </div>
      <div className="flex h-[620px] gap-4">
        <div className="min-w-0 flex-1 overflow-auto rounded-xl border bg-card">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted text-xs text-muted-foreground"><tr><th className="px-3 py-2 text-left font-medium">Model</th><th className="px-3 py-2 text-left font-medium">Type</th><th className="px-3 py-2 text-left font-medium">Source</th></tr></thead>
            <tbody className="divide-y">
              {shown.map((m) => (
                <tr key={m.name} onClick={() => setSel(m)} className={cn("cursor-pointer hover:bg-accent/60", pick === m && "bg-accent")}>
                  <td className="px-3 py-2 font-mono text-xs">{m.name}</td><td className="px-3 py-2 text-xs">{m.kind}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{m.source === "datasheet" ? "Datasheet" : m.source === "generic" ? "Generic" : "Behavioural"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex w-[460px] shrink-0 flex-col rounded-xl border bg-card">
          {pick ? (
            <>
              <div className="border-b p-4"><div className="font-medium">{pick.name}</div><div className="text-xs text-muted-foreground">{pick.kind} · {pick.source}</div></div>
              <ModelSymbol m={pick} index={index} />
              <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all p-4 font-mono text-[12px] leading-relaxed">{pick.model.includes("\n") ? pick.model : `.model ${pick.name.replace(/\s+/g, "_")} ${pick.model}`}</pre>
            </>
          ) : <p className="p-6 text-sm text-muted-foreground">No model matches.</p>}
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------- ⌘K search

function GlobalSearch({ projects, index, showAll, onOpenRecent, onOpenExample, onPlacePart }: {
  projects: RecentProject[]; index: IndexRow[] | null; showAll: boolean
  onOpenRecent: (p: RecentProject) => void; onOpenExample: (id: string) => void; onPlacePart: (lib: string) => void
}) {
  const [q, setQ] = useState("")
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(0)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); ref.current?.focus(); setOpen(true) } }
    window.addEventListener("keydown", k)
    return () => window.removeEventListener("keydown", k)
  }, [])
  const t = q.trim().toLowerCase()
  const items = useMemo(() => {
    if (!t) return []
    const out: { group: string; label: string; sub: string; run: () => void }[] = []
    for (const p of projects.filter((p) => p.title.toLowerCase().includes(t)).slice(0, 4)) out.push({ group: "Projects", label: p.title, sub: timeAgo(p.time), run: () => onOpenRecent(p) })
    for (const e of EXAMPLES.filter((e) => `${e.title} ${e.category} ${e.description}`.toLowerCase().includes(t)).slice(0, 4)) out.push({ group: "Examples", label: e.title, sub: e.category, run: () => onOpenExample(e.id) })
    if (index) for (const r of searchIndex(visibleRows(index, showAll), q, 6)) out.push({ group: "Parts", label: r.name, sub: `${r.lib} · place in a new circuit`, run: () => onPlacePart(`${r.lib}:${r.name}`) })
    return out
  }, [t, q, projects, index, showAll, onOpenRecent, onOpenExample, onPlacePart])
  const go = (i: number) => { const it = items[i]; if (it) { setOpen(false); setQ(""); it.run() } }
  return (
    <div className="relative w-[360px]">
      <Search className="absolute left-2.5 top-2 size-4 text-muted-foreground" />
      <input ref={ref} value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); setHi(0) }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(h + 1, items.length - 1)) }
          else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)) }
          else if (e.key === "Enter") go(hi)
          else if (e.key === "Escape") { setOpen(false); setQ(""); ref.current?.blur() }
        }}
        placeholder="Search projects, examples, parts…" className="h-8 w-full rounded-md border bg-background pl-8 pr-12 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40" />
      <Kbd className="pointer-events-none absolute right-2 top-1.5">{MOD}K</Kbd>
      {open && t && (
        <div className="absolute left-0 right-0 top-10 z-50 overflow-hidden rounded-lg border bg-popover shadow-lg">
          {items.length ? items.map((it, i) => (
            <div key={`${it.group}${it.label}${i}`}>
              {(i === 0 || items[i - 1].group !== it.group) && <div className="px-3 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">{it.group}</div>}
              <button onMouseDown={(e) => { e.preventDefault(); go(i) }} onMouseEnter={() => setHi(i)} className={cn("flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm", i === hi && "bg-accent")}>
                <span className="truncate">{it.label}</span><span className="ml-auto truncate text-xs text-muted-foreground">{it.sub}</span>
              </button>
            </div>
          )) : <div className="px-3 py-3 text-sm text-muted-foreground">Nothing matches “{q}”.</div>}
        </div>
      )}
    </div>
  )
}

