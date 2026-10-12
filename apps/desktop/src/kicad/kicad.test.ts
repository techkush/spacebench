import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
import { beforeAll, describe, expect, it } from "vitest"
import { EXAMPLES, loadExample } from "@/editor/examples"
import { isVirtual, type Doc } from "@/editor/model"
import { deriveNetlist, onSegment } from "@/editor/netlist"
import { setLoader } from "@/lib/kicad"
import { compileKirk } from "@/kirk/compile"
import { generateKirk } from "@/kirk/generate"
import { parseSexpr, printSexpr } from "./sexpr"
import { exportKicadSch } from "./schExport"
import { fromKicadOrient, importKicadSch, pinPoints, toKicadOrient } from "./schImport"

const KICAD = path.resolve(import.meta.dirname, "../../public/kicad")
setLoader(async (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(KICAD, `${f}.gz`))).toString()))

/** Each electrical pin → the electrical pins on its net (independent of net names and drawing). */
function connectivity(doc: Doc) {
  const nl = deriveNetlist(doc)
  const real = new Set(doc.parts.filter((p) => !isVirtual(p)).map((p) => p.ref))
  const byNet = new Map<string, string[]>()
  for (const [k, n] of nl.pinNet) if (real.has(k.split(".")[0])) byNet.set(n, [...(byNet.get(n) ?? []), k])
  const out: Record<string, string> = {}
  for (const [n, pins] of byNet) for (const k of pins) out[k] = `${n === "0" ? "GND" : ""}|${[...pins].sort().join(",")}`
  return out
}

describe("s-expressions", () => {
  it("read and write back", () => {
    const src = `(kicad_sch (version 20231120) (title_block (title "A \\"q\\" b")) (wire (pts (xy 1 2) (xy 3 4))) (pin_numbers hide))`
    const t = parseSexpr(src)
    expect(parseSexpr(printSexpr(t))).toEqual(t)
    expect(printSexpr(t)).toContain("(xy 1 2) (xy 3 4)")
  })
})

describe("orientation", () => {
  it("KiCad → Doc → KiCad is the same placement", () => {
    for (const a of [0, 90, 180, 270]) for (const m of [null, "y", "x"] as const) {
      const d = fromKicadOrient(a, m)
      const k = toKicadOrient(d.rot, d.mirror)
      expect(fromKicadOrient(k.angle, k.mirror)).toEqual(d)
    }
  })
})

const docs: Record<string, Doc> = {}
beforeAll(async () => { for (const e of EXAMPLES) docs[e.id] = await loadExample(e.id) })

