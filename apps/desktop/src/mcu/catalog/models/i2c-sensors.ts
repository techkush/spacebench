// Models: i2c-sensors — Grove I²C twigs modelled at register level from their datasheets, so the
// usual Arduino libraries (Seeed, Bosch, Adafruit, SparkFun …) run unchanged and compute the
// slider values from the raw data, trim / calibration coefficients and status bits they read.
//
//  bma456   Bosch BMA456 step counter (0x19): CHIP_ID 0x16, the 6 kB config upload through
//           INIT_CTRL / 0x5B-0x5C / FEATURES_IN (0x5E) and INTERNAL_STATUS, the feature page, accel,
//           temperature, sensor time and the step counter output that advances while "walking".
//  bmm150   Bosch BMM150 magnetometer (0x13): power control, op modes, trim registers, and raw
//           X/Y/Z/RHALL found by searching Bosch's integer compensation for the slider field (µT).
//  adxl372  ADI ADXL372 ±200 g (0x53): IDs, 12-bit data at 100 mg/LSB, status, peak registers,
//           POWER_CTL modes (instant-on captures only above its threshold), the 512-entry FIFO.
//  bmi088   Bosch BMI088: accelerometer (0x19, ACC_CHIP_ID 0x1E) + gyroscope (0x69, 0x0F), power
//           conf/ctrl, ranges, self-test excitation, temperature, sensor time.
//  dps310 / spa06   Infineon DPS310 (0x77, ID 0x10) and Goertek SPA06-003 (0x77, ID 0x11, extra
//           c31/c40): coefficients, oversampling scale factors, MEAS_CFG ready bits and the
//           background / command measurement timing; raw values invert the compensation.
//  hp206c   HopeRF HP206C (0x76): commands (SOFT_RST, ADC_CVT, READ_PT/AT/P/A/T, register read/write),
//           20-bit pressure / temperature / altitude words.
//  as3935   (proto) ams AS3935 lightning sensor (0x03): AFE / noise floor / watchdog / spike registers,
//           strike statistics, distance estimate, energy, INT_L / INT_D / INT_NH with IRQ held high
//           until the interrupt register is read, CALIB_RCO / PRESET_DEFAULT direct commands.
import type { I2CDevice } from "../../devices"
import type { CatDevice, SimCtx } from "../devices"
import type { Chip } from "../i2c"
import type { ModelGroup } from "./types"

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))
const i16 = (v: number) => (v << 16) >> 16
const tdiv = (a: number, b: number) => Math.trunc(a / b)

/**
 * An 8-bit register file: the first byte after START sets the pointer, data auto-increments
 * except on stream registers (`stay`). Hooks: `wr` after a byte is stored, `rd` computes a read,
 * `onRead` on a read transaction's first byte, `onStart` on every START.
 */
export class RegFile implements I2CDevice {
  readonly r = new Uint8Array(256)
  ptr = 0
  private fresh = true
  private reading = false
  wr?: (reg: number, v: number) => void
  rd?: (reg: number) => number | undefined
  onRead?: (reg: number) => void
  onStart?: () => void
  stay?: (reg: number) => boolean
  start() { this.fresh = true; this.reading = false; this.onStart?.() }
  write(b: number) {
    if (this.fresh) { this.ptr = b; this.fresh = false; return }
    const reg = this.ptr
    this.r[reg] = b
    this.wr?.(reg, b)
    if (!this.stay?.(reg)) this.ptr = (reg + 1) & 0xff
  }
  read() {
    if (!this.reading) { this.reading = true; this.onRead?.(this.ptr) }
    const reg = this.ptr
    const v = this.rd?.(reg) ?? this.r[reg]
    if (!this.stay?.(reg)) this.ptr = (reg + 1) & 0xff
    return v & 0xff
  }
  le16(reg: number, v: number) { this.r[reg] = v & 0xff; this.r[reg + 1] = (v >> 8) & 0xff }
  be16(reg: number, v: number) { this.r[reg] = (v >> 8) & 0xff; this.r[reg + 1] = v & 0xff }
}
const secs = (ctx: SimCtx) => ctx.now() / ctx.hz

