// Input parts: sensors that read the room and controls you move while it simulates
// (potentiometers / sliders / knobs, switches, push buttons).
import { formatParams, parseParams } from "@/lib/spice"
import { ldrResistance, micAmplitude, ntcResistance, photoCurrent, ptcResistance, tempSensorVolts, type Environment } from "@/lib/environment"
import { QUANTITIES, SENSOR_MODELS, sensorModelFor, type Quantity } from "@/lib/sensors"
import { formatSI, parseSI } from "@/lib/units"
import type { Doc, Part } from "./model"

/** the first sensors have their own kinds; catalogue sensors (lib/sensors.ts) are "sensor:<id>" */
export type SensorKind = "ldr" | "photodiode" | "phototransistor" | "ntc" | "ptc" | "mic" | "tempsensor" | `sensor:${string}`
export type InputKind = SensorKind | "pot" | "switch" | "button"

export function inputKind(p: Pick<Part, "lib"> & { value?: string }): InputKind | null {
  const [lib, name = ""] = p.lib.split(":")
  if ((lib === "Device" && /^R_Photo/.test(name)) || (lib === "Sensor_Optical" && /^LDR/.test(name))) return "ldr"
  if (lib === "Device" && /^D_Photo/.test(name)) return "photodiode"
  if (lib === "Device" && /^Q_Photo_NPN/.test(name)) return "phototransistor"
  if (lib === "Device" && /^Thermistor/.test(name)) return /PTC/.test(name) ? "ptc" : "ntc"
  if (lib === "Device" && /^Microphone/.test(name)) return "mic"
  if (lib === "Sensor_Temperature" && /^(LM35|TMP3[67])/.test(name)) return "tempsensor"
  if (lib === "Device" && /^R_Potentiometer($|_US|_Small|_Trim)/.test(name)) return "pot"
  if (lib === "Switch" && /^SW_SPST($|_LED|_Lamp)/.test(name)) return "switch"
  if (lib === "Switch" && /^SW_Push($|_45deg|_LED|_Lamp|_Open$)/.test(name)) return "button"
  const m = sensorModelFor(lib, name, p.value)
  return m?.senses ? `sensor:${m.id}` : null
}

const FIRST: Record<string, Quantity> = { ldr: "light", photodiode: "light", phototransistor: "light", ntc: "temp", ptc: "temp", mic: "sound", tempsensor: "temp" }

/** What a sensor senses (the room property it reads). */
export function senseOf(k: SensorKind): Quantity {
  if (k in FIRST) return FIRST[k]
  return SENSOR_MODELS.find((m) => `sensor:${m.id}` === k)?.senses ?? "light"
}
/** Kept for the first sensors' callers: SENSES[kind] */
export const SENSES = new Proxy({} as Record<SensorKind, Quantity>, { get: (_, k: string) => senseOf(k as SensorKind) })

export const isSensor = (k: InputKind | null): k is SensorKind => !!k && (k in FIRST || k.startsWith("sensor:"))
export const sensorLabel = (k: SensorKind) => SENSOR_MODELS.find((m) => `sensor:${m.id}` === k)?.label ?? k

const params = (p: Part) => parseParams(p.sim?.Params)
const withParam = (p: Part, key: string, value: string): Part => ({ ...p, sim: { ...p.sim, Params: formatParams({ ...params(p), [key]: value }) } })
const num = (s: string | undefined, d: number) => (s === undefined ? d : parseSI(s) ?? d)

/** Wiper position 0…1. */
export const potPos = (p: Part) => Math.min(1, Math.max(0, num(params(p).pos, 0.5)))
export const setPotPos = (p: Part, pos: number) => withParam(p, "pos", String(Math.round(Math.min(1, Math.max(0, pos)) * 1000) / 1000))
/** "slider" / "knob" / "pot": how the control is drawn. */
export const potStyle = (p: Part) => (params(p).control === "slider" ? "slider" : params(p).control === "knob" ? "knob" : "pot")

export const isClosed = (p: Part) => /^(1|true|yes|on|closed)$/i.test(params(p).closed ?? "0")
export const setClosed = (p: Part, closed: boolean) => withParam(p, "closed", closed ? "1" : "0")

export function inputParts(doc: Doc): { part: Part; kind: InputKind }[] {
  const seen = new Set<string>()
  const out: { part: Part; kind: InputKind }[] = []
  for (const part of doc.parts) {
    const kind = inputKind(part)
    if (!kind || seen.has(part.ref)) continue
    seen.add(part.ref)
    out.push({ part, kind })
  }
  return out
}

/** What a sensor is doing in this room, e.g. "4.7 kΩ at 300 lx". */
export function sensorReading(p: Part, kind: SensorKind, env: Environment): string {
  const pr = params(p)
  if (kind.startsWith("sensor:")) { const q = senseOf(kind); return QUANTITIES[q].show(q in env ? env[q as keyof Environment] : QUANTITIES[q].base) }
  switch (kind) {
    case "ldr": return `${formatSI(ldrResistance(env.light, num(pr.r10, 10e3), num(pr.gamma, 0.7), num(pr.rdark, 1e6)), "Ω", 3)}`
    case "ntc": return formatSI(ntcResistance(env.temp, parseSI(p.value) ?? 10e3, num(pr.beta, 3950)), "Ω", 3)
    case "ptc": return formatSI(ptcResistance(env.temp, parseSI(p.value) ?? 100, num(pr.tc, 0.05)), "Ω", 3)
    case "photodiode": return `${formatSI(photoCurrent(env.light, num(pr.resp, 50e-9)), "A", 3)} light current`
    case "phototransistor": return `${formatSI(photoCurrent(env.light, num(pr.resp, 10e-9)), "A", 3)} into the base`
    case "mic": return `${formatSI(micAmplitude(env.sound, num(pr.sens, -42)), "V", 3)} peak at ${formatSI(env.tone, "Hz", 3)}`
    case "tempsensor": return `${formatSI(tempSensorVolts(env.temp, /TMP/.test(p.lib) ? "TMP36" : "LM35"), "V", 3)} out`
  }
  return ""
}
