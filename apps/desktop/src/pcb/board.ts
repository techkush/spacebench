// The board: footprint placement, tracks and vias (stored on the Doc as `pcb`),
// plus everything derived from it — pads with nets, ratsnest, connectivity, DRC.
import { isVirtual, type Doc, type Part } from "@/editor/model"
import type { Netlist } from "@/editor/netlist"
import { footprintFor, type Footprint, type Pad } from "./footprints"

export type Layer = "F" | "B"
export type Pt = [number, number]
export interface Placement { x: number; y: number; rot: 0 | 90 | 180 | 270 }
export interface Track { id: string; net: string; layer: Layer; a: Pt; b: Pt; width: number }
export interface Via { id: string; net: string; x: number; y: number; dia: number; drill: number }
export interface NetClass { width: number; clearance: number }
export interface Board {
  width: number
  height: number
  place: Record<string, Placement>
  tracks: Track[]
  vias: Via[]
  /** refs left off the board */
  exclude: string[]
  rules: { default: NetClass; power: NetClass & { nets: string[] } }
  /** silkscreen reference positions (text box top-left, mm); missing = default above the part */
  labels?: Record<string, Label>
  /** board thickness (mm), corner radius (mm), solder-mask colour — for the 3D view and fab notes */
  thickness?: number
  radius?: number
  mask?: MaskColor
}
export interface Label { x: number; y: number; rot: 0 | 90 }
export type MaskColor = "green" | "black" | "blue" | "red" | "white" | "purple"

/** Silkscreen reference text: 1 mm cap height, stroke font advance 5.5/6 of the height. */
export const LABEL_H = 1.0
export const labelSize = (ref: string) => ({ w: ref.length * LABEL_H * (5.5 / 6) - LABEL_H * (1.5 / 6), h: LABEL_H })
/** Box [x0, y0, x1, y1] covered by a label. */
export function labelBox(ref: string, l: Label): [number, number, number, number] {
  const { w, h } = labelSize(ref)
  return l.rot === 90 ? [l.x, l.y, l.x + h, l.y + w] : [l.x, l.y, l.x + w, l.y + h]
}

export const defaultBoard = (): Board => ({
  width: 50, height: 30, place: {}, tracks: [], vias: [], exclude: [],
  rules: { default: { width: 0.25, clearance: 0.2 }, power: { width: 0.5, clearance: 0.25, nets: [] } },
})

/** Net name as the board shows it (ground is GND). */
export const netName = (n: string | undefined) => (n === undefined ? "" : n === "0" ? "GND" : n)

export interface BoardPad extends Pad { ref: string; net: string; /** absolute centre, mm */ ax: number; ay: number; aw: number; ah: number; layers: Layer[] }
export interface BoardPart { ref: string; part: Part; fp: Footprint; at: Placement; pads: BoardPad[]; court: [number, number, number, number]; label: Label }

const rotPt = ([x, y]: Pt, rot: number): Pt => (rot === 90 ? [-y, x] : rot === 180 ? [-x, -y] : rot === 270 ? [y, -x] : [x, y])
export const placePt = (p: Pt, at: Placement): Pt => { const r = rotPt(p, at.rot); return [r[0] + at.x, r[1] + at.y] }

/** One entry per reference (multi-unit parts share a package). */
export function boardParts(doc: Doc, nl: Netlist, board: Board): BoardPart[] {
  const seen = new Set<string>()
  const out: BoardPart[] = []
  for (const part of doc.parts) {
    if (isVirtual(part) || part.lib.startsWith("power:") || seen.has(part.ref) || board.exclude.includes(part.ref)) continue
    seen.add(part.ref)
    const fp = footprintFor(part)
    const at = board.place[part.ref] ?? { x: 0, y: 0, rot: 0 }
    const pads: BoardPad[] = fp.pads.map((p) => {
      const [ax, ay] = placePt([p.x, p.y], at)
      const swap = at.rot === 90 || at.rot === 270
      return { ...p, ref: part.ref, net: netName(nl.pinNet.get(`${part.ref}.${p.n}`)), ax, ay, aw: swap ? p.h : p.w, ah: swap ? p.w : p.h, layers: p.drill ? ["F", "B"] : ["F"] }
    })
    const c = fp.court
    const corners = [placePt([c[0], c[1]], at), placePt([c[2], c[3]], at)]
    const court: BoardPart["court"] = [Math.min(corners[0][0], corners[1][0]), Math.min(corners[0][1], corners[1][1]), Math.max(corners[0][0], corners[1][0]), Math.max(corners[0][1], corners[1][1])]
    // reference: where Auto label / the user put it, else above the part (below when the edge leaves no room)
    const label: Label = board.labels?.[part.ref] ?? (court[1] - 0.2 - LABEL_H >= 0.3 ? { x: court[0] + 0.3, y: court[1] - 0.2 - LABEL_H, rot: 0 } : { x: court[0] + 0.3, y: court[3] + 0.2, rot: 0 })
    out.push({ ref: part.ref, part, fp, at, pads, court, label })
  }
  return out
}

