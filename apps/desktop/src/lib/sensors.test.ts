import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
import { describe, expect, it } from "vitest"

import type { Doc } from "@/editor/model"
import { deriveNetlist } from "@/editor/netlist"
import { feedTargets } from "@/lib/feeds"
import { remap, type JobResult } from "@/lib/engine"
import { setLoader } from "@/lib/kicad"
import { buildNetlist } from "@/lib/spice"
import { compileKirk } from "@/kirk/compile"
import { generateKirk } from "@/kirk/generate"
import { run } from "../../vite-ngspice"
import { QUANTITY_LIST, SENSOR_MODELS } from "./sensors"

const KICAD = path.resolve(import.meta.dirname, "../../public/kicad")
setLoader(async (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(KICAD, `${f}.gz`))).toString()))
const ngspice = ["/opt/homebrew/bin/ngspice", "/usr/local/bin/ngspice", "/usr/bin/ngspice"].find((p) => fs.existsSync(p))

async function sim(doc: Doc, a: "op" | "tran"): Promise<JobResult> {
  const net = buildNetlist(doc, deriveNetlist(doc), a)
  const r = await run(net.text)
  if (r.status !== 200) throw new Error(`${r.body}\n${net.text}`)
  return remap(JSON.parse(r.body) as JobResult, net)
}
const op = (r: JobResult, n: string) => (r.type === "op" ? r.values[r.names.indexOf(n)] : NaN)
const feed = (d: Doc, target: string, expr: string): Doc => ({ ...d, stimulus: { feeds: [{ target, expr }] } })

/** Each sensor in a minimal test circuit: a 5 V supply, the sensor, and what we measure. */
const RESISTIVE = (ctor: string) => `circuit T {
    ground GND
    V1 = Vdc(5 V)
    S1 = ${ctor}
    R1 = R(10k)
    VCC -- V1 -- GND
    VCC -- S1 -- OUT -- R1 -- GND
}
simulate op
`
const MODULE = (ctor: string, pullup = false) => `circuit T {
    ground GND
    V1 = Vdc(5 V)
    U1 = ${ctor}
    R1 = R(${pullup ? "10k" : "100k"})
    VCC -- V1 -- GND
    U1.VCC -- VCC
    U1.GND -- GND
    U1.OUT -- OUT
    ${pullup ? "VCC -- R1 -- OUT" : "OUT -- R1 -- GND"}
}
simulate op
`

// [constructor, circuit, quantity value low, value high, expectation on V(OUT): "up" rises with the quantity, "down" falls]
const CASES: [string, string, string, string, "up" | "down"][] = [
  ["FSR()", RESISTIVE("FSR()"), "0.2 N", "20 N", "up"],
  ["GasSensor()", RESISTIVE("GasSensor()"), "100 ppm", "5000 ppm", "up"],
  ["MoistureProbe()", RESISTIVE("MoistureProbe()"), "5 %", "90 %", "up"],
  ["LevelSensor()", RESISTIVE("LevelSensor()"), "0 %", "100 %", "up"],
  ["HumiditySensor()", MODULE("HumiditySensor()"), "20 %", "80 %", "up"],
  ["DistanceSensor()", MODULE("DistanceSensor()"), "10 cm", "70 cm", "down"],
  ["Accelerometer()", MODULE("Accelerometer()"), "-1 g", "1 g", "up"],
  ["GasModule()", MODULE("GasModule()"), "100 ppm", "5000 ppm", "up"],
  ["PIR()", MODULE("PIR()"), "0", "1", "up"],
]

