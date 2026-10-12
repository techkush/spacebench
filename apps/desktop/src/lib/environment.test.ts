import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
import { describe, expect, it } from "vitest"

import type { Doc } from "@/editor/model"
import { deriveNetlist } from "@/editor/netlist"
import { remap, type JobResult } from "@/lib/engine"
import { setLoader } from "@/lib/kicad"
import { buildNetlist } from "@/lib/spice"
import { compileKirk } from "@/kirk/compile"
import { generateKirk } from "@/kirk/generate"
import { run } from "../../vite-ngspice"
import { KIRK_EXAMPLES } from "@/editor/examples"
import { setPotPos } from "@/editor/inputs"
import { ldrResistance, micAmplitude, ntcResistance, tempSensorVolts } from "./environment"

const KICAD = path.resolve(import.meta.dirname, "../../public/kicad")
setLoader(async (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(KICAD, `${f}.gz`))).toString()))
const ngspice = ["/opt/homebrew/bin/ngspice", "/usr/local/bin/ngspice", "/usr/bin/ngspice"].find((p) => fs.existsSync(p))

async function sim(doc: Doc, a: "op" | "tran"): Promise<JobResult> {
  const net = buildNetlist(doc, deriveNetlist(doc), a)
  const r = await run(net.text)
  if (r.status !== 200) throw new Error(`${r.body}\n${net.text}`)
  return remap(JSON.parse(r.body) as JobResult, net)
}
const opValue = (r: JobResult, name: string) => (r.type === "op" ? r.values[r.names.indexOf(name)] : NaN)
/** add feeds (Kirk stimulus lines) to a circuit: { "room.light": "1 lux" } */
const withFeeds = (d: Doc, f: Record<string, string>, seed?: number): Doc => ({ ...d, stimulus: { feeds: [...(d.stimulus?.feeds ?? []).filter((x) => !(x.target in f)), ...Object.entries(f).map(([target, expr]) => ({ target, expr }))], ...(seed !== undefined ? { seed } : {}) } })
const withRoom = (d: Doc, env: Partial<Record<"light" | "temp" | "sound" | "tone", number>>): Doc =>
  withFeeds(d, Object.fromEntries(Object.entries(env).map(([k, v]) => [`room.${k}`, `${v} ${({ light: "lux", temp: "°C", sound: "dB", tone: "Hz" } as Record<string, string>)[k]}`])))

const NIGHT_LIGHT = `@title("Night light")
circuit NightLight {
    ground GND
    V1 = Vdc(5 V)
    R1 = R(10k)
    LDR1 = LDR()
    R2 = R(4.7k)
    Q1 = NPN("2N3904")
    R3 = R(220)
    D1 = LED("Green")
    VCC -- V1 -- GND
    VCC -- R1 -- S -- LDR1 -- GND
    VCC -- R3 -- A -- D1' -- C
    Q1.C -- C
    Q1.B -- B
    Q1.E -- GND
    S -- R2 -- B
}

stimulus {
    room.light = 300 lux
}

simulate op
`

describe("room physics", () => {
  it("sensor curves have the right shape", () => {
    expect(ldrResistance(10)).toBeCloseTo(10e3)
    expect(ldrResistance(1000)).toBeLessThan(ldrResistance(10) / 10)
    expect(ldrResistance(0)).toBe(1e6) // dark resistance cap
    expect(ntcResistance(25, 10e3)).toBeCloseTo(10e3)
    expect(ntcResistance(50, 10e3)).toBeCloseTo(3588, -1) // β 3950: 10k NTC at 50 °C ≈ 3.6k
    expect(micAmplitude(94)).toBeCloseTo(0.0112, 3) // 1 Pa → 7.9 mV rms
    expect(micAmplitude(74)).toBeCloseTo(micAmplitude(94) / 10, 6)
    expect(tempSensorVolts(25, "LM35")).toBeCloseTo(0.25)
    expect(tempSensorVolts(25, "TMP36")).toBeCloseTo(0.75)
  })
})

