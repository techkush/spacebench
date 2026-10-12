import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Eye, Map as MapIcon, Maximize2, Minus, Plus } from "lucide-react"

import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { displayRef, isLabel, isVirtual, placedPins, symbolFor, unitOf, UNIT_PX, type Doc, type Part, type Pt } from "@/editor/model"
import { onSegment, type Netlist } from "@/editor/netlist"
import { moveSelection, route, selectInRect, type Selection } from "@/editor/ops"
import { resolveSim } from "@/lib/spice"
import { setSettings, useSettings } from "@/lib/settings"
import { formatSI } from "@/lib/units"
import { PartFields, partTransform, UnitArt } from "./SymbolView"
import { OutputGlow, OutputMarks } from "./OutputFx"
import { InputChips, type InputChipApi } from "./InputChips"
import { outputState } from "@/editor/outputs"

export type Tool =
  | { kind: "select" } | { kind: "pan" } | { kind: "wire" } | { kind: "probe" } | { kind: "noconnect" }
  | { kind: "place"; part: Omit<Part, "id" | "ref" | "x" | "y"> }

/** Signal a probe click on a part plots: I(R1), Ic(Q1), Id(M1)… */
export function partProbe(p: Part): string | null {
  const sim = resolveSim(p)
  if (!sim || "error" in sim) return null
  switch (sim.kind) {
    case "NPN": case "PNP": return `Ic(${p.ref})`
    case "NMOS": case "PMOS": case "NJFET": case "PJFET": return `Id(${p.ref})`
    case "R": case "C": case "L": case "V": case "I": case "D": return sim.type === "POT" ? null : `I(${p.ref})`
    default: return null
  }
}

export interface Overlays { flow: boolean; volt: boolean; tags: boolean }
export interface ProbeFlag { signal: string; label: string; color: string; value?: string; /** false: no × (instrument leads like the function generator) */ removable?: boolean }
export interface HoverInfo { kind: "net" | "part"; name: string; v?: number; i?: number; signal?: string }

interface Props {
  doc: Doc
  netlist: Netlist
  values: Record<string, number>
  /** simulated values are available (otherwise overlays are hidden) */
  live: boolean
  wireFlow: Map<string, number>
  overlays: Overlays
  setOverlays: (o: Overlays) => void
  probeFlags: ProbeFlag[]
  /** live controls and sensor readings under input parts */
  inputs?: InputChipApi
  /** waveform of a signal, for the hover card */
  series: (signal: string) => { x: number[]; y: number[] } | null
  selection: Selection
  setSelection: (s: Selection) => void
  tool: Tool
  ghostRot: number
  ghostMirror: boolean
  onCommit: (next: Doc) => void
  onPlace: (at: Pt) => void
  onWire: (path: Pt[]) => void
  onProbe: (signal: string) => void
  /** × on a probe flag */
  onRemoveProbe: (signal: string) => void
  onNoConnect: (at: Pt) => void
  onToolDone: () => void
  onHover: (h: HoverInfo | null) => void
  onZoom: (percent: number) => void
  fitKey: string
}

const key = (p: Pt) => `${p[0]},${p[1]}`
const ZOOM_100 = 1.4

function voltColor(v: number | undefined, vmax: number): string {
  if (v === undefined || !Number.isFinite(v)) return "var(--canvas-wire)"
  const f = Math.min(1, Math.abs(v) / Math.max(vmax, 1e-9))
  const hue = v >= 0 ? "var(--canvas-volt-high)" : "var(--canvas-volt-low)"
  return `color-mix(in oklab, ${hue} ${Math.round(25 + 75 * f)}%, var(--canvas-volt-zero))`
}

function PartGlyph({ part, color, ghost }: { part: Omit<Part, "id"> & { id?: string }; color: string; ghost?: boolean }) {
  const u = unitOf(part)
  if (!u) return null
  return (
    <g transform={partTransform(part)} style={{ color }} opacity={ghost ? 0.55 : 1}>
      <UnitArt unit={u} />
    </g>
  )
}

