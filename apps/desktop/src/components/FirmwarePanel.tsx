// The firmware side of the circuit workspace: the sketch of each board in the schematic,
// compile, run the circuit and the firmware together, and the Serial Monitor.
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react"
import { Cpu, Hammer, Loader2, Play, Square, X, Sparkles } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import type { Doc, Firmware } from "@/editor/model"
import type { BoardDef } from "@/mcu/boards"
import { firmwareOf, type CoSimControl } from "@/cosim/useCoSim"
import type { LiveView } from "@/mcu/SketchEditor"

const SketchEditor = lazy(() => import("@/mcu/SketchEditor"))

const formatBytes = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)} kB` : `${n} B`)

export function FirmwarePanel({ doc, boards, active, setActive, onChange, cosim, dark, onClose, onAskAi }: {
  doc: Doc
  boards: { ref: string; board: BoardDef }[]
  active: string | null
  setActive: (ref: string) => void
  onChange: (ref: string, fw: Firmware) => void
  /** a compile or a run failed: hand it to the AI assistant */
  onAskAi?: (text: string) => void
  cosim: CoSimControl
  dark: boolean
  onClose: () => void
}) {
  const cur = boards.find((b) => b.ref === active) ?? boards[0]
  const fw = cur ? firmwareOf(doc, cur.ref, cur.board) : null
  const [file, setFile] = useState("sketch.ino")
  const [bottom, setBottom] = useState<"serial" | "output" | "terminal">("serial")
  const [line, setLine] = useState("")
  const [compiling, setCompiling] = useState(false)
  const serialEnd = useRef<HTMLDivElement>(null)
  const build = cur ? cosim.builds[cur.ref] : undefined
  const serial = cur ? cosim.serial[cur.ref] ?? "" : ""
  // while the circuit runs, the code shows what its pins are doing
  const pins = cur ? cosim.live[cur.ref] : undefined
  const live = useMemo<LiveView | null>(() => (cur && pins && cosim.status === "running"
    ? { pins, vcc: cur.board.vcc, seconds: cosim.clock?.t ?? 0, serial: serial.slice(-4000), led: cur.board.led }
    : null), [cur, pins, cosim.status, cosim.clock, serial])

  useEffect(() => { serialEnd.current?.scrollIntoView({ block: "end" }) }, [serial])
  useEffect(() => { if (build && !build.ok) setBottom("output") }, [build])
  useEffect(() => { setFile(cur?.board.chip === "linux" ? "main.py" : "sketch.ino") }, [cur?.ref]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!cur || !fw) return null
  const linux = cur.board.chip === "linux"
  // Linux boards run Python (packages come from pip in the Terminal); sketches have libraries.txt
  const files = linux ? fw.files.map((f) => f.name) : [...fw.files.map((f) => f.name), "libraries.txt"]
  const isLibs = !linux && file === "libraries.txt"
  const content = isLibs ? fw.libraries ?? "" : fw.files.find((f) => f.name === file)?.content ?? ""
  const setContent = (v: string) => onChange(cur.ref, isLibs ? { ...fw, libraries: v } : { ...fw, files: fw.files.map((f) => (f.name === file ? { ...f, content: v } : f)) })

  const compileNow = async () => {
    setCompiling(true)
    try { await cosim.compile(cur.ref); setBottom("output") } catch (e) { toast.error(e instanceof Error ? e.message : String(e)) } finally { setCompiling(false) }
  }
  const status = cosim.status === "running" && cosim.clock
    ? `Running · ${cosim.clock.t.toFixed(2)} s · ${cosim.clock.speed >= 0.995 ? "real time" : `${(cosim.clock.speed * 100).toFixed(0)} % of real time`}`
    : cosim.status === "compiling" || compiling ? "Compiling…"
    : cosim.status === "starting" ? "Starting the chips…"
    : cosim.status === "error" ? cosim.error ?? "Failed"
    : build ? (build.ok ? `Compiled${build.flash ? ` · ${formatBytes(build.flash.used)} of ${formatBytes(build.flash.max)}` : ""}` : "Compile failed")
    : "Not compiled yet"

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-1.5 border-b px-2 py-1.5">
        <Cpu className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">Firmware</span>
        <div className="ml-1 flex min-w-0 gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {boards.map((b) => (
            <button key={b.ref} onClick={() => setActive(b.ref)} title={b.board.name}
              className={`h-7 shrink-0 rounded-md px-2 text-xs ${b.ref === cur.ref ? "bg-accent font-medium" : "text-muted-foreground hover:text-foreground"}`}>
              {b.ref} · {b.board.name.replace(/^Arduino /, "").replace(/^Raspberry Pi /, "")}
            </button>
          ))}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button size="sm" variant="outline" className="h-7 gap-1.5" disabled={compiling || cosim.active} onClick={compileNow} title="Compile with arduino-cli">
            {compiling ? <Loader2 className="size-3.5 animate-spin" /> : <Hammer className="size-3.5" />} Compile
          </Button>
          {cosim.active
            ? <Button size="sm" variant="destructive" className="h-7 gap-1.5" onClick={cosim.stop} title="Stop the circuit and the firmware"><Square className="size-3.5" /> Stop</Button>
            : <Button size="sm" className="h-7 gap-1.5" onClick={cosim.start} title="Simulate the circuit and run the firmware together"><Play className="size-3.5" /> Run</Button>}
          <button onClick={onClose} title="Close the firmware panel" aria-label="Close the firmware panel"
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"><X className="size-4" /></button>
        </div>
      </div>
      <div className={`flex shrink-0 items-center gap-2 border-b px-3 py-1 text-xs ${cosim.status === "error" || (build && !build.ok) ? "text-destructive" : "text-muted-foreground"}`} title={status}>
        <span className="min-w-0 flex-1 truncate">{(cosim.status === "compiling" || cosim.status === "starting" || compiling) && <Loader2 className="mr-1 inline size-3 animate-spin" />}{status}</span>
        {onAskAi && (cosim.status === "error" || (build && !build.ok)) && (
          <button className="flex shrink-0 items-center gap-1 rounded-md border border-destructive/40 px-2 py-0.5 text-[11px] font-medium text-foreground hover:bg-accent"
            onClick={() => onAskAi(cosim.status === "error"
              ? `Running the circuit with the firmware failed: ${cosim.error ?? "unknown error"}\nFind the cause and fix it, then run it again.`
              : `${cur?.ref ?? "The board"}'s sketch doesn't compile:\n${build?.diagnostics.filter((d) => d.severity === "error").slice(0, 8).map((d) => `${d.file}:${d.line}: ${d.message}`).join("\n") || build?.log.slice(-1500) || "see the compiler output"}\nFind the cause and fix it, then compile and run it.`)}>
            <Sparkles className="size-3" /> Fix with AI
          </button>
        )}
      </div>
      <div className="flex shrink-0 gap-1 border-b px-2 py-1">
        {files.map((f) => (
          <button key={f} onClick={() => setFile(f)} className={`h-6 rounded px-2 font-mono text-xs ${f === file ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}>{f}</button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        <Suspense fallback={<div className="flex h-full items-center justify-center text-xs text-muted-foreground"><Loader2 className="mr-2 size-4 animate-spin" />Loading the editor…</div>}>
          <SketchEditor path={`${cur.ref}/${file}`} language={isLibs ? "plaintext" : file.endsWith(".py") ? "python" : "cpp"} value={content} onChange={setContent} dark={dark}
            diagnostics={isLibs ? [] : (build?.diagnostics ?? []).filter((d) => d.file === file)} live={isLibs ? null : live} />
        </Suspense>
      </div>
      <div className="flex h-[38%] min-h-[140px] shrink-0 flex-col border-t">
        <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
          {([["serial", linux ? "Program" : "Serial Monitor"], ["output", "Output"], ...(linux ? [["terminal", "Terminal"]] as const : [])] as const).map(([k, l]) => (
            <button key={k} onClick={() => setBottom(k)} className={`h-6 rounded px-2 text-xs ${bottom === k ? "bg-accent font-medium" : "text-muted-foreground hover:text-foreground"}`}>{l}</button>
          ))}
          {bottom === "serial" && <button onClick={() => cosim.clearSerial(cur.ref)} className="ml-auto h-6 rounded px-2 text-xs text-muted-foreground hover:text-foreground">Clear</button>}
        </div>
        {bottom === "terminal" ? <LinuxTerminal board={cur.board} /> : bottom === "serial" ? (
          <>
            <div className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-xs whitespace-pre-wrap">
              {serial || <span className="text-muted-foreground">{cosim.active ? "Nothing printed yet." : linux ? "Press Run: the program's output (print) appears here." : "Press Run: the sketch's Serial output appears here."}</span>}
              <div ref={serialEnd} />
            </div>
            <form className="flex shrink-0 gap-1 border-t p-1.5" onSubmit={(e) => { e.preventDefault(); if (!line) return; cosim.sendSerial(cur.ref, line + "\n"); setLine("") }}>
              <input value={line} onChange={(e) => setLine(e.target.value)} disabled={cosim.status !== "running"} placeholder={cosim.status === "running" ? `Send to ${cur.ref}…` : "Run to send"}
                className="h-7 min-w-0 flex-1 rounded-md border bg-transparent px-2 font-mono text-xs outline-none focus:border-ring disabled:opacity-50" />
              <Button type="submit" size="sm" variant="outline" className="h-7" disabled={cosim.status !== "running" || !line}>Send</Button>
            </form>
          </>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-xs whitespace-pre-wrap">
            {build?.diagnostics.filter((d) => d.severity === "error").map((d, i) => (
              <button key={i} className="block text-left text-destructive hover:underline" onClick={() => { setFile(d.file); setTimeout(() => window.dispatchEvent(new CustomEvent("sb-reveal-line", { detail: { ...d, file: `${cur.ref}/${d.file}` } })), 50) }}>
                {d.file}:{d.line}: {d.message}
              </button>
            ))}
            {build ? build.log || "(no output)" : <span className="text-muted-foreground">Compile to see the compiler's output.</span>}
          </div>
        )}
      </div>
    </div>
  )
}