describe("Kirk environment block and input parts", () => {
  it("compiles, round-trips and validates units", async () => {
    const r = await compileKirk(NIGHT_LIGHT)
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    expect(r.doc!.stimulus).toEqual({ feeds: [{ target: "room.light", expr: "300 lux" }] })
    expect(r.doc!.parts.find((p) => p.ref === "LDR1")!.lib).toBe("Device:R_Photo")
    const back = generateKirk(r.doc!, deriveNetlist(r.doc!))
    expect(back).toMatch(/stimulus \{\n {4}room\.light = 300 lux\n\}/)
    expect(back).toMatch(/LDR1 = LDR\(\)/)
    const again = await compileKirk(back)
    expect(again.doc!.stimulus).toEqual(r.doc!.stimulus)

    const all = await compileKirk(`circuit Inputs {
    ground GND
    V1 = Vdc(5 V)
    TH1 = Thermistor(10k, beta: 3435)
    MK1 = Mic()
    U1 = TempSensor("LM35")
    RV1 = Slider(10k, pos: 0.25)
    SW1 = Button()
    D1 = Photodiode()
    VCC -- V1 -- GND
    VCC -- TH1 -- GND
    VCC -- MK1 -- GND
    U1.1 -- VCC
    U1.3 -- GND
    U1.2 -- OUT
    VCC -- RV1.1
    RV1.3 -- GND
    RV1.2 -- W
    VCC -- SW1 -- GND
    VCC -- D1 -- GND
}
environment {
    light: 2k lux
    temp: -10°C
    sound: 70 dB
    tone: 440 Hz
}
simulate op
`)
    expect(all.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    // the first room syntax still works: it becomes room feeds
    expect(all.doc!.stimulus!.feeds.map((f) => `${f.target} = ${f.expr}`)).toEqual(["room.light = 2k lux", "room.temp = -10°C", "room.sound = 70 dB", "room.tone = 440 Hz"])
    const k = generateKirk(all.doc!, deriveNetlist(all.doc!))
    if (process.env.SHOW_KIRK) console.log(k)
    for (const s of ["Thermistor(10k, beta: 3435)", "Mic()", `TempSensor("LM35")`, "Slider(10k, pos: 0.25)", "Photodiode()", "SW1 = Button()", "room.temp = -10°C", "room.tone = 440 Hz"]) expect(k).toContain(s)

    const bad = await compileKirk(NIGHT_LIGHT.replace("room.light = 300 lux", "room.light = 300 V\n    smell = 3\n    LDR1 = wobble(2)"))
    const msgs = bad.diagnostics.map((d) => d.message)
    expect(bad.ok).toBe(true) // bad feeds are warnings: the circuit still compiles
    expect(msgs).toEqual(expect.arrayContaining([
      "room.light: room.light takes lx (light for every sensor without its own feed), not V",
      expect.stringMatching(/^smell: nothing called “smell” takes a feed — inputs: V1, LDR1, /),
      "LDR1: unknown signal “wobble” — use ramp, step, sine, square, random, normal, noise, walk, samples or pwl",
    ]))
  })

  it("the netlist follows the room", async () => {
    const r = await compileKirk(NIGHT_LIGHT)
    const text = (env: Doc["environment"]) => buildNetlist(withRoom(r.doc!, env), deriveNetlist(r.doc!), "op").text
    const rOf = (t: string) => Number(/^RLDR1 \S+ \S+ (\S+)/m.exec(t)![1].replace("Meg", "e6").replace("k", "e3"))
    expect(rOf(text({ light: 10 }))).toBeCloseTo(10e3, -1)
    expect(rOf(text({ light: 10000 }))).toBeLessThan(1000)
    // a room temperature only becomes .temp when it is set
    expect(text({})).not.toMatch(/^\.temp/m)
    expect(text({ temp: 40 })).toMatch(/^\.temp 40$/m)
  })
})

describe.skipIf(!ngspice)("circuits react to the room (ngspice)", () => {
  it("night light: LED off in daylight, on in the dark", async () => {
    const doc = (await compileKirk(NIGHT_LIGHT)).doc!
    const led = async (light: number) => opValue(await sim(withRoom(doc, { light }), "op"), "I(D1)")
    const day = await led(10000), dark = await led(1)
    expect(day).toBeLessThan(1e-4)
    expect(dark).toBeGreaterThan(5e-3)
  })
  it("LM35 output tracks temperature, NTC divider moves with it", async () => {
    const doc = (await compileKirk(`circuit Thermo {
    ground GND
    V1 = Vdc(5 V)
    U1 = TempSensor("LM35")
    TH1 = Thermistor(10k)
    R1 = R(10k)
    U1.1 -- VCC
    U1.3 -- GND
    U1.2 -- T
    VCC -- V1 -- GND
    VCC -- R1 -- N -- TH1 -- GND
}
simulate op
`)).doc!
    const at = async (temp: number) => { const r = await sim(withRoom(doc, { temp }), "op"); return { t: opValue(r, "V(T)"), n: opValue(r, "V(N)") } }
    const cold = await at(0), hot = await at(60)
    expect(cold.t).toBeCloseTo(0, 3)
    expect(hot.t).toBeCloseTo(0.6, 3)
    expect(hot.n).toBeLessThan(cold.n) // NTC falls when hot
  })
  it("microphone plays the room's tone at the right level", async () => {
    const doc = (await compileKirk(`circuit MicTest {
    ground GND
    MK1 = Mic()
    R1 = R(1Meg)
    O -- MK1 -- GND
    O -- R1 -- GND
}
environment {
    sound: 94 dB
    tone: 500 Hz
}
simulate tran(stop: 10 ms, step: 10 us)
`)).doc!
    const r = await sim(doc, "tran")
    if (r.type !== "tran") throw new Error("not a transient")
    const v = r.data[r.names.indexOf("V(O)")]
    const peak = Math.max(...v.map(Math.abs))
    expect(peak).toBeGreaterThan(0.0105)
    expect(peak).toBeLessThan(0.0113)
    expect(r.names.some((n) => n.includes("sbint"))).toBe(false)
  })
  it("sensor examples behave: night light, thermostat fan, dimmer", async () => {
    // the examples' own feeds are transients; check the operating point at fixed conditions
    const ex = async (id: string) => ({ ...(await compileKirk(KIRK_EXAMPLES.find((e) => e.id === id)!.kirk)).doc!, stimulus: undefined })
    const nl = await ex("night-light")
    expect(opValue(await sim(withRoom(nl, { light: 1 }), "op"), "I(D1)")).toBeGreaterThan(5e-3)
    expect(opValue(await sim(withRoom(nl, { light: 10000 }), "op"), "I(D1)")).toBeLessThan(1e-4)
    const th = await ex("thermostat")
    const fan = async (temp: number) => Math.abs(opValue(await sim(withRoom(th, { temp }), "op"), "I(M1)"))
    expect(await fan(35)).toBeGreaterThan(0.3) // 12 V across 20 Ω
    expect(await fan(18)).toBeLessThan(1e-3)
    const dm = await ex("dimmer")
    const at = async (pos: number) => opValue(await sim({ ...dm, parts: dm.parts.map((p) => (p.ref === "RV1" ? setPotPos(p, pos) : p)) }, "op"), "I(D1)")
    const low = await at(0.15), mid = await at(0.5), high = await at(0.95)
    expect(low).toBeLessThan(mid)
    expect(mid).toBeLessThan(high)
    expect(high).toBeGreaterThan(5e-3)
  })
  it("time-varying feeds: light ramp, sagging supply, switched load", async () => {
    const nl = (await compileKirk(NIGHT_LIGHT)).doc!
    const tranOf = (d: Doc): Doc => ({ ...d, analyses: { ...d.analyses, tran: { stop: 20e-3, step: 20e-6 } } })
    // dusk: light falls from 10 klx to 0.1 lx over 20 ms — the LED is off at the start, on at the end
    const dusk = await sim(tranOf(withFeeds(nl, { LDR1: "ramp(from: 10k lux, to: 0.1 lux, over: 20 ms)" })), "tran")
    if (dusk.type !== "tran") throw new Error("not a transient")
    const led = dusk.data[dusk.names.indexOf("I(D1)")], ldr = dusk.data[dusk.names.indexOf("I(LDR1)")]
    expect(led[0]).toBeLessThan(1e-4)
    expect(led[led.length - 1]).toBeGreaterThan(5e-3)
    expect(ldr.some((v) => Math.abs(v) > 1e-6)).toBe(true) // the behavioural LDR still reports its current
    // the 5 V supply sags to 3 V: the LED current at the end follows (dark room)
    const sag = await sim(tranOf(withFeeds(nl, { "room.light": "1 lux", V1: "ramp(from: 5 V, to: 3 V, over: 20 ms)" })), "tran")
    if (sag.type !== "tran") throw new Error("not a transient")
    const vcc = sag.data[sag.names.indexOf("V(VCC)")], ledS = sag.data[sag.names.indexOf("I(D1)")]
    expect(vcc[0]).toBeCloseTo(5, 2)
    expect(vcc[vcc.length - 1]).toBeCloseTo(3, 2)
    expect(ledS[ledS.length - 1]).toBeLessThan(ledS[0])
    // static feed at t = 0 for an operating point
    const op = await sim(withFeeds(nl, { "room.light": "1 lux", V1: "ramp(from: 4 V, to: 9 V, over: 20 ms)" }), "op")
    expect(opValue(op, "V(VCC)")).toBeCloseTo(4, 6)
  })
  it("seeded random feeds are reproducible, and differ with another seed", async () => {
    const nl = (await compileKirk(NIGHT_LIGHT)).doc!
    const d = (seed: number) => ({ ...withFeeds(nl, { V1: "5 V + noise(sd: 0.3 V, every: 0.5 ms)" }, seed), analyses: { ...nl.analyses, tran: { stop: 10e-3, step: 20e-6 } } })
    const net = (seed: number) => buildNetlist(d(seed), deriveNetlist(nl), "tran").text
    expect(net(7)).toBe(net(7))
    expect(net(7)).not.toBe(net(8))
    const r = await sim(d(7), "tran")
    if (r.type !== "tran") throw new Error("not a transient")
    const v = r.data[r.names.indexOf("V(VCC)")]
    const mean = v.reduce((a, b) => a + b, 0) / v.length, sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length)
    expect(mean).toBeCloseTo(5, 0)
    expect(sd).toBeGreaterThan(0.15)
    expect(sd).toBeLessThan(0.45)
  })
  it("the examples' own feeds do what their descriptions say", async () => {
    const run = async (id: string) => { const d = (await compileKirk(KIRK_EXAMPLES.find((e) => e.id === id)!.kirk)).doc!; const r = await sim(d, "tran"); if (r.type !== "tran") throw new Error("not a transient"); return r }
    const nl = await run("night-light"), led = nl.data[nl.names.indexOf("I(D1)")]
    expect(led[0]).toBeLessThan(1e-4)
    expect(led[led.length - 1]).toBeGreaterThan(5e-3)
    const dm = await run("dimmer"), ld = dm.data[dm.names.indexOf("I(D1)")]
    expect(ld[Math.floor(ld.length * 0.2)]).toBeLessThan(ld[Math.floor(ld.length * 0.9)])
    const th = await run("thermostat"), fan = th.data[th.names.indexOf("I(M1)")].map(Math.abs)
    // the drifting temperature crosses the set point: the fan is on some of the time, off some of the time
    expect(fan.some((i) => i > 0.3)).toBe(true)
    expect(fan.some((i) => i < 1e-3)).toBe(true)
  })
})