describe("export → import", () => {
  it("keeps every example's connections, values and footprints", async () => {
    for (const e of EXAMPLES) {
      const doc = docs[e.id]
      const text = exportKicadSch(doc, e.id)
      const back = (await importKicadSch(text, `${e.id}.kicad_sch`)).doc
      expect(connectivity(back), e.id).toEqual(connectivity(doc))
      for (const p of doc.parts.filter((x) => !isVirtual(x))) {
        const b = back.parts.find((x) => x.ref === p.ref && x.unit === p.unit)!
        expect([b.lib, b.value, b.footprint ?? ""], `${e.id} ${p.ref}`).toEqual([p.lib, p.value, p.footprint ?? ""])
      }
    }
  })
  it("writes a file KiCad's reader takes: one lib symbol per id, instances, a directive", () => {
    const text = exportKicadSch(docs[EXAMPLES[0].id], "x")
    const t = parseSexpr(text)
    expect(t[0]).toBe("kicad_sch")
    const libs = (t.find((c) => Array.isArray(c) && c[0] === "lib_symbols") as unknown[]).slice(1) as unknown[][]
    const ids = libs.map((l) => (l[1] as { s: string }).s)
    expect(new Set(ids).size).toBe(ids.length)
    expect(text).toMatch(/\(instances\s+\(project "x"/)
    expect(text).toMatch(/\(text "\.(tran|ac|op)/)
  })
})

// a small schematic written by hand in KiCad's format: rotated / mirrored parts, a label, power,
// a no-connect, a symbol only the file defines, and a simulation directive
const HAND = `(kicad_sch (version 20231120) (generator "eeschema") (uuid "u0") (paper "A4")
  (title_block (title "Hand made"))
  (lib_symbols
    (symbol "mylib:BOX" (pin_names (offset 0.508)) (exclude_from_sim no) (in_bom yes) (on_board yes)
      (property "Reference" "U" (at 0 3.81 0) (effects (font (size 1.27 1.27))))
      (property "Value" "BOX" (at 0 -3.81 0) (effects (font (size 1.27 1.27))))
      (symbol "BOX_0_1" (rectangle (start -2.54 2.54) (end 2.54 -2.54) (stroke (width 0.254) (type default)) (fill (type background))))
      (symbol "BOX_1_1"
        (pin input line (at -5.08 1.27 0) (length 2.54) (name "A" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
        (pin input line (at -5.08 -1.27 0) (length 2.54) (name "B" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))
        (pin output line (at 5.08 0 180) (length 2.54) (name "Y" (effects (font (size 1.27 1.27)))) (number "3" (effects (font (size 1.27 1.27)))))
        (pin no_connect line (at 0 -5.08 90) (length 2.54) (name "NC" (effects (font (size 1.27 1.27)))) (number "4" (effects (font (size 1.27 1.27)))))))
  )
  (text ".tran 1u 5m" (at 20 20 0))
  (wire (pts (xy 45.72 49.53) (xy 45.72 40.64)))
  (wire (pts (xy 55.88 48.26) (xy 66.04 48.26)))
  (no_connect (at 50.8 53.34))
  (label "IN" (at 45.72 40.64 0) (effects (font (size 1.27 1.27))) (uuid "l1"))
  (symbol (lib_id "mylib:BOX") (at 50.8 48.26 0) (unit 1) (uuid "s1")
    (property "Reference" "U1" (at 50.8 44 0)) (property "Value" "BOX" (at 50.8 52 0))
    (property "MPN" "BX-1" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (instances (project "h" (path "/u0" (reference "U1") (unit 1)))))
  (symbol (lib_id "Device:R") (at 66.04 52.07 0) (mirror x) (unit 1) (uuid "s2")
    (property "Reference" "R1" (at 0 0 0)) (property "Value" "4.7k" (at 0 0 0))
    (property "Footprint" "Resistor_SMD:R_0603_1608Metric" (at 0 0 0)))
  (symbol (lib_id "power:GND") (at 66.04 55.88 0) (unit 1) (uuid "s3")
    (property "Reference" "#PWR01" (at 0 0 0)) (property "Value" "GND" (at 0 0 0)))
  (symbol (lib_id "Device:R") (at 41.91 49.53 90) (unit 1) (uuid "s4")
    (property "Reference" "R2" (at 0 0 0)) (property "Value" "1k" (at 0 0 0)))
  (wire (pts (xy 45.72 49.53) (xy 45.72 49.53)))
  (wire (pts (xy 38.1 49.53) (xy 38.1 55.88)))
  (symbol (lib_id "power:GND") (at 38.1 55.88 0) (unit 1) (uuid "s5")
    (property "Reference" "#PWR02" (at 0 0 0)) (property "Value" "GND" (at 0 0 0)))
)`

describe("import", () => {
  it("reads a hand-made KiCad schematic", async () => {
    const r = await importKicadSch(HAND, "hand.kicad_sch")
    const d = r.doc
    expect(d.title).toBe("Hand made")
    expect(d.analyses.tran).toEqual({ step: 1e-6, stop: 5e-3 })
    expect(d.defaultAnalysis).toBe("tran")
    const ac = await importKicadSch(HAND.replace(".tran 1u 5m", ".ac dec 10 1 1Meg"), "ac.kicad_sch")
    expect([ac.doc.defaultAnalysis, ac.doc.analyses.ac]).toEqual(["ac", { start: 1, stop: 1e6, points: 10 }])
    expect(r.custom).toEqual(["mylib:BOX"])
    const u1 = d.parts.find((p) => p.ref === "U1")!
    expect(u1.fields?.MPN).toBe("BX-1")
    expect(d.parts.find((p) => p.ref === "R1")!.footprint).toBe("Resistor_SMD:R_0603_1608Metric")
    const nl = deriveNetlist(d)
    // U1.Y → R1 (mirrored) → GND; R2 (turned 90°) from GND to the IN wire
    expect(nl.pinNet.get("U1.3")).toBe(nl.pinNet.get("R1.2"))
    expect(nl.pinNet.get("R1.1")).toBe("0")
    expect([nl.pinNet.get("R2.1"), nl.pinNet.get("R2.2"), nl.pinNet.get("U1.2")]).toEqual(["0", "IN", "IN"])
    expect(d.noConnects).toEqual([[40, 42]])
    // every pin lands on something
    const pts = pinPoints(d)
    const touched = (p: [number, number]) => d.wires.some((w) => onSegment(p, w.a, w.b)) || [...pts.values()].filter((q) => q[0] === p[0] && q[1] === p[1]).length > 1 || (d.noConnects ?? []).some((q) => q[0] === p[0] && q[1] === p[1])
    expect([...pts].filter(([, p]) => !touched(p)).map(([k]) => k)).toEqual([])
  })
  it("opens as Kirk code that compiles back to the same circuit", async () => {
    const r = await importKicadSch(HAND, "hand.kicad_sch")
    const code = generateKirk(r.doc, deriveNetlist(r.doc))
    expect(code).toMatch(/U1 = lib\("mylib:BOX"\)/)
    expect(code).toMatch(/U1\.MPN = "BX-1"/)
    const c = await compileKirk(code, r.doc)
    expect(c.diagnostics.filter((x) => x.severity === "error")).toEqual([])
    expect(connectivity(c.doc!)).toEqual(connectivity(r.doc))
    // the file's own symbol travels with the circuit (saved with it)
    expect(c.doc!.symbols?.map((s) => s.id)).toEqual(["mylib:BOX"])
    // and Kirk can script it: select, set, check
    const more = await compileKirk(code.replace(/\n}\n/, `\n    parts(R*).footprint = "Resistor_SMD:R_0805_2012Metric"\n    check connected(U1.Y, R1)\n    check parts(R*).count == 2\n}\n`), r.doc)
    expect(more.diagnostics.filter((x) => x.severity === "error")).toEqual([])
    expect(more.doc!.parts.filter((p) => p.ref.startsWith("R")).map((p) => p.footprint)).toEqual(["Resistor_SMD:R_0805_2012Metric", "Resistor_SMD:R_0805_2012Metric"])
  })
})

// KiCad's own demo schematics, when they're on this machine (not part of the repo):
//   KICAD_DEMOS=/path/to/dir pnpm vitest run src/kicad
const DEMOS = process.env.KICAD_DEMOS
describe.skipIf(!DEMOS)("KiCad demos", () => {
  it("import with every pin on a wire, a pin or a no-connect (apart from bus labels and dangling symbols)", async () => {
    for (const f of fs.readdirSync(DEMOS!).filter((x) => x.endsWith(".kicad_sch"))) {
      const r = await importKicadSch(fs.readFileSync(path.join(DEMOS!, f), "utf8"), f)
      const pts = pinPoints(r.doc)
      const at = new Map<string, number>()
      for (const p of pts.values()) at.set(`${p}`, (at.get(`${p}`) ?? 0) + 1)
      const nc = new Set((r.doc.noConnects ?? []).map((p) => `${p}`))
      // labels on buses (not imported) don't count
      const partPins = [...pts].filter(([k]) => !k.startsWith("#LBL")).map(([, p]) => p)
      const n = partPins.filter((p) => r.doc.wires.some((w) => onSegment(p, w.a, w.b)) || at.get(`${p}`)! > 1 || nc.has(`${p}`)).length
      expect(n / partPins.length, f).toBeGreaterThan(0.95)
      // and back out to KiCad and in again: the same connections
      const again = (await importKicadSch(exportKicadSch(r.doc, f), f)).doc
      expect(connectivity(again), f).toEqual(connectivity(r.doc))
    }
  }, 300_000)
})