/** The Linux board's console (logged in as pi): pip, apt, files — anything Linux. */
function LinuxTerminal({ board }: { board: BoardDef }) {
  const [text, setText] = useState("")
  const [line, setLine] = useState("")
  const [running, setRunning] = useState(false)
  const [starting, setStarting] = useState(false)
  const end = useRef<HTMLDivElement>(null)
  const vmRef = useRef<import("@/linux/agent").LinuxVm | null>(null)
  useEffect(() => {
    let off = () => {}
    let alive = true
    import("@/linux/agent").then(({ linuxVm }) => {
      if (!alive) return
      const vm = linuxVm()
      vmRef.current = vm
      const on = (t: string) => setText(t)
      vm.consoleListeners.add(on)
      setText(vm.consoleText)
      setRunning(vm.running)
      const tick = setInterval(() => setRunning(vm.running), 1000)
      off = () => { vm.consoleListeners.delete(on); clearInterval(tick) }
    })
    return () => { alive = false; off() }
  }, [])
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }) }, [text])
  const start = async () => {
    const vm = vmRef.current
    if (!vm) return
    setStarting(true)
    try { await vm.boot((board.linux ?? "pi5") as import("@/linux/agent").LinuxBoardId); await vm.console("\n") } catch (e) { toast.error(e instanceof Error ? e.message : String(e)) } finally { setStarting(false); setRunning(vm.running) }
  }
  const shown = text.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\r/g, "")
  return (
    <>
      <div className="min-h-0 flex-1 overflow-auto bg-[#111] px-3 py-2 font-mono text-xs whitespace-pre-wrap text-[#ddd]">
        {shown || <span className="text-[#888]">{running ? "Press Enter for a prompt." : `${board.name} isn't running. Run the circuit, or start it here to install packages (pip install …).`}</span>}
        <div ref={end} />
      </div>
      <form className="flex shrink-0 gap-1 border-t p-1.5" onSubmit={(e) => { e.preventDefault(); void vmRef.current?.console(line + "\n"); setLine("") }}>
        {running ? (
          <input value={line} onChange={(e) => setLine(e.target.value)} placeholder="pi@raspberrypi:~ $"
            className="h-7 min-w-0 flex-1 rounded-md border bg-transparent px-2 font-mono text-xs outline-none focus:border-ring" />
        ) : (
          <Button type="button" size="sm" variant="outline" className="h-7" disabled={starting} onClick={start}>{starting && <Loader2 className="size-3.5 animate-spin" />}Start {board.name}</Button>
        )}
        {running && <Button type="submit" size="sm" variant="outline" className="h-7">Enter</Button>}
        {running && <Button type="button" size="sm" variant="ghost" className="h-7" title="Ctrl-C" onClick={() => void vmRef.current?.console("\x03")}>^C</Button>}
      </form>
    </>
  )
}
