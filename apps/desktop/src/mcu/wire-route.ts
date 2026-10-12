/** Routing for wires between part pins on the Microcontrollers canvas. */

export type Pt = { x: number; y: number }
export type Box = { x: number; y: number; w: number; h: number }
export type Edge = "left" | "right" | "top" | "bottom"

/** Which edge of its part a pin sits on (the nearest one). */
export function pinEdge(p: Pt, b: Box): Edge {
  const d = { left: p.x - b.x, right: b.x + b.w - p.x, top: p.y - b.y, bottom: b.y + b.h - p.y }
  return (Object.entries(d) as [Edge, number][]).sort((u, v) => u[1] - v[1])[0][0]
}

/**
 * A wire between two part pins with no route hints: out of each pin away from its part (each wire
 * on a side a lane further out), then across outside the pin rows, so a wire never runs along a row
 * of pins and looks joined to the ones it passes.
 */
export function routeAround(pa: Pt, ea: Edge, ba: Box, la: number, pb: Pt, eb: Edge, bb: Box, lb: number): Pt[] {
  const offA = 10 + (la % 8) * 6, offB = 10 + (lb % 8) * 6
  const out = (p: Pt, e: Edge, o: number): Pt => e === "left" ? { x: p.x - o, y: p.y } : e === "right" ? { x: p.x + o, y: p.y } : e === "top" ? { x: p.x, y: p.y - o } : { x: p.x, y: p.y + o }
  const sa = out(pa, ea, offA), sb = out(pb, eb, offB)
  const horiz = (e: Edge) => e === "left" || e === "right"
  let mid: Pt[]
  if (horiz(ea) && horiz(eb)) {
    if (ea === eb) {
      // both pins face the same way: one riser beyond both
      const rx = ea === "left" ? Math.min(sa.x, sb.x) : Math.max(sa.x, sb.x)
      mid = [{ x: rx, y: pa.y }, { x: rx, y: pb.y }]
    } else if ((ea === "right") === (sa.x <= sb.x)) {
      // facing each other with room between: a riser half way
      const rx = (sa.x + sb.x) / 2
      mid = [{ x: rx, y: pa.y }, { x: rx, y: pb.y }]
    } else {
      // facing away: across in the gap between the parts, or below both
      const gapTop = Math.min(ba.y + ba.h, bb.y + bb.h), gapBot = Math.max(ba.y, bb.y)
      const ry = gapBot - gapTop > 8 ? (gapTop + gapBot) / 2 : Math.max(ba.y + ba.h, bb.y + bb.h) + Math.max(offA, offB)
      mid = [sa, { x: sa.x, y: ry }, { x: sb.x, y: ry }, sb]
    }
  } else if (!horiz(ea) && !horiz(eb)) {
    if (ea === eb) {
      const ry = ea === "top" ? Math.min(sa.y, sb.y) : Math.max(sa.y, sb.y)
      mid = [{ x: pa.x, y: ry }, { x: pb.x, y: ry }]
    } else if ((ea === "bottom") === (sa.y <= sb.y)) {
      const ry = (sa.y + sb.y) / 2
      mid = [{ x: pa.x, y: ry }, { x: pb.x, y: ry }]
    } else {
      const gapL = Math.min(ba.x + ba.w, bb.x + bb.w), gapR = Math.max(ba.x, bb.x)
      const rx = gapR - gapL > 8 ? (gapL + gapR) / 2 : Math.max(ba.x + ba.w, bb.x + bb.w) + Math.max(offA, offB)
      mid = [sa, { x: rx, y: sa.y }, { x: rx, y: sb.y }, sb]
    }
  } else if (horiz(ea)) mid = [sa, { x: sb.x, y: sa.y }, sb]
  else mid = [sa, { x: sa.x, y: sb.y }, sb]
  return [pa, ...mid, pb]
}

/** Drop repeated points and the middle of straight runs. */
export function tidy(pts: Pt[]): Pt[] {
  const r: Pt[] = []
  for (const p of pts) {
    const q = r[r.length - 1]
    if (q && Math.abs(q.x - p.x) < 0.5 && Math.abs(q.y - p.y) < 0.5) continue
    const o = r[r.length - 2]
    if (o && q && ((Math.abs(o.x - q.x) < 0.5 && Math.abs(q.x - p.x) < 0.5) || (Math.abs(o.y - q.y) < 0.5 && Math.abs(q.y - p.y) < 0.5))) r.pop()
    r.push(p)
  }
  return r
}
