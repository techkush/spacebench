// Kirk part constructors ⇄ KiCad library symbols (spec §5.3, §5.5, §13).
//   R(10k) ⇄ Device:R · C(10 uF, polarized) ⇄ Device:C_Polarized · NPN("2N3904") ⇄ Transistor_BJT:2N3904
//   Vsin(amp: 1 V, freq: 1 kHz) ⇄ Simulation_SPICE:VSIN · NE555 ⇄ Timer:NE555P · lib("Lib:Name") for anything else
import { SENSOR_MODELS, sensorModelFor } from "@/lib/sensors"
import type { Part, SimFields } from "@/editor/model"
import { getSymbol, type IndexRow } from "@/lib/kicad"
import { parseParams, parseValue } from "@/lib/spice"
import type { Arg, Diagnostic, Expr } from "./ast"

export interface PartSpec { lib: string; value: string; sim?: SimFields; fields?: Record<string, string>; footprint?: string }

/** Dimension expected by each constructor's primary value. */
const PRIMARY_UNIT: Record<string, string> = { R: "Ω", Pot: "Ω", C: "F", L: "H", Vdc: "V", Idc: "A", Battery: "V" }
const UNIT_ALIASES: Record<string, string> = { ohm: "Ω", lux: "lx" }
const KIND_NAME: Record<string, string> = { "Ω": "Resistance (Ω)", F: "Capacitance (F)", H: "Inductance (H)", V: "Voltage (V)", A: "Current (A)", Hz: "Frequency (Hz)", s: "Time (s)", W: "Power (W)" }

/** Compact SI text without unit for a value: 1600 → "1.6k", 1e-7 → "100n". */
export function siText(v: number): string {
  if (v === 0) return "0"
  const a = Math.abs(v)
  const P: [number, string][] = [[1e12, "T"], [1e9, "G"], [1e6, "M"], [1e3, "k"], [1, ""], [1e-3, "m"], [1e-6, "u"], [1e-9, "n"], [1e-12, "p"], [1e-15, "f"]]
  for (const [s, p] of P) if (a >= s * 0.9999) return `${Number((v / s).toPrecision(6))}${p}`
  return v.toExponential(3)
}

/** Kirk text for a value with unit: (1600, "Ω") → "1.6k", (5, "V") → "5 V", (1e-3, "s") → "1 ms". */
export function qty(v: number, unit = ""): string {
  if (!unit || unit === "Ω") return siText(v)
  const t = siText(v)
  const m = /^(-?[\d.e+-]+)([TGMkmunpf]?)$/.exec(t)
  return m ? `${m[1]} ${m[2]}${unit}` : `${t} ${unit}`
}

export interface Ctx {
  diag: (d: Omit<Diagnostic, "severity"> & { severity?: Diagnostic["severity"] }) => void
  index: IndexRow[] | null
}

function argMap(args: Arg[]) {
  const named = new Map<string, Expr>()
  const pos: Expr[] = []
  for (const a of args) (a.name ? named.set(a.name, a.value) : pos.push(a.value))
  return { named, pos }
}

/** A numeric value of an expression with its unit (number literals and simple arithmetic). */
export function evalNum(e: Expr): { value: number; unit?: string } | null {
  switch (e.k) {
    case "num": return { value: e.value, unit: e.unit ? UNIT_ALIASES[e.unit] ?? e.unit : undefined }
    case "neg": { const a = evalNum(e.a); return a ? { value: -a.value, unit: a.unit } : null }
    case "bin": {
      const a = evalNum(e.a), b = evalNum(e.b)
      if (!a || !b) return null
      if (e.op === "+") return { value: a.value + b.value, unit: a.unit ?? b.unit }
      if (e.op === "-") return { value: a.value - b.value, unit: a.unit ?? b.unit }
      if (e.op === "*") return { value: a.value * b.value, unit: a.unit ?? b.unit }
      if (e.op === "/") return { value: a.value / b.value, unit: a.unit }
      if (e.op === "^") return { value: a.value ** b.value }
      return null
    }
    case "id": return e.name === "pi" ? { value: Math.PI } : null
    default: return null
  }
}

