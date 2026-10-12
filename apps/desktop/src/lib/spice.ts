// Schematic → SPICE netlist for ngspice. Each part resolves to KiCad-style
// simulation fields (Sim.Device / Type / Pins / Params): from the part's own
// overrides, from the symbol's Sim.* fields, or inferred from the symbol
// (library, name, pin names, Value) for ordinary parts like R, C, 2N3904,
// LM358, NE555, L7805.
import type { Doc, Part, SimFields } from "@/editor/model"
import { displayRef, isVirtual, symbolFor } from "@/editor/model"
import type { Issue, Netlist } from "@/editor/netlist"
import { getSymbol, unitLetter, type KPin, type SymbolDef } from "@/lib/kicad"
import {
  GENERIC, GENERIC_DIODE, GENERIC_SCHOTTKY, knownModel, ledFor, opampParams, regulatorVoltage, SUBCKT_555, SUBCKT_OPAMP,
  SUBCKT_REG, SUBCKT_REG_ADJ, SUBCKT_REG_NEG, zener, zenerVoltage, type ModelKind,
} from "@/lib/models"
import { ldrResistance, micAmplitude, ntcResistance, photoCurrent, ptcResistance, tempSensorVolts } from "@/lib/environment"
import { resolveFeeds, sensorSignal } from "@/lib/feeds"
import { currentSensitivity, curveTable, QUANTITIES, SENSOR_MODELS, sensorModelFor, type Quantity } from "@/lib/sensors"
import { pwlSpec, samplePwl, type Signal } from "@/lib/stimulus"
import { parseSI } from "@/lib/units"
import { boardOf, isProgrammable, pinRole, PIN_R, PULLDOWN_R, PULLUP_R, SUPPLY_R, type BoardDrive, type Wave } from "@/cosim/boards"

// ---------------------------------------------------------------- values & params

/** "4k7" → 4700, "2R2" → 2.2, "10k", "100nF", "1Meg", "1M" (= mega, KiCad convention). */
export function parseValue(text: string | undefined): number | null {
  if (!text) return null
  const t = text.trim().replace(/Ω|ohms?$/i, "")
  const rkm = /^(\d+)([RKMGkmunpµ])(\d+)$/.exec(t)
  if (rkm) {
    const scale: Record<string, string> = { R: "", K: "k", k: "k", M: "M", G: "G", m: "m", u: "u", µ: "u", n: "n", p: "p" }
    return parseSI(`${rkm[1]}.${rkm[3]}${scale[rkm[2]]}`)
  }
  return parseSI(t)
}

/** Number in a form ngspice reads unambiguously (no "M"). */
export const spiceNum = (v: number) => (Number.isInteger(v) && Math.abs(v) < 1e15 ? String(v) : v.toExponential(6).replace(/\.?0+e/, "e"))

/** "dc=0 ampl=1 f=1k ac=1" or pwl="0 0 1m 5" → map (keys lower-case). */
export function parseParams(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!text) return out
  const re = /([A-Za-z_][\w.]*)\s*=\s*("([^"]*)"|\S+)/g
  for (let m; (m = re.exec(text)); ) out[m[1].toLowerCase()] = m[3] ?? m[2]
  return out
}
export const formatParams = (p: Record<string, string>) =>
  Object.entries(p).map(([k, v]) => (/\s/.test(v) ? `${k}="${v}"` : `${k}=${v}`)).join(" ")

/** "1=C 2=B 3=E" → { "1": "C", … } */
export function parsePins(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const tok of (text ?? "").split(/\s+/).filter(Boolean)) {
    const [k, v] = tok.split("=")
    if (k && v) out[k] = v
  }
  return out
}

// ---------------------------------------------------------------- resolution

export type SimKind = "R" | "C" | "L" | "V" | "I" | "D" | "NPN" | "PNP" | "NMOS" | "PMOS" | "NJFET" | "PJFET" | "OPAMP" | "555" | "REG" | "REGADJ" | "SWITCH" | "VSWITCH" | "TEMPSENSOR" | "SENSOR" | "SUBCKT" | "MCU"

export interface ResolvedSim {
  kind: SimKind
  /** the part reads the room (lib/environment.ts): its value is set from light / temperature / sound */
  env?: Quantity
  /** symbol pin number → model terminal name */
  pins: Record<string, string>
  params: Record<string, string>
  type?: string
  /** SPICE model / subckt name (transistors, diodes, subckts) */
  model?: string
  /** where the definition came from — shown in the Inspector */
  origin: "part" | "symbol" | "inferred"
  /** e.g. "generic NPN model" when the Value is not in the model library */
  note?: string
}

const byName = (pins: KPin[], ...names: string[]) => {
  for (const n of names) {
    // a visible pin first: hidden pins with the same name are stacked under it (joined inside the part)
    const same = (q: KPin) => q.name.toUpperCase() === n.toUpperCase()
    const p = pins.find((q) => same(q) && !q.h) ?? pins.find(same)
    if (p) return p.n
  }
  return undefined
}
const allPins = (sym: SymbolDef) => sym.units.flatMap((u) => u.pins)
const pinMap = (pins: KPin[], roles: Record<string, string[]>): Record<string, string> | null => {
  const out: Record<string, string> = {}
  for (const [role, names] of Object.entries(roles)) {
    const n = byName(pins, ...names)
    if (!n) return null
    out[n] = role
  }
  return out
}
const twoPin = (sym: SymbolDef) => {
  const ps = allPins(sym)
  return ps.length === 2 ? { [ps[0].n]: "1", [ps[1].n]: "2" } : null
}

const DEVICE_KIND: Record<string, SimKind> = {
  R: "R", C: "C", L: "L", V: "V", I: "I", D: "D", NPN: "NPN", PNP: "PNP", NMOS: "NMOS", PMOS: "PMOS", NJFET: "NJFET", PJFET: "PJFET", SW: "VSWITCH", SUBCKT: "SUBCKT",
}

function fromFields(f: SimFields, sym: SymbolDef, origin: "part" | "symbol"): ResolvedSim | { error: string } {
  const device = (f.Device ?? "").toUpperCase()
  const kind = DEVICE_KIND[device]
  if (!kind) return { error: `Sim.Device “${f.Device}” is not supported yet` }
  const pins = f.Pins ? parsePins(f.Pins) : (twoPin(sym) ?? {})
  return { kind, pins, params: parseParams(f.Params), type: f.Type?.toUpperCase(), model: f.Name, origin }
}

