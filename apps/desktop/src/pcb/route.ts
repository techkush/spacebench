// Auto-router: A* on a grid (0.25 mm default) over one or both copper layers. Copper of
// other nets is inflated by clearance + half the track width; vias and bends cost extra;
// 45° moves allowed. Failed connections trigger rip-up and retry with them routed first.
// Good enough for small analog boards; anything it can't route stays in the ratsnest.
import { boardParts, netClass, ratsnest, type Board, type BoardPad, type Layer, type Pt, type Rat, type Track, type Via } from "./board"
import type { Doc } from "@/editor/model"
import type { Netlist } from "@/editor/netlist"

export interface RouteOptions {
  /** routing grid, mm */
  grid: number
  layers: "both" | "top" | "bottom"
  /** cost of a via in grid steps (higher = fewer vias, longer tracks) */
  viaCost: number
  /** cost of a change of direction */
  bendCost: number
  /** only route these nets (null = all) */
  nets: string[] | null
  /** remove the existing tracks of the nets being routed first */
  clearFirst: boolean
  /** rip-up-and-retry attempts when connections fail */
  attempts: number
  order: "short" | "long" | "power"
}
export const DEFAULT_ROUTE: RouteOptions = { grid: 0.25, layers: "both", viaCost: 18, bendCost: 0.6, nets: null, clearFirst: false, attempts: 3, order: "short" }

const VIA = { dia: 0.8, drill: 0.4 }
const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]