// ── Bosch BMA456 step counter ──────────────────────────────────────────────────────────────
export const BMA456_CONFIG_SIZE = 6144
function bma456(ctx: SimCtx, addr: number): Chip {
  const g = new RegFile(), r = g.r
  const ram = new Uint8Array(8192) // config RAM the 6 kB blob is streamed into
  const written = new Uint8Array(BMA456_CONFIG_SIZE)
  let nWritten = 0
  const feat = new Uint8Array(64) // feature page (FEATURES_IN once initialised)
  let init = false, initAt = 0, status = 0
  let steps = 0, stepT = 0
  let n5e = 0 // byte offset within the current 0x5E burst
  const reset = () => {
    r.fill(0)
    r[0x00] = 0x16; r[0x03] = 0x10; r[0x40] = 0xa8; r[0x41] = 0x01; r[0x7c] = 0x03
    init = false; status = 0; feat.fill(0); written.fill(0); nWritten = 0; steps = 0
  }
  reset()
  const enabled = () => init && (r[0x7d] & 0x04) !== 0 && (feat[0x37] & 0x10) !== 0
  const advance = () => {
    const t = secs(ctx)
    if (enabled()) steps += (Math.max(0, ctx.ctl("walk")) / 60) * (t - stepT)
    stepT = t
  }
  const base = () => (((r[0x5c] << 4) | (r[0x5b] & 0x0f)) * 2)
  g.onStart = () => { n5e = 0 }
  g.stay = (reg) => reg === 0x5e
  g.wr = (reg, v) => {
    if (reg === 0x7e && v === 0xb6) { advance(); reset(); return }
    if (reg === 0x59) {
      if (v & 1 && !init) {
        // config load: the ASIC starts only from a complete blob
        initAt = secs(ctx)
        status = nWritten >= BMA456_CONFIG_SIZE ? 1 : 2
        if (status === 1) { init = true; r[0x5b] = 0; r[0x5c] = 0; feat[0x3c] = 0x0d; feat[0x3d] = 0x01 } // config id
      }
      return
    }
    if (reg === 0x7d) { advance(); return }
    if (reg !== 0x5e) return
    const a = base() + n5e++
    if (!init) {
      if (a < ram.length) ram[a] = v
      if (a < BMA456_CONFIG_SIZE && !written[a]) { written[a] = 1; nWritten++ }
    } else if (a < 64) {
      if (a === 0x37) {
        advance()
        if (v & 0x04) { steps = 0; v &= ~0x04 } // step counter reset (self-clearing)
      }
      feat[a] = v
    }
  }
  g.onRead = (reg) => {
    if (reg <= 0x17 + 6 && reg + 6 >= 0x12) {
      const on = (r[0x7d] & 0x04) !== 0
      const k = 16384 >> (r[0x41] & 3)
      ;["ax", "ay", "az"].forEach((key, i) => g.le16(0x12 + i * 2, on ? i16(clamp(Math.round(ctx.ctl(key) * k), -32768, 32767)) & 0xffff : 0))
      r[0x03] = 0x10 | (on ? 0x80 : 0)
    }
    if (reg <= 0x1a && reg + 3 >= 0x18) { const st = Math.floor(secs(ctx) / 39.0625e-6) & 0xffffff; r[0x18] = st & 0xff; r[0x19] = (st >> 8) & 0xff; r[0x1a] = st >> 16 }
    if (reg <= 0x21 && reg + 4 >= 0x1e) {
      advance()
      const s = Math.floor(steps) >>> 0
      r[0x1e] = s & 0xff; r[0x1f] = (s >>> 8) & 0xff; r[0x20] = (s >>> 16) & 0xff; r[0x21] = s >>> 24
      const w = enabled() ? ctx.ctl("walk") : 0
      r[0x27] = w <= 0 ? 0 : w < 140 ? 1 : 2 // activity: still / walking / running
    }
    if (reg <= 0x22 && reg >= 0x1e) r[0x22] = clamp(Math.round(ctx.ctl("t") - 23), -128, 127) & 0xff
    if (reg === 0x2a || (reg < 0x2a && reg + 8 >= 0x2a)) r[0x2a] = status === 1 && secs(ctx) - initAt < 0.02 ? 0 : status
  }
  g.rd = (reg) => {
    if (reg !== 0x5e) return undefined
    const a = base() + n5e++
    return init ? (a < 64 ? feat[a] : 0) : a < ram.length ? ram[a] : 0
  }
  stepT = secs(ctx)
  return { devices: [[addr, g]], view: () => ({ text: `${Math.floor(steps)} steps` }) }
}

