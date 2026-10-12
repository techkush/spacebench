import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
import { describe, expect, it } from "vitest"

import type { Doc } from "@/editor/model"
import { deriveNetlist } from "@/editor/netlist"
import { remap, type JobResult } from "@/lib/engine"
import { setLoader } from "@/lib/kicad"
import { buildNetlist } from "@/lib/spice"
import { run } from "../../vite-ngspice"
import { compileKirk, type CompileOptions } from "./compile"
import { refreshVariants } from "./components"
import { generateKirk } from "./generate"
import { runMeasures } from "./measure"

const KICAD = path.resolve(import.meta.dirname, "../../public/kicad")
setLoader(async (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(KICAD, `${f}.gz`))).toString()))
const ngspice = ["/opt/homebrew/bin/ngspice", "/usr/local/bin/ngspice", "/usr/bin/ngspice"].find((p) => fs.existsSync(p))

async function sim(doc: Doc, a: "op" | "ac" | "tran"): Promise<JobResult> {
  const net = buildNetlist(doc, deriveNetlist(doc), a)
  const r = await run(net.text)
  if (r.status !== 200) throw new Error(`${r.body}\n${net.text}`)
  return remap(JSON.parse(r.body) as JobResult, net)
}
const fc = (r: JobResult, sig: string) => { const m = runMeasures([{ name: "f", expr: `fc(${sig})` }], r).f; return m.ok ? m.value.value : NaN }

const RC = `component RCLowPass(r: Resistance = 1.6k, c: Capacitance = 100n) {
    description "first-order RC low-pass"
    pins in, out, gnd
    R1 = R(r)
    C1 = C(c)
    in -- R1 -- out -- C1 -- gnd
}
`
const TWO = `${RC}
circuit Two {
    ground GND
    V1 = Vsin(amp: 1 V, freq: 1 kHz, ac: 1 V)
    F1 = RCLowPass()
    F2 = RCLowPass(r: 3.2k)
    IN -- V1 -- GND
    F1.in -- IN
    F1.out -- A
    F1.gnd -- GND
    F2.in -- IN
    F2.out -- B
    F2.gnd -- GND
}
simulate ac(from: 10 Hz, to: 100 kHz, points: 40/dec)
`