let seq = 0
const id = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`

class Heap {
  private a: [number, number][] = []
  get size() { return this.a.length }
  push(k: number, f: number) {
    const a = this.a; a.push([k, f]); let i = a.length - 1
    while (i > 0) { const p = (i - 1) >> 1; if (a[p][1] <= a[i][1]) break; [a[p], a[i]] = [a[i], a[p]]; i = p }
  }
  pop(): number {
    const a = this.a, top = a[0][0], last = a.pop()!
    if (a.length) {
      a[0] = last; let i = 0
      for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l][1] < a[m][1]) m = l; if (r < a.length && a[r][1] < a[m][1]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m }
    }
    return top
  }
}

export interface RouteResult { board: Board; routed: number; failed: Rat[]; attempts: number }

/** Route the ratsnest; on failures, rip up this run's tracks and retry with the failed nets first. */
export function autoRoute(doc: Doc, nl: Netlist, board0: Board, options: Partial<RouteOptions> = {}): RouteResult {
  const o: RouteOptions = { ...DEFAULT_ROUTE, ...options }
  const start = o.clearFirst ? { ...board0, tracks: board0.tracks.filter((t) => o.nets && !o.nets.includes(t.net)), vias: board0.vias.filter((v) => o.nets && !o.nets.includes(v.net)) } : board0
  let best: RouteResult | null = null
  let first: string[] = []
  for (let k = 0; k < Math.max(1, o.attempts); k++) {
    const r = routeOnce(doc, nl, start, o, first)
    if (!best || r.failed.length < best.failed.length) best = { ...r, attempts: k + 1 }
    if (!r.failed.length) break
    // next attempt: the nets that failed go first
    first = [...new Set([...r.failed.map((f) => f.net), ...first])]
  }
  return best!
}

function routeOnce(doc: Doc, nl: Netlist, board0: Board, o: RouteOptions, first: string[]): Omit<RouteResult, "attempts"> {
  const G = o.grid
  let board = board0
  const W = Math.ceil(board.width / G) + 1, H = Math.ceil(board.height / G) + 1
  const N = W * H
  const parts = boardParts(doc, nl, board)
  const allPads = parts.flatMap((p) => p.pads)
  const cell = (x: number, y: number) => [Math.round(x / G), Math.round(y / G)] as const
  const failed: Rat[] = []
  let routed = 0

  /** Mark cells within r of a pad / segment / via of another net. */
  const build = (net: string, r: number) => {
    const block: [Uint8Array, Uint8Array] = [new Uint8Array(N), new Uint8Array(N)]
    const mark = (layer: 0 | 1, x0: number, y0: number, x1: number, y1: number, inside: (x: number, y: number) => boolean) => {
      const i0 = Math.max(0, Math.floor(x0 / G)), i1 = Math.min(W - 1, Math.ceil(x1 / G)), j0 = Math.max(0, Math.floor(y0 / G)), j1 = Math.min(H - 1, Math.ceil(y1 / G))
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (inside(i * G, j * G)) block[layer][j * W + i] = 1
    }
    // a layer the options exclude is fully blocked
    if (o.layers === "top") block[1].fill(1)
    if (o.layers === "bottom") block[0].fill(1)
    // board edge
    const edge = r + 0.2
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const x = i * G, y = j * G
      if (x < edge || y < edge || x > board.width - edge || y > board.height - edge) { block[0][j * W + i] = 1; block[1][j * W + i] = 1 }
    }
    for (const p of allPads) {
      if (p.net === net && net) continue
      const rx = p.aw / 2 + r, ry = p.ah / 2 + r
      for (const L of p.layers) mark(L === "F" ? 0 : 1, p.ax - rx, p.ay - ry, p.ax + rx, p.ay + ry, (x, y) =>
        p.shape === "circle" ? Math.hypot(x - p.ax, y - p.ay) <= p.aw / 2 + r : Math.hypot(Math.max(Math.abs(x - p.ax) - p.aw / 2, 0), Math.max(Math.abs(y - p.ay) - p.ah / 2, 0)) <= r)
    }
    for (const t of board.tracks) {
      if (t.net === net) continue
      const rr = r + t.width / 2
      const sd = (x: number, y: number) => {
        const dx = t.b[0] - t.a[0], dy = t.b[1] - t.a[1], L2 = dx * dx + dy * dy
        const u = L2 ? Math.max(0, Math.min(1, ((x - t.a[0]) * dx + (y - t.a[1]) * dy) / L2)) : 0
        return Math.hypot(x - t.a[0] - u * dx, y - t.a[1] - u * dy)
      }
      mark(t.layer === "F" ? 0 : 1, Math.min(t.a[0], t.b[0]) - rr, Math.min(t.a[1], t.b[1]) - rr, Math.max(t.a[0], t.b[0]) + rr, Math.max(t.a[1], t.b[1]) + rr, (x, y) => sd(x, y) <= rr)
    }
    for (const v of board.vias) {
      if (v.net === net) continue
      const rr = r + v.dia / 2
      for (const L of [0, 1] as const) mark(L, v.x - rr, v.y - rr, v.x + rr, v.y + rr, (x, y) => Math.hypot(x - v.x, y - v.y) <= rr)
    }
    return block
  }

  const padCells = (p: BoardPad) => {
    const out: number[] = []
    const [i0, j0] = cell(p.ax - p.aw / 2, p.ay - p.ah / 2), [i1, j1] = cell(p.ax + p.aw / 2, p.ay + p.ah / 2)
    for (let j = Math.max(0, j0); j <= Math.min(H - 1, j1); j++) for (let i = Math.max(0, i0); i <= Math.min(W - 1, i1); i++) {
      const x = i * G, y = j * G
      if (p.shape === "circle" ? Math.hypot(x - p.ax, y - p.ay) <= p.aw / 2 : Math.abs(x - p.ax) <= p.aw / 2 && Math.abs(y - p.ay) <= p.ah / 2) out.push(j * W + i)
    }
    if (!out.length) { const [i, j] = cell(p.ax, p.ay); out.push(j * W + i) }
    return out
  }

  // route until nothing new can be routed (each pass recomputes the ratsnest)
  for (let pass = 0; pass < 3; pass++) {
    let rats = ratsnest(boardParts(doc, nl, board), board).filter((r) => !o.nets || o.nets.includes(r.net))
    const power = board.rules.power.nets
    rats.sort((a, b) => (o.order === "long" ? b.len - a.len : o.order === "power" ? Number(power.includes(b.net)) - Number(power.includes(a.net)) || a.len - b.len : a.len - b.len))
    if (first.length) rats = [...rats.filter((r) => first.includes(r.net)), ...rats.filter((r) => !first.includes(r.net))]
    if (!rats.length) break
    let progress = false
    failed.length = 0
    for (const rat of rats) {
      const cls = netClass(board, rat.net)
      // + half a cell: obstacles are tested at grid points, segments run between them
      const block = build(rat.net, cls.clearance + cls.width / 2 + G / 2)
      const viaBlock = build(rat.net, cls.clearance + VIA.dia / 2 + G / 2)
      const path = astar(rat.a, rat.b, block, viaBlock)
      if (!path) { failed.push(rat); continue }
      const { tracks, vias } = toCopper(path, rat, cls.width)
      board = { ...board, tracks: [...board.tracks, ...tracks], vias: [...board.vias, ...vias] }
      routed++; progress = true
    }
    if (!progress) break
  }
  return { board, routed, failed }

  function astar(a: BoardPad, b: BoardPad, block: [Uint8Array, Uint8Array], viaBlock: [Uint8Array, Uint8Array]): { i: number; j: number; L: 0 | 1 }[] | null {
    const startCells = padCells(a), goal = new Set(padCells(b))
    const allowed = (l: Layer) => o.layers === "both" || (o.layers === "top" ? l === "F" : l === "B")
    const goalLayers = b.layers.filter(allowed).map((l) => (l === "F" ? 0 : 1))
    const [gi, gj] = cell(b.ax, b.ay)
    const g = new Float32Array(N * 2).fill(Infinity)
    const came = new Int32Array(N * 2).fill(-1)
    const dirOf = new Int8Array(N * 2).fill(-1)
    const heap = new Heap()
    const h = (k: number) => { const c = k % N, i = c % W, j = (c - i) / W; const dx = Math.abs(i - gi), dy = Math.abs(j - gj); return Math.max(dx, dy) + 0.414 * Math.min(dx, dy) }
    for (const L of a.layers.filter(allowed).map((l) => (l === "F" ? 0 : 1)) as (0 | 1)[]) for (const c of startCells) { const k = L * N + c; g[k] = 0; heap.push(k, h(k)) }
    let found = -1, iter = 0
    while (heap.size && iter++ < 400000) {
      const k = heap.pop()
      const L = k >= N ? 1 : 0, c = k - L * N, i = c % W, j = (c - i) / W
      if (goal.has(c) && goalLayers.includes(L)) { found = k; break }
      for (let d = 0; d < 8; d++) {
        const ni = i + DIRS[d][0], nj = j + DIRS[d][1]
        if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue
        const nc = nj * W + ni
        // stay off other copper unless the cell is inside the start / goal pad
        if (block[L][nc] && !goal.has(nc) && !startCells.includes(nc)) continue
        // diagonal moves must not cut a blocked corner
        if (d >= 4 && (block[L][j * W + ni] || block[L][nj * W + i])) continue
        const nk = L * N + nc
        const cost = g[k] + (d >= 4 ? 1.414 : 1) + (dirOf[k] >= 0 && dirOf[k] !== d ? o.bendCost : 0)
        if (cost < g[nk]) { g[nk] = cost; came[nk] = k; dirOf[nk] = d; heap.push(nk, cost + h(nk)) }
      }
      // via to the other layer — never inside the start / goal pad (no via-in-pad: through-hole pads
      // are already on both layers, and a via in an SMD pad wicks solder away)
      const OL = (1 - L) as 0 | 1, ok = OL * N + c
      if (o.layers === "both" && !viaBlock[0][c] && !viaBlock[1][c] && !block[OL][c] && !goal.has(c) && !startCells.includes(c)) {
        const cost = g[k] + o.viaCost
        if (cost < g[ok]) { g[ok] = cost; came[ok] = k; dirOf[ok] = -1; heap.push(ok, cost + h(ok)) }
      }
    }
    if (found < 0) return null
    const out: { i: number; j: number; L: 0 | 1 }[] = []
    for (let k = found; k >= 0; k = came[k]) { const L = (k >= N ? 1 : 0) as 0 | 1, c = k - L * N; out.push({ i: c % W, j: Math.floor(c / W), L }) }
    return out.reverse()
  }

  function toCopper(path: { i: number; j: number; L: 0 | 1 }[], rat: Rat, width: number): { tracks: Track[]; vias: Via[] } {
    const pts = path.map((p) => ({ x: p.i * G, y: p.j * G, L: p.L }))
    // start and end at the pad centres
    pts[0] = { ...pts[0], x: rat.a.ax, y: rat.a.ay }
    pts[pts.length - 1] = { ...pts[pts.length - 1], x: rat.b.ax, y: rat.b.ay }
    const tracks: Track[] = [], vias: Via[] = []
    // collapse straight runs into one segment per layer
    let s = 0
    const dir = (a: { x: number; y: number }, b: { x: number; y: number }) => [Math.sign(Math.round((b.x - a.x) / G)), Math.sign(Math.round((b.y - a.y) / G))].join()
    for (let k = 1; k < pts.length; k++) {
      const layerChange = pts[k].L !== pts[k - 1].L
      const end = k === pts.length - 1
      const turn = !layerChange && !end && k + 1 < pts.length && pts[k + 1].L === pts[k].L && dir(pts[k - 1], pts[k]) !== dir(pts[k], pts[k + 1])
      if (layerChange) {
        if (k - 1 > s) tracks.push(seg(pts[s], pts[k - 1]))
        vias.push({ id: id("v"), net: rat.net, x: pts[k].x, y: pts[k].y, ...VIA })
        s = k
      } else if (turn || end) {
        tracks.push(seg(pts[s], pts[k]))
        s = k
      }
    }
    return { tracks, vias }
    function seg(a: { x: number; y: number; L: 0 | 1 }, b: { x: number; y: number }): Track {
      const r = (v: number) => Math.round(v * 1000) / 1000
      return { id: id("t"), net: rat.net, layer: (a.L ? "B" : "F") as Layer, a: [r(a.x), r(a.y)] as Pt, b: [r(b.x), r(b.y)] as Pt, width }
    }
  }
}