function num(ctx: Ctx, e: Expr | undefined, want: string | undefined, what: string): number | null {
  if (!e) return null
  const q = evalNum(e)
  if (!q) { ctx.diag({ code: "V103", message: `${what} must be a number`, span: e.span }); return null }
  if (want && q.unit && q.unit !== want && !(want === "V" && q.unit === "Vpp")) {
    const guess = q.unit === "Ω" && want === "F" ? " Did you mean nF?" : ""
    ctx.diag({ code: "V102", message: `unit mismatch: ${what} expects ${KIND_NAME[want] ?? want}, found ${KIND_NAME[q.unit] ?? q.unit}`, span: e.span, help: guess || undefined })
  }
  return q.value
}

const str = (e: Expr | undefined) => (e?.k === "str" ? e.value : e?.k === "id" ? e.name : undefined)
const flag = (e: Expr | undefined) => e?.k === "id" && /^(true|yes|on)$/.test(e.name)
const libExists = (id: string, index: IndexRow[] | null) => !!getSymbol(id) || !!index?.some((r) => `${r.lib}:${r.name}` === id)

/** Library ids a call may need (so symbols can be loaded before resolving pins). */
export function candidateLibs(call: Expr): string[] {
  if (call.k === "id") return KNOWN_IDS[call.name] ? [KNOWN_IDS[call.name]] : []
  if (call.k !== "call") return []
  const { named, pos } = argMap(call.args)
  const model = str(pos[0]) ?? str(named.get("model"))
  switch (call.fn) {
    case "lib": { const id = (str(pos[0]) ?? "").replace("/", ":"); return id ? [id] : [] }
    case "NPN": case "PNP": return [`Transistor_BJT:${model ?? ""}`, call.fn === "NPN" ? "Device:Q_NPN" : "Device:Q_PNP"]
    case "NMOS": case "PMOS": return [`Transistor_FET:${model ?? ""}`, call.fn === "NMOS" ? "Device:Q_NMOS" : "Device:Q_PMOS"]
    case "D": case "Schottky": case "Zener": return [`Diode:${model ?? ""}`, "Device:D", "Device:D_Schottky", "Device:D_Zener"]
    default: {
      const sm = SENSOR_MODELS.find((m) => m.kirk === call.fn)
      if (sm) return [sm.symbol, ...(model ? [`${sm.symbol.split(":")[0]}:${model}`] : [])]
      return CONSTRUCTOR_LIB[call.fn] ? [CONSTRUCTOR_LIB[call.fn]] : []
    }
  }
}

const CONSTRUCTOR_LIB: Record<string, string> = {
  R: "Device:R", C: "Device:C", L: "Device:L", Pot: "Device:R_Potentiometer", LED: "Device:LED", Battery: "Device:Battery", Cell: "Device:Battery_Cell",
  Vdc: "Simulation_SPICE:VDC", Vsin: "Simulation_SPICE:VSIN", Vpulse: "Simulation_SPICE:VPULSE", Vpwl: "Simulation_SPICE:VPWL",
  Idc: "Simulation_SPICE:IDC", Isin: "Simulation_SPICE:ISIN", Ipulse: "Simulation_SPICE:IPULSE", OpAmp: "Simulation_SPICE:OPAMP",
  NJFET: "Device:Q_NJFET_DSG", PJFET: "Device:Q_PJFET_DSG", Switch: "Switch:SW_SPST", PushButton: "Switch:SW_Push", Lamp: "Device:Lamp",
  Speaker: "Device:Speaker", Buzzer: "Device:Buzzer", Motor: "Motor:Motor_DC", Fuse: "Device:Fuse",
}
/** Bare names that are parts: U1 = NE555 */
const KNOWN_IDS: Record<string, string> = { NE555: "Timer:NE555P", LM358: "Amplifier_Operational:LM358", TL072: "Amplifier_Operational:TL072", L7805: "Regulator_Linear:L7805" }