describe("Kirk components", () => {
  it("compile into boxes with the component's pins, one subcircuit per parameter set", async () => {
    const r = await compileKirk(TWO)
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    const f1 = r.doc!.parts.find((p) => p.ref === "F1")!, f2 = r.doc!.parts.find((p) => p.ref === "F2")!
    expect(f1.lib).toBe("kirk:RCLowPass")
    expect(f1.sim?.Name).not.toBe(f2.sim?.Name)
    expect(Object.keys(r.doc!.components![0].variants)).toHaveLength(2)
    const net = buildNetlist(r.doc!, deriveNetlist(r.doc!), "ac").text
    expect(net).toMatch(new RegExp(`^\\.subckt ${f2.sim!.Name} in out 0`, "m"))
    expect(net).toMatch(/^XF1 in a 0 K_RCLOWPASS_/m)
  })
  it("round-trips: definitions stay as written, instances keep their parameters", async () => {
    const r = await compileKirk(TWO)
    const back = generateKirk(r.doc!, deriveNetlist(r.doc!))
    expect(back).toContain(RC.trim())
    expect(back).toMatch(/F2 = RCLowPass\(r: 3\.2kΩ, c: 100nF\)/)
    const again = await compileKirk(back, r.doc)
    expect(again.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    expect(buildNetlist(again.doc!, deriveNetlist(again.doc!), "ac").text.split("\n").filter((l) => /^X|^\.subckt/.test(l)).sort())
      .toEqual(buildNetlist(r.doc!, deriveNetlist(r.doc!), "ac").text.split("\n").filter((l) => /^X|^\.subckt/.test(l)).sort())
  })
  it("explains mistakes", async () => {
    const bad = await compileKirk(TWO.replace("RCLowPass(r: 3.2k)", "RCLowPass(rr: 3.2k)"))
    expect(bad.diagnostics.map((d) => d.message)).toContain("RCLowPass has no parameter “rr” (parameters: r, c)")
    const unit = await compileKirk(TWO.replace("RCLowPass(r: 3.2k)", "RCLowPass(r: 3.2 V)"))
    expect(unit.diagnostics.map((d) => d.message)).toContain("r is a resistance (Ω), not V")
    const nopins = await compileKirk(TWO.replace("    pins in, out, gnd\n", ""))
    expect(nopins.diagnostics.some((d) => /add a {2}pins/.test(d.message))).toBe(true)
    const loop = await compileKirk(`component Loop() {\n    pins a\n    X1 = Loop()\n    X1.a -- a\n}\ncircuit T {\n    ground GND\n    U1 = Loop()\n    U1.a -- GND\n}\nsimulate op\n`)
    expect(loop.diagnostics.some((d) => /nested more than 8 deep/.test(d.message))).toBe(true)
  })
  it("a library file (no circuit) is checked component by component", async () => {
    const ok = await compileKirk(`library Filters version "1.0.0"\n${RC}`)
    expect(ok.ok).toBe(true)
    const broken = await compileKirk(`library Filters version "1.0.0"\n${RC.replace("R1 = R(r)", "R1 = R(r)\n    X9 = Wobble()")}`)
    expect(broken.ok).toBe(false)
  })
})

describe.skipIf(!ngspice)("components simulate (ngspice)", () => {
  it("two instances, two corner frequencies", async () => {
    const r = await compileKirk(TWO)
    const ac = await sim(r.doc!, "ac")
    expect(fc(ac, "V(A)")).toBeGreaterThan(960)
    expect(fc(ac, "V(A)")).toBeLessThan(1030)
    expect(fc(ac, "V(B)")).toBeGreaterThan(480)
    expect(fc(ac, "V(B)")).toBeLessThan(515)
  })
  it("components inside components, expressions and text parameters", async () => {
    const src = `${RC}
component TwoPole(f: Frequency = 1 kHz, c: Capacitance = 10n) {
    pins in, out, gnd
    A = RCLowPass(r: 1 / (2 * pi * f * c), c: c)
    B = RCLowPass(r: 1 / (2 * pi * f * c), c: c / 10)
    A.in -- in
    A.out -- mid
    A.gnd -- gnd
    B.in -- mid
    B.out -- out
    B.gnd -- gnd
}
component Follower(q: Model = "2N3904", re: Resistance = 1k) {
    pins in, out, vcc, gnd
    Q1 = NPN(q)
    RE = R(re)
    Q1.B -- in
    Q1.C -- vcc
    Q1.E -- out
    out -- RE -- gnd
}
circuit Nested {
    ground GND
    V1 = Vsin(amp: 1 V, freq: 1 kHz, ac: 1 V, offset: 3 V)
    V2 = Vdc(9 V)
    P1 = TwoPole(f: 2 kHz)
    U1 = Follower(q: "BC547")
    IN -- V1 -- GND
    VCC -- V2 -- GND
    P1.in -- IN
    P1.out -- F
    P1.gnd -- GND
    U1.in -- IN
    U1.out -- E
    U1.vcc -- VCC
    U1.gnd -- GND
}
simulate ac(from: 10 Hz, to: 1 MHz, points: 40/dec)
`
    const r = await compileKirk(src)
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    const ac = await sim(r.doc!, "ac")
    // two RC stages (the second lightly loaded): the −3 dB point lands just under 2 kHz
    expect(fc(ac, "V(F)")).toBeGreaterThan(1200)
    expect(fc(ac, "V(F)")).toBeLessThan(2000)
    const op = await sim(r.doc!, "op")
    const ve = op.type === "op" ? op.values[op.names.indexOf("V(E)")] : NaN
    expect(ve).toBeGreaterThan(2.2) // emitter follower: 3 V − Vbe
    expect(ve).toBeLessThan(2.5)
    expect(buildNetlist(r.doc!, deriveNetlist(r.doc!), "op").text).toMatch(/\.model BC547/)
  })
  it("imports a project library file and a user library", async () => {
    const files: Record<string, string> = { "lib/filters.kirk": `library Filters version "1.2.0"\n${RC}` }
    const opts: CompileOptions = { resolve: async (p, library) => (library ? (p === "Filters" ? { text: files["lib/filters.kirk"], path: "library:Filters" } : null) : files[p] ? { text: files[p], path: p } : null) }
    const src = TWO.replace(RC, `import "lib/filters.kirk"\n`)
    const r = await compileKirk(src, null, opts)
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    expect(r.doc!.components![0]).toMatchObject({ name: "RCLowPass", from: "lib/filters.kirk", library: { name: "Filters", version: "1.2.0" } })
    expect(fc(await sim(r.doc!, "ac"), "V(B)")).toBeGreaterThan(480)
    // the import line comes back, the component's source does not (it lives in its file)
    const back = generateKirk(r.doc!, deriveNetlist(r.doc!))
    expect(back).toContain(`import "lib/filters.kirk"`)
    expect(back).not.toContain("component RCLowPass")
    const lib = await compileKirk(TWO.replace(RC, `import library "Filters"\n`), null, opts)
    expect(lib.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    const missing = await compileKirk(TWO.replace(RC, `import library "Nope"\n`), null, opts)
    expect(missing.diagnostics.map((d) => d.message)).toContain("no library “Nope” — create it in Libraries, or check the name")
  })
  it("a parameter changed outside Kirk (Inspector) compiles its new subcircuit", async () => {
    const r = await compileKirk(TWO)
    const edited: Doc = { ...r.doc!, parts: r.doc!.parts.map((p) => (p.ref === "F2" ? { ...p, sim: { ...p.sim, Params: "r=6.4k c=100n" } } : p)) }
    const fresh = await refreshVariants(edited, (s, o) => compileKirk(s, null, o))
    expect(fresh).not.toBeNull()
    expect(fc(await sim(fresh!, "ac"), "V(B)")).toBeLessThan(260)
  })
})