// ── Bosch BMM150 magnetometer ──────────────────────────────────────────────────────────────
/** trim registers of a real part (dig_x1, dig_y1, dig_x2, dig_y2, dig_z1..z4, dig_xy1, dig_xy2, dig_xyz1) */
export const BMM_TRIM = { x1: 2, y1: -3, x2: 26, y2: 26, z1: 24747, z2: 763, z3: -45, z4: 0, xy1: 29, xy2: -3, xyz1: 6615 }
export const BMM_RHALL = 6800
type Trim = typeof BMM_TRIM
/** Bosch's integer compensation (bmm150.c), with C's truncating division and int16 casts */
export function bmmX(t: Trim, raw: number, rhall: number, y = false): number {
  const x0 = rhall !== 0 ? rhall : t.xyz1
  if (x0 === 0) return -32768
  const x2 = ((tdiv(t.xyz1 * 16384, x0) & 0xffff) - 0x4000) & 0xffff
  const rv = i16(x2)
  const x4 = t.xy2 * tdiv(rv * rv, 128)
  const x6 = rv * (t.xy1 * 128)
  const x7 = tdiv(x4 + x6, 512) + 0x100000
  const x9 = tdiv(x7 * ((y ? t.y2 : t.x2) + 0xa0), 4096)
  const out = i16(tdiv(raw * x9, 8192))
  return tdiv(out + (y ? t.y1 : t.x1) * 8, 16)
}
export function bmmZ(t: Trim, raw: number, rhall: number): number {
  if (!t.z2 || !t.z1 || !rhall || !t.xyz1) return -32768
  const z0 = i16(rhall - t.xyz1)
  const z1 = tdiv(t.z3 * z0, 4)
  const z2 = (raw - t.z4) * 32768
  const z3 = t.z1 * (rhall * 2)
  const z4 = i16(tdiv(z3 + 32768, 65536))
  const rv = clamp(tdiv(z2 - z1, t.z2 + z4), -32768, 32767)
  return tdiv(rv, 16)
}
/** the raw value in [lo, hi] whose compensation is closest to the target (compensation rises with raw) */
function invert(f: (raw: number) => number, target: number, lo: number, hi: number): number {
  let a = lo, b = hi
  while (a < b) { const m = Math.floor((a + b) / 2); if (f(m) < target) a = m + 1; else b = m }
  return a > lo && Math.abs(f(a - 1) - target) < Math.abs(f(a) - target) ? a - 1 : a
}
function bmm150(ctx: SimCtx, addr: number): Chip {
  const g = new RegFile(), r = g.r
  const t = BMM_TRIM
  const trim = () => {
    r[0x5d] = t.x1 & 0xff; r[0x5e] = t.y1 & 0xff
    g.le16(0x62, t.z4 & 0xffff); r[0x64] = t.x2 & 0xff; r[0x65] = t.y2 & 0xff
    g.le16(0x68, t.z2 & 0xffff); g.le16(0x6a, t.z1); g.le16(0x6c, t.xyz1); g.le16(0x6e, t.z3 & 0xffff)
    r[0x70] = t.xy2 & 0xff; r[0x71] = t.xy1
  }
  const defaults = () => { r.fill(0, 0x40, 0x5d); r[0x4c] = 0x06; r[0x4e] = 0x07; r[0x4f] = 0x3f; r[0x51] = 0x00; r[0x52] = 0x00 }
  trim(); defaults()
  const powered = () => (r[0x4b] & 1) !== 0
  const measure = () => {
    const rh = BMM_RHALL
    const x = invert((v) => bmmX(t, v, rh), ctx.ctl("mx"), -4096, 4095)
    const y = invert((v) => bmmX(t, v, rh, true), ctx.ctl("my"), -4096, 4095)
    const z = invert((v) => bmmZ(t, v, rh), ctx.ctl("mz"), -16384, 16383)
    r[0x42] = (x & 0x1f) << 3; r[0x43] = (x >> 5) & 0xff
    r[0x44] = (y & 0x1f) << 3; r[0x45] = (y >> 5) & 0xff
    r[0x46] = (z & 0x7f) << 1; r[0x47] = (z >> 7) & 0xff
    r[0x48] = ((rh & 0x3f) << 2) | 1; r[0x49] = (rh >> 6) & 0xff
  }
  g.wr = (reg, v) => {
    if (reg === 0x4b) {
      if (v & 0x82) { defaults(); r[0x4b] = v & 1 } // soft reset: registers back to defaults
      if (!(v & 1)) { defaults(); r[0x4b] = 0 } // suspend
    }
    if (reg === 0x4c && ((v >> 1) & 3) === 1 && powered()) { measure(); r[0x4c] = v | 0x06 } // forced: one conversion, back to sleep
  }
  g.rd = (reg) => (reg !== 0x4b && reg >= 0x40 && !powered() ? 0 : reg === 0x40 ? 0x32 : undefined)
  g.onRead = (reg) => {
    if (!powered() || reg > 0x49 || reg + 8 < 0x42) return
    if (((r[0x4c] >> 1) & 3) === 0) measure() // normal mode: a fresh result at the data rate
  }
  return { devices: [[addr, g]] }
}