// ---------------------------------------------------------------- auto-placement

/** Shelf-pack every unplaced footprint inside the board (keeps existing placements). */
export function autoPlace(doc: Doc, nl: Netlist, board: Board, all = false): Board {
  const place = all ? {} : { ...board.place }
  const parts = boardParts(doc, nl, { ...board, place: {} })
  const todo = parts.filter((p) => all || !place[p.ref])
  // biggest first; parts sharing nets end up near each other because of the stable order by connectivity
  todo.sort((a, b) => (b.court[2] - b.court[0]) * (b.court[3] - b.court[1]) - (a.court[2] - a.court[0]) * (a.court[3] - a.court[1]))
  const gap = 2.0
  const taken: [number, number, number, number][] = boardParts(doc, nl, { ...board, place }).filter((p) => place[p.ref]).map((p) => p.court)
  const fits = (r: [number, number, number, number]) => r[0] >= 1 && r[1] >= 1 && r[2] <= board.width - 1 && r[3] <= board.height - 1 && !taken.some((t) => r[0] < t[2] + gap && r[2] + gap > t[0] && r[1] < t[3] + gap && r[3] + gap > t[1])
  let grow = board
  for (const p of todo) {
    const w = p.court[2] - p.court[0], h = p.court[3] - p.court[1]
    let done = false
    for (let y = 1.5; y + h <= grow.height - 1 && !done; y += 0.635) {
      for (let x = 1.5; x + w <= grow.width - 1 && !done; x += 0.635) {
        const r: [number, number, number, number] = [x, y, x + w, y + h]
        if (fits(r)) {
          // footprint origin so that its courtyard lands on r
          place[p.ref] = { x: snap(x - p.court[0]), y: snap(y - p.court[1]), rot: 0 }
          taken.push(r); done = true
        }
      }
    }
    if (!done) {
      // no room: make the board taller and put it at the bottom
      const y = grow.height
      place[p.ref] = { x: snap(1.5 - p.court[0]), y: snap(y - p.court[1]), rot: 0 }
      taken.push([1.5, y, 1.5 + w, y + h])
      grow = { ...grow, height: Math.ceil(y + h + 2) }
    }
  }
  return { ...grow, place }
}

export const snap = (v: number, g = 0.635) => Math.round(v / g) * g

// ---------------------------------------------------------------- connectivity & ratsnest

const segDist = (p: Pt, a: Pt, b: Pt) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy
  const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}
/** Distance between two segments (0 when they cross). */
export function segSeg(a: Pt, b: Pt, c: Pt, d: Pt): number {
  const cross = (o: Pt, p: Pt, q: Pt) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0])
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d)
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0
  return Math.min(segDist(a, c, d), segDist(b, c, d), segDist(c, a, b), segDist(d, a, b))
}
/** Distance from a pad's edge (rectangle approximation; circles exact) to a segment. */
function padSegDist(p: BoardPad, a: Pt, b: Pt): number {
  if (p.shape === "circle") return segDist([p.ax, p.ay], a, b) - p.aw / 2
  // sample the segment against the rectangle (exact enough for DRC on a 0.05 mm scale)
  const n = Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.05))
  let best = Infinity
  for (let i = 0; i <= n; i++) {
    const t = i / n, x = a[0] + t * (b[0] - a[0]), y = a[1] + t * (b[1] - a[1])
    const dx = Math.max(Math.abs(x - p.ax) - p.aw / 2, 0), dy = Math.max(Math.abs(y - p.ay) - p.ah / 2, 0)
    best = Math.min(best, Math.hypot(dx, dy))
  }
  return best
}

export interface Items { pads: BoardPad[]; tracks: Track[]; vias: Via[] }

