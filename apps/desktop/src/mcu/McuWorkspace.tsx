// The microcontroller workspace: files on the left, the sketch in Monaco, the board and its
// parts on the canvas, the Serial Monitor below, the AI assistant on the right.
//   Compile (arduino-cli) → Run (avr8js in a worker, with the circuit solved around it).
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowLeft, Bot, Check, ChevronDown, CircleAlert, Cpu, Download, FileCode2, FileJson, FilePlus, FileText, Hammer,
  Loader2, Moon, Pause, Play, Plus, RotateCcw, Save, Search, Send, Square, Sun, Trash2, TriangleAlert, Upload, X, Zap,
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { AiChat } from "@/components/AiChat"
import { Splitter } from "@/components/Splitter"
import { setSettings, useSettings } from "@/lib/settings"
import { cn } from "@/lib/utils"
import { mcuProfile, type McuAgentHost } from "./agent"
import { BOARDS, boardByType, isBoardType, isLinuxBoard } from "./boards"
import { setBuzzers, stopBuzzers } from "./buzzers"
import { Circuit, type PartUi } from "./circuit"
import { cliStatus, compileSketch, coreOf, installCore, parseLibraries, type CompileOutput, type Diagnostic } from "./compile"
import { boardId, diagramText, nextId, parseDiagram, splitEnd, type Diagram, type DiagramPart } from "./diagram"
import { blankFiles, boardDiagram, boardLinks, boardsOf, filesOf, mergeFrames, moveFiles, ownerOf, prefixOf, rehome } from "./multiboard"
import type { SketchFileData } from "./examples"
import { McuCanvas, PART_DRAG, type CanvasApi } from "./McuCanvas"
import { CATEGORIES, PARTS, catalogControls, partInfo, type PartInfo } from "./parts"
import type { Frame, Snapshot } from "./sim"
import type { LiveView } from "./SketchEditor"
import { CheckDialog } from "./CheckDialog"
import { ESP32_BRIDGE, ESP32_BRIDGE_FILE } from "./esp32/bridge"
import { espPoll, espSend, espStart, espStop } from "./esp32/host"
import type { ChipLink } from "@/cosim/chip"
import { linuxChip } from "@/linux/chip"
import { renodeChip } from "@/renode/chip"
import { renodeStage } from "@/renode/host"
import { CHANGES_SYSTEM, checkSetup, installSetup } from "./setup"
import { LogicBuffer } from "./logic"
import { LogicAnalyzer } from "./LogicAnalyzer"
import type { FromWorker, ToWorker } from "./sim.worker"

const SketchEditor = lazy(() => import("./SketchEditor"))

export interface SketchDoc { name: string; files: SketchFileData[]; diagram: Diagram }

const DIAGRAM = "diagram.json"
const SENSOR_CONTROLS: Record<string, { key: "value" | "y"; label: string; min: number; max: number; step: number; unit: string; attr: string }[]> = {
  "wokwi-ntc-temperature-sensor": [{ key: "value", label: "Temperature", min: -40, max: 125, step: 0.5, unit: "°C", attr: "temperature" }],
  "wokwi-photoresistor-sensor": [{ key: "value", label: "Light", min: 0.1, max: 100000, step: 1, unit: "lux", attr: "lux" }],
  "wokwi-hc-sr04": [{ key: "value", label: "Distance", min: 2, max: 400, step: 1, unit: "cm", attr: "distance" }],
  "wokwi-dht22": [{ key: "value", label: "Temperature", min: -40, max: 80, step: 0.5, unit: "°C", attr: "temperature" }, { key: "y", label: "Humidity", min: 0, max: 100, step: 0.5, unit: "%", attr: "humidity" }],
}

type Status = { kind: "idle" } | { kind: "compiling" } | { kind: "ok"; out: CompileOutput } | { kind: "error"; out?: CompileOutput; message?: string }
const fileIcon = (n: string) => (n === DIAGRAM ? FileJson : n.endsWith(".txt") ? FileText : FileCode2)
const langOf = (n: string) => (n.endsWith(".json") ? "json" : n.endsWith(".txt") ? "ini" : n.endsWith(".py") ? "python" : "cpp")
/** a board's main file: the sketch, or main.py on a Linux board */
const isMain = (n: string) => n.endsWith(".ino") || n.endsWith(".py")
const hashOf = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0).toString(36) }

