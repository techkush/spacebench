// Draw a circuit written in Kirk (or by the AI) as a real schematic: parts in signal-flow
// columns, supply and ground as power symbols at each pin, signal nets as orthogonal wires.
// Separate groups of parts (sections) are laid out side by side. A net that can't be routed
// cleanly is left alone — reconcile() then stubs it with net labels, so the result is always
// electrically right.
import { placedPins, unitOf, uid, type Part, type Pt, type Rot, type Wire } from "@/editor/model"
import type { IR, IRNet } from "./compile"

const ROTS: Rot[] = [0, 90, 180, 270]
const GAP_X = 8, GAP_Y = 5
const key = (p: Pt) => `${p[0]},${p[1]}`

interface Node {
  part: Part
  /** pin number → net */
  nets: Map<string, IRNet>
  w: number
  h: number
  layer: number
  section: number
  row: number
}

const isDcSource = (p: Part) => /^Simulation_SPICE:VDC$|^Device:Battery/.test(p.lib)

/** Box (grid units) of a part at its current position. */
function box(p: Part): [number, number, number, number] {
  const u = unitOf(p)
  if (!u) return [p.x - 2, p.y - 2, p.x + 2, p.y + 2]
  const [x, y, w, h] = u.box.map((v) => v / 12.7)
  const pts: Pt[] = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map(([a, b]) => {
    const r = ((p.rot % 360) + 360) % 360
    let [X, Y] = p.mirror ? [-a, b] : [a, b]
    if (r === 90) [X, Y] = [-Y, X]; else if (r === 180) [X, Y] = [-X, -Y]; else if (r === 270) [X, Y] = [Y, -X]
    return [X + p.x, Y + p.y]
  })
  return [Math.min(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1])), Math.max(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[1]))]
}

/** Direction a pin leaves its part (towards the wire). */
function outward(p: Part, pinA: number): Pt {
  const local: Pt = pinA === 0 ? [-1, 0] : pinA === 90 ? [0, 1] : pinA === 180 ? [1, 0] : [0, -1]
  let [x, y] = p.mirror ? [-local[0], local[1]] : local
  const r = ((p.rot % 360) + 360) % 360
  if (r === 90) [x, y] = [-y, x]; else if (r === 180) [x, y] = [-x, -y]; else if (r === 270) [x, y] = [y, -x]
  return [x, y]
}

export interface LayoutResult { wires: Wire[]; symbols: Part[]; sections: number; routed: number; unrouted: string[]; why: string[] }

/**
 * Place `parts` (positions and rotations are set in place) and wire them.
 * `power(name)` gives the power-symbol lib for a supply net (e.g. power:VCC).
 */