/** Union-find over pads, tracks and vias that touch on a shared layer. */
export function connectivity(items: Items): { find: (k: string) => string; key: { pad: (p: BoardPad) => string; track: (t: Track) => string; via: (v: Via) => string } } {
  const parent = new Map<string, string>()
  const find = (k: string): string => { let r = k; while (parent.get(r) && parent.get(r) !== r) r = parent.get(r)!; parent.set(k, r); return r }
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb) }
  const key = { pad: (p: BoardPad) => `p:${p.ref}.${p.n}`, track: (t: Track) => `t:${t.id}`, via: (v: Via) => `v:${v.id}` }
  for (const p of items.pads) parent.set(key.pad(p), key.pad(p))
  for (const t of items.tracks) parent.set(key.track(t), key.track(t))
  for (const v of items.vias) parent.set(key.via(v), key.via(v))
  const touchesPad = (p: BoardPad, x: number, y: number, r: number) => (p.shape === "circle" ? Math.hypot(x - p.ax, y - p.ay) <= p.aw / 2 + r : Math.abs(x - p.ax) <= p.aw / 2 + r && Math.abs(y - p.ay) <= p.ah / 2 + r)
  for (const t of items.tracks) {
    for (const p of items.pads) if (p.layers.includes(t.layer) && (touchesPad(p, t.a[0], t.a[1], 0.01) || touchesPad(p, t.b[0], t.b[1], 0.01))) union(key.track(t), key.pad(p))
    for (const v of items.vias) if (Math.hypot(t.a[0] - v.x, t.a[1] - v.y) <= v.dia / 2 || Math.hypot(t.b[0] - v.x, t.b[1] - v.y) <= v.dia / 2) union(key.track(t), key.via(v))
    for (const u of items.tracks) if (u !== t && u.layer === t.layer && segSeg(t.a, t.b, u.a, u.b) <= (t.width + u.width) / 4) union(key.track(t), key.track(u))
  }
  // a via joins any pad it sits in (through-hole, or via-in-pad on an SMD pad)
  for (const v of items.vias) for (const p of items.pads) if (touchesPad(p, v.x, v.y, 0)) union(key.via(v), key.pad(p))
  return { find, key }
}

export interface Rat { net: string; a: BoardPad; b: BoardPad; len: number }

/** Unrouted connections: per net, a minimum spanning tree between copper islands. */
export function ratsnest(parts: BoardPart[], board: Board): Rat[] {
  const pads = parts.flatMap((p) => p.pads).filter((p) => p.net)
  const { find, key } = connectivity({ pads, tracks: board.tracks, vias: board.vias })
  const byNet = new Map<string, BoardPad[]>()
  for (const p of pads) byNet.set(p.net, [...(byNet.get(p.net) ?? []), p])
  const rats: Rat[] = []
  for (const [net, list] of byNet) {
    if (list.length < 2) continue
    // islands of this net
    const islands = new Map<string, BoardPad[]>()
    for (const p of list) { const r = find(key.pad(p)); islands.set(r, [...(islands.get(r) ?? []), p]) }
    const groups = [...islands.values()]
    if (groups.length < 2) continue
    // Prim over islands, edge = closest pad pair
    const inTree = [groups[0]]
    const rest = groups.slice(1)
    while (rest.length) {
      let best: Rat | null = null, bi = -1
      for (let i = 0; i < rest.length; i++) for (const a of inTree.flat()) for (const b of rest[i]) {
        const len = Math.hypot(a.ax - b.ax, a.ay - b.ay)
        if (!best || len < best.len) { best = { net, a, b, len }; bi = i }
      }
      rats.push(best!)
      inTree.push(rest.splice(bi, 1)[0])
    }
  }
  return rats.sort((a, b) => a.len - b.len)
}

// ---------------------------------------------------------------- DRC

export interface DrcItem { kind: "unrouted" | "clearance" | "short" | "edge" | "silk" | "overlap"; severity: "error" | "warning"; title: string; detail: string; at: Pt; refs?: string[] }

export const netClass = (board: Board, net: string): NetClass => (board.rules.power.nets.includes(net) ? board.rules.power : board.rules.default)

/** Ground, supply-like and power-symbol nets get the power class by default. */
export function powerNets(doc: Doc, nl: Netlist): string[] {
  const out = new Set<string>()
  for (const p of doc.parts) if (p.lib.startsWith("power:")) { const n = nl.pinNet.get(`${p.ref}.1`); if (n) out.add(netName(n)) }
  for (const n of nl.nets) if (/^(gnd|vcc|vdd|vee|vss|v\+|v-|\+?\d+v\d*)$/i.test(netName(n))) out.add(netName(n))
  out.add("GND")
  return [...out]
}

