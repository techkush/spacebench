// 3D component bodies as simple primitives (mm, z up from the top of the board),
// chosen from the footprint family. The 3D view turns them into meshes.
import type { BoardPart } from "./board"

export type Prim =
  | { k: "box"; c: [number, number, number]; s: [number, number, number]; color: string; metal?: boolean; label?: string }
  | { k: "cyl"; c: [number, number, number]; r: number; h: number; axis: "z" | "x" | "y"; color: string; metal?: boolean; rTop?: number }
  | { k: "sphere"; c: [number, number, number]; r: number; color: string; opacity?: number }

export const COLORS = { black: "#1c1c1f", body: "#2a2a2e", tin: "#c9ccd1", gold: "#d4a72c", copper: "#c87533", resistor: "#c9b48a", blueCap: "#1e3a8a", ceramic: "#c7a26b", led: "#ef4444" }

const ledColor = (v: string) => (/green/i.test(v) ? "#22c55e" : /blue/i.test(v) ? "#3b82f6" : /yellow|amber/i.test(v) ? "#facc15" : /white/i.test(v) ? "#f8fafc" : /orange/i.test(v) ? "#fb923c" : "#ef4444")

/** Primitives for one part, in board coordinates (already placed and rotated). */
export function bodiesFor(bp: BoardPart, thickness = 1.6): Prim[] {
  const out: Prim[] = []
  const at = bp.at
  const rot = (x: number, y: number): [number, number] => {
    const r = at.rot === 90 ? [-y, x] : at.rot === 180 ? [-x, -y] : at.rot === 270 ? [y, -x] : [x, y]
    return [r[0] + at.x, r[1] + at.y]
  }
  const swap = at.rot === 90 || at.rot === 270
  /** box in footprint coordinates (centre cx, cy; size sx × sy × sz; bottom at z0) */
  const box = (cx: number, cy: number, z0: number, sx: number, sy: number, sz: number, color: string, extra: Partial<Extract<Prim, { k: "box" }>> = {}) => {
    const [x, y] = rot(cx, cy)
    out.push({ k: "box", c: [x, y, z0 + sz / 2], s: swap ? [sy, sx, sz] : [sx, sy, sz], color, ...extra })
  }
  const cyl = (cx: number, cy: number, z0: number, r: number, h: number, color: string, extra: Partial<Extract<Prim, { k: "cyl" }>> = {}) => {
    const [x, y] = rot(cx, cy)
    out.push({ k: "cyl", c: [x, y, z0 + h / 2], r, h, axis: "z", color, ...extra })
  }
  /** a lead from a through-hole pad up to height h; it sticks out 1 mm under the board (trimmed lead) */
  const lead = (px: number, py: number, h: number, w = 0.5) => box(px, py, -thickness - 1.0, w, w, h + thickness + 1.0, COLORS.tin, { metal: true })
  const pads = bp.fp.pads
  const name = bp.fp.name.split(":").pop() ?? ""
  const value = bp.part.value
  const minX = Math.min(...pads.map((p) => p.x)), maxX = Math.max(...pads.map((p) => p.x))
  const minY = Math.min(...pads.map((p) => p.y)), maxY = Math.max(...pads.map((p) => p.y))
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2

  if (/^DIP-/.test(name) || /DIP-\d+ \(generic\)/.test(bp.fp.label)) {
    const w = maxX - minX, len = maxY - minY + 2.54
    box(cx, cy, 0.5, w - 1.3, len - 0.4, 3.3, COLORS.black, { label: value })
    cyl(minX + 1.6, minY - 0.2, 3.8, 0.45, 0.06, "#3f3f46") // pin-1 dimple
    // DIP legs: down through the hole, a shoulder at the seating plane, then into the body side
    const half = (w - 1.3) / 2
    for (const p of pads) {
      const side = p.x < cx ? -1 : 1
      box(p.x, p.y, -thickness - 1.0, 0.46, 0.25, thickness + 2.0, COLORS.tin, { metal: true })
      box(p.x, p.y, 0.5, 0.46, 1.5, 0.5, COLORS.tin, { metal: true })
      box((p.x + cx + side * half) / 2, p.y, 1.0, Math.abs(p.x - (cx + side * half)) + 0.1, 0.5, 0.3, COLORS.tin, { metal: true })
    }
  } else if (/^(SOIC|SOP|TSSOP|MSOP)-/.test(name)) {
    const len = maxY - minY + 1.0
    box(cx, cy, 0.1, Math.abs(maxX - minX) - 1.6, len, 1.5, COLORS.black, { label: value })
    for (const p of pads) box(p.x, p.y, 0, 1.2, 0.4, 0.3, COLORS.tin, { metal: true })
  } else if (/^(R|C|L|LED|D)_\d{4}_/.test(name)) {
    const L = (maxX - minX) + pads[0].w * 0.8, W = pads[0].h * 0.85
    const body = /^R_/.test(name) ? COLORS.black : /^C_/.test(name) ? COLORS.ceramic : /^LED/.test(name) ? "#fde68a" : /^L_/.test(name) ? "#57534e" : COLORS.black
    box(cx, cy, 0, L * 0.62, W, 0.5, body)
    box(minX, cy, 0, L * 0.19, W, 0.5, COLORS.tin, { metal: true })
    box(maxX, cy, 0, L * 0.19, W, 0.5, COLORS.tin, { metal: true })
  } else if (/_Horizontal/.test(name)) {
    // axial resistor or diode lying on the board
    const p = maxX - minX
    const L = Math.min(p - 2.5, /DO-41/.test(name) ? 5.2 : /^D_/.test(name) ? 4 : 6.3), D = /DO-41/.test(name) ? 2.7 : /^D_/.test(name) ? 1.9 : 2.5
    const [x, y] = rot(cx, cy)
    out.push({ k: "cyl", c: [x, y, D / 2 + 0.3], r: D / 2, h: L, axis: swap ? "y" : "x", color: /^D_/.test(name) ? (/DO-35/.test(name) ? "#b45309" : COLORS.black) : COLORS.resistor })
    if (/^D_/.test(name)) { const [bx, by] = rot(minX + (p - L) / 2 + 0.5, cy); out.push({ k: "cyl", c: [bx, by, D / 2 + 0.3], r: D / 2 + 0.02, h: 0.5, axis: swap ? "y" : "x", color: "#e5e7eb" }) }
    else for (const [i, c] of ["#a16207", "#000000", "#dc2626", "#d4a72c"].entries()) { const [bx, by] = rot(minX + (p - L) / 2 + 1 + i * 1.1, cy); out.push({ k: "cyl", c: [bx, by, D / 2 + 0.3], r: D / 2 + 0.03, h: 0.45, axis: swap ? "y" : "x", color: c }) }
    // bent leads
    const [l1x, l1y] = rot(minX + ((p - L) / 2) / 2, cy), [l2x, l2y] = rot(maxX - ((p - L) / 2) / 2, cy)
    out.push({ k: "box", c: [l1x, l1y, D / 2 + 0.3], s: swap ? [0.5, (p - L) / 2, 0.5] : [(p - L) / 2, 0.5, 0.5], color: COLORS.tin, metal: true })
    out.push({ k: "box", c: [l2x, l2y, D / 2 + 0.3], s: swap ? [0.5, (p - L) / 2, 0.5] : [(p - L) / 2, 0.5, 0.5], color: COLORS.tin, metal: true })
    lead(minX, cy, D / 2 + 0.3); lead(maxX, cy, D / 2 + 0.3)
  } else if (/^CP_Radial/.test(name) || /^C_Radial/.test(name)) {
    const d = Number(/_D([\d.]+)mm/.exec(name)?.[1] ?? 5), h = d <= 5 ? 11 : d <= 6.3 ? 11 : 12.5
    cyl(cx, cy, 0.4, d / 2, h, COLORS.blueCap)
    cyl(cx, cy, 0.4 + h, d / 2 - 0.15, 0.05, COLORS.tin, { metal: true })
    // minus stripe on the side of pad 2
    box(maxX + d / 2 - 0.6 - (maxX - cx), cy, 0.6, 0.35, d * 0.45, h - 0.4, "#cbd5e1")
    for (const p of pads) lead(p.x, p.y, 0.4)
  } else if (/^C_Disc/.test(name)) {
    const [x, y] = rot(cx, cy)
    out.push({ k: "cyl", c: [x, y, 3.2], r: 2.5, h: 2.5, axis: swap ? "x" : "y", color: COLORS.ceramic })
    for (const p of pads) lead(p.x, p.y, 1.0)
  } else if (/^LED_D/.test(name)) {
    const d = Number(/_D([\d.]+)mm/.exec(name)?.[1] ?? 3), col = ledColor(value)
    cyl(cx, cy, 0.4, d / 2 + 0.4, 1.0, col, { rTop: d / 2 + 0.4 })
    cyl(cx, cy, 1.4, d / 2, d * 1.1, col)
    const [x, y] = rot(cx, cy)
    out.push({ k: "sphere", c: [x, y, 1.4 + d * 1.1], r: d / 2, color: col, opacity: 0.85 })
    for (const p of pads) lead(p.x, p.y, 0.4)
  } else if (/^TO-92/.test(name)) {
    const [x, y] = rot(cx, cy)
    out.push({ k: "cyl", c: [x, y, 3.0 + 2.25], r: 2.4, h: 4.5, axis: "z", color: COLORS.black })
    box(cx, cy - 1.2, 3.0, 4.8, 2.4, 4.5, COLORS.black) // flat face (half cylinder look)
    for (const p of pads) lead(p.x, p.y, 3.0, 0.45)
  } else if (/^TO-220/.test(name)) {
    box(cx, cy - 2.0, 2.0, 10, 4.5, 9, COLORS.black, { label: value })
    box(cx, cy - 0.5, 2.0, 10, 1.3, 15.5, COLORS.tin, { metal: true })
    for (const p of pads) lead(p.x, p.y, 2.0, 0.8)
  } else if (/^SOT-23/.test(name)) {
    box(cx, cy, 0.1, 2.9, 1.3, 1.0, COLORS.black)
    for (const p of pads) box(p.x, p.y, 0, 0.4, 0.6, 0.25, COLORS.tin, { metal: true })
  } else if (/_1x\d+_|PinHeader|Inline_/.test(name)) {
    const vertical = maxY - minY >= maxX - minX
    box(cx, cy, 0, vertical ? 2.54 : maxX - minX + 2.54, vertical ? maxY - minY + 2.54 : 2.54, 2.5, COLORS.black)
    for (const p of pads) box(p.x, p.y, -thickness - 1.5, 0.64, 0.64, thickness + 9.9, COLORS.gold, { metal: true })
  } else {
    const [x0, y0, x1, y1] = bp.fp.court
    box((x0 + x1) / 2, (y0 + y1) / 2, 0.2, (x1 - x0) * 0.8, (y1 - y0) * 0.8, 2.0, "#52525b", { label: value })
    for (const p of pads) if (p.drill) lead(p.x, p.y, 0.2)
  }
  // solder joints on the back of every through-hole pad
  for (const p of pads) {
    if (!p.drill) continue
    const [x, y] = rot(p.x, p.y)
    out.push({ k: "cyl", c: [x, y, -thickness - 0.35], r: 0.32, rTop: Math.min(p.w, p.h) * 0.48, h: 0.7, axis: "z", color: "#cfd3d8", metal: true })
  }
  return out
}

/** Tallest point of a part (for height checks / camera framing). */
export const heightOf = (prims: Prim[]) => Math.max(0, ...prims.map((p) => (p.k === "box" ? p.c[2] + p.s[2] / 2 : p.k === "cyl" ? p.c[2] + (p.axis === "z" ? p.h / 2 : p.r) : p.c[2] + p.r)))
