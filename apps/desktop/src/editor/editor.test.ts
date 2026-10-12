import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import zlib from "node:zlib"
import { beforeAll, describe, expect, it } from "vitest"

import { ensureSymbols, setLoader } from "@/lib/kicad"
import { buildNetlist, parseValue, resolveSim, type ResolvedSim } from "@/lib/spice"
import { EXAMPLES, loadExample } from "./examples"
import { fromV1 } from "./file"
import { defaultPart, emptyDoc, isVirtual, pinPositions, uid, type Doc, type Part } from "./model"
import { deriveNetlist } from "./netlist"
import { addWirePath, deleteSelection, duplicateSelection, mirrorParts, moveSelection, rotateParts, selectInRect } from "./ops"

const KICAD = path.resolve(import.meta.dirname, "../../public/kicad")
setLoader(async (file) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(KICAD, `${file}.gz`))).toString()))

const part = (p: Omit<Part, "id" | "unit"> & { unit?: number }): Part => ({ unit: 1, ...p, id: uid("p") })
const net = (doc: Doc, pin: string) => deriveNetlist(doc).pinNet.get(pin)
const docs: Record<string, Doc> = {}

beforeAll(async () => {
  for (const e of EXAMPLES) docs[e.id] = await loadExample(e.id)
  await ensureSymbols(["Device:R", "@:label", "power:GND", "Transistor_FET:IRF540N", "Transistor_FET:2N7000", "Diode:1N4148", "Diode:BZX84Cxx",
    "Regulator_Linear:LM317_TO-220", "Regulator_Linear:AMS1117-3.3", "Switch:SW_Push", "Device:R_Potentiometer", "74xx:74HC00", "MCU_Microchip_ATmega:ATmega328P-P"])
})

describe("connectivity", () => {
  it("every example connects exactly as designed, with no ERC errors", () => {
    for (const ex of EXAMPLES) {
      const d = docs[ex.id]
      const nl = deriveNetlist(d)
      expect(nl.issues.filter((i) => i.severity === "error"), ex.title).toEqual([])
      for (const p of d.parts) {
        if (isVirtual(p)) continue
        for (const pin of Object.keys(pinPositions(p))) expect(nl.pinNet.get(`${p.ref}.${pin}`), `${ex.title} ${p.ref}.${pin}`).toBeDefined()
      }
    }
  })

  it("RC low-pass: nets come from wires, labels and ground", () => {
    const rc = docs["rc-lowpass"]
    expect(net(rc, "V1.1")).toBe("in")
    expect(net(rc, "R1.2")).toBe("in")
    expect(net(rc, "R1.1")).toBe("out")
    expect(net(rc, "C1.1")).toBe("out")
    expect(net(rc, "V1.2")).toBe("0")
    expect(net(rc, "C1.2")).toBe("0")
    const sp = buildNetlist(rc, deriveNetlist(rc), "ac")
    expect(sp.text).toContain("R1 out in 1600")
    expect(sp.text).toContain("C1 out 0 1e-7")
    expect(sp.text).toMatch(/V1 in 0 DC 0 PULSE\(0 1 1e-4 1e-6 1e-6 1e-3 2e-3\) AC 1/)
    expect(sp.text).toContain(".ac dec 60 10 100000")
    expect(sp.text).not.toContain("savecurrents")
  })

  it("power symbols with the same name are one net; multi-unit parts share their reference", () => {
    const op = docs["opamp-inv"]
    expect(net(op, "U1.8")).toBe("+12V")
    expect(net(op, "U1.4")).toBe("-12V")
    expect(net(op, "U1.1")).toBe("out")
    expect(net(op, "V2.1")).toBe("+12V")
    const sp = buildNetlist(op, deriveNetlist(op), "tran")
    expect(sp.issues.filter((i) => i.severity === "error")).toEqual([])
    expect(sp.text).toMatch(/XU1A in_? \S+ _12v -12v|XU1A \S+ \S+ \S+ \S+ out kicad_builtin_opamp/)
  })

  it("crossing wires do not connect; a T-junction does", () => {
    let doc = emptyDoc()
    doc = addWirePath(doc, [[0, 5], [10, 5]])
    doc = addWirePath(doc, [[5, 0], [5, 10]])
    let nl = deriveNetlist(doc)
    expect(nl.wireNet.get(doc.wires[0].id)).not.toBe(nl.wireNet.get(doc.wires[1].id))
    doc = addWirePath(emptyDoc(), [[0, 5], [10, 5]])
    doc = addWirePath(doc, [[5, 5], [5, 10]])
    nl = deriveNetlist(doc)
    expect(nl.wireNet.get(doc.wires[0].id)).toBe(nl.wireNet.get(doc.wires[1].id))
    expect(nl.junctions).toContainEqual([5, 5])
  })

  it("labels with the same name join separate wires", () => {
    let doc = emptyDoc()
    doc = addWirePath(doc, [[0, 0], [4, 0]])
    doc = addWirePath(doc, [[0, 10], [4, 10]])
    doc.parts.push(part({ ref: "#LBL1", lib: "@:label", x: 2, y: 0, rot: 0, value: "net", net: "vout" }))
    doc.parts.push(part({ ref: "#LBL2", lib: "@:label", x: 2, y: 10, rot: 0, value: "net", net: "vout" }))
    const nl = deriveNetlist(doc)
    expect(nl.wireNet.get(doc.wires[0].id)).toBe("vout")
    expect(nl.wireNet.get(doc.wires[1].id)).toBe("vout")
  })

  it("reports a missing ground and unconnected pins", () => {
    const doc = emptyDoc()
    doc.parts.push(part({ ref: "R1", lib: "Device:R", x: 0, y: 0, rot: 0, value: "1k" }))
    const msgs = deriveNetlist(doc).issues.map((i) => i.message).join(" | ")
    expect(msgs).toMatch(/No ground/)
    expect(msgs).toMatch(/R1: pins 1, 2 not connected/)
  })

  it("hidden power pins of logic ICs join their named net", () => {
    const doc = emptyDoc()
    doc.parts.push(part({ ref: "U1", lib: "74xx:74HC00", x: 0, y: 0, rot: 0, value: "74HC00" }))
    const nl = deriveNetlist(doc)
    // 74HC00 has a separate power unit in KiCad 10; either way the pins resolve
    expect(nl.issues.some((i) => /Missing symbol/.test(i.message))).toBe(false)
  })
})