export function drc(parts: BoardPart[], board: Board): DrcItem[] {
  const items: DrcItem[] = []
  const pads = parts.flatMap((p) => p.pads)
  for (const r of ratsnest(parts, board)) items.push({ kind: "unrouted", severity: "error", title: `Unrouted: ${r.net}`, detail: `${r.a.ref}.${r.a.n} ↔ ${r.b.ref}.${r.b.n} · ${r.len.toFixed(1)} mm`, at: [(r.a.ax + r.b.ax) / 2, (r.a.ay + r.b.ay) / 2], refs: [r.a.ref, r.b.ref] })
  // tracks: clearance to other nets' pads / tracks / vias, board edge
  for (const t of board.tracks) {
    const cl = netClass(board, t.net).clearance
    for (const p of pads) {
      if (!p.layers.includes(t.layer) || p.net === t.net) continue
      const d = padSegDist(p, t.a, t.b) - t.width / 2
      if (d < cl) items.push({ kind: d <= 0 ? "short" : "clearance", severity: "error", title: d <= 0 ? `Short: ${t.net} ↔ ${p.net || "no net"}` : "Clearance", detail: `${t.net} track to ${p.ref}.${p.n} (${p.net || "no net"}): ${Math.max(0, d).toFixed(2)} mm < ${cl} mm`, at: [p.ax, p.ay], refs: [p.ref] })
    }
    for (const u of board.tracks) {
      if (u.id <= t.id || u.layer !== t.layer || u.net === t.net) continue
      const d = segSeg(t.a, t.b, u.a, u.b) - (t.width + u.width) / 2
      if (d < Math.max(cl, netClass(board, u.net).clearance)) items.push({ kind: d <= 0 ? "short" : "clearance", severity: "error", title: d <= 0 ? `Short: ${t.net} ↔ ${u.net}` : "Clearance", detail: `${t.net} and ${u.net} tracks ${Math.max(0, d).toFixed(2)} mm apart`, at: [(t.a[0] + t.b[0]) / 2, (t.a[1] + t.b[1]) / 2] })
    }
    for (const v of board.vias) {
      if (v.net === t.net) continue
      const d = segDist([v.x, v.y], t.a, t.b) - t.width / 2 - v.dia / 2
      if (d < cl) items.push({ kind: d <= 0 ? "short" : "clearance", severity: "error", title: d <= 0 ? "Short to via" : "Clearance to via", detail: `${t.net} track to ${v.net} via: ${Math.max(0, d).toFixed(2)} mm`, at: [v.x, v.y] })
    }
    for (const q of [t.a, t.b]) if (q[0] < 0.3 || q[1] < 0.3 || q[0] > board.width - 0.3 || q[1] > board.height - 0.3) { items.push({ kind: "edge", severity: "error", title: "Track at the board edge", detail: `${t.net} track ends ${q[0].toFixed(1)}, ${q[1].toFixed(1)} mm`, at: q }); break }
  }
  // footprints: outside the board, overlapping courtyards, silk reference over a pad
  for (const bp of parts) {
    const [x0, y0, x1, y1] = bp.court
    if (x0 < 0 || y0 < 0 || x1 > board.width || y1 > board.height) items.push({ kind: "edge", severity: "error", title: `${bp.ref} is off the board`, detail: "Move it inside the outline or make the board bigger", at: [(x0 + x1) / 2, (y0 + y1) / 2], refs: [bp.ref] })
    for (const o of parts) {
      if (o.ref <= bp.ref) continue
      const c = o.court
      if (x0 < c[2] && x1 > c[0] && y0 < c[3] && y1 > c[1]) items.push({ kind: "overlap", severity: "warning", title: "Courtyards overlap", detail: `${bp.ref} and ${o.ref}`, at: [(Math.max(x0, c[0]) + Math.min(x1, c[2])) / 2, (Math.max(y0, c[1]) + Math.min(y1, c[3])) / 2], refs: [bp.ref, o.ref] })
    }
    const lb = labelBox(bp.ref, bp.label)
    const lc: Pt = [(lb[0] + lb[2]) / 2, (lb[1] + lb[3]) / 2]
    for (const p of pads) {
      if (lb[0] < p.ax + p.aw / 2 && lb[2] > p.ax - p.aw / 2 && lb[1] < p.ay + p.ah / 2 && lb[3] > p.ay - p.ah / 2) {
        items.push({ kind: "silk", severity: "warning", title: "Silk over pad", detail: `${bp.ref} reference overlaps ${p.ref} pad ${p.n}`, at: lc, refs: [bp.ref] })
        break
      }
    }
    for (const o of parts) {
      if (o.ref <= bp.ref) continue
      const ob = labelBox(o.ref, o.label)
      if (lb[0] < ob[2] && lb[2] > ob[0] && lb[1] < ob[3] && lb[3] > ob[1]) items.push({ kind: "silk", severity: "warning", title: "Labels overlap", detail: `${bp.ref} and ${o.ref} references`, at: lc, refs: [bp.ref, o.ref] })
    }
    if (lb[0] < 0 || lb[1] < 0 || lb[2] > board.width || lb[3] > board.height) items.push({ kind: "silk", severity: "warning", title: "Label off the board", detail: `${bp.ref} reference is outside the outline`, at: lc, refs: [bp.ref] })
  }
  // vias of different nets too close
  for (const v of board.vias) for (const w of board.vias) {
    if (w.id <= v.id || w.net === v.net) continue
    const d = Math.hypot(v.x - w.x, v.y - w.y) - (v.dia + w.dia) / 2
    if (d < board.rules.default.clearance) items.push({ kind: d <= 0 ? "short" : "clearance", severity: "error", title: "Via clearance", detail: `${v.net} and ${w.net} vias ${Math.max(0, d).toFixed(2)} mm apart`, at: [v.x, v.y] })
  }
  return items
}

