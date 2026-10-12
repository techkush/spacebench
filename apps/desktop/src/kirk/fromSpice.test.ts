import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import zlib from "node:zlib"
import { spawnSync } from "node:child_process"
import { describe, expect, it } from "vitest"

import { isVirtual } from "@/editor/model"
import { deriveNetlist } from "@/editor/netlist"
import { setLoader } from "@/lib/kicad"
import { buildNetlist, optionsLine } from "@/lib/spice"
import { compileKirk } from "./compile"
import { spiceToKirk, spiceValue } from "./fromSpice"

const KICAD = path.resolve(import.meta.dirname, "../../public/kicad")
setLoader(async (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(KICAD, `${f}.gz`))).toString()))
const ngspice = ["/opt/homebrew/bin/ngspice", "/usr/local/bin/ngspice", "/usr/bin/ngspice"].find((p) => fs.existsSync(p))

function measure(text: string, meas: string[]): Record<string, number> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbimp-"))
  const file = path.join(dir, "c.cir")
  fs.writeFileSync(file, `${text}\n.control\nrun\n${meas.join("\n")}\n.endc\n.end\n`)
  const out = spawnSync(ngspice!, ["-b", file], { encoding: "utf8" })
  fs.rmSync(dir, { recursive: true, force: true })
  const vals: Record<string, number> = {}
  for (const m of (out.stdout + out.stderr).matchAll(/^(\w+)\s+=\s+([-+\d.eE]+)/gm)) vals[m[1]] = parseFloat(m[2])
  return vals
}

const RC = `RC low-pass from a netlist
* corner = 1/(2*pi*1.6k*100n) = 995 Hz
V1 in 0 DC 0 AC 1
R1 in out 1.6k
C1 out 0 100n
.ac dec 40 10 100k
.end
`

const CE = `Common emitter
VCC vcc 0 12
VIN in 0 SIN(0 10m 1k) AC 1
C1 in b 10u
R1 vcc b 47k
R2 b 0 10k
RC vcc c 4.7k
RE e 0 1k
Q1 c b e Q2N3904
.model Q2N3904 NPN(IS=6.7f BF=416)
.tran 10u 5m
.end
`

describe("SPICE number parsing", () => {
  it("uses SPICE prefixes (m = milli, meg = mega)", () => {
    expect([spiceValue("1k"), spiceValue("4.7u"), spiceValue("2meg"), spiceValue("10mA"), spiceValue("1M"), spiceValue("100n"), spiceValue("3")])
      .toEqual([1e3, 4.7e-6, 2e6, 0.01, 0.001, 1e-7, 3])
  })
})

describe("netlist import", () => {
  it("RC netlist → Kirk → schematic, same connectivity", async () => {
    const imp = spiceToKirk(RC, "rc.cir")
    expect(imp.parts).toBe(3)
    expect(imp.skipped).toEqual([])
    const r = await compileKirk(imp.kirk)
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    const doc = r.doc!
    expect(doc.title).toBe("RC low-pass from a netlist")
    expect(doc.defaultAnalysis).toBe("ac")
    expect(doc.parts.filter((p) => !isVirtual(p)).map((p) => p.ref).sort()).toEqual(["C1", "R1", "V1"])
    const nl = deriveNetlist(doc)
    const net = (k: string) => nl.pinNet.get(k)
    expect(net("R1.2")).toBe(net("C1.1"))
    expect(net("C1.2")).toBe("0")
    expect(net("V1.2")).toBe("0")
    expect(nl.issues.filter((i) => i.severity === "error")).toEqual([])
  })
  it.skipIf(!ngspice)("imported RC simulates: corner ≈ 995 Hz", async () => {
    const doc = (await compileKirk(spiceToKirk(RC).kirk)).doc!
    const net = buildNetlist(doc, deriveNetlist(doc), "ac")
    const v = measure(net.text, ["meas ac fc WHEN vdb(out)=-3.0103"])
    expect(v.fc).toBeGreaterThan(960)
    expect(v.fc).toBeLessThan(1030)
  })
  it.skipIf(!ngspice)("imported common-emitter amplifier: gain ≈ Rc/(Re+re) ≈ 4.6", async () => {
    const imp = spiceToKirk(CE)
    expect(imp.parts).toBe(8)
    const r = await compileKirk(imp.kirk)
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    const doc = r.doc!
    expect(doc.parts.find((p) => p.ref === "Q1")?.lib).toBe("Transistor_BJT:2N3904")
    const net = buildNetlist(doc, deriveNetlist(doc), "tran")
    const v = measure(net.text, ["meas tran vo PP v(c) FROM=2m TO=4m", "meas tran vi PP v(in) FROM=2m TO=4m"])
    expect(v.vo / v.vi).toBeGreaterThan(4.2)
    expect(v.vo / v.vi).toBeLessThan(4.8)
  })
  it("lists what it could not import", () => {
    const imp = spiceToKirk("t\nX1 a b c OPA\nE1 o 0 a b 10\nR1 a 0 1k\n.op\n")
    expect(imp.parts).toBe(1)
    expect(imp.skipped).toHaveLength(2)
    expect(imp.kirk).toContain("// not imported: X1 a b c OPA")
  })
})

describe("solver options", () => {
  it("leaves ngspice defaults out and writes changed ones", () => {
    expect(optionsLine("tran", {})).toBe(".options savecurrents rshunt=1e12")
    expect(optionsLine("ac", {})).toBe(".options rshunt=1e12")
    expect(optionsLine("tran", { reltol: 1e-3, abstol: 1e-12, gmin: 1e-12, vntol: 1e-6, method: "trap" })).toBe(".options savecurrents rshunt=1e12")
    expect(optionsLine("tran", { reltol: 1e-4, method: "gear", saveCurrents: false })).toBe(".options rshunt=1e12 reltol=1e-4 method=gear")
  })
})
