// PCB editor: layers, footprints placed from the schematic, ratsnest,
// two-layer routing with vias (manual or auto-router), live DRC, Gerber + drill export.
import { useEffect, useMemo, useRef, useState } from "react"
import {
  Box, CircleDot, Download, Eye, EyeOff, LayoutGrid, Loader2, Maximize2, Minus, MousePointer2, Plus, RotateCw, Route, Scan, Settings2, ShieldCheck, Spline, Tag, Trash2, Wand2,
} from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Kbd } from "@/components/ui/kbd"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { saveExport } from "@/editor/file"
import { symbolFor, type Doc, type Part } from "@/editor/model"
import type { Netlist } from "@/editor/netlist"
import { BOARD_PRESETS, resizeBoard, smartPlace, boardParts, drc, fitBoard, LABEL_H, labelBox, labelSize, netClass, ratsnest, snap, syncBoard, type Board, type BoardPad, type DrcItem, type Label, type Layer, type MaskColor, type Pt, type Track } from "@/pcb/board"
import { autoLabel } from "@/pcb/labels"
import { textStrokes } from "@/pcb/gerber"
import { defaultFootprintName, footprintFromName } from "@/pcb/footprints"
import { fabricationFiles, zip } from "@/pcb/gerber"
import { autoRoute, DEFAULT_ROUTE, type RouteOptions } from "@/pcb/route"
import { Board3D } from "./Board3D"
import { cn } from "@/lib/utils"

const C = { board: "#0f3b2e", F: "#e0602c", B: "#3b82f6", pad: "#d4a72c", silk: "#f4f4f5", edge: "#f59e0b", court: "#a1a1aa", rat: "#e5e7eb", drc: "#ef4444", via: "#d4a72c" }
type LayerKey = "F" | "B" | "silk" | "mask" | "edge" | "court"
const LAYERS: { k: LayerKey; label: string; color: string }[] = [
  { k: "F", label: "Top copper", color: C.F }, { k: "B", label: "Bottom copper", color: C.B }, { k: "silk", label: "Silkscreen", color: "#e4e4e7" },
  { k: "mask", label: "Solder mask", color: "#16a34a" }, { k: "edge", label: "Board outline", color: C.edge }, { k: "court", label: "Courtyard", color: "#71717a" },
]

/** Footprint choices a part can switch to (only those whose pads cover the symbol's pins). */
const CHOICES = [
  "Resistor_SMD:R_0603_1608Metric", "Resistor_SMD:R_0805_2012Metric", "Resistor_SMD:R_1206_3216Metric", "Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal", "Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P7.62mm_Horizontal",
  "Capacitor_SMD:C_0603_1608Metric", "Capacitor_SMD:C_0805_2012Metric", "Capacitor_THT:C_Disc_D5.0mm_W2.5mm_P5.00mm", "Capacitor_THT:CP_Radial_D5.0mm_P2.00mm", "Capacitor_THT:CP_Radial_D6.3mm_P2.50mm", "Capacitor_THT:CP_Radial_D8.0mm_P3.50mm",
  "Inductor_SMD:L_1206_3216Metric", "LED_THT:LED_D3.0mm", "LED_THT:LED_D5.0mm", "LED_SMD:LED_0805_2012Metric", "Diode_THT:D_DO-35_SOD27_P7.62mm_Horizontal", "Diode_THT:D_DO-41_SOD81_P10.16mm_Horizontal",
  "Package_TO_SOT_THT:TO-92_Inline", "Package_TO_SOT_SMD:SOT-23", "Package_TO_SOT_THT:TO-220-3_Vertical", "Package_DIP:DIP-8_W7.62mm", "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm",
  "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical", "Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical",
]
function choicesFor(part: Part): string[] {
  const pins = new Set(symbolFor(part)?.units.flatMap((u) => u.pins.map((p) => p.n)) ?? [])
  return CHOICES.filter((n) => { const f = footprintFromName(n); return f && f.pads.length === pins.size && [...pins].every((x) => f.pads.some((p) => p.n === x)) })
}

interface Props {
  doc: Doc
  netlist: Netlist
  onChange: (b: Board) => void
  onFootprint: (partId: string, footprint: string) => void
}

type Sel = { kind: "part"; ref: string } | { kind: "track"; id: string } | { kind: "via"; id: string } | null
type Drag = { kind: "pan"; sx: number; sy: number; vx: number; vy: number } | { kind: "move"; ref: string; start: Pt; orig: Pt }
  | { kind: "label"; ref: string; start: Pt; orig: Label } | { kind: "resize"; edge: string; start: Pt; orig: Board; view: { x: number; y: number; k: number }; sx: number; sy: number } | null

const loadOpts = (): RouteOptions => { try { return { ...DEFAULT_ROUTE, ...JSON.parse(localStorage.getItem("sb-route-opts") ?? "{}"), nets: null } } catch { return DEFAULT_ROUTE } }
const MASKS: { k: MaskColor; c: string }[] = [{ k: "green", c: "#14532d" }, { k: "black", c: "#111113" }, { k: "blue", c: "#1e3a8a" }, { k: "red", c: "#991b1b" }, { k: "white", c: "#e7e5e4" }, { k: "purple", c: "#4c1d95" }]