/** Keep the board in step with the schematic: place new parts, drop placements of removed ones. */
export function syncBoard(doc: Doc, nl: Netlist, board: Board | undefined): Board {
  let b = board ?? defaultBoard()
  const refs = new Set(doc.parts.filter((p) => !isVirtual(p) && !p.lib.startsWith("power:")).map((p) => p.ref))
  const place = Object.fromEntries(Object.entries(b.place).filter(([r]) => refs.has(r)))
  b = { ...b, place }
  // a new board gets the spread-out, connection-aware layout; parts added later are packed into free space
  if (!Object.keys(place).length) b = smartPlace(doc, nl, b)
  else if ([...refs].some((r) => !place[r] && !b.exclude.includes(r))) b = autoPlace(doc, nl, b)
  if (!board) b = { ...b, rules: { ...b.rules, power: { ...b.rules.power, nets: powerNets(doc, nl) } } }
  return b
}

// ---------------------------------------------------------------- board size

export const BOARD_PRESETS: { label: string; w: number; h: number }[] = [
  { label: "50 × 30 mm", w: 50, h: 30 }, { label: "50 × 50 mm", w: 50, h: 50 }, { label: "80 × 60 mm", w: 80, h: 60 },
  { label: "100 × 80 mm", w: 100, h: 80 }, { label: "100 × 100 mm (fab 10 cm limit)", w: 100, h: 100 },
  { label: "100 × 160 mm (Eurocard)", w: 100, h: 160 }, { label: "68.6 × 53.3 mm (Arduino shield)", w: 68.58, h: 53.34 },
  { label: "65 × 30 mm (Raspberry Pi Zero)", w: 65, h: 30 },
]

/** Extent of everything on the board (courtyards, labels, tracks, vias). */
export function contentBox(parts: BoardPart[], board: Board): [number, number, number, number] | null {
  const xs: number[] = [], ys: number[] = []
  for (const p of parts) {
    xs.push(p.court[0], p.court[2]); ys.push(p.court[1], p.court[3])
    const l = labelBox(p.ref, p.label); xs.push(l[0], l[2]); ys.push(l[1], l[3])
  }
  for (const t of board.tracks) { xs.push(t.a[0], t.b[0]); ys.push(t.a[1], t.b[1]) }
  for (const v of board.vias) { xs.push(v.x - v.dia / 2, v.x + v.dia / 2); ys.push(v.y - v.dia / 2, v.y + v.dia / 2) }
  return xs.length ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] : null
}