/** Resolve how a part simulates, or why it can't. */
export function resolveSim(part: Part): ResolvedSim | { error: string } | null {
  const sym = symbolFor(part)
  if (!sym) return { error: `symbol ${part.lib} not loaded` }
  if (isVirtual(part)) return null
  // Arduino / Pico: the firmware drives the pins (cosim/); a plain run sees the board's supplies
  if (isProgrammable(part)) return { kind: "MCU", pins: {}, params: {}, origin: "inferred", note: "runs its sketch when the circuit and firmware simulate together" }
  // the power unit of a multi-unit IC (e.g. LM358 unit C: V+/V−) only connects pins; the other units' models use them
  const u = sym.units[part.unit - 1]
  if (sym.units.length > 1 && u && u.pins.length && u.pins.every((p) => p.t === "power_in" || p.t === "power_out")) return null
  if (part.sim?.Exclude === "1") return { error: "excluded from simulation" }
  if (part.sim?.Device) return fromFields({ ...sym.sim, ...part.sim }, sym, "part")
  if (sym.sim?.Enable === "0") return { error: "the symbol is graphic only (Sim.Enable = 0)" }
  if (sym.sim?.Device) {
    const r = fromFields({ ...sym.sim, ...part.sim }, sym, "symbol")
    if ("error" in r) return r
    if (r.kind === "SUBCKT" && /^kicad_builtin_opamp/.test(r.model ?? "")) {
      const inf = infer(sym, part)
      if (inf) return { ...inf, params: { ...inf.params, ...parseParams(part.sim?.Params) }, origin: "inferred" }
    }
    // base symbols (e.g. Q_NPN_EBC, D) give pins but no model: take the model from the Value (2N3904, 1N4148 …)
    if (["D", "NPN", "PNP", "NMOS", "PMOS", "NJFET", "PJFET"].includes(r.kind) && !r.model && !Object.keys(r.params).length && !r.type) {
      const inf = infer(sym, part)
      if (inf && inf.kind === r.kind) return { ...r, model: inf.model, type: inf.type, note: inf.note }
    }
    return r
  }
  if (sym.excludeFromSim) return { error: "the symbol is marked “exclude from simulation”" }
  const inferred = infer(sym, part)
  if (!inferred) return { error: `no simulation model for ${sym.name} yet` }
  const params = { ...inferred.params, ...parseParams(part.sim?.Params) }
  return { ...inferred, params, origin: "inferred" }
}