export function autoLayout(parts: Part[], ir: IR, power: { gnd: string; supply: (net: string) => string }): LayoutResult {
  // ---- nets and their roles
  const netOfPin = new Map<string, IRNet>()
  for (const n of ir.nets) for (const p of n.pins) netOfPin.set(`${p.ref}.${p.n}`, n)
  const nodes: Node[] = parts.map((part) => {
    const nets = new Map<string, IRNet>()
    for (const pin of placedPins({ ...part, x: 0, y: 0, rot: 0 })) { const n = netOfPin.get(`${part.ref}.${pin.n}`); if (n) nets.set(pin.n, n) }
    return { part, nets, w: 4, h: 4, layer: 0, section: 0, row: 0 }
  })
  const supply = new Set<IRNet>()
  for (const nd of nodes) {
    if (!isDcSource(nd.part)) continue
    const ns = [...nd.nets.values()]
    if (ns.length === 2 && ns.some((n) => n.ground)) for (const n of ns) if (!n.ground) supply.add(n)
  }
  // large circuits: a net reaching many pins (a regulated rail, a shared bus) is labelled at each pin
  // instead of wired, and doesn't join sections — so each block is drawn on its own
  const big = parts.length > 14
  const pinCount = (n: IRNet) => n.pins.length
  const labelled = (n: IRNet | undefined) => !!n && big && !n.ground && !supply.has(n) && pinCount(n) >= 5
  const rail = (n: IRNet | undefined) => !!n && (n.ground || supply.has(n) || labelled(n))
  const signalNets = (nd: Node) => [...new Set([...nd.nets.values()].filter((n) => !rail(n)))]
  const isSupplySource = (nd: Node) => isDcSource(nd.part) && [...nd.nets.values()].every(rail)

  // ---- graph on signal nets → sections → layers
  const byNet = new Map<IRNet, Node[]>()
  for (const nd of nodes) for (const n of signalNets(nd)) { if (!byNet.has(n)) byNet.set(n, []); byNet.get(n)!.push(nd) }
  const neighbours = (nd: Node) => [...new Set(signalNets(nd).flatMap((n) => byNet.get(n) ?? []))].filter((x) => x !== nd)
  let sections = 0
  const seen = new Set<Node>()
  const order = [...nodes].sort((a, b) => Number(isSupplySource(b)) - Number(isSupplySource(a)))
  for (const start of order) {
    if (seen.has(start)) continue
    const comp: Node[] = []
    const stack = [start]
    seen.add(start)
    while (stack.length) { const n = stack.pop()!; comp.push(n); for (const m of neighbours(n)) if (!seen.has(m)) { seen.add(m); stack.push(m) } }
    // supply sources stand alone at the left of the first section
    for (const n of comp) n.section = isSupplySource(n) && comp.length === 1 ? -1 : sections
    if (!(comp.length === 1 && isSupplySource(comp[0]))) sections++
    // layers: BFS from the inputs (signal sources), else from the least connected part
    const roots = comp.filter((n) => /^Simulation_SPICE:[VI]/.test(n.part.lib) && !isSupplySource(n))
    const firstRoots = roots.length ? roots : [comp.reduce((a, b) => (neighbours(a).length <= neighbours(b).length ? a : b))]
    const depth = new Map<Node, number>()
    let frontier = firstRoots
    for (const r of firstRoots) depth.set(r, 0)
    while (frontier.length) {
      const next: Node[] = []
      for (const n of frontier) for (const m of neighbours(n)) if (!depth.has(m)) { depth.set(m, depth.get(n)! + 1); next.push(m) }
      frontier = next
    }
    for (const n of comp) n.layer = depth.get(n) ?? 0
    // a part on rails only (bypass capacitor) sits with the part it's nearest in the list
  }

  // ---- orientation: rails vertical (supply up, ground down), series parts left → right
  const netLayer = new Map<IRNet, number>()
  for (const nd of nodes) for (const n of signalNets(nd)) netLayer.set(n, Math.min(netLayer.get(n) ?? Infinity, nd.layer))
  for (const nd of nodes) {
    const pins = placedPins({ ...nd.part, x: 0, y: 0, rot: 0 })
    if (pins.length !== 2) continue
    const [a, b] = pins.map((p) => nd.nets.get(p.n))
    const score = (rot: Rot) => {
      const [pa, pb] = placedPins({ ...nd.part, x: 0, y: 0, rot }).map((p) => p.at)
      const vertical = pa[0] === pb[0], top = pa[1] < pb[1] ? 0 : 1
      const nets = [a, b]
      let s = 0
      if (rail(a) || rail(b)) {
        if (!vertical) return -10
        const up = nets[top], down = nets[1 - top]
        if (up && supply.has(up)) s += 4
        if (down?.ground) s += 4
        if (up?.ground || (down && supply.has(down))) s -= 6
      } else {
        const la = a ? netLayer.get(a) ?? 0 : 0, lb = b ? netLayer.get(b) ?? 0 : 0
        if (la === lb) s += vertical ? 2 : 0
        else {
          if (vertical) return -5
          const left = pa[0] < pb[0] ? 0 : 1
          s += (left === 0 ? la < lb : lb < la) ? 4 : -4
        }
      }
      return s - (rot === 0 ? 0 : 0.1)
    }
    nd.part.rot = ROTS.reduce((best, r) => (score(r) > score(best) ? r : best), nd.part.rot)
  }

  // ---- positions: sections side by side, layers as columns, rows stacked
  for (const nd of nodes) { nd.part.x = 0; nd.part.y = 0; const [x0, y0, x1, y1] = box(nd.part); nd.w = Math.ceil(x1 - x0); nd.h = Math.ceil(y1 - y0) }
  let x = 0
  const sectionIds = [...new Set(nodes.map((n) => n.section))].sort((a, b) => a - b)
  for (const sid of sectionIds) {
    const sec = nodes.filter((n) => n.section === sid)
    const layers = [...new Set(sec.map((n) => n.layer))].sort((a, b) => a - b)
    let prevCol: Node[] = []
    for (const L of layers) {
      const col = sec.filter((n) => n.layer === L)
      // order by the rows of the parts they connect to on the left (fewer crossings)
      const bary = (n: Node) => { const ns = neighbours(n).filter((m) => prevCol.includes(m)); return ns.length ? ns.reduce((s, m) => s + m.row, 0) / ns.length : Infinity }
      col.sort((a, b) => bary(a) - bary(b) || Number(isSupplySource(b)) - Number(isSupplySource(a)))
      const width = Math.max(...col.map((n) => n.w))
      let y = 0
      col.forEach((n, i) => { n.row = i; n.part.x = x + Math.ceil(width / 2); n.part.y = y + Math.ceil(n.h / 2); y += n.h + GAP_Y })
      // centre the column
      const shift = -Math.round(y / 2)
      for (const n of col) n.part.y += shift
      // line pins up with what they connect to on the left: straight wires
      for (const n of col) {
        const mine = placedPins(n.part)
        for (const pin of mine) {
          const net = n.nets.get(pin.n)
          if (!net || rail(net)) continue
          const other = prevCol.flatMap((m) => placedPins(m.part).filter((q) => m.nets.get(q.n) === net).map((q) => q.at))[0]
          if (other) { n.part.y += other[1] - pin.at[1]; break }
        }
      }
      // keep the column free of overlaps after aligning
      col.sort((a, b) => a.part.y - b.part.y)
      for (let i = 1; i < col.length; i++) {
        const [, , , pb] = box(col[i - 1].part), [, t] = box(col[i].part)
        if (t < pb + GAP_Y) col[i].part.y += Math.ceil(pb + GAP_Y - t)
      }
      x += width + GAP_X
      prevCol = col
    }
    x += GAP_X * 2 // between sections
  }
  // wrap sections into rows (max ~140 grid units wide), each section kept together
  {
    const secs = sectionIds.map((sid) => nodes.filter((n) => n.section === sid)).filter((g) => g.length)
    const bb = (g: Node[]) => { const bs = g.map((n) => box(n.part)); return [Math.min(...bs.map((b) => b[0])), Math.min(...bs.map((b) => b[1])), Math.max(...bs.map((b) => b[2])), Math.max(...bs.map((b) => b[3]))] }
    let cx = 0, cy = 0, rowH = 0
    for (const g of secs) {
      const [x0, y0, x1, y1] = bb(g)
      if (cx > 0 && cx + (x1 - x0) > 140) { cx = 0; cy += rowH + GAP_Y * 4; rowH = 0 }
      const dx = Math.round(cx - x0), dy = Math.round(cy - y0)
      for (const n of g) { n.part.x += dx; n.part.y += dy }
      cx += x1 - x0 + GAP_X * 3
      rowH = Math.max(rowH, y1 - y0)
    }
  }

  // ---- wiring
  const wires: Wire[] = []
  const symbols: Part[] = []
  type Mark = { net: IRNet | null; kind: "end" | "h" | "v" | "body" }
  const grid = new Map<string, Mark[]>()
  const mark = (p: Pt, m: Mark) => { const k = key(p); grid.set(k, [...(grid.get(k) ?? []), m]) }
  for (const nd of nodes) {
    const [x0, y0, x1, y1] = box(nd.part)
    for (let gx = Math.ceil(x0) + 1; gx <= Math.floor(x1) - 1; gx++) for (let gy = Math.ceil(y0) + 1; gy <= Math.floor(y1) - 1; gy++) mark([gx, gy], { net: null, kind: "body" })
    for (const pin of placedPins(nd.part)) mark(pin.at, { net: nd.nets.get(pin.n) ?? null, kind: "end" })
  }
  const segPoints = (a: Pt, b: Pt): Pt[] => {
    const out: Pt[] = []
    const n = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]))
    for (let i = 0; i <= n; i++) out.push([a[0] + Math.sign(b[0] - a[0]) * i, a[1] + Math.sign(b[1] - a[1]) * i])
    return out
  }
  const why: string[] = []
  let lastWhy = ""
  /** can `path` carry `net` without touching other nets or crossing part bodies? */
  const free = (path: Pt[], net: IRNet) => {
    for (let s = 1; s < path.length; s++) {
      const [a, b] = [path[s - 1], path[s]]
      const horiz = a[1] === b[1]
      const pts = segPoints(a, b)
      for (let i = 0; i < pts.length; i++) {
        const interior = i > 0 && i < pts.length - 1
        for (const m of grid.get(key(pts[i])) ?? []) {
          if (m.kind === "body") { lastWhy = `${net.name}: body at ${key(pts[i])}`; return false }
          if (m.net === net) continue
          // a plain crossing (both straight through, no corner or end here) doesn't connect
          const corner = (i === 0 && s > 1) || (i === pts.length - 1 && s < path.length - 1)
          if (!(interior && !corner && m.kind !== "end" && (m.kind === "h") !== horiz)) { lastWhy = `${net.name}: touches ${m.net?.name ?? "?"} (${m.kind}) at ${key(pts[i])}`; return false }
        }
      }
    }
    return true
  }
  const commitPath = (path: Pt[], net: IRNet) => {
    const clean = path.filter((p, i) => i === 0 || key(p) !== key(path[i - 1]))
    for (let s = 1; s < clean.length; s++) {
      const [a, b] = [clean[s - 1], clean[s]]
      wires.push({ id: uid("w"), a, b })
      const horiz = a[1] === b[1]
      segPoints(a, b).forEach((p, i, all) => mark(p, { net, kind: i === 0 || i === all.length - 1 ? "end" : horiz ? "h" : "v" }))
    }
  }
  const pinEnds = (net: IRNet) => nodes.flatMap((nd) => placedPins(nd.part).filter((q) => nd.nets.get(q.n) === net).map((q) => ({ at: q.at, out: outward(nd.part, q.a), nd })))

  // supply and ground: a power symbol two steps out from each pin
  for (const nd of nodes) for (const pin of placedPins(nd.part)) {
    const net = nd.nets.get(pin.n)
    if (!rail(net) || labelled(net)) continue
    const o = outward(nd.part, pin.a)
    const want: Pt = net!.ground ? [0, 1] : [0, -1]
    // straight out, then turn towards the symbol's side if the pin points sideways
    const e: Pt = [pin.at[0] + o[0], pin.at[1] + o[1]]
    const end: Pt = o[0] === want[0] && o[1] === want[1] ? [pin.at[0] + 2 * o[0], pin.at[1] + 2 * o[1]] : [e[0] + want[0] * 2, e[1] + want[1] * 2]
    const path: Pt[] = o[0] === want[0] && o[1] === want[1] ? [pin.at, end] : [pin.at, e, end]
    if (!free(path, net!)) continue // reconcile() will label it
    commitPath(path, net!)
    symbols.push({ id: uid("p"), ref: "#PWR", lib: net!.ground ? power.gnd : power.supply(net!.name), unit: 1, x: end[0], y: end[1], rot: 0, value: net!.ground ? "GND" : net!.name })
  }

  // maze search (A*, bends cost extra) from a pin to any point of its net's tree, for pins the
  // simple shapes can't reach; crossing another net is allowed only straight through
  const allBoxes = nodes.map((n) => box(n.part))
  const lim = [Math.min(...allBoxes.map((b) => b[0])) - 8, Math.min(...allBoxes.map((b) => b[1])) - 8, Math.max(...allBoxes.map((b) => b[2])) + 8, Math.max(...allBoxes.map((b) => b[3])) + 8]
  const DIRS: Pt[] = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  function maze(pinAt: Pt, esc: Pt, tree: Pt[], net: IRNet): Pt[] | null {
    if (!free([pinAt, esc], net)) return null
    const targets = new Set(tree.map(key))
    type S = { p: Pt; d: number; g: number; prev: S | null; straight: boolean }
    const open: S[] = [{ p: esc, d: DIRS.findIndex((d) => d[0] === esc[0] - pinAt[0] && d[1] === esc[1] - pinAt[1]), g: 0, prev: null, straight: false }]
    const best = new Map<string, number>()
    let found: S | null = null, guard = 0
    while (open.length && guard++ < 40000) {
      open.sort((a, b) => a.g - b.g)
      const s = open.shift()!
      if (targets.has(key(s.p))) { found = s; break }
      for (let di = 0; di < 4; di++) {
        if (s.straight && di !== s.d) continue
        const d = DIRS[di]
        if (s.d >= 0 && d[0] === -DIRS[s.d][0] && d[1] === -DIRS[s.d][1]) continue
        const q: Pt = [s.p[0] + d[0], s.p[1] + d[1]]
        if (q[0] < lim[0] || q[0] > lim[2] || q[1] < lim[1] || q[1] > lim[3]) continue
        const marks = grid.get(key(q)) ?? []
        let crossing = false, blocked = false
        for (const m of marks) {
          if (m.kind === "body") { blocked = true; break }
          if (m.net === net) continue
          if (m.kind === "end") { blocked = true; break }
          const horizMove = d[1] === 0
          if ((m.kind === "h") === horizMove) { blocked = true; break }
          crossing = true
        }
        if (blocked) continue
        if (crossing && targets.has(key(q))) continue
        const g = s.g + 1 + (s.d >= 0 && di !== s.d ? 4 : 0)
        const k = `${key(q)}|${di}|${crossing ? 1 : 0}`
        if ((best.get(k) ?? Infinity) <= g) continue
        best.set(k, g)
        open.push({ p: q, d: di, g, prev: s, straight: crossing })
      }
    }
    if (!found) return null
    const pts: Pt[] = []
    for (let s: S | null = found; s; s = s.prev) pts.unshift(s.p)
    pts.unshift(pinAt)
    // keep only the corners
    const out: Pt[] = [pts[0]]
    for (let i = 1; i < pts.length - 1; i++) {
      const [a, b, c] = [out[out.length - 1], pts[i], pts[i + 1]]
      if ((a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1])) continue
      out.push(b)
    }
    out.push(pts[pts.length - 1])
    return free(out, net) ? out : null
  }

  // signal nets: two pins → an L (or straight); more → a trunk with drops; fewest pins first
  const routed: string[] = [], unrouted: string[] = []
  const sig = ir.nets.filter((n) => !rail(n) && pinEnds(n).length >= 2).sort((a, b) => pinEnds(a).length - pinEnds(b).length)
  for (const net of sig) {
    const ends = pinEnds(net)
    // grow a tree: start at the pin nearest the others, then join each pin to the closest point of the tree
    const cx = ends.reduce((a, e) => a + e.at[0], 0) / ends.length, cy = ends.reduce((a, e) => a + e.at[1], 0) / ends.length
    const todo = [...ends].sort((a, b) => Math.hypot(a.at[0] - cx, a.at[1] - cy) - Math.hypot(b.at[0] - cx, b.at[1] - cy))
    const first = todo.shift()!
    const tree: Pt[] = [first.at]
    let all = true
    while (todo.length) {
      // the pin closest to the tree goes next
      todo.sort((a, b) => Math.min(...tree.map((t) => Math.abs(t[0] - a.at[0]) + Math.abs(t[1] - a.at[1]))) - Math.min(...tree.map((t) => Math.abs(t[0] - b.at[0]) + Math.abs(t[1] - b.at[1]))))
      const e = todo.shift()!
      const esc: Pt = [e.at[0] + e.out[0], e.at[1] + e.out[1]]
      let best: Pt[] | null = null, bestLen = Infinity
      const consider = (path: Pt[]) => {
        const len = path.slice(1).reduce((s, p, i) => s + Math.abs(p[0] - path[i][0]) + Math.abs(p[1] - path[i][1]), 0)
        if (len < bestLen && free(path, net)) { best = path; bestLen = len }
      }
      for (const t of tree) {
        if (e.at[0] === t[0] || e.at[1] === t[1]) consider([e.at, t])
        consider([e.at, esc, [esc[0], t[1]], t])
        consider([e.at, esc, [t[0], esc[1]], t])
        for (const d of [2, -2, 4, -4]) {
          consider([e.at, esc, [esc[0], esc[1] + d], [t[0], esc[1] + d], t])
          consider([e.at, esc, [esc[0] + d, esc[1]], [esc[0] + d, t[1]], t])
        }
      }
      if (!best) best = maze(e.at, esc, tree, net)
      if (best) {
        commitPath(best, net)
        // every grid point of the new branch can take the next pin (T-junctions)
        const b = best as Pt[]
        for (let i = 1; i < b.length; i++) tree.push(...segPoints(b[i - 1], b[i]))
      } else { all = false; why.push(lastWhy) }
    }
    ;(all ? routed : unrouted).push(net.name)
  }
  return { wires, symbols, sections, routed: routed.length, unrouted, why }
}