export function PcbView({ doc, netlist, onChange, onFootprint }: Props) {
  const board = useMemo(() => syncBoard(doc, netlist, doc.pcb), [doc, netlist])
  // preview / drag also live in refs: pointer-up can arrive before React re-renders after the
  // last move (fast drags), and must still commit the latest preview
  const [preview, setPreviewState] = useState<Board | null>(null)
  const previewRef = useRef<Board | null>(null)
  const setPreview = (nb: Board | null) => { previewRef.current = nb; setPreviewState(nb) }
  const b = preview ?? board
  const parts = useMemo(() => boardParts(doc, netlist, b), [doc, netlist, b])
  const pads = useMemo(() => parts.flatMap((p) => p.pads), [parts])
  const rats = useMemo(() => ratsnest(parts, b), [parts, b])
  const issues = useMemo(() => drc(parts, b), [parts, b])
  const [visible, setVisible] = useState<Record<LayerKey, boolean>>({ F: true, B: true, silk: true, mask: true, edge: true, court: false })
  const [layer, setLayer] = useState<Layer>("F")
  const [tool, setTool] = useState<"select" | "route">("select")
  const [sel, setSel] = useState<Sel>(null)
  const [hoverNet, setHoverNet] = useState<string | null>(null)
  const [focus, setFocus] = useState<DrcItem | null>(null)
  const [routing, setRouting] = useState<{ net: string; pts: Pt[]; layers: Layer[] } | null>(null)
  const [cursor, setCursor] = useState<Pt>([0, 0])
  const [busy, setBusy] = useState(false)
  const svg = useRef<SVGSVGElement>(null)
  const [view, setView] = useState({ x: 40, y: 40, k: 14 })
  const [drag, setDragState] = useState<Drag>(null)
  const dragRef = useRef<Drag>(null)
  const setDrag = (d: Drag) => { dragRef.current = d; setDragState(d) }
  const [mode, setMode] = useState<"2d" | "3d">("2d")
  const [opts, setOptsState] = useState<RouteOptions>(loadOpts)
  const setOpts = (o: Partial<RouteOptions>) => setOptsState((x) => { const n = { ...x, ...o }; try { localStorage.setItem("sb-route-opts", JSON.stringify({ ...n, nets: null })) } catch { /* storage unavailable */ } return n })
  const [optsOpen, setOptsOpen] = useState(false)
  const [labelAfter, setLabelAfter] = useState(() => { try { return localStorage.getItem("sb-autolabel") !== "0" } catch { return true } })
  const [fitMargin, setFitMargin] = useState(2)
  const commit = (nb: Board) => { setPreview(null); onChange(nb) }
  /** Re-place every reference so none overlaps a pad, via, another reference or the edge. */
  const relabel = (nb: Board, quiet = false) => {
    const ps = boardParts(doc, netlist, { ...nb, labels: {} })
    const r = autoLabel(ps, nb)
    if (!quiet) {
      if (r.unplaced.length) toast.warning(`Labelled ${ps.length - r.unplaced.length} of ${ps.length} parts`, { description: `No free spot next to ${r.unplaced.join(", ")} — move parts apart or enlarge the board` })
      else toast.success(`Labelled ${ps.length} parts · no overlaps`)
    }
    return { ...nb, labels: { ...Object.fromEntries(r.unplaced.map((ref) => [ref, ps.find((p) => p.ref === ref)!.label])), ...r.labels } }
  }

  // fit the board on first show and on demand
  const fit = () => {
    const el = svg.current
    if (!el) return
    const w = el.clientWidth, h = el.clientHeight
    const k = Math.min((w - 80) / b.width, (h - 120) / b.height)
    setView({ k, x: (w - b.width * k) / 2, y: (h - b.height * k) / 2 + 10 })
  }
  useEffect(() => { fit() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const toWorld = (e: { clientX: number; clientY: number }): Pt => {
    const r = svg.current!.getBoundingClientRect()
    return [(e.clientX - r.left - view.x) / view.k, (e.clientY - r.top - view.y) / view.k]
  }
  const padAt = (p: Pt) => pads.find((q) => (layer === "B" ? q.layers.includes("B") : q.layers.includes("F")) && Math.abs(p[0] - q.ax) <= q.aw / 2 + 0.1 && Math.abs(p[1] - q.ay) <= q.ah / 2 + 0.1)
    ?? pads.find((q) => Math.abs(p[0] - q.ax) <= q.aw / 2 + 0.1 && Math.abs(p[1] - q.ay) <= q.ah / 2 + 0.1)
  const trackAt = (p: Pt) => b.tracks.find((t) => distSeg(p, t.a, t.b) <= t.width / 2 + 0.15)
  const viaAt = (p: Pt) => b.vias.find((v) => Math.hypot(p[0] - v.x, p[1] - v.y) <= v.dia / 2 + 0.1)
  const partAt = (p: Pt) => [...parts].reverse().find((q) => p[0] >= q.court[0] && p[0] <= q.court[2] && p[1] >= q.court[1] && p[1] <= q.court[3])
  const labelAt = (p: Pt) => (visible.silk ? parts.find((q) => { const lb = labelBox(q.ref, q.label); return p[0] >= lb[0] - 0.1 && p[0] <= lb[2] + 0.1 && p[1] >= lb[1] - 0.1 && p[1] <= lb[3] + 0.1 }) : undefined)
  /** outline handles: right edge, bottom edge, corner (6 px tolerance) */
  /** outline edges under the pointer: "l", "r", "t", "b" or a corner like "lt" (6 px tolerance) */
  const handleAt = (p: Pt): string | null => {
    const t = 6 / view.k
    const inY = p[1] >= -t && p[1] <= b.height + t, inX = p[0] >= -t && p[0] <= b.width + t
    const e = `${Math.abs(p[0]) <= t && inY ? "l" : ""}${Math.abs(p[0] - b.width) <= t && inY ? "r" : ""}${Math.abs(p[1]) <= t && inX ? "t" : ""}${Math.abs(p[1] - b.height) <= t && inX ? "b" : ""}`
    return e || null
  }

  /** Route preview: from the last point to the cursor, straight then 45°. */
  const legs = (from: Pt, to: Pt): Pt[] => {
    const dx = to[0] - from[0], dy = to[1] - from[1]
    if (Math.abs(dx) < 1e-6 || Math.abs(dy) < 1e-6 || Math.abs(Math.abs(dx) - Math.abs(dy)) < 1e-6) return [to]
    const d = Math.min(Math.abs(dx), Math.abs(dy))
    const mid: Pt = Math.abs(dx) > Math.abs(dy) ? [to[0] - Math.sign(dx) * d, from[1]] : [from[0], to[1] - Math.sign(dy) * d]
    return [mid, to]
  }
  const snapPt = (p: Pt): Pt => { const pad = padAt(p); return pad ? [pad.ax, pad.ay] : [snap(p[0], 0.25), snap(p[1], 0.25)] }

  const finishRoute = (r: { net: string; pts: Pt[]; layers: Layer[] }, extraVia = false) => {
    const width = netClass(b, r.net).width
    const tracks: Track[] = []
    for (let i = 1; i < r.pts.length; i++) if (r.pts[i][0] !== r.pts[i - 1][0] || r.pts[i][1] !== r.pts[i - 1][1]) tracks.push({ id: uidT(), net: r.net, layer: r.layers[i], a: r.pts[i - 1], b: r.pts[i], width })
    const vias = r.layers.flatMap((L, i) => (i > 1 && L !== r.layers[i - 1] ? [{ id: uidT("v"), net: r.net, x: r.pts[i - 1][0], y: r.pts[i - 1][1], dia: 0.8, drill: 0.4 }] : []))
    if (extraVia) { const last = r.pts[r.pts.length - 1]; vias.push({ id: uidT("v"), net: r.net, x: last[0], y: last[1], dia: 0.8, drill: 0.4 }) }
    if (tracks.length || vias.length) commit({ ...b, tracks: [...b.tracks, ...tracks], vias: [...b.vias, ...vias] })
    setRouting(null)
  }

  const onDown = (e: React.PointerEvent) => {
    const p = toWorld(e)
    const h = tool === "select" && e.button === 0 ? handleAt(p) : null
    if (h) {
      svg.current!.setPointerCapture(e.pointerId)
      setDrag({ kind: "resize", edge: h, start: p, orig: board, view, sx: e.clientX, sy: e.clientY })
      return
    }
    const lab = tool === "select" && e.button === 0 && !e.altKey ? labelAt(p) : undefined
    if (lab) {
      svg.current!.setPointerCapture(e.pointerId)
      setSel({ kind: "part", ref: lab.ref })
      setDrag({ kind: "label", ref: lab.ref, start: p, orig: lab.label })
      return
    }
    if (e.button === 1 || e.altKey || (e.button === 0 && tool === "select" && !partAt(p) && !trackAt(p) && !viaAt(p))) {
      svg.current!.setPointerCapture(e.pointerId)
      setDrag({ kind: "pan", sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y })
      if (tool === "select") setSel(null)
      return
    }
    if (e.button !== 0) return
    if (tool === "route") {
      const sp = snapPt(p)
      if (!routing) {
        const pad = padAt(p), t = trackAt(p), v = viaAt(p)
        const net = pad?.net || t?.net || v?.net
        if (!net) { toast("Start a track on a pad, track or via"); return }
        const L: Layer = pad && !pad.layers.includes(layer) ? pad.layers[0] : t ? t.layer : layer
        setLayer(L)
        setRouting({ net, pts: [sp], layers: [L] })
        return
      }
      const last = routing.pts[routing.pts.length - 1]
      const add = legs(last, sp)
      const next = { ...routing, pts: [...routing.pts, ...add], layers: [...routing.layers, ...add.map(() => layer)] }
      const pad = padAt(p)
      if (pad && pad.net === routing.net && pad.layers.includes(layer) && next.pts.length > 1) finishRoute(next)
      else setRouting(next)
      return
    }
    // select tool
    const part = partAt(p), t = trackAt(p), v = viaAt(p)
    if (v) setSel({ kind: "via", id: v.id })
    else if (t) setSel({ kind: "track", id: t.id })
    else if (part) {
      setSel({ kind: "part", ref: part.ref })
      svg.current!.setPointerCapture(e.pointerId)
      setDrag({ kind: "move", ref: part.ref, start: p, orig: [part.at.x, part.at.y] })
    }
  }
  const onMove = (e: React.PointerEvent) => {
    const drag = dragRef.current // latest, even before React re-renders
    const p = toWorld(e)
    setCursor(p)
    const pad = padAt(p)
    setHoverNet(routing?.net ?? pad?.net ?? null)
    if (drag?.kind === "pan") setView((v) => ({ ...v, x: drag.vx + e.clientX - drag.sx, y: drag.vy + e.clientY - drag.sy }))
    if (drag?.kind === "move") {
      const at = b.place[drag.ref] ?? { x: 0, y: 0, rot: 0 as const }
      const nx = snap(drag.orig[0] + p[0] - drag.start[0]), ny = snap(drag.orig[1] + p[1] - drag.start[1])
      if (nx !== at.x || ny !== at.y) {
        // a label the user placed travels with its part
        const lab = board.labels?.[drag.ref]
        const labels = lab ? { ...board.labels, [drag.ref]: { ...lab, x: lab.x + nx - at.x, y: lab.y + ny - at.y } } : board.labels
        setPreview({ ...board, place: { ...board.place, [drag.ref]: { ...at, x: nx, y: ny } }, labels })
      }
    }
    if (drag?.kind === "label") {
      const x = Math.round((drag.orig.x + p[0] - drag.start[0]) * 10) / 10, y = Math.round((drag.orig.y + p[1] - drag.start[1]) * 10) / 10
      setPreview({ ...board, labels: { ...board.labels, [drag.ref]: { ...drag.orig, x, y } } })
    }
    if (drag?.kind === "resize") {
      // pointer travel in mm, measured from where the drag started (the view moves during the drag)
      const dx = (e.clientX - drag.sx) / drag.view.k, dy = (e.clientY - drag.sy) / drag.view.k
      const { shift, ...nb } = resizeBoard(drag.orig, drag.edge, dx, dy)
      setPreview(nb)
      // a left / top edge moves the board origin: shift the view so the parts stay put on screen
      setView({ ...drag.view, x: drag.view.x + shift[0] * drag.view.k, y: drag.view.y + shift[1] * drag.view.k })
    }
  }
  const onUp = () => {
    const d = dragRef.current, pv = previewRef.current
    if ((d?.kind === "move" || d?.kind === "label" || d?.kind === "resize") && pv) commit(pv)
    setDrag(null)
  }
  const onWheel = (e: React.WheelEvent) => {
    const r = svg.current!.getBoundingClientRect()
    const mx = e.clientX - r.left, my = e.clientY - r.top
    const k = Math.min(200, Math.max(2, view.k * Math.exp(-e.deltaY * 0.0015)))
    setView((v) => ({ k, x: mx - ((mx - v.x) / v.k) * k, y: my - ((my - v.y) / v.k) * k }))
  }

  const rotateSel = () => {
    if (sel?.kind !== "part") return
    const at = b.place[sel.ref] ?? { x: 0, y: 0, rot: 0 as const }
    commit({ ...b, place: { ...b.place, [sel.ref]: { ...at, rot: (((at.rot + 90) % 360) as 0 | 90 | 180 | 270) } } })
  }
  const deleteSel = () => {
    if (sel?.kind === "track") commit({ ...b, tracks: b.tracks.filter((t) => t.id !== sel.id) })
    else if (sel?.kind === "via") commit({ ...b, vias: b.vias.filter((v) => v.id !== sel.id) })
    setSel(null)
  }
  // keyboard: R rotate, Delete, X route, V via / layer switch, Esc
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input,textarea,[contenteditable],[role=combobox],[role=listbox]")) return
      const key = e.key.toLowerCase()
      if (e.key === "Escape") { if (routing) setRouting(null); else { setSel(null); setTool("select") } }
      else if (key === "x" && !e.metaKey) setTool("route")
      else if (key === "s" && !e.metaKey) setTool("select")
      else if (key === "v" && !e.metaKey) {
        const L: Layer = layer === "F" ? "B" : "F"
        if (routing) {
          // via at the last point, continue on the other layer
          const last = routing.pts[routing.pts.length - 1]
          setRouting({ ...routing, pts: [...routing.pts, last], layers: [...routing.layers, L] })
        }
        setLayer(L)
      } else if (key === "r" && !e.metaKey && drag?.kind === "label") {
        // R while dragging a label turns it
        const l = (preview ?? board).labels?.[drag.ref] ?? drag.orig
        setPreview({ ...(preview ?? board), labels: { ...(preview ?? board).labels, [drag.ref]: { ...l, rot: l.rot === 90 ? 0 : 90 } } })
      } else if (key === "r" && !e.metaKey) rotateSel()
      else if (key === "l" && !e.metaKey) commit(relabel(b))
      else if (key === "3" && !e.metaKey) setMode((m) => (m === "3d" ? "2d" : "3d"))
      else if ((e.key === "Delete" || e.key === "Backspace") && !routing) { e.preventDefault(); deleteSel() }
      else if (e.key === "Backspace" && routing) { e.preventDefault(); setRouting(routing.pts.length > 1 ? { ...routing, pts: routing.pts.slice(0, -1), layers: routing.layers.slice(0, -1) } : null) }
      else if (e.key === "Enter" && routing) finishRoute(routing)
      else return
      e.stopPropagation()
    }
    window.addEventListener("keydown", k, true)
    return () => window.removeEventListener("keydown", k, true)
  })

  const runAutoRoute = (o: Partial<RouteOptions> = {}) => {
    setBusy(true)
    setTimeout(() => {
      const t0 = performance.now()
      const r = autoRoute(doc, netlist, b, { ...opts, ...o })
      commit(labelAfter ? relabel(r.board, true) : r.board)
      setBusy(false)
      const ms = Math.round(performance.now() - t0)
      const tries = r.attempts > 1 ? ` · ${r.attempts} attempts` : ""
      if (r.failed.length) toast.warning(`Routed ${r.routed} connection${r.routed === 1 ? "" : "s"} · ${r.failed.length} could not be routed (${ms} ms${tries})`, { description: `${[...new Set(r.failed.map((f) => f.net))].join(", ")} — move parts apart, allow both layers, use a finer grid or a bigger board.` })
      else toast.success(`Routed ${r.routed} connection${r.routed === 1 ? "" : "s"} · ${ms} ms${tries}`)
    }, 20)
  }
  const exportGerbers = async () => {
    const errors = issues.filter((i) => i.severity === "error")
    if (errors.length) toast.warning(`Exporting with ${errors.length} DRC error${errors.length > 1 ? "s" : ""}`, { description: errors[0].title })
    const name = doc.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "board"
    try {
      const p = await saveExport(`${name}-gerbers.zip`, "zip", zip(fabricationFiles(b, parts, name)))
      if (p) toast.success(`Gerbers saved: ${p.split("/").pop()}`, { description: "F/B copper, F/B mask, paste, silkscreen, outline (Gerber X2) + Excellon drill" })
    } catch (e) { toast.error(String(e instanceof Error ? e.message : e)) }
  }

  const errors = issues.filter((i) => i.severity === "error").length
  const routePreview = routing ? [...routing.pts, ...legs(routing.pts[routing.pts.length - 1], snapPt(cursor))] : null
  const dim = (net: string) => (hoverNet && net !== hoverNet ? 0.35 : 1)
  const selTrack = sel?.kind === "track" ? sel.id : null, selVia = sel?.kind === "via" ? sel.id : null

  return (
    <div className="flex h-full min-h-0">
      {/* layers + net classes */}
      <aside className="flex w-[260px] shrink-0 flex-col gap-1 overflow-auto border-r bg-sidebar p-3">
        <div className="mb-1 text-sm font-medium">Layers</div>
        {LAYERS.map((l) => (
          <div key={l.k} className={cn("flex h-9 items-center gap-2.5 rounded-md px-2 text-sm", (l.k === layer) && "bg-accent")}>
            <button onClick={() => (l.k === "F" || l.k === "B") && setLayer(l.k)} className="flex flex-1 items-center gap-2.5 text-left" title={l.k === "F" || l.k === "B" ? "Route on this layer (V switches)" : undefined}>
              <span className="size-3.5 rounded-[3px]" style={{ background: l.color }} /> {l.label}
              {(l.k === "F" || l.k === "B") && l.k === layer && <Badge variant="secondary" className="ml-auto h-4 px-1 text-[10px]">active</Badge>}
            </button>
            <button onClick={() => setVisible((v) => ({ ...v, [l.k]: !v[l.k] }))} className="text-muted-foreground hover:text-foreground" aria-label={`Toggle ${l.label}`}>{visible[l.k] ? <Eye className="size-4" /> : <EyeOff className="size-4" />}</button>
          </div>
        ))}
        <div className="mb-1 mt-4 text-sm font-medium">Net classes</div>
        <NetClassRow label="Default" value={b.rules.default} onChange={(v) => commit({ ...b, rules: { ...b.rules, default: v } })} />
        <NetClassRow label={`Power (${b.rules.power.nets.slice(0, 3).join(", ")}${b.rules.power.nets.length > 3 ? "…" : ""})`} value={b.rules.power} onChange={(v) => commit({ ...b, rules: { ...b.rules, power: { ...b.rules.power, ...v } } })} />
        <div className="mb-1 mt-4 text-sm font-medium">Board size</div>
        <div className="flex flex-col gap-2 px-2 text-xs">
          <div className="flex items-center gap-1.5">
            <MmInput value={b.width} onCommit={(v) => commit({ ...b, width: Math.max(5, v) })} /> × <MmInput value={b.height} onCommit={(v) => commit({ ...b, height: Math.max(5, v) })} /> mm
          </div>
          <Select value="" onValueChange={(v) => { const pr = BOARD_PRESETS[Number(v)]; if (pr) commit({ ...b, width: pr.w, height: pr.h }) }}>
            <SelectTrigger size="sm" className="h-7 text-xs"><SelectValue placeholder="Presets…" /></SelectTrigger>
            <SelectContent>{BOARD_PRESETS.map((pr, i) => <SelectItem key={pr.label} value={String(i)} className="text-xs">{pr.label}</SelectItem>)}</SelectContent>
          </Select>
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="sm" className="h-7 flex-1 text-xs" onClick={() => { const nb = fitBoard(parts, b, fitMargin); commit(nb); toast.success(`Board fitted: ${nb.width} × ${nb.height} mm`) }}><Scan /> Fit to parts</Button>
            <span className="text-muted-foreground">margin</span><MmInput value={fitMargin} onCommit={(v) => setFitMargin(Math.max(0, v))} />
          </div>
          <label className="flex items-center justify-between gap-2"><span className="text-muted-foreground">Corner radius</span><MmInput value={b.radius ?? 0.5} onCommit={(v) => commit({ ...b, radius: Math.max(0, Math.min(v, Math.min(b.width, b.height) / 4)) })} /></label>
          <label className="flex items-center justify-between gap-2"><span className="text-muted-foreground">Thickness</span>
            <Select value={String(b.thickness ?? 1.6)} onValueChange={(v) => commit({ ...b, thickness: Number(v) })}>
              <SelectTrigger size="sm" className="h-7 w-24 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>{[0.8, 1.0, 1.2, 1.6, 2.0].map((t) => <SelectItem key={t} value={String(t)} className="text-xs">{t.toFixed(1)} mm</SelectItem>)}</SelectContent>
            </Select>
          </label>
          <div className="flex items-center justify-between gap-2"><span className="text-muted-foreground">Solder mask</span>
            <span className="flex gap-1">{MASKS.map((m) => <button key={m.k} title={m.k} onClick={() => commit({ ...b, mask: m.k })} className={cn("size-5 rounded-full border", (b.mask ?? "green") === m.k && "ring-2 ring-ring ring-offset-1 ring-offset-sidebar")} style={{ background: m.c }} />)}</span>
          </div>
          <p className="text-[11px] text-muted-foreground">Drag any edge or corner of the outline to resize — parts stay where they are.</p>
        </div>
        <p className="mt-auto px-2 pt-4 text-[11px] text-muted-foreground">Drag parts and labels · <Kbd>R</Kbd> rotate · <Kbd>X</Kbd> route · <Kbd>V</Kbd> via / layer · <Kbd>L</Kbd> auto label · <Kbd>3</Kbd> 3D · <Kbd>⌫</Kbd> delete · scroll to zoom · drag empty space to pan</p>
      </aside>

      {/* canvas */}
      <div className="relative min-w-0 flex-1 bg-canvas">
        {mode === "3d" && <div className="absolute inset-0"><Board3D board={b} parts={parts} /></div>}
        <svg ref={svg} style={mode === "3d" ? { visibility: "hidden" } : undefined} className={cn("h-full w-full touch-none select-none", tool === "route" ? "cursor-crosshair" : drag?.kind === "pan" ? "cursor-grabbing" : "cursor-default")}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onWheel={onWheel} onContextMenu={(e) => { e.preventDefault(); if (routing) finishRoute(routing) }}>
          <defs>
            <pattern id="pcbgrid" width={2.54 * view.k} height={2.54 * view.k} patternUnits="userSpaceOnUse" x={view.x} y={view.y}>
              <circle cx={0.5} cy={0.5} r={0.8} fill="var(--canvas-grid)" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#pcbgrid)" />
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            <rect x={0} y={0} width={b.width} height={b.height} rx={b.radius ?? 0.5} fill={MASKS.find((m) => m.k === (b.mask ?? "green"))!.c} stroke={visible.edge ? C.edge : "none"} strokeWidth={0.15} />
            {/* dimensions */}
            <g className="pointer-events-none" fill="var(--muted-foreground)" stroke="var(--muted-foreground)">
              <line x1={0} y1={-1.6} x2={b.width} y2={-1.6} strokeWidth={0.06} /><line x1={0} y1={-2.2} x2={0} y2={-1} strokeWidth={0.06} /><line x1={b.width} y1={-2.2} x2={b.width} y2={-1} strokeWidth={0.06} />
              <text x={b.width / 2} y={-2.1} textAnchor="middle" fontSize={Math.max(0.9, 11 / view.k)} stroke="none" className="font-mono">{b.width.toFixed(2)} mm</text>
              <line x1={-1.6} y1={0} x2={-1.6} y2={b.height} strokeWidth={0.06} /><line x1={-2.2} y1={0} x2={-1} y2={0} strokeWidth={0.06} /><line x1={-2.2} y1={b.height} x2={-1} y2={b.height} strokeWidth={0.06} />
              <text x={-2.1 - Math.max(0.9, 11 / view.k) * 0.3} y={b.height / 2} textAnchor="middle" fontSize={Math.max(0.9, 11 / view.k)} stroke="none" transform={`rotate(-90 ${-2.1 - Math.max(0.9, 11 / view.k) * 0.3} ${b.height / 2})`} className="font-mono">{b.height.toFixed(2)} mm</text>
            </g>
            {/* resize handles */}
            {tool === "select" && ([
              [0, b.height / 2, "ew-resize"], [b.width, b.height / 2, "ew-resize"], [b.width / 2, 0, "ns-resize"], [b.width / 2, b.height, "ns-resize"],
              [0, 0, "nwse-resize"], [b.width, b.height, "nwse-resize"], [b.width, 0, "nesw-resize"], [0, b.height, "nesw-resize"],
            ] as const).map(([x, y, cur], i) => (
              <rect key={i} x={x - 4 / view.k} y={y - 4 / view.k} width={8 / view.k} height={8 / view.k} rx={1.5 / view.k} fill="white" stroke={C.edge} strokeWidth={1.5 / view.k} style={{ cursor: cur }} />
            ))}
            {(["B", "F"] as const).map((L) => visible[L] && (
              <g key={L}>
                {b.tracks.filter((t) => t.layer === L).map((t) => (
                  <line key={t.id} x1={t.a[0]} y1={t.a[1]} x2={t.b[0]} y2={t.b[1]} stroke={C[L]} strokeWidth={t.width} strokeLinecap="round" opacity={dim(t.net)}
                    className={selTrack === t.id ? "[filter:drop-shadow(0_0_0.4px_white)]" : undefined} />
                ))}
              </g>
            ))}
            {selTrack && (() => { const t = b.tracks.find((x) => x.id === selTrack); return t ? <line x1={t.a[0]} y1={t.a[1]} x2={t.b[0]} y2={t.b[1]} stroke="white" strokeWidth={t.width + 0.12} strokeOpacity={0.5} strokeLinecap="round" /> : null })()}
            {/* pads */}
            {pads.map((p) => {
              const show = p.layers.some((L) => visible[L])
              if (!show) return null
              const op = dim(p.net)
              return (
                <g key={`${p.ref}.${p.n}`} opacity={op}>
                  {visible.mask && <PadShape p={p} grow={0.05} fill="none" stroke="#16a34a" sw={0.04} />}
                  <PadShape p={p} fill={C.pad} />
                  {p.drill && <circle cx={p.ax} cy={p.ay} r={p.drill / 2} fill={C.board} />}
                </g>
              )
            })}
            {b.vias.map((v) => (
              <g key={v.id} opacity={dim(v.net)}>
                <circle cx={v.x} cy={v.y} r={v.dia / 2} fill={C.via} stroke={selVia === v.id ? "white" : "none"} strokeWidth={0.1} />
                <circle cx={v.x} cy={v.y} r={v.drill / 2} fill={C.board} />
              </g>
            ))}
            {/* silkscreen + courtyard */}
            {parts.map((bp) => {
              const t = (q: Pt): Pt => { const r = bp.at.rot === 90 ? [-q[1], q[0]] : bp.at.rot === 180 ? [-q[0], -q[1]] : bp.at.rot === 270 ? [q[1], -q[0]] : q; return [r[0] + bp.at.x, r[1] + bp.at.y] }
              const isSel = sel?.kind === "part" && sel.ref === bp.ref
              return (
                <g key={bp.ref}>
                  {visible.silk && bp.fp.silk.map((s, i) => s.k === "line"
                    ? <line key={i} x1={t(s.a)[0]} y1={t(s.a)[1]} x2={t(s.b)[0]} y2={t(s.b)[1]} stroke={C.silk} strokeWidth={0.15} strokeLinecap="round" />
                    : <circle key={i} cx={t(s.c)[0]} cy={t(s.c)[1]} r={s.r} fill="none" stroke={C.silk} strokeWidth={0.15} />)}
                  {visible.silk && <LabelText ref_={bp.ref} l={bp.label} selected={drag?.kind === "label" && drag.ref === bp.ref} />}
                  {(visible.court || isSel) && <rect x={bp.court[0]} y={bp.court[1]} width={bp.court[2] - bp.court[0]} height={bp.court[3] - bp.court[1]} fill={isSel ? "rgba(255,255,255,0.06)" : "none"} stroke={isSel ? "white" : C.court} strokeWidth={0.05} strokeDasharray={isSel ? undefined : "0.3 0.2"} />}
                </g>
              )
            })}
            {/* ratsnest */}
            {rats.map((r, i) => <line key={i} x1={r.a.ax} y1={r.a.ay} x2={r.b.ax} y2={r.b.ay} stroke={C.rat} strokeWidth={0.06} strokeDasharray="0.4 0.25" opacity={0.85} />)}
            {/* route in progress */}
            {routePreview && routePreview.slice(1).map((q, i) => {
              const L = routing!.layers[i + 1] ?? layer
              const a = routePreview[i]
              return <line key={i} x1={a[0]} y1={a[1]} x2={q[0]} y2={q[1]} stroke={C[L]} strokeWidth={netClass(b, routing!.net).width} strokeLinecap="round" opacity={i + 1 >= routing!.pts.length ? 0.55 : 0.95} />
            })}
            {/* DRC markers */}
            {issues.filter((i) => i.kind !== "unrouted").map((i, k) => (
              <circle key={k} cx={i.at[0]} cy={i.at[1]} r={focus === i ? 1.4 : 0.8} fill="none" stroke={i.severity === "error" ? C.drc : "#f59e0b"} strokeWidth={0.12} />
            ))}
          </g>
        </svg>
        {/* HUD + tools */}
        <div className="pointer-events-none absolute left-3 top-3 flex flex-wrap items-center gap-2">
          <div className="pointer-events-auto rounded-md border bg-background/90 px-3 py-1 text-xs shadow-sm backdrop-blur">
            {b.width.toFixed(1)} × {b.height.toFixed(1)} mm · 2 layers · {parts.length} footprints
            <span className="ml-3 font-mono text-muted-foreground">cursor X {cursor[0].toFixed(2)} Y {cursor[1].toFixed(2)} mm</span>
          </div>
          <div className="pointer-events-auto flex items-center gap-0.5 rounded-md border bg-background/90 p-0.5 shadow-sm backdrop-blur">
            <ToolBtn on={tool === "select"} title="Select / move (S)" onClick={() => { setTool("select"); setRouting(null) }}><MousePointer2 /></ToolBtn>
            <ToolBtn on={tool === "route"} title="Route a track (X)" onClick={() => setTool("route")}><Spline /></ToolBtn>
            <ToolBtn title={`Switch layer · via while routing (V) — now ${layer === "F" ? "top" : "bottom"}`} onClick={() => setLayer((l) => (l === "F" ? "B" : "F"))}><CircleDot style={{ color: C[layer] }} /></ToolBtn>
            <ToolBtn title="Rotate part (R)" onClick={rotateSel} disabled={sel?.kind !== "part"}><RotateCw /></ToolBtn>
            <ToolBtn title="Delete track / via (⌫)" onClick={deleteSel} disabled={sel?.kind !== "track" && sel?.kind !== "via"}><Trash2 /></ToolBtn>
            <span className="mx-1 h-5 w-px bg-border" />
            <ToolBtn title="Auto-place: spread parts out, connected parts close together (removes tracks)" onClick={() => { const nb = smartPlace(doc, netlist, { ...b, tracks: [], vias: [], labels: {} }); commit(labelAfter ? relabel(nb, true) : nb) }}><LayoutGrid /></ToolBtn>
            <ToolBtn title="Auto-route the ratsnest" onClick={() => runAutoRoute()} disabled={busy || !rats.length}>{busy ? <Loader2 className="animate-spin" /> : <Wand2 />}</ToolBtn>
            <ToolBtn title="Auto-router options" onClick={() => setOptsOpen(true)}><Settings2 /></ToolBtn>
            <ToolBtn title="Auto label: references without overlaps (L)" onClick={() => commit(relabel(b))}><Tag /></ToolBtn>
            <ToolBtn title="Remove all tracks and vias" onClick={() => commit({ ...b, tracks: [], vias: [] })} disabled={!b.tracks.length && !b.vias.length}><Route className="opacity-60" /></ToolBtn>
          </div>
          <div className="pointer-events-auto flex rounded-md border bg-background/90 p-0.5 shadow-sm backdrop-blur">
            {(["2d", "3d"] as const).map((m) => <button key={m} onClick={() => setMode(m)} className={cn("flex h-7 items-center gap-1 rounded px-2.5 text-xs", mode === m ? "bg-accent font-medium" : "text-muted-foreground")}>{m === "3d" && <Box className="size-3.5" />}{m.toUpperCase()}</button>)}
          </div>
          {routing && <div className="pointer-events-auto rounded-md border bg-background/90 px-3 py-1 text-xs shadow-sm">Routing <span className="font-mono">{routing.net}</span> on {layer === "F" ? "top" : "bottom"} · click to add · <Kbd>V</Kbd> via · right-click / <Kbd>↵</Kbd> finish · <Kbd>Esc</Kbd> cancel</div>}
        </div>
        <div className={cn("absolute bottom-3 left-3 flex items-center gap-1 rounded-md border bg-background/90 p-0.5 text-xs shadow-sm", mode === "3d" && "hidden")}>
          <Button variant="ghost" size="icon-sm" onClick={() => setView((v) => ({ ...v, k: v.k / 1.25 }))}><Minus /></Button>
          <span className="w-12 text-center font-mono">{Math.round(view.k * 10)}%</span>
          <Button variant="ghost" size="icon-sm" onClick={() => setView((v) => ({ ...v, k: v.k * 1.25 }))}><Plus /></Button>
          <Button variant="ghost" size="icon-sm" onClick={fit} title="Fit board"><Maximize2 /></Button>
        </div>
        {hoverNet && <div className="absolute bottom-3 right-3 rounded-md border bg-background/90 px-2 py-1 font-mono text-xs shadow-sm">net {hoverNet}</div>}
      </div>

      {/* inspector */}
      <aside className="flex w-[340px] shrink-0 flex-col border-l">
        <div className="flex flex-col gap-2 border-b p-4">
          <div className="flex items-center gap-2">
            <h3 className="flex-1 text-sm font-medium">Design rules check</h3>
            <Badge variant="secondary" className={errors ? "bg-destructive-subtle text-destructive" : "bg-success-subtle text-success"}>{errors ? `${errors} error${errors > 1 ? "s" : ""}` : "0 errors"}</Badge>
          </div>
          <div className="flex max-h-[38vh] flex-col gap-2 overflow-auto">
            {issues.slice(0, 60).map((i, k) => (
              <button key={k} onClick={() => { setFocus(i); setSel(i.refs?.[0] ? { kind: "part", ref: i.refs[0] } : null); const el = svg.current; if (el) setView((v) => ({ ...v, x: el.clientWidth / 2 - i.at[0] * v.k, y: el.clientHeight / 2 - i.at[1] * v.k })) }}
                className={cn("rounded-lg border p-2.5 text-left hover:bg-accent/50", i.severity === "error" ? "border-destructive/50" : "border-warning/60", focus === i && "bg-accent")}>
                <div className="text-sm">{i.title}</div>
                <div className="text-xs text-muted-foreground">{i.detail}</div>
              </button>
            ))}
            {!issues.length && <p className="text-xs text-muted-foreground">No problems: every connection is routed and clearances are met.</p>}
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-4">
          <h3 className="text-sm font-medium">Footprints from schematic</h3>
          {doc.parts.filter((p, i, a) => !p.lib.startsWith("power:") && !p.lib.startsWith("@") && a.findIndex((q) => q.ref === p.ref) === i).map((p) => {
            const on = !b.exclude.includes(p.ref)
            const bp = parts.find((x) => x.ref === p.ref)
            const opts = choicesFor(p)
            const cur = defaultFootprintName(p)
            return (
              <div key={p.ref} className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={on} onChange={(e) => commit({ ...b, exclude: e.target.checked ? b.exclude.filter((r) => r !== p.ref) : [...b.exclude, p.ref] })} className="size-3.5 accent-[var(--primary)]" />
                <span className="w-10 font-mono font-medium">{p.ref}</span>
                {opts.length > 1 ? (
                  <Select value={opts.includes(cur) ? cur : ""} onValueChange={(v) => onFootprint(p.id, v)}>
                    <SelectTrigger size="sm" className="h-6 min-w-0 flex-1 font-mono text-[11px]"><SelectValue placeholder={bp?.fp.label ?? "—"} /></SelectTrigger>
                    <SelectContent>{opts.map((o) => <SelectItem key={o} value={o} className="font-mono text-xs">{footprintFromName(o)!.label} · {o.split(":")[1]}</SelectItem>)}</SelectContent>
                  </Select>
                ) : <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{bp?.fp.label ?? "—"}</span>}
              </div>
            )
          })}
        </div>
        <div className="grid grid-cols-2 gap-2 border-t p-4">
          <Button variant="outline" onClick={() => { const e = issues.filter((i) => i.severity === "error").length; if (e) toast.error(`DRC: ${e} error${e > 1 ? "s" : ""}, ${issues.length - e} warning${issues.length - e === 1 ? "" : "s"}`); else toast.success(`DRC passed${issues.length ? ` · ${issues.length} warning${issues.length > 1 ? "s" : ""}` : ""}`) }}><ShieldCheck /> Run DRC</Button>
          <Button onClick={exportGerbers}><Download /> Export Gerbers</Button>
        </div>
      </aside>
      <RouteOptionsDialog open={optsOpen} onOpenChange={setOptsOpen} opts={opts} setOpts={setOpts} nets={[...new Set(pads.map((p) => p.net).filter(Boolean))].sort()}
        labelAfter={labelAfter} setLabelAfter={(v) => { setLabelAfter(v); try { localStorage.setItem("sb-autolabel", v ? "1" : "0") } catch { /* storage unavailable */ } }}
        busy={busy} onRoute={(o) => { setOptsOpen(false); runAutoRoute(o) }} hoverNet={hoverNet} />
    </div>
  )
}

