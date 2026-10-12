import { describe, expect, it } from "vitest"
import { pinEdge, routeAround, tidy } from "./wire-route"

type Pt = { x: number; y: number }
// does a segment of the path pass over point p (other than at its ends)?
const passesOver = (pts: Pt[], p: Pt) => pts.slice(1).some((q, i) => {
  const o = pts[i]
  const onV = Math.abs(o.x - q.x) < 0.5 && Math.abs(o.x - p.x) < 0.5 && p.y > Math.min(o.y, q.y) && p.y < Math.max(o.y, q.y)
  const onH = Math.abs(o.y - q.y) < 0.5 && Math.abs(o.y - p.y) < 0.5 && p.x > Math.min(o.x, q.x) && p.x < Math.max(o.x, q.x)
  return onV || onH
})

describe("wire routing between part pins", () => {
  // two 4-input gates stacked, inputs on the left at x = 100, rows every 9.6 px
  const top = { x: 100, y: 0, w: 80, h: 58 }, bot = { x: 100, y: 80, w: 80, h: 58 }
  const pin = (b: typeof top, row: number) => ({ x: 100, y: b.y + row * 9.6 })

  it("does not run along the pin column over the pins between", () => {
    const a = pin(top, 4), b = pin(bot, 2)   // top gate's C → bottom gate's B
    expect(pinEdge(a, top)).toBe("left")
    const pts = tidy(routeAround(a, "left", top, 0, b, "left", bot, 0))
    for (const p of [pin(top, 5), pin(bot, 1)]) expect(passesOver(pts, p)).toBe(false)
    // the riser is to the left of the pins
    expect(Math.min(...pts.map((p) => p.x))).toBeLessThan(100)
  })

  it("puts a second wire on that side in its own lane", () => {
    const one = routeAround(pin(top, 4), "left", top, 0, pin(bot, 2), "left", bot, 0)
    const two = routeAround(pin(top, 1), "left", top, 1, pin(bot, 1), "left", bot, 1)
    expect(Math.min(...two.map((p) => p.x))).not.toBe(Math.min(...one.map((p) => p.x)))
  })

  it("goes straight across between facing pins", () => {
    const pts = tidy(routeAround({ x: 180, y: 29 }, "right", top, 0, { x: 300, y: 29 }, "left", { x: 300, y: 0, w: 80, h: 58 }, 0))
    expect(pts).toEqual([{ x: 180, y: 29 }, { x: 300, y: 29 }])
  })

  it("leaves an output that faces away round the outside, not through the part", () => {
    // output on the right of a part to the left input of a part further left and lower
    const b2 = { x: 0, y: 100, w: 60, h: 40 }
    const pts = tidy(routeAround({ x: 180, y: 29 }, "right", top, 0, { x: 0, y: 120 }, "left", b2, 0))
    expect(pts[1].x).toBeGreaterThan(180)
    expect(pts[pts.length - 2].x).toBeLessThan(0)
  })
})