// ── ADI ADXL372 ±200 g ────────────────────────────────────────────────────────────────────
function adxl372(ctx: SimCtx, addr: number): Chip {
  const g = new RegFile(), r = g.r
  const fifo: number[] = []
  let fifoByte = 0, last = 0, overrun = false
  const peak = [-2048, -2048, -2048]
  const defaults = () => {
    r.fill(0); r[0x00] = 0xad; r[0x01] = 0x1d; r[0x02] = 0xfa; r[0x03] = 0x02
    r[0x39] = 0x80; r[0x3d] = 0x00; r[0x3e] = 0x00; r[0x3f] = 0x00
    fifo.length = 0; fifoByte = 0; overrun = false; peak.fill(-2048)
  }
  defaults()
  const counts = () => ["ax", "ay", "az"].map((k) => clamp(Math.round(ctx.ctl(k) * 10), -2048, 2047))
  const mode = () => r[0x3f] & 3
  const odr = () => 400 << Math.min(4, (r[0x3d] >> 5) & 7)
  const instantOn = () => mode() === 2
  const triggered = (c: number[]) => !instantOn() || Math.max(...c.map(Math.abs)) * 0.1 >= (r[0x3f] & 0x20 ? 30 : 10)
  /** samples the ODR produced since the last look go into the FIFO (and the peaks) */
  const sample = () => {
    const now = secs(ctx)
    if (mode() === 0) { last = now; return }
    const n = Math.min(600, Math.floor((now - last) * odr()))
    if (n <= 0) return
    last += n / odr()
    const c = counts()
    if (!triggered(c)) return
    c.forEach((v, i) => (peak[i] = Math.max(peak[i], v)))
    const fm = (r[0x3a] >> 1) & 3, fmt = (r[0x3a] >> 3) & 7
    if (fm === 0) return
    const axes = [[0, 1, 2], [0], [1], [0, 1], [2], [0, 2], [1, 2], [0, 1, 2]][fmt]
    for (let k = 0; k < n; k++) {
      if (fifo.length + axes.length > 512) {
        overrun = true
        if (fm === 3) break // oldest saved: stop when full
        fifo.splice(0, axes.length)
      }
      axes.forEach((a, j) => fifo.push(((((fmt === 7 ? peak[a] : c[a]) << 4) & 0xfff0) | (j === 0 ? 1 : 0))))
    }
  }
  g.stay = (reg) => reg === 0x42
  g.onStart = () => { fifoByte = 0 }
  g.wr = (reg, v) => {
    if (reg === 0x41 && v === 0x52) { defaults(); return }
    if (reg === 0x3f || reg === 0x3d) { sample(); last = secs(ctx) }
    if (reg === 0x3a) { fifo.length = 0; fifoByte = 0; overrun = false }
  }
  g.onRead = (reg) => {
    sample()
    const c = counts(), on = mode() !== 0 && triggered(c)
    if (on) c.forEach((v, i) => { peak[i] = Math.max(peak[i], v); g.be16(0x08 + i * 2, (v << 4) & 0xfff0) })
    const wm = r[0x39] | ((r[0x3a] & 1) << 8)
    r[0x04] = (on ? 1 : 0) | (fifo.length >= wm && wm ? 2 : 0) | (fifo.length >= 512 ? 4 : 0) | (overrun ? 8 : 0) | (mode() !== 0 ? 0x40 : 0)
    r[0x06] = (fifo.length >> 8) & 3; r[0x07] = fifo.length & 0xff
    if (reg <= 0x1a && reg + 6 >= 0x15) peak.forEach((v, i) => g.be16(0x15 + i * 2, (Math.max(-2048, v) << 4) & 0xfff0))
    if (reg <= 0x04 && reg + 4 >= 0x04) overrun = false
  }
  g.rd = (reg) => {
    if (reg === 0x42) {
      const w = fifo[0]
      if (w === undefined) return 0
      const b = fifoByte === 0 ? w >> 8 : w & 0xff
      if (++fifoByte === 2) { fifoByte = 0; fifo.shift() }
      return b
    }
    // reading a peak register's low byte restarts that axis' peak
    if (reg === 0x16 || reg === 0x18 || reg === 0x1a) { const v = r[reg]; peak[(reg - 0x16) / 2] = -2048; return v }
    return undefined
  }
  return { devices: [[addr, g]], drives: () => { if (mode() !== 0) { const c = counts(); if (triggered(c)) c.forEach((v, i) => (peak[i] = Math.max(peak[i], v))) } } }
}

