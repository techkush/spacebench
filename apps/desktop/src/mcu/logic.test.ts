import { describe, expect, it } from "vitest"
import { LogicBuffer } from "./logic"

describe("logic analyser", () => {
  it("measures a 1 kHz 25 % PWM and writes VCD", () => {
    const b = new LogicBuffer()
    const ev: [string, number, number][] = []
    for (let k = 0; k < 10; k++) ev.push(["9", k * 1e-3, 1], ["9", k * 1e-3 + 0.25e-3, 0])
    b.push(ev, ["9", "13"], 0.01)
    const m = b.measure("9", 0, 0.01)
    expect(m.freq).toBeCloseTo(1000, 3)
    expect(m.duty).toBeCloseTo(0.25, 3)
    expect(b.levelAt("9", 0.0001)).toBe(1)
    expect(b.levelAt("9", 0.0005)).toBe(0)
    const vcd = b.toVCD()
    expect(vcd).toContain("$var wire 1 ! 9 $end")
    expect(vcd).toContain("#250000\n0!")
  })
})