/** Move everything on the board (parts, labels, tracks, vias) by dx, dy mm. */
export function translateBoard(board: Board, dx: number, dy: number): Board {
  if (!dx && !dy) return board
  const r = (v: number) => Math.round(v * 1000) / 1000
  const mv = (p: Pt): Pt => [r(p[0] + dx), r(p[1] + dy)]
  return {
    ...board,
    place: Object.fromEntries(Object.entries(board.place).map(([k, a]) => [k, { ...a, x: r(a.x + dx), y: r(a.y + dy) }])),
    labels: board.labels && Object.fromEntries(Object.entries(board.labels).map(([k, l]) => [k, { ...l, x: r(l.x + dx), y: r(l.y + dy) }])),
    tracks: board.tracks.map((t) => ({ ...t, a: mv(t.a), b: mv(t.b) })),
    vias: board.vias.map((v) => ({ ...v, x: r(v.x + dx), y: r(v.y + dy) })),
  }
}

/**
 * Drag one or two edges of the outline: left / top edges move the origin, so the content
 * is shifted to stay put on the board. Edges snap to 0.5 mm; the board stays ≥ 5 mm.
 */
export function resizeBoard(board: Board, edges: string, dx: number, dy: number): Board & { shift: Pt } {
  const half = (v: number) => Math.round(v * 2) / 2
  let l = 0, t = 0, w = board.width, h = board.height
  if (edges.includes("l")) { l = Math.min(half(dx), w - 5); w -= l }
  if (edges.includes("r")) w = Math.max(5, half(board.width + dx))
  if (edges.includes("t")) { t = Math.min(half(dy), h - 5); h -= t }
  if (edges.includes("b")) h = Math.max(5, half(board.height + dy))
  return { ...translateBoard(board, -l, -t), width: w, height: h, shift: [l, t] }
}

/** Shrink (or grow) the outline to the content plus a margin; everything moves with it. */
export function fitBoard(parts: BoardPart[], board: Board, margin = 2): Board {
  const box = contentBox(parts, board)
  if (!box) return board
  // shift on the 0.635 mm placement grid so parts stay on-grid
  const dx = snap(margin - box[0]), dy = snap(margin - box[1])
  const mv = (p: Pt): Pt => [Math.round((p[0] + dx) * 1000) / 1000, Math.round((p[1] + dy) * 1000) / 1000]
  const up = (v: number) => Math.ceil(v * 2) / 2
  return {
    ...board,
    width: up(box[2] + dx + margin), height: up(box[3] + dy + margin),
    place: Object.fromEntries(Object.entries(board.place).map(([r, a]) => [r, { ...a, x: a.x + dx, y: a.y + dy }])),
    labels: board.labels && Object.fromEntries(Object.entries(board.labels).map(([r, l]) => [r, { ...l, x: l.x + dx, y: l.y + dy }])),
    tracks: board.tracks.map((t) => ({ ...t, a: mv(t.a), b: mv(t.b) })),
    vias: board.vias.map((v) => ({ ...v, x: v.x + dx, y: v.y + dy })),
  }
}

// ---------------------------------------------------------------- smart placement

/**
 * Spread the parts over the board and pull connected parts together: start on a grid,
 * then iterate springs along nets (pad to the centroid of its net) and push courtyards
 * apart; finally snap to the 0.635 mm grid and nudge any remaining overlaps away.
 */
