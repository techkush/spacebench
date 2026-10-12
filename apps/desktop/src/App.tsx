import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Loader2 } from "lucide-react"
import { isTauri } from "@tauri-apps/api/core"
import { ask } from "@tauri-apps/plugin-dialog"
import { toast } from "sonner"

import { StatusBar, TitleBar, Toolbar, type AnalysisType, type SimMode, type ToolKind } from "@/components/Chrome"
import { StartScreen, type StartPage } from "@/components/StartScreen"
import { SettingsView, type SettingsSection } from "@/components/SettingsView"
import { CHANNEL_COLORS, InstrumentDock } from "@/components/InstrumentDock"
import { Inspector } from "@/components/Inspector"
import { CodePanel, type ViewMode } from "@/components/CodePanel"
import { PartBrowser } from "@/components/PartBrowser"
import { Splitter } from "@/components/Splitter"
import { ExamplesDialog } from "@/components/ExamplesDialog"
import { AnalysisView } from "@/components/AnalysisView"
import { ErrorBoundary } from "@/components/ErrorBoundary"
import { ExportDialog } from "@/components/ExportDialog"
import type { ResultSet } from "@/lib/results"
import { buildReport } from "@/lib/report"
import { SimulationSetup, type SetupPatch, type SetupSection } from "@/components/SimulationSetup"
import { LIBRARY, PartsSidebar } from "@/components/PartsSidebar"
import { SchematicEditor, type HoverInfo, type Overlays, type ProbeFlag, type Tool } from "@/components/SchematicEditor"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { loadExample } from "@/editor/examples"
import { outputKind, outputState } from "@/editor/outputs"
import { playOutputs, stopOutputs } from "@/lib/sound"
import { openDoc, pickImport, readDoc, saveDoc, saveExport } from "@/editor/file"
import { useHistory } from "@/editor/history"
import { defaultPart, docSymbols, emptyDoc, isLabel, isVirtual, nextRef, uid, type Doc, type Part, type Pt, type Rot } from "@/editor/model"
import { deriveNetlist } from "@/editor/netlist"
import { wireCurrents } from "@/editor/flow"
import { addPart, addWirePath, deleteSelection, duplicateSelection, emptySelection, mirrorParts, rotateParts, toggleNoConnect, updatePart, type Selection } from "@/editor/ops"
import { finalValues, haltRun, ngspiceVersion, setEngineOptions, simulate, type AcResult, type JobResult } from "@/lib/engine"
import { ensureSymbols, getSymbol, loadIndex, loadSymbol, searchIndex, unitLetter, visibleRows } from "@/lib/kicad"
import { AiChat, clearChat } from "@/components/AiChat"
import { LibraryEditor } from "@/components/LibraryEditor"
import { NewProjectDialog, type NewProjectRequest } from "@/components/NewProjectDialog"
import { ProjectPanel } from "@/components/ProjectPanel"
import { refreshVariants } from "@/kirk/components"
import { copyIntoProject } from "@/lib/libraries"
import { createProject, loadCircuit, newCircuit, newLibraryFile, openProject, projectResolver, projectTree, saveCircuit, type Project, type TreeNode } from "@/lib/project"
import { appFS, dirName, homeFolders, join as joinPath } from "@/lib/projectfs"
import { MCU_EXAMPLES, blankSketch } from "@/mcu/examples"
import { loadSketch, newSketch, saveSketch, sketchFolderOf } from "@/mcu/sketchfs"
import { forgetSketch, rememberSketch, type RecentSketch } from "@/mcu/recent"
import { boardByType, isBoardType } from "@/mcu/boards"
import { moveToTrash, restoreFromTrash, type TrashItem } from "@/lib/trash"
import type { SketchDoc } from "@/mcu/McuWorkspace"
const McuWorkspace = lazy(() => import("@/mcu/McuWorkspace").then((m) => ({ default: m.McuWorkspace })))
import { inputKind, isClosed, potPos, setClosed, setPotPos } from "@/editor/inputs"
import { resolveFeeds, sensorSignal } from "@/lib/feeds"
import { labChannel, openLabWindow } from "@/lib/labLink"
import { QUANTITIES } from "@/lib/sensors"
import { isSensor, senseOf } from "@/editor/inputs"
import type { AgentHost } from "@/lib/ai/agent"
import { summarizeResult } from "@/lib/ai/summary"
import { usePlayback, valuesAt } from "@/lib/playback"
import { FirmwarePanel } from "@/components/FirmwarePanel"
import { boardParts, isProgrammable } from "@/cosim/boards"
import { firmwareOf, useCoSim } from "@/cosim/useCoSim"
import { usePermission } from "@/components/PermissionDialog"
import { checkSetup, installSetup } from "@/mcu/setup"
import { buildNetlist, resolveSim, setSolverOptions } from "@/lib/spice"
import { explainFailure, refsInMessage, stamp, startRun, type RunHandle, type SpanStatus } from "@/lib/runlog"
import { RunView } from "@/components/RunView"
import { InstrumentsPanel } from "@/components/Instruments"
import { PcbView } from "@/components/PcbView"
import { addFrame, getRecorder } from "@/lib/recorder"
import { readGen, shapeOf } from "@/lib/fgen"
import { forgetProject, getProjects, rememberProject, type RecentProject } from "@/lib/projects"
import { getSettings, resolvedDark, setSettings, useSettings } from "@/lib/settings"
import { parseSI } from "@/lib/units"
import { spiceToKirk } from "@/kirk/fromSpice"
import { importKicadSch, isKicadSch } from "@/kicad/schImport"
import { exportKicadSch } from "@/kicad/schExport"
import { NEW_FROM_CODE } from "@/kirk/snippets"
import { runAsserts, runMeasures, type AssertOutcome, type MeasureOutcome } from "@/kirk/measure"
import type { Diagnostic as KirkDiagnostic } from "@/kirk/ast"
import { compileKirk } from "@/kirk/compile"
import { generateKirk } from "@/kirk/generate"
import { planRuns, runAll, type RunControl, type RunOutcome } from "@/lib/runs"
import { formatSI } from "@/lib/units"

/** Theme from Settings (light / dark / system); the title-bar button picks light or dark explicitly. */
function useTheme() {
  const pref = useSettings().theme
  const [sys, setSys] = useState(() => resolvedDark("system"))
  useEffect(() => {
    try {
      const mq = matchMedia("(prefers-color-scheme: dark)")
      const on = () => setSys(mq.matches)
      mq.addEventListener("change", on)
      return () => mq.removeEventListener("change", on)
    } catch { return undefined }
  }, [])
  const dark = pref === "system" ? sys : pref === "dark"
  // switch the class during render, so everything re-rendering for the new theme reads the new colours
  if (document.documentElement.classList.contains("dark") !== dark) document.documentElement.classList.toggle("dark", dark)
  return [dark, () => { document.documentElement.classList.toggle("dark", !dark); setSettings({ theme: dark ? "light" : "dark" }) }] as const
}

function useRecent() {
  const [recent, setRecent] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("sb-recent-parts") ?? "[]") } catch { return [] }
  })
  const push = (id: string) => setRecent((r) => {
    if (r[0] === id) return r
    const next = [id, ...r.filter((x) => x !== id)].slice(0, 24)
    try { localStorage.setItem("sb-recent-parts", JSON.stringify(next)) } catch { /* storage unavailable */ }
    return next
  })
  return [recent, push] as const
}

/** A pane size remembered between sessions. */
function usePaneSize(key: string, initial: number) {
  const [v, setV] = useState(() => { try { const n = Number(localStorage.getItem(key)); return n > 0 ? n : initial } catch { return initial } })
  useEffect(() => { try { localStorage.setItem(key, String(Math.round(v))) } catch { /* storage unavailable */ } }, [key, v])
  return [v, setV] as const
}
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

function useShowAllParts() {
  const [v, setV] = useState(() => { try { return localStorage.getItem("sb-show-all-parts") === "1" } catch { return false } })
  const set = (x: boolean) => { setV(x); try { localStorage.setItem("sb-show-all-parts", x ? "1" : "0") } catch { /* storage unavailable */ } }
  return [v, set] as const
}

interface Placing { lib: string; unit: number; ref: string | null }