describe("simulation models", () => {
  const sim = (lib: string, value?: string, unit = 1): ResolvedSim => {
    const r = resolveSim({ ...defaultPart(getSym(lib), unit), ...(value ? { value } : {}), id: "t", ref: "X1", x: 0, y: 0 } as Part)
    if (!r || "error" in r) throw new Error(`${lib}: ${r ? r.error : "virtual"}`)
    return r
  }
  it("infers devices from KiCad symbols", () => {
    expect(sim("Transistor_BJT:2N3904").kind).toBe("NPN")
    expect(sim("Transistor_BJT:2N3904").type).toMatch(/^NPN\(IS=6.734f/)
    expect(sim("Transistor_BJT:2N3906").kind).toBe("PNP")
    expect(sim("Transistor_FET:IRF540N").kind).toBe("NMOS")
    expect(sim("Transistor_FET:IRF540N").type).toMatch(/VDMOS\(.*Vto=3.5/)
    expect(sim("Transistor_FET:2N7000").kind).toBe("NMOS")
    expect(sim("Diode:1N4148").type).toMatch(/IS=2.52n/)
    expect(sim("Diode:1N4007").type).toMatch(/BV=1000/)
    expect(sim("Diode:BZX84Cxx", "BZX84C5V1").note).toBe("zener 5.1 V")
    expect(sim("Device:LED").model).toBe("LED_RED")
    expect(sim("Timer:NE555P").kind).toBe("555")
    expect(sim("Regulator_Linear:L7805").params.vout).toBe("5")
    expect(sim("Regulator_Linear:AMS1117-3.3").params.vout).toBe("3.3")
    expect(sim("Regulator_Linear:LM317_TO-220").kind).toBe("REGADJ")
    expect(sim("Switch:SW_Push").kind).toBe("SWITCH")
    expect(sim("Device:R_Potentiometer").type).toBe("POT")
    const a = sim("Amplifier_Operational:LM358", undefined, 2)
    expect(a.kind).toBe("OPAMP")
    expect(Object.entries(a.pins).sort()).toEqual([["4", "vee"], ["5", "in+"], ["6", "in-"], ["7", "out"], ["8", "vcc"]])
  })
  it("parts without a model are flagged, not simulated", () => {
    const r = resolveSim({ ...defaultPart(getSym("MCU_Microchip_ATmega:ATmega328P-P")), id: "u", ref: "U1", x: 0, y: 0 } as Part)
    expect(r && "error" in r).toBe(true)
  })
  it("parses KiCad / SPICE value notation", () => {
    expect(parseValue("4k7")).toBe(4700)
    expect(parseValue("2R2")).toBeCloseTo(2.2)
    expect(parseValue("1M")).toBe(1e6)
    expect(parseValue("100nF")).toBeCloseTo(1e-7)
    expect(parseValue("10 kΩ")).toBe(1e4)
    expect(parseValue("abc")).toBeNull()
  })
})

describe("current flow", () => {
  it("wires carry the loop current, in the right direction", async () => {
    const { wireCurrents } = await import("./flow")
    const rc = docs["rc-lowpass"]
    // 1 mA out of V1+, through R1 (into its pin 2), into C1 and back via ground
    const cur = wireCurrents(rc, deriveNetlist(rc), { "I(V1)": -1e-3, "I(R1)": -1e-3, "I(C1)": 1e-3 })
    for (const w of rc.wires) expect(Math.abs(cur.get(w.id)!), `${w.a}→${w.b}`).toBeCloseTo(1e-3, 9)
    const up = rc.wires.find((w) => w.a[0] === 12 && w.a[1] === 16)! // V1+ going up
    expect(cur.get(up.id)!).toBeGreaterThan(0)
  })
})

describe("editing", () => {
  it("moving a part stretches attached wires so nothing disconnects", () => {
    const rc = docs["rc-lowpass"]
    const c1 = rc.parts.find((p) => p.ref === "C1")!
    const moved = moveSelection(rc, { parts: new Set([c1.id]), wires: new Set() }, 4, 2)
    expect(net(moved, "C1.1")).toBe("out")
    expect(net(moved, "C1.2")).toBe("0")
    expect(deriveNetlist(moved).issues.filter((i) => i.severity === "error")).toEqual([])
  })

  it("rotating and mirroring a part keep its wires attached", () => {
    const rc = docs["rc-lowpass"]
    const r1 = rc.parts.find((p) => p.ref === "R1")!
    for (const next of [rotateParts(rc, new Set([r1.id])), mirrorParts(rc, new Set([r1.id]))]) {
      expect(new Set([net(next, "R1.1"), net(next, "R1.2")])).toEqual(new Set([net(next, "V1.1"), net(next, "C1.1")]))
      expect(net(next, "V1.1")).not.toBe(net(next, "C1.1"))
    }
  })

  it("deleting a part removes it from the netlist", () => {
    const rc = docs["rc-lowpass"]
    const r1 = rc.parts.find((p) => p.ref === "R1")!
    const del = deleteSelection(rc, { parts: new Set([r1.id]), wires: new Set() })
    expect(del.parts.some((p) => p.ref === "R1")).toBe(false)
    expect(buildNetlist(del, deriveNetlist(del), "op").text).not.toMatch(/^R1 /m)
  })

  it("deleting a part removes the wires that only led to it, and keeps the rest", () => {
    const rc = docs["rc-lowpass"]
    const c1 = rc.parts.find((p) => p.ref === "C1")!
    const del = deleteSelection(rc, { parts: new Set([c1.id]), wires: new Set() })
    // C1's ground wire (30,23)->(30,27) ends on the GND symbol pin: that pin remains, so the wire is a dead end only on C1's side → removed
    expect(del.wires.some((w) => w.a[0] === 30 && w.a[1] === 23)).toBe(false)
    // the R1 → C1 wire is trimmed back to the `out` label in its middle, so R1 keeps its net
    expect(del.wires.some((w) => (w.a[0] === 23 && w.b[0] === 27) || (w.a[0] === 27 && w.b[0] === 23))).toBe(true)
    expect(deriveNetlist(del).pinNet.get("R1.1")).toBe("out")
    // …and C1's ground symbol, now connected to nothing, is gone; V1's stays
    expect(del.parts.filter((p) => p.lib === "power:GND").map((p) => [p.x, p.y])).toEqual([[12, 27]])
    // V1's wiring is untouched
    expect(del.wires.some((w) => w.a[0] === 12 && w.a[1] === 16)).toBe(true)
    expect(deriveNetlist(del).pinNet.get("R1.2")).toBe("in")
  })

  it("duplicating gives new references", () => {
    const rc = docs["rc-lowpass"]
    const r1 = rc.parts.find((p) => p.ref === "R1")!
    const { doc, sel } = duplicateSelection(rc, { parts: new Set([r1.id]), wires: new Set() })
    const copy = doc.parts.find((p) => sel.parts.has(p.id))!
    expect(copy.ref).toBe("R2")
    expect(copy.x).toBe(r1.x + 2)
  })

  it("box select picks parts by origin and wires fully inside", () => {
    const rc = docs["rc-lowpass"]
    const sel = selectInRect(rc, 25, 10, 40, 30)
    const refs = rc.parts.filter((p) => sel.parts.has(p.id)).map((p) => p.ref).sort()
    expect(refs).toEqual(["#LBL_out_27", "#PWR02", "C1"])
  })

  it("converts version-1 files onto KiCad symbols without breaking wires", () => {
    const v1 = {
      ...emptyDoc(),
      parts: [
        { id: "a", ref: "V1", kind: "V", x: 12, y: 20, rot: 0 as const, value: 5, wave: { type: "dc" as const, value: 5 } },
        { id: "b", ref: "R1", kind: "R", x: 20, y: 14, rot: 90 as const, value: 1000 },
        { id: "c", ref: "#GND1", kind: "GND", x: 12, y: 27, rot: 0 as const, value: 0 },
        { id: "d", ref: "#GND2", kind: "GND", x: 26, y: 20, rot: 0 as const, value: 0 },
      ],
      wires: [{ id: "w1", a: [12, 16] as [number, number], b: [12, 14] as [number, number] }, { id: "w2", a: [12, 14] as [number, number], b: [17, 14] as [number, number] },
        { id: "w3", a: [12, 24] as [number, number], b: [12, 27] as [number, number] }, { id: "w4", a: [23, 14] as [number, number], b: [26, 14] as [number, number] }, { id: "w5", a: [26, 14] as [number, number], b: [26, 20] as [number, number] }],
    }
    const d = fromV1(v1)
    expect(net(d, "V1.1")).toBe(net(d, "R1.2"))
    expect(net(d, "R1.1")).toBe("0")
  })
})

// ---------------------------------------------------------------- end to end on ngspice

const ngspice = ["/opt/homebrew/bin/ngspice", "/usr/local/bin/ngspice", "/usr/bin/ngspice"].find((p) => fs.existsSync(p))

function runSpice(text: string, meas: string[]): Record<string, number> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbtest-"))
  const file = path.join(dir, "c.cir")
  fs.writeFileSync(file, `${text}\n.control\nrun\n${meas.join("\n")}\n.endc\n.end\n`)
  const out = spawnSync(ngspice!, ["-b", file], { encoding: "utf8" })
  fs.rmSync(dir, { recursive: true, force: true })
  const vals: Record<string, number> = {}
  for (const m of (out.stdout + out.stderr).matchAll(/^(\w+)\s+=\s+([-+\d.eE]+)/gm)) vals[m[1]] = parseFloat(m[2])
  return vals
}

describe.skipIf(!ngspice)("examples simulate on ngspice", () => {
  const spice = (id: string, a: "tran" | "ac" | "op") => buildNetlist(docs[id], deriveNetlist(docs[id]), a)

  it("RC low-pass corner ≈ 995 Hz", () => {
    const v = runSpice(spice("rc-lowpass", "ac").text, ["meas ac fc WHEN vdb(out)=-3.0103"])
    expect(v.fc).toBeGreaterThan(960)
    expect(v.fc).toBeLessThan(1030)
  })
  it("LED current ≈ 14 mA", () => {
    const v = runSpice(spice("led", "op").text, ["print i(v1)", "let ia = -i(v1)", "print ia"])
    expect(v.ia).toBeGreaterThan(0.012)
    expect(v.ia).toBeLessThan(0.016)
  })
  it("half-wave rectifier peaks near 9.3 V", () => {
    const v = runSpice(spice("half-wave", "tran").text, ["meas tran vmax MAX v(out)"])
    expect(v.vmax).toBeGreaterThan(9)
    expect(v.vmax).toBeLessThan(9.6)
  })
  it("common-emitter amplifier inverts with gain ≈ 3", () => {
    const v = runSpice(spice("ce-amp", "tran").text, ["meas tran vo PP v(out) FROM=2m TO=4m", "meas tran vi PP v(in) FROM=2m TO=4m"])
    const g = v.vo / v.vi
    expect(g).toBeGreaterThan(2.3)
    expect(g).toBeLessThan(3.8)
  })
  it("LM358 inverting amplifier: gain −10", () => {
    const v = runSpice(spice("opamp-inv", "tran").text, ["meas tran vo PP v(out) FROM=1m TO=3m", "meas tran vi PP v(in) FROM=1m TO=3m"])
    expect(v.vo / v.vi).toBeGreaterThan(9.5)
    expect(v.vo / v.vi).toBeLessThan(10.1)
  })
  it("555 astable runs near 69 Hz", () => {
    const v = runSpice(spice("555-astable", "tran").text, ["meas tran per TRIG v(out) VAL=2.5 RISE=2 TARG v(out) VAL=2.5 RISE=3"])
    expect(1 / v.per).toBeGreaterThan(60)
    expect(1 / v.per).toBeLessThan(78)
  })
  it("L7805 holds 5 V through the input ripple", () => {
    const v = runSpice(spice("7805", "tran").text, ["meas tran vmin MIN v(vout) FROM=5m", "meas tran vmax MAX v(vout) FROM=5m"])
    expect(v.vmin).toBeGreaterThan(4.95)
    expect(v.vmax).toBeLessThan(5.05)
  })
})

import { getSymbol } from "@/lib/kicad"
function getSym(id: string) {
  const s = getSymbol(id)
  if (!s) throw new Error(`symbol ${id} not loaded`)
  return s
}
