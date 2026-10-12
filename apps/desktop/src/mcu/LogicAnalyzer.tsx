// The logic analyser (bottom panel): every wired board pin as a digital trace over the last
// window of simulated time, with frequency / duty per channel, a time cursor, and VCD export.
import { useEffect, useRef, useState } from "react"
import { Download, Pause, Play } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { formatSI } from "@/lib/units"
import { cn } from "@/lib/utils"
import type { LogicBuffer } from "./logic"

const WINDOWS = [0.0001, 0.001, 0.01, 0.1, 1, 5]
const ROW = 26, LABEL = 64, STATS = 150
const COLORS = ["#22c55e", "#3b82f6", "#f59e0b", "#ef4444", "#a855f7", "#06b6d4", "#ec4899", "#84cc16"]

export function LogicAnalyzer({ buffer, running, dark, name }: { buffer: LogicBuffer; running: boolean; dark: boolean; name: string }) {
  const [win, setWin] = useState(0.01)
  const [held, setHeld] = useState<number | null>(null) // frozen end time
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [cursor, setCursor] = useState<number | null>(null)
  const [, tick] = useState(0)
  const canvas = useRef<HTMLCanvasElement>(null)
  const box = useRef<HTMLDivElement>(null)
  // redraw as the capture grows (~20 fps)
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 50); return () => clearInterval(t) }, [])
  const pins = buffer.pins.filter((p) => !hidden.has(p))
  const end = held ?? buffer.now
  const t0 = Math.max(0, end - win)

  useEffect(() => {
    const c = canvas.current, b = box.current
    if (!c || !b) return
    const w = b.clientWidth, h = Math.max(ROW, pins.length * ROW)
    const dpr = window.devicePixelRatio || 1
    c.width = w * dpr; c.height = h * dpr; c.style.width = `${w}px`; c.style.height = `${h}px`
    const g = c.getContext("2d")!
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, w, h)
    const plotW = w - LABEL - STATS
    const X = (t: number) => LABEL + ((t - t0) / win) * plotW
    // grid
    g.strokeStyle = dark ? "#ffffff14" : "#0000000f"
    for (let i = 0; i <= 10; i++) { const x = LABEL + (i / 10) * plotW; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke() }
    pins.forEach((pin, row) => {
      const y0 = row * ROW + 5, y1 = row * ROW + ROW - 5
      g.fillStyle = dark ? "#a1a1aa" : "#52525b"
      g.font = "11px 'Geist Mono Variable', monospace"
      g.fillText(pin, 8, row * ROW + ROW / 2 + 4)
      const color = COLORS[row % COLORS.length]
      g.strokeStyle = color; g.lineWidth = 1.5
      const ch = buffer.channels.get(pin) ?? []
      let level = buffer.levelAt(pin, t0)
      let x = LABEL
      const yOf = (l: number) => (l === 1 ? y0 : l === 0 ? y1 : (y0 + y1) / 2)
      g.beginPath(); g.moveTo(x, yOf(level))
      // edges closer than a pixel are drawn as a filled band
      for (const e of ch) {
        if (e.t <= t0) continue
        if (e.t > end) break
        const ex = X(e.t)
        g.lineTo(ex, yOf(level)); g.lineTo(ex, yOf(e.l))
        level = e.l; x = ex
      }
      g.lineTo(LABEL + plotW, yOf(level)); g.stroke()
      // stats
      const m = buffer.measure(pin, t0, end)
      g.fillStyle = dark ? "#d4d4d8" : "#27272a"
      g.fillText(m.freq ? `${formatSI(m.freq, "Hz", 3)}` : level === 1 ? "HIGH" : level === 0 ? "LOW" : "—", LABEL + plotW + 10, row * ROW + ROW / 2 - 1)
      g.fillStyle = dark ? "#a1a1aa" : "#71717a"
      if (m.duty !== null && m.freq) g.fillText(`${(m.duty * 100).toFixed(1)} % high`, LABEL + plotW + 10, row * ROW + ROW / 2 + 11)
    })
    if (cursor !== null && cursor >= t0 && cursor <= end) {
      g.strokeStyle = dark ? "#fafafa" : "#18181b"; g.lineWidth = 1; g.setLineDash([3, 3])
      g.beginPath(); g.moveTo(X(cursor), 0); g.lineTo(X(cursor), h); g.stroke(); g.setLineDash([])
    }
  })

  const exportVcd = () => {
    const a = document.createElement("a")
    a.href = URL.createObjectURL(new Blob([buffer.toVCD(buffer.pins, name)], { type: "text/plain" }))
    a.download = `${name.replace(/\W+/g, "_") || "capture"}.vcd`
    a.click()
  }
  const onMove = (e: React.MouseEvent) => {
    const b = box.current!.getBoundingClientRect()
    const plotW = b.width - LABEL - STATS
    const x = e.clientX - b.left - LABEL
    setCursor(x >= 0 && x <= plotW ? t0 + (x / plotW) * win : null)
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-2 py-1 text-xs">
        <span className="text-muted-foreground">Window</span>
        <Select value={String(win)} onValueChange={(v) => setWin(Number(v))}>
          <SelectTrigger size="sm" className="h-6 w-24 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>{WINDOWS.map((w) => <SelectItem key={w} value={String(w)}>{formatSI(w, "s", 3)}</SelectItem>)}</SelectContent>
        </Select>
        <Button variant="ghost" size="sm" className="h-6" disabled={!running && held === null} onClick={() => setHeld(held === null ? buffer.now : null)}>{held === null ? <><Pause /> Hold</> : <><Play /> Live</>}</Button>
        {cursor !== null && <span className="font-mono tabular-nums">t = {formatSI(cursor, "s", 6)}{pins.length ? " · " + pins.map((p) => `${p}=${["0", "1", "z"][buffer.levelAt(p, cursor)]}`).join(" ") : ""}</span>}
        <div className="flex-1" />
        <div className="flex max-w-[45%] flex-wrap gap-1">
          {buffer.pins.map((p, i) => (
            <button key={p} onClick={() => setHidden((h) => { const n = new Set(h); if (n.has(p)) n.delete(p); else n.add(p); return n })}
              className={cn("rounded border px-1.5 font-mono text-[10px]", hidden.has(p) && "opacity-40")} style={{ borderColor: COLORS[i % COLORS.length] }}>{p}</button>
          ))}
        </div>
        <Button variant="ghost" size="sm" className="h-6" disabled={!buffer.pins.length} onClick={exportVcd} title="Value Change Dump — opens in GTKWave, PulseView"><Download /> VCD</Button>
      </div>
      <div ref={box} className="min-h-0 flex-1 overflow-auto" onMouseMove={onMove} onMouseLeave={() => setCursor(null)}>
        {buffer.pins.length ? <canvas ref={canvas} /> : <p className="px-3 py-2 text-xs text-muted-foreground">{running ? "No board pins are wired yet." : "Run the sketch: every wired board pin shows here as a trace."}</p>}
      </div>
    </div>
  )
}
