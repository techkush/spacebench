import { describe, expect, it } from "vitest"

import { toAudio } from "@/lib/sound"
import type { Part } from "./model"
import { ledColor, outputKind, outputState } from "./outputs"

const part = (lib: string, value = "", ref = "X1") => ({ id: "p", ref, lib, value, unit: 1, x: 0, y: 0, rot: 0 }) as unknown as Part

describe("output devices", () => {
  it("recognises outputs by symbol", () => {
    expect(["Device:LED", "Device:LED_Small", "Device:Lamp", "Device:Speaker", "Device:Buzzer", "Motor:Motor_DC", "Motor:Fan"].map((lib) => outputKind({ lib }))).toEqual(["led", "led", "lamp", "speaker", "buzzer", "motor", "motor"])
    expect(outputKind({ lib: "Device:R" })).toBeNull()
    expect(outputKind({ lib: "Device:LED_RGBA" })).toBeNull() // multi-colour packages: not a single light
  })
  it("LED brightness follows forward current on a log scale and warns past 30 mA", () => {
    const led = part("Device:LED", "Green", "D1")
    const at = (i: number) => outputState(led, { "I(D1)": i })!
    expect(at(-0.01).level).toBe(0) // reverse: dark
    expect(at(5e-5).level).toBe(0)
    expect(at(0.02).level).toBeCloseTo(1)
    expect(at(0.002).level).toBeGreaterThan(0.4)
    expect(at(0.002).level).toBeLessThan(0.7)
    expect(at(0.02).overdriven).toBe(false)
    expect(at(0.04).overdriven).toBe(true)
    expect(at(0.01).color).toBe(ledColor("Green"))
    expect(outputState(led, {})).toBeNull()
  })
  it("motor direction comes from the current's sign", () => {
    const m = part("Motor:Motor_DC", "", "M1")
    expect(outputState(m, { "I(M1)": -0.3 })).toMatchObject({ kind: "motor", current: -0.3 })
    expect(outputState(m, { "I(M1)": 0.52 })!.level).toBe(1)
  })
})

describe("speaker audio", () => {
  it("resamples a 1 kHz tone at real pitch, loops on whole periods and normalises", () => {
    const time = Array.from({ length: 2001 }, (_, k) => k * 1e-5) // 20 ms
    const y = time.map((t) => 0.1 + 0.05 * Math.sin(2 * Math.PI * 1000 * t))
    const a = toAudio(time, y, 1)!
    // whole periods of 44.1 samples each
    expect(a.length / 44.1).toBeCloseTo(Math.round(a.length / 44.1), 0)
    expect(Math.max(...a)).toBeCloseTo(0.35, 2)
    // zero-crossings per second ≈ 2 × 1000
    let z = 0
    for (let k = 1; k < a.length; k++) if (Math.sign(a[k]) !== Math.sign(a[k - 1])) z++
    expect(z / (a.length / 44100)).toBeGreaterThan(1900)
    expect(z / (a.length / 44100)).toBeLessThan(2100)
  })
  it("silence and too-short runs give nothing", () => {
    expect(toAudio([0, 1e-3, 2e-3, 3e-3], [1, 1, 1, 1], 1)).toBeNull()
    expect(toAudio([0, 1e-6, 2e-6, 3e-6], [0, 1, 0, 1], 1)).toBeNull()
  })
})