// ── Bosch BMI088 accelerometer + gyroscope ────────────────────────────────────────────────
function bmi088(ctx: SimCtx, accAddr: number): Chip {
  const a = new RegFile(), ar = a.r
  const gy = new RegFile(), gr = gy.r
  const accDefaults = () => { ar.fill(0); ar[0x00] = 0x1e; ar[0x40] = 0xa8; ar[0x41] = 0x01; ar[0x53] = 0x01; ar[0x54] = 0x01; ar[0x7c] = 0x03 }
  const gyroDefaults = () => { gr.fill(0); gr[0x00] = 0x0f; gr[0x10] = 0x80; gr[0x16] = 0x0f }
  accDefaults(); gyroDefaults()
  a.wr = (reg, v) => { if (reg === 0x7e && v === 0xb6) accDefaults() }
  const accOn = () => ar[0x7d] === 0x04 && ar[0x7c] === 0x00
  a.onRead = (reg) => {
    if (reg <= 0x1d && reg + 9 >= 0x03) {
      const on = accOn()
      const lsb = 32768 / (1.5 * (2 << (ar[0x41] & 3))) // per g: ±3 / 6 / 12 / 24 g
      const st = ar[0x6d] === 0x0d ? 1 : ar[0x6d] === 0x09 ? -1 : 0 // self-test excitation
      ;[["ax", 1], ["ay", 1], ["az", 0.5]].forEach(([k, e], i) => a.le16(0x12 + i * 2, on ? i16(clamp(Math.round((ctx.ctl(k as string) + st * (e as number)) * lsb), -32768, 32767)) & 0xffff : 0))
      ar[0x03] = on ? 0x80 : 0; ar[0x1d] = on ? 0x80 : 0
      const t = Math.floor(secs(ctx) / 39.0625e-6) & 0xffffff
      ar[0x18] = t & 0xff; ar[0x19] = (t >> 8) & 0xff; ar[0x1a] = t >> 16
    }
    if (reg === 0x22 || reg === 0x23) {
      const v = clamp(Math.round((ctx.ctl("t") - 23) * 8), -1024, 1023) & 0x7ff
      ar[0x22] = v >> 3; ar[0x23] = (v & 7) << 5
    }
  }
  gy.wr = (reg, v) => {
    if (reg === 0x14 && v === 0xb6) gyroDefaults()
    if (reg === 0x10) gr[0x10] = v | 0x80
    if (reg === 0x3c && v & 1) gr[0x3c] = 0x12 // built-in self-test: done, rate ok
  }
  gy.onRead = (reg) => {
    if (reg > 0x0a || reg + 6 < 0x02) return
    const on = gr[0x11] === 0x00
    const lsb = 32768 / (2000 >> Math.min(4, gr[0x0f] & 7))
    ;["gx", "gy", "gz"].forEach((k, i) => gy.le16(0x02 + i * 2, on ? i16(clamp(Math.round(ctx.ctl(k) * lsb), -32768, 32767)) & 0xffff : 0))
    gr[0x0a] = on ? 0x80 : 0
  }
  const gyroAddr = Number(ctx.attrs.gyroAddress ?? (accAddr === 0x18 ? 0x68 : 0x69))
  return { devices: [[accAddr, a], [gyroAddr, gy]] }
}

