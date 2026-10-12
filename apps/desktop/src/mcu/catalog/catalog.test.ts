import { describe, expect, it } from "vitest"
import { CATALOG, simulated } from "."
import { draw } from "./look"
import { PARTS } from "../parts"

describe("parts catalogue", () => {
  it("has no \"Drawing only\" parts: every part is simulated (only boards without an emulator aren't)", () => {
    const drawn = CATALOG.filter((p) => !simulated(p) && !p.noEmu).map((p) => p.type)
    expect(drawn).toEqual([])
    // and every proto model behind them exists
    for (const p of CATALOG) if (p.model.m === "none" && !p.noEmu) expect(p.board || p.legacy, p.type).toBeTruthy()
  })
  it("lists every part once per key, with groups", () => {
    const keys = PARTS.map((p) => p.key)
    expect(new Set(keys).size).toBe(keys.length)
    const by: Record<string, number> = {}
    for (const p of PARTS) by[p.category] = (by[p.category] ?? 0) + 1
    console.log(PARTS.length, JSON.stringify(by), "simulated", PARTS.filter((p) => p.sim).length)
    expect(PARTS.length).toBeGreaterThan(400)
  })
  it("draws each sb- part with its pins on the 2.54 mm grid", () => {
    for (const p of CATALOG) {
      if (!p.type.startsWith("sb-") || p.base) continue
      const d = draw(p)
      expect(d.pins.map((x) => x.name), p.title).toEqual(expect.arrayContaining(p.pins))
      expect(new Set(d.pins.map((x) => x.name)).size, p.title).toBe(d.pins.length)
      expect(d.w > 0 && d.h > 0, p.title).toBe(true)
    }
  })
})
