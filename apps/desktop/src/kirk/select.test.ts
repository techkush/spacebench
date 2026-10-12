import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
import { describe, expect, it } from "vitest"
import { deriveNetlist } from "@/editor/netlist"
import { setLoader } from "@/lib/kicad"
import { compileKirk } from "./compile"
import { generateKirk } from "./generate"

const KICAD = path.resolve(import.meta.dirname, "../../public/kicad")
setLoader(async (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(KICAD, `${f}.gz`))).toString()))

const errors = (r: Awaited<ReturnType<typeof compileKirk>>) => r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`)

describe("for loops", () => {
  it("unrolls parts and wiring, with arithmetic in names", async () => {
    const r = await compileKirk(`circuit Ladder {
    supply VCC = 5 V
    ground GND
    for i in 1..4 {
        R{i} = R(1k)
        N{i} -- R{i} -- N{i+1}
    }
    VCC -- N1
    N5 -- GND
}`)
    expect(errors(r)).toEqual([])
    expect(r.ir!.parts.map((p) => p.ref).filter((x) => x.startsWith("R"))).toEqual(["R1", "R2", "R3", "R4"])
    const net = (ref: string, n: string) => r.ir!.nets.find((x) => x.pins.some((p) => p.ref === ref && p.n === n))!.name
    expect(net("R1", "2")).toBe(net("R2", "1"))
    expect(net("R4", "2")).toBe("GND")
  })
  it("nests and runs over lists", async () => {
    const r = await compileKirk(`circuit Grid {
    ground GND
    for row in [1, 2] {
        for col in 1..3 {
            R{row}{col} = R(1k)
            R{row}{col} -- GND
            R{row}{col}.2 -- GND
        }
    }
}`)
    expect(r.ir!.parts.map((p) => p.ref)).toEqual(["R11", "R12", "R13", "R21", "R22", "R23"])
  })
  it("reports a name with an unknown variable", async () => {
    const r = await compileKirk(`circuit X {
    ground GND
    R{j} = R(1k)
}`)
    expect(errors(r).join()).toMatch(/V505/)
  })
})

describe("properties and selections", () => {
  const SRC = `circuit Amp {
    supply VCC = 5 V
    ground GND
    R1 = R(10k)
    R2 = R(10k)
    R3 = R(4.7k)
    C1 = C(100 nF)
    C2 = C(10 uF)
    VCC -- R1 -- MID -- R2 -- GND
    MID -- R3 -- OUT -- C1 -- GND
    VCC -- C2 -- GND

    parts(R*).footprint = "Resistor_SMD:R_0603_1608Metric"
    parts(R*, value: 10k).MPN = "RC0603FR-0710KL"
    R3.MPN = "RC0603FR-074K7L"
    parts(C*, on: VCC).footprint = "Capacitor_SMD:C_1206_3216Metric"
    C1.footprint = "Capacitor_SMD:C_0603_1608Metric"
    parts(/C[0-9]+/).tol = 10 %
    R3.\`Manufacturer\` = "Yageo"
}`
  it("sets one part's or a whole selection's properties", async () => {
    const r = await compileKirk(SRC)
    expect(errors(r)).toEqual([])
    const p = (ref: string) => r.doc!.parts.find((x) => x.ref === ref)!
    expect(p("R1").footprint).toBe("Resistor_SMD:R_0603_1608Metric")
    expect(p("R3").footprint).toBe("Resistor_SMD:R_0603_1608Metric")
    expect(p("R1").fields?.MPN).toBe("RC0603FR-0710KL")
    expect(p("R2").fields?.MPN).toBe("RC0603FR-0710KL")
    expect(p("R3").fields?.MPN).toBe("RC0603FR-074K7L")
    expect(p("R3").fields?.Manufacturer).toBe("Yageo")
    expect(p("C2").footprint).toBe("Capacitor_SMD:C_1206_3216Metric")
    expect(p("C1").footprint).toBe("Capacitor_SMD:C_0603_1608Metric")
    expect(p("C1").fields?.Tolerance).toBe("10")
  })
  it("keeps footprints and fields when the code is made again from the schematic", async () => {
    const r = await compileKirk(SRC)
    const again = generateKirk(r.doc!, deriveNetlist(r.doc!))
    const r2 = await compileKirk(again)
    expect(errors(r2)).toEqual([])
    for (const ref of ["R1", "R3", "C1", "C2"]) {
      const a = r.doc!.parts.find((x) => x.ref === ref)!, b = r2.doc!.parts.find((x) => x.ref === ref)!
      expect([b.footprint, b.fields]).toEqual([a.footprint, a.fields])
    }
  })
  it("warns when a selection picks nothing, errors on an unknown part", async () => {
    const r = await compileKirk(SRC.replace("R3.MPN", "R9.MPN").replace("parts(R*).footprint", "parts(Q*).footprint"))
    expect(r.diagnostics.map((d) => d.code)).toEqual(expect.arrayContaining(["V504", "V204"]))
  })
})

describe("checks", () => {
  const base = (checks: string) => `circuit Div {
    supply VCC = 5 V
    ground GND
    R1 = R(10k)
    R2 = R(10k)
    R3 = R(1k)
    C1 = C(100 nF)
    VCC -- R1 -- MID -- R2 -- GND
    MID -- R3 -- OUT -- C1 -- GND
    R1.footprint = "Resistor_SMD:R_0603_1608Metric"
${checks}
}`
  it("passes when the design holds", async () => {
    const r = await compileKirk(base(`    check connected(R3.2, C1.1)
    check connected(R1, R2, MID)
    check connected(OUT, C1)
    check not connected(R3.2, VCC)
    check parts(R*).count == 3
    check parts(R*, value: 10k).value == 10k
    check parts(C*, value: 100n).count == 1`))
    expect(errors(r)).toEqual([])
  })
  it("fails with what is wrong", async () => {
    const r = await compileKirk(base(`    check connected(R3.2, VCC)
    check parts(R*).footprint
    check parts(R*).count >= 4
    check not connected(R1, MID)`))
    const e = errors(r)
    expect(e).toHaveLength(4)
    expect(e[0]).toMatch(/V510 check failed: R3\.2, VCC are not connected \(R3\.2: OUT, VCC: VCC\)/)
    expect(e[1]).toMatch(/no footprint on R2, R3/)
    expect(e[2]).toMatch(/3 parts selected, expected >= 4/)
    expect(e[3]).toMatch(/expected not/)
  })
})
