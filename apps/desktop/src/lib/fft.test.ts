import { describe, expect, it } from "vitest"

import { spectrum } from "./fft"

const sample = (fn: (t: number) => number, stop: number, n = 20000) => {
  const t = Array.from({ length: n }, (_, i) => (i / (n - 1)) * stop)
  return { t, y: t.map(fn) }
}

describe("spectrum", () => {
  it("finds a 1 kHz sine's frequency and amplitude, with ~0 THD", () => {
    const { t, y } = sample((x) => 2 * Math.sin(2 * Math.PI * 1000 * x) + 0.5, 0.02)
    const s = spectrum(t, y)
    expect(s.fundamental!.f).toBeCloseTo(1000, -1)
    expect(s.fundamental!.amp).toBeCloseTo(2, 1)
    expect(s.dc).toBeCloseTo(0.5, 2)
    expect(s.thd).toBeLessThan(0.01)
  })
  it("a 50 % square wave has odd harmonics and THD ≈ 43 % (harmonics 2…10)", () => {
    const { t, y } = sample((x) => ((x * 500) % 1 < 0.5 ? 1 : -1), 0.04, 80000)
    const s = spectrum(t, y)
    expect(s.fundamental!.f).toBeCloseTo(500, -1)
    expect(s.fundamental!.amp).toBeCloseTo(4 / Math.PI, 1)
    const h3 = s.harmonics.find((h) => h.k === 3)!, h2 = s.harmonics.find((h) => h.k === 2)!
    expect(h3.amp / s.fundamental!.amp).toBeCloseTo(1 / 3, 1)
    expect(h2.amp / s.fundamental!.amp).toBeLessThan(0.02)
    expect(s.thd).toBeGreaterThan(0.39)
    expect(s.thd).toBeLessThan(0.46)
  })
})