/** Reference text in the silkscreen stroke font (the same strokes the Gerber and 3D view use). */
function LabelText({ ref_, l, selected }: { ref_: string; l: Label; selected: boolean }) {
  const w = labelSize(ref_).w
  const d = textStrokes(ref_, 0, LABEL_H).map((poly) => poly.map((q, i) => { const [x, y] = l.rot === 90 ? [l.x + q[1], l.y + w - q[0]] : [l.x + q[0], l.y + q[1]]; return `${i ? "L" : "M"}${x.toFixed(3)},${y.toFixed(3)}` }).join(" ")).join(" ")
  const bx = labelBox(ref_, l)
  return (
    <g className="cursor-move">
      <rect x={bx[0] - 0.1} y={bx[1] - 0.1} width={bx[2] - bx[0] + 0.2} height={bx[3] - bx[1] + 0.2} fill={selected ? "rgba(255,255,255,0.15)" : "transparent"} stroke={selected ? "white" : "none"} strokeWidth={0.04} />
      <path d={d} fill="none" stroke={C.silk} strokeWidth={0.15} strokeLinecap="round" strokeLinejoin="round" />
    </g>
  )
}

function RouteOptionsDialog({ open, onOpenChange, opts, setOpts, nets, labelAfter, setLabelAfter, busy, onRoute, hoverNet }: {
  open: boolean; onOpenChange: (o: boolean) => void; opts: RouteOptions; setOpts: (o: Partial<RouteOptions>) => void; nets: string[]
  labelAfter: boolean; setLabelAfter: (v: boolean) => void; busy: boolean; onRoute: (o: Partial<RouteOptions>) => void; hoverNet: string | null
}) {
  const [only, setOnly] = useState<string>("all")
  const Row = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
    <div className="flex items-center gap-4"><div className="min-w-0 flex-1"><div className="text-sm">{label}</div>{hint && <div className="text-xs text-muted-foreground">{hint}</div>}</div><div className="shrink-0">{children}</div></div>
  )
  const Seg = <T extends string | number>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) => (
    <div className="flex rounded-lg bg-muted p-[3px]">{options.map(([v, l]) => <button key={String(v)} onClick={() => onChange(v)} className={cn("h-7 rounded-md px-2.5 text-xs", value === v ? "bg-background font-medium shadow-sm" : "text-muted-foreground")}>{l}</button>)}</div>
  )
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg sm:max-w-lg">
        <DialogTitle>Auto-router</DialogTitle>
        <DialogDescription>Track width and clearance come from the net classes. Settings are remembered.</DialogDescription>
        <div className="flex flex-col gap-4 py-2">
          <Row label="Layers" hint="One-sided boards are cheaper to make at home"><Seg value={opts.layers} options={[["both", "Both"], ["top", "Top only"], ["bottom", "Bottom only"]]} onChange={(v) => setOpts({ layers: v })} /></Row>
          <Row label="Routing grid" hint="Finer finds more paths, coarser is faster"><Seg value={opts.grid} options={[[0.125, "0.125"], [0.25, "0.25"], [0.5, "0.5 mm"]]} onChange={(v) => setOpts({ grid: v })} /></Row>
          <Row label="Vias" hint="How hard to avoid changing layer"><Seg value={opts.viaCost} options={[[6, "Use freely"], [18, "Normal"], [60, "Avoid"]]} onChange={(v) => setOpts({ viaCost: v })} /></Row>
          <Row label="Corners" hint="Penalty for bends: straighter tracks vs shorter tracks"><Seg value={opts.bendCost} options={[[0.2, "Few"], [0.6, "Normal"], [2, "Straight"]]} onChange={(v) => setOpts({ bendCost: v })} /></Row>
          <Row label="Order" hint="Which connections get the best paths"><Seg value={opts.order} options={[["short", "Short first"], ["long", "Long first"], ["power", "Power first"]]} onChange={(v) => setOpts({ order: v })} /></Row>
          <Row label="Rip-up and retry" hint="If connections fail, re-route with them first"><Seg value={opts.attempts} options={[[1, "Off"], [3, "3×"], [6, "6×"]]} onChange={(v) => setOpts({ attempts: v })} /></Row>
          <Row label="Nets">
            <Select value={only} onValueChange={setOnly}>
              <SelectTrigger size="sm" className="w-44 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all" className="text-xs">All unrouted</SelectItem>{nets.map((n) => <SelectItem key={n} value={n} className="font-mono text-xs">{n}</SelectItem>)}</SelectContent>
            </Select>
          </Row>
          <Row label="Replace existing tracks" hint="Rip up the chosen nets' tracks before routing"><Switch checked={opts.clearFirst} onCheckedChange={(c) => setOpts({ clearFirst: c })} /></Row>
          <Row label="Auto label afterwards" hint="Re-place references so none overlaps"><Switch checked={labelAfter} onCheckedChange={setLabelAfter} /></Row>
        </div>
        <div className="flex justify-end gap-2">
          {hoverNet && <Button variant="outline" disabled={busy} onClick={() => onRoute({ nets: [hoverNet] })}>Route {hoverNet}</Button>}
          <Button disabled={busy} onClick={() => onRoute({ nets: only === "all" ? null : [only] })}>{busy ? <Loader2 className="animate-spin" /> : <Wand2 />} Route</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function PadShape({ p, fill, stroke, sw, grow = 0 }: { p: BoardPad; fill: string; stroke?: string; sw?: number; grow?: number }) {
  const w = p.aw + 2 * grow, h = p.ah + 2 * grow
  if (p.shape === "circle") return <circle cx={p.ax} cy={p.ay} r={w / 2} fill={fill} stroke={stroke} strokeWidth={sw} />
  const r = p.shape === "oval" ? Math.min(w, h) / 2 : p.shape === "roundrect" ? Math.min(w, h) * 0.25 : 0
  return <rect x={p.ax - w / 2} y={p.ay - h / 2} width={w} height={h} rx={r} fill={fill} stroke={stroke} strokeWidth={sw} />
}

