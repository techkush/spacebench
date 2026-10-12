import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
import { beforeAll, describe, expect, it } from "vitest"

import { EXAMPLES, loadExample } from "@/editor/examples"
import { isVirtual, type Doc } from "@/editor/model"
import { deriveNetlist } from "@/editor/netlist"
import { setLoader } from "@/lib/kicad"
import { buildNetlist, parseParams, parseValue } from "@/lib/spice"
import { compileKirk } from "./compile"
import { generateKirk } from "./generate"
import { lex } from "./lexer"
import { parse } from "./parser"

const KICAD = path.resolve(import.meta.dirname, "../../public/kicad")
setLoader(async (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(KICAD, `${f}.gz`))).toString()))

/** pin → set of pins on the same net (connectivity fingerprint, independent of net names) */
function connectivity(doc: Doc) {
  const nl = deriveNetlist(doc)
  const byNet = new Map<string, string[]>()
  for (const [k, n] of nl.pinNet) byNet.set(n, [...(byNet.get(n) ?? []), k])
  const out: Record<string, string> = {}
  for (const [n, pins] of byNet) for (const k of pins) out[k] = `${n === "0" ? "GND" : ""}|${[...pins].sort().join(",")}`
  return out
}

const docs: Record<string, Doc> = {}
beforeAll(async () => { for (const e of EXAMPLES) docs[e.id] = await loadExample(e.id) })

describe("lexer", () => {
  it("reads SI numbers with prefixes and units", () => {
    const t = lex("10k 4.7uF 5V 1Meg 2.2M 100m 20us 1 kΩ 27°C 1%").filter((x) => x.kind === "number")
    expect(t.map((x) => [Number(x.value!.toPrecision(6)), x.unit ?? ""])).toEqual([[1e4, ""], [4.7e-6, "F"], [5, "V"], [1e6, ""], [2.2e6, ""], [0.1, ""], [2e-5, "s"], [1, ""], [27, "°C"], [1, "%"]])
  })
})

describe("parser", () => {
  it("parses the spec's first example without errors", () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, "../../../../docs/kirk-language-spec.md"), "utf8")
    const code = /```kirk\n([\s\S]*?)```/.exec(src)![1]
    const { file, diagnostics } = parse(code)
    expect(diagnostics).toEqual([])
    expect(file.items.map((i) => i.k)).toEqual(["circuit", "simulate", "measure", "measure", "assert", "instrument"])
  })
  it("recovers after a bad line and keeps going", () => {
    const { file, diagnostics } = parse("circuit X {\n  R1 = R(1k)\n  R1 -- -- out\n  C1 = C(1u)\n}\n")
    expect(diagnostics.length).toBe(1)
    const c = file.items[0]
    expect(c.k === "circuit" && c.body.map((s) => s.k)).toEqual(["part", "part"])
  })
})

describe("compile", () => {
  it("unit mismatch: C(10k) is V102", async () => {
    const r = await compileKirk("circuit X {\n  ground GND\n  C1 = C(10 kΩ)\n  C1.1 -- GND\n}\n")
    expect(r.diagnostics.some((d) => d.code === "V102")).toBe(true)
  })
  it("hand-written code: chains, pins by name, supply and ground", async () => {
    const src = `circuit Blinker {
    supply VCC = 5 V
    ground GND
    U1 = NE555
    R1 = R(1 kΩ)
    R2 = R(10k)
    C1 = C(1 uF)
    R3 = R(330)
    D1 = LED(color: red)
    VCC -- R1 -- DISCH -- R2 -- TRIG -- C1 -- GND
    U1.OUT -- OUT -- R3 -- LED_A -- D1' -- GND
    U1.VCC, U1.RST -- VCC
    U1.DISCH -- DISCH
    U1.THRES, U1.TRIG -- TRIG
    U1.GND -- GND
    U1.CONT -- nc
}
simulate tran(stop: 60 ms, step: 10 us)
measure f = frequency(V(OUT))
scope S { ch1 = V(OUT) }
`
    const r = await compileKirk(src)
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    const doc = r.doc!
    const nl = deriveNetlist(doc)
    expect(nl.pinNet.get("R1.1")).toBe("VCC")
    expect(nl.pinNet.get("U1.7")).toBe("DISCH")
    expect(nl.pinNet.get("C1.2")).toBe("0")
    expect(nl.pinNet.get("D1.2")).toBe("LED_A") // D1' : anode (pin 2) faces LED_A
    expect(nl.pinNet.get("V_VCC.1")).toBe("VCC")
    expect(nl.issues.filter((i) => i.severity === "error")).toEqual([])
    expect(doc.probes).toEqual(["V(OUT)"])
    expect(doc.measures).toEqual([{ name: "f", expr: "frequency(V(OUT))" }])
    expect(doc.analyses.tran.stop).toBeCloseTo(0.06)
    const sp = buildNetlist(doc, nl, "tran")
    expect(sp.issues.filter((i) => i.severity === "error")).toEqual([])
    expect(sp.text).toMatch(/XU1 0 trig out vcc \S+ trig dischg?|XU1 0 trig out vcc/i)
  })
})

