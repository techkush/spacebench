// Everything a circuit's sensors can sense (the room's properties), and the analog sensors
// that turn them into a resistance or a voltage. Data-driven: each sensor is a response curve
// (sampled to a pwl() table for ngspice) plus how it connects. Digital (I²C / SPI) sensors need
// a microcontroller (the AVR step).
import type { KPin, SymbolDef } from "./kicad"
import { registerBuiltin } from "./kicad"

export type Quantity =
  | "light" | "temp" | "sound" | "tone" | "humidity" | "pressure" | "field" | "distance"
  | "force" | "accel" | "gas" | "motion" | "touch" | "level" | "moisture"

export interface QuantityInfo {
  label: string
  /** Kirk unit of feeds (values are in this unit: °C, lx, cm …; pressure in Pa, field in T) */
  unit?: "lx" | "°C" | "dB" | "Hz" | "%" | "Pa" | "T" | "cm" | "N" | "g" | "ppm"
  /** how the value is shown */
  show: (v: number) => string
  base: number
  /** sensible range (feeds, previews, response tables) */
  range: [number, number]
  icon: string
}

const n3 = (v: number) => String(Number(v.toPrecision(3)))
export const QUANTITIES: Record<Quantity, QuantityInfo> = {
  light: { label: "light", unit: "lx", show: (v) => (v >= 1000 ? `${n3(v / 1000)}k lx` : `${n3(v)} lx`), base: 300, range: [0.1, 100e3], icon: "☀" },
  temp: { label: "temperature", unit: "°C", show: (v) => `${n3(v)} °C`, base: 27, range: [-40, 125], icon: "🌡" },
  sound: { label: "sound level", unit: "dB", show: (v) => `${Math.round(v)} dB`, base: 40, range: [0, 120], icon: "♪" },
  tone: { label: "sound pitch", unit: "Hz", show: (v) => (v >= 1000 ? `${n3(v / 1000)} kHz` : `${n3(v)} Hz`), base: 1000, range: [20, 20e3], icon: "♪" },
  humidity: { label: "relative humidity", unit: "%", show: (v) => `${n3(v)} %RH`, base: 50, range: [0, 100], icon: "💧" },
  pressure: { label: "pressure", unit: "Pa", show: (v) => `${n3(v / 1000)} kPa`, base: 0, range: [0, 200e3], icon: "⊚" },
  field: { label: "magnetic field", unit: "T", show: (v) => `${n3(v * 1000)} mT`, base: 0, range: [-0.1, 0.1], icon: "🧲" },
  distance: { label: "distance", unit: "cm", show: (v) => `${n3(v)} cm`, base: 30, range: [2, 150], icon: "↔" },
  force: { label: "force", unit: "N", show: (v) => `${n3(v)} N`, base: 0, range: [0, 100], icon: "⬇" },
  accel: { label: "acceleration", unit: "g", show: (v) => `${n3(v)} g`, base: 0, range: [-3, 3], icon: "↗" },
  gas: { label: "gas concentration", unit: "ppm", show: (v) => `${n3(v)} ppm`, base: 0, range: [0, 10000], icon: "☁" },
  motion: { label: "motion (0 none · 1 moving)", show: (v) => (v > 0.5 ? "motion" : "still"), base: 0, range: [0, 1], icon: "🏃" },
  touch: { label: "touch (0 · 1 touched)", show: (v) => (v > 0.5 ? "touched" : "not touched"), base: 0, range: [0, 1], icon: "☝" },
  level: { label: "liquid level", unit: "%", show: (v) => `${n3(v)} % full`, base: 50, range: [0, 100], icon: "≋" },
  moisture: { label: "soil moisture", unit: "%", show: (v) => `${n3(v)} %`, base: 40, range: [0, 100], icon: "🌱" },
}
export const QUANTITY_LIST = Object.keys(QUANTITIES) as Quantity[]

/** Kirk text for a value in the quantity's unit (°C must stick to the number). */
export function qtyText(q: Quantity, v: number): string {
  const u = QUANTITIES[q].unit
  if (!u) return n3(v)
  if (u === "°C") return `${n3(v)}°C`
  if (u === "Pa") return Math.abs(v) >= 1000 ? `${n3(v / 1000)} kPa` : `${n3(v)} Pa`
  if (u === "T") return `${n3(v * 1000)} mT`
  if (u === "lx") return v >= 1000 ? `${n3(v / 1000)}k lux` : `${n3(v)} lux`
  return `${n3(v)} ${u}`
}