function ToolBtn({ on, title, onClick, disabled, children }: { on?: boolean; title: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return <Button variant={on ? "secondary" : "ghost"} size="icon-sm" title={title} onClick={onClick} disabled={disabled} className={on ? "bg-accent" : ""}>{children}</Button>
}

function MmInput({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [t, setT] = useState<string | null>(null)
  const done = () => { const v = parseFloat(t ?? ""); if (t !== null && Number.isFinite(v)) onCommit(v); setT(null) }
  return <Input value={t ?? String(Number(value.toFixed(2)))} onChange={(e) => setT(e.target.value)} onBlur={done} onKeyDown={(e) => e.key === "Enter" && done()} className="h-7 w-16 text-right font-mono text-xs text-foreground" />
}

function NetClassRow({ label, value, onChange }: { label: string; value: { width: number; clearance: number }; onChange: (v: { width: number; clearance: number }) => void }) {
  return (
    <div className="flex flex-col gap-1 rounded-md px-2 py-1.5">
      <span className="truncate text-sm">{label}</span>
      <span className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
        <MmInput value={value.width} onCommit={(v) => onChange({ ...value, width: Math.max(0.1, v) })} /> mm · clearance
        <MmInput value={value.clearance} onCommit={(v) => onChange({ ...value, clearance: Math.max(0.1, v) })} />
      </span>
    </div>
  )
}

const distSeg = (p: Pt, a: Pt, b: Pt) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy
  const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
}
let n = 0
const uidT = (p = "t") => `${p}${Date.now().toString(36)}${(n++).toString(36)}`