function infer(sym: SymbolDef, part: Part): Omit<ResolvedSim, "origin"> | null {
  const names = [sym.name, ...sym.bases].join(" ")
  const text = `${names} ${part.value} ${sym.desc}`
  const pins = allPins(sym)
  const lib = sym.lib
  const ref = sym.refPrefix.toUpperCase()

  // ---- catalogue sensors (lib/sensors.ts): FSR, gas, humidity, pressure, Hall, distance, PIR …
  const sm = sensorModelFor(lib, sym.name, part.value)
  if (sm) {
    const named = (roles: Record<string, string[]>) => pinMap(pins, roles)
    const pm = sm.shape === "resistive" ? twoPin(sym)
      : sm.shape === "bridge" ? named({ "e+": ["E+"], "e-": ["E-"], "s+": ["S+"], "s-": ["S-"] })
      : sm.shape === "current" ? named(sm.pins ?? {})
      : named(sm.pins ?? { vs: ["VCC"], out: ["OUT"], gnd: ["GND"] })
    if (pm) {
      const defaults = { ...sm.defaults, ...(sm.shape === "current" ? { sens: currentSensitivity(sym.name) } : {}) }
      return { kind: "SENSOR", type: sm.id, env: sm.senses ?? undefined, pins: pm, params: Object.fromEntries(Object.entries(defaults).map(([k, v]) => [k, String(v)])), note: sm.note }
    }
  }

  // ---- environment sensors: values follow what they sense (feeds, Kirk `stimulus { }`)
  const tp2 = twoPin(sym)
  if (tp2 && ((lib === "Device" && /^R_Photo/.test(sym.name)) || (lib === "Sensor_Optical" && /^LDR/.test(sym.name)))) {
    return { kind: "R", type: "LDR", env: "light", pins: tp2, params: { r10: "10k", gamma: "0.7", rdark: "1Meg" }, note: "light-dependent resistor: R = R10·(lux/10)^−γ" }
  }
  if (tp2 && lib === "Device" && /^Thermistor/.test(sym.name)) {
    const ptc = /PTC/.test(sym.name)
    return { kind: "R", type: ptc ? "PTC" : "NTC", env: "temp", pins: tp2, params: ptc ? { tc: "0.05" } : { beta: "3950" }, note: ptc ? "PTC thermistor: R = R25·e^(tc·(T−25 °C))" : "NTC thermistor (β model): R = R25·e^(β(1/T − 1/298 K))" }
  }
  if (lib === "Device" && /^D_Photo/.test(sym.name)) {
    const pm = pinMap(pins, { A: ["A"], K: ["K"] })
    if (pm) return { kind: "D", env: "light", pins: pm, params: { resp: "50n" }, model: "D_PHOTO", type: "D(IS=1n N=1.6 RS=10 CJO=50p BV=60)", note: "photodiode: 50 nA per lux of photocurrent" }
  }
  if (lib === "Device" && /^Q_Photo_NPN/.test(sym.name)) {
    const pm = pinMap(pins, { C: ["C"], E: ["E"], ...(pins.some((q) => q.name === "B") ? { B: ["B"] } : {}) })
    if (pm) return { kind: "NPN", env: "light", pins: pm, params: { resp: "10n" }, model: "Q_PHOTO", type: GENERIC.NPN, note: "phototransistor: 10 nA per lux into the base" }
  }
  if (lib === "Device" && /^Microphone/.test(sym.name)) {
    const pm = pinMap(pins, { "+": ["+"], "-": ["-"] })
    if (pm) return { kind: "V", env: "sound", pins: pm, params: { sens: "-42", rs: "2.2k" }, note: "electret microphone: −42 dBV/Pa, 2.2 kΩ, plays the room's sound" }
  }
  if (lib === "Sensor_Temperature" && /^(LM35|TMP3[67])/.test(sym.name)) {
    const pm = pinMap(pins, { vs: ["+V_{S}", "+Vs", "+VS", "VS", "V+"], out: ["V_{OUT}", "VOUT", "OUT"], gnd: ["GND"] })
    if (pm) return { kind: "TEMPSENSOR", env: "temp", type: /TMP/.test(sym.name) ? "TMP36" : "LM35", pins: pm, params: {}, note: /TMP/.test(sym.name) ? "0.5 V + 10 mV/°C" : "10 mV/°C" }
  }

  // ---- passives
  if (lib === "Device" && /^R_?Potentiometer|^R_POT/i.test(sym.name)) {
    const ps = pins.filter((p) => !p.h)
    if (ps.length === 3) return { kind: "R", type: "POT", pins: { [ps[0].n]: "r0", [ps[1].n]: "wiper", [ps[2].n]: "r1" }, params: { pos: "0.5" } }
  }
  const tp = twoPin(sym)
  if (tp && (lib === "Device" || ref === "R" || ref === "C" || ref === "L")) {
    if (ref === "R" && /^R/.test(sym.name)) return { kind: "R", pins: tp, params: {} }
    if (ref === "C" && /^C/.test(sym.name)) return { kind: "C", pins: tp, params: {} }
    if (ref === "L" && /^L/.test(sym.name)) return { kind: "L", pins: tp, params: {} }
    if (/^Lamp/.test(sym.name)) return { kind: "R", pins: tp, params: { r: "100" }, note: "modelled as a 100 Ω filament" }
    if (/^Speaker/.test(sym.name)) return { kind: "R", pins: tp, params: { r: "8" }, note: "modelled as 8 Ω" }
    if (/^Buzzer/.test(sym.name)) return { kind: "R", pins: tp, params: { r: "50" }, note: "modelled as 50 Ω" }
    if (/^(Fuse|Polyfuse)/.test(sym.name)) return { kind: "R", pins: tp, params: { r: "0.05" }, note: "modelled as 50 mΩ" }
  }
  if (tp && lib === "Motor" && /^(Motor_DC|Fan$|Fan_ALT|Fan_IEC|Fan_ISO)/.test(sym.name)) return { kind: "R", pins: tp, params: { r: "20" }, note: "modelled as a 20 Ω winding" }
  if (lib === "Device" && /^Battery/.test(sym.name)) {
    const pm = pinMap(pins, { "+": ["+"], "-": ["-"] })
    if (pm) return { kind: "V", type: "DC", pins: pm, params: {} }
  }

  // ---- diodes & LEDs
  const isLed = /LED/i.test(names) || lib === "LED"
  if (ref === "D" || lib === "Diode" || lib === "LED" || lib === "Diode_Laser") {
    const pm = pinMap(pins, { A: ["A"], K: ["K"] })
    if (pm) {
      if (isLed) { const l = ledFor(`${part.value} ${sym.desc}`); return { kind: "D", pins: pm, params: {}, model: l.name, type: l.model } }
      if (/zener|BZX|BZT|ZMM|1N47[2-4]\d|^MMSZ/i.test(text)) {
        const bv = zenerVoltage(`${part.value} ${sym.name}`) ?? 5.1
        return { kind: "D", pins: pm, params: {}, model: `DZ_${String(bv).replace(".", "V")}`, type: zener(bv), note: `zener ${bv} V` }
      }
      const known = knownModel("D", part.value) ?? knownModel("D", sym.name)
      if (known) return { kind: "D", pins: pm, params: {}, model: modelName(part.value), type: known }
      if (/schottky|^BAT|^SS1|^SB\d|^MBR|^1N58/i.test(text)) return { kind: "D", pins: pm, params: {}, model: "D_SCHOTTKY", type: GENERIC_SCHOTTKY, note: "generic Schottky model" }
      return { kind: "D", pins: pm, params: {}, model: "D_GENERIC", type: GENERIC_DIODE, note: `generic diode model (no model for “${part.value}”)` }
    }
  }

  // ---- transistors
  if (ref === "Q" || /^Transistor/.test(lib)) {
    const kind: SimKind | null =
      /PNP/i.test(names) || /\bPNP\b/i.test(sym.desc) ? "PNP"
      : /NPN/i.test(names) || /\bNPN\b/i.test(sym.desc) ? "NPN"
      : /PMOS|P-?Channel.*MOS|P-?MOS/i.test(`${names} ${sym.desc}`) && !/JFET/i.test(`${names} ${sym.desc}`) ? "PMOS"
      : /NMOS|N-?Channel.*MOS|N-?MOS/i.test(`${names} ${sym.desc}`) && !/JFET/i.test(`${names} ${sym.desc}`) ? "NMOS"
      : /PJFET|P-?Channel.*JFET/i.test(`${names} ${sym.desc}`) ? "PJFET"
      : /NJFET|JFET/i.test(`${names} ${sym.desc}`) ? "NJFET"
      : null
    if (kind) {
      const roles: Record<string, string[]> = kind === "NPN" || kind === "PNP" ? { C: ["C"], B: ["B"], E: ["E"] } : { D: ["D"], G: ["G"], S: ["S"] }
      const pm = pinMap(pins, roles)
      if (pm) {
        const known = knownModel(kind as ModelKind, part.value) ?? knownModel(kind as ModelKind, sym.name)
        return known
          ? { kind, pins: pm, params: {}, model: modelName(part.value), type: known }
          : { kind, pins: pm, params: {}, model: `${kind}_GENERIC`, type: GENERIC[kind as keyof typeof GENERIC], note: `generic ${kind} model (no model for “${part.value}”)` }
      }
    }
  }

  // ---- ICs
  if (/^(Amplifier_Operational|Amplifier_Audio)$/.test(lib) || (pins.some((p) => p.name === "+") && pins.some((p) => p.name === "-") && pins.some((p) => /^V[+]|^VCC|^V\+$/i.test(p.name)))) {
    const unit = sym.units[part.unit - 1]
    const inP = unit?.pins.find((p) => p.name === "+")
    const inN = unit?.pins.find((p) => p.name === "-")
    const out = unit?.pins.find((p) => p.t === "output" || p.name === "~" || p.name.toUpperCase() === "OUT")
    if (inP && inN && out) {
      const vcc = byName(pins, "V+", "VCC", "VS+", "+VS", "VDD")
      const vee = byName(pins, "V-", "VEE", "VS-", "-VS", "VSS", "GND")
      if (vcc && vee) {
        const { gbw, gain } = opampParams(part.value || sym.name)
        return {
          kind: "OPAMP", pins: { [inP.n]: "in+", [inN.n]: "in-", [vcc]: "vcc", [vee]: "vee", [out.n]: "out" },
          params: { gain: String(gain), pole: String(gbw / gain), voff: "0", rout: "10" }, model: "kicad_builtin_opamp",
          note: `single-pole op-amp, GBW ${gbw / 1e6} MHz`,
        }
      }
    }
  }
  if (lib === "Timer" && /555/.test(names)) {
    const pm = pinMap(pins, { gnd: ["GND"], trig: ["TRIG", "TR"], out: ["OUT", "Q"], rst: ["~{RST}", "~{R}", "R", "RESET", "~{RESET}"], ctrl: ["CONT", "CV", "CTRL"], thr: ["THRES", "THR", "TH"], dis: ["DISCH", "DIS"], vcc: ["VCC", "V+"] })
    if (pm) return { kind: "555", pins: pm, params: {}, model: "sb_555", note: "behavioural 555" }
  }
  if (/^Regulator_Linear$/.test(lib)) {
    if (/317|LM1117-ADJ|ADJ/i.test(names)) {
      const pm = pinMap(pins, { in: ["VI", "IN", "VIN"], adj: ["ADJ"], out: ["VO", "OUT", "VOUT"] })
      if (pm) return { kind: "REGADJ", pins: pm, params: { vref: "1.25", drop: "2" }, model: "sb_regadj", note: "Vout = Vadj + 1.25 V" }
    }
    const v = regulatorVoltage(part.value) ?? regulatorVoltage(sym.name)
    const pm = pinMap(pins, { in: ["VI", "IN", "VIN"], gnd: ["GND"], out: ["VO", "OUT", "VOUT"] })
    if (v !== undefined && pm) return { kind: "REG", pins: pm, params: { vout: String(v), drop: /^(L|LM|MC|UA|KA)?7[89]/i.test(sym.name) ? "2" : "1" }, model: v < 0 ? "sb_regn" : "sb_reg", note: `fixed ${v} V regulator` }
  }
  if (lib === "Switch" || ref === "SW") {
    const ps = pins.filter((p) => !p.h)
    if (ps.length === 2) return { kind: "SWITCH", pins: { [ps[0].n]: "1", [ps[1].n]: "2" }, params: { closed: "0" }, note: "click Closed in the Inspector to toggle" }
  }
  return null
}