/** Resolve a part constructor to a KiCad symbol and fields. */
export function resolveConstructor(ctx: Ctx, call: Expr & { k: "call" | "id" }): PartSpec | null {
  if (call.k === "id") {
    const id = KNOWN_IDS[call.name] ?? findByName(ctx.index, call.name)
    if (!id) { ctx.diag({ code: "V201", message: `unknown part “${call.name}”`, span: call.span, help: "use R(…), C(…), NPN(\"2N3904\"), lib(\"Library:Symbol\") …" }); return null }
    return { lib: id, value: getSymbol(id)?.value ?? call.name }
  }
  const { named, pos } = argMap(call.args)
  const get = (name: string, i?: number) => named.get(name) ?? (i !== undefined ? pos[i] : undefined)
  const fields: Record<string, string> = {}
  const tol = named.get("tol"), power = named.get("power"), voltage = named.get("voltage")
  if (tol) { const v = evalNum(tol); if (v) fields.Tolerance = String(v.unit === "%" ? v.value : v.value * 100) }
  if (power) { const v = num(ctx, power, "W", "power"); if (v !== null) fields.Power = siText(v) }
  if (voltage) { const v = num(ctx, voltage, "V", "voltage"); if (v !== null) fields.Voltage = siText(v) }
  const withFields = (p: PartSpec): PartSpec => (Object.keys(fields).length ? { ...p, fields } : p)
  const fn = call.fn
  const params = (o: Record<string, number | string | undefined>) => {
    const out: string[] = []
    for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null) out.push(`${k}=${typeof v === "number" ? siText(v) : v}`)
    return out.join(" ")
  }

  switch (fn) {
    // ---- inputs: sensors read the room (environment { }), controls are moved live
    case "LDR": {
      const r10 = num(ctx, get("r10", 0), "Ω", "r10"), gamma = num(ctx, named.get("gamma"), undefined, "gamma")
      return { lib: "Device:R_Photo", value: "LDR", sim: r10 !== null || gamma !== null ? { Params: params({ r10: r10 ?? undefined, gamma: gamma ?? undefined }) } : undefined }
    }
    case "Photodiode": return { lib: "Device:D_Photo", value: "Photodiode" }
    case "Phototransistor": return { lib: "Device:Q_Photo_NPN", value: "Phototransistor" }
    case "Thermistor": case "PTC": {
      const r = num(ctx, get("value", 0), "Ω", `${fn}()`) ?? (fn === "PTC" ? 100 : 10e3)
      const beta = num(ctx, named.get("beta"), undefined, "beta")
      return { lib: fn === "PTC" ? "Device:Thermistor_PTC" : "Device:Thermistor_NTC", value: siText(r), sim: beta !== null ? { Params: `beta=${beta}` } : undefined }
    }
    case "Mic": return { lib: "Device:Microphone", value: "Mic" }
    case "TempSensor": {
      const model = (str(get("model", 0)) ?? "LM35").toUpperCase()
      return model.startsWith("TMP") ? { lib: "Sensor_Temperature:TMP36xS", value: "TMP36" } : { lib: "Sensor_Temperature:LM35-LP", value: "LM35" }
    }
    case "Slider": case "Knob": {
      const v = num(ctx, get("value", 0), "Ω", `${fn}()`) ?? 10e3
      const pos2 = num(ctx, named.get("pos"), undefined, "pos")
      return { lib: "Device:R_Potentiometer", value: siText(v), sim: { Params: `pos=${pos2 ?? 0.5} control=${fn.toLowerCase()}` } }
    }
    case "Button": return { lib: CONSTRUCTOR_LIB.PushButton, value: "SW_Push", sim: flag(named.get("closed")) ? { Params: "closed=1" } : undefined }
    case "R": case "C": case "L": case "Pot": {
      const v = num(ctx, get("value", 0), PRIMARY_UNIT[fn], `${fn}()`)
      if (v === null) { ctx.diag({ code: "V104", message: `${fn}() needs a value, e.g. ${fn}(${fn === "C" ? "100n" : fn === "L" ? "1m" : "10k"})`, span: call.span }); return null }
      if (fn === "C" && pos.slice(1).concat([...named.values()]).some((e) => e.k === "id" && e.name === "polarized")) return withFields({ lib: "Device:C_Polarized", value: siText(v) })
      if (fn === "Pot") { const pos2 = num(ctx, named.get("pos"), undefined, "pos"); return { lib: "Device:R_Potentiometer", value: siText(v), sim: pos2 !== null ? { Params: `pos=${pos2}` } : undefined } }
      return withFields({ lib: CONSTRUCTOR_LIB[fn], value: siText(v) })
    }
    case "D": case "Schottky": case "Zener": {
      const model = str(get("model", 0))
      if (model && libExists(`Diode:${model}`, ctx.index)) return { lib: `Diode:${model}`, value: model }
      return { lib: fn === "D" ? "Device:D" : fn === "Schottky" ? "Device:D_Schottky" : "Device:D_Zener", value: model ?? (fn === "Zener" ? "5V1" : "D") }
    }
    case "LED": return { lib: "Device:LED", value: str(get("color", 0)) ?? "Red" }
    case "NPN": case "PNP": case "NMOS": case "PMOS": case "NJFET": case "PJFET": {
      const model = str(get("model", 0))
      const family = fn.endsWith("JFET") ? null : fn.length === 3 ? "Transistor_BJT" : "Transistor_FET"
      if (model && family && libExists(`${family}:${model}`, ctx.index)) return { lib: `${family}:${model}`, value: model }
      const generic = fn === "NPN" ? "Device:Q_NPN" : fn === "PNP" ? "Device:Q_PNP" : fn === "NMOS" ? "Device:Q_NMOS" : fn === "PMOS" ? "Device:Q_PMOS" : CONSTRUCTOR_LIB[fn]
      return { lib: generic, value: model ?? fn }
    }
    case "Vdc": case "Idc": case "Battery": case "Cell": {
      const v = num(ctx, get("value", 0), fn === "Idc" ? "A" : "V", `${fn}()`) ?? 0
      return { lib: CONSTRUCTOR_LIB[fn], value: siText(v) }
    }
    case "Vsin": case "Isin": {
      const u = fn === "Vsin" ? "V" : "A"
      return {
        lib: CONSTRUCTOR_LIB[fn], value: fn.toUpperCase(),
        sim: { Params: params({ dc: num(ctx, get("offset"), u, "offset") ?? 0, ampl: num(ctx, get("amp", 0), u, "amp") ?? 1, f: num(ctx, get("freq", 1), "Hz", "freq") ?? 1e3,
          td: num(ctx, get("delay"), "s", "delay") ?? undefined, phase: num(ctx, get("phase"), undefined, "phase") ?? undefined, ac: num(ctx, get("ac"), u, "ac") ?? undefined }) },
      }
    }
    case "Vpulse": case "Ipulse": {
      const u = fn === "Vpulse" ? "V" : "A"
      const per = num(ctx, get("period"), "s", "period") ?? 1e-3
      return {
        lib: CONSTRUCTOR_LIB[fn], value: fn.toUpperCase(),
        sim: { Params: params({ y1: num(ctx, get("low", 0), u, "low") ?? 0, y2: num(ctx, get("high", 1), u, "high") ?? 1, td: num(ctx, get("delay"), "s", "delay") ?? 0,
          tr: num(ctx, get("rise"), "s", "rise") ?? 1e-9, tf: num(ctx, get("fall"), "s", "fall") ?? (num(ctx, get("rise"), "s", "rise") ?? 1e-9),
          tw: num(ctx, get("width"), "s", "width") ?? per / 2, per, ac: num(ctx, get("ac"), u, "ac") ?? undefined }) },
      }
    }
    case "Vpwl": {
      const s = str(get("points", 0))
      return { lib: CONSTRUCTOR_LIB[fn], value: "VPWL", sim: { Params: `pwl="${s ?? "0 0"}"` } }
    }
    case "OpAmp": {
      const gbw = num(ctx, named.get("gbw"), "Hz", "gbw"), gain = num(ctx, named.get("gain"), undefined, "gain")
      return { lib: CONSTRUCTOR_LIB[fn], value: "OPAMP", sim: gbw || gain ? { Params: params({ gain: gain ?? 1e5, pole: (gbw ?? 1e6) / (gain ?? 1e5) }) } : undefined }
    }
    case "Switch": case "PushButton": return { lib: CONSTRUCTOR_LIB[fn], value: fn === "Switch" ? "SW_SPST" : "SW_Push", sim: flag(named.get("closed")) ? { Params: "closed=1" } : undefined }
    case "Lamp": case "Speaker": case "Buzzer": case "Motor": case "Fuse": return { lib: CONSTRUCTOR_LIB[fn], value: fn }
    case "lib": {
      const raw = str(pos[0])
      if (!raw) { ctx.diag({ code: "V105", message: "lib() needs a quoted symbol id, e.g. lib(\"Timer:NE555P\")", span: call.span }); return null }
      const id = raw.includes(":") ? raw : raw.replace("/", ":")
      if (!libExists(id, ctx.index)) { ctx.diag({ code: "V202", message: `no KiCad symbol “${id}”`, span: pos[0].span, help: "open the part browser (A) to find the exact Library:Symbol name" }); return null }
      const value = str(named.get("value")) ?? getSymbol(id)?.value ?? id.split(":")[1]
      const sp = str(named.get("params"))
      const footprint = str(named.get("footprint"))
      return withFields({ lib: id, value, ...(sp ? { sim: { Params: sp } } : {}), ...(footprint ? { footprint } : {}) })
    }
    default: {
      // catalogue sensors: FSR() GasSensor() HumiditySensor() PressureSensor("40PC100G") HallSensor("A1302") …
      const sm = SENSOR_MODELS.find((m) => m.kirk === fn)
      if (sm) {
        const model = str(get("model", 0))
        let lib = sm.symbol
        if (model) {
          const fam = sm.symbol.split(":")[0]
          // an exact name, else a prefix — preferring the default package (HallSensor("A1301") → A1301xUA, like the default)
          const def = sm.symbol.split(":")[1]
          const rows = ctx.index?.filter((r) => r.lib === fam && r.name.startsWith(model)) ?? []
          const row = rows.find((r) => r.name === model) ?? rows.find((r) => r.name.slice(model.length) === def.slice(def.length - (r.name.length - model.length))) ?? rows[0]
          if (!row) { ctx.diag({ code: "V202", message: `no ${sm.label} “${model}” in ${fam}`, span: call.span, help: `leave it out for the default (${sm.symbol.split(":")[1]})` }); return null }
          lib = `${fam}:${row.name}`
        }
        const generic = lib.startsWith("SpaceBench:") || lib === "Device:R_Variable"
        const extra: Record<string, number> = {}
        for (const [k, e] of named) { if (k === "model") continue; const v = evalNum(e); if (v) extra[k] = v.unit === "%" ? v.value / 100 : v.value }
        return { lib, value: generic ? sm.kirk : getSymbol(lib)?.value ?? lib.split(":")[1], ...(Object.keys(extra).length ? { sim: { Params: params(extra) } } : {}) }
      }
      const id = findByName(ctx.index, fn)
      if (id) return { lib: id, value: getSymbol(id)?.value ?? fn }
      ctx.diag({ code: "V201", message: `unknown part constructor “${fn}”`, span: call.span, help: "built-ins: R C L Pot Slider Knob LDR Photodiode Phototransistor Thermistor PTC Mic TempSensor FSR GasSensor GasModule HumiditySensor PressureSensor HallSensor HallSwitch DistanceSensor Accelerometer PIR TouchSensor LoadCell MoistureProbe LevelSensor CurrentSensor Button D LED Zener Schottky NPN PNP NMOS PMOS NJFET PJFET Vdc Vsin Vpulse Vpwl Idc Isin Ipulse OpAmp NE555 Switch Battery lib(\"Lib:Name\")" })
      return null
    }
  }
}