export function smartPlace(doc: Doc, nl: Netlist, board: Board, gap = 1.5): Board {
  const base = boardParts(doc, nl, { ...board, place: {} })
  const n = base.length
  if (!n) return board
  const size = base.map((p) => [p.court[2] - p.court[0], p.court[3] - p.court[1]] as const)
  // most-connected part first, then breadth-first over shared nets: neighbours start near each other
  const netsOf = base.map((p) => new Set(p.pads.map((q) => q.net).filter(Boolean)))
  const order: number[] = []
  const seen = new Set<number>()
  const start = base.map((_, i) => i).sort((a, b) => netsOf[b].size - netsOf[a].size || base[b].pads.length - base[a].pads.length)
  for (const s0 of start) {
    if (seen.has(s0)) continue
    const q = [s0]; seen.add(s0)
    while (q.length) {
      const i = q.shift()!; order.push(i)
      for (let j = 0; j < n; j++) if (!seen.has(j) && [...netsOf[i]].some((x) => netsOf[j].has(x) && x !== "GND")) { seen.add(j); q.push(j) }
    }
  }
  const cols = Math.max(1, Math.round(Math.sqrt(n * board.width / board.height)))
  const rows = Math.ceil(n / cols)
  // centre positions (of each courtyard)
  const pos = new Array<[number, number]>(n)
  order.forEach((i, k) => { const c = k % cols, r = Math.floor(k / cols); pos[i] = [((c + 0.5) * board.width) / cols, ((r + 0.5) * board.height) / rows] })
  // pad offsets from each courtyard centre
  const off = base.map((p) => { const cx = (p.court[0] + p.court[2]) / 2, cy = (p.court[1] + p.court[3]) / 2; return p.pads.map((q) => [q.ax - cx, q.ay - cy, q.net] as const) })
  const clamp = (i: number) => {
    const [w, h] = size[i]
    pos[i][0] = Math.min(Math.max(pos[i][0], w / 2 + 1), board.width - w / 2 - 1)
    pos[i][1] = Math.min(Math.max(pos[i][1], h / 2 + 1), board.height - h / 2 - 1)
  }
  for (let it = 0; it < 220; it++) {
    const cool = 1 - it / 220
    // net centroids
    const sum = new Map<string, [number, number, number]>()
    for (let i = 0; i < n; i++) for (const [dx, dy, net] of off[i]) {
      if (!net || net === "GND") continue // ground usually becomes a pour / long bus: don't let it clump everything
      const e = sum.get(net) ?? [0, 0, 0]; e[0] += pos[i][0] + dx; e[1] += pos[i][1] + dy; e[2]++; sum.set(net, e)
    }
    const force = pos.map(() => [0, 0])
    for (let i = 0; i < n; i++) for (const [dx, dy, net] of off[i]) {
      const e = net ? sum.get(net) : undefined
      if (!e || e[2] < 2) continue
      force[i][0] += (e[0] / e[2] - (pos[i][0] + dx)) * 0.08
      force[i][1] += (e[1] / e[2] - (pos[i][1] + dy)) * 0.08
    }
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const ox = (size[i][0] + size[j][0]) / 2 + gap - Math.abs(pos[i][0] - pos[j][0])
      const oy = (size[i][1] + size[j][1]) / 2 + gap - Math.abs(pos[i][1] - pos[j][1])
      if (ox > 0 && oy > 0) {
        // push apart along the axis of least overlap
        if (ox < oy) { const s = Math.sign(pos[i][0] - pos[j][0]) || 1; force[i][0] += s * ox * 0.5; force[j][0] -= s * ox * 0.5 }
        else { const s = Math.sign(pos[i][1] - pos[j][1]) || 1; force[i][1] += s * oy * 0.5; force[j][1] -= s * oy * 0.5 }
      }
    }
    for (let i = 0; i < n; i++) { pos[i][0] += force[i][0] * (0.3 + cool); pos[i][1] += force[i][1] * (0.3 + cool); clamp(i) }
  }
  // snap and settle: footprint origin from courtyard centre
  const place: Record<string, Placement> = {}
  const taken: [number, number, number, number][] = []
  for (const i of order) {
    const p = base[i]
    const cx = (p.court[0] + p.court[2]) / 2, cy = (p.court[1] + p.court[3]) / 2
    let x = snap(pos[i][0] - cx), y = snap(pos[i][1] - cy)
    const box = () => [x + p.court[0], y + p.court[1], x + p.court[2], y + p.court[3]] as [number, number, number, number]
    const bad = (r: [number, number, number, number]) => r[0] < 1 || r[1] < 1 || r[2] > board.width - 1 || r[3] > board.height - 1 || taken.some((t) => r[0] < t[2] + gap && r[2] + gap > t[0] && r[1] < t[3] + gap && r[3] + gap > t[1])
    // spiral search for the nearest free spot
    let found = !bad(box())
    for (let ring = 1; ring < 80 && !found; ring++) {
      for (let a = 0; a < ring * 8 && !found; a++) {
        const ang = (a / (ring * 8)) * 2 * Math.PI
        const nx = snap(pos[i][0] - cx + Math.cos(ang) * ring * 0.635), ny = snap(pos[i][1] - cy + Math.sin(ang) * ring * 0.635)
        const r: [number, number, number, number] = [nx + p.court[0], ny + p.court[1], nx + p.court[2], ny + p.court[3]]
        if (!bad(r)) { x = nx; y = ny; found = true }
      }
    }
    if (!found) return autoPlace(doc, nl, { ...board, place: {} }, true) // board too small for a spread layout
    place[p.ref] = { x, y, rot: 0 }
    taken.push(box())
  }
  return { ...board, place }
}