const modelName = (v: string) => v.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_") || "M"

// ---------------------------------------------------------------- netlist

export interface SpiceNetlist {
  text: string
  /** spice node (lower case) → schematic net name */
  nodes: Map<string, string>
  /** spice element name (upper case) → displayed reference */
  elements: Map<string, string>
  issues: Issue[]
  /** parts that are simulated */
  simulated: number
}

export type AnalysisKind = "tran" | "ac" | "op" | "dc"

export function analysisLine(doc: Doc, a: AnalysisKind): string {
  const s = doc.analyses
  if (a === "tran") return `.tran ${spiceNum(s.tran.step)} ${spiceNum(s.tran.stop)} 0 ${spiceNum(s.tran.step)}`
  if (a === "ac") return `.ac dec ${s.ac.points ?? 60} ${spiceNum(s.ac.start)} ${spiceNum(s.ac.stop)}`
  if (a === "dc" && s.dc) return `.dc ${s.dc.source} ${spiceNum(s.dc.start)} ${spiceNum(s.dc.stop)} ${spiceNum(s.dc.step)}`
  return ".op"
}

/** Solver options from Settings → Simulation engine (ngspice defaults are left out of the netlist). */
export interface SolverOptions { reltol?: number; abstol?: number; vntol?: number; gmin?: number; method?: "trap" | "gear"; saveCurrents?: boolean }
const NGSPICE_DEFAULTS = { reltol: 1e-3, abstol: 1e-12, vntol: 1e-6, gmin: 1e-12 }
let solver: SolverOptions = {}
export function setSolverOptions(o: SolverOptions) { solver = o }

export function optionsLine(analysis: AnalysisKind, o: SolverOptions = solver): string {
  const opts: string[] = []
  // device currents (I(R1), Ic(Q1)…); ngspice cannot export them from AC analysis
  if (analysis !== "ac" && o.saveCurrents !== false) opts.push("savecurrents")
  opts.push("rshunt=1e12")
  for (const k of ["reltol", "abstol", "vntol", "gmin"] as const) {
    const v = o[k]
    if (v !== undefined && Number.isFinite(v) && v > 0 && Math.abs(v / NGSPICE_DEFAULTS[k] - 1) > 1e-9) opts.push(`${k}=${spiceNum(v)}`)
  }
  if (o.method === "gear") opts.push("method=gear")
  return `.options ${opts.join(" ")}`
}

/**
 * `boards`: what each programmable board's pins do over the run (co-simulation, by reference);
 * `ic`: net voltages to start from (`.ic`, carried from one co-simulation frame to the next).
 */
export interface NetlistOptions { temp?: number; boards?: Map<string, BoardDrive>; ic?: Map<string, number> }