describe("round trip: schematic → Kirk → schematic", () => {
  it("every example keeps parts, positions, wires and connectivity", async () => {
    for (const ex of EXAMPLES) {
      const d = docs[ex.id]
      const code = generateKirk(d, deriveNetlist(d))
      const r = await compileKirk(code)
      expect(r.diagnostics.filter((x) => x.severity === "error"), `${ex.id}:\n${code}`).toEqual([])
      const d2 = r.doc!
      const sig = (doc: Doc) => doc.parts.filter((p) => !isVirtual(p)).map((p) => `${p.ref}/${p.unit} ${p.lib} ${p.value} @${p.x},${p.y} r${p.rot}${p.mirror ? "m" : ""} ${Object.entries(parseParams(p.sim?.Params)).map(([k, v]) => `${k}=${parseValue(v) ?? v}`).join(" ")}`).sort()
      expect(sig(d2), ex.id).toEqual(sig(d))
      expect(d2.wires.length, ex.id).toBe(d.wires.length)
      expect(connectivity(d2), ex.id).toEqual(connectivity(d))
      expect(d2.probes, ex.id).toEqual(d.probes)
      // and generating again gives the same text (stable)
      expect(generateKirk(d2, deriveNetlist(d2)), ex.id).toBe(code)
    }
  })
  it("editing the code rewires only what changed", async () => {
    const d = docs["rc-lowpass"]
    const code = generateKirk(d, deriveNetlist(d))
    // move C1.2 from ground to `out` (shorting the capacitor, but it is what the code says)
    const edited = code.replace("V1.2, C1.2 -- GND", "V1.2 -- GND").replace("R1.1, C1.1 -- out", "R1.1, C1.1, C1.2 -- out")
    expect(edited).not.toBe(code)
    const r = await compileKirk(edited, d)
    expect(r.ok).toBe(true)
    const nl = deriveNetlist(r.doc!)
    expect(nl.pinNet.get("C1.2")).toBe("out")
    expect(nl.pinNet.get("C1.1")).toBe("out")
    expect(nl.pinNet.get("V1.2")).toBe("0")
    expect(nl.pinNet.get("V1.1")).toBe("in")
    // adding a pin to a net keeps that net's drawing
    const r2 = await compileKirk(code.replace("R1.1, C1.1 -- out", "R1.1, C1.1 -- out\n    R2 = R(4.7k)\n    R2.1 -- out\n    R2.2 -- GND"), d)
    expect(r2.ok).toBe(true)
    const nl2 = deriveNetlist(r2.doc!)
    expect(nl2.pinNet.get("R2.1")).toBe("out")
    expect(nl2.pinNet.get("R2.2")).toBe("0")
    expect(r2.doc!.wires.some((w) => w.a[0] === 23 && w.a[1] === 14)).toBe(true) // R1 → C1 wire survives
    // the untouched `in` net keeps its drawn wire
    expect(r.doc!.wires.some((w) => w.a[0] === 12 && w.a[1] === 16)).toBe(true)
  })
})
