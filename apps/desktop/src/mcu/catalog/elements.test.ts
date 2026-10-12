// The solver with catalogue parts (no sketch: the Uno only supplies 5 V / 3.3 V / GND).
import { describe, expect, it } from "vitest"
import { boardByType } from "../boards"
import { Circuit, type PartUi } from "../circuit"
import type { Connection, Diagram } from "../diagram"

const uno = boardByType("wokwi-arduino-uno")!
type P = [string, string, Record<string, string>?]
function solve(parts: P[], wires: [string, string][], ui: Record<string, PartUi> = {}, c?: Circuit) {
  const d: Diagram = { version: 1, author: "", editor: "t", parts: [{ type: uno.type, id: "uno", top: 0, left: 0, attrs: {} }, ...parts.map(([type, id, attrs]) => ({ type, id, top: 0, left: 0, attrs: attrs ?? {} }))], connections: wires.map(([a, b]) => [a, b, "", []] as Connection) }
  const circuit = c ?? new Circuit(d, uno)
  const s = circuit.solve(new Map(), ui, new Map())
  return { s, circuit, v: (end: string) => { const [id, pin] = end.split(":"); return s.v[circuit.net(id, pin)] } }
}

describe("catalogue parts in the DC solver", () => {
  it("a 9 V battery lights an LED through 1 kΩ", () => {
    const { s } = solve([["sb-9v-battery", "b1"], ["wokwi-resistor", "r1", { value: "1k" }], ["wokwi-led", "d1", { color: "red" }]], [["b1:+", "r1:1"], ["r1:2", "d1:A"], ["d1:C", "b1:-"]])
    expect(s.leds.find((l) => l.part === "d1")!.current).toBeCloseTo((9 - 1.8) / 1012, 3)
  })
  it("an NPN switches an LED from a base resistor; no LED warning for the junction", () => {
    const parts: P[] = [["sb-2n2222-npn", "q1"], ["wokwi-resistor", "rb", { value: "1k" }], ["wokwi-resistor", "rc", { value: "220" }], ["wokwi-led", "d1"]]
    const w: [string, string][] = [["uno:5V", "rc:1"], ["rc:2", "d1:A"], ["d1:C", "q1:C"], ["q1:E", "uno:GND.1"], ["rb:2", "q1:B"]]
    const off = solve(parts, w)
    expect(off.s.leds.find((l) => l.part === "d1")?.current ?? 0).toBeLessThan(1e-4)
    const on = solve(parts, [...w, ["rb:1", "uno:5V"]])
    expect(on.s.leds.find((l) => l.part === "d1")!.current).toBeGreaterThan(0.01)
    expect(on.s.leds.some((l) => l.part === "q1")).toBe(false)
    expect(on.s.warnings).toEqual([])
  })
  it("a relay module closes COM–NO when SIG is high", () => {
    const w: [string, string][] = [["k1:GND", "uno:GND.1"], ["k1:COM", "uno:5V"], ["k1:NO", "r1:1"], ["r1:2", "uno:GND.2"]]
    const parts: P[] = [["sb-grove-relay-5v-10a", "k1"], ["wokwi-resistor", "r1", { value: "1k" }]]
    expect(solve(parts, w).v("r1:1")).toBeLessThan(0.1)
    const on = solve(parts, [...w, ["k1:SIG", "uno:5V"]])
    expect(on.v("r1:1")).toBeGreaterThan(4.9)
    expect(on.s.views.get("k1")?.on).toBe(1)
  })
  it("an op-amp follower copies a divider; a comparator saturates", () => {
    const parts: P[] = [["sb-ideal-op-amp", "u1"], ["wokwi-resistor", "ra", { value: "10k" }], ["wokwi-resistor", "rb", { value: "10k" }]]
    const w: [string, string][] = [["uno:5V", "ra:1"], ["ra:2", "rb:1"], ["rb:2", "uno:GND.1"], ["ra:2", "u1:IN+"], ["u1:OUT", "u1:IN-"]]
    expect(solve(parts, w).v("u1:OUT")).toBeCloseTo(2.5, 2)
    const cmp = solve(parts, [["uno:5V", "ra:1"], ["ra:2", "rb:1"], ["rb:2", "uno:GND.1"], ["ra:2", "u1:IN+"], ["u1:IN-", "uno:GND.2"], ["u1:OUT", "rb:1"]].slice(0, 5).concat([["u1:OUT", "uno:A0"]]))
    expect(cmp.v("u1:OUT")).toBeCloseTo(5, 1)
  })
  it("NAND gate and a D flip-flop that changes on the clock edge", () => {
    const g = solve([["sb-nand-gate", "g1"]], [["g1:A", "uno:5V"], ["g1:B", "uno:5V"], ["g1:Y", "uno:A0"]])
    expect(g.v("g1:Y")).toBeLessThan(0.1)
    const parts: P[] = [["sb-d-flip-flop", "ff"]]
    const first = solve(parts, [["ff:D", "uno:5V"], ["ff:CLK", "uno:2"], ["ff:Q", "uno:A0"]])
    const c = first.circuit
    const q = (clk: boolean) => { const s = c.solve(new Map([["2", { out: clk, pullup: false }]]), {}, new Map()); return s.v[c.net("ff", "Q")] }
    expect(q(false)).toBeLessThan(0.1)
    expect(q(true)).toBeGreaterThan(4.9)
    expect(q(false)).toBeGreaterThan(4.9)
    expect(c.stateKey()).toBe("ff10")
  })
  it("7805 regulates a 9 V battery; a voltmeter reads it", () => {
    const { v, s } = solve([["sb-9v-battery", "b1"], ["sb-7805-5v-regulator", "u1"], ["wokwi-resistor", "rl", { value: "1k" }], ["sb-dc-voltmeter", "vm"]],
      [["b1:+", "u1:IN"], ["b1:-", "u1:GND"], ["u1:OUT", "rl:1"], ["rl:2", "u1:GND"], ["vm:V+", "u1:OUT"], ["vm:V-", "u1:GND"]])
    expect(v("u1:OUT") - v("u1:GND")).toBeCloseTo(5, 1)
    expect(s.views.get("vm")?.text).toMatch(/^4\.9|^5\.0/)
  })
})