export function buildNetlist(doc: Doc, nl: Netlist, analysis: AnalysisKind, opts: NetlistOptions = {}): SpiceNetlist {
  const issues: Issue[] = []
  const nodes = new Map<string, string>()
  const byNet = new Map<string, string>()
  const node = (net: string | undefined): string => {
    if (net === undefined) return "0"
    if (net === "0") return "0"
    let n = byNet.get(net)
    if (!n) {
      const base = net.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^_+/, "") || "n"
      n = /^\d/.test(base) || base === "0" ? `n${base}` : base
      while (nodes.has(n)) n += "_"
      nodes.set(n, net)
      byNet.set(net, n)
    }
    return n
  }
  const elements = new Map<string, string>()
  const lines: string[] = []
  const models = new Map<string, string>()
  const name = (letter: string, ref: string) => {
    const n = ref.toUpperCase().startsWith(letter) ? ref : `${letter}${ref}`
    elements.set(n.toUpperCase(), ref)
    return n
  }
  let dangling = 0
  let simulated = 0
  const done = new Set<string>() // package-level devices emitted once per reference
  // feeds (Kirk stimulus { }): time-varying ones only matter in a transient
  const tstop = doc.analyses.tran.stop
  const { feeds } = resolveFeeds(doc, tstop)
  const timed = analysis === "tran"
  const varying = (s: Signal | null | undefined) => !!s && timed && !s.constant
  let nsig = 0
  /** a node carrying the signal as a voltage (internal: not in the results) */
  const sigNode = (s: Signal) => {
    const n = `sbsig${++nsig}`
    lines.push(`V__SIG${nsig} ${n} 0 ${pwlSpec(samplePwl(s, tstop))}`)
    return n
  }
  /** a behavioural part between a and b with an inline 0 V ammeter, so I(ref) is still reported */
  const behaviouralR = (ref: string, a: string, b: string, rExpr: string) => {
    const x = `sbint_${ref.toLowerCase()}_x`, meter = `V${ref.toUpperCase()}_M`
    lines.push(`${meter} ${a} ${x} 0`)
    elements.set(meter, ref)
    lines.push(`B${ref.toUpperCase()}_R ${x} ${b} I=V(${x},${b})/(${rExpr})`)
  }
  const sensed = (ref: string, sense: Quantity) => sensorSignal(feeds, ref, sense)
  const sensedNow = (ref: string, sense: Quantity) => sensed(ref, sense)?.at(0) ?? QUANTITIES[sense].base
  const control = (ref: string) => feeds.get(ref.toUpperCase())?.signal ?? null

  for (const part of doc.parts) {
    const sim = resolveSim(part)
    if (sim === null) continue
    const ref = displayRef(part)
    if ("error" in sim) {
      issues.push({ severity: "warning", message: `${ref} not simulated: ${sim.error}`, ref: part.ref })
      continue
    }
    const sym = getSymbol(part.lib)!
    const net = (pin: string) => nl.pinNet.get(`${part.ref}.${pin}`)
    const roleNode = (role: string): string | null => {
      const pin = Object.entries(sim.pins).find(([, r]) => r.toLowerCase() === role.toLowerCase())?.[0]
      if (!pin) return null
      const n = net(pin)
      if (n === undefined) {
        // pin of a unit that is not placed (e.g. the op-amp power unit)
        const unit = sym.units.findIndex((u) => u.pins.some((q) => q.n === pin))
        if (unit >= 0 && sym.units.length > 1 && unit + 1 !== part.unit) {
          issues.push({ severity: "error", message: `${part.ref}: place unit ${unitLetter(unit + 1)} (pin ${pin}) — the simulator needs it`, ref: part.ref })
        }
        return `nc_${++dangling}`
      }
      return node(n)
    }
    const nodesOf = (...roles: string[]) => roles.map((r) => roleNode(r) ?? `nc_${++dangling}`).join(" ")
    const p = sim.params
    const num = (k: string, fallback: number) => parseValue(p[k]) ?? fallback

    switch (sim.kind) {
      case "R": case "C": case "L": {
        if (done.has(part.ref)) break
        if (sim.type === "POT") {
          const r = parseValue(p.r) ?? parseValue(part.value) ?? 10e3
          const fed = control(part.ref)
          const base = name("R", part.ref)
          if (varying(fed)) {
            const n = sigNode(fed!), [r0, w, r1] = [nodesOf("r0"), nodesOf("wiper"), nodesOf("r1")]
            behaviouralR(part.ref, r0, w, `${spiceNum(r)}*max(min(V(${n}),0.999),0.001)`)
            lines.push(`B${part.ref.toUpperCase()}_RB ${w} ${r1} I=V(${w},${r1})/(${spiceNum(r)}*max(min(1-V(${n}),0.999),0.001))`)
            break
          }
          const pos = Math.min(0.999, Math.max(0.001, fed ? fed.at(0) : num("pos", 0.5)))
          lines.push(`${base}_A ${nodesOf("r0", "wiper")} ${spiceNum(r * pos)}`)
          lines.push(`${base}_B ${nodesOf("wiper", "r1")} ${spiceNum(r * (1 - pos))}`)
          elements.set(`${base}_A`.toUpperCase(), part.ref)
          break
        }
        const keyName = sim.kind.toLowerCase()
        const nominal = parseValue(p[keyName]) ?? parseValue(part.value)
        // sensors: the value comes from what they sense (their feed, the room's, or the default)
        const sense = sim.type === "LDR" ? "light" : sim.type === "NTC" || sim.type === "PTC" ? "temp" : null
        if (sense) {
          const s = sensed(part.ref, sense)
          if (varying(s)) {
            const n = sigNode(s!), roles = Object.values(sim.pins)
            const [a, b] = [nodesOf(roles[0] ?? "1"), nodesOf(roles[1] ?? "2")]
            const rx = sim.type === "LDR"
              ? `max(min(${spiceNum(num("r10", 10e3))}*pow(max(V(${n}),0.001)/10,${-num("gamma", 0.7)}),${spiceNum(num("rdark", 1e6))}),50)`
              : sim.type === "NTC" ? `${spiceNum(nominal ?? 10e3)}*exp(${num("beta", 3950)}*(1/(V(${n})+273.15)-1/298.15))`
              : `${spiceNum(nominal ?? 100)}*exp(${num("tc", 0.05)}*(V(${n})-25))`
            behaviouralR(part.ref, a, b, rx)
            break
          }
        }
        const v = sim.type === "LDR" ? ldrResistance(sensedNow(part.ref, "light"), num("r10", 10e3), num("gamma", 0.7), num("rdark", 1e6))
          : sim.type === "NTC" ? ntcResistance(sensedNow(part.ref, "temp"), nominal ?? 10e3, num("beta", 3950))
          : sim.type === "PTC" ? ptcResistance(sensedNow(part.ref, "temp"), nominal ?? 100, num("tc", 0.05))
          : nominal
        if (v === null) { issues.push({ severity: "error", message: `${ref}: value “${part.value}” is not a number (e.g. 10k, 100n, 4k7)`, ref: part.ref }); break }
        const roles = Object.values(sim.pins)
        lines.push(`${name(sim.kind, part.ref)} ${nodesOf(roles[0] ?? "1", roles[1] ?? "2")} ${spiceNum(v)}`)
        break
      }
      case "V": case "I": {
        if (sim.env === "sound") {
          // microphone: what it hears as a sine behind the capsule's source resistance
          const inner = `sbint_${part.ref.toLowerCase()}_mic` // internal: not a schematic net, so not in the results
          const tone = sensedNow(part.ref, "tone"), lvl = sensed(part.ref, "sound")
          if (varying(lvl)) {
            const n = sigNode(lvl!), k = Math.pow(10, num("sens", -42) / 20) * Math.SQRT2
            lines.push(`B${part.ref.toUpperCase()} ${inner} ${nodesOf("-")} V=${spiceNum(k)}*pow(10,(V(${n})-94)/20)*sin(${spiceNum(2 * Math.PI * tone)}*time)`)
            lines.push(`${name("V", part.ref)}_M ${nodesOf("+")} sbint_${part.ref.toLowerCase()}_m 0`)
            elements.set(`V${part.ref.toUpperCase()}_M`, part.ref)
            lines.push(`R${part.ref.toUpperCase()}_S sbint_${part.ref.toLowerCase()}_m ${inner} ${spiceNum(num("rs", 2.2e3))}`)
            break
          }
          const a = micAmplitude(sensedNow(part.ref, "sound"), num("sens", -42))
          lines.push(`${name("V", part.ref)} ${inner} ${nodesOf("-")} SIN(0 ${spiceNum(a)} ${spiceNum(tone)}) AC ${spiceNum(a)}`)
          lines.push(`R${part.ref.toUpperCase()}_S ${nodesOf("+")} ${inner} ${spiceNum(num("rs", 2.2e3))}`)
          break
        }
        const roles = Object.values(sim.pins)
        const pos = roles.includes("+") ? "+" : roles[0], neg = roles.includes("-") ? "-" : roles[1]
        // a fed source: its value over time (transient) or at t = 0; a DC sweep's own source stays swept
        const fed = feeds.get(part.ref.toUpperCase())?.signal
        const swept = analysis === "dc" && doc.analyses.dc?.source.toUpperCase() === part.ref.toUpperCase()
        if (fed && !swept) {
          const acMag = /\bAC\s+(\S+)/i.exec(sourceSpec(sim, part))?.[1]
          const spec = varying(fed) ? pwlSpec(samplePwl(fed!, tstop)) : `DC ${spiceNum(fed.at(0))}`
          lines.push(`${name(sim.kind, part.ref)} ${nodesOf(pos, neg)} ${spec}${acMag && analysis === "ac" ? ` AC ${acMag}` : ""}`)
          break
        }
        lines.push(`${name(sim.kind, part.ref)} ${nodesOf(pos, neg)} ${sourceSpec(sim, part)}`)
        break
      }
      case "D": {
        const m = sim.model ?? `D_${part.ref.toUpperCase()}`
        if (sim.type) models.set(m, `.model ${m} ${sim.type}`)
        else models.set(m, `.model ${m} D(${formatParamsSpice(p)})`)
        lines.push(`${name("D", part.ref)} ${nodesOf("A", "K")} ${m}`)
        // photodiode: light makes a reverse current, cathode → anode inside the device
        if (sim.env === "light") {
          const s = sensed(part.ref, "light")
          lines.push(varying(s)
            ? `B${part.ref.toUpperCase()}_PH ${nodesOf("K", "A")} I=${spiceNum(num("resp", 50e-9))}*max(V(${sigNode(s!)}),0)`
            : `I${part.ref.toUpperCase()}_PH ${nodesOf("K", "A")} DC ${spiceNum(photoCurrent(sensedNow(part.ref, "light"), num("resp", 50e-9)))}`)
        }
        break
      }
      case "NPN": case "PNP": {
        const m = sim.model ?? `Q_${part.ref.toUpperCase()}`
        models.set(m, `.model ${m} ${sim.type && /^(NPN|PNP)\(/.test(sim.type) ? sim.type : `${sim.kind}(${formatParamsSpice(p)})`}`)
        if (sim.env === "light") {
          // phototransistor: light drives the base (internal when the symbol has no base pin)
          const b = roleNode("B") ?? `sbint_${part.ref.toLowerCase()}_b`
          lines.push(`${name("Q", part.ref)} ${nodesOf("C")} ${b} ${nodesOf("E")} ${m}`)
          const s = sensed(part.ref, "light")
          lines.push(varying(s)
            ? `B${part.ref.toUpperCase()}_PH ${nodesOf("C")} ${b} I=${spiceNum(num("resp", 10e-9))}*max(V(${sigNode(s!)}),0)`
            : `I${part.ref.toUpperCase()}_PH ${nodesOf("C")} ${b} DC ${spiceNum(photoCurrent(sensedNow(part.ref, "light"), num("resp", 10e-9)))}`)
          break
        }
        lines.push(`${name("Q", part.ref)} ${nodesOf("C", "B", "E")} ${m}`)
        break
      }
      case "NMOS": case "PMOS": {
        const m = sim.model ?? `M_${part.ref.toUpperCase()}`
        const fourPin = Object.values(sim.pins).includes("B")
        if (sim.type?.startsWith("VDMOS(")) models.set(m, `.model ${m} ${sim.type}`)
        else if (fourPin || sim.type === "MOS1") models.set(m, `.model ${m} ${sim.kind}(LEVEL=1 ${formatParamsSpice(p)})`)
        else models.set(m, `.model ${m} VDMOS(${sim.kind === "PMOS" ? "pchan " : ""}${formatParamsSpice(p) || (sim.kind === "PMOS" ? "Vto=-2 Kp=1" : "Vto=2 Kp=1")})`)
        lines.push(`${name("M", part.ref)} ${fourPin ? nodesOf("D", "G", "S", "B") : nodesOf("D", "G", "S")} ${m}`)
        break
      }
      case "NJFET": case "PJFET": {
        const m = sim.model ?? `J_${part.ref.toUpperCase()}`
        models.set(m, `.model ${m} ${sim.type && /^[NP]JF\(/.test(sim.type) ? sim.type : `${sim.kind === "NJFET" ? "NJF" : "PJF"}(${formatParamsSpice(p)})`}`)
        lines.push(`${name("J", part.ref)} ${nodesOf("D", "G", "S")} ${m}`)
        break
      }
      case "OPAMP": {
        models.set("kicad_builtin_opamp", SUBCKT_OPAMP)
        const params = Object.entries(p).filter(([k]) => /^(gain|pole|voff|rout)$/.test(k)).map(([k, v]) => `${k.toUpperCase()}=${spiceNum(parseValue(v) ?? 0)}`).join(" ")
        const unit = sym.units.length > 1 ? unitLetter(part.unit) : ""
        lines.push(`${name("X", part.ref)}${unit} ${nodesOf("in+", "in-", "vcc", "vee", "out")} kicad_builtin_opamp ${params}`)
        break
      }
      case "555": {
        if (done.has(part.ref)) break
        models.set("sb_555", SUBCKT_555)
        lines.push(`${name("X", part.ref)} ${nodesOf("gnd", "trig", "out", "rst", "ctrl", "thr", "dis", "vcc")} sb_555`)
        break
      }
      case "REG": {
        if (done.has(part.ref)) break
        const neg = sim.model === "sb_regn"
        models.set(neg ? "sb_regn" : "sb_reg", neg ? SUBCKT_REG_NEG : SUBCKT_REG)
        lines.push(`${name("X", part.ref)} ${nodesOf("in", "gnd", "out")} ${neg ? "sb_regn" : "sb_reg"} vout=${spiceNum(num("vout", 5))} drop=${spiceNum(num("drop", 2))}`)
        break
      }
      case "REGADJ": {
        if (done.has(part.ref)) break
        models.set("sb_regadj", SUBCKT_REG_ADJ)
        lines.push(`${name("X", part.ref)} ${nodesOf("in", "adj", "out")} sb_regadj vref=${spiceNum(num("vref", 1.25))} drop=${spiceNum(num("drop", 2))}`)
        break
      }
      case "SENSOR": {
        const m = SENSOR_MODELS.find((x) => x.id === sim.type)
        if (!m) break
        const pr = Object.fromEntries(Object.entries(p).map(([k, v]) => [k, parseValue(v) ?? Number(v)]))
        const s = m.senses ? sensed(part.ref, m.senses) : null
        const q0 = s ? s.at(0) : m.senses ? QUANTITIES[m.senses].base : 0
        // the sensor's response: a number now, or a pwl() table over its feed (transient)
        const resp = varying(s) ? `pwl(V(${sigNode(s!)}),${curveTable(m, pr)})` : spiceNum(m.curve(q0, pr))
        const R = part.ref.toUpperCase(), int = `sbint_${part.ref.toLowerCase()}`
        if (m.shape === "resistive") {
          const roles = Object.values(sim.pins), [a, b] = [nodesOf(roles[0]), nodesOf(roles[1])]
          if (varying(s)) behaviouralR(part.ref, a, b, resp)
          else lines.push(`${name("R", part.ref)} ${a} ${b} ${resp}`)
          break
        }
        if (m.shape === "bridge") {
          // excitation across E+/E−; each output is a divider tap ± ½ of the bridge imbalance, 1 kΩ source resistance
          const [ep, en, sp, sn] = [nodesOf("e+"), nodesOf("e-"), nodesOf("s+"), nodesOf("s-")]
          lines.push(`${name("R", part.ref)} ${ep} ${en} 1k`)
          lines.push(`B${R}_P ${int}_p ${en} V=V(${ep},${en})*(0.5+(${resp})/2)`, `R${R}_SP ${int}_p ${sp} 1k`)
          lines.push(`B${R}_N ${int}_n ${en} V=V(${ep},${en})*(0.5-(${resp})/2)`, `R${R}_SN ${int}_n ${sn} 1k`)
          break
        }
        const [vs, out, gnd] = [roleNode("vs") ?? "0", roleNode("out") ?? `nc_${++dangling}`, roleNode("gnd") ?? "0"]
        lines.push(`R${R}_Q ${vs} ${gnd} 50k`) // supply current
        if (m.shape === "opendrain") {
          lines.push(`B${R} ${out} ${gnd} I=V(${out},${gnd})*(1e-9+10*(${resp}))`)
          break
        }
        if (m.shape === "current") {
          // the measured current flows IP+ → IP− through a 0 V ammeter (1 mΩ conductor in a real part)
          const meter = `V${R}_M`
          lines.push(`${meter} ${nodesOf("ipp")} ${nodesOf("ipn")} 0`)
          elements.set(meter, part.ref)
          lines.push(`B${R} ${int}_o ${gnd} V=max(min(V(${vs},${gnd})*(0.5+${spiceNum(num("sens", 0.185) / 5)}*i(${meter})),V(${vs},${gnd})),0)`, `R${R}_O ${int}_o ${out} 100`)
          break
        }
        // module: ratiometric (fraction of the supply) or absolute volts, never above the supply; 100 Ω output
        const v = m.ratiometric ? `V(${vs},${gnd})*(${resp})` : `min(${resp},max(V(${vs},${gnd})-0.2,0))`
        lines.push(`B${R} ${int}_o ${gnd} V=max(${v},0)`, `R${R}_O ${int}_o ${out} 100`)
        break
      }
      case "TEMPSENSOR": {
        // analog temperature sensor: output follows the room, needs its supply (≈ 80 µA)
        const [vs, out, gnd] = [roleNode("vs") ?? "0", roleNode("out") ?? `nc_${++dangling}`, roleNode("gnd") ?? "0"]
        const s = sensed(part.ref, "temp"), tmp = sim.type === "TMP36"
        const v = varying(s) ? `${tmp ? "max(min(0.5+0.01*" : "max(min(0.01*"}V(${sigNode(s!)}),${tmp ? 2 : 1.5}),${tmp ? 0.1 : 0})` : spiceNum(tempSensorVolts(sensedNow(part.ref, "temp"), tmp ? "TMP36" : "LM35"))
        lines.push(`${name("B", part.ref)} ${out} ${gnd} V=min(max(V(${vs},${gnd})-0.5,0),${v})`)
        lines.push(`R${part.ref.toUpperCase()}_Q ${vs} ${gnd} 60k`)
        break
      }
      case "SWITCH": {
        const fed = control(part.ref)
        if (varying(fed)) {
          // a fed switch: closes above 0.5 (smoothly, so the solver can follow the edge)
          const n = sigNode(fed!), x = `sbint_${part.ref.toLowerCase()}_x`, meter = `V${part.ref.toUpperCase()}_M`, [a, b] = [nodesOf("1"), nodesOf("2")]
          lines.push(`${meter} ${a} ${x} 0`)
          elements.set(meter, part.ref)
          lines.push(`B${part.ref.toUpperCase()}_SW ${x} ${b} I=V(${x},${b})*(1e-12+100/(1+exp(-40*(V(${n})-0.5))))`)
          break
        }
        const closed = fed ? fed.at(0) > 0.5 : /^(1|true|yes|on|closed)$/i.test(p.closed ?? "0")
        lines.push(`${name("R", part.ref)} ${nodesOf("1", "2")} ${closed ? "0.01" : "1e12"}`)
        break
      }
      case "VSWITCH": {
        const m = `SW_${part.ref.toUpperCase()}`
        models.set(m, `.model ${m} SW(Vt=${spiceNum(num("thr", 0))} Ron=${spiceNum(num("ron", 1))} Roff=${spiceNum(num("roff", 1e9))})`)
        lines.push(`${name("S", part.ref)} ${nodesOf("no+", "no-", "ctrl+", "ctrl-")} ${m}`)
        break
      }
      case "SUBCKT": {
        if (sim.model === "kicad_builtin_vdiff") {
          lines.push(`${name("E", part.ref)} ${nodesOf("out")} 0 ${nodesOf("in+", "in-")} 1`)
          break
        }
        // a Kirk component: its compiled parameter set is a .subckt carried by the document
        const comp = sim.model ? doc.components?.find((c) => c.variants[sim.model!]) : undefined
        if (comp) {
          for (const [k, t] of Object.entries(comp.variants[sim.model!].models)) models.set(k, t)
          lines.push(`${name("X", part.ref)} ${nodesOf(...comp.pins)} ${sim.model}`)
          break
        }
        if (part.lib.startsWith("kirk:")) { issues.push({ severity: "warning", message: `${ref}: compiling component ${part.value} for these parameters…`, ref: part.ref }); continue }
        issues.push({ severity: "warning", message: `${ref} not simulated: subcircuit ${sim.model ?? "?"} needs a model library (coming with model import)`, ref: part.ref })
        continue
      }
      case "MCU": {
        if (done.has(part.ref)) break
        boardLines(part, sym, boardOf(part)!, opts.boards?.get(part.ref), net, node, lines, elements)
        break
      }
    }
    done.add(part.ref)
    simulated++
  }

  const text = [
    `* ${doc.title} — Space Bench (ngspice)`,
    optionsLine(analysis),
    ...models.values(),
    ...lines,
    ...[...(opts.ic ?? [])].filter(([n]) => byNet.has(n) && byNet.get(n) !== "0").map(([n, v]) => `.ic V(${byNet.get(n)})=${spiceNum(v)}`),
    ...(opts.temp !== undefined ? [`.temp ${spiceNum(opts.temp)}`] : feeds.has("ROOM.TEMP") ? [`.temp ${spiceNum(feeds.get("ROOM.TEMP")!.signal.at(0))}`] : []),
    analysisLine(doc, analysis),
  ].join("\n")
  return { text, nodes, elements, issues, simulated }
}

