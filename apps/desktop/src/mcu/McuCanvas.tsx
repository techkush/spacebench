// The microcontroller canvas: boards and parts are wokwi-elements web components placed on a
// pannable, zoomable grid; wires run pin to pin (drag from a pin to another). While the sketch
// runs, parts show what the simulation does — LEDs glow, displays draw, servos turn — and
// buttons, knobs and switches drive the simulation.
import { createElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import "@wokwi/elements"
import "./elements/pi-pico"
import "./elements/breadboard"
import { isBreadboard } from "./elements/breadboard"
import { Copy, FileCode2, RotateCw, Settings2, Trash2, Minus, Plus, Maximize } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { isBoardType } from "./boards"
import { splitEnd, type Connection, type Diagram, type DiagramPart } from "./diagram"
import type { PartUi } from "./circuit"
import type { Frame } from "./sim"
import { paintOled } from "./devices"
import { catalogPart, defineCatalog, type CatalogPart } from "./catalog"
import { drawingOf, type ModView } from "./catalog/look"
import { pinEdge, routeAround, tidy } from "./wire-route"

defineCatalog()
/** what a catalogue part responds to while running: a click, a press, or its own events */
function interaction(c: CatalogPart | undefined): "toggle" | "press" | "events" | "touch" | null {
  if (!c) return null
  const m = c.model
  if (m.m === "proto" && m.kind.endsWith("-touch")) return "touch" // a touch screen: press / drag on it
  if (m.m === "digital") return "toggle"
  if (m.m === "button") return m.latch ? "toggle" : "press"
  if (m.m === "proto" && (m.kind === "rfid125" || m.kind === "dualbutton")) return m.kind === "rfid125" ? "toggle" : "press"
  if (m.m === "proto" && ["encoder", "keypad", "irremote", "dialer"].includes(m.kind)) return "events"
  if (m.m === "proto" && m.kind === "as3935") return "toggle" // a click is a lightning strike
  if (m.m === "proto" && ["speech-recognizer", "offline-voice", "df2301q"].includes(m.kind)) return "toggle" // a click says the selected command
  return null
}
/** where a pointer is on a catalogue part's screen: 0..1 across (tx) and down (ty), or null off the screen */
function touchPoint(e: React.PointerEvent, p: DiagramPart): { tx: number; ty: number } | null {
  const c = catalogPart(p.type)
  if (!c || !p.type.startsWith("sb-")) return null
  const d = drawingOf(c), r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const rot = (((p.rotate ?? 0) % 360) + 360) % 360, side = rot === 90 || rot === 270
  const w = side ? r.height : r.width, h = side ? r.width : r.height
  const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2), a = (-rot * Math.PI) / 180
  const x = ((dx * Math.cos(a) - dy * Math.sin(a)) / w + 0.5) * d.w, y = ((dx * Math.sin(a) + dy * Math.cos(a)) / h + 0.5) * d.h
  const tx = (x - d.live.x) / d.live.w, ty = (y - d.live.y) / d.live.h
  return tx >= 0 && tx <= 1 && ty >= 0 && ty <= 1 ? { tx, ty } : null
}
const isInteractive = (type: string) => INTERACTIVE.has(type) || !!interaction(catalogPart(type))

interface ElementPin { name: string; x: number; y: number; description?: string }
interface Measure { pins: ElementPin[]; w: number; h: number }
type El = HTMLElement & Record<string, unknown>

/** drag-and-drop data type for parts from the palette */
export const PART_DRAG = "application/x-spacebench-part"

export const WIRE_COLORS = ["green", "red", "black", "blue", "orange", "yellow", "purple", "gray", "white", "brown", "cyan", "magenta"]
const CSS: Record<string, string> = { green: "#22c55e", red: "#ef4444", black: "#404040", blue: "#3b82f6", orange: "#f97316", yellow: "#eab308", purple: "#a855f7", gray: "#9ca3af", white: "#e5e7eb", brown: "#a16207", cyan: "#06b6d4", magenta: "#d946ef", lime: "#84cc16", violet: "#8b5cf6", gold: "#ca8a04" }
export const wireCss = (c: string) => CSS[c] ?? (c || CSS.green)

/** Colour for a new wire from its pins: ground black, supplies red, else green. */
export function autoColor(a: string, b: string): string {
  const pin = (e: string) => splitEnd(e)[1].toUpperCase()
  const pins = [pin(a), pin(b)]
  if (pins.some((p) => /^(GND|VSS|K|COM)\b/.test(p) || p.startsWith("GND"))) return "black"
  if (pins.some((p) => /^(5V|VCC|VDD|3\.3V|3V3|VIN|V\+)/.test(p))) return "red"
  return "green"
}

const INTERACTIVE = new Set(["wokwi-pushbutton", "wokwi-pushbutton-6mm", "wokwi-potentiometer", "wokwi-slide-potentiometer", "wokwi-slide-switch", "wokwi-analog-joystick", "wokwi-dip-switch-8", "wokwi-pir-motion-sensor", "wokwi-tilt-switch", "wokwi-ky-040"])

/** A part's box on the canvas, rotation included (it turns about its centre). */
function bounds(p: DiagramPart, m?: Measure) {
  const w = m?.w ?? 60, h = m?.h ?? 60
  const side = (p.rotate ?? 0) % 180 !== 0
  return side ? { x: p.left + (w - h) / 2, y: p.top + (h - w) / 2, w: h, h: w } : { x: p.left, y: p.top, w, h }
}

function rotatePt(x: number, y: number, w: number, h: number, deg: number) {
  if (!deg) return { x, y }
  const r = (deg * Math.PI) / 180, cx = w / 2, cy = h / 2
  const dx = x - cx, dy = y - cy
  return { x: cx + dx * Math.cos(r) - dy * Math.sin(r), y: cy + dx * Math.sin(r) + dy * Math.cos(r) }
}