describe("sensor catalogue", () => {
  it("every quantity is a room property; every sensor is an input with its quantity", async () => {
    const r = await compileKirk(RESISTIVE("FSR()"))
    const t = feedTargets(r.doc!)
    for (const q of QUANTITY_LIST) expect(t.some((x) => x.target === `room.${q}`)).toBe(true)
    expect(t.find((x) => x.target === "S1")).toMatchObject({ kind: "sensor", sense: "force", unit: "N" })
  })
  it("every Kirk constructor compiles and round-trips", async () => {
    for (const m of SENSOR_MODELS) {
      // KiCad-symbol sensors: wired by their own pin numbers
      const wire: Record<string, string> = {
        pressure: "U1.1 -- VCC\n    U1.2 -- GND\n    U1.3 -- OUT\n    U1.4 -- nc\n    U1.5 -- nc\n    U1.6 -- nc",
        hall: "U1.1 -- VCC\n    U1.2 -- GND\n    U1.3 -- OUT", hallsw: "U1.1 -- VCC\n    U1.2 -- GND\n    U1.3 -- OUT",
        touch: "U1.5 -- VCC\n    U1.2 -- GND\n    U1.1 -- OUT\n    U1.3 -- nc\n    U1.4 -- nc\n    U1.6 -- GND",
        acs: "U1.8 -- VCC\n    U1.5 -- GND\n    U1.7 -- OUT\n    U1.2 -- VCC\n    U1.3 -- L\n    L -- R2 -- GND",
        loadcell: "U1.1 -- VCC\n    U1.2 -- GND\n    U1.3 -- OUT\n    U1.4 -- N\n    N -- R2 -- GND",
      }
      const src = m.shape === "resistive" ? RESISTIVE(`${m.kirk}()`) : wire[m.id]
        ? `circuit T {\n    ground GND\n    V1 = Vdc(5 V)\n    U1 = ${m.kirk}()\n    R1 = R(100k)\n    R2 = R(10k)\n    VCC -- V1 -- GND\n    OUT -- R1 -- GND\n    ${wire[m.id]}\n}\nsimulate op\n`
        : MODULE(`${m.kirk}()`)
      const r = await compileKirk(src)
      expect(r.diagnostics.filter((d) => d.severity === "error"), m.kirk).toEqual([])
      const back = generateKirk(r.doc!, deriveNetlist(r.doc!))
      expect(back, m.kirk).toContain(`${m.kirk}(`)
    }
    // a specific KiCad part by name, and parameters
    const p = await compileKirk(`circuit T {\n    ground GND\n    V1 = Vdc(5 V)\n    U1 = PressureSensor("40PC100G")\n    VCC -- V1 -- GND\n    U1.1 -- VCC\n    U1.2 -- GND\n    U1.3 -- nc\n    U1.4 -- nc\n    U1.5 -- nc\n    U1.6 -- nc\n}\nsimulate op\n`)
    // a short name picks the default package: A1301 → A1301xUA
    expect((await compileKirk(`circuit T {\n    ground GND\n    U1 = HallSensor("A1301")\n    U1.1 -- nc\n    U1.2 -- GND\n    U1.3 -- nc\n}\nsimulate op\n`)).doc!.parts.find((x) => x.ref === "U1")!.lib).toBe("Sensor_Magnetic:A1301xUA")
    expect(p.doc!.parts.find((x) => x.ref === "U1")!.lib).toBe("Sensor_Pressure:40PC100G")
    expect(generateKirk(p.doc!, deriveNetlist(p.doc!))).toContain(`PressureSensor("40PC100G")`)
    const g = await compileKirk(RESISTIVE("GasSensor(r0: 20k)"))
    expect(generateKirk(g.doc!, deriveNetlist(g.doc!))).toMatch(/GasSensor\(r0: 20k?\)/)
  })
})