/** Steps as a PWL source: each change ramps over 20 ns. */
function stepPwl(steps: [number, number][]): string {
  const TR = 20e-9
  const pts: number[] = [0, steps[0]?.[1] ?? 0]
  for (let i = 1; i < steps.length; i++) {
    const t = Math.max(steps[i][0], pts[pts.length - 2] + TR)
    pts.push(t, steps[i - 1][1], t + TR, steps[i][1])
  }
  return `PWL(${pts.map(spiceNum).join(" ")})`
}

/**
 * A programmable board: its supplies, its ground, and - while its firmware runs - each I/O pin
 * as the firmware leaves it: driven through PIN_R, an input (high impedance), or pulled up/down.
 * A pin that changes between output and input during the run is a behavioural current source.
 */
function boardLines(part: Part, sym: SymbolDef, board: NonNullable<ReturnType<typeof boardOf>>, drive: BoardDrive | undefined,
  net: (pin: string) => string | undefined, node: (net: string | undefined) => string, lines: string[], elements: Map<string, string>) {
  const R = part.ref.toUpperCase().replace(/[^A-Z0-9_]/g, "_")
  const vcc = `sbint_${R.toLowerCase()}_vcc`
  let vccUsed = false
  const grounded = new Set<string>()
  const ioNode = new Map<string, string>()
  const wave = (w: Wave, name: string): string => {
    if (typeof w === "number") return spiceNum(w)
    const n = `sbint_${name.toLowerCase()}`
    lines.push(`V${name} ${n} 0 ${stepPwl(w)}`)
    return `V(${n})`
  }
  for (const pin of sym.units.flatMap((u) => u.pins)) {
    const role = pinRole(board, pin.name)
    const n = role ? net(pin.n) : undefined
    if (!role || n === undefined) continue
    const nd = node(n)
    const k = `${R}_${pin.n.replace(/[^A-Za-z0-9]/g, "_")}`
    if (role.k === "gnd") {
      if (nd !== "0" && !grounded.has(nd)) { grounded.add(nd); lines.push(`V${k}_GND ${nd} 0 0`) }
      continue
    }
    if (role.k === "supply") {
      const x = `sbint_${k.toLowerCase()}_sup`
      lines.push(`V${k}_SUP ${x} 0 DC ${spiceNum(role.volts)}`, `R${k}_SUP ${x} ${nd} ${SUPPLY_R}`)
      elements.set(`V${k}_SUP`, `${part.ref}.${pin.name}`)
      continue
    }
    // the same chip pin on two symbol pins (the Uno's SDA/A4 header): one pin, joined
    const first = ioNode.get(role.pin)
    if (first !== undefined) { if (first !== nd) lines.push(`V${k}_JOIN ${nd} ${first} 0`); continue }
    ioNode.set(role.pin, nd)
    const d = drive?.get(role.pin)
    if (!d) continue
    // a CMOS input left open floats somewhere mid-rail: 10 MΩ to Vcc/2 keeps an open pin between
    // the logic thresholds (undefined) instead of at 0 V, and loads a real circuit by < 0.2 µA
    vccUsed = true
    lines.push(`R${k}_FLOAT ${nd} ${vcc}_mid 10Meg`)
    if (typeof d.en === "number" && typeof d.pu === "number" && typeof d.pd === "number") {
      if (d.en) {
        const x = `sbint_${k.toLowerCase()}_o`
        lines.push(`V${k}_OUT ${x} 0 ${typeof d.v === "number" ? `DC ${spiceNum(d.v)}` : stepPwl(d.v)}`, `R${k}_OUT ${x} ${nd} ${PIN_R}`)
        elements.set(`V${k}_OUT`, `${part.ref}.${role.pin}`)
      } else {
        if (d.pu) { vccUsed = true; lines.push(`R${k}_PU ${nd} ${vcc} ${spiceNum(PULLUP_R)}`) }
        if (d.pd) lines.push(`R${k}_PD ${nd} 0 ${spiceNum(PULLDOWN_R)}`)
      }
      continue
    }
    const en = wave(d.en, `${k}_EN`), v = wave(d.v, `${k}_V`), pu = wave(d.pu, `${k}_PU`), pd = wave(d.pd, `${k}_PD`)
    lines.push(`B${k} ${nd} 0 I=${en}*(V(${nd})-${v})/${PIN_R}+${pu}*(V(${nd})-${spiceNum(board.vcc)})/${spiceNum(PULLUP_R)}+${pd}*V(${nd})/${spiceNum(PULLDOWN_R)}`)
  }
  if (vccUsed) lines.push(`V${R}_VCC ${vcc} 0 DC ${spiceNum(board.vcc)}`, `V${R}_MID ${vcc}_mid 0 DC ${spiceNum(board.vcc / 2)}`)
}

