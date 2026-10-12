// "Check with ngspice": the deck of a running sketch agrees with the built-in solver.
import fs from "node:fs"
import { describe, expect, it } from "vitest"
import { remap, type OpResult } from "@/lib/engine"
import { run } from "../../vite-ngspice"
import { boardByType } from "./boards"
import { MCU_EXAMPLES } from "./examples"
import { mcuDeck } from "./spice"

const ngspice = ["/opt/homebrew/bin/ngspice", "/usr/local/bin/ngspice", "/usr/bin/ngspice"].find((p) => fs.existsSync(p))

describe.skipIf(!ngspice)("check with ngspice", () => {
  it("an LED on a HIGH pin through 220 Ω draws ~12 mA", async () => {
    const ex = MCU_EXAMPLES.find((e) => e.id === "blink")!
    const { net, rows } = mcuDeck(ex.diagram, boardByType("wokwi-arduino-uno")!, { pins: [["12", { out: true, pullup: false }], ["13", { out: false, pullup: false }]], drives: [], ui: {} })
    const r = await run(net.text)
    expect(r.status).toBe(200)
    const op = remap(JSON.parse(r.body) as OpResult, net)
    const get = (name: string) => op.values[op.names.indexOf(name)]
    const led = rows.find((x) => x.kind === "led")!
    const i = get(`I(${led.element})`)
    expect(i).toBeGreaterThan(0.010)
    expect(i).toBeLessThan(0.014)
    const pin = rows.find((x) => x.what.startsWith("pin 12"))!
    expect(Math.abs(get(`I(${pin.element})`))).toBeCloseTo(i, 4)
  })
})