describe.skipIf(!ngspice)("sensors respond on ngspice", () => {
  for (const [name, src, lo, hi, dir] of CASES) {
    it(`${name}: output ${dir === "up" ? "rises" : "falls"} from ${lo} to ${hi}`, async () => {
      const d = (await compileKirk(src)).doc!
      const target = d.parts.find((p) => p.ref === "S1" || p.ref === "U1")!.ref
      const a = op(await sim(feed(d, target, lo), "op"), "V(OUT)"), b = op(await sim(feed(d, target, hi), "op"), "V(OUT)")
      expect(Number.isFinite(a) && Number.isFinite(b)).toBe(true)
      if (dir === "up") expect(b).toBeGreaterThan(a + 0.05)
      else expect(b).toBeLessThan(a - 0.05)
    })
  }
  it("humidity module follows its datasheet line; Hall sensor and Hall switch on KiCad symbols", async () => {
    const h = (await compileKirk(MODULE("HumiditySensor()"))).doc!
    expect(op(await sim(feed(h, "U1", "50 %"), "op"), "V(OUT)")).toBeCloseTo(5 * (0.0062 * 50 + 0.16) * 100e3 / (100e3 + 100), 2)
    const hall = (await compileKirk(MODULE(`HallSensor("A1301xUA")`).replace("U1.VCC", "U1.1").replace("U1.GND", "U1.2").replace("U1.OUT", "U1.3"))).doc!
    const v0 = op(await sim(feed(hall, "U1", "0 mT"), "op"), "V(OUT)"), v20 = op(await sim(feed(hall, "U1", "20 mT"), "op"), "V(OUT)")
    expect(v0).toBeCloseTo(2.5 * 100e3 / 100.1e3, 2) // half supply with no field
    expect(v20 - v0).toBeCloseTo(0.5, 1) // 25 mV/mT
    const sw = (await compileKirk(MODULE(`HallSwitch("A1101xUA")`, true).replace("U1.VCC", "U1.1").replace("U1.GND", "U1.2").replace("U1.OUT", "U1.3"))).doc!
    expect(op(await sim(feed(sw, "U1", "0 mT"), "op"), "V(OUT)")).toBeGreaterThan(4.9) // pulled up
    expect(op(await sim(feed(sw, "U1", "30 mT"), "op"), "V(OUT)")).toBeLessThan(0.1) // switched low
  })
  it("load cell bridge and current sensor", async () => {
    const lc = (await compileKirk(`circuit T {\n    ground GND\n    V1 = Vdc(5 V)\n    U1 = LoadCell()\n    VCC -- V1 -- GND\n    U1.1 -- VCC\n    U1.2 -- GND\n    U1.3 -- P\n    U1.4 -- N\n}\nsimulate op\n`)).doc!
    const full = await sim(feed(lc, "U1", "49 N"), "op")
    expect(op(full, "V(P)") - op(full, "V(N)")).toBeCloseTo(5 * 0.002, 4) // 2 mV/V at full scale
    const cs = (await compileKirk(`circuit T {\n    ground GND\n    V1 = Vdc(5 V)\n    V2 = Vdc(5 V)\n    U1 = CurrentSensor()\n    RL = R(2.5)\n    R1 = R(100k)\n    VCC -- V1 -- GND\n    LOAD -- V2 -- GND\n    U1.8 -- VCC\n    U1.5 -- GND\n    U1.7 -- OUT\n    OUT -- R1 -- GND\n    U1.2 -- LOAD\n    U1.3 -- L2\n    L2 -- RL -- GND\n}\nsimulate op\n`)).doc!
    const r = await sim(cs, "op")
    // 2 A through the sensor: 2.5 V + 2 × 185 mV
    expect(op(r, "V(OUT)")).toBeCloseTo((2.5 + 2 * 0.185) * 100e3 / 100.1e3, 2)
    expect(r.names).toContain("I(U1)")
    expect(Math.abs(op(r, "I(U1)"))).toBeCloseTo(2, 3)
  })
  it("a time-varying feed through a response table: approaching object", async () => {
    const d = (await compileKirk(MODULE("DistanceSensor()"))).doc!
    const t: Doc = { ...feed(d, "U1", "ramp(from: 70 cm, to: 10 cm, over: 10 ms)"), analyses: { ...d.analyses, tran: { stop: 10e-3, step: 20e-6 } } }
    const r = await sim(t, "tran")
    if (r.type !== "tran") throw new Error("not a transient")
    const v = r.data[r.names.indexOf("V(OUT)")]
    expect(v[0]).toBeLessThan(0.7)
    expect(v[v.length - 1]).toBeGreaterThan(1.8)
    // the room property reaches every humidity sensor without its own feed
    const h = (await compileKirk(MODULE("HumiditySensor()"))).doc!
    const room = op(await sim(feed(h, "room.humidity", "80 %"), "op"), "V(OUT)")
    expect(room).toBeCloseTo(5 * (0.0062 * 80 + 0.16) * 100e3 / 100.1e3, 2)
  })
})