// ── Infineon DPS310 / Goertek SPA06-003 ───────────────────────────────────────────────────
export const OS_SCALE = [524288, 1572864, 3670016, 7864320, 253952, 516096, 1040384, 2088960]
const OS_MS = [3.6, 5.2, 8.4, 14.8, 27.6, 53.2, 104.4, 206.8]
export interface Coefs { c0: number; c1: number; c00: number; c10: number; c01: number; c11: number; c20: number; c21: number; c30: number; c31: number; c40: number }
export const DPS310_COEF: Coefs = { c0: 204, c1: -261, c00: 80469, c10: -54769, c01: -2803, c11: 1219, c20: -10838, c21: 143, c30: -1427, c31: 0, c40: 0 }
export const SPA06_COEF: Coefs = { c0: 203, c1: -258, c00: 81352, c10: -55912, c01: -2718, c11: 1243, c20: -10502, c21: 152, c30: -1398, c31: -21, c40: 13 }
export const pressureOf = (c: Coefs, p: number, t: number) => c.c00 + p * (c.c10 + p * (c.c20 + p * (c.c30 + c.c40 * p))) + t * (c.c01 + p * (c.c11 + p * (c.c21 + c.c31 * p)))
/** scaled raw pressure for a pressure (Pa) at a scaled raw temperature: Newton on the compensation polynomial */
export function invertPressure(c: Coefs, pa: number, t: number): number {
  let x = (pa - c.c00 - t * c.c01) / c.c10
  for (let i = 0; i < 30; i++) {
    const f = pressureOf(c, x, t) - pa
    const d = c.c10 + x * (2 * c.c20 + x * (3 * c.c30 + 4 * c.c40 * x)) + t * (c.c11 + x * (2 * c.c21 + 3 * c.c31 * x))
    const nx = x - f / d
    if (Math.abs(nx - x) < 1e-12) { x = nx; break }
    x = nx
  }
  return x
}
function dpsFamily(ctx: SimCtx, addr: number, spa: boolean): Chip {
  const g = new RegFile(), r = g.r
  const c = spa ? SPA06_COEF : DPS310_COEF
  let resetAt = 0, startAt = -1, readP = 0, readT = 0
  const coefBytes = () => {
    const b = [
      (c.c0 >> 4) & 0xff, ((c.c0 & 0xf) << 4) | ((c.c1 >> 8) & 0xf), c.c1 & 0xff,
      (c.c00 >> 12) & 0xff, (c.c00 >> 4) & 0xff, ((c.c00 & 0xf) << 4) | ((c.c10 >> 16) & 0xf), (c.c10 >> 8) & 0xff, c.c10 & 0xff,
      ...[c.c01, c.c11, c.c20, c.c21, c.c30].flatMap((v) => [(v >> 8) & 0xff, v & 0xff]),
    ]
    if (spa) b.push((c.c31 >> 4) & 0xff, ((c.c31 & 0xf) << 4) | ((c.c40 >> 8) & 0xf), c.c40 & 0xff)
    b.forEach((v, i) => (r[0x10 + i] = v))
  }
  const defaults = () => { r.fill(0); r[0x0d] = spa ? 0x11 : 0x10; coefBytes(); if (!spa) r[0x28] = 0x80; r[0x0b] = 0x01; startAt = -1; resetAt = secs(ctx) }
  defaults(); resetAt = 0
  const rateHz = (cfg: number) => { const n = spa ? (cfg >> 4) & 0xf : (cfg >> 4) & 7; return n < 8 ? 1 << n : (25 / 16) * (1 << (n - 8)) }
  const tmeas = (cfg: number) => OS_MS[cfg & 7] / 1000
  /** how many results of a kind are done since the measurement started */
  const done = (kind: "p" | "t") => {
    const m = r[0x08] & 7
    if (startAt < 0 || m === 0) return 0
    const cfg = r[kind === "p" ? 0x06 : 0x07]
    const want = kind === "p" ? m === 1 || m === 5 || m === 7 : m === 2 || m === 6 || m === 7
    if (!want) return 0
    const dt = secs(ctx) - startAt - tmeas(cfg) * (m === 7 && kind === "p" ? 2 : 1)
    if (dt < 0) return 0
    return m < 4 ? 1 : 1 + Math.floor(dt / Math.max(1 / rateHz(cfg), tmeas(r[0x06]) + tmeas(r[0x07])))
  }
  const meas = () => {
    const m = r[0x08] & 7
    const sensor = secs(ctx) - resetAt >= 0.012, coef = secs(ctx) - resetAt >= 0.04
    const pd = done("p"), td = done("t")
    if (m === 1 && pd) r[0x08] &= ~7 // command mode returns to idle
    if (m === 2 && td) r[0x08] &= ~7
    return (coef ? 0x80 : 0) | (sensor ? 0x40 : 0) | (td > readT ? 0x20 : 0) | (pd > readP ? 0x10 : 0) | (r[0x08] & 0x0f)
  }
  const raw = () => {
    const kT = OS_SCALE[r[0x07] & 7], kP = OS_SCALE[r[0x06] & 7]
    const traw = clamp(Math.round(((ctx.ctl("t") - c.c0 / 2) / c.c1) * kT), -8388608, 8388607)
    const praw = clamp(Math.round(invertPressure(c, ctx.ctl("p") * 100, traw / kT) * kP), -8388608, 8388607)
    for (const [reg, v] of [[0x00, praw], [0x03, traw]]) { r[reg] = (v >> 16) & 0xff; r[reg + 1] = (v >> 8) & 0xff; r[reg + 2] = v & 0xff }
  }
  g.wr = (reg, v) => {
    if (reg === 0x0c && (v & 0x0f) === 0x09) { defaults(); return }
    if (reg === 0x08) { r[0x08] = v & 0x0f; startAt = secs(ctx); readP = 0; readT = 0 }
  }
  g.onRead = (reg) => {
    if (reg <= 0x05) {
      raw()
      if (reg <= 0x02) readP = done("p")
      if (reg + 3 >= 0x03 && reg <= 0x05) readT = done("t")
    }
    if (reg <= 0x0a && reg + 8 >= 0x08) {
      r[0x08] = meas()
      r[0x0a] = (r[0x08] & 0x20 ? 2 : 0) | (r[0x08] & 0x10 ? 1 : 0)
    }
  }
  return { devices: [[addr, g]] }
}