export default function App() {
  const [dark, toggleTheme] = useTheme()
  const settings = useSettings()
  // full-screen views: Start screen, workspace, Settings
  const [screen, setScreen] = useState<"start" | "work" | "settings" | "library" | "mcu">(() => (getSettings().openOnLaunch === "start" ? "start" : "work"))
  const [settingsFrom, setSettingsFrom] = useState<"start" | "work" | "mcu">("start")
  const [startPage, setStartPage] = useState<StartPage>("home")
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general")
  /** a circuit is open in the workspace (the Start screen offers "Back to …") */
  const [hasDoc, setHasDoc] = useState(false)
  const projectId = useRef(uid("prj"))
  const menuRef = useRef({ home: () => {}, import: () => {}, settings: () => {} })
  const simulatedRef = useRef(false)
  const [recent, pushRecent] = useRecent()
  const [showAllParts, setShowAllParts] = useShowAllParts()
  const history = useHistory<Doc>(emptyDoc())
  const { doc, commit } = history
  /** the Room tab edits the circuit live: a drag is one undo step, a momentary button none */
  const roomEdit = useMemo(() => ({
    preview: (d: Doc) => { history.begin(); history.replace(d) },
    end: history.end, cancel: history.cancel, commit: history.commit,
  }), [history.begin, history.replace, history.end, history.cancel, history.commit])
  const replacePart = (d: Doc, ref: string, next: Part): Doc => ({ ...d, parts: d.parts.map((q) => (q.ref === ref ? { ...next, id: q.id, unit: q.unit, x: q.x, y: q.y, rot: q.rot, mirror: q.mirror } : q)) })
  const chipFeeds = useMemo(() => resolveFeeds(doc, doc.analyses.tran.stop).feeds, [doc])
  const inputChips = {
    reading: (part: Part) => {
      const kind = inputKind(part)
      if (!isSensor(kind)) return null
      const sense = senseOf(kind), sig = sensorSignal(chipFeeds, part.ref, sense), qi = QUANTITIES[sense]
      const text = `${qi.icon} ${qi.show(sig ? sig.at(0) : qi.base)}`
      return sig && !sig.constant ? `${text} ∿` : text
    },
    set: (part: Part, next: Part, mode: "commit" | "preview" | "cancel") => {
      if (mode === "cancel") { history.cancel(); return }
      const d = replacePart(doc, part.ref, next)
      if (mode === "preview") roomEdit.preview(d); else history.commit(d)
    },
    openLab: () => { if (!labBlocked) openLabWindow().catch((e) => toast.error(`Couldn't open the Lab: ${String(e)}`)) },
  }
  const [savedDoc, setSavedDoc] = useState<Doc>(doc)
  const [path, setPath] = useState<string | null>(null)
  const [fitKey, setFitKey] = useState("start")
  const [selection, setSelection] = useState<Selection>(emptySelection())
  const [tool, setTool] = useState<Tool>({ kind: "select" })
  const [placing, setPlacing] = useState<Placing | null>(null)
  const [ghostRot, setGhostRot] = useState<Rot>(0)
  const [ghostMirror, setGhostMirror] = useState(false)
  const [analysis, setAnalysis] = useState<AnalysisType>("ac")
  const [result, setResult] = useState<JobResult | null>(null)
  const [opValues, setOpValues] = useState<Record<string, number>>({})
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [probes, setProbes] = useState<string[]>([])
  const probesRef = useRef(probes)
  probesRef.current = probes
  const [mode, setMode] = useState<SimMode>(() => getSettings().runMode)
  const live = mode === "realtime"
  const [overlays, setOverlays] = useState<Overlays>(() => ({ flow: getSettings().overlayFlow, volt: getSettings().overlayVolt, tags: getSettings().overlayTags }))
  const [dmm, setDmm] = useState<string | null>(null)
  const [hoverInfo, setHoverInfo] = useState<HoverInfo | null>(null)
  const [zoom, setZoom] = useState(100)
  const [dockMax, setDockMax] = useState(false)
  const [codeW, setCodeW] = usePaneSize("sb-code-width", 640)
  const [dockH, setDockH] = usePaneSize("sb-dock-height", 340)
  const [tab, setTab] = useState("scope")
  const [log, setLog] = useState<string[]>([])
  const [ms, setMs] = useState<number | null>(null)
  const [browser, setBrowser] = useState<{ open: boolean; q?: string }>({ open: false })
  const [examplesOpen, setExamplesOpen] = useState(false)
  const [setupDlg, setSetupDlg] = useState<{ open: boolean; section?: SetupSection; target?: string }>({ open: false })
  const [runs, setRuns] = useState<RunOutcome[] | null>(null)
  // every Simulate press / sweep becomes a result set (Analysis view, Data export); live runs share one "Live" entry
  const [resultSets, setResultSets] = useState<ResultSet[]>([])
  const [activeSet, setActiveSet] = useState<string | null>(null)
  const [analysisOpen, setAnalysisOpen] = useState(false)
  // Simulation process view: which run it shows (null = the latest)
  const [runOpen, setRunOpen] = useState(false)
  const [runView, setRunView] = useState<string | null>(null)
  const [pcbOpen, setPcbOpen] = useState(false)
  // right panel: part inspector or "Instruments & data"
  const [aside, setAside] = useState<"inspector" | "instruments">("inspector")
  /** the panel shows for a selected part, or when Instruments & data was opened */
  const [panelPinned, setPanelPinned] = useState(false)
  /** last AC sweep, kept for the Bode plotter while the scope shows a transient */
  const [lastAc, setLastAc] = useState<AcResult | null>(null)
  const [sweeping, setSweeping] = useState(false)
  const [exportDlg, setExportDlg] = useState<{ open: boolean; setId: string | null }>({ open: false, setId: null })
  const [progress, setProgress] = useState<string | null>(null)
  // ---- Kirk code view
  const [view, setView] = useState<ViewMode>("schematic")
  const [code, setCode] = useState("")
  const [kirkDiag, setKirkDiag] = useState<KirkDiagnostic[]>([])
  const [compileMs, setCompileMs] = useState<number | null>(null)
  const [compiling, setCompiling] = useState(false)
  const [codeBroken, setCodeBroken] = useState(false)
  const fromCode = useRef<Doc | null>(null)
  // code → schematic (debounced compile)
  const compileTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const compileId = useRef(0)
  const [measured, setMeasured] = useState<{ measures: Record<string, MeasureOutcome>; asserts: AssertOutcome[] }>({ measures: {}, asserts: [] })
  const [engine, setEngine] = useState<string | null>(null)
  const [, setSymbolsReady] = useState(0)
  const runId = useRef(0)

  const netlist = useMemo(() => deriveNetlist(doc), [doc])
  const spiceIssues = useMemo(() => buildNetlist(doc, netlist, "op").issues, [doc, netlist])
  const issues = useMemo(() => [...netlist.issues, ...spiceIssues], [netlist, spiceIssues])
  const errors = issues.filter((i) => i.severity === "error")
  /** the Lab opens for a circuit with parts and no ERC errors */
  const labBlocked = !doc.parts.some((p) => !isVirtual(p)) ? "Lab: add parts to the circuit first" : errors.length ? `Lab: fix ${errors.length} ERC error${errors.length > 1 ? "s" : ""} first — ${errors[0].message}` : null
  // ---- link to the Lab window: send the circuit, take back its feeds
  const lab = useRef<ReturnType<typeof labChannel> | null>(null)
  const labState = useRef({ doc, errors: errors.map((e) => e.message), path: null as string | null })
  labState.current = { doc, errors: errors.map((e) => e.message), path: null }
  useEffect(() => {
    const ch = labChannel((m) => {
      if (m.type === "hello") ch.send({ type: "circuit", ...labState.current })
      else if (m.type === "stimulus") {
        const d = latestDoc.current
        if (JSON.stringify(d.stimulus ?? null) === JSON.stringify(m.stimulus ?? null)) return
        const nd = { ...d, stimulus: m.stimulus }
        latestDoc.current = nd
        commit(nd)
      }
    })
    lab.current = ch
    const bye = () => ch.send({ type: "closed" })
    window.addEventListener("beforeunload", bye)
    return () => { window.removeEventListener("beforeunload", bye); ch.close() }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const t = setTimeout(() => lab.current?.send({ type: "circuit", ...labState.current }), 150)
    return () => clearTimeout(t)
  }, [doc, errors.length])

  // schematic → code. A drawing edit always wins: it cancels any pending compile of
  // older text and regenerates the code (⌘Z in the editor brings unfinished text back).
  const docForCode = useMemo(() => ({ ...doc, probes, dmm: dmm ?? undefined }), [doc, probes, dmm])
  const latestDoc = useRef(doc)
  latestDoc.current = doc

  // ---- circuit + firmware: Arduino / Pico boards in the schematic run their sketches (cosim/)
  const boards = useMemo(() => boardParts(doc).map((b) => ({ ref: b.part.ref, board: b.board })), [doc.parts])
  const [fwOpen, setFwOpen] = useState(false)
  const [fwActive, setFwActive] = useState<string | null>(null)
  const [fwW, setFwW] = usePaneSize("sb-firmware-width", 520)
  const hadBoards = useRef(false)
  /** the last co-simulation window: after Stop it holds still instead of playing back */
  const cosimWindow = useRef<JobResult | null>(null)
  useEffect(() => { if (boards.length && !hadBoards.current) setFwOpen(true); hadBoards.current = boards.length > 0 }, [boards.length])
  const cosim = useCoSim({
    doc, cliBin: settings.arduinoCliPath,
    onFrame: (f) => { cosimWindow.current = f.window; setResult(f.window); setOpValues(f.avg); setError(null) },
    onError: (msg) => {
      setError(msg)
      toast.error(`Circuit + firmware stopped: ${msg.split("\n")[0]}`, { duration: 12000, action: { label: "Fix with AI", onClick: () => askAiRef.current(`Running the circuit with the firmware failed: ${msg}\nFind the cause and fix it, then run it again.`) } })
    },
  })

  // ---- projects (lib/project.ts): the open project, its circuit file, the user's libraries folder
  const [project, setProject] = useState<Project | null>(null)
  const [circuitFile, setCircuitFile] = useState<string | null>(null)
  const [folders, setFolders] = useState<{ projects: string; libraries: string } | null>(null)
  useEffect(() => { homeFolders().then(setFolders).catch(() => {}) }, [])
  // parts imported from Fritzing (~/Documents/Space Bench/Parts)
  useEffect(() => { if (folders) import("@/mcu/customParts").then((m) => m.loadImportedParts(appFS(), joinPath(dirName(folders.projects), "Parts"))).catch(() => {}) }, [folders])
  const [tree, setTree] = useState<TreeNode[]>([])
  const refreshTree = useCallback(() => { if (project) projectTree(project).then(setTree).catch(() => setTree([])) }, [project])
  useEffect(refreshTree, [refreshTree])
  const resolve = useMemo(() => projectResolver(project, folders ? { fs: appFS(), root: folders.libraries } : null), [project, folders])
  const resolveRef = useRef(resolve)
  resolveRef.current = resolve
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const [leftTab, setLeftTab] = useState<"parts" | "project">("parts")
  useEffect(() => { if (project) setLeftTab("project") }, [project])
  /** a library file open in the library editor */
  /** the AI conversation lasts as long as the open project (or, without one, the session) */
  const chatKey = project ? `project:${project.root}` : "circuit"
  /** the microcontroller workspace: the open sketch and where Save writes it */
  const [mcu, setMcu] = useState<{ doc: SketchDoc; where?: string; save: (d: SketchDoc) => Promise<string | void>; back: "start" | "work"; key: number } | null>(null)
  const [libEdit, setLibEdit] = useState<{ title: string; where: string; text: string; save: (t: string) => Promise<void>; back: "start" | "work" } | null>(null)
  useEffect(() => {
    if (view === "schematic") return
    if (fromCode.current && doc === fromCode.current) return
    if (compileTimer.current) { clearTimeout(compileTimer.current); compileTimer.current = null }
    compileId.current++
    setCompiling(false)
    setCodeBroken(false)
    fromCode.current = null
    setCode(generateKirk(docForCode, netlist)); setKirkDiag([])
  }, [docForCode, netlist, view]) // eslint-disable-line react-hooks/exhaustive-deps

  const onCodeChange = (text: string) => {
    setCode(text)
    if (compileTimer.current) clearTimeout(compileTimer.current)
    compileTimer.current = setTimeout(async () => {
      compileTimer.current = null
      const id = ++compileId.current
      const base = latestDoc.current
      setCompiling(true)
      const t0 = performance.now()
      const r = await compileKirk(text, base, { resolve: resolveRef.current })
      // superseded by newer typing, or the drawing changed meanwhile: drop this result
      if (id !== compileId.current || latestDoc.current !== base) return
      setCompiling(false); setCompileMs(performance.now() - t0); setKirkDiag(r.diagnostics)
      if (r.ok && r.doc) {
        fromCode.current = r.doc
        setCodeBroken(false)
        commit(r.doc)
        if (JSON.stringify(r.doc.probes) !== JSON.stringify(probes)) setProbes(r.doc.probes)
        if (r.doc.dmm !== (dmm ?? undefined)) setDmm(r.doc.dmm ?? null)
        if (r.doc.defaultAnalysis !== analysis && text.includes("simulate")) setAnalysis(r.doc.defaultAnalysis)
      } else setCodeBroken(true)
    }, getSettings().kirkDelay)
  }
  const regenerate = () => { setCodeBroken(false); fromCode.current = null; setCode(generateKirk(docForCode, netlist)); setKirkDiag([]) }
  // a component instance's parameters edited outside Kirk (Inspector): compile its new subcircuit
  useEffect(() => {
    if (!doc.components?.length || !doc.parts.some((p) => p.lib.startsWith("kirk:"))) return
    let live = true
    refreshVariants(doc, (src, o) => compileKirk(src, null, { ...o, resolve: resolveRef.current })).then((d) => { if (live && d && latestDoc.current === doc) history.replace(d) })
    return () => { live = false }
  }, [doc]) // eslint-disable-line react-hooks/exhaustive-deps

  const addLog = (line: string) => setLog((l) => [...l.slice(-300), line])

  // ---- simulation. Every run is recorded for the Simulation process view (lib/runlog.ts).
  const engineRef = useRef<string | null>(null)
  const lastRunError = useRef<string | null>(null)
  const lastResult = useRef<JobResult | null>(null)
  /** while the AI assistant simulates, real-time re-runs wait (they would supersede its run) */
  const holdLive = useRef(false)
  /** name of the engine run in flight (for Stop) */
  const engineRun = useRef<string | null>(null)
  engineRef.current = engine
  const currentRun = useRef<RunHandle | null>(null)
  const runControl = useRef<RunControl | null>(null)
  /** Select the parts an error points at and show them on the schematic. */
  const showRefs = (refs: string[]) => {
    const ids = latestDoc.current.parts.filter((p) => refs.includes(p.ref)).map((p) => p.id)
    setSelection({ parts: new Set(ids), wires: new Set() })
    setRunOpen(false); setAnalysisOpen(false); setPcbOpen(false); setView((v) => (v === "code" ? "split" : v)); setScreen("work")
  }
  const showRefsRef = useRef(showRefs)
  showRefsRef.current = showRefs
  const openRun = (id: string) => { setRunView(id); setRunOpen(true); setAnalysisOpen(false); setPcbOpen(false); setScreen("work") }
  const openRunRef = useRef(openRun)
  openRunRef.current = openRun

  /** Stages 1–3: ERC, netlist (circuit IR) and models. Null when ERC errors block the run. */
  const prepare = useCallback((h: RunHandle, d: Doc, a: AnalysisType) => {
    const end = h.span("ERC + netlist", "stage")
    let t = performance.now()
    const nl = deriveNetlist(d)
    const ercMs = performance.now() - t
    t = performance.now()
    const net = buildNetlist(d, nl, a)
    const irMs = performance.now() - t
    t = performance.now()
    for (const p of d.parts) resolveSim(p)
    const modelMs = performance.now() - t
    const parts = d.parts.filter((p) => !isVirtual(p)).length
    const all = [...nl.issues, ...net.issues]
    const errs = all.filter((e) => e.severity === "error"), warns = all.filter((e) => e.severity !== "error")
    const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`
    h.stage("erc", {
      ms: ercMs, status: errs.length ? "failed" : warns.length ? "warning" : "done",
      lines: [`${plural(parts, "part")} · ${plural(nl.nets.length, "net")}`, `ERC: ${plural(errs.length, "error")}, ${plural(warns.length, "warning")}`, (errs[0] ?? warns[0])?.message ?? "No problems found"],
      note: errs.length ? plural(errs.length, "error") : warns.length ? plural(warns.length, "warning") : undefined,
    })
    h.log(`${stamp(h.now())} ${d.title} · ${plural(parts, "part")} · ${plural(nl.nets.length, "net")} · ERC ${plural(errs.length, "error")}, ${plural(warns.length, "warning")}`, errs.length ? "error" : "info")
    for (const w of all) h.log(`${stamp(h.now())} ${w.severity === "error" ? "error" : "warning"}: ${w.message}`, w.severity === "error" ? "error" : "warn")
    if (errs.length) {
      end("failed")
      for (const s of ["ir", "models", "solver", "vectors", "measure"] as const) h.stage(s, { status: "skipped" })
      h.event({ kind: "failed", title: "Not simulated: ERC errors", detail: errs.map((e) => e.message).join(" · "), refs: errs.map((e) => e.ref).filter((r): r is string => !!r) })
      return { nl, net, errs }
    }
    const lines = net.text.split("\n")
    const models = lines.filter((l) => /^\.(model|subckt)\s/i.test(l)).map((l) => l.split(/\s+/)[1])
    h.stage("ir", { ms: irMs, status: "done", lines: ["Schematic → SPICE netlist", `${lines.length} lines · ${plural(net.nodes.size, "node")}`, `${plural(net.simulated, "device")} stamped`] })
    h.stage("models", {
      ms: modelMs, status: "done",
      lines: [models.length ? `${plural(models.length, "model")} / subcircuits` : "Linear parts only", "Datasheet or generic (KiCad Sim.*)", models.slice(0, 3).join(" · ") || "R · C · L · sources"],
    })
    h.log(`${stamp(h.now())} netlist · ${lines.length} lines · ${plural(net.nodes.size, "node")} · ${plural(models.length, "model")}`)
    end("done")
    return { nl, net, errs }
  }, [])

  const partsOnNet = (nl: ReturnType<typeof deriveNetlist>) => (n: string) => [...new Set([...nl.pinNet].filter(([, v]) => v === n).map(([k]) => k.split(".")[0]))]

  /** Turn an error into a run event, a console line and a toast with "Show on schematic". */
  const reportFailure = (h: RunHandle, msg: string, net: ReturnType<typeof buildNetlist>, nl: ReturnType<typeof deriveNetlist>, quiet: boolean) => {
    const info = explainFailure(msg)
    const { refs } = refsInMessage(msg, net.elements, net.nodes, partsOnNet(nl))
    h.event({ kind: "failed", title: info.title, detail: `${info.detail}${msg && !info.detail.includes(msg.split("\n")[0]) ? ` — ngspice: ${msg.split("\n")[0]}` : ""}`, refs })
    for (const l of msg.split("\n").slice(0, 8)) h.log(`${stamp(h.now())} error: ${l}`, "error")
    if (!quiet) toast.error(info.title, {
      description: info.detail, duration: 12000,
      action: { label: "Fix with AI", onClick: () => askAiRef.current(`The simulation failed: ${info.title}. ${info.detail}\nngspice said: ${msg.split("\n").slice(0, 4).join(" · ")}\nFind the cause and fix it, then simulate again.`) },
      cancel: refs.length ? { label: "Show on schematic", onClick: () => showRefsRef.current(refs) } : { label: "Details", onClick: () => openRunRef.current(h.id) },
    })
  }

  const ANALYSIS_LABEL: Record<AnalysisType, string> = { tran: "Transient", ac: "AC sweep", dc: "DC sweep", op: "Operating point" }
  const resultDetail = (res: JobResult) => res.type === "tran" ? `${res.time.length} points` : res.type === "ac" ? `${res.freq.length} frequencies` : res.type === "dc" ? `${res.sweep.length} sweep points` : `${res.names.length} values`
  const pointsOf = (res: JobResult) => res.type === "tran" ? res.time.length : res.type === "ac" ? res.freq.length : res.type === "dc" ? res.sweep.length : 1
  const vectorsStage = (h: RunHandle, results: JobResult[], probesNow: string[]) => {
    const r = results[0]
    if (!r) return
    const pts = results.reduce((s, x) => s + pointsOf(x) * x.names.length, 0)
    const mb = (pts * (r.type === "ac" ? 16 : 8)) / 1e6
    h.stage("vectors", { status: "done", ms: null, note: "stream", lines: [`${r.names.length} vectors × ${results.length} run${results.length > 1 ? "s" : ""}`, `${resultDetail(r)} · ${mb * 1e6 < 1000 ? `${Math.round(mb * 1e6)} B` : mb < 0.1 ? `${(mb * 1000).toFixed(0)} kB` : `${mb.toFixed(1)} MB`}`, probesNow.length ? `Probes: ${probesNow.slice(0, 3).join(", ")}${probesNow.length > 3 ? "…" : ""}` : "No probes connected"] })
  }

  /** Returns the result (null when the run failed or was superseded; the reason is in lastRunError). */
  const run = useCallback(async (d: Doc, a: AnalysisType, quiet = false): Promise<JobResult | null> => {
    lastRunError.current = null
    const stampTime = new Date().toLocaleTimeString()
    if (!d.parts.some((p) => !isVirtual(p))) { setResult(null); setOpValues({}); lastRunError.current = "the circuit has no parts"; return null }
    const h = startRun({ label: ANALYSIS_LABEL[a], analysis: a, live: quiet, total: 1 })
    const { nl, net, errs } = prepare(h, d, a)
    if (errs.length) {
      setError(`Fix ${errs.length} problem${errs.length > 1 ? "s" : ""} first: ${errs.map((e) => e.message).join(" · ")}`)
      if (!quiet) {
        addLog(`[${stampTime}] not simulated — ${errs.map((e) => e.message).join("; ")}`)
        const refs = errs.map((e) => e.ref).filter((r): r is string => !!r)
        toast.error(`Not simulated: ${errs[0].message}${errs.length > 1 ? ` (+${errs.length - 1} more)` : ""}`, refs.length ? { action: { label: "Show on schematic", onClick: () => showRefsRef.current(refs) } } : undefined)
      }
      h.finish("failed")
      lastRunError.current = `ERC errors: ${errs.map((e) => e.message).join("; ")}`
      return null
    }
    if (!net.simulated) {
      setError("Nothing to simulate yet — no part has a simulation model.")
      if (!quiet) toast.error("Nothing to simulate yet — no part has a simulation model.")
      h.event({ kind: "failed", title: "Nothing to simulate", detail: "No part has a simulation model yet." })
      h.finish("failed")
      lastRunError.current = "no part has a simulation model"
      return null
    }
    const id = ++runId.current
    currentRun.current = h
    setRunning(true)
    const method = getSettings().method === "gear" ? "Gear" : "trapezoidal"
    h.stage("solver", { status: "running", lines: [engineRef.current ?? "ngspice", `${ANALYSIS_LABEL[a]} · 1 run`, `Newton–Raphson · ${method}`] })
    h.update({ netlist: net.text })
    const endRun = h.span(quiet ? "live run" : "run nominal")
    h.log(`${stamp(h.now())} ${engineRef.current ?? "ngspice"} · ${ANALYSIS_LABEL[a].toLowerCase()} · ${method}`)
    const t0 = performance.now()
    try {
      const name = `app${id}`
      engineRun.current = name
      const [res, op] = await Promise.all([
        simulate(net, { live: quiet, run: name, onProgress: quiet ? undefined : (f) => { if (id === runId.current && f !== null) setProgress(`${Math.round(f * 100)}%`) } }),
        a === "op" ? null : simulate(buildNetlist(d, nl, "op")).catch(() => null),
      ])
      if (!quiet) setProgress(null)
      if (id !== runId.current) { lastRunError.current = "superseded by a newer run"; return null }
      const dt = performance.now() - t0
      endRun("done")
      const recovered = (res.log ?? []).some((l) => l.startsWith("auto-recovered"))
      h.stage("solver", { ms: dt, status: recovered ? "warning" : "done", note: recovered ? "1 retry" : undefined, lines: [`${engineRef.current ?? "ngspice"} · ${method}`, `${ANALYSIS_LABEL[a]} · ${resultDetail(res)}`, recovered ? "1 retry (auto-recovered)" : "0 retries"] })
      for (const m of res.log ?? []) h.log(`${stamp(h.now())} ngspice: ${m}`, /error|singular/i.test(m) ? "error" : "warn")
      if (recovered) {
        h.event({ kind: "recovered", title: "Recovered from a convergence failure", detail: "The first attempt did not converge; the retry with Gear integration and gmin / source stepping did. Results are valid." })
        if (!quiet) toast.warning("Recovered from a convergence failure", { description: "Retried with Gear integration and gmin stepping — results are valid.", action: { label: "Details", onClick: () => openRunRef.current(h.id) } })
      }
      setResult(res); setOpValues(finalValues(a === "op" ? res : op)); setError(null); setMs(dt)
      simulatedRef.current = true
      vectorsStage(h, [res], probesRef.current)
      const tm = performance.now()
      const endMeasure = h.span("Measurements + stats", "stage")
      const m = d.measures?.length ? runMeasures(d.measures, res) : {}
      const as = d.asserts?.length ? runAsserts(d.asserts, m, res) : []
      endMeasure("done")
      setMeasured({ measures: m, asserts: as })
      const okMeasures = Object.entries(m).filter(([, v]) => v.ok)
      const failedAsserts = as.filter((x) => !(x.ok && x.pass)).length
      h.stage("measure", {
        ms: performance.now() - tm, status: failedAsserts ? "warning" : "done", note: failedAsserts ? `${failedAsserts} assert${failedAsserts > 1 ? "s" : ""} ✗` : undefined,
        lines: [Object.keys(m).length ? `.meas: ${Object.keys(m).slice(0, 4).join(", ")}` : "No measurements", as.length ? `Asserts: ${as.length - failedAsserts} ✓ · ${failedAsserts} ✗` : "No asserts", "Scope · DMM · Bode"],
      })
      if (okMeasures.length) h.log(`${stamp(h.now())} ${okMeasures.slice(0, 4).map(([k, v]) => `${k} = ${v.ok ? formatSI(v.value.value, v.value.unit === "deg" ? "°" : v.value.unit, 4) : ""}`).join(" · ")}`)
      const entry: ResultSet = {
        id: quiet ? "live" : uid("rs"), label: `${quiet ? "Live · " : `Run #${h.rec().n} · `}${ANALYSIS_LABEL[a]} · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`,
        time: Date.now(), analysis: a, doc: d, netlist: net.text,
        runs: [{ label: "nominal", params: {}, result: res, measures: m, asserts: as, ms: dt }],
      }
      setResultSets((list) => [entry, ...list.filter((x) => x.id !== entry.id)].slice(0, 20))
      if (!quiet) setActiveSet(entry.id)
      h.update({ resultSetId: entry.id, done: 1 })
      h.log(`${stamp(h.now())} ${resultDetail(res)} · results ready`, "ok")
      h.finish("done")
      addLog(`[${stampTime}] ${d.title} · ${a.toUpperCase()} · ngspice · ${resultDetail(res)} · ${dt.toFixed(0)} ms`)
      for (const msg of res.log ?? []) addLog(`    ngspice: ${msg}`)
      if (!quiet) toast.success(`${ANALYSIS_LABEL[a]} simulated · ${dt.toFixed(0)} ms`, { action: { label: "Details", onClick: () => openRunRef.current(h.id) } })
      if (!quiet) addLog(`    netlist:\n${net.text.split("\n").map((l) => `      ${l}`).join("\n")}`)
      if (a === "op") setTab((t) => (t === "scope" || t === "bode" ? "dmm" : t))
      lastResult.current = res
      return res
    } catch (e) {
      if (id !== runId.current) { lastRunError.current = "superseded by a newer run"; return null }
      const msg = e instanceof Error ? e.message : String(e)
      lastRunError.current = msg
      endRun("failed")
      h.stage("solver", { ms: performance.now() - t0, status: "failed", note: "failed", lines: [engineRef.current ?? "ngspice", `${ANALYSIS_LABEL[a]} · 1 run`, msg.split("\n")[0].slice(0, 60)] })
      for (const s of ["vectors", "measure"] as const) h.stage(s, { status: "skipped" })
      reportFailure(h, msg, net, nl, quiet)
      h.finish("failed")
      setError(msg)
      addLog(`[${stampTime}] error: ${msg}`)
      addLog(`    netlist:\n${net.text.split("\n").map((l) => `      ${l}`).join("\n")}`)
      return null
    } finally {
      if (id === runId.current) setRunning(false)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- multi-run (sweep / Monte Carlo / temperature)
  const runMany = async (d: Doc, a: AnalysisType) => {
    const specs = planRuns(d)
    if (specs.length <= 1) { setRuns(null); run(d, a); return }
    const stampTime = new Date().toLocaleTimeString()
    const sw = d.setup?.sweep?.enabled ? `Sweep ${d.setup.sweep.target.replace(/\.value$/, "")}` : d.setup?.montecarlo?.enabled ? "Monte Carlo" : d.setup?.temp?.enabled ? "Temperature" : "Runs"
    const h = startRun({ label: `${sw} · ${specs.length} runs`, analysis: a, live: false, total: specs.length })
    const { nl, net, errs } = prepare(h, d, a)
    if (errs.length) {
      const refs = errs.map((e) => e.ref).filter((r): r is string => !!r)
      toast.error(`Not simulated: ${errs[0].message}`, refs.length ? { action: { label: "Show on schematic", onClick: () => showRefsRef.current(refs) } } : undefined)
      h.finish("failed")
      return
    }
    const workers = d.setup?.parallel === false ? 1 : getSettings().workers
    const control: RunControl = { paused: false, cancelled: false }
    runControl.current = control
    currentRun.current = h
    const id = ++runId.current
    const method = getSettings().method === "gear" ? "Gear" : "trapezoidal"
    h.stage("solver", { status: "running", lines: [`${engineRef.current ?? "ngspice"} · ${method}`, `${ANALYSIS_LABEL[a]} · ${specs.length} runs`, `${workers} parallel worker${workers > 1 ? "s" : ""}`] })
    h.update({ netlist: net.text })
    setRunning(true); setProgress(`0/${specs.length}`)
    const t0 = performance.now()
    const ends = new Map<number, (s?: SpanStatus) => void>()
    let retries = 0
    try {
      const out = await runAll(d, a, specs, workers, {
        onStart: (i, s) => { ends.set(i, h.span(`run ${s.label}`)); h.log(`${stamp(h.now())} start · ${s.label}`) },
        onDone: (i, o) => {
          // after Stop, runs that were already inside ngspice are dropped
          if (control.cancelled) return
          ends.get(i)?.(o.error ? (o.error === "stopped" ? "stopped" : "failed") : "done")
          if (o.result?.log?.some((l) => l.startsWith("auto-recovered"))) { retries++; h.event({ kind: "recovered", title: `Recovered: ${o.label}`, detail: "Retried with Gear integration and gmin / source stepping; results are valid." }) }
          const ms = Object.entries(o.measures).filter(([, v]) => v.ok).slice(0, 3).map(([k, v]) => `${k} = ${v.ok ? formatSI(v.value.value, v.value.unit === "deg" ? "°" : v.value.unit, 4) : ""}`)
          h.log(`${stamp(h.now())} ${o.label} ${o.error ? `failed: ${o.error.split("\n")[0]}` : `done${ms.length ? ` · ${ms.join(" · ")}` : ""}`}`, o.error ? "error" : "info")
        },
        onProgress: (k, n) => { if (control.cancelled) return; setProgress(`${k}/${n}`); h.update({ done: k }) },
      }, control)
      if (id !== runId.current || control.cancelled) {
        if (h.rec().status !== "stopped") h.finish("stopped")
        return
      }
      const done = out.filter((o) => o.error !== "stopped")
      setRuns(done)
      const failed = done.filter((r) => r.error).length
      h.stage("solver", { ms: performance.now() - t0, status: failed ? (failed === done.length ? "failed" : "warning") : retries ? "warning" : "done", note: failed ? `${failed} failed` : retries ? `${retries} retr${retries > 1 ? "ies" : "y"}` : undefined,
        lines: [`${engineRef.current ?? "ngspice"} · ${method}`, `${done.length} runs · ${workers} worker${workers > 1 ? "s" : ""}`, `${failed} failed · ${retries} retr${retries === 1 ? "y" : "ies"}`] })
      vectorsStage(h, done.map((o) => o.result).filter((r): r is JobResult => !!r), probesRef.current)
      const allAsserts = done.flatMap((o) => o.asserts)
      const bad = allAsserts.filter((x) => !(x.ok && x.pass)).length
      const measureNames = [...new Set(done.flatMap((o) => Object.keys(o.measures)))]
      const passRuns = done.filter((o) => o.asserts.length && o.asserts.every((x) => x.ok && x.pass)).length
      h.stage("measure", { ms: null, status: bad ? "warning" : "done", note: bad ? `${bad} ✗` : undefined,
        lines: [measureNames.length ? `.meas: ${measureNames.slice(0, 4).join(", ")}` : "No measurements", allAsserts.length ? `Yield: ${passRuns}/${done.length} runs pass` : "No asserts", `${done.length}-run statistics`] })
      const entry: ResultSet = {
        id: uid("rs"), label: `Run #${h.rec().n} · ${sw} · ${done.length} runs · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
        time: Date.now(), analysis: a, doc: d, netlist: buildNetlist(d, deriveNetlist(d), a).text, runs: done,
      }
      setResultSets((list) => [entry, ...list].slice(0, 20))
      setActiveSet(entry.id)
      h.update({ resultSetId: entry.id })
      const first = done.find((r) => r.result)
      if (first?.result) { setResult(first.result); setError(null); simulatedRef.current = true }
      if (h.rec().status === "running" || h.rec().status === "paused") {
        h.log(`${stamp(h.now())} all runs complete · ${done.length - failed} ok · ${failed} failed`, failed ? "warn" : "ok")
        h.finish(failed === done.length ? "failed" : "done")
      }
      if (failed) {
        const firstErr = done.find((r) => r.error)!
        reportFailure(h, firstErr.error!, net, nl, true)
      }
      addLog(`[${stampTime}] ${d.title} · ${specs.length} runs · ${a.toUpperCase()} · ${((performance.now() - t0) / 1000).toFixed(1)} s${failed ? ` · ${failed} failed` : ""}`)
      setTab("results")
      if (!control.cancelled) toast.success(`${done.length} runs done${failed ? ` (${failed} failed)` : ""}`, { action: { label: "Details", onClick: () => openRunRef.current(h.id) } })
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
      reportFailure(h, String(e instanceof Error ? e.message : e), net, nl, false)
      h.finish("failed")
    } finally { if (id === runId.current) { setRunning(false); setProgress(null) }; runControl.current = null }
  }
  /** Stop: cancels queued runs (a run already inside ngspice is dropped when it returns). */
  const stopRun = () => {
    if (!running) return false
    // the library stops mid-run; a program run finishes and is ignored
    if (engineRun.current) haltRun(engineRun.current)
    runId.current++
    if (runControl.current) runControl.current.cancelled = true
    const h = currentRun.current
    if (h && (h.rec().status === "running" || h.rec().status === "paused")) {
      h.log(`${stamp(h.now())} stopped by the user · ${h.rec().done} of ${h.rec().total} run${h.rec().total > 1 ? "s" : ""} finished`, "warn")
      for (const st of ["solver", "vectors", "measure"] as const) if (h.rec().stages[st].status === "running" || h.rec().stages[st].status === "pending") h.stage(st, { status: "skipped" })
      h.finish("stopped")
    }
    setRunning(false); setProgress(null)
    toast("Simulation stopped")
    return true
  }
  const pauseRun = (pause: boolean) => {
    const c = runControl.current, h = currentRun.current
    if (!c || !h) return
    c.paused = pause
    h.update({ status: pause ? "paused" : "running" })
    h.log(`${stamp(h.now())} ${pause ? "paused — runs already in ngspice finish first" : "resumed"}`, "warn")
  }
  // ---- AI assistant: the agent's view of (and hands on) the app. Everything goes through refs,
  // because one chat turn runs several tools before React re-renders.
  const [aiOpen, setAiOpen] = useState(false)
  /** a message for the assistant ("Fix with AI"): the chat sends it */
  const [aiAsk, setAiAsk] = useState<{ id: number; text: string } | null>(null)
  const askAiRef = useRef<(text: string) => void>(() => {})
  const permission = usePermission()
  const cosimRef = useRef(cosim)
  cosimRef.current = cosim
  const analysisRef = useRef(analysis)
  analysisRef.current = analysis
  const dmmRef = useRef(dmm)
  dmmRef.current = dmm
  const netName = (n: string) => (n === "0" ? "GND" : n)
  const signalExists = (sig: string, d: Doc) => {
    const m = /^(V|I[a-z]*)\((.+)\)$/.exec(sig)
    if (!m) return false
    if (m[1] === "V") return deriveNetlist(d).nets.some((n) => netName(n).toLowerCase() === m[2].toLowerCase())
    return d.parts.some((p) => p.ref === m[2])
  }
  const normalizeSignal = (sig: string, d: Doc) => {
    const m = /^(V|I[a-z]*)\((.+)\)$/i.exec(sig.trim())
    if (!m) return sig.trim()
    const kind = m[1].length === 1 ? m[1].toUpperCase() : m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()
    if (kind === "V") { const n = deriveNetlist(d).nets.find((x) => netName(x).toLowerCase() === m[2].toLowerCase()); return `V(${n ? netName(n) : m[2]})` }
    return `${kind}(${m[2].toUpperCase()})`
  }
  const aiHost: AgentHost = {
    getCircuit: () => {
      const d = latestDoc.current, nl = deriveNetlist(d)
      const issues = [...nl.issues, ...buildNetlist(d, nl, analysisRef.current).issues].map((i) => `${i.severity}: ${i.message}`)
      return { kirk: d.parts.length ? generateKirk({ ...d, probes: probesRef.current, dmm: dmmRef.current ?? undefined }, nl) : "(empty — no circuit yet)", issues, nets: nl.nets.map(netName), probes: probesRef.current, analysis: analysisRef.current, title: d.title }
    },
    writeKirk: async (code) => {
      const r = await compileKirk(code, latestDoc.current, { resolve: resolveRef.current })
      const errors = r.diagnostics.filter((x) => x.severity === "error").map((x) => `line ${lineOf(code, x.span.from)}: ${x.message}${x.help ? ` (${x.help})` : ""}`)
      if (!r.ok || !r.doc) return { ok: false, errors: errors.length ? errors : ["could not compile"], warnings: [], parts: 0, nets: [] }
      // drop any pending compile of older text, then show the new program and drawing
      if (compileTimer.current) { clearTimeout(compileTimer.current); compileTimer.current = null }
      compileId.current++
      let nd = r.doc
      const cname = /^\s*circuit\s+([A-Za-z_]\w*)/m.exec(code)?.[1]
      if (cname && (nd.title === "Untitled circuit" || !/@title/.test(code))) nd = { ...nd, title: cname.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ") }
      fromCode.current = nd
      latestDoc.current = nd
      commit(nd)
      setCode(code); setKirkDiag(r.diagnostics); setCodeBroken(false)
      // probes: the program's own, else keep the ones that still exist
      const keep = nd.probes.length ? nd.probes : probesRef.current.filter((x) => signalExists(x, nd))
      probesRef.current = keep; setProbes(keep)
      setDmm(nd.dmm ?? (dmmRef.current && signalExists(dmmRef.current, nd) ? dmmRef.current : null))
      setAnalysis(nd.defaultAnalysis); analysisRef.current = nd.defaultAnalysis
      if (view === "schematic") setView("split")
      await ensureSymbols(docSymbols(nd))
      setFitKey(`ai${Date.now()}`) // frame the new drawing
      const nl = deriveNetlist(nd)
      return { ok: true, errors: [], warnings: [...r.diagnostics.filter((x) => x.severity === "warning").map((x) => x.message), ...nl.issues.map((i) => i.message)], parts: nd.parts.filter((x) => !isVirtual(x)).length, nets: nl.nets.map(netName) }
    },
    simulate: async (a, o) => {
      let d = latestDoc.current
      const t = (v: unknown) => (typeof v === "string" && v.trim() ? parseSI(v) : null)
      const an = structuredClone(d.analyses)
      if (a === "tran") { const stop = t(o.stop), step = t(o.step); if (stop) an.tran.stop = stop; if (step) an.tran.step = step; else if (stop) an.tran.step = Math.min(an.tran.step, stop / 500) }
      if (a === "ac") { const f0 = t(o.from), f1 = t(o.to); if (f0) an.ac.start = f0; if (f1) an.ac.stop = f1 }
      if (JSON.stringify(an) !== JSON.stringify(d.analyses) || d.defaultAnalysis !== a) { d = { ...d, analyses: an, defaultAnalysis: a }; latestDoc.current = d; commit(d) }
      setAnalysis(a); analysisRef.current = a
      setTab(a === "ac" ? "bode" : a === "op" ? "dmm" : "scope")
      holdLive.current = true
      const t0 = performance.now()
      try {
        const res = await run(d, a)
        if (!res) return `Simulation failed: ${lastRunError.current ?? "unknown error"}`
        const m = d.measures?.length ? runMeasures(d.measures, res) : {}
        const as = d.asserts?.length ? runAsserts(d.asserts, m, res) : []
        return summarizeResult(res, probesRef.current, m, (d.asserts ?? []).map((expr, i) => ({ expr, outcome: as[i] })), performance.now() - t0)
      } finally { holdLive.current = false }
    },
    measure: async (expr) => {
      const r = lastResult.current
      if (!r) return "error: nothing simulated yet — call simulate first"
      const m = runMeasures([{ name: "value", expr }], r).value
      return m.ok ? `${expr} = ${formatSI(m.value.value, m.value.unit === "deg" ? "°" : m.value.unit, 5)}` : `error: ${m.error}`
    },
    addProbe: (sig) => {
      const d = latestDoc.current, s2 = normalizeSignal(sig, d)
      if (!signalExists(s2, d)) return `No such signal ${s2} — nets are ${deriveNetlist(d).nets.map(netName).join(", ")}`
      if (probesRef.current.includes(s2)) return `${s2} is already on CH${probesRef.current.indexOf(s2) + 1}`
      const next = [...probesRef.current, s2]
      probesRef.current = next; setProbes(next)
      return `Probe ${s2} connected on CH${next.length}`
    },
    removeProbe: (sig) => {
      const s2 = normalizeSignal(sig, latestDoc.current)
      if (!probesRef.current.includes(s2)) return `${s2} was not probed`
      const next = probesRef.current.filter((x) => x !== s2)
      probesRef.current = next; setProbes(next)
      return `Probe ${s2} removed`
    },
    setStimulus: (target, expr) => {
      const d = latestDoc.current
      const others = (d.stimulus?.feeds ?? []).filter((f) => f.target.toUpperCase() !== target.trim().toUpperCase())
      const stimulus = expr.trim() ? { ...d.stimulus, feeds: [...others, { target: target.trim(), expr: expr.trim() }] } : { ...d.stimulus, feeds: others }
      const nd = { ...d, stimulus }
      const bad = resolveFeeds(nd, nd.analyses.tran.stop).problems.find((p) => p.feed.target === target.trim())
      if (bad) return `Not set: ${bad.message}`
      latestDoc.current = nd
      commit(nd)
      return expr.trim() ? `${target.trim()} = ${expr.trim()} (used by transient runs; operating points use its value at t = 0)` : `Removed the feed on ${target.trim()}`
    },
    setInput: (ref, value) => {
      const d = latestDoc.current
      const part = d.parts.find((p) => p.ref.toUpperCase() === ref.trim().toUpperCase())
      if (!part) return `No part ${ref}`
      const kind = inputKind(part)
      let next: Part
      if (kind === "pot") {
        const m = /^\s*([\d.]+)\s*(%)?\s*$/.exec(value)
        if (!m) return `Can't set ${part.ref} to “${value}” — use 0…1 or a percentage`
        const pos = Number(m[1]) / (m[2] || Number(m[1]) > 1 ? 100 : 1)
        next = setPotPos(part, pos)
      } else if (kind === "switch" || kind === "button") {
        const on = /^(1|on|true|closed|close|press|pressed|yes)$/i.test(value.trim())
        if (!on && !/^(0|off|false|open|release|released|no)$/i.test(value.trim())) return `Can't set ${part.ref} to “${value}” — use on or off`
        next = setClosed(part, on)
      } else return `Can't move ${part.ref}: only Pot / Slider / Knob, Switch and Button are live controls${kind ? " (sensors follow set_environment)" : ""}`
      const nd = { ...d, parts: d.parts.map((p) => (p.ref === part.ref ? { ...next, id: p.id, unit: p.unit, x: p.x, y: p.y, rot: p.rot, mirror: p.mirror } : p)) }
      latestDoc.current = nd
      commit(nd)
      return kind === "pot" ? `${part.ref} at ${Math.round(potPos(next) * 100)} %` : `${part.ref} ${isClosed(next) ? "on (closed)" : "off (open)"}`
    },
    setMeter: (sig) => {
      const d = latestDoc.current, s2 = normalizeSignal(sig, d)
      if (!signalExists(s2, d)) return `No such signal ${s2}`
      setDmm(s2); setTab("dmm")
      return `Multimeter connected to ${s2}`
    },
    findParts: async (q) => {
      const rows = visibleRows(await loadIndex())
      const hits = searchIndex(rows, q, 12)
      return hits.length ? hits.map((r) => `${r.lib}:${r.name} — ${r.desc}`).join("\n") : `No simulation-ready part matches “${q}”.`
    },
    firmware: {
      read: (ref) => {
        const d = latestDoc.current, bs = boardParts(d).filter((b) => !ref || b.part.ref.toUpperCase() === ref.toUpperCase())
        if (!bs.length) return ref ? `No board ${ref} — place an Arduino / Pico in the schematic` : "No board in the schematic runs a sketch yet (place an Arduino UNO / Nano / Mega or a Pico)."
        return bs.map((b) => {
          const fw = firmwareOf(d, b.part.ref, b.board), build = cosimRef.current.builds[b.part.ref]
          const errs = build && !build.ok ? `\nLast compile FAILED:\n${build.diagnostics.filter((x) => x.severity === "error").map((x) => `${x.file}:${x.line}: ${x.message}`).join("\n") || build.log.slice(-2000)}` : build ? "\nLast compile: ok" : "\nNot compiled yet"
          const serial = cosimRef.current.serial[b.part.ref]
          return `## ${b.part.ref}: ${b.board.name}\n${fw.files.map((f) => `--- ${f.name}\n${f.content}`).join("\n")}\n--- libraries.txt\n${fw.libraries ?? ""}${errs}${cosimRef.current.error ? `\nLast run error: ${cosimRef.current.error}` : ""}${serial ? `\nSerial (last):\n${serial.slice(-1200)}` : ""}`
        }).join("\n\n")
      },
      write: (ref, name, content) => {
        const d = latestDoc.current, b = boardParts(d).find((x) => x.part.ref.toUpperCase() === ref.trim().toUpperCase())
        if (!b) return `Not written: no board ${ref}`
        const fw = firmwareOf(d, b.part.ref, b.board)
        const n = name.trim().replace(/^.*\//, "")
        let next: typeof fw
        if (n === "libraries.txt") next = { ...fw, libraries: content }
        else if (!/\.(ino|h|hpp|c|cpp|py)$/.test(n)) return `Not written: ${n} — use sketch.ino, .h, .cpp or libraries.txt`
        else next = { ...fw, files: fw.files.some((f) => f.name === n) ? fw.files.map((f) => (f.name === n ? { ...f, content } : f)) : [...fw.files, { name: n, content }] }
        const nd = { ...d, firmware: { ...d.firmware, [b.part.ref]: next } }
        latestDoc.current = nd
        commit(nd)
        setFwOpen(true); setFwActive(b.part.ref)
        return `Wrote ${b.part.ref}/${n} (${content.split("\n").length} lines)`
      },
      compile: async (ref) => {
        await new Promise((r) => setTimeout(r, 60)) // the edit reaches the compiler's doc first
        const b = boardParts(latestDoc.current).find((x) => x.part.ref.toUpperCase() === ref.trim().toUpperCase())
        if (!b) return { ok: false, text: `No board ${ref}` }
        try {
          const r = await cosimRef.current.compile(b.part.ref)
          if (r.ok) return { ok: true, text: `Compiled${r.flash ? ` — ${r.flash.used} of ${r.flash.max} bytes of flash` : ""}` }
          return { ok: false, text: `Compile failed:\n${r.diagnostics.filter((x) => x.severity === "error").map((x) => `${x.file}:${x.line}: ${x.message}`).join("\n") || r.log.slice(-3000)}` }
        } catch (e) { return { ok: false, text: `Compile failed: ${e instanceof Error ? e.message : String(e)}` } }
      },
      run: async (seconds) => {
        await new Promise((r) => setTimeout(r, 60))
        const c = cosimRef.current
        if (c.active) c.stop()
        void c.start()
        const t0 = Date.now()
        while (Date.now() - t0 < (seconds + 30) * 1000) {
          await new Promise((r) => setTimeout(r, 200))
          const s = cosimRef.current
          if (s.status === "error") return { ok: false, text: `The run failed: ${s.error}` }
          if (s.status === "running" && s.clock && s.clock.t >= seconds) break
        }
        const s = cosimRef.current
        const serial = Object.entries(s.serial).map(([ref, t]) => `[${ref}]\n${t.slice(-1500)}`).join("\n") || "(nothing printed)"
        s.stop()
        return { ok: true, text: `Ran ${s.clock?.t.toFixed(2) ?? "?"} s of circuit + firmware (now stopped).\nSerial output:\n${serial}` }
      },
      checkSetup: async () => {
        const d = latestDoc.current
        const items = await checkSetup(boardParts(d).map((b) => b.board), settings.arduinoCliPath)
        if (!items.length) return "No board in the schematic needs anything."
        return items.map((i) => `${i.ok ? "ok     " : "MISSING"} ${i.id} — ${i.label}: ${i.detail}${!i.ok && i.install ? ` (install: ${i.install})` : ""}`).join("\n")
      },
      install: async (item, reason) => {
        const defs = boardParts(latestDoc.current).map((b) => b.board)
        const items = await checkSetup(defs, settings.arduinoCliPath)
        const it = items.find((i) => i.id === item.trim())
        if (!it) return { ok: false, text: `Unknown item ${item} — check_setup lists: ${items.map((i) => i.id).join(", ")}` }
        if (it.ok) return { ok: true, text: `${it.label} is already installed` }
        if (!it.install) return { ok: false, text: `${it.label} can't be installed from here: ${it.detail}` }
        if (!(await permission.ask(`Install ${it.label}?`, it.install, reason))) return { ok: false, text: "The user didn't allow the install. Stop, and tell them how to install it themselves (Settings → Microcontrollers)." }
        const id = toast.loading(`Installing ${it.label}…`)
        try { const text = await installSetup(it.id, defs, settings.arduinoCliPath, (t) => toast.loading(`${it.label}: ${t}`, { id })); toast.success(`Installed ${it.label}`, { id }); return { ok: true, text } }
        catch (e) { toast.error(`Install failed: ${e instanceof Error ? e.message : String(e)}`, { id }); return { ok: false, text: `Install failed: ${e instanceof Error ? e.message : String(e)}` } }
      },
    },
  }
  askAiRef.current = (text: string) => { openAi(); setAiAsk({ id: Date.now(), text }) }
  // the chat sits beside the editor: make the code pane wide enough for both
  const openAi = () => { setPcbOpen(false); setAnalysisOpen(false); setRunOpen(false); if (view === "schematic") { regenerate(); setView("split") } setCodeW((w) => Math.max(w, Math.min(940, window.innerWidth - 560))); setAiOpen(true) }

  const applySetup = (pt: SetupPatch) => {
    const next = { ...doc, ...pt }
    commit(next)
    setAnalysis(pt.defaultAnalysis)
    return next
  }

  useEffect(() => {
    setTab((t) => (analysis === "ac" && t === "scope" ? "bode" : analysis === "tran" && t === "bode" ? "scope" : t))
  }, [analysis])

  // a freshly opened circuit starts paused: real-time re-runs wait for ▶ or Simulate
  const [paused, setPaused] = useState(true)
  useEffect(() => {
    if (!live || paused || cosim.active) return
    const h = setTimeout(() => { if (!holdLive.current) run(doc, analysis, true) }, 200)
    return () => clearTimeout(h)
  }, [doc, analysis, live, paused, run, cosim.active])

  // ---- document actions
  const loadDoc = (d: Doc, p: string | null, fit: string, id?: string) => {
    cosim.stop()
    if (hasDoc) rememberCurrent()
    // a circuit that isn't part of the open project closes the project
    if (!id?.startsWith("prj:")) { setProject(null); setCircuitFile(null) }
    setPaused(true)
    projectId.current = id ?? uid("prj"); simulatedRef.current = false
    setHasDoc(true); setScreen("work"); setView("schematic"); setAnalysisOpen(false)
    history.reset(d); setSavedDoc(d); setPath(p); setFitKey(fit + Date.now())
    setLastAc(null) // the Bode plot belongs to the previous circuit
    setSelection(emptySelection()); setTool({ kind: "select" }); setPlacing(null)
    setAnalysis(d.defaultAnalysis); setProbes(d.probes); setResult(null); setOpValues({}); setError(null); setRuns(null); setDmm(d.dmm ?? null)
  }
  const openExample = async (id: string) => {
    try { const d = await loadExample(id); loadDoc(d, null, id) } catch (e) { toast.error(String(e instanceof Error ? e.message : e)) }
  }
  /** Put the open circuit on the Start screen's recent list (drafts included). */
  const rememberCurrent = () => {
    const d = { ...latestDoc.current, defaultAnalysis: analysis, probes, dmm: dmm ?? undefined }
    rememberProject({ id: projectId.current, title: d.title, path, analysis: d.defaultAnalysis, simulated: simulatedRef.current, doc: d, ...(projectRef.current ? { folder: projectRef.current.root, circuit: circuitFileRef.current ?? undefined } : {}) }, getSettings().recentLimit)
  }
  const rememberRef = useRef(rememberCurrent)
  rememberRef.current = rememberCurrent
  useEffect(() => {
    const save = () => { if (hasDocRef.current) rememberRef.current() }
    window.addEventListener("beforeunload", save)
    return () => window.removeEventListener("beforeunload", save)
  }, [])
  const hasDocRef = useRef(hasDoc)
  hasDocRef.current = hasDoc
  const goHome = () => { if (hasDoc) rememberCurrent(); setScreen("start"); setStartPage("home") }
  menuRef.current = { home: goHome, import: () => onImport(), settings: () => openSettings() }
  const openSettings = (section?: SettingsSection) => { if (screen !== "settings") setSettingsFrom(screen === "work" ? "work" : screen === "mcu" ? "mcu" : "start"); if (section) setSettingsSection(section); setScreen("settings") }
  /** Kirk source → a new circuit, shown in the code view. */
  const openCode = async (text: string, name = "untitled.kirk") => {
    if (!(await confirmDiscard())) return false
    const blank = { ...emptyDoc(), defaultAnalysis: getSettings().newAnalysis }
    const r = await compileKirk(text, blank, { resolve: resolveRef.current })
    if (!r.doc) { toast.error(`Could not read ${name}: ${r.diagnostics[0]?.message ?? "syntax error"}`); return false }
    // no @title: name the circuit after `circuit MyFilter {` → "My Filter"
    const cname = /^\s*circuit\s+([A-Za-z_]\w*)/m.exec(text)?.[1]
    if (r.doc.title === blank.title && cname) r.doc = { ...r.doc, title: cname.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ") }
    loadDoc(r.doc, null, name)
    fromCode.current = r.doc
    setCode(text); setKirkDiag(r.diagnostics); setCodeBroken(!r.ok)
    setView(getSettings().kirkView === "code" ? "code" : "split")
    return true
  }
  const onNewFromCode = (text?: string) => openCode(text ?? NEW_FROM_CODE)
  const onImport = async () => {
    try {
      const f = await pickImport()
      if (!f) return
      if (/\.kirk$/i.test(f.name)) { if (await openCode(f.text, f.name)) toast.success(`Imported ${f.name}`); return }
      if (/\.kicad_sch$/i.test(f.name) || isKicadSch(f.text)) {
        // a KiCad schematic opens as the drawing it is; the Kirk code is written from it
        const r = await importKicadSch(f.text, f.name)
        if (!r.doc.parts.length) { toast.error(`${f.name}: no symbols found`); return }
        if (!(await confirmDiscard())) return
        await ensureSymbols(docSymbols(r.doc))
        loadDoc(r.doc, null, f.name)
        setView(getSettings().kirkView === "code" ? "code" : "split")
        const n = r.doc.parts.filter((p) => !isVirtual(p)).length
        toast.success(`Imported ${f.name} · ${n} part${n === 1 ? "" : "s"}${r.custom.length ? ` · ${r.custom.length} symbol${r.custom.length > 1 ? "s" : ""} from the file` : ""}`, r.warnings.length ? { description: r.warnings.join(" · ") } : undefined)
        return
      }
      const imp = spiceToKirk(f.text, f.name)
      if (!imp.parts) { toast.error(`${f.name}: no parts found that Space Bench can import`); return }
      if (await openCode(imp.kirk, f.name)) toast.success(`Imported ${f.name} · ${imp.parts} parts${imp.skipped.length ? ` · ${imp.skipped.length} line${imp.skipped.length > 1 ? "s" : ""} skipped (listed at the end of the code)` : ""}`)
    } catch (e) { toast.error(String(e instanceof Error ? e.message : e)) }
  }
  const onExportKicad = async () => {
    try {
      const name = `${doc.title.replace(/[^\w\- ]+/g, "").trim() || "circuit"}.kicad_sch`
      const p = await saveExport(name, "kicad_sch", exportKicadSch({ ...doc, probes }, name.replace(/\.kicad_sch$/, "")))
      if (p) toast.success(`Exported ${p.split("/").pop()}`, { description: "Opens in KiCad 8 and 9. Tools → Update Symbols from Library swaps in KiCad's own symbol drawings." })
    } catch (e) { toast.error(String(e instanceof Error ? e.message : e)) }
  }
  const openRecent = async (p: RecentProject) => {
    if (p.id === projectId.current && hasDoc) { setScreen("work"); return }
    if (p.folder) { await openProjectAt(p.folder, p.circuit); return }
    if (!(await confirmDiscard())) return
    let d = p.doc
    if (p.path && isTauri()) {
      try { d = await readDoc(p.path) } catch { toast.warning(`${p.path.split("/").pop()} could not be read — opened the last snapshot`) }
    }
    await ensureSymbols(docSymbols(d))
    loadDoc(d, p.path, p.id, p.id)
  }
  const placeInNew = async (lib: string) => {
    if (!(await confirmDiscard())) return
    loadDoc({ ...emptyDoc(), defaultAnalysis: getSettings().newAnalysis }, null, "new")
    startPlace(lib)
  }
  // native menu bar: File → Examples…
  const examplesRef = useRef(() => { setScreen("work"); setExamplesOpen(true) })

  useEffect(() => {
    if (!isTauri()) return
    ;(async () => {
      try {
        const { Menu, MenuItem, PredefinedMenuItem, Submenu } = await import("@tauri-apps/api/menu")
        const menu = await Menu.default()
        for (const item of await menu.items()) {
          if (item instanceof Submenu && (await item.text()) === "File") {
            await item.insert([
              await MenuItem.new({ id: "home", text: "Start Screen", accelerator: "CmdOrCtrl+Shift+H", action: () => menuRef.current.home() }),
              await MenuItem.new({ id: "examples", text: "Examples…", accelerator: "CmdOrCtrl+Shift+E", action: () => examplesRef.current() }),
              await MenuItem.new({ id: "import", text: "Import Kirk / KiCad / Netlist…", accelerator: "CmdOrCtrl+I", action: () => menuRef.current.import() }),
              await PredefinedMenuItem.new({ item: "Separator" }),
              await MenuItem.new({ id: "settings", text: "Settings…", accelerator: "CmdOrCtrl+,", action: () => menuRef.current.settings() }),
              await PredefinedMenuItem.new({ item: "Separator" }),
            ], 0)
          }
        }
        await menu.setAsAppMenu()
      } catch { /* the in-app File menu still works */ }
    })()
  }, [])

  useEffect(() => {
    ngspiceVersion().then(setEngine)
    const how = getSettings().openOnLaunch
    const last = getProjects()[0]
    if (how === "last" && last) { openRecent(last) }
    else if (how !== "start") loadDoc({ ...emptyDoc(), defaultAnalysis: getSettings().newAnalysis }, null, "new")
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- settings → engine, netlister, workspace
  useEffect(() => {
    const n = (t: string) => parseSI(t) ?? undefined
    setSolverOptions({ reltol: n(settings.reltol), abstol: n(settings.abstol), vntol: n(settings.vntol), gmin: n(settings.gmin), method: settings.method, saveCurrents: settings.saveCurrents })
    setEngineOptions({ bin: settings.ngspicePath, autoRecover: settings.autoRecover, engine: settings.engineKind })
  }, [settings.reltol, settings.abstol, settings.vntol, settings.gmin, settings.method, settings.saveCurrents, settings.ngspicePath, settings.autoRecover, settings.engineKind])
  useEffect(() => { setMode(settings.runMode) }, [settings.runMode])
  useEffect(() => { setOverlays((o) => ({ ...o, flow: settings.overlayFlow, volt: settings.overlayVolt, tags: settings.overlayTags })) }, [settings.overlayFlow, settings.overlayVolt, settings.overlayTags])
  useEffect(() => { if (engine !== undefined) ngspiceVersion().then(setEngine) }, [settings.ngspicePath]) // eslint-disable-line react-hooks/exhaustive-deps

  const confirmDiscard = async () => {
    if (!hasDoc || doc === savedDoc || !getSettings().confirmDiscard) return true
    return isTauri() ? ask("Discard unsaved changes to this circuit?", { title: "Unsaved changes", kind: "warning", okLabel: "Discard", cancelLabel: "Keep editing" }) : window.confirm("Discard unsaved changes?")
  }
  // ---- project actions
  const projectRef = useRef(project); projectRef.current = project
  const circuitFileRef = useRef(circuitFile); circuitFileRef.current = circuitFile
  /** open a circuit file of a project in the workspace */
  const openCircuit = async (p: Project, file: string) => {
    const { doc: d, text, diagnostics } = await loadCircuit(p, file, projectResolver(p, folders ? { fs: appFS(), root: folders.libraries } : null))
    await ensureSymbols(docSymbols(d))
    loadDoc(d, null, `${p.root}/${file}`, `prj:${p.root}/${file}`)
    setProject(p); setCircuitFile(file)
    fromCode.current = d
    setCode(text); setKirkDiag(diagnostics as never); setCodeBroken(false)
    rememberProject({ id: `prj:${p.root}/${file}`, title: d.title, path: null, analysis: d.defaultAnalysis, simulated: false, doc: d, folder: p.root, circuit: file }, getSettings().recentLimit)
  }
  const openProjectAt = async (root: string, circuit?: string) => {
    if (!(await confirmDiscard())) return
    try {
      const p = await openProject(appFS(), root)
      const file = circuit && (await p.fs.exists(`${p.root}/${circuit}`)) ? circuit : p.manifest.main
      await openCircuit(p, file)
      toast.success(`Opened project ${p.manifest.name}`)
    } catch (e) { toast.error(String(e instanceof Error ? e.message : e)) }
  }
  const pickProject = async () => {
    if (isTauri()) {
      const { open: pick } = await import("@tauri-apps/plugin-dialog")
      const dir = await pick({ directory: true, multiple: false, defaultPath: folders?.projects })
      if (typeof dir === "string") await openProjectAt(dir)
      return
    }
    // web preview: projects live in the browser; open the most recent one
    const roots = folders ? (await appFS().list(folders.projects).catch(() => [])).filter((e) => e.dir) : []
    if (!roots.length) { toast("No projects yet — create one with New project"); return }
    await openProjectAt(roots[roots.length - 1].path)
  }
  const createNewProject = async (r: NewProjectRequest) => {
    if (!(await confirmDiscard())) return
    const kirk = r.fromCurrent && hasDoc ? generateKirk({ ...doc, probes, dmm: dmm ?? undefined }, netlist) : undefined
    const p = await createProject(appFS(), r.parent, r.name, kirk, r.description || undefined)
    if (r.fromCurrent && hasDoc && doc.pcb) await saveCircuit(p, p.manifest.main, { ...doc, probes })
    await openCircuit(p, p.manifest.main)
    setScreen("work")
    toast.success(`Created project ${p.manifest.name}`, { description: p.root })
  }
  const openProjectFileRef = useRef<(f: string) => Promise<void>>(async () => {})
  const openProjectFile = async (file: string) => {
    if (!project) return
    const sketch = sketchFolderOf(file)
    if (sketch) {
      try { openSketch(await loadSketch(project, sketch), sketch, "work") } catch (e) { toast.error(String(e instanceof Error ? e.message : e)) }
      return
    }
    if (file.startsWith("lib/")) {
      const text = await project.fs.read(`${project.root}/${file}`)
      setLibEdit({ title: file.split("/").pop()!.replace(/\.kirk$/, ""), where: `${project.root}/${file}`, text, back: "work",
        save: async (t) => { await project.fs.write(`${project.root}/${file}`, t); refreshTree() } })
      setScreen("library")
      return
    }
    if (file === circuitFile) return
    if (!(await confirmDiscard())) return
    try { await openCircuit(project, file) } catch (e) { toast.error(String(e instanceof Error ? e.message : e)) }
  }
  openProjectFileRef.current = openProjectFile
  const newProjectCircuit = async () => {
    if (!project) return
    const name = window.prompt("Name of the new circuit", "Circuit 2")
    if (!name) return
    try { const f = await newCircuit(project, name); refreshTree(); await openProjectFile(f) } catch (e) { toast.error(String(e instanceof Error ? e.message : e)) }
  }
  const newProjectLibrary = async () => {
    if (!project) return
    const name = window.prompt("Name of the component library (one word)", "MyParts")
    if (!name) return
    try { const f = await newLibraryFile(project, name); refreshTree(); await openProjectFile(f) } catch (e) { toast.error(String(e instanceof Error ? e.message : e)) }
  }
  // ── microcontroller sketches ──
  /** the sketch's (first) board by name, for the recent list: "Arduino Uno", "Raspberry Pi 5" */
  const boardName = (d: SketchDoc) => { const t = d.diagram.parts.find((p) => isBoardType(p.type))?.type; return (t && boardByType(t)?.name) ?? "" }
  const openSketch = (doc: SketchDoc, folder: string | null, back: "start" | "work", standaloneRoot?: string) => {
    let where = folder
    // a sketch of the open project saves through it; anything else saves straight to its folder
    const inProject = project && !standaloneRoot ? project : null
    const remember = (root: string, f: string, d: SketchDoc, projectName?: string) => {
      rememberSketch({ path: joinPath(root, f), name: d.name, root, folder: f, project: projectName, board: boardName(d), parts: d.diagram.parts.length, diagram: d.diagram })
    }
    const save = async (d: SketchDoc) => {
      if (inProject) {
        if (!where?.startsWith("firmware/")) where = await newSketch(inProject, d.name, d)
        else await saveSketch(inProject, where, d)
        refreshTree()
        remember(inProject.root, where, d, inProject.manifest.name)
        setMcu((m) => (m ? { ...m, where: `${inProject.root}/${where}` } : m))
        return
      }
      // no project: ~/Documents/Space Bench/Sketches/<name>/ (or the folder it was opened from)
      if (!folders && !standaloneRoot) throw new Error("No folder to save into")
      const root = standaloneRoot ?? joinPath(dirName(folders!.projects), "Sketches")
      const pseudo = { fs: appFS(), root, manifest: {} as never }
      if (!where) {
        const base = d.name.trim().replace(/[\\/:*?"<>|]+/g, "-") || "sketch"
        where = base
        for (let i = 2; await appFS().exists(joinPath(root, where)); i++) where = `${base}-${i}`
      }
      await saveSketch(pseudo, where, d)
      remember(root, where, d, root.includes("/firmware") || where.startsWith("firmware/") ? root.split("/").pop() : undefined)
      setMcu((m) => (m ? { ...m, where: joinPath(root, where!) } : m))
    }
    const root = standaloneRoot ?? inProject?.root
    if (folder && root) remember(root, folder, doc, inProject?.manifest.name ?? (folder.startsWith("firmware/") ? root.split("/").pop() : undefined))
    setMcu({ doc, where: folder && root ? joinPath(root, folder) : undefined, save, back, key: Date.now() })
    setScreen("mcu")
  }
  // ── Trash: deleting moves folders to ~/Documents/Space Bench/Trash ──
  const trashRoot = folders ? joinPath(dirName(folders.projects), "Trash") : null
  const [trashVersion, setTrashVersion] = useState(0)
  const toTrash = async (path: string, kind: TrashItem["kind"], name: string, after: () => void) => {
    if (!trashRoot) return
    try {
      const item = await moveToTrash(appFS(), trashRoot, path, kind, name)
      after(); setTrashVersion((v) => v + 1)
      toast(`Moved ${name} to the Trash`, { action: { label: "Undo", onClick: async () => { const to = await restoreFromTrash(appFS(), item); if (kind === "sketch") rememberRestored(to); setTrashVersion((v) => v + 1); toast.success(`Restored ${name}`) } } })
    } catch (e) { toast.error(`Could not delete ${name}: ${e instanceof Error ? e.message : e}`) }
  }
  /** a restored sketch goes back on the recent list */
  const rememberRestored = async (path: string) => {
    try {
      const root = dirName(path), folder = path.slice(root.length + 1)
      const d = await loadSketch({ fs: appFS(), root, manifest: {} as never }, folder)
      rememberSketch({ path, name: d.name, root, folder, board: boardName(d), parts: d.diagram.parts.length, diagram: d.diagram })
    } catch { /* not a sketch folder */ }
  }
  const deleteSketch = (r: RecentSketch) => toTrash(r.path, "sketch", r.name, () => forgetSketch(r.path))
  const deleteProject = (r: RecentProject) => {
    if (!r.folder) return
    if (project?.root === r.folder) { toast.error("Close the project before deleting it"); return }
    toTrash(r.folder, "project", r.title.split(" · ")[0] || r.folder.split("/").pop()!, () => { for (const x of getProjects()) if (x.folder === r.folder) forgetProject(x.id) })
  }
  /** A sketch from the Start screen's recent list (saved where it was). */
  const openRecentSketch = async (r: RecentSketch) => {
    try { openSketch(await loadSketch({ fs: appFS(), root: r.root, manifest: {} as never }, r.folder), r.folder, "start", r.root) }
    catch (e) { forgetSketch(r.path); toast.error(`Could not open ${r.name}: ${e instanceof Error ? e.message : e}`) }
  }
  const openSketchRef = useRef(openSketch)
  openSketchRef.current = openSketch
  const newSketchDoc = (boardType = "wokwi-arduino-uno") => {
    const b = blankSketch(boardType)
    openSketch({ name: "My sketch", files: b.files, diagram: b.diagram }, null, screen === "work" ? "work" : "start")
  }
  const openMcuExample = (id: string) => {
    const e = MCU_EXAMPLES.find((x) => x.id === id)
    if (e) openSketch({ name: e.title, files: e.files.map((f) => ({ ...f })), diagram: structuredClone(e.diagram) }, null, screen === "work" ? "work" : "start")
  }
  /** Sketches saved without a project (~/Documents/Space Bench/Sketches) and the open project's firmware/. */
  const listSketches = useCallback(async () => {
    const out: { name: string; where: string; open: () => void }[] = []
    if (project) for (const e of await project.fs.list(`${project.root}/firmware`).catch(() => [])) if (e.dir) out.push({ name: e.name, where: `${project.manifest.name}/firmware/${e.name}`, open: () => openProjectFileRef.current(`firmware/${e.name}/sketch.ino`) })
    if (folders) {
      const root = joinPath(dirName(folders.projects), "Sketches")
      for (const e of await appFS().list(root).catch(() => [])) if (e.dir) out.push({ name: e.name, where: e.path, open: async () => {
        try { const pseudo = { fs: appFS(), root, manifest: {} as never }; openSketchRef.current(await loadSketch(pseudo, e.name), e.name, "start", root) } catch (err) { toast.error(String(err instanceof Error ? err.message : err)) }
      } })
    }
    return out
  }, [project, folders])
  const newProjectSketch = async () => {
    if (!project) return
    const name = window.prompt("Name of the new sketch", "Sketch")
    if (!name) return
    try { const f = await newSketch(project, name); refreshTree(); await openProjectFile(`${f}/sketch.ino`) } catch (e) { toast.error(String(e instanceof Error ? e.message : e)) }
  }
  const revealInFinder = isTauri() ? async (file: string) => { const { revealItemInDir } = await import("@tauri-apps/plugin-opener"); if (project) await revealItemInDir(file ? `${project.root}/${file}` : project.root) } : null
  const closeProject = async () => { if (!(await confirmDiscard())) return; clearChat(chatKey); setProject(null); setCircuitFile(null); setTree([]); setLeftTab("parts"); goHome() }

  const onNew = async () => { if (await confirmDiscard()) loadDoc({ ...emptyDoc(), defaultAnalysis: getSettings().newAnalysis }, null, "new") }
  const onOpen = async () => {
    if (!(await confirmDiscard())) return
    try {
      const r = await openDoc()
      if (r) {
        await ensureSymbols(docSymbols(r.doc))
        const known = r.path ? getProjects().find((x) => x.path === r.path) : undefined
        loadDoc(r.doc, r.path, r.path ?? r.name, known?.id); toast.success(`Opened ${r.name}`)
        rememberProject({ id: projectId.current, title: r.doc.title, path: r.path, analysis: r.doc.defaultAnalysis, simulated: false, doc: r.doc }, getSettings().recentLimit)
      }
    } catch (e) { toast.error(String(e instanceof Error ? e.message : e)) }
  }
  const onSave = async () => {
    if (project && circuitFile) {
      try {
        const d = { ...doc, defaultAnalysis: analysis, probes, dmm: dmm ?? undefined }
        // the code as typed when it is what's drawn (comments kept), else generated from the drawing
        await saveCircuit(project, circuitFile, d, view !== "schematic" && !codeBroken && fromCode.current === doc ? code : undefined)
        setSavedDoc(doc); refreshTree()
        toast.success(`Saved ${circuitFile}`)
        rememberCurrent()
      } catch (e) { toast.error(String(e instanceof Error ? e.message : e)) }
      return
    }
    try {
      const d = { ...doc, defaultAnalysis: analysis, probes }
      const p = await saveDoc(d, path)
      if (p) {
        setPath(p); setSavedDoc(doc); toast.success(`Saved ${p.split("/").pop()}`)
        rememberProject({ id: projectId.current, title: d.title, path: p, analysis: d.defaultAnalysis, simulated: simulatedRef.current, doc: d }, getSettings().recentLimit)
      } else if (!isTauri()) { setSavedDoc(doc); toast.success("Downloaded the .sbc file") }
    } catch (e) { toast.error(String(e instanceof Error ? e.message : e)) }
  }

  // ---- placement (multi-unit symbols continue with the next unit of the same reference)
  const startPlace = async (lib: string, unit = 1, ref: string | null = null) => {
    try {
      const sym = await loadSymbol(lib)
      setSymbolsReady((n) => n + 1)
      setPlacing({ lib, unit, ref }); setSelection(emptySelection())
      if (unit === 1 && !ref) { setGhostRot(0); setGhostMirror(false) }
      setTool({ kind: "place", part: defaultPart(sym, unit) })
    } catch (e) { toast.error(String(e instanceof Error ? e.message : e)) }
  }
  const place = (at: Pt) => {
    if (tool.kind !== "place" || !placing) return
    const sym = getSymbol(placing.lib)
    if (!sym) return
    const ref = placing.ref ?? nextRef(doc.parts, sym.power ? "#PWR" : isLabel(tool.part) ? "#LBL" : sym.refPrefix)
    const part = { ...tool.part, id: uid("p"), ref, x: at[0], y: at[1], rot: ghostRot, mirror: ghostMirror || undefined }
    if (isLabel(part)) part.net = nextLabel(doc)
    commit(addPart(doc, part))
    pushRecent(placing.lib)
    if (sym.units.length > 1 && placing.unit < sym.units.length) {
      toast(`${ref}${unitLetter(placing.unit)} placed — now place unit ${unitLetter(placing.unit + 1)} (Esc to stop)`)
      startPlace(placing.lib, placing.unit + 1, ref)
    } else if (sym.units.length > 1) {
      startPlace(placing.lib, 1, null)
    }
  }
  const selectTool = (t: ToolKind) => { setTool({ kind: t }); setPlacing(null) }
  const rotate = () => {
    if (tool.kind === "place") setGhostRot((r) => (((r + 90) % 360) as Rot))
    else if (selection.parts.size) commit(rotateParts(doc, selection.parts))
  }
  const mirror = () => {
    if (tool.kind === "place") setGhostMirror((m) => !m)
    else if (selection.parts.size) commit(mirrorParts(doc, selection.parts))
  }
  const duplicate = () => {
    if (!selection.parts.size && !selection.wires.size) return
    const r = duplicateSelection(doc, selection)
    commit(r.doc); setSelection(r.sel)
  }
  const removeProbe = (signal: string) => {
    setProbes((p) => p.filter((x) => x !== signal))
    if (dmm === signal) setDmm(null)
  }
  const remove = () => {
    if (!selection.parts.size && !selection.wires.size) return
    commit(deleteSelection(doc, selection)); setSelection(emptySelection())
  }
  /** Probe tool: clicking a wire / part adds its probe (like LTspice; removing is the × on the flag or channel). */
  const addProbe = (signal: string) => {
    if (probes.includes(signal)) { setTab("scope"); toast(`${signal} is already on CH${probes.indexOf(signal) + 1}`); return }
    setProbes((p) => [...p, signal])
    if (signal.startsWith("I") && getSettings().autoDmm) setDmm(signal)
    if (getSettings().scopeOnProbe) setTab("scope")
    if (analysis === "op") setAnalysis("tran")
    toast(`Probing ${signal}`)
  }

  // ---- keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      const k = e.key.toLowerCase()
      // app-wide (also on the Start and Settings screens, and from text fields)
      if (mod && e.key === ",") { e.preventDefault(); openSettings(); return }
      if (mod && e.shiftKey && k === "h") { e.preventDefault(); if (screen === "mcu") setScreen("start"); else goHome(); return }
      if (screen === "mcu") return // the microcontroller workspace has its own keys
      if (mod && e.shiftKey && k === "a") { e.preventDefault(); newSketchDoc(); return }
      if ((e.target as HTMLElement)?.closest?.("input,textarea,[contenteditable],[role=combobox],[role=listbox],[role=dialog]")) return
      if (mod && e.shiftKey && k === "n") { e.preventDefault(); onNewFromCode(); return }
      if (mod && e.shiftKey && k === "p") { e.preventDefault(); setNewProjectOpen(true); return }
      if (mod && k === "i") { e.preventDefault(); onImport(); return }
      if (mod && k === "j" && screen === "work") { e.preventDefault(); if (aiOpen && view !== "schematic") setAiOpen(false); else openAi(); return }
      if (screen !== "work") {
        if (mod && k === "n") { e.preventDefault(); onNew() }
        else if (mod && k === "o") { e.preventDefault(); onOpen() }
        else if (e.key === "Escape" && screen === "settings") setScreen(settingsFrom === "work" && hasDoc ? "work" : "start")
        return
      }
      if (e.key === "F5") { e.preventDefault(); setPaused(false); runMany(doc, analysis) }
      else if (mod && k === "z") { e.preventDefault(); if (e.shiftKey) history.redo(); else history.undo() }
      else if (mod && k === "y") { e.preventDefault(); history.redo() }
      else if (mod && k === "s") { e.preventDefault(); onSave() }
      else if (mod && k === "o") { e.preventDefault(); onOpen() }
      else if (mod && k === "n") { e.preventDefault(); onNew() }
      else if (mod && k === "r") { e.preventDefault(); rotate() }
      else if (mod && k === "d") { e.preventDefault(); duplicate() }
      else if (mod && k === "k") { e.preventDefault(); setBrowser({ open: true }) }
      else if (mod && e.shiftKey && k === "e") { e.preventDefault(); setExamplesOpen(true) }
      else if (mod && k === "e") { e.preventDefault(); if (view === "schematic") { regenerate(); setView("split") } else setView("schematic") }
      else if (mod && k === "a") { e.preventDefault(); setSelection({ parts: new Set(doc.parts.map((p) => p.id)), wires: new Set(doc.wires.map((w) => w.id)) }) }
      else if (mod) return
      else if (e.key === "Escape") { setTool({ kind: "select" }); setPlacing(null); setSelection(emptySelection()) }
      else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); remove() }
      else if (k === "x" && e.shiftKey) selectTool("noconnect")
      else if (k === "h") selectTool("pan")
      else if (e.key === " " && tool.kind !== "place") { e.preventDefault(); togglePlay() }
      else if (k === "w") selectTool("wire")
      else if (k === "p") selectTool("probe")
      else if (k === "a") { e.preventDefault(); setBrowser({ open: true }) }
      else if (k === "x" || k === "y") mirror()
      else if (k === "r" && tool.kind === "place") rotate()
      else {
        const item = LIBRARY.flatMap((g) => g.items).find((i) => i.hotkey?.toLowerCase() === k)
        if (item) startPlace(item.id)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  const part = selection.parts.size === 1 ? doc.parts.find((p) => selection.parts.has(p.id)) ?? null : null
  useEffect(() => { if (part) setAside("inspector") }, [part?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (part && isProgrammable(part)) { setFwActive(part.ref); setFwOpen(true) } }, [part?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const playback = usePlayback(result, live && !cosim.active && result !== cosimWindow.current)
  useEffect(() => { playback.setSpeed(settings.playbackSpeed) }, [settings.playbackSpeed]) // eslint-disable-line react-hooks/exhaustive-deps
  const tranResult = result?.type === "tran" ? result : null
  const shownValues = useMemo(() => {
    const base = { ...opValues, ...(result?.type === "op" ? finalValues(result) : {}) }
    return tranResult && playback.t !== null ? { ...base, ...valuesAt(tranResult, playback.t) } : base
  }, [opValues, result, tranResult, playback.t])
  /** ▶/⏸: pause, play the transient, or run one first when there is nothing to play. */
  const togglePlay = () => {
    // ⏸ also holds real-time re-runs, so the circuit stays still while you edit
    if (playback.playing) { playback.pause(); setPaused(true); return }
    const wasPaused = paused
    setPaused(false)
    playback.play()
    if (result?.type === "tran") return
    // real-time mode re-runs by itself when the analysis changes or it leaves pause
    if (analysis !== "tran") setAnalysis("tran")
    if (!(live && (wasPaused || analysis !== "tran"))) run(doc, "tran")
  }
  const wireFlow = useMemo(() => wireCurrents(doc, netlist, shownValues), [doc, netlist, shownValues])
  // AC results feed the Bode plotter; transients feed the recorder while it records
  useEffect(() => {
    if (result?.type === "ac") setLastAc(result)
    if (result?.type === "tran" && getRecorder().recording) addFrame(result, `${doc.title} · ${new Date().toLocaleTimeString()}`)
  }, [result]) // eslint-disable-line react-hooks/exhaustive-deps
  // speakers and buzzers: play the transient through the computer while it plays on screen
  useEffect(() => {
    if (!playback.playing || result?.type !== "tran" || !settings.outputSound) { stopOutputs(); return }
    const sounding = doc.parts.filter((p) => { const k = outputKind(p); return k === "speaker" || k === "buzzer" })
      .map((p) => { const k = result.names.indexOf(`I(${p.ref})`); const peak = k < 0 ? 0 : result.data[k].reduce((m, v) => Math.max(m, Math.abs(v)), 0); return { ref: p.ref, level: outputState(p, { [`I(${p.ref})`]: peak })?.level ?? 0 } })
      .filter((x) => x.level > 0.02)
    playOutputs(result, sounding, `${result.time.length}:${result.time[result.time.length - 1]}:${sounding.map((x) => `${x.ref}@${x.level.toFixed(2)}`).join(",")}`)
  }, [playback.playing, result, settings.outputSound, doc.parts])
  useEffect(() => () => stopOutputs(), [])
  /** Bode "Sweep": an AC analysis in the background (the scope keeps its transient). */
  const sweepAc = async () => {
    const nl = deriveNetlist(doc)
    const net = buildNetlist(doc, nl, "ac")
    if ([...nl.issues, ...net.issues].some((i) => i.severity === "error")) { toast.error("Fix the ERC errors first"); return }
    setSweeping(true)
    try { const r = await simulate(net); if (r.type === "ac") setLastAc(r) } catch (e) { toast.error(`AC sweep failed: ${String(e instanceof Error ? e.message : e).split("\n")[0]}`) } finally { setSweeping(false) }
  }
  const openInstrument = (t: string) => {
    if (t === "scope" && !probes.length) toast("Probe a wire with P to connect a scope channel")
    setTab(t); setDockMax(false)
  }
  const fgFlag: ProbeFlag[] = useMemo(() => {
    const src = doc.parts.find((q) => /^Simulation_SPICE:V(SIN|PULSE)$/.test(q.lib))
    if (!src) return []
    const g = readGen(src), sh = shapeOf(src)
    return [{ signal: `I(${src.ref})`, label: "FG1", color: "#7c3aed", removable: false, value: `${sh} ${formatSI(g.f, "Hz", 3)} · ${formatSI(g.amp * 2, "Vpp", 3)}` }]
  }, [doc.parts])
  const probeFlags: ProbeFlag[] = useMemo(() => [
    ...fgFlag,
    ...probes.map((s, i) => ({ signal: s, label: `CH${i + 1}`, color: CHANNEL_COLORS[i % CHANNEL_COLORS.length] })),
    ...(dmm && !probes.includes(dmm) ? [{ signal: dmm, label: "DMM", color: "var(--warning)", value: shownValues[dmm] !== undefined ? formatSI(shownValues[dmm], dmm.startsWith("I") ? "A" : "V", 3) : undefined }] : []),
  ], [probes, dmm, shownValues, fgFlag])
  const series = useCallback((signal: string) => {
    if (!result || (result.type !== "tran" && result.type !== "dc")) return null
    const k = result.names.indexOf(signal)
    return k < 0 ? null : { x: result.type === "tran" ? result.time : result.sweep, y: result.data[k] }
  }, [result])
  const hoverText = hoverInfo ? (() => {
    const parts = [`Hover ${hoverInfo.kind === "net" ? "net" : ""} ${hoverInfo.name}`.replace("  ", " ")]
    if (hoverInfo.v !== undefined) parts.push(formatSI(hoverInfo.v, "V", 4))
    if (hoverInfo.i !== undefined) parts.push(formatSI(hoverInfo.i, "A", 3))
    if (hoverInfo.signal && tranResult && playback.t !== null) {
      const k = tranResult.names.indexOf(hoverInfo.signal)
      if (k >= 0) {
        const t = tranResult.time, y = tranResult.data[k]
        let j = 1
        while (j < t.length - 1 && t[j] < playback.t) j++
        const d = (y[j] - y[j - 1]) / (t[j] - t[j - 1] || 1)
        parts.push(`d/dt ${formatSI(d, hoverInfo.signal.startsWith("I") ? "A/s" : "V/s", 3)}`)
      }
    }
    return parts.join(" · ")
  })() : null
  const electrical = doc.parts.filter((p) => !isVirtual(p)).length
  const inProject = useMemo(() => {
    const n = new Map<string, number>()
    for (const p of doc.parts) if (!isVirtual(p)) n.set(p.lib, (n.get(p.lib) ?? 0) + 1)
    return [...n].sort((a, b) => b[1] - a[1]).map(([id]) => id)
  }, [doc.parts])

  return (
    <TooltipProvider delayDuration={300}>
      {screen === "start" && (
        <ErrorBoundary name="Start screen"><StartScreen page={startPage} setPage={setStartPage} dark={dark} onToggleTheme={toggleTheme} engine={engine}
          current={hasDoc ? { title: doc.title, dirty: doc !== savedDoc } : null} onResume={() => setScreen("work")}
          onNewSchematic={onNew} onNewFromCode={(c) => { onNewFromCode(c) }} onImport={onImport} onOpen={onOpen} onOpenRecent={openRecent}
          onOpenExample={async (id) => { if (await confirmDiscard()) openExample(id) }} onPlacePart={placeInNew}
          onSettings={() => openSettings()} showAllParts={showAllParts}
          onNewProject={() => setNewProjectOpen(true)} onOpenProject={pickProject}
          onDeleteSketch={deleteSketch} onDeleteProject={deleteProject}
          trash={{ fs: appFS(), root: trashRoot, version: trashVersion, onRestored: (item, to) => { if (item.kind === "sketch") rememberRestored(to) } }}
          onNewSketch={newSketchDoc} onOpenMcuExample={openMcuExample} partsRoot={folders ? joinPath(dirName(folders.projects), "Parts") : null} arduinoCliPath={settings.arduinoCliPath} listSketches={listSketches} onOpenSketch={openRecentSketch}
          libraries={{
            fs: appFS(), root: folders?.libraries ?? null, projectName: project?.manifest.name ?? null,
            onEdit: async (lib) => {
              const text = await appFS().read(lib.file)
              setLibEdit({ title: lib.name, where: lib.file, text, back: "start", save: (t) => appFS().write(lib.file, t) })
              setScreen("library")
            },
            onAddToProject: async (lib, how) => {
              if (!project || !folders) return
              if (how === "copy") { const f = await copyIntoProject(appFS(), folders.libraries, lib.name, project.root, project.fs); refreshTree(); toast.success(`Copied ${lib.name} into ${f}`, { description: `Use it with  import "${f}"` }); return }
              // add  import library "Name"  to the open circuit's code
              const line = `import library "${lib.name}"`
              const cur = view === "schematic" ? generateKirk({ ...doc, probes, dmm: dmm ?? undefined }, netlist) : code
              if (cur.includes(line)) { toast(`${project.manifest.name} already imports ${lib.name}`); return }
              setScreen("work"); setView(view === "schematic" ? "split" : view)
              onCodeChange(`${line}\n${cur}`)
              toast.success(`${circuitFile ?? "The circuit"} now imports ${lib.name}`)
            },
          }} /></ErrorBoundary>
      )}
      {screen === "mcu" && mcu && (
        <ErrorBoundary name="Microcontroller workspace">
          <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-muted-foreground"><Loader2 className="mr-2 size-4 animate-spin" /> Loading the microcontroller workspace…</div>}>
            <McuWorkspace key={mcu.key} chatKey={`sketch:${mcu.key}`} doc={mcu.doc}
              onDelete={mcu.where ? () => toTrash(mcu.where!, "sketch", mcu.doc.name, () => { forgetSketch(mcu.where!); clearChat(`sketch:${mcu.key}`); setScreen(mcu.back === "work" && hasDoc ? "work" : "start"); setMcu(null) }) : undefined} where={mcu.where} dark={dark} onToggleTheme={toggleTheme} onSave={async (d) => { await mcu.save(d) }} onOpenSettings={() => openSettings("microcontrollers")}
              onBack={async () => {
                setScreen(mcu.back === "work" && hasDoc ? "work" : "start"); clearChat(`sketch:${mcu.key}`); setMcu(null)
              }} />
          </Suspense>
        </ErrorBoundary>
      )}
      {screen === "library" && libEdit && (
        <ErrorBoundary name="Library editor"><LibraryEditor title={libEdit.title} where={libEdit.where} text={libEdit.text} resolve={resolve} onSave={libEdit.save}
          onClose={async (dirty) => {
            if (dirty && !(isTauri() ? await ask("Discard unsaved changes to this library?", { title: "Unsaved changes", kind: "warning", okLabel: "Discard", cancelLabel: "Keep editing" }) : window.confirm("Discard unsaved changes?"))) return
            setScreen(libEdit.back === "work" && hasDoc ? "work" : "start"); setLibEdit(null)
            // circuits that import it pick up the change on their next compile
            if (hasDoc && libEdit.back === "work" && view !== "schematic") onCodeChange(code)
          }} /></ErrorBoundary>
      )}
      {screen === "settings" && (
        <ErrorBoundary name="Settings"><SettingsView section={settingsSection} setSection={setSettingsSection} dark={dark} onToggleTheme={toggleTheme}
          onBack={() => setScreen(settingsFrom === "mcu" && mcu ? "mcu" : settingsFrom === "work" && hasDoc ? "work" : "start")} backLabel={settingsFrom === "mcu" && mcu ? `Back to ${mcu.doc.name}` : settingsFrom === "work" && hasDoc ? `Back to ${doc.title}` : "Back to Start"}
          showAllParts={showAllParts} setShowAllParts={setShowAllParts} /></ErrorBoundary>
      )}
      <div className={screen === "work" ? "flex h-full flex-col" : "hidden"}>
        <TitleBar title={doc.title} dirty={doc !== savedDoc} dark={dark} onToggleTheme={toggleTheme} onNew={onNew} onOpen={onOpen} onSave={onSave} onSearch={() => setBrowser({ open: true })} onExamples={() => setExamplesOpen(true)}
          onImport={onImport} onExportKicad={onExportKicad} onHome={goHome} onSettings={() => openSettings()}
          view={view} setView={(v) => { setAnalysisOpen(false); setRunOpen(false); setPcbOpen(false); if (v !== "schematic" && view === "schematic") regenerate(); setView(v) }}
          analysisOpen={analysisOpen} onAnalysis={() => { setRunOpen(false); setPcbOpen(false); setAnalysisOpen((o) => !o) }}
          runOpen={runOpen} onRuns={() => { setAnalysisOpen(false); setPcbOpen(false); setRunOpen((o) => !o) }} running={running}
          pcbOpen={pcbOpen} onPcb={() => { setAnalysisOpen(false); setRunOpen(false); setPcbOpen((o) => !o) }}
          aiOpen={aiOpen && view !== "schematic" && !pcbOpen && !runOpen && !analysisOpen} onAi={() => (aiOpen && view !== "schematic" && !pcbOpen && !runOpen && !analysisOpen ? setAiOpen(false) : openAi())}
          onLab={() => inputChips.openLab()} labBlocked={labBlocked} />
        <Toolbar
          tool={tool.kind} setTool={selectTool} onLabel={() => startPlace("@:label")} onRotate={rotate} onMirror={mirror} onDuplicate={duplicate} onDelete={remove} onAddPart={() => setBrowser({ open: true })}
          onUndo={history.undo} onRedo={history.redo} canUndo={history.canUndo} canRedo={history.canRedo}
          hasSelection={selection.parts.size + selection.wires.size > 0}
          errors={errors.length} warnings={issues.length - errors.length}
          analysis={analysis} setAnalysis={setAnalysis} running={running || cosim.active}
          onRun={() => { if (boards.length && analysis === "tran") { setFwOpen(true); cosim.start(); return } setPaused(false); runMany(doc, analysis) }}
          analysisDetail={{ tran: formatSI(doc.analyses.tran.stop, "s"), ac: `${formatSI(doc.analyses.ac.start, "Hz")}–${formatSI(doc.analyses.ac.stop, "Hz")}`, op: "", dc: doc.analyses.dc?.source ?? "" }}
          onSetup={() => setSetupDlg({ open: true, section: analysis })} hasDc={!!doc.analyses.dc} progress={progress}
          mode={mode} setMode={setMode} clock={playback.t} playing={playback.playing}
          onPlayPause={togglePlay}
          onStop={() => { stopRun(); cosim.stop(); playback.stop() }}
          canStop={running || cosim.active || playback.t !== null}
          onShowIssues={() => setTab("log")}
          onQuickPlace={(id) => startPlace(id)}
        />
        {analysisOpen && (
          <div className="min-h-0 flex-1">
            <ErrorBoundary name="Analysis view"><AnalysisView sets={resultSets} activeId={activeSet} setActiveId={setActiveSet} themeKey={dark ? "dark" : "light"}
              onExport={(id) => setExportDlg({ open: true, setId: id })}
              onReport={async (set, el) => {
                try {
                  const name = `${set.doc.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-report.html`
                  const p = await saveExport(name, "html", buildReport(set, el))
                  if (p) toast.success(`Report saved: ${p.split("/").pop()}`)
                } catch (e) { toast.error(String(e instanceof Error ? e.message : e)) }
              }} /></ErrorBoundary>
          </div>
        )}
        {runOpen && (
          <div className="min-h-0 flex-1">
            <ErrorBoundary name="Simulation process"><RunView selectedId={runView} setSelectedId={setRunView} activeId={running ? currentRun.current?.id ?? null : null}
              onRerun={() => { setRunView(null); runMany(doc, analysis) }} onViewResults={(id) => { setActiveSet(id); setRunOpen(false); setAnalysisOpen(true) }}
              onExport={(id) => setExportDlg({ open: true, setId: id })} onShowRefs={showRefs}
              onPause={pauseRun} onStop={() => { stopRun() }} /></ErrorBoundary>
          </div>
        )}
        {pcbOpen && (
          <div className="min-h-0 flex-1">
            <ErrorBoundary name="PCB editor"><PcbView doc={doc} netlist={netlist} onChange={(pcb) => commit({ ...doc, pcb })}
              onFootprint={(id, footprint) => commit(updatePart(doc, id, { footprint }))} /></ErrorBoundary>
          </div>
        )}
        <div className={analysisOpen || runOpen || pcbOpen ? "hidden" : "flex min-h-0 flex-1"}>
          {view !== "schematic" && (
            <div className={view === "code" ? "min-w-0 flex-1" : "shrink-0"} style={view === "split" ? { width: clamp(codeW, 320, window.innerWidth - 480) } : undefined}>
              <CodePanel view={view} setView={setView} fileName={`${doc.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "circuit"}.kirk`} dirty={doc !== savedDoc}
                code={code} onChange={onCodeChange} diagnostics={kirkDiag} compileMs={compileMs} compiling={compiling} inSync={!codeBroken}
                onFormat={regenerate} onResync={regenerate} doc={doc} netlist={netlist} values={shownValues}
                measures={measured.measures} asserts={measured.asserts} ercErrors={errors.length}
                onCursorRef={(ref) => { if (!ref) return; const ids = doc.parts.filter((p) => p.ref === ref).map((p) => p.id); if (ids.length && !ids.every((id) => selection.parts.has(id))) setSelection({ parts: new Set(ids), wires: new Set() }) }}
                aiOpen={aiOpen} onToggleAi={() => (aiOpen ? setAiOpen(false) : openAi())}
                ai={<ErrorBoundary name="AI assistant"><AiChat host={aiHost} sessionKey={chatKey} request={aiAsk} onOpenSettings={() => openSettings("ai")} onOpenTerminal={() => { setTab("terminal"); setDockMax(false) }} onClose={() => setAiOpen(false)} /></ErrorBoundary>} />
            </div>
          )}
          {view === "split" && <Splitter axis="x" onDrag={(d) => setCodeW((w) => clamp(w + d, 320, window.innerWidth - 480))} onReset={() => setCodeW(640)} />}
          {view === "schematic" && (project ? (
            <div className="flex w-[260px] shrink-0 flex-col border-r">
              <div className="flex shrink-0 gap-1 border-b p-1.5">
                {([["project", "Project"], ["parts", "Parts"]] as const).map(([k, l]) => (
                  <button key={k} onClick={() => setLeftTab(k)} className={`h-7 flex-1 rounded-md text-xs ${leftTab === k ? "bg-accent font-medium" : "text-muted-foreground hover:text-foreground"}`}>{l}</button>
                ))}
              </div>
              <div className="min-h-0 flex-1 [&>*]:h-full [&>*]:w-full [&>*]:border-r-0">
                {leftTab === "project"
                  ? <ProjectPanel project={project} tree={tree} active={circuitFile} dirty={doc !== savedDoc} onOpen={openProjectFile} onNewCircuit={newProjectCircuit} onNewLibrary={newProjectLibrary} onNewSketch={newProjectSketch} onRefresh={refreshTree} onReveal={revealInFinder} onClose={closeProject} />
                  : <PartsSidebar onPlace={(id) => startPlace(id)} onBrowse={(q) => setBrowser({ open: true, q })} placing={placing?.lib ?? null} recent={recent} showAll={showAllParts} onShowAll={setShowAllParts} inProject={inProject} />}
              </div>
            </div>
          ) : <PartsSidebar
            onPlace={(id) => startPlace(id)} onBrowse={(q) => setBrowser({ open: true, q })} placing={placing?.lib ?? null} recent={recent} showAll={showAllParts} onShowAll={setShowAllParts} inProject={inProject} />)}
          <main className={view === "code" ? "flex w-[min(46%,820px)] shrink-0 flex-col border-l" : "flex min-w-0 flex-1 flex-col"}>
            <div className={view === "code" ? "hidden" : "relative min-h-0 flex-1"}>
              <button onClick={() => { setAside("instruments"); setPanelPinned(true) }} title="Instruments & data"
                className="absolute right-3 top-3 z-10 hidden rounded-md border bg-background/90 px-2.5 py-1 text-xs text-muted-foreground whitespace-nowrap shadow-sm backdrop-blur hover:text-foreground md:block">
                <span className="font-medium text-foreground">Root sheet</span> · {electrical} part{electrical === 1 ? "" : "s"} · {netlist.nets.length} nets · {fgFlag.length + probes.length + (dmm && !probes.includes(dmm) ? 1 : 0) + (lastAc ? 1 : 0)} instruments
              </button>
              {boards.length > 0 && !fwOpen && (
                <button onClick={() => setFwOpen(true)} title="Show the boards' sketches"
                  className="absolute right-3 top-12 z-10 hidden rounded-md border bg-background/90 px-2.5 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur hover:text-foreground md:block">
                  <span className="font-medium text-foreground">Firmware</span> · {boards.map((b) => b.ref).join(", ")}
                </button>
              )}
              <SchematicEditor
                doc={doc} netlist={netlist} values={shownValues} live={!error && Object.keys(shownValues).length > 0}
                wireFlow={wireFlow} overlays={overlays} setOverlays={setOverlays} probeFlags={probeFlags} inputs={inputChips} series={series}
                onNoConnect={(at) => commit(toggleNoConnect(doc, at))} onHover={setHoverInfo} onZoom={setZoom}
                selection={selection} setSelection={setSelection}
                tool={tool} ghostRot={ghostRot} ghostMirror={ghostMirror} onCommit={commit} onPlace={place}
                onWire={(p) => commit(addWirePath(doc, p))} onProbe={addProbe} onRemoveProbe={removeProbe}
                onToolDone={() => { setTool({ kind: "select" }); setPlacing(null) }}
                fitKey={fitKey}
              />
            </div>
            {view !== "code" && !dockMax && <Splitter axis="y" onDrag={(d) => setDockH((h) => clamp(h - d, 160, window.innerHeight - 260))} onReset={() => setDockH(340)} />}
            <div className={view === "code" ? "min-h-0 flex-1" : `${dockMax ? "h-[62%] border-t" : ""} shrink-0`} style={view !== "code" && !dockMax ? { height: clamp(dockH, 160, window.innerHeight - 260) } : undefined}>
              <ErrorBoundary name="instrument dock"><InstrumentDock doc={doc} result={result} error={error} probes={probes} setProbes={setProbes} values={shownValues} time={playback.t} onSeek={playback.seek}
                dmm={dmm} setDmm={setDmm} analysis={analysis} setAnalysis={setAnalysis} onChangePart={(id, patch) => commit(updatePart(doc, id, patch))}
                log={log} issues={issues} tab={tab} setTab={setTab} terminal={settings.aiProvider === "claude-code"}
                themeKey={dark ? "dark" : "light"} maximized={dockMax} onToggleMax={() => setDockMax((m) => !m)}
                runs={runs} overlay={doc.setup?.overlay !== false} onClearRuns={() => setRuns(null)} measures={measured.measures} asserts={measured.asserts}
                netlist={netlist} lastAc={lastAc} onSweepAc={sweepAc} sweeping={sweeping} /></ErrorBoundary>
            </div>
          </main>
          {fwOpen && boards.length > 0 && view !== "code" && (
            <>
              <Splitter axis="x" onDrag={(d) => setFwW((w) => clamp(w - d, 360, window.innerWidth - 560))} onReset={() => setFwW(520)} />
              <div className="flex shrink-0 flex-col" style={{ width: clamp(fwW, 360, window.innerWidth - 560) }}>
                <ErrorBoundary name="firmware panel"><FirmwarePanel doc={doc} boards={boards} active={fwActive} setActive={setFwActive}
                  onChange={(ref, fw) => history.replace((d) => ({ ...d, firmware: { ...d.firmware, [ref]: fw } }))}
                  cosim={cosim} dark={dark} onClose={() => setFwOpen(false)} onAskAi={(t) => askAiRef.current(t)} /></ErrorBoundary>
              </div>
            </>
          )}
          <aside className={view !== "code" && (part || panelPinned) ? "flex w-[340px] shrink-0 flex-col border-l" : "hidden"}>
            <div className="flex shrink-0 items-center gap-1 border-b p-1.5">
              {([["inspector", part ? part.ref : "Inspector"], ["instruments", "Instruments & data"]] as const).map(([k, l]) => (
                <button key={k} onClick={() => { setAside(k); if (k === "instruments") setPanelPinned(true) }} className={`h-7 flex-1 rounded-md text-xs ${aside === k ? "bg-accent font-medium" : "text-muted-foreground hover:text-foreground"}`}>{l}</button>
              ))}
              <button title="Close the panel" aria-label="Close the panel" className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => { setPanelPinned(false); if (part) setSelection(emptySelection()) }}>×</button>
            </div>
            <div className="min-h-0 flex-1">
              {aside === "inspector" ? (
                <ErrorBoundary name="inspector"><Inspector doc={doc} netlist={netlist} part={part} values={shownValues}
                  onChangePart={(id, patch) => commit(updatePart(doc, id, patch))}
                  onChangeAnalyses={(a) => commit({ ...doc, analyses: a })} onRotate={rotate} onMirror={mirror}
                  onDuplicate={duplicate} onDelete={remove} series={series} time={playback.t}
                  onAddToSweep={(target) => setSetupDlg({ open: true, section: "sweep", target })} /></ErrorBoundary>
              ) : (
                <ErrorBoundary name="instruments panel"><InstrumentsPanel doc={doc} netlist={netlist} probes={probes} dmm={dmm} result={result} lastAc={lastAc} onOpen={openInstrument} /></ErrorBoundary>
              )}
            </div>
          </aside>
        </div>
        <StatusBar onStatus={() => { setAnalysisOpen(false); setRunView(null); setRunOpen(true) }} text={cosim.status === "running" ? "Simulating · circuit + firmware" : running ? "Simulating…" : errors.length ? `${errors.length} ERC error${errors.length > 1 ? "s" : ""}` : error ? "Last run failed" : playback.playing ? "Simulating · real-time playback" : result ? "Ready" : "Idle"}
          nodes={netlist.nets.length} parts={electrical} ms={ms} path={path} engine={engine} warnings={issues.length - errors.length}
          step={analysis === "tran" ? formatSI(doc.analyses.tran.step, "s") : null} hover={hoverText} zoom={zoom} />
      </div>
      <ErrorBoundary name="export dialog"><ExportDialog open={exportDlg.open} onOpenChange={(o) => setExportDlg((x) => ({ ...x, open: o }))} sets={resultSets} setId={exportDlg.setId}
        math={(() => { try { return JSON.parse(localStorage.getItem("sb-math") ?? "[]") } catch { return [] } })()} /></ErrorBoundary>
      <NewProjectDialog open={newProjectOpen} onOpenChange={setNewProjectOpen} defaultParent={folders?.projects ?? "/Space Bench/Projects"} current={hasDoc && doc.parts.length ? doc.title : null} onCreate={createNewProject} />
      <ExamplesDialog open={examplesOpen} onOpenChange={setExamplesOpen} currentTitle={doc.title} onOpen={async (id) => { if (await confirmDiscard()) openExample(id) }} />
      <SimulationSetup open={setupDlg.open} onOpenChange={(o) => setSetupDlg((x) => ({ ...x, open: o, target: o ? x.target : undefined }))}
        doc={doc} netlist={netlist} section={setupDlg.section} sweepTarget={setupDlg.target} lastMs={ms}
        onApply={applySetup} onRun={(pt) => { const next = applySetup(pt); runMany(next, pt.defaultAnalysis) }} />
      <PartBrowser open={browser.open} initialQuery={browser.q} onOpenChange={(o) => setBrowser((b) => ({ ...b, open: o }))} onPlace={(id) => startPlace(id)} recent={recent} showAll={showAllParts} />
      <Toaster position="bottom-center" theme={dark ? "dark" : "light"} />
      {permission.dialog}
    </TooltipProvider>
  )
}

const lineOf = (src: string, pos: number) => src.slice(0, pos).split("\n").length

function nextLabel(doc: Doc): string {
  const used = new Set(doc.parts.filter(isLabel).map((p) => p.net))
  for (let i = 1; ; i++) if (!used.has(`net${i}`)) return `net${i}`
}