/** Ready-made feeds for a quantity (the Lab's + menu), sized to the run. */
export function quantityTemplates(q: Quantity, dur: number, d: (s: number) => string): { label: string; expr: string }[] {
  const [lo, hi] = QUANTITIES[q].range, t = (v: number) => qtyText(q, v)
  const span = d(dur), half = d(dur / 2), step = d(dur / 20)
  const mid = (lo + hi) / 2
  switch (q) {
    case "light": return [{ label: "Room light", expr: t(300) }, { label: "Dusk (bright → dark)", expr: `ramp(from: 10k lux, to: 0.1 lux, over: ${span})` }, { label: "Lights off", expr: `step(from: 500 lux, to: 1 lux, at: ${half})` }, { label: "Flicker (100 Hz)", expr: "sine(mean: 300 lux, amp: 100 lux, freq: 100 Hz)" }, { label: "Clouds (random)", expr: `random(min: 2k lux, max: 20k lux, every: ${step}, smooth: true)` }]
    case "temp": return [{ label: "Room", expr: "25°C" }, { label: "Drift (random walk)", expr: `walk(start: 25°C, sd: 0.5°C, every: ${d(dur / 50)}, min: -20°C, max: 80°C)` }, { label: "Random", expr: `random(min: 20°C, max: 30°C, every: ${step})` }, { label: "Heat up", expr: `ramp(from: 20°C, to: 60°C, over: ${span})` }, { label: "Sensor noise", expr: "25°C + noise(sd: 0.3°C)" }, { label: "Hot / cold cycles", expr: `square(low: 15°C, high: 40°C, period: ${half})` }]
    case "sound": return [{ label: "Quiet room", expr: "30 dB" }, { label: "Getting louder", expr: `ramp(from: 30 dB, to: 90 dB, over: ${span})` }, { label: "Clap", expr: `step(from: 30 dB, to: 95 dB, at: ${half})` }, { label: "Random noise level", expr: `random(min: 40 dB, max: 80 dB, every: ${step})` }]
    case "tone": return [{ label: "1 kHz", expr: "1 kHz" }, { label: "440 Hz (A)", expr: "440 Hz" }]
    case "humidity": return [{ label: "Comfortable", expr: "45 %" }, { label: "Shower (rising)", expr: `ramp(from: 40 %, to: 95 %, over: ${span})` }, { label: "Dry → wet step", expr: `step(from: 20 %, to: 80 %, at: ${half})` }, { label: "Drift", expr: `walk(start: 50 %, sd: 2 %, every: ${d(dur / 50)}, min: 0 %, max: 100 %)` }]
    case "pressure": return [{ label: "None (gauge 0)", expr: "0 kPa" }, { label: "Pump up", expr: `ramp(from: 0 kPa, to: 100 kPa, over: ${span})` }, { label: "Leak (falling)", expr: `ramp(from: 90 kPa, to: 20 kPa, over: ${span})` }, { label: "Pulses", expr: `square(low: 10 kPa, high: 80 kPa, period: ${half})` }]
    case "field": return [{ label: "No magnet", expr: "0 mT" }, { label: "Magnet approaches", expr: `ramp(from: 0 mT, to: 60 mT, over: ${span})` }, { label: "Spinning magnet", expr: `sine(mean: 0 mT, amp: 40 mT, freq: ${Math.round(4 / dur)} Hz)` }, { label: "Door opens", expr: `step(from: 30 mT, to: 0 mT, at: ${half})` }]
    case "distance": return [{ label: "30 cm", expr: "30 cm" }, { label: "Approaching", expr: `ramp(from: 80 cm, to: 10 cm, over: ${span})` }, { label: "Walk past", expr: `pwl("0 80 ${dur * 0.4} 80 ${dur * 0.5} 15 ${dur * 0.6} 80")` }, { label: "Random", expr: `random(min: 10 cm, max: 80 cm, every: ${step})` }]
    case "force": return [{ label: "No load", expr: "0 N" }, { label: "Press harder", expr: `ramp(from: 0 N, to: 20 N, over: ${span})` }, { label: "Taps", expr: `square(low: 0 N, high: 10 N, period: ${d(dur / 4)}, duty: 30%)` }, { label: "Weight placed", expr: `step(from: 0 N, to: 9.81 N, at: ${half})` }]
    case "accel": return [{ label: "Still (0 g)", expr: "0 g" }, { label: "Tilt (gravity)", expr: `ramp(from: -1 g, to: 1 g, over: ${span})` }, { label: "Vibration", expr: `sine(mean: 0 g, amp: 0.5 g, freq: ${Math.round(10 / dur)} Hz)` }, { label: "Bump", expr: `pwl("0 0 ${dur * 0.5} 0 ${dur * 0.52} 2.5 ${dur * 0.56} -1 ${dur * 0.6} 0")` }]
    case "gas": return [{ label: "Clean air", expr: "0 ppm" }, { label: "Leak (rising)", expr: `ramp(from: 0 ppm, to: 5000 ppm, over: ${span})` }, { label: "Puff", expr: `step(from: 0 ppm, to: 3000 ppm, at: ${half})` }, { label: "Random", expr: `random(min: 0 ppm, max: 2000 ppm, every: ${step})` }]
    case "motion": case "touch": return [{ label: q === "motion" ? "Nobody" : "Not touched", expr: "0" }, { label: q === "motion" ? "Someone walks in" : "Touched halfway", expr: `step(from: 0, to: 1, at: ${half})` }, { label: "On / off", expr: `square(low: 0, high: 1, period: ${d(dur / 3)})` }, { label: "Random", expr: `random(min: 0, max: 1, every: ${d(dur / 10)})` }]
    case "level": return [{ label: "Half full", expr: "50 %" }, { label: "Filling", expr: `ramp(from: 0 %, to: 100 %, over: ${span})` }, { label: "Draining", expr: `ramp(from: 100 %, to: 5 %, over: ${span})` }]
    case "moisture": return [{ label: "Moist", expr: "40 %" }, { label: "Drying out", expr: `ramp(from: 80 %, to: 5 %, over: ${span})` }, { label: "Watered", expr: `step(from: 10 %, to: 70 %, at: ${half})` }]
  }
  return [{ label: "Constant", expr: t(mid) }]
}

