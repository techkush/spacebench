import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
import { describe, expect, it } from "vitest"

import type { Doc } from "@/editor/model"
import { deriveNetlist } from "@/editor/netlist"
import { KIRK_EXAMPLES } from "@/editor/examples"
import { remap, type JobResult } from "@/lib/engine"
import { setLoader } from "@/lib/kicad"
import { buildNetlist } from "@/lib/spice"
import { compileKirk } from "@/kirk/compile"
import { run } from "../../vite-ngspice"
import { partReports, stats } from "./stress"

const KICAD = path.resolve(import.meta.dirname, "../../public/kicad")
setLoader(async (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(KICAD, `${f}.gz`))).toString()))
const ngspice = ["/opt/homebrew/bin/ngspice", "/usr/local/bin/ngspice", "/usr/bin/ngspice"].find((p) => fs.existsSync(p))

async function sim(doc: Doc, a: "op" | "tran"): Promise<JobResult> {
  const net = buildNetlist(doc, deriveNetlist(doc), a)
  const r = await run(net.text)
  if (r.status !== 200) throw new Error(r.body)
  return remap(JSON.parse(r.body) as JobResult, net)
}

describe("stats", () => {
  it("time-weighted average and rms", () => {
    // 1 for 1 s, then 3 for 3 s (uneven steps): average 2.5, not 2
    const s = stats([1, 1, 3, 3], [0, 1, 1, 4])
    expect(s.avg).toBeCloseTo(2.5)
    expect(s.max).toBe(3)
    expect(s.peak).toBe(3)
  })
})

describe.skipIf(!ngspice)("part stress (ngspice)", () => {
  it("a dark night light with a 47 Ω LED resistor overdrives the LED; the 220 Ω one is fine", async () => {
    const kirk = KIRK_EXAMPLES.find((e) => e.id === "night-light")!.kirk
    const dark = (d: Doc): Doc => ({ ...d, stimulus: { feeds: [{ target: "LDR1", expr: "1 lux" }] } })
    const ok = dark((await compileKirk(kirk)).doc!)
    const hot = dark((await compileKirk(kirk.replace("R3 = R(220)", "R3 = R(47)"))).doc!)
    const rep = async (d: Doc) => partReports(d, deriveNetlist(d), await sim(d, "op"))
    const okR = await rep(ok), hotR = await rep(hot)
    const led = (r: Awaited<ReturnType<typeof rep>>) => r.find((p) => p.ref === "D1")!
    expect(led(okR).worst).toBe("ok")
    expect(led(hotR).worst).toBe("over")
    const fwd = led(hotR).checks.find((c) => c.what === "Forward current")!
    expect(fwd.value).toBeGreaterThan(0.03)
    expect(hotR[0].ref).toBe("D1") // most stressed first
    // every simulated part has a report with voltage and current
    for (const r of okR.filter((p) => p.label.startsWith("Resistor"))) { expect(r.v).not.toBeNull(); expect(r.i).not.toBeNull() }
    // derating 50 %: the healthy LED (≈ 14 mA of 15 mA allowed) becomes a warning or worse
    const derated = partReports(ok, deriveNetlist(ok), await sim(ok, "op"), 0.5)
    expect(derated.find((p) => p.ref === "D1")!.checks[0].pct).toBeGreaterThan(led(okR).checks[0].pct * 1.9)
  })
  it("transient stats: the fed supply's average and the switch-fed thermostat fan power", async () => {
    const th = (await compileKirk(KIRK_EXAMPLES.find((e) => e.id === "thermostat")!.kirk)).doc!
    const d: Doc = { ...th, stimulus: { feeds: [{ target: "TH1", expr: "square(low: 15°C, high: 40°C, period: 10 ms)" }] }, analyses: { ...th.analyses, tran: { stop: 20e-3, step: 20e-6 } } }
    const r = await sim(d, "tran")
    const reps = partReports(d, deriveNetlist(d), r)
    const motor = reps.find((p) => p.ref === "M1")!
    expect(motor.label).toBe("DC motor")
    expect(motor.checks).toEqual([]) // a motor is not judged as a ¼ W resistor
    // the fan runs half the time: average power ≈ half of 12 V² / 20 Ω
    expect(motor.p!.avg).toBeGreaterThan(1.5)
    expect(motor.p!.avg).toBeLessThan(5.5)
    expect(motor.p!.max).toBeGreaterThan(6)
    const supply = reps.find((p) => p.ref === "V1")!
    expect(supply.v!.avg).toBeCloseTo(12, 3)
    expect(supply.p!.min).toBeLessThan(-6) // delivering power
  })
})