/** Wokwi route hints: "h10", "v-5", "*" (the rest is from the other end). */
function routePoints(a: { x: number; y: number }, b: { x: number; y: number }, hints: string[]): { x: number; y: number }[] {
  const star = hints.indexOf("*")
  const head = star < 0 ? hints : hints.slice(0, star), tail = star < 0 ? [] : hints.slice(star + 1)
  const walk = (start: { x: number; y: number }, list: string[]) => {
    const pts = [start]
    let p = start
    for (const h of list) {
      const m = /^([hv])(-?[\d.]+)$/.exec(h)
      if (!m) continue
      p = m[1] === "h" ? { x: p.x + Number(m[2]), y: p.y } : { x: p.x, y: p.y + Number(m[2]) }
      pts.push(p)
    }
    return pts
  }
  const s = walk(a, head), e = walk(b, [...tail].reverse().map((h) => h.replace(/^([hv])(-?)/, (_m, d, neg) => `${d}${neg ? "" : "-"}`)))
  const p = s[s.length - 1], q = e[e.length - 1]
  // join with an L: along the axis of the last hint's direction
  const lastV = head.length && head[head.length - 1].startsWith("v")
  const mid = lastV ? { x: q.x, y: p.y } : { x: p.x, y: q.y }
  const join = Math.abs(p.x - q.x) < 0.5 || Math.abs(p.y - q.y) < 0.5 ? [] : [mid]
  return [...s, ...join, ...e.reverse()]
}

export interface CanvasApi { fit(): void; center(): { x: number; y: number }; freeSpot(): { x: number; y: number } }