const formatParamsSpice = (p: Record<string, string>) =>
  Object.entries(p).filter(([k]) => !/^(ac|closed)$/.test(k)).map(([k, v]) => `${k}=${spiceNum(parseValue(v) ?? 0)}`).join(" ")

/** Source value: DC / SIN / PULSE / EXP / PWL / noise, plus AC magnitude. */
export function sourceSpec(sim: ResolvedSim, part: Part): string {
  const p = sim.params
  const n = (k: string, d = 0) => spiceNum(parseValue(p[k]) ?? d)
  const ac = p.ac !== undefined ? ` AC ${n("ac")}` : ""
  switch ((sim.type ?? "DC").toUpperCase()) {
    case "SIN": return `DC ${n("dc")} SIN(${n("dc")} ${n("ampl", 1)} ${n("f", 1e3)} ${n("td")} ${n("theta")} ${n("phase")})${ac}`
    case "PULSE": return `DC ${n("y1")} PULSE(${n("y1")} ${n("y2", 1)} ${n("td")} ${n("tr", 1e-9)} ${n("tf", 1e-9)} ${n("tw", 1e-3)} ${n("per", 2e-3)})${ac}`
    case "EXP": return `DC ${n("y1")} EXP(${n("y1")} ${n("y2", 1)} ${n("td1")} ${n("tau1", 1e-6)} ${n("td2", 1e-3)} ${n("tau2", 1e-6)})${ac}`
    case "PWL": return `PWL(${(p.pwl ?? "0 0").trim()})${ac}`
    case "WHITENOISE": return `DC 0 TRNOISE(${n("rms")} ${n("dt", 1e-9)} 0 0)${ac}`
    default: {
      const dc = parseValue(p.dc) ?? parseValue(part.value) ?? 0
      return `DC ${spiceNum(dc)}${ac}`
    }
  }
}