export function McuWorkspace({ doc: initial, chatKey, where, dark, onToggleTheme, onBack, onSave, onOpenSettings, onDelete }: {
  doc: SketchDoc
  /** the AI conversation's session (kept while the sketch is open, even with the panel closed) */
  chatKey?: string
  /** shown under the title: the project folder */
  where?: string
  dark: boolean
  onToggleTheme: () => void
  onBack: (dirty: boolean) => void
  onSave: (doc: SketchDoc) => Promise<void>
  onOpenSettings: () => void
  /** move the sketch's folder to the Trash (only once it is saved somewhere) */
  onDelete?: () => void
}) {
  const s = useSettings()
  const [name, setName] = useState(initial.name)
  const [files, setFiles] = useState<SketchFileData[]>(initial.files)
  const [diagram, setDiagramState] = useState<Diagram>(initial.diagram)
  const [saved, setSaved] = useState(() => JSON.stringify([initial.name, initial.files, initial.diagram]))
  const dirty = JSON.stringify([name, files, diagram]) !== saved
  // the main board's program: sketch.ino, or main.py on a Linux board
  const mainFile = (fs: SketchFileData[]) => (!fs.some((f) => f.name === "sketch.ino") && fs.some((f) => f.name === "main.py") ? "main.py" : "sketch.ino")
  const [active, setActive] = useState(() => mainFile(initial.files))
  const [tabs, setTabs] = useState<string[]>(() => [mainFile(initial.files)])
  /** compile results per board (by board id) */
  const [statuses, setStatuses] = useState<Record<string, Status>>({})
  /** the compiled firmware per board: Intel HEX (AVR) or a flash image (RP2040, ESP32) */
  const [hexes, setHexes] = useState<Record<string, { hex: string | Uint8Array; key: string }>>({})
  const [running, setRunning] = useState(false)
  const [paused, setPaused] = useState(false)
  const [frames, setFrames] = useState<Record<string, Frame>>({})
  const [serials, setSerials] = useState<Record<string, string>>({})
  const serialsRef = useRef(serials)
  serialsRef.current = serials
  const [serialIn, setSerialIn] = useState("")
  const [lineEnd, setLineEnd] = useState<"\n" | "\r\n" | "">("\n")
  const [bottom, setBottom] = useState<"serial" | "output" | "problems" | "logic">("serial")
  const logic = useRef(new LogicBuffer())
  const [bottomH, setBottomH] = useState(200)
  const [editorW, setEditorW] = useState(() => Math.round(window.innerWidth * 0.32))
  const [aiOpen, setAiOpen] = useState(false)
  /** a message for the assistant ("Fix with assistant"): the chat sends it */
  const [aiAsk, setAiAsk] = useState<{ id: number; text: string } | null>(null)
  const askAi = useCallback((text: string) => { setAiOpen(true); setAiAsk({ id: Date.now(), text }) }, [])
  /** the last error from running (the assistant reads it) */
  const [lastError, setLastError] = useState("")
  /** a run that failed: the toast offers the assistant, which finds the cause and fixes it */
  const fail = useCallback((message: string, description?: string) => {
    const full = description ? `${message} — ${description}` : message
    setLastError(full)
    toast.error(message, { description, duration: 15_000, action: { label: "Fix with assistant", onClick: () => askAi(`Running the project failed: ${full}\nFind the cause and fix it, then run it again.`) } })
  }, [askAi])
  /** the assistant asks before it installs anything */
  const [perm, setPerm] = useState<{ title: string; detail: string; reason: string; resolve: (ok: boolean) => void } | null>(null)
  const askPermission = useCallback((title: string, detail: string, reason: string) => new Promise<boolean>((resolve) => setPerm({ title, detail, reason, resolve })), [])
  const answer = (ok: boolean) => { perm?.resolve(ok); setPerm(null) }
  /** an install (or a command on the Pi) in progress */
  const [installing, setInstalling] = useState<string | null>(null)
  const [aiW, setAiW] = useState(380)
  const [selected, setSelected] = useState<string | null>(null)
  const [settingsFor, setSettingsFor] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [checking, setChecking] = useState<Snapshot | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [newFile, setNewFile] = useState<string | null>(null)
  const [ui, setUiState] = useState<Record<string, PartUi>>({})
  /** one simulator per board */
  const workers = useRef(new Map<string, Worker>())
  const canvas = useRef<CanvasApi | null>(null)
  const undo = useRef<Diagram[]>([])
  const redo = useRef<Diagram[]>([])
  const dragBase = useRef<Diagram | null>(null)
  const serialBox = useRef<HTMLDivElement>(null)

  // ── boards: each has its own sketch; the editor shows the focused board's ───────────────
  const boards = useMemo(() => boardsOf(diagram), [diagram])
  const mainId = boards[0]?.id
  const multi = boards.length > 1
  const builds = useMemo(() => boards.map((part) => {
    const def = boardByType(part.type)
    const prefix = prefixOf(part.id, mainId)
    const own = filesOf(files, prefix)
    const sources = own.filter((f) => f.name !== "libraries.txt")
    const libraries = parseLibraries(own.find((f) => f.name === "libraries.txt")?.content ?? "")
    return { part, def, prefix, sources, libraries, key: hashOf(JSON.stringify([sources, libraries, def?.fqbn])) }
  }), [boards, mainId, files])
  const focusId = ownerOf(active, boards) ?? mainId
  const focus = builds.find((b) => b.part.id === focusId) ?? builds[0]
  const boardPart = focus?.part
  const board = focus?.def
  const libraries = focus?.libraries ?? []
  const hex = focusId ? hexes[focusId] : undefined
  const stale = !builds.length || builds.some((b) => hexes[b.part.id]?.key !== b.key)
  const idle: Status = { kind: "idle" }
  /** the focused board's compile (Output panel) */
  const focusStatus = (focusId && statuses[focusId]) || idle
  /** all boards together (the Compile button, the AI) */
  const status: Status = useMemo(() => {
    const all = builds.map((b) => statuses[b.part.id] ?? idle)
    if (all.some((x) => x.kind === "compiling")) return { kind: "compiling" }
    const bad = builds.find((b) => statuses[b.part.id]?.kind === "error")
    if (bad) { const st = statuses[bad.part.id] as Extract<Status, { kind: "error" }>; return multi && st.message ? { ...st, message: `${bad.part.id}: ${st.message}` } : st }
    if (all.length && all.every((x) => x.kind === "ok")) return (statuses[focusId ?? ""] ?? all[0]) as Status
    return idle
  }, [builds, statuses, focusId, multi]) // eslint-disable-line react-hooks/exhaustive-deps
  const serial = (focusId && serials[focusId]) || ""
  /** the focused board's pins, clock and serial for the live code view (while running) */
  const liveFrame = (focusId && frames[focusId]) || null
  const liveView = useMemo<LiveView | null>(() => (running && liveFrame?.live
    ? { pins: liveFrame.live, vcc: liveFrame.vcc ?? board?.vcc ?? 5, seconds: liveFrame.seconds, serial: serial.slice(-4000), led: board?.led ?? "" }
    : null), [running, liveFrame, serial, board])
  const setSerial = (f: (old: string) => string) => focusId && setSerials((o) => ({ ...o, [focusId]: f(o[focusId] ?? "") }))
  const frame = useMemo(() => mergeFrames(frames, focusId), [frames, focusId])
  // breadboard seating adds connections the canvas finds (pins sitting on holes)
  const [seated, setSeated] = useState<Diagram["connections"]>([])
  const simDiagram = useMemo(() => (seated.length ? { ...diagram, connections: [...diagram.connections, ...seated] } : diagram), [diagram, seated])
  /** each board's circuit (its own parts and wires) */
  const circuits = useMemo(() => new Map(boards.map((b) => [b.id, new Circuit(boardDiagram(simDiagram, b.id), boardByType(b.type))])), [simDiagram, boards])
  const circuit = (focusId && circuits.get(focusId)) || new Circuit(simDiagram, undefined)
  const links = useMemo(() => boardLinks(diagram), [diagram])

  // a board that becomes the first one takes over the top-level files; a new board gets a blank sketch
  const mainRef = useRef(mainId)
  const boardIds = boards.map((b) => b.id).join(",")
  useEffect(() => {
    const old = mainRef.current
    mainRef.current = mainId
    setFiles((fs) => {
      let out = old && mainId && old !== mainId ? rehome(fs, old, mainId) : fs
      for (const b of boards.slice(1)) if (!out.some((f) => f.name.startsWith(`${b.id}/`) && isMain(f.name))) out = [...out, ...blankFiles(`${b.id}/`, isLinuxBoard(boardByType(b.type)))]
      // the first board a Linux board (a new Pi sketch, or the board type changed): it runs main.py
      if (boards[0] && isLinuxBoard(boardByType(boards[0].type)) && !out.some((f) => !f.name.includes("/") && f.name.endsWith(".py"))) out = [...out, ...blankFiles("", true)]
      return out
    })
    if (old && mainId && old !== mainId) { setTabs((t) => [...new Set(t.map((n) => (n.includes("/") ? n : `${old}/${n}`)).map((n) => (n.startsWith(`${mainId}/`) ? n.slice(mainId.length + 1) : n)))]); setActive((a) => (a.includes("/") ? (a.startsWith(`${mainId}/`) ? a.slice(mainId.length + 1) : "sketch.ino") : "sketch.ino")) }
  }, [boardIds]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Show a board's sketch in the editor. */
  const showCode = useCallback((id: string) => {
    const pre = prefixOf(id, mainRef.current)
    const own = files.filter((f) => (pre ? f.name.startsWith(pre) : !f.name.includes("/")))
    const linux = isLinuxBoard(boardByType(boards.find((b) => b.id === id)?.type ?? ""))
    const n = linux
      ? own.find((f) => f.name === `${pre}main.py`)?.name ?? own.find((f) => f.name.endsWith(".py"))?.name ?? `${pre}main.py`
      : own.find((f) => f.name === `${pre}sketch.ino`)?.name ?? own.find((f) => f.name.endsWith(".ino"))?.name ?? `${pre}sketch.ino`
    setActive(n); setTabs((t) => (t.includes(n) ? t : [...t, n]))
  }, [files, boards])
  const selectPart = useCallback((id: string | null) => {
    setSelected(id)
    if (id && boards.some((b) => b.id === id)) showCode(id)
  }, [boards, showCode])

  // ── diagram edits with undo ────────────────────────────────────────────────────────────
  const setDiagram = useCallback((d: Diagram, commit = true) => {
    setDiagramState((old) => {
      if (!commit) { dragBase.current ??= old; return d }
      const base = dragBase.current ?? old
      dragBase.current = null
      if (base !== d) { undo.current.push(base); if (undo.current.length > 200) undo.current.shift(); redo.current = [] }
      return d
    })
  }, [])
  const undoDiagram = () => { const d = undo.current.pop(); if (d) { redo.current.push(diagram); setDiagramState(d) } }
  const redoDiagram = () => { const d = redo.current.pop(); if (d) { undo.current.push(diagram); setDiagramState(d) } }

  // ── the workers (one per board) ────────────────────────────────────────────────────────
  const espTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  /** Linux / Renode boards: their chips run here, frame by frame, fed to the workers */
  const fedChips = useRef(new Map<string, ChipLink>())
  const fedRun = useRef(0)
  const stop = useCallback(() => {
    fedRun.current++
    for (const c of fedChips.current.values()) c.dispose()
    fedChips.current.clear()
    for (const w of workers.current.values()) { w.postMessage({ type: "stop" } satisfies ToWorker); w.terminate() }
    workers.current.clear()
    if (espTimer.current) { clearInterval(espTimer.current); espTimer.current = null; espStop() }
    setRunning(false); setPaused(false); setFrames({})
    stopBuzzers()
  }, [])
  useEffect(() => () => { for (const w of workers.current.values()) w.terminate(); stopBuzzers(); if (espTimer.current) { clearInterval(espTimer.current); espStop() } }, [])
  const startWith = useCallback(async (fws: Record<string, string | Uint8Array>) => {
    for (const w of workers.current.values()) w.terminate()
    workers.current.clear()
    if (espTimer.current) { clearInterval(espTimer.current); espTimer.current = null; espStop() }
    setFrames({})
    setLastError("")
    const todo = boards.filter((b) => fws[b.id] !== undefined)
    // QEMU runs one ESP32 at a time
    const esps = todo.filter((b) => boardByType(b.type)?.chip === "esp32")
    if (esps.length > 1) toast.error(`Only one ESP32 can run at a time — ${esps.slice(1).map((b) => b.id).join(", ")} stays off`)
    const espId = esps[0]?.id
    if (espId) {
      // the firmware runs in QEMU; the worker solves the circuit from the bridge's pin reports
      try { await espStart(fws[espId] as string, s.esp32QemuPath, boardByType(esps[0].type)?.esp ?? "esp32") } catch (e) { fail(e instanceof Error ? e.message : String(e)); setBottom("output"); return }
    }
    setSerials({})
    logic.current.reset()
    const logicPins = new Map<string, string[]>()
    const bufs = new Map<string, string>()
    let flush: ReturnType<typeof setTimeout> | null = null
    const addSerial = (id: string, text: string) => {
      bufs.set(id, (bufs.get(id) ?? "") + text)
      flush ??= setTimeout(() => { const all = [...bufs]; bufs.clear(); flush = null; setSerials((old) => { const n = { ...old }; for (const [k, t] of all) n[k] = ((n[k] ?? "") + t).slice(-200_000); return n }) }, 30)
    }
    for (const b of todo) {
      const id = b.id
      const esp = boardByType(b.type)?.chip === "esp32"
      if (esp && id !== espId) continue
      const w = new Worker(new URL("./sim.worker.ts", import.meta.url), { type: "module" })
      workers.current.set(id, w)
      w.onmessage = (e: MessageEvent<FromWorker>) => {
        const m = e.data
        if (m.type === "frame") {
          // several boards share the analyser: their channels are "board:pin"
          const tag = (p: string) => (multi ? `${id}:${p}` : p)
          logicPins.set(id, m.frame.logicPins.map(tag))
          logic.current.push(multi ? m.frame.logic.map(([p, t, l]) => [tag(p), t, l]) : m.frame.logic, [...logicPins.values()].flat(), m.frame.seconds)
          setFrames((old) => ({ ...old, [id]: m.frame }))
        } else if (m.type === "serial") {
          addSerial(id, m.text)
          // a Raspberry Pi program that crashed (a Python traceback): offer the assistant
          const crash = /\[program exited with code ([1-9]\d*)\]/.exec(m.text)
          if (crash) {
            const said = (serialsRef.current[id] ?? "") + (bufs.get(id) ?? "")
            const why = said.split("\n").map((l) => l.trim()).filter((l) => /^\w*(Error|Exception)\b/.test(l)).pop()
            fail(`${multi ? `${id}: ` : ""}the program stopped with an error (exit code ${crash[1]})`, why)
          }
        }
        else if (m.type === "error") { fail(multi ? `${id}: ${m.message}` : m.message); stop() }
        else if (m.type === "esp32-out") espSend(undefined, m.bytes).catch(() => {})
      }
      if (esp) {
        espTimer.current = setInterval(async () => {
          const r = await espPoll().catch(() => null)
          if (!r) return
          if (r.serial) addSerial(id, r.serial)
          if (r.bridge.length) w.postMessage({ type: "esp32-in", bytes: r.bridge } satisfies ToWorker)
          if (!r.running) { fail("The ESP32 emulator stopped", r.log.split("\n").filter(Boolean).slice(-3).join(" · ")); stop() }
        }, 33)
      }
      const fedDef = boardByType(b.type)
      const fed = fedDef?.chip === "linux" || fedDef?.chip === "renode"
      w.postMessage({ type: "start", diagram: boardDiagram(simDiagram, id), hex: fed ? "" : fws[id], speed: esp || fed ? 1 : s.mcuSpeed } satisfies ToWorker)
      for (const [pid, u] of Object.entries(ui)) w.postMessage({ type: "ui", id: pid, ui: u } satisfies ToWorker)
      if (fed && fedDef) {
        // the chip runs here in 50 ms lockstep frames; the worker solves the circuit from them
        const run = fedRun.current
        let levels: [string, boolean][] = []
        const prev = w.onmessage
        w.onmessage = (e: MessageEvent<FromWorker>) => { if (e.data.type === "fed-in") levels = e.data.levels; else prev?.call(w, e) }
        try {
          const chip = fedDef.chip === "linux"
            ? await linuxChip(fedDef, { files: JSON.parse(fws[id] as string) as { name: string; content: string }[] }, { parts: boardDiagram(simDiagram, id).parts, ui })
            : await renodeChip(fedDef, fws[id] as string)
          if (run !== fedRun.current) { chip.dispose(); return }
          fedChips.current.set(id, chip)
          void (async () => {
            try {
              const T = 0.05
              w.postMessage({ type: "fed-frame", frame: await chip.frame({ seconds: 0, digital: levels, analog: [] }), seconds: 0 } satisfies ToWorker)
              while (run === fedRun.current) {
                const frame = await chip.frame({ seconds: T, digital: levels, analog: [] })
                if (run !== fedRun.current) break
                w.postMessage({ type: "fed-frame", frame, seconds: T } satisfies ToWorker)
              }
            } catch (e) { if (run === fedRun.current) { fail(`${id}: ${e instanceof Error ? e.message : String(e)}`); stop() } }
          })()
        } catch (e) { fail(e instanceof Error ? e.message : String(e)); stop(); return }
      }
    }
    setRunning(true); setPaused(false)
  }, [simDiagram, s.mcuSpeed, s.esp32QemuPath, ui, stop, boards, multi, fail])
  const firmware = () => Object.fromEntries(Object.entries(hexes).filter(([id]) => boards.some((b) => b.id === id)).map(([id, h]) => [id, h.hex]))
  // changing the wiring while running restarts with the new circuit
  const runningDiagram = useRef<Diagram | null>(null)
  useEffect(() => {
    if (!running || !Object.keys(hexes).length) { runningDiagram.current = simDiagram; return }
    if (runningDiagram.current && runningDiagram.current !== simDiagram && !dragBase.current) startWith(firmware())
    runningDiagram.current = simDiagram
  }, [simDiagram]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { for (const w of workers.current.values()) w.postMessage({ type: "speed", speed: s.mcuSpeed } satisfies ToWorker) }, [s.mcuSpeed])
  useEffect(() => { setBuzzers(running && !paused ? frame?.buzzer ?? null : null, s.outputSound) }, [frame, running, paused, s.outputSound])
  useEffect(() => { const el = serialBox.current; if (el) el.scrollTop = el.scrollHeight }, [serial, bottom])

  const sendUi = useCallback((id: string, u: PartUi) => {
    setUiState((old) => ({ ...old, [id]: { ...old[id], ...u, ...(u.v ? { v: { ...old[id]?.v, ...u.v } } : {}) } }))
    for (const w of workers.current.values()) w.postMessage({ type: "ui", id, ui: u } satisfies ToWorker)
    // a Raspberry Pi's camera / microphone parts feed the guest (src/linux/media.ts)
    for (const c of fedChips.current.values()) c.ui?.(id, u)
  }, [])

  // ── compile & run ──────────────────────────────────────────────────────────────────────
  const compileOne = useCallback(async (b: (typeof builds)[number]): Promise<{ fw: string | Uint8Array | null; st: Status }> => {
    const id = b.part.id, def = b.def
    const set = (st: Status) => { setStatuses((o) => ({ ...o, [id]: st })); return { fw: null, st } }
    if (!def) return set({ kind: "error", message: `Unknown board ${b.part.type}` })
    if (def.chip === "linux") {
      // Python runs as it is: the files are the "firmware"
      if (!b.sources.some((f) => f.name.endsWith(".py"))) return set({ kind: "error", message: `${id} has no .py program (main.py)` })
      const fw = JSON.stringify(b.sources.filter((f) => !f.name.endsWith(".json")))
      setHexes((o) => ({ ...o, [id]: { hex: fw, key: b.key } }))
      return { ...set({ kind: "ok", out: { ok: true, hex: null, bin: null, image: null, elf: null, log: "Python runs as it is on the board — nothing to compile.", diagnostics: [] } }), fw }
    }
    if (!b.sources.some((f) => f.name.endsWith(".ino"))) return set({ kind: "error", message: `${id} has no .ino sketch` })
    set({ kind: "compiling" })
    try {
      const st = await cliStatus(s.arduinoCliPath)
      const core = coreOf(def.fqbn)
      if (!st.cores.includes(core)) throw new Error(`The ${core} board core is not installed. Click “Install ${core}” to download it (once${def.chip === "rp2040" ? ", about 300 MB" : ""}).`)
      // ESP32: the bridge that reports pin activity from QEMU goes in with the sketch
      const fs = def.chip === "esp32" ? [...b.sources, { name: ESP32_BRIDGE_FILE, content: ESP32_BRIDGE }] : [...b.sources, ...(def.renode?.sources ?? [])]
      const out = await compileSketch(fs, def.fqbn, b.libraries, s.arduinoCliPath, def.buildProps)
      // diagnostics name the file inside the board's folder
      if (b.prefix) out.diagnostics = out.diagnostics.map((d) => ({ ...d, file: b.prefix + d.file }))
      // Renode boots the ELF from disk: a copy the next compile won't delete
      const fw = def.firmware === "bin" ? out.bin : def.firmware === "image" ? out.image : def.firmware === "elf" ? (out.ok && out.elf ? await renodeStage(out.elf) : null) : out.hex
      if (out.ok && fw) {
        setHexes((o) => ({ ...o, [id]: { hex: fw, key: b.key } }))
        return { ...set({ kind: "ok", out }), fw }
      }
      return set({ kind: "error", out })
    } catch (e) {
      return set({ kind: "error", message: e instanceof Error ? e.message : String(e) })
    }
  }, [s.arduinoCliPath])

  /** Compile every board whose sketch changed (all of them with `force`); null if one fails. */
  const compile = useCallback(async (force = true): Promise<Record<string, string | Uint8Array> | null> => {
    if (!builds.length) { toast.error("Add a board to the canvas first"); return null }
    setBottom((b) => (b === "serial" && !running ? "output" : b))
    const out: Record<string, string | Uint8Array> = {}
    let failed: { id: string; st: Status } | null = null
    // one at a time: arduino-cli builds each board type in one folder
    for (const b of builds) {
      const done = hexes[b.part.id]
      const r = !force && done?.key === b.key ? { fw: done.hex, st: null } : await compileOne(b)
      if (r.fw) out[b.part.id] = r.fw
      else if (r.st) failed ??= { id: b.part.id, st: r.st }
    }
    if (failed) {
      // show the board that failed, and where
      if (multi) showCode(failed.id)
      setBottom(failed.st.kind === "error" && failed.st.out?.diagnostics.length ? "problems" : "output")
      return null
    }
    return out
  }, [builds, hexes, compileOne, running, multi, showCode])

  const run = useCallback(async () => {
    const fws = await compile(false)
    if (!fws) return false
    setBottom("serial")
    startWith(fws)
    return true
  }, [compile, startWith])

  const [saving, setSaving] = useState<"idle" | "saving" | "error">("idle")
  const save = useCallback(async (quiet = false) => {
    const snap = JSON.stringify([name, files, diagram])
    setSaving("saving")
    try {
      await onSave({ name, files, diagram })
      setSaved(snap)
      setSaving("idle")
      if (!quiet) toast.success(`Saved ${name}`)
      return true
    } catch (e) {
      setSaving("error")
      toast.error(`Could not save ${name}: ${e instanceof Error ? e.message : String(e)}`)
      return false
    }
  }, [name, files, diagram, onSave])
  // autosave: a second after the last change (no Save needed, nothing lost on Back)
  useEffect(() => {
    if (!dirty) return
    const t = setTimeout(() => { save(true) }, 1000)
    return () => clearTimeout(t)
  }, [dirty, save])

  // keyboard shortcuts
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); save() }
      else if (mod && e.key.toLowerCase() === "b") { e.preventDefault(); compile() }
      else if (mod && e.key === "Enter") { e.preventDefault(); if (running) stop(); else run() }
      else if (mod && e.key.toLowerCase() === "j") { e.preventDefault(); setAiOpen((o) => !o) }
      else if (mod && e.key.toLowerCase() === "z" && !(e.target as HTMLElement).closest(".monaco-editor, input, textarea")) { e.preventDefault(); if (e.shiftKey) redoDiagram(); else undoDiagram() }
    }
    window.addEventListener("keydown", k)
    return () => window.removeEventListener("keydown", k)
  })

  // ── files ──────────────────────────────────────────────────────────────────────────────
  const allFiles = [...files.map((f) => f.name), DIAGRAM]
  const textOf = (n: string) => (n === DIAGRAM ? diagramText(diagram) : files.find((f) => f.name === n)?.content ?? "")
  const [diagramDraft, setDiagramDraft] = useState<string | null>(null)
  const [diagramError, setDiagramError] = useState<string | null>(null)
  const setText = (n: string, text: string) => {
    if (n === DIAGRAM) {
      setDiagramDraft(text)
      try { setDiagram(parseDiagram(text)); setDiagramError(null) } catch (e) { setDiagramError(e instanceof Error ? e.message : String(e)) }
      return
    }
    setFiles((fs) => fs.map((f) => (f.name === n ? { ...f, content: text } : f)))
  }
  useEffect(() => { if (active !== DIAGRAM) { setDiagramDraft(null); setDiagramError(null) } }, [active])
  const open = (n: string) => { setActive(n); setTabs((t) => (t.includes(n) ? t : [...t, n])) }
  const closeTab = (n: string) => {
    const rest = tabs.filter((t) => t !== n)
    setTabs(rest.length ? rest : [mainFile(files)])
    if (active === n) setActive(rest[rest.length - 1] ?? mainFile(files))
  }
  /** files go in the focused board's folder */
  const pre = focusId ? prefixOf(focusId, mainId) : ""
  const shortName = (n: string) => (n.includes("/") ? n.slice(n.indexOf("/") + 1) : n)
  const fixed = (n: string) => n === DIAGRAM || shortName(n) === "sketch.ino" || shortName(n) === "libraries.txt" || shortName(n) === "main.py"
  const addFile = (raw: string) => {
    const n = raw.trim().replace(/[^\w.-]/g, "_")
    if (!n) return
    const full = pre + (/\.(ino|h|hpp|c|cpp|txt)$/.test(n) ? n : `${n}.h`)
    if (allFiles.includes(full)) { toast.error(`${full} already exists`); return }
    const header = full.endsWith(".h") || full.endsWith(".hpp")
    setFiles((fs) => [...fs, { name: full, content: header ? `#pragma once\n\n` : "" }])
    open(full)
  }
  const renameFile = (from: string, raw: string) => {
    const clean = raw.trim().replace(/[^\w.-]/g, "_")
    const to = clean && from.slice(0, from.length - shortName(from).length) + clean
    setRenaming(null)
    if (!to || to === from || allFiles.includes(to)) return
    setFiles((fs) => fs.map((f) => (f.name === from ? { ...f, name: to } : f)))
    setTabs((t) => t.map((x) => (x === from ? to : x)))
    if (active === from) setActive(to)
  }
  const deleteFile = (n: string) => { setFiles((fs) => fs.filter((f) => f.name !== n)); closeTab(n) }

  const diagnostics: Diagnostic[] = builds.flatMap((b) => { const st = statuses[b.part.id]; return st?.kind === "ok" || st?.kind === "error" ? st.out?.diagnostics ?? [] : [] })
  const errors = diagnostics.filter((d) => d.severity === "error")

  // ── parts ──────────────────────────────────────────────────────────────────────────────
  const addPart = (info: PartInfo, at?: { x: number; y: number }) => {
    if (isBoardType(info.type) && boards.length) {
      // another board, with its own sketch (in a folder named after its id)
      const base = boardId(info.type)
      let id = base
      for (let i = 2; diagram.parts.some((p) => p.id === id); i++) id = `${base}${i}`
      const last = boards[boards.length - 1]
      const c = at ?? { x: last.left + (boardByType(last.type)?.size.w ?? 280) + 120, y: last.top }
      setFiles((fs) => (fs.some((f) => f.name === `${id}/sketch.ino`) ? fs : [...fs, ...blankFiles(`${id}/`)]))
      setDiagram({ ...diagram, parts: [...diagram.parts, { type: info.type, id, left: c.x, top: c.y, attrs: {} }] })
      setSelected(id)
      setActive(`${id}/sketch.ino`); setTabs((t) => [...t, `${id}/sketch.ino`])
      setAdding(false)
      // fit once the new board's element has been measured
      for (const ms of [150, 500]) setTimeout(() => canvas.current?.fit(), ms)
      return
    }
    const id = nextId(diagram, info.type)
    const c = at ?? canvas.current?.freeSpot() ?? { x: 100, y: -120 }
    const p: DiagramPart = { type: info.type, id, left: c.x, top: c.y, attrs: { ...(info.attrs ?? {}) } }
    setDiagram({ ...diagram, parts: [...diagram.parts, p] })
    setSelected(id)
    setAdding(false)
  }
  const updatePart = (id: string, patch: Partial<DiagramPart>) => {
    const nid = patch.id && patch.id !== id ? patch.id.replace(/[^\w-]/g, "") : id
    if (nid !== id && diagram.parts.some((p) => p.id === nid)) { toast.error(`There is already a part called ${nid}`); return }
    const ren = (e: string) => { const [pid, pin] = splitEnd(e); return pid === id ? `${nid}:${pin}` : e }
    setDiagram({ ...diagram, parts: diagram.parts.map((p) => (p.id === id ? { ...p, ...patch, id: nid } : p)), connections: diagram.connections.map((c) => [ren(c[0]), ren(c[1]), c[2], c[3]]) })
    if (nid !== id) {
      setSettingsFor(nid); setSelected(nid)
      // a renamed board keeps its sketch: its folder follows the new id
      if (boards.some((b) => b.id === id)) {
        if (id === mainRef.current) mainRef.current = nid
        else {
          const rn = (n: string) => (n.startsWith(`${id}/`) ? `${nid}/${n.slice(id.length + 1)}` : n)
          setFiles((fs) => moveFiles(fs, `${id}/`, `${nid}/`))
          setTabs((t) => t.map(rn)); setActive(rn)
        }
      }
    }
  }
  /** Swap a board for another kind, keeping the wires on pins the new one has. */
  const changeBoard = (id: string, type: string) => {
    const nb = boardByType(type)
    if (!nb) return
    setDiagram({ ...diagram, parts: diagram.parts.map((p) => (p.id === id ? { ...p, type } : p)), connections: diagram.connections.filter((c) => [c[0], c[1]].every((e) => { const [pid, pin] = splitEnd(e); return pid !== id || nb.pins[pin.split(".")[0]] || /^(GND|5V|3\.3V|VIN|IOREF|AREF|RESET)/.test(pin) })) })
  }

  // ── AI host ────────────────────────────────────────────────────────────────────────────
  const boardList = builds.map((b) => `${b.part.id}: ${b.def?.name ?? b.part.type} (${b.part.type}) — files ${b.prefix ? `in ${b.prefix}` : "at the top level"}`).join("; ")
  const defs = builds.flatMap((b) => (b.def ? [b.def] : []))
  const live = useRef({ files, diagram, status, serial, frame, running, run, compile, stop, sendUi, board, boardList, serials, defs, cliPath: s.arduinoCliPath, lastError, askPermission })
  live.current = { files, diagram, status, serial, frame, running, run, compile, stop, sendUi, board, boardList, serials, defs, cliPath: s.arduinoCliPath, lastError, askPermission }
  const host = useMemo<McuAgentHost>(() => ({
    project: () => {
      const l = live.current
      const st = l.status
      return {
        name, board: l.boardList.includes(";") ? `several boards, each with its own sketch — ${l.boardList}. Write another board's files as "<id>/sketch.ino".` : l.board ? `${l.board.name} (${l.board.type})` : "none", files: l.files, diagram: diagramText(l.diagram),
        lastCompile: st.kind === "ok" ? `ok — ${st.out.flash ? `${st.out.flash.used} bytes flash` : ""}` : st.kind === "error" ? `failed:\n${st.message ?? st.out?.log.slice(-2500)}` : "",
        serial: Object.keys(l.serials).length > 1 ? Object.entries(l.serials).map(([id, t]) => `[${id}]\n${t}`).join("\n") : l.serial,
        lastError: l.lastError,
      }
    },
    writeFile: (n, content) => {
      // "<board id>/file" for a board other than the first one
      const m = /^([\w-]+)\/([^/]+)$/.exec(n.trim())
      const own = m && boardsOf(live.current.diagram).slice(1).some((b) => b.id === m[1])
      const clean = own ? `${m[1]}/${m[2]}` : n.trim().replace(/^.*\//, "")
      if (!/\.(ino|h|hpp|c|cpp|txt|py)$/.test(clean)) return `Not written: ${clean} — use .ino, .h, .cpp, libraries.txt, or .py / requirements.txt on a Raspberry Pi`
      setFiles((fs) => (fs.some((f) => f.name === clean) ? fs.map((f) => (f.name === clean ? { ...f, content } : f)) : [...fs, { name: clean, content }]))
      return `Wrote ${clean} (${content.split("\n").length} lines)`
    },
    setDiagram: (text) => {
      const d = parseDiagram(text)
      const problems: string[] = []
      for (const p of d.parts) if (!isBoardType(p.type) && !partInfo(p.type) && !customElements.get(p.type)) problems.push(`unknown part type ${p.type}`)
      const ids = new Set(d.parts.map((p) => p.id))
      for (const c of d.connections) for (const e of [c[0], c[1]]) if (!ids.has(splitEnd(e)[0])) problems.push(`connection to missing part ${e}`)
      if (problems.length) return `Problems: ${problems.join("; ")}`
      setDiagram(d)
      setTimeout(() => canvas.current?.fit(), 120)
      return `Diagram set: ${d.parts.length} parts, ${d.connections.length} wires`
    },
    compile: async () => {
      await new Promise((r) => setTimeout(r, 30)) // let a write_file land first
      const h = await live.current.compile()
      const st = liveStatus.current
      if (h) return { ok: true, text: `Compiled OK${st?.kind === "ok" && st.out.flash ? ` — flash ${st.out.flash.used}/${st.out.flash.max} bytes, RAM ${st.out.ram?.used}/${st.out.ram?.max}` : ""}` }
      return { ok: false, text: `Compile failed:\n${st?.kind === "error" ? st.message ?? (st.out?.diagnostics.map((d) => `${d.file}:${d.line}:${d.col}: ${d.severity}: ${d.message}`).join("\n") || st.out?.log.slice(-3000)) : "unknown error"}` }
    },
    run: async (seconds) => {
      await new Promise((r) => setTimeout(r, 30))
      if (live.current.running) live.current.stop()
      const ok = await live.current.run()
      if (!ok) { const st = liveStatus.current; return `Compile failed:\n${st?.kind === "error" ? st.message ?? st.out?.diagnostics.map((d) => `${d.file}:${d.line}: ${d.message}`).join("\n") : ""}` }
      const seen = { leds: new Map<string, number>(), servo: new Map<string, number>(), tones: new Set<number>(), warnings: new Set<string>() }
      const t0 = Date.now()
      while (Date.now() - t0 < seconds * 1000) {
        await new Promise((r) => setTimeout(r, 100))
        const f = live.current.frame
        if (!f) continue
        for (const [id, b] of f.leds) if (b.length) seen.leds.set(id, Math.max(seen.leds.get(id) ?? 0, ...b))
        for (const [id, a] of f.servo) seen.servo.set(id, a)
        for (const hz of f.buzzer.values()) if (hz > 0) seen.tones.add(Math.round(hz))
        for (const w of f.warnings) seen.warnings.add(w)
      }
      const f = live.current.frame
      const lcd = f ? [...f.lcd].map(([id, l]) => { const t = String.fromCharCode(...l.chars); const cols = t.length / (l.chars.length > 32 ? 4 : 2); return `${id}: ${Array.from({ length: t.length / cols }, (_, r) => `“${t.slice(r * cols, (r + 1) * cols).trimEnd()}”`).join(" / ")}` }) : []
      return [
        `Ran ${seconds} s (simulated ${f?.seconds.toFixed(2) ?? "?"} s).`,
        `Serial output:\n${(Object.keys(live.current.serials).length > 1 ? Object.entries(live.current.serials).map(([id, t]) => `[${id}] ${t.slice(-1500)}`).join("\n") : live.current.serial.slice(-2000)) || "(nothing)"}`,
        seen.warnings.size ? `Electrical warnings: ${[...seen.warnings].join("; ")}` : "No electrical warnings.",
        seen.leds.size ? `Brightest each LED got: ${[...seen.leds].map(([id, b]) => `${id} ${Math.round(b * 100)}%`).join(", ")}` : "",
        seen.servo.size ? `Servo angles: ${[...seen.servo].map(([id, a]) => `${id} ${a.toFixed(0)}°`).join(", ")}` : "",
        seen.tones.size ? `Buzzer tones (Hz): ${[...seen.tones].slice(0, 20).join(", ")}` : "",
        lcd.length ? `Displays: ${lcd.join("; ")}` : "",
        "Still running — call stop when done, or set_input to interact.",
      ].filter(Boolean).join("\n")
    },
    stop: () => { live.current.stop(); return "Stopped" },
    setInput: (part, value) => {
      const p = live.current.diagram.parts.find((x) => x.id === part)
      if (!p) return `No part ${part}`
      if (!live.current.running) return "Not running — call run first"
      const v = value.trim().toLowerCase()
      const t = p.type
      let u: PartUi
      if (t.includes("pushbutton")) u = { pressed: v === "press" || v === "on" || v === "1" || v === "pressed" }
      else if (t === "wokwi-potentiometer") u = { value: v.endsWith("%") ? (parseFloat(v) / 100) * 1023 : parseFloat(v) }
      else if (t === "wokwi-slide-potentiometer") u = { value: v.endsWith("%") ? parseFloat(v) : (parseFloat(v) / 1023) * 100 }
      else if (t === "wokwi-slide-switch") u = { value: v === "1" || v === "on" ? 1 : 0 }
      else if (t === "wokwi-pir-motion-sensor" || t === "wokwi-tilt-switch") u = { active: v === "on" || v === "1" || v === "motion" }
      else if (SENSOR_CONTROLS[t]) u = { value: parseFloat(v) }
      else if (catalogControls(t).length) {
        // "temperature=30, humidity=60" or a bare number for the first control
        const ctls = catalogControls(t), set: Record<string, number> = {}
        for (const item of v.split(/[,;]\s*/)) {
          const m = /^([\w ]+?)\s*[=:]\s*(-?[\d.]+)/.exec(item)
          if (m) { const c = ctls.find((x) => x.key === m[1].trim() || x.label.toLowerCase().startsWith(m[1].trim())); if (c) set[c.key] = parseFloat(m[2]) }
          else if (!Number.isNaN(parseFloat(item))) set[ctls[0].key] = parseFloat(item)
        }
        if (!Object.keys(set).length) return `${part} has controls ${ctls.map((c) => `${c.key} (${c.label}, ${c.min}–${c.max} ${c.unit})`).join(", ")}`
        u = { v: set }
      } else if (partInfo(t)?.cat?.model.m === "button") u = { pressed: v === "press" || v === "on" || v === "1" || v === "pressed" }
      else if (partInfo(t)?.cat?.model.m === "digital") u = { active: v === "on" || v === "1" || v === "active" }
      else return `Not an input: ${part} (${t})`
      live.current.sendUi(part, u)
      return `${part} ← ${value}`
    },
    checkSetup: async () => {
      const items = await checkSetup(live.current.defs, live.current.cliPath, live.current.diagram.parts.map((p) => p.type))
      if (!items.length) return "Nothing to check — add a board first."
      return items.map((i) => `${i.ok ? "ok     " : "MISSING"} ${i.id} — ${i.label}: ${i.detail}${!i.ok && i.install ? ` (install: ${i.install})` : ""}`).join("\n") + (items.every((i) => i.ok) ? "\nEverything this project needs is installed." : "")
    },
    install: async (item, reason) => {
      const items = await checkSetup(live.current.defs, live.current.cliPath, live.current.diagram.parts.map((p) => p.type))
      const it = items.find((i) => i.id === item.trim())
      if (!it) return { ok: false, text: `Unknown item ${item} — check_setup lists: ${items.map((i) => i.id).join(", ")}` }
      if (it.ok) return { ok: true, text: `${it.label} is already installed (${it.detail})` }
      if (!it.install) return { ok: false, text: `${it.label} can't be installed from here: ${it.detail}` }
      if (!(await live.current.askPermission(`Install ${it.label}?`, it.install, reason)))
        return { ok: false, text: "The user didn't allow the install. Stop, and tell them how to install it themselves (Settings → Microcontrollers)." }
      // a Pi add-on installs in the running board's system: its program stops first (one at a time)
      if (it.id.startsWith("pi-") && it.id !== "pi-system" && live.current.running) { live.current.stop(); await new Promise((r) => setTimeout(r, 1000)) }
      setInstalling(`Installing ${it.label}…`)
      try { return { ok: true, text: await installSetup(it.id, live.current.defs, live.current.cliPath, (t) => setInstalling(`${it.label}: ${t}`)) } }
      catch (e) { return { ok: false, text: `Install failed: ${e instanceof Error ? e.message : String(e)}` } }
      finally { setInstalling(null) }
    },
    piShell: async (cmd, reason) => {
      const b = live.current.defs.find((d) => d.chip === "linux")
      if (!b) return { ok: false, text: "This project has no Raspberry Pi board" }
      // installing or changing the system is the user's call
      if (CHANGES_SYSTEM.test(cmd) && !(await live.current.askPermission("Run this on the Raspberry Pi?", cmd, reason)))
        return { ok: false, text: "The user didn't allow it. Stop, and give them the command to run in the Terminal tab themselves." }
      // the program stops (one program at a time); let its last frame finish first
      if (live.current.running) { live.current.stop(); await new Promise((r) => setTimeout(r, 1000)) }
      setInstalling(`Raspberry Pi: ${cmd.slice(0, 60)}`)
      try {
        const { piExec } = await import("@/linux/exec")
        const r = await piExec(b.linux ?? "pi5", cmd, 900, (t) => setInstalling(t))
        return { ok: r.code === 0, text: `exit code ${r.code ?? "none (timed out)"}\n${r.output.slice(-4000).trim() || "(no output)"}` }
      } catch (e) { return { ok: false, text: e instanceof Error ? e.message : String(e) } }
      finally { setInstalling(null) }
    },
  }), [name, setDiagram])
  const liveStatus = useRef<Status | null>(null)
  liveStatus.current = status
  const piProject = isLinuxBoard(board)
  const profile = useMemo(() => mcuProfile(host, piProject), [host, piProject])

  // ── chrome ─────────────────────────────────────────────────────────────────────────────
  const statusBadge = (
    <div className="flex items-center gap-2 rounded-md border bg-popover/90 px-2 py-1 font-mono text-[11px] shadow-sm backdrop-blur">
      <span className={cn("rounded px-1 font-semibold", running ? (paused ? "bg-warning/20 text-warning" : "bg-success/20 text-success") : "bg-muted text-muted-foreground")}>{running ? (paused ? "PAUSED" : "RUN") : "STOP"}</span>
      <span>{multi ? `${boards.length} boards · ${focusId}` : board ? `${board.chip.toUpperCase()} ${board.hz / 1e6} MHz` : "no board"}</span>
      <span className="text-muted-foreground">·</span>
      <span>{circuit.members.filter((m) => m.length > 1).length} nets</span>
      {frame && <><span className="text-muted-foreground">·</span><span className="tabular-nums">{frame.seconds.toFixed(2)} s</span><span className={cn("tabular-nums", frame.speed < 0.9 && "text-warning")}>{Math.round(frame.speed * 100)}%</span></>}
      {frame && frame.warnings.length > 0 && <span className="flex items-center gap-1 text-warning"><TriangleAlert className="size-3" />{frame.warnings.length}</span>}
    </div>
  )
  const sel = diagram.parts.find((p) => p.id === selected)
  const controls: { key: string; label: string; min: number; max: number; step: number; unit: string; attr: string; def?: number; cat?: boolean }[] | undefined = running && sel
    ? SENSOR_CONTROLS[sel.type] ?? catalogControls(sel.type).map((c) => ({ ...c, attr: c.key, cat: true }))
    : undefined

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header data-tauri-drag-region className="flex h-12 shrink-0 items-center gap-2 whitespace-nowrap border-b bg-sidebar pl-[88px] pr-3">
        <Button variant="ghost" size="sm" onClick={async () => { stop(); if (dirty && !(await save(true))) return; onBack(false) }}><ArrowLeft /> Back</Button>
        <div className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground"><Cpu className="size-3.5" /></div>
        <div className="min-w-0">
          <input value={name} onChange={(e) => setName(e.target.value)} className="w-56 truncate bg-transparent text-sm font-medium outline-none focus:underline" title="Project name" />
          {where && <div className="truncate font-mono text-[10px] text-muted-foreground" title={where}>{where}</div>}
        </div>
        <Badge variant="secondary" className={cn("shrink-0", saving === "error" && "bg-warning-subtle text-warning")} title="Sketches save themselves a second after each change">{saving === "error" ? "Not saved" : dirty || saving === "saving" ? "Saving…" : "Saved"}</Badge>
        <div data-tauri-drag-region className="flex-1" />
        <Button variant="outline" size="sm" onClick={() => compile()} disabled={status.kind === "compiling"} title="Compile with arduino-cli (⌘B)">
          {status.kind === "compiling" ? <Loader2 className="animate-spin" /> : status.kind === "ok" && !stale ? <Check className="text-success" /> : status.kind === "error" ? <CircleAlert className="text-destructive" /> : <Hammer />} Compile
        </Button>
        {running ? (
          <>
            <Button variant="outline" size="icon-sm" disabled={builds.some((b) => b.def?.chip === "esp32")} title={builds.some((b) => b.def?.chip === "esp32") ? "QEMU runs in real time (no pause)" : paused ? "Resume" : "Pause"} onClick={() => { const p = !paused; setPaused(p); for (const w of workers.current.values()) w.postMessage({ type: "pause", paused: p } satisfies ToWorker) }}>{paused ? <Play /> : <Pause />}</Button>
            <Button variant="outline" size="icon-sm" title="Restart" onClick={() => startWith(firmware())}><RotateCcw /></Button>
            <Button size="sm" variant="destructive" onClick={stop} title="Stop (⌘↵)"><Square /> Stop</Button>
          </>
        ) : (
          <Button size="sm" onClick={run} disabled={status.kind === "compiling"} title="Compile if needed and run (⌘↵)"><Play /> Run</Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" size="sm" title="Simulation speed">{s.mcuSpeed === 1 ? "1×" : `${s.mcuSpeed}×`}<ChevronDown /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Simulation Speed</DropdownMenuLabel>
            {[0.1, 0.25, 0.5, 1, 2].map((v) => <DropdownMenuItem key={v} onClick={() => setSettings({ mcuSpeed: v })}>{v}× {v === 1 ? "(real time)" : ""}</DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="mx-1 h-5 w-px bg-border" />
        <Button variant="ghost" size="icon-sm" title="Save now (⌘S) — sketches also save themselves" onClick={() => save()}><Save /></Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" title="Import / export"><Download /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => { navigator.clipboard.writeText(diagramText(diagram)); toast.success("diagram.json copied — paste it into a Wokwi project") }}><FileJson /> Copy diagram.json (Wokwi)</DropdownMenuItem>
            <DropdownMenuItem onClick={() => { const t = prompt("Paste a Wokwi diagram.json"); if (t) { try { setDiagram(parseDiagram(t)); setTimeout(() => canvas.current?.fit(), 100) } catch (e) { toast.error(String(e)) } } }}><Upload /> Paste a Wokwi diagram.json…</DropdownMenuItem>
            <DropdownMenuSeparator />
            {onDelete && <><DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => { stop(); onDelete() }}><Trash2 /> Delete Sketch (to Trash)</DropdownMenuItem><DropdownMenuSeparator /></>}
            <DropdownMenuItem disabled={!hex} onClick={() => { if (!hex) return; const bin = typeof hex.hex !== "string"; const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([hex.hex as BlobPart], { type: bin ? "application/octet-stream" : "text/plain" })); a.download = `${name.replace(/\W+/g, "_")}.${bin ? "bin" : "hex"}`; a.click() }}><Download /> Download firmware{multi ? ` of ${focusId}` : ""} ({board?.firmware === "bin" ? ".bin" : ".hex"})</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant={aiOpen ? "secondary" : "ghost"} size="icon-sm" title="AI assistant (⌘J)" onClick={() => setAiOpen((o) => !o)}><Bot /></Button>
        <Button variant="ghost" size="icon-sm" onClick={onToggleTheme} aria-label="Toggle theme">{dark ? <Sun /> : <Moon />}</Button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* files */}
        <aside className="flex w-52 shrink-0 flex-col border-r bg-sidebar">
          <div className="flex items-center gap-1 px-3 pb-1 pt-2.5">
            <span className="flex-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Workspace</span>
            <Button variant="ghost" size="icon-sm" title="New file (.h, .cpp, .ino)" onClick={() => setNewFile("")}><FilePlus /></Button>
          </div>
          <div className="max-h-[38%] shrink-0 overflow-auto py-1 text-[13px]">
            {(multi ? [...builds.map((b) => b.part.id), null] : [null]).map((owner) => {
              // several boards: each board's files under its name; diagram.json is everyone's
              const names = multi ? (owner ? files.filter((f) => ownerOf(f.name, boards) === owner).map((f) => f.name) : [DIAGRAM]) : allFiles
              const b = owner ? builds.find((x) => x.part.id === owner) : undefined
              return (
                <div key={owner ?? "shared"}>
                  {b && (
                    <button className={cn("mt-1 flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-[12px] font-medium hover:bg-accent/60", owner === focusId && "text-primary")} title={`Show ${owner}'s code`} onClick={() => { showCode(owner!); setSelected(owner) }}>
                      <Cpu className="size-3.5 shrink-0" /><span className="truncate">{owner}</span><span className="truncate text-[10px] font-normal text-muted-foreground">{b.def?.name}</span>
                      {statuses[owner!]?.kind === "ok" && hexes[owner!]?.key === b.key && <Check className="ml-auto size-3 shrink-0 text-success" />}
                      {running && frames[owner!] && <span className="ml-auto size-1.5 shrink-0 rounded-full bg-success" title="Running" />}
                    </button>
                  )}
                  {names.map((n) => {
              const Icon = fileIcon(n)
              const errs = diagnostics.filter((d) => d.file === n && d.severity === "error").length
              return renaming === n ? (
                <Input key={n} autoFocus defaultValue={shortName(n)} className="mx-2 my-0.5 h-7 w-[calc(100%-16px)] font-mono text-xs" onBlur={(e) => renameFile(n, e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") renameFile(n, (e.target as HTMLInputElement).value); if (e.key === "Escape") setRenaming(null) }} />
              ) : (
                <div key={n} className={cn("group flex items-center gap-1.5 py-1 pr-1.5", multi && n !== DIAGRAM ? "pl-6" : "pl-3", " hover:bg-accent/60", active === n && "bg-accent font-medium")}>
                  <button className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => open(n)} onDoubleClick={() => !fixed(n) && setRenaming(n)}>
                    <Icon className={cn("size-3.5 shrink-0", n === DIAGRAM ? "text-warning" : "text-muted-foreground")} />
                    <span className="truncate">{multi ? shortName(n) : n}</span>
                    {shortName(n) === "libraries.txt" && (builds.find((x) => x.prefix === n.slice(0, n.length - 13))?.libraries.length ?? 0) > 0 && <span className="ml-auto rounded bg-muted px-1 text-[10px] tabular-nums text-muted-foreground">{builds.find((x) => x.prefix === n.slice(0, n.length - 13))?.libraries.length}</span>}
                    {errs > 0 && <span className="ml-auto rounded bg-destructive/15 px-1 text-[10px] text-destructive">{errs}</span>}
                  </button>
                  {!fixed(n) && <button className="invisible rounded p-0.5 text-muted-foreground hover:text-destructive group-hover:visible" title={`Delete ${n}`} onClick={() => deleteFile(n)}><Trash2 className="size-3.5" /></button>}
                </div>
              )
            })}
                </div>
              )
            })}
            {newFile !== null && <Input autoFocus placeholder="name.h" className="mx-2 my-0.5 h-7 w-[calc(100%-16px)] font-mono text-xs" onBlur={(e) => { addFile(e.target.value); setNewFile(null) }} onKeyDown={(e) => { if (e.key === "Enter") { addFile((e.target as HTMLInputElement).value); setNewFile(null) } if (e.key === "Escape") setNewFile(null) }} />}
          </div>
          <PartsPalette onAdd={(p) => addPart(p)} onMore={() => setAdding(true)} hasBoard={!!boardPart} />
        </aside>

        {/* editor */}
        <div className="flex min-w-0 shrink-0 flex-col" style={{ width: editorW }}>
          {/* no visible scrollbar: with macOS "always show scroll bars" it ate the strip's height and
              pushed the tabs under the header; the strip still scrolls (wheel / trackpad) */}
          <div className="flex h-9 shrink-0 items-end gap-0.5 overflow-x-auto overflow-y-hidden border-b bg-sidebar px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            onWheel={(e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY }}>
            {tabs.map((t) => (
              <div key={t} ref={(el) => { if (el && active === t) el.scrollIntoView({ block: "nearest", inline: "nearest" }) }}
                className={cn("group flex h-8 shrink-0 items-center gap-1 rounded-t-md border-x border-t px-2.5 text-xs", active === t ? "border-border bg-background" : "border-transparent text-muted-foreground hover:text-foreground")}>
                <button onClick={() => setActive(t)} className="font-mono">{t}</button>
                {tabs.length > 1 && <button onClick={() => closeTab(t)} className="rounded opacity-0 hover:bg-accent group-hover:opacity-100"><X className="size-3" /></button>}
              </div>
            ))}
          </div>
          {active === DIAGRAM && diagramError && <div className="border-b bg-destructive/10 px-3 py-1 text-[11px] text-destructive">{diagramError}</div>}
          <div className="min-h-0 flex-1">
            <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-muted-foreground"><Loader2 className="mr-2 size-4 animate-spin" /> Loading editor…</div>}>
              <MemoEditor path={active} language={langOf(active)} value={active === DIAGRAM ? diagramDraft ?? textOf(DIAGRAM) : textOf(active)} onChange={(v) => setText(active, v)} dark={dark} diagnostics={diagnostics.filter((d) => d.file === active)} live={active === DIAGRAM ? null : liveView} />
            </Suspense>
          </div>
        </div>
        <Splitter axis="x" onDrag={(d) => setEditorW((w) => Math.max(260, Math.min(window.innerWidth - 500, w + d)))} onReset={() => setEditorW(Math.round(window.innerWidth * 0.32))} />

        {/* canvas + serial */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1">
            <McuCanvas diagram={diagram} onChange={setDiagram} frame={frame} running={running} onUi={sendUi} selected={selected} onSelect={selectPart} onCode={showCode}
              onSettings={setSettingsFor} onRestart={() => running && startWith(firmware())} apiRef={canvas} dark={dark} badge={statusBadge}
              onSeated={setSeated}
              onDropPart={(t, x, y) => { const info = PARTS.find((p) => p.key === t) ?? partInfo(t); if (info) addPart(info, { x, y }) }}
              corner={<>
                <Button size="sm" variant="outline" className="bg-popover shadow-sm" disabled={!frame} title={frame ? "Solve the circuit at this instant with ngspice: exact currents, voltages and power" : "Run the sketch first"} onClick={() => setChecking((focusId && frames[focusId]?.snapshot) || frame?.snapshot || null)}><Zap /> Check with ngspice</Button>
                <Button size="sm" variant="outline" className="bg-popover shadow-sm" onClick={() => setAdding(true)}><Plus /> Add Part</Button>
              </>}
              voltsAt={(end) => {
                const [id, pin] = splitEnd(end)
                // the board that drives this part: its own, or one it is wired to
                const order = boards.some((b) => b.id === id) ? [id] : [focusId, ...boards.map((b) => b.id)]
                for (const bid of order) { const c = bid && circuits.get(bid), f = bid && frames[bid]; if (!c || !f) continue; const n = c.net(id, pin); if (n >= 0 && c.members[n].length > 1) return f.volts[n] ?? null }
                return null
              }} />
            {multi && links.length > 0 && <div className="absolute bottom-14 left-1/2 z-10 -translate-x-1/2 rounded-md border bg-popover px-2 py-1 text-[11px] text-muted-foreground shadow">Wires between two boards' signal pins aren't simulated yet ({links.map((c) => `${c[0]}–${c[1]}`).slice(0, 3).join(", ")}{links.length > 3 ? " …" : ""}) — each board runs on its own, sharing ground.</div>}
            {controls && sel && (
              <div className="absolute bottom-14 left-3 z-10 max-h-[60%] w-64 overflow-auto rounded-lg border bg-popover p-3 shadow-md" onPointerDown={(e) => e.stopPropagation()}>
                <div className="mb-2 text-xs font-semibold">{sel.id} <span className="font-normal text-muted-foreground">{partInfo(sel.type)?.title}</span></div>
                {controls.map((c) => {
                  const attr = sel.attrs[c.attr] !== undefined && sel.attrs[c.attr] !== "" ? Number(sel.attrs[c.attr]) : NaN
                  const v = (c.cat ? ui[sel.id]?.v?.[c.key] : (ui[sel.id] as Record<string, number> | undefined)?.[c.key]) ?? (Number.isFinite(attr) ? attr : c.def ?? c.min)
                  return (
                    <div key={c.key} className="mb-2">
                      <div className="mb-1 flex justify-between gap-2 text-[11px]"><span className="truncate">{c.label}</span><span className="shrink-0 font-mono tabular-nums">{Math.round(v * 1000) / 1000} {c.unit}</span></div>
                      <Slider min={c.min} max={c.max} step={c.step} value={[v]} onValueChange={([x]) => sendUi(sel.id, c.cat ? { v: { [c.key]: x } } : { [c.key]: x })} />
                    </div>
                  )
                })}
              </div>
            )}
            {frame && frame.warnings.length > 0 && (
              <div className="absolute right-3 top-3 z-10 max-w-sm rounded-lg border border-warning/40 bg-popover p-2 text-xs shadow-md">
                {frame.warnings.map((w) => <div key={w} className="flex gap-1.5 py-0.5"><TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />{w}</div>)}
              </div>
            )}
            {frame && frame.i2cMissing.length > 0 && <div className="absolute bottom-14 right-3 z-10 rounded-md border bg-popover px-2 py-1 text-[11px] shadow">No I²C device answers at {frame.i2cMissing.map((a) => `0x${a.toString(16)}`).join(", ")}</div>}
          </div>
          <Splitter axis="y" onDrag={(d) => setBottomH((h) => Math.max(90, Math.min(window.innerHeight - 260, h - d)))} onReset={() => setBottomH(200)} />
          <div className="flex shrink-0 flex-col border-t bg-sidebar" style={{ height: bottomH }}>
            <div className="flex h-8 shrink-0 items-center gap-1 border-b px-2">
              {([["serial", "Serial Monitor"], ["logic", "Logic Analyser"], ["output", "Output"], ["problems", `Problems${diagnostics.length ? ` (${diagnostics.length})` : ""}`]] as const).map(([k, l]) => (
                <button key={k} onClick={() => setBottom(k)} className={cn("rounded px-2 py-0.5 text-xs", bottom === k ? "bg-background font-medium shadow-sm ring-1 ring-border" : "text-muted-foreground hover:text-foreground")}>{l}</button>
              ))}
              <div className="flex-1" />
              {multi && (bottom === "serial" || bottom === "output") && (
                <div className="flex items-center gap-0.5 rounded-md bg-muted p-0.5" title="Which board's Serial and compile output to show">
                  {boards.map((b) => <button key={b.id} onClick={() => showCode(b.id)} className={cn("rounded px-1.5 py-px font-mono text-[10px]", b.id === focusId ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground")}>{b.id}{serials[b.id] && b.id !== focusId ? " •" : ""}</button>)}
                </div>
              )}
              {focusStatus.kind === "ok" && focusStatus.out.flash && <span className="font-mono text-[10px] text-muted-foreground">flash {focusStatus.out.flash.used}/{focusStatus.out.flash.max} B · RAM {focusStatus.out.ram?.used}/{focusStatus.out.ram?.max} B</span>}
              {bottom === "serial" && <Button variant="ghost" size="icon-sm" title="Clear" onClick={() => setSerial(() => "")}><Trash2 /></Button>}
            </div>
            {bottom === "serial" && (
              <>
                <div ref={serialBox} className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all px-3 py-1.5 font-mono text-xs">{serial || <span className="text-muted-foreground">{running ? `Waiting for Serial output${multi ? ` from ${focusId}` : ""}…` : "Run the sketch to see Serial output here."}</span>}</div>
                <form className="flex shrink-0 items-center gap-1 border-t p-1" onSubmit={(e) => { e.preventDefault(); if (!running) return; if (board?.chip === "esp32") espSend(serialIn + lineEnd).catch(() => {}); else if (focusId && fedChips.current.has(focusId)) fedChips.current.get(focusId)!.serialWrite(serialIn + lineEnd); else if (focusId) workers.current.get(focusId)?.postMessage({ type: "serial", text: serialIn + lineEnd } satisfies ToWorker); setSerialIn("") }}>
                  <Input value={serialIn} onChange={(e) => setSerialIn(e.target.value)} disabled={!running} placeholder={running ? `Send to ${multi ? focusId : "the sketch"} (Enter)` : "Serial input (while running)"} className="h-7 font-mono text-xs" />
                  <Select value={lineEnd === "\n" ? "nl" : lineEnd === "\r\n" ? "crlf" : "none"} onValueChange={(v) => setLineEnd(v === "nl" ? "\n" : v === "crlf" ? "\r\n" : "")}>
                    <SelectTrigger size="sm" className="h-7 w-28 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="nl">Newline</SelectItem><SelectItem value="crlf">CR + LF</SelectItem><SelectItem value="none">No ending</SelectItem></SelectContent>
                  </Select>
                  <Button type="submit" size="icon-sm" variant="ghost" disabled={!running}><Send /></Button>
                </form>
              </>
            )}
            {bottom === "logic" && <LogicAnalyzer buffer={logic.current} running={running} dark={dark} name={name} />}
            {bottom === "output" && (
              <div className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap px-3 py-1.5 font-mono text-xs">
                {focusStatus.kind === "idle" && <span className="text-muted-foreground">Compile (⌘B) to see arduino-cli's output.</span>}
                {focusStatus.kind === "compiling" && <span className="flex items-center gap-2 text-muted-foreground"><Loader2 className="size-3 animate-spin" /> Compiling for {board?.name} ({board?.fqbn}){libraries.length ? ` with ${libraries.join(", ")}` : ""}…</span>}
                {focusStatus.kind === "ok" && <><div className="mb-1 flex items-center gap-1.5 text-success"><Check className="size-3.5" /> Compiled</div>{focusStatus.out.log}</>}
                {focusStatus.kind === "error" && (
                  <>
                    {focusStatus.message && <div className="mb-2 text-destructive">{focusStatus.message}</div>}
                    <Button size="sm" variant="outline" className="mb-2 mr-2" onClick={() => askAi(`It doesn't build: ${focusStatus.message ?? focusStatus.out?.diagnostics.filter((d) => d.severity === "error").slice(0, 8).map((d) => `${d.file}:${d.line}: ${d.message}`).join("\n") ?? "see the compiler output"}\nFind the cause and fix it, then run it.`)}><Bot /> Fix with assistant</Button>
                    {focusStatus.message?.includes("core is not installed") && board && (
                      <Button size="sm" className="mb-2" onClick={async () => { const id = toast.loading(`Installing ${coreOf(board.fqbn)}…`); try { await installCore(coreOf(board.fqbn), s.arduinoCliPath, board.coreUrl); toast.success("Installed", { id }); compile() } catch (e) { toast.error(String(e), { id }) } }}><Download /> Install {coreOf(board.fqbn)}</Button>
                    )}
                    {focusStatus.message?.includes("not found") && <Button size="sm" variant="outline" className="mb-2" onClick={onOpenSettings}>Set the arduino-cli path…</Button>}
                    {focusStatus.out?.log}
                  </>
                )}
              </div>
            )}
            {bottom === "problems" && (
              <div className="min-h-0 flex-1 overflow-auto py-1 text-xs">
                {!diagnostics.length && <div className="px-3 py-1 text-muted-foreground">No problems.</div>}
                {errors.length > 0 && <Button size="sm" variant="outline" className="mx-3 my-1" onClick={() => askAi(`It doesn't build:\n${errors.slice(0, 8).map((d) => `${d.file}:${d.line}: ${d.message}`).join("\n")}\nFind the cause and fix it, then run it.`)}><Bot /> Fix with assistant</Button>}
                {diagnostics.map((d, i) => (
                  <button key={i} className="flex w-full items-start gap-2 px-3 py-1 text-left hover:bg-accent/60" onClick={() => { open(d.file); setTimeout(() => window.dispatchEvent(new CustomEvent("sb-reveal-line", { detail: d })), 50) }}>
                    {d.severity === "error" ? <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" /> : <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />}
                    <span className="font-mono text-muted-foreground">{d.file}:{d.line}</span><span>{d.message}</span>
                  </button>
                ))}
                {errors.length === 0 && frame?.warnings.map((w) => <div key={w} className="flex gap-2 px-3 py-1"><Zap className="mt-0.5 size-3.5 text-warning" />{w}</div>)}
              </div>
            )}
          </div>
        </div>

        {aiOpen && (
          <>
            <Splitter axis="x" onDrag={(d) => setAiW((w) => Math.max(300, Math.min(700, w - d)))} onReset={() => setAiW(380)} />
            <div className="flex min-h-0 shrink-0 flex-col border-l" style={{ width: aiW }}>
              <AiChat profile={profile} sessionKey={chatKey ?? "sketch"} request={aiAsk} onOpenSettings={onOpenSettings} onOpenTerminal={() => setBottom("output")} onClose={() => setAiOpen(false)} />
            </div>
          </>
        )}
      </div>

      <Dialog open={!!perm} onOpenChange={(o) => { if (!o) answer(false) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{perm?.title}</DialogTitle>
            <DialogDescription>The assistant asks to do this{perm?.reason ? ` — ${perm.reason}` : "."}</DialogDescription>
          </DialogHeader>
          <pre className="whitespace-pre-wrap break-all rounded-md bg-muted px-3 py-2 font-mono text-xs">{perm?.detail}</pre>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => answer(false)}>Don't allow</Button>
            <Button onClick={() => answer(true)}><Download /> Allow</Button>
          </div>
        </DialogContent>
      </Dialog>
      {installing && <div className="fixed bottom-4 left-1/2 z-50 flex max-w-[80vw] -translate-x-1/2 items-center gap-2 rounded-full border bg-popover px-3 py-1.5 text-xs shadow-md"><Loader2 className="size-3.5 shrink-0 animate-spin" /><span className="truncate">{installing}</span></div>}
      <CheckDialog open={!!checking} onOpenChange={(o) => !o && setChecking(null)} diagram={focusId ? boardDiagram(simDiagram, focusId) : simDiagram} board={board} snapshot={checking} />
      <AddPartDialog open={adding} onOpenChange={setAdding} onAdd={addPart} hasBoard={!!boardPart} />
      <PartSettingsDialog part={diagram.parts.find((p) => p.id === settingsFor) ?? null} onClose={() => setSettingsFor(null)} onChange={updatePart} onBoardType={changeBoard} />
    </div>
  )
}

// ── Parts palette (left sidebar) ─────────────────────────────────────────────────────────
function PartsPalette({ onAdd, onMore, hasBoard }: { onAdd: (p: PartInfo) => void; onMore: () => void; hasBoard: boolean }) {
  const [q, setQ] = useState("")
  const [open, setOpen] = useState<Record<string, boolean>>({ Output: true, Input: true })
  const list = PARTS.filter((p) => !q || `${p.title} ${p.type} ${p.hint}`.toLowerCase().includes(q.toLowerCase()))
  return (
    <div className="flex min-h-0 flex-1 flex-col border-t">
      <div className="flex items-center gap-1 px-3 pb-1 pt-2.5">
        <span className="flex-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Parts</span>
        <Button variant="ghost" size="icon-sm" title="Browse all parts" onClick={onMore}><Plus /></Button>
      </div>
      <div className="relative px-2 pb-1">
        <Search className="absolute left-4 top-2 size-3.5 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="LED, servo, sensor…" className="h-7 pl-7 text-xs" />
      </div>
      <div className="min-h-0 flex-1 overflow-auto pb-2">
        {CATEGORIES.map((cat) => {
          const items = list.filter((p) => p.category === cat)
          if (!items.length) return null
          const isOpen = q ? true : open[cat] ?? false
          return (
            <div key={cat}>
              <button className="flex w-full items-center gap-1 px-3 py-1 text-left text-[11px] font-medium text-muted-foreground hover:text-foreground" onClick={() => setOpen((o) => ({ ...o, [cat]: !isOpen }))}>
                <ChevronDown className={cn("size-3 transition-transform", !isOpen && "-rotate-90")} />{cat}{cat === "Boards" && hasBoard ? " (add)" : ""}<span className="ml-auto tabular-nums">{items.length}</span>
              </button>
              {isOpen && items.map((p) => (
                <button key={p.key ?? p.type} draggable onDragStart={(e) => { e.dataTransfer.setData(PART_DRAG, p.key ?? p.type); e.dataTransfer.effectAllowed = "copy" }}
                  onClick={() => onAdd(p)} title={`${p.hint}\nClick to add, or drag onto the canvas`}
                  className="flex w-full items-center gap-2 px-3 py-1 text-left text-[12px] hover:bg-accent/60">
                  <PartThumb type={p.type} attrs={p.attrs} size={30} />
                  <span className={cn("min-w-0 truncate", !p.sim && "text-muted-foreground")}>{p.title}</span>
                </button>
              ))}
            </div>
          )
        })}
        {!list.length && <p className="px-3 py-2 text-xs text-muted-foreground">No part matches.</p>}
      </div>
    </div>
  )
}

const MemoEditor = memo(function MemoEditor(props: { path: string; language: string; value: string; onChange: (v: string) => void; dark: boolean; diagnostics: Diagnostic[]; live: LiveView | null }) {
  return <SketchEditor {...props} />
})

// ── Add part ─────────────────────────────────────────────────────────────────────────────
const partText = (p: PartInfo) => `${p.title} ${p.type} ${p.hint} ${p.category} ${p.sub ?? ""}`.toLowerCase()
function AddPartDialog({ open, onOpenChange, onAdd, hasBoard }: { open: boolean; onOpenChange: (o: boolean) => void; onAdd: (p: PartInfo) => void; hasBoard: boolean }) {
  const [q, setQ] = useState("")
  const [where, setWhere] = useState("all") // "all", a group, or "group/sub"
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})
  const [simOnly, setSimOnly] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const found = PARTS.filter((p) => (!simOnly || p.sim) && words.every((w) => partText(p).includes(w)))
  const tree = CATEGORIES.map((g) => {
    const items = found.filter((p) => p.category === g)
    const subs = [...new Set(items.map((p) => p.sub).filter(Boolean))] as string[]
    return { g, n: items.length, subs: subs.map((s) => ({ s, n: items.filter((p) => p.sub === s).length })) }
  }).filter((x) => x.n)
  const shown = found.filter((p) => where === "all" || p.category === where || `${p.category}/${p.sub}` === where)
  const sections: { title: string; items: PartInfo[] }[] = []
  for (const g of CATEGORIES) {
    const inG = shown.filter((p) => p.category === g)
    const subs = [...new Set(inG.map((p) => p.sub ?? ""))]
    for (const s of subs) { const items = inG.filter((p) => (p.sub ?? "") === s); if (items.length) sections.push({ title: s ? `${g} / ${s}` : g, items }) }
  }
  useEffect(() => { scroller.current?.scrollTo({ top: 0 }) }, [where, q, simOnly])
  const side = (key: string, label: string, n: number, depth = 0, chevron?: boolean) => (
    <button key={key} onClick={() => { setWhere(key); if (chevron) setOpenGroups((o) => ({ ...o, [key]: !o[key] })) }}
      className={cn("flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-accent/60", where === key && "bg-accent font-medium text-accent-foreground", depth && "py-1 pl-7 text-xs text-muted-foreground")}>
      {chevron !== undefined && <ChevronDown className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", !(openGroups[key] || q) && "-rotate-90", !chevron && "invisible")} />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="text-[11px] tabular-nums text-muted-foreground">{n}</span>
    </button>
  )
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[86vh] w-[min(1280px,96vw)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
        <DialogHeader className="flex-row items-center gap-4 space-y-0 border-b px-5 py-3 pr-12">
          <DialogTitle className="shrink-0 text-lg">Add Component</DialogTitle>
          <DialogDescription className="sr-only">Every part you can place on the canvas; most are simulated with the sketch.</DialogDescription>
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input autoFocus placeholder="Search components — BME280, relay, OLED, Grove, ESP32…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
          </div>
          <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <input type="checkbox" checked={simOnly} onChange={(e) => setSimOnly(e.target.checked)} className="accent-primary" /> Simulated only
          </label>
        </DialogHeader>
        <div className="flex min-h-0 flex-1">
          <div className="w-60 shrink-0 overflow-auto border-r p-2">
            {side("all", "All Components", found.length)}
            {tree.map((t) => (
              <div key={t.g}>
                {side(t.g, t.g, t.n, 0, t.subs.length > 0)}
                {(openGroups[t.g] || (q && t.subs.length > 0)) && t.subs.map((s) => side(`${t.g}/${s.s}`, s.s, s.n, 1))}
              </div>
            ))}
          </div>
          <div ref={scroller} className="min-h-0 flex-1 overflow-auto px-5 pb-5">
            {sections.map((sec) => (
              <section key={sec.title}>
                <div className="sticky top-0 z-10 -mx-5 mb-3 bg-background/95 px-5 pb-2 pt-4 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur">
                  {sec.title} <span className="ml-1 font-normal tabular-nums">{sec.items.length}</span>
                  {sec.title === "Boards" && hasBoard && <span className="ml-2 font-normal normal-case tracking-normal">— an emulated board is added next to yours, with its own sketch</span>}
                </div>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-3">
                  {sec.items.map((p) => (
                    <button key={p.key} onClick={() => onAdd(p)} title={`${p.title}\n\n${p.hint}`}
                      className="group relative flex flex-col gap-1.5 rounded-lg border bg-card p-2 text-left transition-colors hover:border-ring hover:bg-accent/30">
                      {!p.sim && <Badge variant="outline" className="absolute right-1.5 top-1.5 z-10 bg-background/90 px-1.5 py-0 text-[9px] font-medium" title={p.noEmu ?? "Placed and wired — not simulated yet"}>{p.noEmu ? "No emulator" : "Drawing only"}</Badge>}
                      <LazyThumb type={p.type} attrs={p.attrs} root={scroller} />
                      <span className="line-clamp-2 text-[13px] font-medium leading-tight">{p.title}</span>
                      <span className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">{p.hint}</span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
            {!sections.length && <p className="py-10 text-center text-sm text-muted-foreground">No component matches “{q}”.</p>}
          </div>
        </div>
        <div className="flex items-center gap-3 border-t px-5 py-2 text-xs text-muted-foreground">
          <span className="tabular-nums">{shown.length} items</span>
          <span>· {PARTS.filter((p) => p.sim).length} of {PARTS.length} simulated</span>
          <span className="ml-auto">Click a component to add it · drag from a pin to wire it</span>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** A thumbnail that only mounts its element once it scrolls into view. */
function LazyThumb({ type, attrs, root }: { type: string; attrs?: Record<string, string>; root: React.RefObject<HTMLDivElement | null> }) {
  const box = useRef<HTMLDivElement>(null)
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    const el = box.current
    if (!el || seen) return
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect() } }, { root: root.current, rootMargin: "200px" })
    io.observe(el)
    return () => io.disconnect()
  }, [seen, root])
  return <div ref={box} className="flex h-24 items-center justify-center overflow-hidden rounded-md bg-muted/50">{seen ? <PartThumb type={type} attrs={attrs} size={92} /> : null}</div>
}

/** The real element, scaled into a box. */
export function PartThumb({ type, attrs, size = 84 }: { type: string; attrs?: Record<string, string>; size?: number }) {
  const box = useRef<HTMLDivElement>(null)
  const [k, setK] = useState(1)
  useEffect(() => {
    const fit = () => { const el = box.current?.firstElementChild as HTMLElement | null; if (!el) return; const w = el.offsetWidth || 1, h = el.offsetHeight || 1; setK(Math.min(1.6, (size - 8) / Math.max(w, h))) }
    const t = [setTimeout(fit, 20), setTimeout(fit, 200)]
    return () => t.forEach(clearTimeout)
  }, [type, size])
  return (
    <div className="pointer-events-none flex items-center justify-center overflow-hidden rounded-md bg-muted/40" style={{ width: size, height: size }}>
      <div ref={box} style={{ transform: `scale(${k})` }}>{createPart(type, attrs)}</div>
    </div>
  )
}
function createPart(type: string, attrs?: Record<string, string>) {
  const props: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(attrs ?? {})) props[k] = /^\d+$/.test(v) && k !== "pins" ? Number(v) : v
  return <PartEl tag={type} props={props} />
}
function PartEl({ tag, props }: { tag: string; props: Record<string, unknown> }) {
  const Tag = tag as unknown as React.ElementType
  return <Tag {...props} />
}

// ── Part settings ────────────────────────────────────────────────────────────────────────
function PartSettingsDialog({ part, onClose, onChange, onBoardType }: { part: DiagramPart | null; onClose: () => void; onChange: (id: string, patch: Partial<DiagramPart>) => void; onBoardType: (id: string, type: string) => void }) {
  const info = part ? partInfo(part.type) : undefined
  const [newKey, setNewKey] = useState("")
  if (!part) return null
  const setAttr = (k: string, v: string) => onChange(part.id, { attrs: { ...part.attrs, [k]: v } })
  const delAttr = (k: string) => { const a = { ...part.attrs }; delete a[k]; onChange(part.id, { attrs: a }) }
  const known = Object.keys(info?.settings ?? {})
  const extra = Object.keys(part.attrs).filter((k) => !known.includes(k))
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">{info?.title ?? part.type}</DialogTitle>
          <DialogDescription>{info?.hint}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-sm">
          {isBoardType(part.type) && (
            <label className="flex items-center gap-3">
              <span className="w-24 text-muted-foreground">Board</span>
              <Select value={part.type} onValueChange={(t) => onBoardType(part.id, t)}>
                <SelectTrigger size="sm" className="flex-1"><SelectValue /></SelectTrigger>
                <SelectContent>{BOARDS.map((b) => <SelectItem key={b.type} value={b.type}>{b.name}</SelectItem>)}</SelectContent>
              </Select>
            </label>
          )}
          <label className="flex items-center gap-3"><span className="w-24 text-muted-foreground">Id</span><Input defaultValue={part.id} className="h-8 font-mono" onBlur={(e) => onChange(part.id, { id: e.target.value })} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} /></label>
          {known.map((k) => {
            const opt = info!.settings![k]
            const v = part.attrs[k] ?? info?.attrs?.[k] ?? ""
            return (
              <label key={k} className="flex items-center gap-3">
                <span className="w-24 capitalize text-muted-foreground">{k}</span>
                {Array.isArray(opt) ? (
                  <Select value={v} onValueChange={(x) => setAttr(k, x)}>
                    <SelectTrigger size="sm" className="flex-1"><SelectValue /></SelectTrigger>
                    <SelectContent>{opt.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}</SelectContent>
                  </Select>
                ) : opt === "color" ? <input type="color" value={v || "#ff0000"} onChange={(e) => setAttr(k, e.target.value)} className="h-8 w-16 rounded border" />
                  : <Input defaultValue={v} type={opt === "number" ? "number" : "text"} className="h-8 flex-1 font-mono" onBlur={(e) => setAttr(k, e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />}
              </label>
            )
          })}
          {extra.length > 0 && <div className="mt-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Other attributes</div>}
          {extra.map((k) => (
            <div key={k} className="flex items-center gap-2">
              <span className="w-24 truncate font-mono text-xs text-muted-foreground">{k}</span>
              <Input defaultValue={part.attrs[k]} className="h-8 flex-1 font-mono" onBlur={(e) => setAttr(k, e.target.value)} />
              <Button variant="ghost" size="icon-sm" onClick={() => delAttr(k)}><X /></Button>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <Input placeholder="new attribute" value={newKey} onChange={(e) => setNewKey(e.target.value)} className="h-8 flex-1 font-mono text-xs" />
            <Button variant="outline" size="sm" disabled={!newKey.trim()} onClick={() => { setAttr(newKey.trim(), ""); setNewKey("") }}><Plus /> Add</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