// ── HopeRF HP206C ─────────────────────────────────────────────────────────────────────────
export const hpAltitude = (pa: number) => 44330 * (1 - Math.pow(pa / 101325, 0.190295))
function hp206c(ctx: SimCtx, addr: number): Chip {
  const regs = new Uint8Array(0x40)
  const defaults = () => { regs.fill(0); regs[0x0f] = 0x80; regs[0x0d] = 0x40 }
  defaults()
  let tw = 0, pw = 0, aw = 0
  let got: number[] = []
  let out: number[] = []
  const w24 = (v: number) => [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]
  const dev: I2CDevice = {
    start() { got = [] },
    write(b) {
      got.push(b)
      const cmd = got[0]
      if (got.length === 1) {
        if (cmd === 0x06) { defaults(); tw = pw = aw = 0; out = [] }
        else if ((cmd & 0xe0) === 0x40) {
          // ADC_CVT: the conversion latches the sliders (channel 00 = P & T, 10 = T only)
          const t = ctx.ctl("t"), pa = ctx.ctl("p") * 100
          tw = Math.round(t * 100) & 0xffffff
          if ((cmd & 3) === 0) {
            pw = clamp(Math.round(pa), 0, 0xfffff)
            const off = i16(regs[0x00] | (regs[0x01] << 8))
            aw = (Math.round(hpAltitude(pa) * 100) + off) & 0xffffff
            regs[0x0d] |= 0x30
          } else regs[0x0d] |= 0x10
        }
        else if (cmd === 0x10) out = [...w24(tw), ...w24(pw)]
        else if (cmd === 0x11) out = [...w24(tw), ...w24(aw)]
        else if (cmd === 0x30) out = w24(pw)
        else if (cmd === 0x31) out = w24(aw)
        else if (cmd === 0x32) out = w24(tw)
        else if ((cmd & 0xc0) === 0x80) { const reg = cmd & 0x3f; out = [regs[reg]]; if (reg === 0x0d) regs[0x0d] &= 0x40 }
      } else if ((cmd & 0xc0) === 0xc0 && got.length === 2) regs[cmd & 0x3f] = b
    },
    read() { return out.length ? out.shift()! : 0 },
  }
  return { devices: [[addr, dev]] }
}