function findByName(index: IndexRow[] | null, name: string): string | null {
  if (!index) return null
  const hits = index.filter((r) => r.name === name)
  const best = hits.find((r) => r.sim) ?? hits[0]
  return best ? `${best.lib}:${best.name}` : null
}

// ---------------------------------------------------------------- reverse: Doc part → Kirk constructor

const n = (s: string | undefined) => (s === undefined ? undefined : parseValue(s) ?? undefined)

/** Kirk source for a part's declaration right-hand side, e.g. R(1.6k), Vsin(amp: 1 V, freq: 1 kHz). */
export function partToKirk(p: Part): string {
  const pr = parseParams(p.sim?.Params)
  const extras: string[] = []
  if (p.fields?.Tolerance) extras.push(`tol: ${p.fields.Tolerance} %`)
  if (p.fields?.Power) extras.push(`power: ${qty(n(p.fields.Power) ?? 0.25, "W")}`)
  if (p.fields?.Voltage) extras.push(`voltage: ${qty(n(p.fields.Voltage) ?? 50, "V")}`)
  const tail = extras.length ? `, ${extras.join(", ")}` : ""
  const v = n(p.value)
  switch (p.lib) {
    case "Device:R": if (v !== undefined) return `R(${siText(v)}${tail})`; break
    case "Device:C": if (v !== undefined) return `C(${qty(v, "F")}${tail})`; break
    case "Device:C_Polarized": if (v !== undefined) return `C(${qty(v, "F")}, polarized${tail})`; break
    case "Device:L": if (v !== undefined) return `L(${qty(v, "H")})`; break
    case "Device:R_Potentiometer": if (v !== undefined) {
      const ctl = pr.control === "slider" ? "Slider" : pr.control === "knob" ? "Knob" : "Pot"
      return `${ctl}(${siText(v)}${pr.pos ? `, pos: ${pr.pos}` : ""})`
    } break
    case "Device:R_Photo": {
      const a = [pr.r10 ? `r10: ${qty(n(pr.r10) ?? 10e3, "Ω")}` : "", pr.gamma ? `gamma: ${pr.gamma}` : ""].filter(Boolean)
      if (p.value === "LDR") return `LDR(${a.join(", ")})`
      break
    }
    case "Device:D_Photo": if (p.value === "Photodiode" && !p.sim?.Params) return "Photodiode()"; break
    case "Device:Q_Photo_NPN": if (p.value === "Phototransistor" && !p.sim?.Params) return "Phototransistor()"; break
    case "Device:Thermistor_NTC": case "Device:Thermistor_PTC": if (v !== undefined) return `${p.lib.endsWith("PTC") ? "PTC" : "Thermistor"}(${qty(v, "Ω")}${pr.beta ? `, beta: ${pr.beta}` : ""})`; break
    case "Device:Microphone": if (p.value === "Mic" && !p.sim?.Params) return "Mic()"; break
    case "Switch:SW_Push": if (p.value === "SW_Push") return /^(1|true|on|closed)$/i.test(pr.closed ?? "") ? "Button(closed: true)" : "Button()"; break
    case "Switch:SW_SPST": if (p.value === "SW_SPST") return /^(1|true|on|closed)$/i.test(pr.closed ?? "") ? "Switch(closed: true)" : "Switch()"; break
    case "Sensor_Temperature:LM35-LP": if (p.value === "LM35") return `TempSensor("LM35")`; break
    case "Sensor_Temperature:TMP36xS": if (p.value === "TMP36") return `TempSensor("TMP36")`; break
    case "Device:LED": return `LED(color: ${/^[A-Za-z]+$/.test(p.value) ? p.value : `"${p.value}"`})`
    case "Device:D": return p.value && p.value !== "D" ? `D("${p.value}")` : "D()"
    case "Device:Battery": if (v !== undefined) return `Battery(${qty(v, "V")})`; break
    case "Simulation_SPICE:VDC": return `Vdc(${qty(v ?? n(pr.dc) ?? 0, "V")}${pr.ac ? `, ac: ${pr.ac}` : ""})`
    case "Simulation_SPICE:IDC": return `Idc(${qty(v ?? n(pr.dc) ?? 0, "A")})`
    case "Simulation_SPICE:VSIN": case "Simulation_SPICE:ISIN": {
      const u = p.lib.endsWith("VSIN") ? "V" : "A"
      const a = [`amp: ${qty(n(pr.ampl) ?? 1, u)}`, `freq: ${qty(n(pr.f) ?? 1e3, "Hz")}`]
      if (n(pr.dc)) a.push(`offset: ${qty(n(pr.dc)!, u)}`)
      if (n(pr.td)) a.push(`delay: ${qty(n(pr.td)!, "s")}`)
      if (pr.ac) a.push(`ac: ${pr.ac}`)
      return `${u === "V" ? "Vsin" : "Isin"}(${a.join(", ")})`
    }
    case "Simulation_SPICE:VPULSE": case "Simulation_SPICE:IPULSE": {
      const u = p.lib.endsWith("VPULSE") ? "V" : "A"
      const a = [`low: ${qty(n(pr.y1) ?? 0, u)}`, `high: ${qty(n(pr.y2) ?? 1, u)}`, `period: ${qty(n(pr.per) ?? 1e-3, "s")}`, `width: ${qty(n(pr.tw) ?? 5e-4, "s")}`]
      if (n(pr.tr)) a.push(`rise: ${qty(n(pr.tr)!, "s")}`)
      if (n(pr.tf) && pr.tf !== pr.tr) a.push(`fall: ${qty(n(pr.tf)!, "s")}`)
      if (n(pr.td)) a.push(`delay: ${qty(n(pr.td)!, "s")}`)
      if (pr.ac) a.push(`ac: ${pr.ac}`)
      return `${u === "V" ? "Vpulse" : "Ipulse"}(${a.join(", ")})`
    }
    case "Simulation_SPICE:VPWL": return `Vpwl("${pr.pwl ?? "0 0"}")`
    case "Timer:NE555P": if (!p.sim?.Params) return "NE555"; break
  }
  const [plib, pname = ""] = p.lib.split(":")
  // an instance of a Kirk component: Name(param: value, …)
  if (plib === "kirk") return `${pname}(${Object.entries(pr).map(([k, v]) => `${k}: ${/^[-+.\d]/.test(v) ? v : JSON.stringify(v)}`).join(", ")})`
  const sm = sensorModelFor(plib, pname, p.value)
  if (sm) {
    const generic = plib === "SpaceBench" || p.lib === "Device:R_Variable"
    const args = [generic || p.lib === sm.symbol ? "" : `"${pname}"`, ...Object.entries(pr).map(([k, v]) => `${k}: ${v}`)].filter(Boolean)
    return `${sm.kirk}(${args.join(", ")})`
  }
  if (p.lib.startsWith("Transistor_BJT:") || p.lib.startsWith("Transistor_FET:")) {
    const name = p.lib.split(":")[1]
    const sym = getSymbol(p.lib)
    const kind = /PNP/i.test(`${sym?.bases.join(" ")} ${sym?.desc}`) ? "PNP" : /NPN/i.test(`${sym?.bases.join(" ")} ${sym?.desc}`) ? "NPN"
      : /P-?Channel|PMOS/i.test(`${sym?.bases.join(" ")} ${sym?.desc}`) ? "PMOS" : /N-?Channel|NMOS/i.test(`${sym?.bases.join(" ")} ${sym?.desc}`) ? "NMOS" : null
    if (kind && p.value === name && !p.sim?.Params) return `${kind}("${name}")`
  }
  if (p.lib.startsWith("Diode:") && p.value === p.lib.split(":")[1] && !p.sim?.Params) return `D("${p.value}")`
  const sym = getSymbol(p.lib)
  const args = [`"${p.lib}"`]
  if (sym && p.value !== sym.value) args.push(`value: "${p.value}"`)
  if (p.sim?.Params) args.push(`params: "${p.sim.Params.replace(/"/g, "'")}"`)
  if (p.footprint) args.push(`footprint: "${p.footprint}"`)
  return `lib(${args.join(", ")}${tail})`
}