/** Tiny line chart for the hover card. */
function Sparkline({ x, y, color }: { x: number[]; y: number[]; color: string }) {
  const n = Math.min(x.length, 240)
  const step = Math.max(1, Math.floor(x.length / n))
  let lo = Infinity, hi = -Infinity
  for (let i = 0; i < y.length; i += step) { lo = Math.min(lo, y[i]); hi = Math.max(hi, y[i]) }
  if (!Number.isFinite(lo)) return null
  const span = hi - lo || 1
  const x0 = x[0], xs = x[x.length - 1] - x0 || 1
  const pts: string[] = []
  for (let i = 0; i < x.length; i += step) pts.push(`${(((x[i] - x0) / xs) * 220).toFixed(1)},${(44 - ((y[i] - lo) / span) * 40).toFixed(1)}`)
  return <svg viewBox="0 -2 220 50" className="h-12 w-[220px]"><polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth={1.6} /></svg>
}

export function SchematicEditor(props: Props) {
  const {
    doc, netlist, values, live, wireFlow, overlays, setOverlays, probeFlags, inputs, series, selection, setSelection, tool, ghostRot, ghostMirror,
    onCommit, onPlace, onWire, onProbe, onRemoveProbe, onNoConnect, onToolDone, onHover, onZoom, fitKey,
  } = props
  const svgRef = useRef<SVGSVGElement>(null)
  const [view, setView] = useState({ x: 0, y: 0, k: ZOOM_100 })
  const [size, setSize] = useState({ w: 800, h: 600 })
  const settings = useSettings()
  const showMini = settings.minimap
  const setShowMini = (v: boolean | ((m: boolean) => boolean)) => setSettings({ minimap: typeof v === "function" ? v(showMini) : v })
  const [cursor, setCursor] = useState<Pt>([0, 0])
  const [wireStart, setWireStart] = useState<Pt | null>(null)
  const [vfirst, setVfirst] = useState(false)
  const [drag, setDrag] = useState<null | { kind: "move"; start: Pt; base: Doc; preview: Doc } | { kind: "box"; start: Pt; now: Pt } | { kind: "pan"; sx: number; sy: number; vx: number; vy: number }>(null)
  const [hover, setHover] = useState<{ x: number; y: number; info: HoverInfo; title: string; sub: string } | null>(null)

  const shown = drag?.kind === "move" ? drag.preview : doc
  // the hovered part or wire may have just been deleted or changed
  useEffect(() => { setHover(null); onHover(null) }, [doc.parts, doc.wires]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onZoom(Math.round((view.k / ZOOM_100) * 100)) }, [view.k, onZoom])
  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ---- coordinates
  const toWorld = useCallback((e: { clientX: number; clientY: number }, snap = true): Pt => {
    const r = svgRef.current!.getBoundingClientRect()
    const x = (e.clientX - r.left - view.x) / view.k / UNIT_PX
    const y = (e.clientY - r.top - view.y) / view.k / UNIT_PX
    return snap ? [Math.round(x), Math.round(y)] : [x, y]
  }, [view])

  // ---- content bounds (grid units)
  const bounds = useMemo(() => {
    const xs: number[] = [], ys: number[] = []
    for (const w of doc.wires) for (const p of [w.a, w.b]) { xs.push(p[0]); ys.push(p[1]) }
    for (const p of doc.parts) {
      const u = unitOf(p)
      const r = u ? Math.max(Math.abs(u.box[0]), Math.abs(u.box[1]), Math.abs(u.box[0] + u.box[2]), Math.abs(u.box[1] + u.box[3])) / UNIT_PX : 5
      xs.push(p.x - r, p.x + r + 3); ys.push(p.y - r, p.y + r)
    }
    if (!xs.length) return null
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }
  }, [doc])

  const fit = useCallback(() => {
    const el = svgRef.current
    if (!el) return
    if (!bounds) { setView({ x: el.clientWidth / 2, y: el.clientHeight / 2, k: ZOOM_100 }); return }
    const [x0, x1, y0, y1] = [bounds.x0, bounds.x1, bounds.y0, bounds.y1].map((v) => v * UNIT_PX)
    const W = el.clientWidth, H = el.clientHeight
    const k = Math.min(2.4, Math.max(0.3, Math.min((W - 160) / (x1 - x0 || 1), (H - 140) / (y1 - y0 || 1))))
    setView({ k, x: W / 2 - ((x0 + x1) / 2) * k, y: H / 2 - ((y0 + y1) / 2) * k })
  }, [bounds])
  useEffect(() => { fit() }, [fitKey]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (tool.kind !== "wire") setWireStart(null) }, [tool.kind])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input,textarea,[contenteditable]")) return
      if (e.key === "/" && tool.kind === "wire") setVfirst((v) => !v)
      if (e.key === "Escape" && wireStart) { e.stopPropagation(); setWireStart(null) }
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [tool.kind, wireStart])

  const vmax = useMemo(() => Math.max(1e-6, ...Object.entries(values).filter(([k]) => k.startsWith("V(")).map(([, v]) => Math.abs(v))), [values])
  const netVolt = (net: string | undefined) => (net === undefined ? undefined : net === "0" ? 0 : values[`V(${net})`])
  const showVolt = live && overlays.volt

  // one anchor per net (midpoint of its longest wire): voltage tags and probe flags sit there
  const netAnchor = useMemo(() => {
    const best = new Map<string, { at: Pt; len: number }>()
    for (const w of shown.wires) {
      const net = netlist.wireNet.get(w.id)
      if (!net) continue
      const len = Math.abs(w.a[0] - w.b[0]) + Math.abs(w.a[1] - w.b[1]) + (w.a[1] === w.b[1] ? 0.5 : 0)
      const prev = best.get(net)
      if (!prev || len > prev.len) best.set(net, { at: [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2], len })
    }
    return new Map([...best].map(([n, v]) => [n, v.at]))
  }, [shown.wires, netlist])

  // connection points for ending a wire
  const isConnection = (p: Pt) => netlist.pointNet.has(key(p)) || doc.wires.some((w) => onSegment(p, w.a, w.b))
  const noConnects = useMemo(() => new Set((doc.noConnects ?? []).map(key)), [doc.noConnects])

  // ---- hover card
  const hoverNet = (e: React.PointerEvent, net: string | undefined) => {
    if (!net) return
    const info: HoverInfo = { kind: "net", name: net === "0" ? "GND" : net, v: netVolt(net), signal: net === "0" ? undefined : `V(${net})` }
    setHover({ x: e.clientX, y: e.clientY, info, title: `Net ${info.name}`, sub: info.v !== undefined ? `V = ${formatSI(info.v, "V", 4)}` : "not simulated yet" })
    onHover(info)
  }
  const hoverPart = (e: React.PointerEvent, p: Part) => {
    const sym = symbolFor(p)
    if (!sym || sym.power) return
    if (isLabel(p)) { hoverNet(e, netlist.pointNet.get(key(placedPins(p)[0]?.at ?? [0, 0]))); return }
    const probe = partProbe(p)
    const i = probe ? values[probe] : undefined
    const pins = placedPins(p)
    const v = pins.length === 2 ? (netVolt(netlist.pinNet.get(`${p.ref}.${pins[0].n}`)) ?? NaN) - (netVolt(netlist.pinNet.get(`${p.ref}.${pins[1].n}`)) ?? NaN) : undefined
    const info: HoverInfo = { kind: "part", name: displayRef(p), v: Number.isFinite(v) ? v : undefined, i, signal: probe ?? undefined }
    setHover({
      x: e.clientX, y: e.clientY, info, title: `${displayRef(p)} · ${p.value}`,
      sub: [info.v !== undefined ? `V = ${formatSI(info.v, "V", 3)}` : null, i !== undefined ? `${probe?.split("(")[0]} = ${formatSI(i, "A", 3)}` : null].filter(Boolean).join("  ·  ") || sym.desc || sym.name,
    })
    onHover(info)
  }
  const unhover = () => { setHover(null); onHover(null) }

  // ---- pointer handlers on the background
  const onDown = (e: React.PointerEvent) => {
    svgRef.current!.setPointerCapture(e.pointerId)
    if (e.button === 1 || (e.button === 0 && (e.altKey || tool.kind === "pan"))) {
      setDrag({ kind: "pan", sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y })
      return
    }
    const p = toWorld(e)
    if (e.button === 2) { if (tool.kind === "wire") setWireStart(null); else onToolDone(); return }
    if (tool.kind === "place") { onPlace(p); return }
    if (tool.kind === "noconnect") { onNoConnect(p); return }
    if (tool.kind === "wire") {
      if (!wireStart) { setWireStart(p); return }
      if (key(p) === key(wireStart)) return
      const ends = isConnection(p)
      onWire(route(wireStart, p, vfirst))
      setWireStart(ends ? null : p)
      return
    }
    if (tool.kind === "select") {
      if (!e.shiftKey) setSelection({ parts: new Set(), wires: new Set() })
      setDrag({ kind: "box", start: toWorld(e, false), now: toWorld(e, false) })
    }
  }

  const startMove = (e: React.PointerEvent, sel: Selection) => {
    svgRef.current!.setPointerCapture(e.pointerId)
    setDrag({ kind: "move", start: toWorld(e), base: doc, preview: doc })
    setSelection(sel)
  }

  const onPartDown = (e: React.PointerEvent, part: Part) => {
    if (tool.kind === "probe") {
      e.stopPropagation()
      if (isVirtual(part)) {
        const at = placedPins(part)[0]?.at
        const net = at && netlist.pointNet.get(key(at))
        if (net && net !== "0") onProbe(`V(${net})`)
      } else {
        const sig = partProbe(part)
        if (sig) onProbe(sig)
      }
      return
    }
    if (tool.kind !== "select" || e.button !== 0 || e.altKey) return
    e.stopPropagation()
    let sel = selection
    if (e.shiftKey) {
      const parts = new Set(selection.parts)
      if (parts.has(part.id)) parts.delete(part.id); else parts.add(part.id)
      sel = { parts, wires: selection.wires }
    } else if (!selection.parts.has(part.id)) sel = { parts: new Set([part.id]), wires: new Set() }
    startMove(e, sel)
  }

  const onWireDown = (e: React.PointerEvent, wireId: string) => {
    if (tool.kind === "probe") {
      e.stopPropagation()
      const net = netlist.wireNet.get(wireId)
      if (net && net !== "0") onProbe(`V(${net})`)
      return
    }
    if (tool.kind !== "select" || e.button !== 0 || e.altKey) return
    e.stopPropagation()
    let sel = selection
    if (e.shiftKey) {
      const wires = new Set(selection.wires)
      if (wires.has(wireId)) wires.delete(wireId); else wires.add(wireId)
      sel = { parts: selection.parts, wires }
    } else if (!selection.wires.has(wireId)) sel = { parts: new Set(), wires: new Set([wireId]) }
    startMove(e, sel)
  }

  const onMove = (e: React.PointerEvent) => {
    setCursor(toWorld(e))
    if (!drag) return
    if (drag.kind === "pan") setView((v) => ({ ...v, x: drag.vx + e.clientX - drag.sx, y: drag.vy + e.clientY - drag.sy }))
    else if (drag.kind === "box") setDrag({ ...drag, now: toWorld(e, false) })
    else if (drag.kind === "move") {
      const p = toWorld(e)
      setDrag({ ...drag, preview: moveSelection(drag.base, selection, p[0] - drag.start[0], p[1] - drag.start[1]) })
    }
  }

  const onUp = () => {
    if (drag?.kind === "move" && drag.preview !== drag.base) onCommit(drag.preview)
    if (drag?.kind === "box") {
      const [a, b] = [drag.start, drag.now]
      if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) > 0.5) {
        const inRect = selectInRect(doc, a[0], a[1], b[0], b[1])
        setSelection({ parts: new Set([...selection.parts, ...inRect.parts]), wires: new Set([...selection.wires, ...inRect.wires]) })
      }
    }
    setDrag(null)
  }

  const cursorStyle = drag?.kind === "pan" ? "grabbing" : tool.kind === "pan" ? "grab" : tool.kind === "select" ? "default" : "crosshair"

  // ---- probe flag anchors (world px)
  const flagAnchor = (signal: string): Pt | null => {
    const m = /^(V|I[a-z]*)\((.*)\)$/.exec(signal)
    if (!m) return null
    if (m[1] === "V") { const a = netAnchor.get(m[2]); return a ? [a[0] * UNIT_PX, a[1] * UNIT_PX] : null }
    const part = shown.parts.find((p) => p.ref === m[2])
    return part ? [part.x * UNIT_PX, part.y * UNIT_PX] : null
  }

  // ---- minimap
  const mini = useMemo(() => {
    if (!bounds) return null
    const pad = 4
    const b = { x0: bounds.x0 - pad, y0: bounds.y0 - pad, w: bounds.x1 - bounds.x0 + 2 * pad, h: bounds.y1 - bounds.y0 + 2 * pad }
    const W = 150, H = Math.max(60, Math.min(110, (W * b.h) / b.w))
    const s = Math.min(W / b.w, H / b.h)
    return { b, W, H, s }
  }, [bounds])

  return (
    <div className="relative h-full w-full overflow-hidden bg-canvas">
      <svg
        ref={svgRef}
        className="h-full w-full touch-none"
        style={{ cursor: cursorStyle }}
        onContextMenu={(e) => e.preventDefault()}
        onWheel={(e) => {
          const r = svgRef.current!.getBoundingClientRect()
          const mx = e.clientX - r.left, my = e.clientY - r.top
          const k = Math.min(6, Math.max(0.2, view.k * Math.exp(-e.deltaY * 0.0015)))
          setView({ k, x: mx - ((mx - view.x) * k) / view.k, y: my - ((my - view.y) * k) / view.k })
        }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onDoubleClick={() => { if (tool.kind === "wire") setWireStart(null) }}
      >
        <defs>
          <pattern id="dots" width={2 * UNIT_PX * view.k} height={2 * UNIT_PX * view.k} patternUnits="userSpaceOnUse" x={view.x} y={view.y}>
            <circle cx={1} cy={1} r={0.9} fill="var(--canvas-grid)" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#dots)" />
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {/* wires */}
          {shown.wires.map((w) => {
            const net = netlist.wireNet.get(w.id)
            const sel = selection.wires.has(w.id)
            const stroke = sel ? "var(--canvas-selection)" : showVolt ? voltColor(netVolt(net), vmax) : "var(--canvas-wire)"
            const [x1, y1, x2, y2] = [w.a[0] * UNIT_PX, w.a[1] * UNIT_PX, w.b[0] * UNIT_PX, w.b[1] * UNIT_PX]
            return (
              <g key={w.id}>
                <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={stroke} strokeWidth={2.4} strokeLinecap="round" />
                <line
                  x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={10}
                  onPointerDown={(e) => onWireDown(e, w.id)}
                  onPointerEnter={(e) => hoverNet(e, net)}
                  onPointerLeave={unhover}
                  style={{ cursor: tool.kind === "select" ? "move" : "crosshair" }}
                />
              </g>
            )
          })}
          {/* current flow */}
          {live && overlays.flow && !drag && shown.wires.map((w) => {
            const i = wireFlow.get(w.id) ?? 0
            if (!(Math.abs(i) > 1e-9)) return null
            const [a, b] = i > 0 ? [w.a, w.b] : [w.b, w.a]
            const mag = Math.log10(Math.abs(i) * 1e6) // decades above 1 µA
            const dur = Math.min(3, Math.max(0.35, 1.8 - 0.35 * mag))
            return <line key={`f${w.id}`} x1={a[0] * UNIT_PX} y1={a[1] * UNIT_PX} x2={b[0] * UNIT_PX} y2={b[1] * UNIT_PX} className="sb-flow" stroke="var(--canvas-current)" strokeWidth={4} style={{ animationDuration: `${dur}s` }} />
          })}
          {netlist.junctions.map((p) => (
            <circle key={key(p)} cx={p[0] * UNIT_PX} cy={p[1] * UNIT_PX} r={3.6} fill={showVolt ? voltColor(netVolt(netlist.pointNet.get(key(p))), vmax) : "var(--canvas-wire)"} />
          ))}
          {/* parts */}
          {shown.parts.map((p) => {
            const sel = selection.parts.has(p.id)
            const sym = symbolFor(p)
            const u = unitOf(p)
            if (!sym || !u) return null
            const label = isLabel(p)
            const color = sel ? "var(--canvas-selection)" : label ? "var(--chart-5)" : "var(--canvas-symbol)"
            const flagged = netlist.issues.some((i) => i.ref === p.ref)
            const out = live && !drag ? outputState(p, values) : null
            return (
              <g key={p.id}>
                {out && <g transform={partTransform(p)}><OutputGlow s={out} box={u.box} id={p.id} /></g>}
                <g
                  transform={partTransform(p)}
                  onPointerDown={(e) => onPartDown(e, p)}
                  onPointerEnter={(e) => hoverPart(e, p)}
                  onPointerLeave={unhover}
                  style={{ cursor: tool.kind === "select" ? "move" : "pointer", color }}
                >
                  <rect x={u.box[0] - 4} y={u.box[1] - 4} width={u.box[2] + 8} height={u.box[3] + 8} rx={3}
                    fill={sel ? "color-mix(in oklab, var(--canvas-selection) 10%, transparent)" : "transparent"}
                    stroke={sel ? "var(--canvas-selection)" : "none"} strokeDasharray="4 3" strokeWidth={1} />
                  <UnitArt unit={u} />
                  {out && <OutputMarks s={out} box={u.box} />}
                </g>
                {label ? (
                  <text x={p.x * UNIT_PX + 22} y={p.y * UNIT_PX - 13} className="pointer-events-none font-sans" fill={color} fontSize={11} fontWeight={600}>{p.net}</text>
                ) : (
                  <PartFields part={p} sym={sym} color={color} />
                )}
                {/* pins: small squares so you can see where to connect */}
                {(tool.kind === "wire" || tool.kind === "noconnect" || flagged) && !label &&
                  placedPins(p).filter((pp) => !noConnects.has(key(pp.at))).map((pp) => (
                    <rect key={pp.n + key(pp.at)} x={pp.at[0] * UNIT_PX - 3} y={pp.at[1] * UNIT_PX - 3} width={6} height={6} fill="none" stroke="var(--canvas-selection)" strokeWidth={1.2} className="pointer-events-none" />
                  ))}
              </g>
            )
          })}
          {/* no-connect markers */}
          {(doc.noConnects ?? []).map((p) => (
            <g key={`nc${key(p)}`} stroke="var(--destructive)" strokeWidth={2} className="pointer-events-none">
              <line x1={p[0] * UNIT_PX - 6} y1={p[1] * UNIT_PX - 6} x2={p[0] * UNIT_PX + 6} y2={p[1] * UNIT_PX + 6} />
              <line x1={p[0] * UNIT_PX + 6} y1={p[1] * UNIT_PX - 6} x2={p[0] * UNIT_PX - 6} y2={p[1] * UNIT_PX + 6} />
            </g>
          ))}
          {/* op-point voltage tags */}
          {live && overlays.tags && !drag && [...netAnchor].map(([net, at]) => {
            const v = netVolt(net)
            if (net === "0" || v === undefined || !Number.isFinite(v)) return null
            const text = formatSI(v, "V", 3)
            const w = text.length * 6.6 + 12
            const x = at[0] * UNIT_PX - w / 2, y = at[1] * UNIT_PX - 24
            return (
              <g key={`t${net}`} className="pointer-events-none">
                <rect x={x} y={y} width={w} height={17} rx={4} fill="var(--popover)" stroke="var(--border)" />
                <text x={x + w / 2} y={y + 12} textAnchor="middle" className="font-mono" fontSize={10.5} fill="var(--foreground)">{text}</text>
              </g>
            )
          })}
          {/* live controls (switches, buttons, pots) and sensor readings */}
          {inputs && !drag && tool.kind !== "place" && <InputChips doc={shown} api={inputs} />}
          {/* probe flags */}
          {probeFlags.map((f, n) => {
            const a = flagAnchor(f.signal)
            if (!a) return null
            // instrument leads (removable: false) show what they do, not the signal they hang on
            const text = f.removable === false ? `${f.label}${f.value ? ` ${f.value}` : ""}` : `${f.label} ${f.signal}${f.value ? ` ${f.value}` : ""}`
            const w = text.length * 6.4 + (f.removable === false ? 26 : 42)
            const fx = a[0] + 26, fy = a[1] - 46 - (n % 3) * 4
            return (
              <g key={`p${f.label}${f.signal}`} className="pointer-events-none">
                <line x1={a[0]} y1={a[1]} x2={fx} y2={fy + 9} stroke={f.color} strokeWidth={1.2} strokeDasharray="3 3" />
                <circle cx={a[0]} cy={a[1]} r={3.5} fill="var(--canvas-background)" stroke={f.color} strokeWidth={1.6} />
                <rect x={fx} y={fy} width={w} height={19} rx={9.5} fill={f.color} />
                <circle cx={fx + 10} cy={fy + 9.5} r={4} fill="none" stroke="white" strokeWidth={1.4} />
                <text x={fx + 19} y={fy + 13.5} fontSize={10.5} fill="white" className="font-mono" fontWeight={600}>{text}</text>
                {f.removable !== false && <g role="button" aria-label={`Remove probe ${f.signal}`} className="pointer-events-auto cursor-pointer opacity-80 hover:opacity-100"
                  onPointerDown={(e) => { e.stopPropagation(); onRemoveProbe(f.signal) }}>
                  <title>Remove probe</title>
                  <circle cx={fx + w - 10} cy={fy + 9.5} r={7} fill="black" fillOpacity={0.18} />
                  <path d={`M${fx + w - 13} ${fy + 6.5}l6 6m0 -6l-6 6`} stroke="white" strokeWidth={1.5} strokeLinecap="round" />
                </g>}
              </g>
            )
          })}
          {/* wire preview */}
          {tool.kind === "wire" && wireStart && (
            <polyline points={route(wireStart, cursor, vfirst).map((p) => `${p[0] * UNIT_PX},${p[1] * UNIT_PX}`).join(" ")} fill="none" stroke="var(--canvas-wire)" strokeWidth={2} strokeDasharray="6 4" className="pointer-events-none" />
          )}
          {(tool.kind === "wire" || tool.kind === "noconnect") && (
            <circle cx={cursor[0] * UNIT_PX} cy={cursor[1] * UNIT_PX} r={4} fill="none" stroke={tool.kind === "wire" ? "var(--canvas-wire)" : "var(--destructive)"} strokeWidth={1.5} className="pointer-events-none" />
          )}
          {/* ghost part */}
          {tool.kind === "place" && (
            <g className="pointer-events-none"><PartGlyph part={{ ...tool.part, ref: "", x: cursor[0], y: cursor[1], rot: ghostRot as Part["rot"], mirror: ghostMirror }} color="var(--canvas-selection)" ghost /></g>
          )}
          {/* box selection */}
          {drag?.kind === "box" && (
            <rect
              x={Math.min(drag.start[0], drag.now[0]) * UNIT_PX} y={Math.min(drag.start[1], drag.now[1]) * UNIT_PX}
              width={Math.abs(drag.now[0] - drag.start[0]) * UNIT_PX} height={Math.abs(drag.now[1] - drag.start[1]) * UNIT_PX}
              fill="color-mix(in oklab, var(--canvas-selection) 8%, transparent)" stroke="var(--canvas-selection)" strokeDasharray="4 3" strokeWidth={1 / view.k}
              className="pointer-events-none"
            />
          )}
        </g>
      </svg>

      {/* hover card with mini waveform */}
      {hover && !drag && (() => {
        const s = hover.info.signal ? series(hover.info.signal) : null
        return (
          <div className="pointer-events-none fixed z-50 rounded-lg border bg-popover px-3 py-2 text-popover-foreground shadow-lg" style={{ left: hover.x + 14, top: hover.y + 14 }}>
            <div className="flex items-baseline gap-3 font-mono text-xs">
              <span className="font-semibold">{hover.title}</span>
              <span className="text-muted-foreground">{hover.sub}</span>
            </div>
            {s && s.x.length > 2 && <Sparkline x={s.x} y={s.y} color={hover.info.kind === "net" ? "var(--chart-2)" : "var(--canvas-current)"} />}
          </div>
        )
      })()}

      {/* zoom + hint + minimap */}
      <div className="absolute bottom-3 left-3 flex items-center gap-0.5 rounded-lg border bg-popover p-0.5 shadow-sm">
        <Button variant="ghost" size="icon-sm" onClick={() => setView((v) => ({ ...v, k: Math.max(0.2, v.k / 1.2) }))}><Minus /></Button>
        <span className="w-12 text-center font-mono text-xs">{Math.round((view.k / ZOOM_100) * 100)}%</span>
        <Button variant="ghost" size="icon-sm" onClick={() => setView((v) => ({ ...v, k: Math.min(6, v.k * 1.2) }))}><Plus /></Button>
        <Button variant="ghost" size="icon-sm" onClick={fit} title="Fit to view"><Maximize2 /></Button>
        <div className="mx-0.5 h-4 w-px bg-border" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" title="View: current flow, voltage colours, labels"><Eye /></Button></DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-56">
            <DropdownMenuLabel className="text-xs">Show on the schematic</DropdownMenuLabel>
            {([["flow", "Current flow"], ["volt", "Voltage colours"], ["tags", "Op-point labels"]] as const).map(([k, l]) => (
              <DropdownMenuCheckboxItem key={k} checked={overlays[k]} onCheckedChange={(c) => setOverlays({ ...overlays, [k]: !!c })} onSelect={(e) => e.preventDefault()}>{l}</DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuCheckboxItem checked={settings.outputSound} onCheckedChange={(c) => setSettings({ outputSound: !!c })} onSelect={(e) => e.preventDefault()}>Sound from speakers</DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <div className="px-2 pb-2 pt-1 text-xs">
              <div className="mb-1 text-muted-foreground">Voltage scale</div>
              <div className="h-1.5 rounded-full" style={{ background: "linear-gradient(90deg, var(--canvas-volt-low), var(--canvas-volt-zero), var(--canvas-volt-high))" }} />
              <div className="mt-1 flex justify-between font-mono text-[10px] text-muted-foreground"><span>−{formatSI(vmax, "V", 2)}</span><span>0</span><span>+{formatSI(vmax, "V", 2)}</span></div>
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant={showMini ? "secondary" : "ghost"} size="icon-sm" onClick={() => setShowMini((v) => !v)} title={showMini ? "Hide minimap" : "Show minimap"} aria-pressed={showMini}><MapIcon /></Button>
      </div>
      <div className="pointer-events-none absolute bottom-3 left-64 max-w-[calc(100%-18rem)] truncate rounded-lg border bg-popover/90 px-3 py-1.5 font-mono text-xs text-muted-foreground shadow-sm">
        {tool.kind === "wire" ? (wireStart ? "Click to add a corner · end on a pin or wire · / flips the bend · Esc stops" : "Click to start a wire")
          : tool.kind === "place" ? "Click to place · R rotates · X mirrors · Esc stops"
          : tool.kind === "probe" ? "Click a wire to plot its voltage, a part for its current · × on a flag removes it"
          : tool.kind === "noconnect" ? "Click a pin to mark it intentionally unconnected (click again to remove)"
          : tool.kind === "pan" ? "Drag to pan · scroll to zoom"
          : "Drag to move · Shift-click to add · drag empty space to box-select · Alt-drag to pan"}
        <span className="ml-3 text-foreground">{cursor[0]}, {cursor[1]}</span>
      </div>
      {mini && showMini && (
        <div className="absolute bottom-3 right-3 rounded-lg border bg-popover/95 p-1.5 shadow-sm">
          <svg width={mini.W} height={mini.H} className="cursor-pointer"
            onPointerDown={(e) => {
              const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
              const gx = mini.b.x0 + (e.clientX - r.left) / mini.s, gy = mini.b.y0 + (e.clientY - r.top) / mini.s
              setView((v) => ({ ...v, x: size.w / 2 - gx * UNIT_PX * v.k, y: size.h / 2 - gy * UNIT_PX * v.k }))
            }}>
            <g transform={`scale(${mini.s}) translate(${-mini.b.x0} ${-mini.b.y0})`}>
              {doc.wires.map((w) => <line key={w.id} x1={w.a[0]} y1={w.a[1]} x2={w.b[0]} y2={w.b[1]} stroke="var(--canvas-wire)" strokeWidth={1.2 / mini.s} />)}
              {doc.parts.filter((p) => !isVirtual(p)).map((p) => <rect key={p.id} x={p.x - 2} y={p.y - 2} width={4} height={4} fill="var(--canvas-symbol)" opacity={0.6} />)}
              <rect
                x={-view.x / view.k / UNIT_PX} y={-view.y / view.k / UNIT_PX} width={size.w / view.k / UNIT_PX} height={size.h / view.k / UNIT_PX}
                fill="none" stroke="var(--canvas-selection)" strokeWidth={1.2 / mini.s}
              />
            </g>
          </svg>
        </div>
      )}
    </div>
  )
}