// ── ams AS3935 lightning sensor (a proto device: clicks strike) ───────────────────────────
/** the distance estimation register for a storm front `km` away */
export function as3935Distance(km: number): number {
  if (km > 40) return 0x3f
  if (km < 5) return 0x01
  const steps = [5, 6, 8, 10, 12, 14, 17, 20, 24, 27, 31, 34, 37, 40]
  return steps.filter((s) => s <= km).pop()!
}
function as3935(ctx: SimCtx): CatDevice {
  const addr = Number(ctx.attrs.i2cAddress ?? 0x03)
  const g = new RegFile(), r = g.r
  let count = 0, irq = false
  const defaults = () => { r.fill(0); r[0x00] = 0x24; r[0x01] = 0x22; r[0x02] = 0xc2; r[0x03] = 0x00; r[0x07] = 0x3f; count = 0 }
  defaults()
  const setIrq = (on: boolean) => {
    if (on === irq) return
    irq = on
    ctx.drive("IRQ", { v: on ? ctx.vcc : 0, r: 100 })
  }
  const live = () => ctx.supply("VCC") > 0 && (r[0x00] & 1) === 0
  const raise = (bits: number) => { r[0x03] = (r[0x03] & 0xf0) | bits; setIrq(true) }
  const strike = () => {
    if (!live()) return
    count++
    const need = [1, 5, 9, 16][(r[0x02] >> 4) & 3]
    if (count < need) return
    const e = clamp(Math.round(ctx.ctl("energy")), 0, 0x1fffff)
    r[0x04] = e & 0xff; r[0x05] = (e >> 8) & 0xff; r[0x06] = (e >> 16) & 0x1f
    r[0x07] = as3935Distance(ctx.ctl("dist"))
    raise(0x08)
  }
  const disturber = () => { if (live() && !(r[0x03] & 0x20)) raise(0x04) }
  g.wr = (reg, v) => {
    if (reg === 0x3c && v === 0x96) { defaults(); setIrq(false); return }
    if (reg === 0x3d && v === 0x96) { r[0x3a] = 0x80; r[0x3b] = 0x80; r[0x3d] = 0; return }
    if (reg === 0x02 && v & 0x40 && !(prev02 & 0x40)) count = 0 // CL_STAT high-low-high clears the statistics
    if (reg === 0x02) prev02 = v
    if (reg === 0x03) r[0x03] = (v & 0xf0) | (int03 & 0x0f) // INT bits are read-only
    if (reg === 0x00 && v & 1) setIrq(false)
  }
  let prev02 = r[0x02], int03 = 0
  g.onStart = () => { int03 = r[0x03] }
  g.rd = (reg) => {
    if (reg !== 0x03) return undefined
    const v = r[0x03]
    r[0x03] &= 0xf0; int03 = 0; setIrq(false) // reading the interrupt register clears it
    return v
  }
  ctx.i2c(addr, g)
  ctx.drive("IRQ", { v: 0, r: 100 })
  // strikes / disturbers at the slider rates, and noise above the floor (INT_NH, repeated while it lasts)
  let accS = 0, accD = 0, noisy = false
  const tick = () => {
    accS += Math.max(0, ctx.ctl("rate")) / 600; accD += Math.max(0, ctx.ctl("drate")) / 600
    while (accS >= 1) { accS -= 1; strike() }
    while (accD >= 1) { accD -= 1; disturber() }
    const floor = (r[0x00] & 0x3e) === 0x1c ? [390, 630, 860, 1100, 1140, 1570, 1800, 2000] : [28, 45, 62, 78, 95, 112, 130, 146]
    const n = ctx.ctl("noise") > floor[(r[0x01] >> 4) & 7]
    if (n && live() && !noisy) raise(0x01)
    noisy = n
    ctx.after(0.1, tick)
  }
  ctx.after(0.1, tick)
  return {
    kind: "as3935",
    ui(u) { if (u.active) strike(); if (u.pressed) disturber() },
    view: () => ({ glow: [irq ? 1 : 0], text: r[0x07] === 0x3f ? "out of range" : `${r[0x07]} km` }),
  }
}

const group: ModelGroup = {
  proto: { as3935: (_c, ctx) => as3935(ctx) },
  chips: {
    bma456: (ctx, addr) => bma456(ctx, addr),
    bmm150: (ctx, addr) => bmm150(ctx, addr),
    adxl372: (ctx, addr) => adxl372(ctx, addr),
    bmi088: (ctx, addr) => bmi088(ctx, addr),
    dps310: (ctx, addr) => dpsFamily(ctx, addr, false),
    spa06: (ctx, addr) => dpsFamily(ctx, addr, true),
    hp206c: (ctx, addr) => hp206c(ctx, addr),
  },
}
export default group
