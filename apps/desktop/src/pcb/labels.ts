// Auto label: put every silkscreen reference next to its part without touching a pad,
// another reference, a via or the board edge. Candidates are tried around the part
// (above, below, left, right — horizontal or turned 90°, stepping outwards); the
// cheapest free one wins, where cost = distance from the part + overlap with other parts.
import { labelBox, labelSize, LABEL_H, type Board, type BoardPart, type Label } from "./board"

type Box = [number, number, number, number]
const hit = (a: Box, b: Box, m = 0) => a[0] < b[2] + m && a[2] + m > b[0] && a[1] < b[3] + m && a[3] + m > b[1]
const area = (a: Box, b: Box) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))

export interface LabelOptions {
  /** silk-to-pad / silk-to-silk clearance, mm */
  clearance: number
  /** allow references turned 90° */
  rotate: boolean
  /** keep labels the user placed by hand */
  keepManual: string[]
}

export interface LabelResult { labels: Record<string, Label>; unplaced: string[] }

export function autoLabel(parts: BoardPart[], board: Board, opts: Partial<LabelOptions> = {}): LabelResult {
  const o: LabelOptions = { clearance: 0.15, rotate: true, keepManual: [], ...opts }
  const padBoxes: Box[] = parts.flatMap((p) => p.pads.map((q) => [q.ax - q.aw / 2, q.ay - q.ah / 2, q.ax + q.aw / 2, q.ay + q.ah / 2] as Box))
  const viaBoxes: Box[] = board.vias.map((v) => [v.x - v.dia / 2, v.y - v.dia / 2, v.x + v.dia / 2, v.y + v.dia / 2])
  const placed: Box[] = []
  const labels: Record<string, Label> = {}
  const unplaced: string[] = []
  for (const r of o.keepManual) {
    const p = parts.find((x) => x.ref === r)
    const l = board.labels?.[r]
    if (p && l) { labels[r] = l; placed.push(labelBox(r, l)) }
  }
  // crowded parts first (more neighbours nearby), so they get the best spots
  const todo = parts.filter((p) => !labels[p.ref]).sort((a, b) => crowd(b) - crowd(a) || a.ref.localeCompare(b.ref))
  function crowd(p: BoardPart) { return parts.filter((q) => q !== p && hit(p.court, q.court, 3)).length }
  const inside = (b: Box) => b[0] >= 0.3 && b[1] >= 0.3 && b[2] <= board.width - 0.3 && b[3] <= board.height - 0.3
  for (const p of todo) {
    const { w } = labelSize(p.ref)
    const [x0, y0, x1, y1] = p.court
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
    const cands: { l: Label; d: number }[] = []
    for (let step = 0; step <= 12; step++) {
      const g = 0.1 + step * 0.4
      // horizontal: above / below (left, centre, right aligned), left / right of the part
      for (const x of [x0 + 0.3, cx - w / 2, x1 - w - 0.3]) {
        cands.push({ l: { x, y: y0 - g - LABEL_H, rot: 0 }, d: g })
        cands.push({ l: { x, y: y1 + g, rot: 0 }, d: g + 0.05 })
      }
      cands.push({ l: { x: x1 + g, y: cy - LABEL_H / 2, rot: 0 }, d: g + 0.1 })
      cands.push({ l: { x: x0 - g - w, y: cy - LABEL_H / 2, rot: 0 }, d: g + 0.1 })
      if (o.rotate) {
        cands.push({ l: { x: x1 + g, y: cy - w / 2, rot: 90 }, d: g + 0.3 })
        cands.push({ l: { x: x0 - g - LABEL_H, y: cy - w / 2, rot: 90 }, d: g + 0.3 })
      }
    }
    // inside the courtyard (large parts like DIPs have room between the pad rows)
    cands.push({ l: { x: cx - w / 2, y: cy - LABEL_H / 2, rot: 0 }, d: 0.2 })
    if (o.rotate) cands.push({ l: { x: cx - LABEL_H / 2, y: cy - w / 2, rot: 90 }, d: 0.25 })
    let best: { l: Label; cost: number } | null = null
    for (const c of cands) {
      const b = labelBox(p.ref, c.l)
      if (!inside(b)) continue
      if (padBoxes.some((q) => hit(b, q, o.clearance))) continue
      if (viaBoxes.some((q) => hit(b, q, o.clearance))) continue
      if (placed.some((q) => hit(b, q, o.clearance))) continue
      // prefer not to sit on another part's body (it would be hidden under the component)
      const overOthers = parts.reduce((s, q) => (q === p ? s : s + area(b, q.court)), 0)
      const cost = c.d + overOthers * 4
      if (!best || cost < best.cost) best = { l: { ...c.l, x: round(c.l.x), y: round(c.l.y) }, cost }
    }
    if (best) { labels[p.ref] = best.l; placed.push(labelBox(p.ref, best.l)) }
    else unplaced.push(p.ref)
  }
  return { labels, unplaced }
}

const round = (v: number) => Math.round(v * 100) / 100
