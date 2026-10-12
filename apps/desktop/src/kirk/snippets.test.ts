import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import zlib from "node:zlib"
import { spawnSync } from "node:child_process"
import { describe, expect, it } from "vitest"

import { deriveNetlist } from "@/editor/netlist"
import { setLoader } from "@/lib/kicad"
import { buildNetlist } from "@/lib/spice"
import { compileKirk } from "./compile"
import { NEW_FROM_CODE, SNIPPETS } from "./snippets"

const KICAD = path.resolve(import.meta.dirname, "../../public/kicad")
setLoader(async (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(KICAD, `${f}.gz`))).toString()))
const ngspice = ["/opt/homebrew/bin/ngspice", "/usr/local/bin/ngspice", "/usr/bin/ngspice"].find((p) => fs.existsSync(p))

function measure(text: string, meas: string[]): Record<string, number> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbsnip-"))
  const file = path.join(dir, "c.cir")
  fs.writeFileSync(file, `${text}\n.control\nrun\n${meas.join("\n")}\n.endc\n.end\n`)
  const out = spawnSync(ngspice!, ["-b", file], { encoding: "utf8" })
  fs.rmSync(dir, { recursive: true, force: true })
  const vals: Record<string, number> = {}
  for (const m of (out.stdout + out.stderr).matchAll(/^(\w+)\s+=\s+([-+\d.eE]+)/gm)) vals[m[1]] = parseFloat(m[2])
  return vals
}

async function compileOk(code: string) {
  const r = await compileKirk(code)
  expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  const doc = r.doc!
  const nl = deriveNetlist(doc)
  const net = buildNetlist(doc, nl, doc.defaultAnalysis)
  expect([...nl.issues, ...net.issues].filter((i) => i.severity === "error")).toEqual([])
  return { doc, net }
}

describe("Kirk starter programs", () => {
  it("“New from code” template compiles", async () => { await compileOk(NEW_FROM_CODE) })
  for (const s of SNIPPETS) it(`${s.title} compiles to an error-free schematic`, async () => { await compileOk(s.code) })

  it.skipIf(!ngspice)("divider: V(MID) = 2.5 V", async () => {
    const { net } = await compileOk(SNIPPETS.find((s) => s.id === "divider")!.code)
    expect(measure(net.text, ["let vm = v(mid)", "print vm"]).vm).toBeCloseTo(2.5, 2)
  })
  it.skipIf(!ngspice)("RC: corner ≈ 995 Hz", async () => {
    const { net } = await compileOk(SNIPPETS.find((s) => s.id === "rc")!.code)
    const v = measure(net.text, ["meas ac fc WHEN vdb(out)=-3.0103"])
    expect(v.fc).toBeGreaterThan(960)
    expect(v.fc).toBeLessThan(1030)
  })
  it.skipIf(!ngspice)("LED: ≈ 14 mA through the 220 Ω resistor", async () => {
    const { net } = await compileOk(SNIPPETS.find((s) => s.id === "led")!.code)
    const v = measure(net.text, ["let ia = (v(vcc) - v(a)) / 220", "print ia"])
    expect(v.ia).toBeGreaterThan(0.012)
    expect(v.ia).toBeLessThan(0.017)
  })
  it.skipIf(!ngspice)("555 blinker oscillates near 69 Hz", async () => {
    const { net } = await compileOk(SNIPPETS.find((s) => s.id === "blinker")!.code)
    const v = measure(net.text, ["meas tran per TRIG v(out) VAL=2.5 RISE=2 TARG v(out) VAL=2.5 RISE=3"])
    expect(1 / v.per).toBeGreaterThan(60)
    expect(1 / v.per).toBeLessThan(78)
  })
  it("sweep snippet sets up a five-point sweep", async () => {
    const { doc } = await compileOk(SNIPPETS.find((s) => s.id === "sweep")!.code)
    expect(doc.setup?.sweep?.enabled).toBe(true)
    expect(doc.setup?.sweep?.values).toHaveLength(5)
  })
})
