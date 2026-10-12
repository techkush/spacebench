// Sensor physics: how each sensor turns what it senses (light, temperature, sound) into a
// resistance, current or voltage. What it senses comes from the circuit's feeds (lib/feeds.ts).
export interface Environment {
  /** illuminance on light sensors (lux): night 1 · room 300 · office 500 · daylight 10k · sun 100k */
  light: number
  /** ambient temperature (°C); also the simulation temperature when set */
  temp: number
  /** sound level at microphones (dB SPL): quiet room 30 · talking 60 · shouting 90 */
  sound: number
  /** pitch of the room's sound (Hz) */
  tone: number
}

/** What a sensor senses without a feed. 27 °C is SPICE's default, so unfed circuits simulate as before. */
export const DEFAULT_ENV: Environment = { light: 300, temp: 27, sound: 40, tone: 1000 }

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

/** Light-dependent resistor: R = R10·(lux/10)^−γ, capped by the dark resistance. */
export function ldrResistance(lux: number, r10 = 10e3, gamma = 0.7, rdark = 1e6): number {
  return clamp(r10 * Math.pow(Math.max(lux, 1e-3) / 10, -gamma), 50, rdark)
}

/** NTC thermistor (β model): R = R25·exp(β·(1/T − 1/298.15 K)). */
export function ntcResistance(tempC: number, r25: number, beta = 3950): number {
  const t = tempC + 273.15
  return r25 * Math.exp(beta * (1 / t - 1 / 298.15))
}

/** PTC thermistor: R = R25·exp(tc·(T − 25 °C)) — a steep rise above its switch point. */
export function ptcResistance(tempC: number, r25: number, tc = 0.05): number {
  return r25 * Math.exp(tc * (tempC - 25))
}

/** Photodiode / phototransistor-base current: responsivity (A per lux) × lux. */
export const photoCurrent = (lux: number, perLux: number) => Math.max(0, lux) * perLux

/** Electret microphone output (V peak): −42 dBV/Pa sensitivity, 94 dB SPL = 1 Pa. */
export function micAmplitude(dbSpl: number, dbvPerPa = -42): number {
  if (dbSpl <= 0) return 0
  const pa = Math.pow(10, (dbSpl - 94) / 20)
  return Math.pow(10, dbvPerPa / 20) * pa * Math.SQRT2
}

/** Analog temperature sensor output (V): LM35 10 mV/°C from 0 °C; TMP36 0.5 V + 10 mV/°C. */
export function tempSensorVolts(tempC: number, kind: "LM35" | "TMP36"): number {
  return kind === "TMP36" ? clamp(0.5 + 0.01 * tempC, 0.1, 2) : clamp(0.01 * tempC, 0, 1.5)
}

const fmt = (v: number, d = 3) => Number(v.toPrecision(d)).toString()
export const luxText = (lux: number) => (lux >= 1000 ? `${fmt(lux / 1000)}k lx` : `${fmt(lux)} lx`)
