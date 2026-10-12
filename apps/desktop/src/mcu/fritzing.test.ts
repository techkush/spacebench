// Fritzing import: connector positions from the breadboard SVG, buses as one net.
// Fixture: fritzing-parts core/US-100_ultrasonic-distance-sensor (CC-BY-SA 3.0, Fritzing).
import fs from "node:fs"
import path from "node:path"
import { DOMParser } from "@xmldom/xmldom"
import { zipSync, strToU8 } from "fflate"
import { describe, expect, it } from "vitest"
import { Circuit } from "./circuit"
import { partFromFzp, partFromFzpz, type ParseXml } from "./fritzing"

const parse: ParseXml = (t) => new DOMParser().parseFromString(t, "image/svg+xml") as never
const dir = path.join(import.meta.dirname, "__fixtures__")
const fzp = fs.readFileSync(path.join(dir, "US-100.fzp"), "utf8")
const svg = fs.readFileSync(path.join(dir, "US-100_breadboard.svg"), "utf8")

describe("Fritzing import", () => {
  it("reads the US-100: title, size, five pins, the GND bus", () => {
    const p = partFromFzp(fzp, svg, parse)
    expect(p.type).toMatch(/^fz-/)
    expect(p.w).toBeCloseTo(44 * 3.7795, 1)
    expect(p.h).toBeCloseTo(26 * 3.7795, 1)
    expect(p.pins).toHaveLength(5)
    // the VCC pad: rect centred at (0, 5.625) inside translate(22, 0) · translate(-5.08, 20)
    expect(p.pins[0].x).toBeCloseTo((22 - 5.08) * 3.7795, 0)
    expect(p.pins[0].y).toBeCloseTo(25.625 * 3.7795, 0)
    // connector3 and connector4 are a bus: same prefix
    const bus = p.pins.slice(3).map((x) => x.name.split(".")[0])
    expect(bus[0]).toBe(bus[1])
    // in a circuit the two bus pins are one net
    const c = new Circuit({ version: 1, author: "", editor: "t", parts: [{ type: p.type, id: "us1", left: 0, top: 0, attrs: {} }], connections: [] }, undefined)
    expect(c.net("us1", p.pins[3].name)).toBe(c.net("us1", p.pins[4].name))
  })
  it("opens a .fzpz", () => {
    const zip = zipSync({ "part.US-100.fzp": strToU8(fzp), "svg.breadboard.US-100_ultrasonic-distance-sensor_breadboard.svg": strToU8(svg) })
    expect(partFromFzpz(zip, parse).pins).toHaveLength(5)
  })
})