export function McuCanvas({ diagram, onChange, frame, running, onUi, selected, onSelect, onSettings, onRestart, apiRef, dark, badge, voltsAt, thumb, onDropPart, corner, onSeated, onCode }: {
  diagram: Diagram
  /** commit = one undo step (false while dragging) */
  onChange: (d: Diagram, commit: boolean) => void
  frame: Frame | null
  running: boolean
  onUi: (id: string, u: PartUi) => void
  selected: string | null
  onSelect: (id: string | null) => void
  onSettings: (id: string) => void
  /** show a board's code in the editor */
  onCode?: (boardId: string) => void
  onRestart: () => void
  apiRef?: React.MutableRefObject<CanvasApi | null>
  dark: boolean
  badge?: React.ReactNode
  /** live voltage at a pin while running */
  voltsAt?: (end: string) => number | null
  /** a static preview: no controls, no pins */
  thumb?: boolean
  /** a part dragged in from the palette, dropped at a canvas point */
  onDropPart?: (type: string, x: number, y: number) => void
  /** extra controls in the top-right corner */
  corner?: React.ReactNode
  /** the connections breadboard seating makes (pins sitting on holes) */
  onSeated?: (conns: Connection[]) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const els = useRef(new Map<string, El>())
  const [measure, setMeasure] = useState<Record<string, Measure>>({})
  const [view, setView] = useState({ x: 80, y: 80, z: 1 })
  const [wiring, setWiring] = useState<{ from: string; x: number; y: number } | null>(null)
  const [hoverPin, setHoverPin] = useState<string | null>(null)
  const [wireSel, setWireSel] = useState<number | null>(null)
  /** where the selected wire was clicked (world units): its toolbar opens there */
  const [wireAt, setWireAt] = useState<{ x: number; y: number } | null>(null)
  const drag = useRef<{ id: string; sx: number; sy: number; left: number; top: number; moved: boolean; carry: { id: string; left: number; top: number }[] } | null>(null)
  const pan = useRef<{ sx: number; sy: number; x: number; y: number } | null>(null)
  const active = useRef(new Map<string, boolean>())
  /** the touch screen being pressed (its part id) */
  const touching = useRef<string | null>(null)

  // ── measuring pins ─────────────────────────────────────────────────────────────────────
  const measureAll = useCallback(() => {
    const m: Record<string, Measure> = {}
    for (const p of diagram.parts) {
      const el = els.current.get(p.id)
      if (!el) continue
      const pins = (el.pinInfo as ElementPin[] | undefined) ?? []
      // the element is display:block in its wrapper (inline elements report a line's height)
      const box = el.parentElement ?? el
      m[p.id] = { pins, w: box.offsetWidth, h: box.offsetHeight }
    }
    setMeasure((old) => (JSON.stringify(old) === JSON.stringify(m) ? old : m))
  }, [diagram.parts])
  useLayoutEffect(() => {
    // Lit renders asynchronously: measure after it has
    const t = [requestAnimationFrame(measureAll), setTimeout(measureAll, 60), setTimeout(measureAll, 300)]
    return () => { cancelAnimationFrame(t[0] as number); clearTimeout(t[1]); clearTimeout(t[2]) }
  }, [measureAll, diagram])

  const pinPos = useCallback((end: string): { x: number; y: number } | null => {
    const [id, pin] = splitEnd(end)
    const p = diagram.parts.find((x) => x.id === id)
    const m = measure[id]
    if (!p || !m) return null
    const ep = m.pins.find((x) => x.name === pin)
    if (!ep) return null
    const r = rotatePt(ep.x, ep.y, m.w, m.h, p.rotate ?? 0)
    return { x: p.left + r.x, y: p.top + r.y }
  }, [diagram.parts, measure])

  // ── breadboard seating: a part pin on a hole is connected to it ──────────────────────────
  const seated = useMemo(() => {
    const out: Connection[] = []
    const boards = diagram.parts.filter((p) => isBreadboard(p.type) && measure[p.id])
    if (!boards.length) return out
    const holes: { end: string; x: number; y: number }[] = []
    for (const b of boards) for (const pin of measure[b.id].pins) { const pt = pinPos(`${b.id}:${pin.name}`); if (pt) holes.push({ end: `${b.id}:${pin.name}`, ...pt }) }
    for (const p of diagram.parts) {
      if (isBreadboard(p.type) || !measure[p.id]) continue
      for (const pin of measure[p.id].pins) {
        const end = `${p.id}:${pin.name}`, pt = pinPos(end)
        if (!pt) continue
        const h = holes.find((x) => Math.abs(x.x - pt.x) < 3.5 && Math.abs(x.y - pt.y) < 3.5)
        if (h) out.push([end, h.end, "", []])
      }
    }
    return out
  }, [diagram.parts, measure, pinPos])
  const seatedKey = JSON.stringify(seated)
  useEffect(() => { onSeated?.(seated) }, [seatedKey]) // eslint-disable-line react-hooks/exhaustive-deps
  /** The shift that puts a part's nearest pin exactly on a breadboard hole (within 7 px). */
  const snapToHoles = (id: string): { x: number; y: number } | null => {
    const m = measure[id]
    if (!m) return null
    let best: { x: number; y: number; d: number } | null = null
    for (const b of diagram.parts.filter((x) => isBreadboard(x.type) && measure[x.id])) {
      for (const hole of measure[b.id].pins) {
        const hp = pinPos(`${b.id}:${hole.name}`)
        if (!hp) continue
        for (const pin of m.pins) {
          const pp = pinPos(`${id}:${pin.name}`)
          if (!pp) continue
          const d = Math.hypot(hp.x - pp.x, hp.y - pp.y)
          if (d < 7 && (!best || d < best.d)) best = { x: hp.x - pp.x, y: hp.y - pp.y, d }
        }
      }
    }
    return best && best.d > 0.01 ? { x: best.x, y: best.y } : null
  }

  // ── attributes → element properties ─────────────────────────────────────────────────────
  useEffect(() => {
    for (const p of diagram.parts) {
      const el = els.current.get(p.id)
      if (!el) continue
      for (const [k, v] of Object.entries(p.attrs)) {
        if (k === "pins" || k === "color" || k === "common" || k === "label" || k === "lightColor") { if (el[k] !== v) el[k] = v }
        else if (k === "digits" || k === "value" || k === "travelLength" || k === "pixels" || k === "min" || k === "max") { const n = Number(v); if (!Number.isNaN(n) && el[k] !== n) el[k] = n }
        else if (k === "flip") el.flip = v === "1" || v === "true"
      }
      if (p.type.startsWith("sb-") && "attrs" in el) el.attrs = p.attrs
    }
  }, [diagram.parts])

  // ── simulation frame → element state ───────────────────────────────────────────────────
  const oledVer = useRef(new Map<string, number>())
  /** screens' last pixels, and the version drawn into a Wokwi element's own canvas */
  const images = useRef(new Map<string, NonNullable<ModView["image"]>>())
  const drawnVer = useRef(new Map<string, number>())
  useEffect(() => {
    for (const p of diagram.parts) {
      const el = els.current.get(p.id)
      if (!el) continue
      const cat = catalogPart(p.type)
      const t = cat?.base ?? p.type
      if (cat && !cat.base && !isBoardType(p.type)) {
        // catalogue parts: their view, plus LED brightness from the solver
        const m: ModView | undefined = frame ? { ...frame.mods?.get(p.id), ...(frame.leds.get(p.id)?.length ? { glow: frame.leds.get(p.id) } : {}) } : undefined
        // a screen's pixels come only when they change: keep the last ones
        if (m?.image) {
          const im = m.image, kept = images.current.get(p.id)
          if (im.data) images.current.set(p.id, im)
          else if (kept?.ver === im.ver) m.image = kept
          // Wokwi's own screens (ILI9341) draw into their canvas
          const cv = (el as { canvas?: HTMLCanvasElement }).canvas
          const shown = m.image
          if (cv && shown.data && drawnVer.current.get(p.id) !== shown.ver) {
            drawnVer.current.set(p.id, shown.ver)
            cv.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(shown.data), shown.w, shown.h), 0, 0)
          }
        }
        if (p.type.startsWith("sb-")) { el.state = m; continue }
        if (t === "wokwi-stepper-motor" && m?.angle !== undefined) el.angle = m.angle
        else if (t === "wokwi-biaxial-stepper" && m?.angle !== undefined) { el.outerHandAngle = m.angle; el.innerHandAngle = (m.rows?.[0] ?? 0) / 100 }
        continue
      }
      if (isBoardType(p.type)) {
        // several boards: each lights its own LED (a board that isn't running stays dark)
        const own = frame?.boards ? frame.boards[p.id] : frame ? { led: frame.boardLed, tx: frame.tx } : undefined
        const on = !!own && own.led > 0.05, live = running && (!frame?.boards || !!own)
        if (t === "wokwi-pi-pico") el.led = on; else if (!t.startsWith("wokwi-")) { /* drawn by the catalogue: no LED props */ } else if (t === "wokwi-esp32-devkit-v1") { el.led1 = on; el.ledPower = live } else { el.led13 = on; el.ledTX = !!own?.tx; el.ledPower = live }
        continue
      }
      if (!frame) {
        if (t === "wokwi-led") el.value = false
        else if (t === "wokwi-rgb-led") { el.ledRed = 0; el.ledGreen = 0; el.ledBlue = 0 }
        else if (t === "wokwi-7segment" || t === "wokwi-led-bar-graph") el.values = []
        else if (t === "wokwi-buzzer") el.hasSignal = false
        continue
      }
      const b = frame.leds.get(p.id) ?? []
      switch (t) {
        case "wokwi-led": el.value = (b[0] ?? 0) > 0.03; el.brightness = Math.max(0.15, b[0] ?? 0); break
        case "wokwi-rgb-led": el.ledRed = b[0] ?? 0; el.ledGreen = b[1] ?? 0; el.ledBlue = b[2] ?? 0; break
        case "wokwi-led-bar-graph": el.values = Array.from({ length: 10 }, (_, i) => ((b[i] ?? 0) > 0.05 ? b[i] : 0)); break
        case "wokwi-7segment": el.values = Array.from({ length: 8 * (Number(p.attrs.digits ?? 1) || 1) }, (_, i) => ((b[i] ?? 0) > 0.05 ? 1 : 0)); break
        case "wokwi-servo": { const a = frame.servo.get(p.id); if (a !== undefined) el.angle = a; break }
        case "wokwi-buzzer": el.hasSignal = (frame.buzzer.get(p.id) ?? 0) > 0; break
        case "wokwi-lcd1602": case "wokwi-lcd2004": {
          const l = frame.lcd.get(p.id)
          if (l) { el.characters = l.chars; el.cursor = l.cursor; el.blink = l.blink; el.cursorX = l.x; el.cursorY = l.y; el.backlight = l.backlight }
          const bl = frame.mods?.get(p.id)?.backlight
          if (bl) el.background = `#${bl.map((x) => x.toString(16).padStart(2, "0")).join("")}`
          break
        }
        case "wokwi-ssd1306": {
          const o = frame.oled.get(p.id)
          if (o && oledVer.current.get(p.id) !== o.version && el.imageData) { oledVer.current.set(p.id, o.version); paintOled(o, el.imageData as ImageData); (el.redraw as () => void)() }
          break
        }
        case "wokwi-neopixel": { const c = frame.neopixel.get(p.id)?.[0]; if (c) { el.r = c[0] / 255; el.g = c[1] / 255; el.b = c[2] / 255 } break }
        case "wokwi-led-ring": case "wokwi-neopixel-matrix": {
          const px = frame.neopixel.get(p.id) ?? []
          const cols = Number(p.attrs.cols ?? 8)
          px.forEach((c, i) => { const rgb = { r: c[0] / 255, g: c[1] / 255, b: c[2] / 255 }; if (t === "wokwi-led-ring") (el.setPixel as (i: number, c: object) => void)?.(i, rgb); else (el.setPixel as (r: number, c: number, v: object) => void)?.(Math.floor(i / cols), i % cols, rgb) })
          break
        }
      }
    }
  }, [frame, running, diagram.parts])

  // ── interactive parts → simulation ─────────────────────────────────────────────────────
  const onUiRef = useRef(onUi)
  onUiRef.current = onUi
  const bind = useCallback((p: DiagramPart, el: El | null) => {
    if (!el) { els.current.delete(p.id); return }
    if (els.current.get(p.id) === el) return
    els.current.set(p.id, el)
    const send = (u: PartUi) => onUiRef.current(p.id, u)
    const t = p.type
    if (t === "wokwi-pushbutton" || t === "wokwi-pushbutton-6mm" || t === "wokwi-ky-040") {
      el.addEventListener("button-press", () => send({ pressed: true }))
      el.addEventListener("button-release", () => send({ pressed: false }))
    } else if (t === "wokwi-potentiometer" || t === "wokwi-slide-potentiometer" || t === "wokwi-slide-switch") {
      el.addEventListener("input", () => send({ value: Number(el.value) }))
    } else if (t === "wokwi-analog-joystick") {
      el.addEventListener("input", () => send({ x: Number(el.xValue), y: Number(el.yValue) }))
      el.addEventListener("button-press", () => send({ pressed: true }))
      el.addEventListener("button-release", () => send({ pressed: false }))
    } else if (t === "wokwi-dip-switch-8") {
      el.addEventListener("switch-change", () => send({ values: Array.from(el.values as number[]) }))
    } else if (isBoardType(t)) {
      el.addEventListener("button-press", () => onRestartRef.current())
    }
    const c = catalogPart(t)
    if (c?.model.m === "proto") {
      const v: Record<string, number> = {}
      if (c.model.kind === "encoder" && t === "wokwi-ky-040") {
        let pos = 0
        el.addEventListener("rotate-cw", () => send({ v: { pos: ++pos } }))
        el.addEventListener("rotate-ccw", () => send({ v: { pos: --pos } }))
      } else if (c.model.kind === "keypad") {
        const key = (e: Event) => { const d = (e as CustomEvent).detail as { row: number; column: number }; return `k${d.row}${d.column}` }
        el.addEventListener("button-press", (e) => { v[key(e)] = 1; send({ v: { ...v } }) })
        el.addEventListener("button-release", (e) => { v[key(e)] = 0; send({ v: { ...v } }) })
      } else if (c.model.kind === "irremote") {
        el.addEventListener("button-press", (e) => send({ pressed: true, v: { code: (e as CustomEvent).detail.irCode } }))
        el.addEventListener("button-release", () => send({ pressed: false }))
      } else if (c.model.kind === "dialer") {
        el.addEventListener("dial", (e) => send({ active: true, v: { digit: (e as CustomEvent).detail.digit } }))
      }
    }
  }, [])
  const onRestartRef = useRef(onRestart)
  onRestartRef.current = onRestart

  // ── pointer handling ───────────────────────────────────────────────────────────────────
  const toWorld = (cx: number, cy: number) => {
    const r = host.current!.getBoundingClientRect()
    return { x: (cx - r.left - view.x) / view.z, y: (cy - r.top - view.y) / view.z }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (drag.current) {
      const d = drag.current
      const dx = (e.clientX - d.sx) / view.z, dy = (e.clientY - d.sy) / view.z
      if (!d.moved && Math.hypot(dx, dy) < 3) return
      d.moved = true
      const snap = (v: number) => Math.round(v / 2.5) * 2.5
      const mx = snap(d.left + dx) - d.left, my = snap(d.top + dy) - d.top
      onChange({ ...diagram, parts: diagram.parts.map((p) => {
        if (p.id === d.id) return { ...p, left: d.left + mx, top: d.top + my }
        const c = d.carry.find((x) => x.id === p.id) // parts plugged into a breadboard move with it
        return c ? { ...p, left: c.left + mx, top: c.top + my } : p
      }) }, false)
    } else if (pan.current) {
      const p = pan.current
      setView((v) => ({ ...v, x: p.x + e.clientX - p.sx, y: p.y + e.clientY - p.sy }))
    } else if (wiring) {
      const w = toWorld(e.clientX, e.clientY)
      setWiring({ ...wiring, x: w.x, y: w.y })
    }
  }
  const onPointerUp = () => {
    if (drag.current?.moved) {
      // dropped near breadboard holes: snap so the pins sit in them
      const id = drag.current.id
      const part = diagram.parts.find((x) => x.id === id)
      const off = part && !isBreadboard(part.type) ? snapToHoles(id) : null
      onChange(off ? { ...diagram, parts: diagram.parts.map((x) => (x.id === id ? { ...x, left: x.left + off.x, top: x.top + off.y } : x)) } : diagram, true)
    }
    drag.current = null
    pan.current = null
  }
  const startPart = (e: React.PointerEvent, p: DiagramPart) => {
    if (e.button !== 0) return
    onSelect(p.id); setWireSel(null)
    if (running && isInteractive(p.type)) return // pressing a button, turning a knob
    if (running && isBoardType(p.type)) return
    e.stopPropagation()
    const carry = isBreadboard(p.type) ? [...new Set(seated.filter(([, b]) => splitEnd(b)[0] === p.id).map(([a]) => splitEnd(a)[0]))].map((cid) => { const q = diagram.parts.find((x) => x.id === cid)!; return { id: cid, left: q.left, top: q.top } }) : []
    drag.current = { id: p.id, sx: e.clientX, sy: e.clientY, left: p.left, top: p.top, moved: false, carry }
  }
  const clickPin = (e: React.PointerEvent, end: string) => {
    e.stopPropagation()
    if (!wiring) { const pt = pinPos(end)!; setWiring({ from: end, x: pt.x, y: pt.y }); return }
    if (wiring.from !== end) {
      const exists = diagram.connections.some(([a, b]) => (a === wiring.from && b === end) || (a === end && b === wiring.from))
      if (!exists) onChange({ ...diagram, connections: [...diagram.connections, [wiring.from, end, autoColor(wiring.from, end), []] as Connection] }, true)
    }
    setWiring(null)
  }
  const onBgDown = (e: React.PointerEvent) => {
    if (wiring) { setWiring(null); return }
    onSelect(null); setWireSel(null)
    pan.current = { sx: e.clientX, sy: e.clientY, x: view.x, y: view.y }
  }
  const onWheel = (e: React.WheelEvent) => {
    const r = host.current!.getBoundingClientRect()
    if (e.ctrlKey || e.metaKey) {
      const z = Math.min(4, Math.max(0.2, view.z * Math.exp(-e.deltaY * 0.01)))
      const mx = e.clientX - r.left, my = e.clientY - r.top
      setView({ z, x: mx - ((mx - view.x) * z) / view.z, y: my - ((my - view.y) * z) / view.z })
    } else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }))
  }
  const zoomBy = (k: number) => {
    const r = host.current!.getBoundingClientRect()
    const z = Math.min(4, Math.max(0.2, view.z * k)), mx = r.width / 2, my = r.height / 2
    setView({ z, x: mx - ((mx - view.x) * z) / view.z, y: my - ((my - view.y) * z) / view.z })
  }
  const fit = useCallback(() => {
    const r = host.current?.getBoundingClientRect()
    if (!r || !diagram.parts.length) return
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const p of diagram.parts) { const b = bounds(p, measure[p.id]); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h) }
    const pad = thumb ? 16 : 120
    const z = Math.min(thumb ? 1.2 : 1.5, Math.max(0.1, Math.min((r.width - pad) / (x1 - x0 || 1), (r.height - (thumb ? 16 : 140)) / (y1 - y0 || 1))))
    setView({ z, x: (r.width - (x1 - x0) * z) / 2 - x0 * z, y: (r.height - (y1 - y0) * z) / 2 - y0 * z })
  }, [diagram.parts, measure, thumb])
  useEffect(() => {
    const center = () => { const r = host.current!.getBoundingClientRect(); return { x: (r.width / 2 - view.x) / view.z, y: (r.height / 2 - view.y) / view.z } }
    // the free spot nearest the middle of the view for a ~100 px part (rings outward)
    const freeSpot = () => {
      const c = center(), S = 100, gap = 16
      const boxes = diagram.parts.map((p) => { const b = bounds(p, measure[p.id]); return { x: b.x - gap, y: b.y - gap, w: b.w + 2 * gap, h: b.h + 2 * gap } })
      const free = (x: number, y: number) => boxes.every((b) => x + S < b.x || x > b.x + b.w || y + S < b.y || y > b.y + b.h)
      for (let ring = 0; ring < 30; ring++) for (let k = 0; k < Math.max(1, ring * 8); k++) {
        const a = (k / Math.max(1, ring * 8)) * Math.PI * 2 - Math.PI / 2
        const x = c.x - S / 2 + Math.cos(a) * ring * 40, y = c.y - S / 2 + Math.sin(a) * ring * 40
        if (free(x, y)) return { x: Math.round(x / 5) * 5, y: Math.round(y / 5) * 5 }
      }
      return { x: c.x, y: c.y }
    }
    if (apiRef) apiRef.current = { fit, center, freeSpot }
  }, [apiRef, fit, view, diagram.parts, measure])
  // fit while the elements first render (Lit lays them out a moment after mounting)
  const mounted = useRef(Date.now())
  useEffect(() => { if (Date.now() - mounted.current < 1500 && Object.keys(measure).length >= diagram.parts.length) fit() }, [measure, fit, diagram.parts.length])

  // keyboard: delete / rotate / escape
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.closest("input, textarea, .monaco-editor, [contenteditable]")) return
      if (e.key === "Escape") { setWiring(null); setWireSel(null) }
      if ((e.key === "Delete" || e.key === "Backspace") && wireSel !== null) { onChange({ ...diagram, connections: diagram.connections.filter((_, i) => i !== wireSel) }, true); setWireSel(null); e.preventDefault() }
      else if ((e.key === "Delete" || e.key === "Backspace") && selected) { remove(selected); e.preventDefault() }
      else if (e.key.toLowerCase() === "r" && selected && !e.metaKey && !e.ctrlKey) rotate(selected)
    }
    window.addEventListener("keydown", k)
    return () => window.removeEventListener("keydown", k)
  })

  const remove = (id: string) => {
    onChange({ ...diagram, parts: diagram.parts.filter((p) => p.id !== id), connections: diagram.connections.filter(([a, b]) => splitEnd(a)[0] !== id && splitEnd(b)[0] !== id) }, true)
    onSelect(null)
  }
  const rotate = (id: string) => onChange({ ...diagram, parts: diagram.parts.map((p) => (p.id === id ? { ...p, rotate: ((p.rotate ?? 0) + 90) % 360 } : p)) }, true)
  const duplicate = (id: string) => {
    const p = diagram.parts.find((x) => x.id === id)!
    const base = id.replace(/\d+$/, "")
    let n = 1
    while (diagram.parts.some((x) => x.id === `${base}${n}`)) n++
    onChange({ ...diagram, parts: [...diagram.parts, { ...p, id: `${base}${n}`, left: p.left + 30, top: p.top + 30, attrs: { ...p.attrs } }] }, true)
    onSelect(`${base}${n}`)
  }

  // ── drawing ────────────────────────────────────────────────────────────────────────────
  const wires = useMemo(() => {
    // wires leaving a board header: out of the header first (up or down), each a little
    // further than the last on that side so they don't run on top of each other
    const lanes = new Map<string, number>()
    return diagram.connections.map(([a, b, color, hints], i) => {
    let pa = pinPos(a), pb = pinPos(b)
    if (!pa || !pb) return null
    let pts: { x: number; y: number }[]
    const boardEnd = [a, b].find((e) => { const p = diagram.parts.find((x) => x.id === splitEnd(e)[0]); return p && isBoardType(p.type) })
    if (!hints.length && boardEnd) {
      const bp = diagram.parts.find((x) => x.id === splitEnd(boardEnd)[0])!
      const m = measure[bp.id]
      if (boardEnd === b) [pa, pb] = [pb, pa]
      const up = m ? pa.y - bp.top < m.h / 2 : true
      const side = `${bp.id}:${up ? "u" : "d"}`
      const lane = lanes.get(side) ?? 0
      lanes.set(side, lane + 1)
      const stubY = pa.y + (up ? -1 : 1) * (14 + (lane % 8) * 6)
      const beyond = up ? pb.y < stubY : pb.y > stubY
      // which edge of its part the far pin is on: wires come in from that side
      const far = boardEnd === a ? b : a
      const fp = diagram.parts.find((x) => x.id === splitEnd(far)[0])
      const fb = fp ? bounds(fp, measure[fp.id]) : null
      const edge = fb ? (() => {
        const d = { left: pb.x - fb.x, right: fb.x + fb.w - pb.x, top: pb.y - fb.y, bottom: fb.y + fb.h - pb.y }
        return (Object.entries(d) as [keyof typeof d, number][]).sort((u, v) => u[1] - v[1])[0][0]
      })() : "top"
      const off = 10 + (lane % 8) * 6
      if (edge === "left" || edge === "right") {
        // a riser beside the pin row, one lane per wire, then straight into the pin
        const rx = pb.x + (edge === "left" ? -off : off)
        pts = [pa, { x: pa.x, y: stubY }, { x: rx, y: stubY }, { x: rx, y: pb.y }, pb]
      } else if (beyond === (edge === (up ? "bottom" : "top"))) {
        pts = [pa, { x: pa.x, y: stubY }, { x: pb.x, y: stubY }, pb]
      } else {
        // the pin faces away: go round to its side
        const ry = pb.y + (edge === "top" ? -off : off)
        const rx = pb.x + (pb.x > pa.x ? -1 : 1) * off
        pts = [pa, { x: pa.x, y: stubY }, { x: rx, y: stubY }, { x: rx, y: ry }, { x: pb.x, y: ry }, pb]
      }
    } else if (!hints.length) {
      const part = (e: string) => diagram.parts.find((x) => x.id === splitEnd(e)[0])
      const pA = part(a), pB = part(b)
      if (pA && pB) {
        const ba = bounds(pA, measure[pA.id]), bb = bounds(pB, measure[pB.id])
        const ea = pinEdge(pa, ba), eb = pinEdge(pb, bb)
        const lane = (k: string) => { const n = lanes.get(k) ?? 0; lanes.set(k, n + 1); return n }
        pts = routeAround(pa, ea, ba, lane(`${pA.id}:${ea}`), pb, eb, bb, lane(`${pB.id}:${eb}`))
      } else pts = routePoints(pa, pb, hints)
    } else pts = routePoints(pa, pb, hints)
    pts = tidy(pts)
    return { i, color, d: pts.map((p, k) => `${k ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" "), a, b }
  })
  }, [diagram.connections, diagram.parts, pinPos, measure])

  const sel = diagram.parts.find((p) => p.id === selected)
  const selM = sel ? measure[sel.id] : null

  return (
    <div ref={host} className={cn("relative h-full w-full select-none overflow-hidden", dark ? "bg-[#141414]" : "bg-[#f6f6f4]", wiring && "cursor-crosshair", thumb && "pointer-events-none")}
      style={{ backgroundImage: `radial-gradient(${dark ? "#2a2a2a" : "#d4d4d0"} 1px, transparent 1px)`, backgroundSize: `${16 * view.z}px ${16 * view.z}px`, backgroundPosition: `${view.x}px ${view.y}px` }}
      onPointerDown={onBgDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={onPointerUp} onWheel={onWheel}
      onDragOver={(e) => { if (onDropPart && e.dataTransfer.types.includes(PART_DRAG)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy" } }}
      onDrop={(e) => { const t = e.dataTransfer.getData(PART_DRAG); if (!t || !onDropPart) return; e.preventDefault(); const w = toWorld(e.clientX, e.clientY); onDropPart(t, Math.round(w.x / 5) * 5, Math.round(w.y / 5) * 5) }}>
      {/* CSS zoom, not scale(): WebKit (the desktop app's web view) keeps a scaled layer at its
          100 % bitmap and stretches it, so parts went blurry; zoom lays them out and draws them
          at the zoomed size, sharp at any zoom */}
      <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${view.x}px, ${view.y}px)` }}>
      <div style={{ zoom: view.z }}>
        {[...diagram.parts.filter((p) => isBreadboard(p.type)), ...diagram.parts.filter((p) => !isBreadboard(p.type))].map((p) => (
          <div key={p.id} data-part={p.id} className={cn("absolute", selected === p.id && "outline outline-2 outline-offset-4 outline-primary/70 rounded-sm")}
            style={{ lineHeight: 0, left: p.left, top: p.top, transform: p.rotate ? `rotate(${p.rotate}deg)` : undefined, transformOrigin: "center", cursor: running && isInteractive(p.type) ? "pointer" : "move", display: p.hide ? "none" : undefined }}
            onClick={() => {
              if (!running) return
              const how = interaction(catalogPart(p.type))
              if (p.type === "wokwi-pir-motion-sensor" || p.type === "wokwi-tilt-switch" || how === "toggle") {
                const c = catalogPart(p.type), pulse = c?.model.m === "digital" && c.model.pulse || c?.model.m === "proto"
                const on = pulse ? true : !active.current.get(p.id)
                active.current.set(p.id, on); onUi(p.id, { active: on })
                if (pulse) setTimeout(() => { active.current.set(p.id, false); onUi(p.id, { active: false }) }, 50)
              }
            }}
            onPointerDown={(e) => { startPart(e, p); if (running && interaction(catalogPart(p.type)) === "press") { const half = e.nativeEvent.offsetX > (e.currentTarget as HTMLElement).offsetWidth / 2 ? "b2" : "b1"; onUi(p.id, { pressed: true, v: { [half]: 1 } }) }
              if (running && interaction(catalogPart(p.type)) === "touch") { const t = touchPoint(e, p); if (t) { touching.current = p.id; (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); onUi(p.id, { pressed: true, v: t }) } } }}
            onPointerMove={(e) => { if (touching.current === p.id) { const t = touchPoint(e, p); if (t) onUi(p.id, { pressed: true, v: t }) } }}
            onPointerUp={() => { if (touching.current === p.id) { touching.current = null; onUi(p.id, { pressed: false }) } if (running && interaction(catalogPart(p.type)) === "press") onUi(p.id, { pressed: false, v: { b1: 0, b2: 0 } }) }}
            onPointerLeave={() => { if (touching.current === p.id) { touching.current = null; onUi(p.id, { pressed: false }) } if (running && interaction(catalogPart(p.type)) === "press") onUi(p.id, { pressed: false, v: { b1: 0, b2: 0 } }) }}>
            {createElement(p.type, { ref: (el: El | null) => bind(p, el), style: { display: "flex" }, ...attrProps(p) })}
          </div>
        ))}
        <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={1} height={1}>
          {wires.map((w) => w && (
            <g key={w.i} className="pointer-events-auto cursor-pointer" onPointerDown={(e) => { e.stopPropagation(); setWireSel(w.i); setWireAt(toWorld(e.clientX, e.clientY)); onSelect(null) }}>
              <path d={w.d} fill="none" stroke="transparent" strokeWidth={8} />
              {wireSel === w.i && <path d={w.d} fill="none" stroke={dark ? "#fff" : "#000"} strokeOpacity={0.35} strokeWidth={6} strokeLinejoin="round" strokeLinecap="round" />}
              <path d={w.d} fill="none" stroke={wireCss(w.color)} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
            </g>
          ))}
          {seated.map(([, h]) => { const pt = pinPos(h); return pt ? <rect key={h} x={pt.x - 3} y={pt.y - 3} width={6} height={6} rx={1} fill="#22c55e" fillOpacity={0.55} /> : null })}
          {wiring && (() => { const a = pinPos(wiring.from); return a ? <path d={`M${a.x},${a.y} L${wiring.x},${a.y} L${wiring.x},${wiring.y}`} fill="none" stroke={wireCss("green")} strokeDasharray="4 3" strokeWidth={2} /> : null })()}
        </svg>
        {/* pins: hit targets on top of everything */}
        {!thumb && diagram.parts.map((p) => {
          const m = measure[p.id]
          if (!m || p.hide) return null
          return m.pins.map((pin) => {
            const end = `${p.id}:${pin.name}`
            const pt = pinPos(end)
            if (!pt) return null
            const used = diagram.connections.some(([a, b]) => a === end || b === end)
            const hot = hoverPin === end || wiring?.from === end
            return (
              <div key={end} title={`${p.id} · ${pin.name}${pin.description ? ` — ${pin.description}` : ""}`}
                className={cn("absolute size-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full transition-opacity", hot ? "bg-primary opacity-100 ring-2 ring-primary/40" : used ? "opacity-0" : "bg-primary/60 opacity-0 hover:opacity-100", (wiring || selected === p.id) && !used && "opacity-60")}
                style={{ left: pt.x, top: pt.y, cursor: "crosshair" }}
                onPointerEnter={() => setHoverPin(end)} onPointerLeave={() => setHoverPin(null)}
                onPointerDown={(e) => clickPin(e, end)} />
            )
          })
        })}
      </div>
      </div>

      {hoverPin && (() => {
        const pt = pinPos(hoverPin)
        if (!pt) return null
        return <div className="pointer-events-none absolute z-20 -translate-x-1/2 rounded bg-popover px-1.5 py-0.5 font-mono text-[10px] text-popover-foreground shadow ring-1 ring-border" style={{ left: view.x + pt.x * view.z, top: view.y + pt.y * view.z - 26 }}>{hoverPin.replace(":", " · ")}{running && voltsAt ? (() => { const v = voltsAt(hoverPin); return v === null ? "" : ` = ${v.toFixed(2)} V` })() : ""}</div>
      })()}

      {/* the selected part's toolbar (under it) */}
      {sel && selM && !running && (
        <div className="absolute z-10 flex items-center gap-0.5 rounded-lg border bg-popover p-0.5 shadow-md" style={{ left: view.x + (sel.left + selM.w / 2) * view.z, top: view.y + (sel.top + (sel.rotate === 90 || sel.rotate === 270 ? (selM.h + selM.w) / 2 : selM.h)) * view.z + 14, transform: "translateX(-50%)" }} onPointerDown={(e) => e.stopPropagation()}>
          {onCode && isBoardType(sel.type) && <Button variant="ghost" size="sm" title="Show this board's code" onClick={() => onCode(sel.id)}><FileCode2 /> Code</Button>}
          <Button variant="ghost" size="icon-sm" title="Rotate (R)" onClick={() => rotate(sel.id)}><RotateCw /></Button>
          <Button variant="ghost" size="icon-sm" title="Duplicate" onClick={() => duplicate(sel.id)}><Copy /></Button>
          <Button variant="ghost" size="icon-sm" title="Settings" onClick={() => onSettings(sel.id)}><Settings2 /></Button>
          <Button variant="ghost" size="icon-sm" title="Delete (⌫)" className="hover:text-destructive" onClick={() => remove(sel.id)}><Trash2 /></Button>
        </div>
      )}
      {/* the selected wire's toolbar: under the point where the wire was clicked, kept inside the canvas
          (pinned to the top it covered the canvas's own buttons) */}
      {wireSel !== null && diagram.connections[wireSel] && (() => {
        const W = 330, hostW = host.current?.clientWidth ?? 800, hostH = host.current?.clientHeight ?? 600
        const at = wireAt ?? { x: 0, y: 0 }
        const left = Math.min(Math.max(8, view.x + at.x * view.z - W / 2), Math.max(8, hostW - W - 8))
        const below = view.y + at.y * view.z + 14
        const top = below + 70 > hostH ? view.y + at.y * view.z - 84 : below
        return (
        <div className="absolute z-10 flex flex-wrap items-center gap-1 rounded-lg border bg-popover px-2 py-1 shadow-md" style={{ left, top: Math.max(8, top), width: W }} onPointerDown={(e) => e.stopPropagation()}>
          <span className="mr-1 font-mono text-[11px] text-muted-foreground">{diagram.connections[wireSel][0]} → {diagram.connections[wireSel][1]}</span>
          {WIRE_COLORS.map((c) => <button key={c} title={c} className={cn("size-4 rounded-full ring-1 ring-border", diagram.connections[wireSel][2] === c && "ring-2 ring-primary")} style={{ background: wireCss(c) }}
            onClick={() => onChange({ ...diagram, connections: diagram.connections.map((w, i) => (i === wireSel ? [w[0], w[1], c, w[3]] as Connection : w)) }, true)} />)}
          <Button variant="ghost" size="icon-sm" className="hover:text-destructive" title="Delete wire (⌫)" onClick={() => { onChange({ ...diagram, connections: diagram.connections.filter((_, i) => i !== wireSel) }, true); setWireSel(null) }}><Trash2 /></Button>
        </div>
        )
      })()}
      {/* one row: on a narrow canvas the buttons wrap under the badge instead of covering it */}
      {(badge || (corner && !thumb)) && (
        <div className="pointer-events-none absolute inset-x-3 top-3 z-10 flex flex-wrap items-start justify-between gap-1.5">
          {badge ?? <span />}
          {corner && !thumb && <div className="pointer-events-auto ml-auto flex flex-wrap items-center justify-end gap-1" onPointerDown={(e) => e.stopPropagation()}>{corner}</div>}
        </div>
      )}
      {wiring && <div className="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-md bg-popover px-2 py-1 text-xs shadow ring-1 ring-border">Click another pin to connect · Esc to cancel</div>}

      {!thumb && <div className="absolute bottom-3 right-3 z-10 flex items-center rounded-lg border bg-popover shadow-sm" onPointerDown={(e) => e.stopPropagation()}>
        <Button variant="ghost" size="icon-sm" title="Zoom out" onClick={() => zoomBy(1 / 1.2)}><Minus /></Button>
        <button className="w-12 text-center font-mono text-xs tabular-nums" title="Reset zoom" onClick={() => zoomBy(1 / view.z)}>{Math.round(view.z * 100)}%</button>
        <Button variant="ghost" size="icon-sm" title="Zoom in" onClick={() => zoomBy(1.2)}><Plus /></Button>
        <Button variant="ghost" size="icon-sm" title="Fit to window" onClick={fit}><Maximize /></Button>
      </div>}
    </div>
  )
}

/** Initial attributes as element properties (React 19 sets known properties on custom elements). */
function attrProps(p: DiagramPart): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(p.attrs)) {
    if (["color", "pins", "label", "common", "lightColor"].includes(k)) out[k] = v
    else if (["digits", "travelLength", "pixels", "value"].includes(k) && !Number.isNaN(Number(v))) out[k] = Number(v)
  }
  return out
}