// ---------------------------------------------------------------- analog sensors

/** How a sensor connects: a two-pin resistance, a 3-pin module (VCC / OUT / GND), an open-drain
 *  switch (OUT pulled low), a 4-wire bridge, or a current sensor (measures its own pins' current). */
export type SensorShape = "resistive" | "module" | "opendrain" | "bridge" | "current"

export interface SensorModel {
  id: string
  label: string
  /** what it senses (current sensors sense the circuit itself) */
  senses: Quantity | null
  shape: SensorShape
  /** KiCad / built-in symbols it applies to */
  match: (lib: string, name: string) => boolean
  /** resistive: ohms; module: output ÷ supply (ratiometric) or volts (absolute); opendrain: 1 = on */
  curve: (q: number, params: Record<string, number>) => number
  ratiometric?: boolean
  /** curve sampled over this range (default: the quantity's range); log spacing for wide ranges */
  logX?: boolean
  /** Kirk constructor and its symbol */
  kirk: string
  symbol: string
  /** pin names per role, for symbols whose pins are named */
  pins?: Record<string, string[]>
  note: string
  defaults?: Record<string, number>
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

export const SENSOR_MODELS: SensorModel[] = [
  { id: "fsr", label: "Force sensor (FSR)", senses: "force", shape: "resistive", kirk: "FSR", symbol: "Device:R_Variable", match: () => false,
    curve: (f) => (f < 0.05 ? 1e7 : clamp(30e3 / Math.pow(f, 0.9), 500, 1e7)), logX: false, note: "≈ 30 kΩ at 1 N, 3.7 kΩ at 10 N, open with no load" },
  { id: "gas", label: "Gas sensor (MQ-type element)", senses: "gas", shape: "resistive", kirk: "GasSensor", symbol: "Device:R_Variable", match: () => false,
    curve: (ppm, p) => clamp((p.r0 ?? 10e3) * Math.pow(Math.max(ppm, 50) / 1000, -0.47), 500, 2e5), note: "Rs = R0·(ppm/1000)^−0.47, R0 = 10 kΩ" },
  { id: "moisture", label: "Soil moisture probe", senses: "moisture", shape: "resistive", kirk: "MoistureProbe", symbol: "Device:R_Variable", match: () => false,
    curve: (m) => Math.pow(10, 6 - 3 * clamp(m, 0, 100) / 100), note: "1 MΩ dry … 1 kΩ wet" },
  { id: "level", label: "Liquid level strip (resistive)", senses: "level", shape: "resistive", kirk: "LevelSensor", symbol: "Device:R_Variable", match: () => false,
    curve: (l) => 2000 - 16 * clamp(l, 0, 100), note: "2 kΩ empty … 400 Ω full" },
  { id: "humidity", label: "Humidity sensor (analog, HIH-4030 type)", senses: "humidity", shape: "module", ratiometric: true, kirk: "HumiditySensor", symbol: "SpaceBench:SensorModule", match: () => false,
    curve: (rh) => clamp(0.0062 * rh + 0.16, 0.16, 0.8), note: "Vout = Vs·(0.0062·RH + 0.16)" },
  { id: "pressure", label: "Pressure sensor (40PC series)", senses: "pressure", shape: "module", ratiometric: true, kirk: "PressureSensor", symbol: "Sensor_Pressure:40PC015G",
    match: (lib, n) => lib === "Sensor_Pressure" && /^40PC/.test(n), pins: { vs: ["Vcc", "VCC", "Vs", "VS", "+Vs", "V+", "Vdd", "VDD"], out: ["Vout", "VOUT", "OUT"], gnd: ["GND", "Gnd"] },
    curve: (pa, p) => clamp(0.1 + 0.8 * pa / (p.pmax ?? 103.4e3), 0.05, 0.95), defaults: { pmax: 103.4e3 }, note: "Vout = Vs·(0.1 + 0.8·P/Pmax) — 40PC015G: Pmax 15 psi" },
  { id: "hall", label: "Linear Hall sensor (A1301/A1302)", senses: "field", shape: "module", ratiometric: true, kirk: "HallSensor", symbol: "Sensor_Magnetic:A1301xUA",
    match: (lib, n) => lib === "Sensor_Magnetic" && /^A130[12]/.test(n), pins: { vs: ["V_{CC}", "VCC", "Vcc", "VDD"], out: ["V_{OUT}", "VOUT", "Vout", "OUT"], gnd: ["GND", "Gnd"] },
    curve: (b, p) => clamp(0.5 + (p.sens ?? 5) * b, 0.05, 0.95), defaults: { sens: 5 }, note: "Vout = Vs/2 + 25 mV/mT at 5 V (A1301; A1302: 13 mV/mT)" },
  { id: "hallsw", label: "Hall switch (A110x)", senses: "field", shape: "opendrain", kirk: "HallSwitch", symbol: "Sensor_Magnetic:A1101xUA",
    match: (lib, n) => lib === "Sensor_Magnetic" && /^A110\d/.test(n), pins: { vs: ["V_{CC}", "VCC", "Vcc", "VDD"], out: ["V_{OUT}", "VOUT", "Vout", "OUT"], gnd: ["GND", "Gnd"] },
    curve: (b, p) => (Math.abs(b) > (p.bop ?? 0.0175) ? 1 : 0), defaults: { bop: 0.0175 }, note: "output pulled low when |B| > 17.5 mT (open drain: add a pull-up)" },
  { id: "distance", label: "IR distance sensor (analog, Sharp type)", senses: "distance", shape: "module", kirk: "DistanceSensor", symbol: "SpaceBench:SensorModule", match: () => false,
    curve: (d) => clamp(27.86 * Math.pow(Math.max(d, 4), -1.15), 0.35, 3.1), note: "Vout ≈ 27.9·d^−1.15 V (10 … 80 cm)" },
  { id: "accel", label: "Accelerometer axis (analog, ADXL335 type)", senses: "accel", shape: "module", ratiometric: true, kirk: "Accelerometer", symbol: "SpaceBench:SensorModule", match: () => false,
    curve: (a) => clamp(0.5 + 0.1 * a, 0.05, 0.95), note: "Vout = Vs·(0.5 + 0.1·a/g)" },
  { id: "gasmodule", label: "Gas sensor module (MQ + 10 kΩ load)", senses: "gas", shape: "module", ratiometric: true, kirk: "GasModule", symbol: "SpaceBench:SensorModule", match: () => false,
    curve: (ppm) => { const rs = clamp(10e3 * Math.pow(Math.max(ppm, 50) / 1000, -0.47), 500, 2e5); return 10e3 / (10e3 + rs) }, note: "Vout = Vs·RL/(RL + Rs), RL = 10 kΩ" },
  { id: "pir", label: "Motion sensor (PIR module)", senses: "motion", shape: "module", ratiometric: true, kirk: "PIR", symbol: "SpaceBench:SensorModule", match: () => false,
    curve: (m) => (m > 0.5 ? 0.98 : 0), note: "output high while motion is seen" },
  { id: "touch", label: "Touch sensor (AT42QT1010)", senses: "touch", shape: "module", ratiometric: true, kirk: "TouchSensor", symbol: "Sensor_Touch:AT42QT1010-TSHR",
    match: (lib, n) => lib === "Sensor_Touch" && /^AT42QT1010/.test(n), pins: { vs: ["VDD", "Vdd", "VCC"], out: ["OUT", "Out"], gnd: ["VSS", "Vss", "GND"] },
    curve: (t) => (t > 0.5 ? 0.98 : 0), note: "OUT high while the pad is touched" },
  { id: "loadcell", label: "Load cell (strain bridge)", senses: "force", shape: "bridge", kirk: "LoadCell", symbol: "SpaceBench:LoadCell", match: () => false,
    curve: (f, p) => (p.sens ?? 0.002) * clamp(f, -(p.fmax ?? 49), p.fmax ?? 49) / (p.fmax ?? 49), defaults: { sens: 0.002, fmax: 49 }, note: "2 mV/V at full scale (5 kg = 49 N), 1 kΩ bridge" },
  { id: "acs", label: "Current sensor (Hall, ACS7xx)", senses: null, shape: "current", ratiometric: true, kirk: "CurrentSensor", symbol: "Sensor_Current:ACS706xLC-05C",
    match: (lib, n) => lib === "Sensor_Current" && /^ACS7/.test(n), pins: { ipp: ["IP+"], ipn: ["IP-"], vs: ["VCC"], out: ["VOUT", "VIOUT"], gnd: ["GND"] },
    curve: () => 0, note: "measures the current from IP+ to IP−: Vout = Vs/2 + k·I (k ≈ 0.93 V ÷ range, at 5 V)" },
]

/** ACS current sensors: sensitivity from the range in the name (…-05C: 5 A → 185 mV/A at 5 V). */
export const currentSensitivity = (name: string) => { const r = Number(/-(\d+)/.exec(name)?.[1] ?? 5); return 0.925 / (r || 5) }

export const sensorModelFor = (lib: string, name: string, value?: string): SensorModel | null => {
  // built-in / generic symbols: chosen by the part's value (the Kirk constructor name)
  if (lib === "SpaceBench" || (lib === "Device" && name === "R_Variable")) return SENSOR_MODELS.find((m) => m.kirk === value || m.id === value) ?? null
  return SENSOR_MODELS.find((m) => m.match(lib, name)) ?? null
}

/** The curve as "x0,y0, x1,y1 …" for ngspice's pwl(): 48 points over the quantity's range. */
export function curveTable(m: SensorModel, params: Record<string, number>): string {
  const q = m.senses ? QUANTITIES[m.senses] : null
  const [lo, hi] = q?.range ?? [0, 1]
  const pts: string[] = []
  const N = 48
  const log = m.logX && lo > 0
  // a step response needs points either side of its threshold
  const extra = m.id === "hallsw" ? [-(params.bop ?? 0.0175) - 1e-6, -(params.bop ?? 0.0175) + 1e-6, (params.bop ?? 0.0175) - 1e-6, (params.bop ?? 0.0175) + 1e-6] : m.id === "pir" || m.id === "touch" ? [0.49, 0.51] : []
  const xs = [...Array.from({ length: N }, (_, k) => (log ? lo * Math.pow(hi / lo, k / (N - 1)) : lo + ((hi - lo) * k) / (N - 1))), ...extra].sort((a, b) => a - b)
  for (const x of xs) pts.push(`${Number(x.toPrecision(6))},${Number(m.curve(x, params).toPrecision(6))}`)
  return pts.join(",")
}

// ---------------------------------------------------------------- built-in symbols

const PX = 12.7
const pin = (n: string, name: string, x: number, y: number, a: number, t: string): KPin => ({ n, name, x, y, a, t })
function moduleSymbol(id: string, desc: string, pins: { n: string; name: string; side: "top" | "bottom" | "left" | "right"; t: string }[], wGrid: number, hGrid: number): SymbolDef {
  const hw = (wGrid / 2) * PX, hh = (hGrid / 2) * PX
  const sides = { top: [] as typeof pins, bottom: [] as typeof pins, left: [] as typeof pins, right: [] as typeof pins }
  for (const p of pins) sides[p.side].push(p)
  const kp: KPin[] = []
  let svg = `<rect x="${-hw}" y="${-hh}" width="${2 * hw}" height="${2 * hh}" rx="3" stroke-width="2" fill="var(--canvas-symbol-fill, none)"/>`
  svg += `<path d="M${-hw * 0.45},2 q4,-8 8,0 t8,0 t8,0" stroke-width="1.6" fill="none"/>` // a little "signal" mark
  for (const [side, list] of Object.entries(sides) as [keyof typeof sides, typeof pins][]) {
    list.forEach((p, i) => {
      const along = (i - (list.length - 1) / 2) * 2
      const [gx, gy, a] = side === "top" ? [along, -hGrid / 2 - 1, 270] : side === "bottom" ? [along, hGrid / 2 + 1, 90] : side === "left" ? [-wGrid / 2 - 1, along, 0] : [wGrid / 2 + 1, along, 180]
      kp.push(pin(p.n, p.name, gx, gy, a, p.t))
      const [x0, y0] = [gx * PX, gy * PX]
      const [x1, y1] = side === "top" ? [x0, -hh] : side === "bottom" ? [x0, hh] : side === "left" ? [-hw, y0] : [hw, y0]
      svg += `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" class="kp"/>`
      const [tx, ty, anchor] = side === "top" ? [x0, -hh + 11, "middle"] : side === "bottom" ? [x0, hh - 4, "middle"] : side === "left" ? [-hw + 4, y0 + 3.5, "start"] : [hw - 4, y0 + 3.5, "end"]
      svg += `<text x="${tx}" y="${ty}" font-size="8" text-anchor="${anchor}" fill="currentColor" stroke="none" font-family="ui-monospace,monospace">${p.name}</text>`
    })
  }
  return {
    id, lib: "SpaceBench", name: id.split(":")[1], bases: [], desc, refPrefix: "U", value: "Sensor", power: false, excludeFromSim: false,
    units: [{ svg, pins: kp, box: [-hw - PX, -hh - PX, 2 * hw + 2 * PX, 2 * hh + 2 * PX] }],
    fields: { Reference: { v: "U", x: hw + 6, y: -hh + 2, j: "left" }, Value: { v: "Sensor", x: hw + 6, y: -hh + 16, j: "left" } },
  }
}

registerBuiltin(moduleSymbol("SpaceBench:SensorModule", "Analog sensor module (VCC, OUT, GND)", [
  { n: "1", name: "VCC", side: "top", t: "power_in" }, { n: "2", name: "OUT", side: "right", t: "output" }, { n: "3", name: "GND", side: "bottom", t: "power_in" },
], 6, 4))
registerBuiltin(moduleSymbol("SpaceBench:LoadCell", "Load cell — strain-gauge bridge (E+, E−, S+, S−)", [
  { n: "1", name: "E+", side: "top", t: "passive" }, { n: "2", name: "E-", side: "bottom", t: "passive" }, { n: "3", name: "S+", side: "right", t: "output" }, { n: "4", name: "S-", side: "left", t: "output" },
], 6, 4))
