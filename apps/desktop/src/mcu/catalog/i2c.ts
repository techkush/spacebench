// I²C chips, modelled at the register / command level from their datasheets so that the usual
// Arduino libraries talk to them unchanged. Values come from the part's live controls.
import { HD44780, SSD1306, type I2CDevice } from "../devices"
import type { ModView } from "./look"
import type { SimCtx } from "./devices"
import { CHIPS } from "./models"

export interface Chip {
  devices: [number, I2CDevice][]
  view?(): ModView | undefined
  /** drive analog/digital outputs from the chip state (AS5600 OUT …) */
  drives?(): void
  lcd?: HD44780
  oled?: SSD1306
}

// ── helpers ────────────────────────────────────────────────────────────────────────────────
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))
const s16 = (v: number) => clamp(Math.round(v), -32768, 32767) & 0xffff
const bcd = (n: number) => ((Math.floor(n / 10) % 10) << 4) | n % 10
const unbcd = (b: number) => (b >> 4) * 10 + (b & 15)

/** a register file: the first byte written after START is the pointer, then data auto-increments */
export class Regs implements I2CDevice {
  readonly r = new Uint8Array(256)
  ptr = 0
  private fresh = true
  inc = true
  onWrite?: (reg: number, v: number) => void
  /** computed registers */
  get?: (reg: number) => number | undefined
  /** called on a read transaction's first byte (refresh the data) */
  onRead?: (reg: number) => void
  private reading = false
  start() { this.fresh = true; this.reading = false }
  write(b: number) {
    if (this.fresh) { this.ptr = b; this.fresh = false; return }
    this.r[this.ptr] = b
    this.onWrite?.(this.ptr, b)
    if (this.inc) this.ptr = (this.ptr + 1) & 0xff
  }
  read() {
    if (!this.reading) { this.reading = true; this.onRead?.(this.ptr) }
    const v = this.get?.(this.ptr) ?? this.r[this.ptr]
    if (this.inc) this.ptr = (this.ptr + 1) & 0xff
    return v & 0xff
  }
  /** 16-bit big-endian / little-endian register helpers */
  be(reg: number, v: number) { this.r[reg] = (v >> 8) & 0xff; this.r[reg + 1] = v & 0xff }
  le(reg: number, v: number) { this.r[reg] = v & 0xff; this.r[reg + 1] = (v >> 8) & 0xff }
}

/** 16-bit registers: the pointer selects a register, reads/writes are its high then low byte */
export class Reg16 implements I2CDevice {
  readonly r = new Uint16Array(256)
  ptr = 0
  private n = 0
  onRead?: (reg: number) => void
  start() { this.n = 0 }
  write(b: number) {
    if (this.n === 0) this.ptr = b
    else if (this.n % 2 === 1) this.r[this.ptr] = (b << 8) | (this.r[this.ptr] & 0xff)
    else this.r[this.ptr] = (this.r[this.ptr] & 0xff00) | b
    this.n++
  }
  read() { if (this.n % 2 === 0) this.onRead?.(this.ptr); const v = this.r[this.ptr]; return this.n++ % 2 === 0 ? v >> 8 : v & 0xff }
}

/** Sensirion style: 16-bit commands, replies are 16-bit words each followed by a CRC-8 */
const crcS = (a: number, b: number) => { let c = 0xff; for (const x of [a, b]) { c ^= x; for (let i = 0; i < 8; i++) c = c & 0x80 ? ((c << 1) ^ 0x31) & 0xff : (c << 1) & 0xff } return c }
const words = (ws: number[]) => ws.flatMap((w) => { const h = (w >> 8) & 0xff, l = w & 0xff; return [h, l, crcS(h, l)] })
export class Cmd16 implements I2CDevice {
  private got: number[] = []
  private out: number[] = []
  private reply: (cmd: number, args: number[]) => number[] | undefined
  constructor(reply: (cmd: number, args: number[]) => number[] | undefined) { this.reply = reply }
  start() { this.got = [] }
  write(b: number) {
    this.got.push(b)
    if (this.got.length === 2 || this.got.length === 5) { const r = this.reply((this.got[0] << 8) | this.got[1], this.got.slice(2)); if (r) this.out = r }
  }
  read() { return this.out.length ? this.out.shift()! : 0xff }
}
/** one-byte command, then a fixed reply */
export class Cmd8 implements I2CDevice {
  private got: number[] = []
  private out: number[] = []
  private reply: (cmd: number[]) => number[] | undefined
  constructor(reply: (cmd: number[]) => number[] | undefined) { this.reply = reply }
  start() { this.got = [] }
  write(b: number) { this.got.push(b); const r = this.reply(this.got); if (r) this.out = r }
  read() { if (!this.out.length) { const r = this.reply([]); if (r) this.out = r } return this.out.length ? this.out.shift()! : 0 }
}

/** the smallest integer in [lo, hi] whose f is ≥ target (f increasing) */
function search(f: (x: number) => number, target: number, lo: number, hi: number, dec = false): number {
  for (let k = 0; k < 40 && lo < hi; k++) {
    const mid = Math.floor((lo + hi) / 2)
    if (dec ? f(mid) > target : f(mid) < target) lo = mid + 1; else hi = mid
  }
  return lo
}

// ── Bosch BMP280 / BME280 (datasheet compensation, inverted by search) ─────────────────────
const BT = { T1: 27504, T2: 26435, T3: -1000, P1: 36477, P2: -10685, P3: 3024, P4: 2855, P5: 140, P6: -7, P7: 15500, P8: -14600, P9: 6000, H1: 75, H2: 370, H3: 0, H4: 313, H5: 50, H6: 30 }
function bmeTemp(adc: number) { const v1 = (adc / 16384 - BT.T1 / 1024) * BT.T2; const v2 = (adc / 131072 - BT.T1 / 8192) ** 2 * BT.T3; return { tf: v1 + v2, t: (v1 + v2) / 5120 } }
function bmePress(adc: number, tf: number) {
  let v1 = tf / 2 - 64000, v2 = (v1 * v1 * BT.P6) / 32768
  v2 += v1 * BT.P5 * 2; v2 = v2 / 4 + BT.P4 * 65536
  v1 = ((BT.P3 * v1 * v1) / 524288 + BT.P2 * v1) / 524288; v1 = (1 + v1 / 32768) * BT.P1
  let p = 1048576 - adc; p = ((p - v2 / 4096) * 6250) / v1
  return p + ((BT.P9 * p * p) / 2147483648 + (p * BT.P8) / 32768 + BT.P7) / 16
}
function bmeHum(adc: number, tf: number) {
  let h = tf - 76800
  h = (adc - (BT.H4 * 64 + (BT.H5 / 16384) * h)) * ((BT.H2 / 65536) * (1 + (BT.H6 / 67108864) * h * (1 + (BT.H3 / 67108864) * h)))
  return clamp(h * (1 - (BT.H1 * h) / 524288), 0, 100)
}
function bme280(ctx: SimCtx, addr: number, hum: boolean): Chip {
  const g = new Regs()
  const r = g.r
  r[0xd0] = hum ? 0x60 : 0x58
  const cal = [BT.T1, BT.T2, BT.T3, BT.P1, BT.P2, BT.P3, BT.P4, BT.P5, BT.P6, BT.P7, BT.P8, BT.P9]
  cal.forEach((v, i) => g.le(0x88 + i * 2, v & 0xffff))
  if (hum) {
    r[0xa1] = BT.H1; g.le(0xe1, BT.H2); r[0xe3] = BT.H3
    r[0xe4] = BT.H4 >> 4; r[0xe5] = (BT.H4 & 0xf) | ((BT.H5 & 0xf) << 4); r[0xe6] = BT.H5 >> 4; r[0xe7] = BT.H6
  }
  g.onWrite = (reg, v) => { if (reg === 0xe0 && v === 0xb6) r[0xf3] = 0 }
  g.onRead = (reg) => {
    if (reg > 0xf7 || reg + 8 < 0xf7) return
    const at = search((a) => bmeTemp(a).t, ctx.ctl("t"), 0, 0xfffff)
    const tf = bmeTemp(at).tf
    const ap = search((a) => bmePress(a, tf), ctx.ctl("p") * 100, 0, 0xfffff, true)
    r[0xf7] = ap >> 12; r[0xf8] = (ap >> 4) & 0xff; r[0xf9] = (ap & 0xf) << 4
    r[0xfa] = at >> 12; r[0xfb] = (at >> 4) & 0xff; r[0xfc] = (at & 0xf) << 4
    if (hum) g.be(0xfd, search((a) => bmeHum(a, tf), ctx.ctl("h"), 0, 0xffff))
  }
  return { devices: [[addr, g]] }
}

// ── Bosch BME680 / BME688 (variant 1: the BME688 gas formula) ──────────────────────────────
const B6 = { T1: 27504, T2: 26435, T3: -62, P1: 36477, P2: -10685, P3: 94, P4: 2855, P5: 140, P6: -28, P7: 121, P8: -14600, P9: 6000, P10: 30, H1: 676, H2: 1029, H3: 0, H4: 45, H5: 20, H6: 120, H7: -100 }
function b6Temp(adc: number) { const v1 = (adc / 16384 - B6.T1 / 1024) * B6.T2; const v2 = (adc / 131072 - B6.T1 / 8192) ** 2 * (B6.T3 * 16); return { tf: v1 + v2, t: (v1 + v2) / 5120 } }
function b6Press(adc: number, tf: number) {
  let v1 = tf / 2 - 64000, v2 = v1 * v1 * (B6.P6 / 131072)
  v2 += v1 * B6.P5 * 2; v2 = v2 / 4 + B6.P4 * 65536
  v1 = ((B6.P3 * v1 * v1) / 16384 + B6.P2 * v1) / 524288; v1 = (1 + v1 / 32768) * B6.P1
  let p = 1048576 - adc; p = ((p - v2 / 4096) * 6250) / v1
  const a = (B6.P9 * p * p) / 2147483648, b = p * (B6.P8 / 32768), c = (p / 256) ** 3 * (B6.P10 / 131072)
  return p + (a + b + c + B6.P7 * 128) / 16
}
function b6Hum(adc: number, tf: number) {
  const tc = tf / 5120
  const v1 = adc - (B6.H1 * 16 + (B6.H3 / 2) * tc)
  const v2 = v1 * ((B6.H2 / 262144) * (1 + (B6.H4 / 16384) * tc + (B6.H5 / 1048576) * tc * tc))
  return clamp(v2 + (B6.H6 / 16384 + (B6.H7 / 2097152) * tc) * v2 * v2, 0, 100)
}
function bme680(ctx: SimCtx, addr: number): Chip {
  const g = new Regs()
  const r = g.r
  r[0xd0] = 0x61; r[0xf0] = 0x01
  g.le(0x8a, B6.T2); r[0x8c] = B6.T3 & 0xff; g.le(0x8e, B6.P1); g.le(0x90, B6.P2 & 0xffff); r[0x92] = B6.P3; g.le(0x94, B6.P4); g.le(0x96, B6.P5)
  r[0x98] = B6.P7; r[0x99] = B6.P6 & 0xff; g.le(0x9c, B6.P8 & 0xffff); g.le(0x9e, B6.P9); r[0xa0] = B6.P10
  r[0xe1] = B6.H2 >> 4; r[0xe2] = ((B6.H2 & 0xf) << 4) | (B6.H1 & 0xf); r[0xe3] = B6.H1 >> 4
  r[0xe4] = B6.H3; r[0xe5] = B6.H4; r[0xe6] = B6.H5; r[0xe7] = B6.H6; r[0xe8] = B6.H7 & 0xff; g.le(0xe9, B6.T1)
  g.onWrite = (reg, v) => { if (reg === 0xe0 && v === 0xb6) r[0x74] = 0 }
  g.get = (reg) => (reg === 0x74 ? r[0x74] & 0xfc : undefined) // forced mode returns to sleep
  g.onRead = (reg) => {
    if (reg > 0x2d || reg < 0x1d) return
    const at = search((a) => b6Temp(a).t, ctx.ctl("t"), 0, 0xfffff)
    const tf = b6Temp(at).tf
    const ap = search((a) => b6Press(a, tf), ctx.ctl("p") * 100, 0, 0xfffff, true)
    const ah = search((a) => b6Hum(a, tf), ctx.ctl("h"), 0, 0xffff)
    r[0x1d] = 0x80
    r[0x1f] = ap >> 12; r[0x20] = (ap >> 4) & 0xff; r[0x21] = (ap & 0xf) << 4
    r[0x22] = at >> 12; r[0x23] = (at >> 4) & 0xff; r[0x24] = (at & 0xf) << 4
    g.be(0x25, ah)
    // BME688 gas: R = 1e6·(262144 >> range) / (4096 + 3·(adc − 512)) — pick a range that fits 10 bits
    const res = Math.max(1, ctx.ctl("gas") * 1000)
    let range = 0, adc = 0
    for (range = 0; range < 16; range++) { adc = Math.round(((1e6 * (262144 >> range)) / res - 4096) / 3 + 512); if (adc <= 1023) break }
    adc = clamp(adc, 0, 1023)
    for (const base of [0x2a, 0x2c]) { r[base] = adc >> 2; r[base + 1] = ((adc & 3) << 6) | 0x30 | (range & 0xf) }
  }
  return { devices: [[addr, g]] }
}

// ── motion ────────────────────────────────────────────────────────────────────────────────
function mpu(ctx: SimCtx, who: number, tempScale: number, tempOff: number): I2CDevice {
  const g = new Regs()
  const r = g.r
  r[0x75] = who; r[0x6b] = 0x40
  g.onWrite = (reg, v) => { if (reg === 0x6b && v & 0x80) r[0x6b] = 0x40 | (v & 0x3f) & ~0x80 }
  g.onRead = (reg) => {
    if (reg < 0x3b || reg > 0x48) return
    const a = 16384 >> ((r[0x1c] >> 3) & 3), gy = 131 / (1 << ((r[0x1b] >> 3) & 3))
    ;["ax", "ay", "az"].forEach((k, i) => g.be(0x3b + i * 2, s16(ctx.ctl(k) * a)))
    g.be(0x41, s16((ctx.ctl("t") - tempOff) * tempScale))
    ;["gx", "gy", "gz"].forEach((k, i) => g.be(0x43 + i * 2, s16(ctx.ctl(k) * gy)))
  }
  return g
}
function accel(ctx: SimCtx, setup: (g: Regs) => void, data: number, lsbPerG: (g: Regs) => number, opts: { le?: boolean; shift?: number; bits?: number; autoBit?: number } = {}): I2CDevice {
  const g = new Regs()
  setup(g)
  const origWrite = g.write.bind(g)
  if (opts.autoBit) g.write = (b: number) => { origWrite(b) ; if (g.ptr & opts.autoBit!) g.ptr &= ~opts.autoBit! }
  g.onRead = (reg) => {
    if (reg < data || reg > data + 5) return
    const k = lsbPerG(g)
    ;["ax", "ay", "az"].forEach((key, i) => {
      let v = Math.round(ctx.ctl(key) * k)
      if (opts.bits) v = clamp(v, -(1 << (opts.bits - 1)), (1 << (opts.bits - 1)) - 1) & ((1 << opts.bits) - 1)
      v = (v << (opts.shift ?? 0)) & 0xffff
      if (opts.le === false) g.be(data + i * 2, v); else g.le(data + i * 2, v)
    })
  }
  return g
}

// ── clocks ────────────────────────────────────────────────────────────────────────────────
function rtc(ctx: SimCtx, kind: "ds1307" | "ds3231" | "pcf85063"): I2CDevice {
  const g = new Regs()
  const base = kind === "pcf85063" ? 4 : 0
  let offset = Date.now() / 1000 - new Date().getTimezoneOffset() * 60
  const t0 = ctx.now() / ctx.hz
  const now = () => offset + (ctx.now() / ctx.hz - t0)
  const pending: number[] = []
  g.onRead = (reg) => {
    if (reg > base + 6) { if (kind === "ds3231") { const t = ctx.ctl("t"); g.r[0x11] = Math.floor(t) & 0xff; g.r[0x12] = Math.round((t % 1) * 4) << 6 } return }
    const d = new Date(now() * 1000)
    const v = [bcd(d.getUTCSeconds()), bcd(d.getUTCMinutes()), bcd(d.getUTCHours()), kind === "pcf85063" ? bcd(d.getUTCDate()) : d.getUTCDay() + 1, kind === "pcf85063" ? d.getUTCDay() : bcd(d.getUTCDate()), bcd(d.getUTCMonth() + 1), bcd(d.getUTCFullYear() % 100)]
    v.forEach((x, i) => (g.r[base + i] = x))
  }
  g.onWrite = (reg, v) => {
    if (reg < base || reg > base + 6) return
    pending[reg - base] = v
    if (reg === base + 6) {
      const p = pending.map((x) => x ?? 0)
      const s = unbcd(p[0] & 0x7f), mi = unbcd(p[1]), h = unbcd(p[2] & 0x3f)
      const day = kind === "pcf85063" ? unbcd(p[3]) : unbcd(p[4]), mo = unbcd(p[5] & 0x1f), y = 2000 + unbcd(p[6])
      offset = Date.UTC(y, mo - 1, day, h, mi, s) / 1000 - (ctx.now() / ctx.hz - t0)
    }
  }
  if (kind === "ds3231") g.r[0x0f] = 0x00
  return g
}

// ── displays ──────────────────────────────────────────────────────────────────────────────
class Ht16k33 implements I2CDevice {
  readonly ram = new Uint8Array(16)
  on = false
  private ptr = -1
  start() { this.ptr = -1 }
  write(b: number) {
    if (this.ptr < 0) {
      if ((b & 0xf0) === 0x00) this.ptr = b & 0x0f
      else if ((b & 0xf0) === 0x80) this.on = !!(b & 1)
      return
    }
    this.ram[this.ptr & 15] = b; this.ptr++
  }
}
class Sh1107 implements I2CDevice {
  readonly ram = new Uint8Array(128 * 16)
  private ctrl = -1; private page = 0; private col = 0; private need = 0
  on = false
  version = 0
  start() { this.ctrl = -1 }
  write(b: number) {
    if (this.ctrl < 0) { this.ctrl = b; return }
    if (this.ctrl & 0x40) { this.ram[this.page * 128 + (this.col & 127)] = b; this.col++; this.version++; return }
    if (this.need) { this.need--; return }
    if (b >= 0xb0 && b <= 0xbf) this.page = b & 15
    else if (b <= 0x0f) this.col = (this.col & 0xf0) | b
    else if (b >= 0x10 && b <= 0x17) this.col = ((b & 7) << 4) | (this.col & 0x0f)
    else if (b === 0xaf) { this.on = true; this.version++ } else if (b === 0xae) { this.on = false; this.version++ }
    else if ([0x81, 0xa8, 0xd3, 0xd5, 0xd9, 0xdb, 0xdc, 0xad].includes(b)) this.need = 1
  }
  bitmap(): { w: number; h: number; data: Uint8Array } {
    const data = new Uint8Array(128 * 16)
    if (this.on) for (let p = 0; p < 16; p++) for (let x = 0; x < 128; x++) { const v = this.ram[p * 128 + x]; for (let k = 0; k < 8; k++) if (v & (1 << k)) { const y = p * 8 + k; data[y * 16 + (x >> 3)] |= 0x80 >> (x & 7) } }
    return { w: 128, h: 128, data }
  }
}
/** AiP31068 (Grove 16×2): control byte 0x80/0x00 = command, 0x40 = data */
function groveLcd(ctx: SimCtx, rgb: boolean): Chip {
  const lcd = new HD44780(16, 2)
  lcd.backlight = true
  let ctrl = -1
  const dev: I2CDevice = {
    start() { ctrl = -1 },
    write(b) { if (ctrl < 0) { ctrl = b; return } lcd.write(!!(ctrl & 0x40), b); if (ctrl & 0x80) ctrl = -1 },
  }
  const col: [number, number, number] = [255, 255, 255]
  const led = new Regs()
  led.onWrite = (reg, v) => { const i = { 4: 0, 3: 1, 2: 2, 6: 0, 7: 1, 8: 2 }[reg]; if (i !== undefined) col[i] = v }
  void ctx
  return { devices: rgb ? [[0x3e, dev], [0x62, led], [0x30, led]] : [[0x3e, dev]], lcd, view: () => (rgb ? { backlight: [...col] as [number, number, number] } : undefined) }
}

// ── the chips ─────────────────────────────────────────────────────────────────────────────
export function makeChip(chip: string, addr: number, ctx: SimCtx): Chip | null {
  const T = () => ctx.ctl("t"), H = () => ctx.ctl("h")
  switch (chip) {
    case "bme280": return bme280(ctx, addr, true)
    case "bmp280": return bme280(ctx, addr, false)
    case "bme680": return bme680(ctx, addr)
    case "mpu6050": return { devices: [[addr, mpu(ctx, 0x68, 340, 36.53)]] }
    case "mpu9250": return { devices: [[addr, mpu(ctx, 0x71, 333.87, 21)]] }
    case "icm20600": return { devices: [[addr, mpu(ctx, 0x11, 326.8, 25)]] }
    case "mpu9250+bmp280": return { devices: [[addr, mpu(ctx, 0x71, 333.87, 21)], ...bme280(ctx, 0x77, false).devices] }
    case "adxl345": return { devices: [[addr, accel(ctx, (g) => { g.r[0] = 0xe5; g.r[0x31] = 0x08 }, 0x32, (g) => (g.r[0x31] & 8 ? 256 : 256 >> (g.r[0x31] & 3)))]] }
    case "lis3dh": return { devices: [[addr, accel(ctx, (g) => { g.r[0x0f] = 0x33 }, 0x28, (g) => [16380, 8190, 4096, 1365][(g.r[0x23] >> 4) & 3], { autoBit: 0x80 })]] }
    case "mma7660": {
      const g = new Regs()
      g.onRead = () => ["ax", "ay", "az"].forEach((k, i) => (g.r[i] = clamp(Math.round(ctx.ctl(k) * 21.33), -32, 31) & 0x3f))
      return { devices: [[addr, g]] }
    }
    case "bma400": return { devices: [[addr, accel(ctx, (g) => { g.r[0] = 0x90 }, 0x04, (g) => 1024 >> ((g.r[0x1a] >> 6) & 3), { bits: 12 })]] }
    case "lsm6ds3": {
      const g = new Regs()
      g.r[0x0f] = 0x69
      g.onRead = (reg) => {
        if (reg < 0x20 || reg > 0x2d) return
        const ga = [0.061, 0.488, 0.122, 0.244][(g.r[0x10] >> 2) & 3] / 1000, gg = [8.75, 70, 17.5, 35][(g.r[0x11] >> 2) & 3] / 1000
        g.le(0x20, s16((T() - 25) * 16))
        ;["gx", "gy", "gz"].forEach((k, i) => g.le(0x22 + i * 2, s16(ctx.ctl(k) / gg)))
        ;["ax", "ay", "az"].forEach((k, i) => g.le(0x28 + i * 2, s16(ctx.ctl(k) / ga)))
      }
      return { devices: [[addr, g]] }
    }
    case "as5600": {
      const g = new Regs()
      g.onRead = () => { const raw = Math.round((((ctx.ctl("deg") % 360) + 360) % 360) / 360 * 4096) & 0xfff; g.be(0x0c, raw); g.be(0x0e, raw); g.r[0x0b] = 0x20; g.r[0x1a] = 0x80; g.be(0x1b, 1800) }
      return { devices: [[addr, g]], drives: () => ctx.set("OUT", { v: (ctx.ctl("deg") / 360) * ctx.vcc, r: 100 }) }
    }
    case "sht3x": return { devices: [[addr, new Cmd16((cmd) => {
      if (cmd === 0xf32d) return words([0x8010])
      if (cmd === 0x2400 || cmd === 0x2c06 || cmd === 0x2c0d || cmd === 0x2c10 || cmd === 0x240b || cmd === 0x2416 || cmd === 0xe000) return words([Math.round(((clamp(T(), -45, 130) + 45) / 175) * 65535), Math.round((clamp(H(), 0, 100) / 100) * 65535)])
      if (cmd === 0x3780) return words([0x1234, 0x5678])
      return undefined
    })]] }
    case "sht4x": return { devices: [[addr, new Cmd8((c) => {
      if (c.length !== 1) return undefined
      if (c[0] === 0x89) return words([0x0123, 0x4567])
      if ([0xfd, 0xf6, 0xe0, 0x39, 0x32, 0x2f, 0x24, 0x1e, 0x15].includes(c[0])) return words([Math.round(((clamp(T(), -45, 130) + 45) / 175) * 65535), Math.round(((clamp(H(), 0, 100) + 6) / 125) * 65535)])
      return undefined
    })]] }
    case "aht20": case "th02": {
      if (chip === "th02") {
        const g = new Regs()
        g.r[0x11] = 0x50
        g.onWrite = (reg, v) => { if (reg === 0x03 && v & 1) { if (v & 0x10) g.be(0x01, (Math.round((T() + 50) * 32) & 0x3fff) << 2); else g.be(0x01, (Math.round((H() + 24) * 16) & 0xfff) << 4) } }
        return { devices: [[addr, g]] }
      }
      let out: number[] = [0x18]
      let idx = 0
      const dev: I2CDevice = {
        start() { idx = 0 },
        write(b) {
          if (b === 0xac) {
            const h = Math.round((clamp(H(), 0, 100) / 100) * 0x100000) & 0xfffff, t = Math.round(((clamp(T(), -50, 150) + 50) / 200) * 0x100000) & 0xfffff
            const d = [0x1c, h >> 12, (h >> 4) & 0xff, ((h & 0xf) << 4) | (t >> 16), (t >> 8) & 0xff, t & 0xff]
            let c = 0xff
            for (const x of d) { c ^= x; for (let i = 0; i < 8; i++) c = c & 0x80 ? ((c << 1) ^ 0x31) & 0xff : (c << 1) & 0xff }
            out = [...d, c]
          } else if (b === 0x71) out = [0x1c]
        },
        read() { return out[idx++] ?? 0x1c },
      }
      return { devices: [[addr, dev]] }
    }
    case "scd4x": {
      let ready = false
      return { devices: [[addr, new Cmd16((cmd) => {
        if (cmd === 0x21b1 || cmd === 0x219d) { ready = true; return [] }
        if (cmd === 0xe4b8) return words([ready ? 0x8006 : 0x8000])
        if (cmd === 0xec05) return words([Math.round(ctx.ctl("co2")), Math.round(((T() + 45) / 175) * 65535), Math.round((H() / 100) * 65535)])
        if (cmd === 0x3682) return words([0x1234, 0x5678, 0x9abc])
        if (cmd === 0x2318) return words([0x0400]) // temperature offset
        if (cmd === 0x3639) return words([0x0000]) // self test passed
        return undefined
      })]] }
    }
    case "scd30": {
      const f32 = (x: number) => { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, x); return [b.getUint16(0), b.getUint16(2)] }
      return { devices: [[addr, new Cmd16((cmd) => {
        if (cmd === 0x0202) return words([1])
        if (cmd === 0x0300) return words([...f32(ctx.ctl("co2")), ...f32(T()), ...f32(H())])
        if (cmd === 0xd100) return words([0x0342])
        if (cmd === 0x4600 || cmd === 0x5306 || cmd === 0x5403 || cmd === 0x5204 || cmd === 0x5102) return words([2])
        return undefined
      })]] }
    }
    case "sgp30": return { devices: [[addr, new Cmd16((cmd) => {
      if (cmd === 0x3682) return words([0x0000, 0x0123, 0x4567])
      if (cmd === 0x202f) return words([0x0022])
      if (cmd === 0x2008) return words([Math.round(ctx.ctl("eco2")), Math.round(ctx.ctl("tvoc"))])
      if (cmd === 0x2050) return words([13000, 18000])
      if (cmd === 0x2015) return words([0x8a3e, 0x8f2b])
      if (cmd === 0x2032) return words([0xd400])
      return undefined
    })]] }
    case "sgp41": return { devices: [[addr, new Cmd16((cmd) => {
      if (cmd === 0x3682) return words([0x0000, 0x0123, 0x4567])
      if (cmd === 0x2612) return words([Math.round(ctx.ctl("voc"))])
      if (cmd === 0x2619) return words([Math.round(ctx.ctl("voc")), Math.round(ctx.ctl("nox"))])
      if (cmd === 0x280e) return words([0xd400])
      return undefined
    })]] }
    case "sfa30": return { devices: [[addr, new Cmd16((cmd) => {
      if (cmd === 0x0327) return words([s16(ctx.ctl("hcho") * 5), s16(H() * 100), s16(T() * 200)])
      if (cmd === 0xd060) return words(Array(16).fill(0x4142))
      return undefined
    })]] }
    case "sen5x": return { devices: [[addr, new Cmd16((cmd) => {
      if (cmd === 0x0202) return words([1])
      if (cmd === 0x03c4) { const pm = ctx.ctl("pm25") * 10; return words([Math.round(pm * 0.8), Math.round(pm), Math.round(pm * 1.1), Math.round(pm * 1.2), s16(H() * 100), s16(T() * 200), s16(ctx.ctl("voc") * 10), s16((ctx.ctl("nox") || 1) * 10)]) }
      if (cmd === 0xd014) return words([0x5345, 0x4e35, 0x3500, ...Array(13).fill(0)]) // "SEN55"
      if (cmd === 0xd033) return words([0x3132, 0x3334, ...Array(14).fill(0)])
      if (cmd === 0xd100) return words([0x0200])
      if (cmd === 0xd206) return words([0, 0])
      return undefined
    })]] }
    case "hm3301": return { devices: [[addr, new Cmd8(() => {
      const d = new Array(29).fill(0)
      const put = (i: number, v: number) => { d[i] = (v >> 8) & 0xff; d[i + 1] = v & 0xff }
      const [p1, p25, p10] = [ctx.ctl("pm1"), ctx.ctl("pm25"), ctx.ctl("pm10")].map(Math.round)
      put(4, p1); put(6, p25); put(8, p10); put(10, p1); put(12, p25); put(14, p10)
      d[28] = d.slice(0, 28).reduce((a, b) => a + b, 0) & 0xff
      return d
    })]] }
    case "gmxxx": {
      // write a channel command (0x01 NO₂, 0x03 ethanol, 0x05 VOC, 0x07 CO), read a 32-bit little-endian count
      const key: Record<number, string> = { 1: "no2", 3: "eth", 5: "voc", 7: "co" }
      let out: number[] = []
      return { devices: [[addr, { start() {}, write(b: number) { const v = key[b] ? Math.round(ctx.ctl(key[b])) : 0; out = [v & 0xff, (v >> 8) & 0xff, 0, 0] }, read: () => out.shift() ?? 0 } as I2CDevice]] }
    }
    case "d7s": {
      let ptr = 0, n = 0
      return { devices: [[addr, { start() { n = 0 }, write(b: number) { ptr = n++ === 0 ? b << 8 : ptr | b }, read() { const si = Math.round(ctx.ctl("si") * 1000), pga = Math.round(ctx.ctl("pga") * 1000); const v = ptr === 0x2000 || ptr === 0x2001 ? si : ptr === 0x2002 || ptr === 0x2003 ? pga : ptr === 0x1000 ? 0x0100 : 0; const b = ptr & 1 ? v & 0xff : (v >> 8) & 0xff; ptr++; return b } } as I2CDevice]] }
    }
    case "ads1115": {
      const regs = [0, 0x8583, 0x8000, 0x7fff]
      let ptr = 0, n = 0, hi = 0
      const fsr = [6.144, 4.096, 2.048, 1.024, 0.512, 0.256, 0.256, 0.256]
      const conv = () => {
        const mux = (regs[1] >> 12) & 7, pga = (regs[1] >> 9) & 7
        const v = (p: string) => ctx.volts(p)
        const d = mux >= 4 ? v(`A${mux - 4}`) : mux === 0 ? v("A0") - v("A1") : mux === 1 ? v("A0") - v("A3") : mux === 2 ? v("A1") - v("A3") : v("A2") - v("A3")
        regs[0] = s16(clamp((d / fsr[pga]) * 32768, -32768, 32767))
      }
      return { devices: [[addr, {
        start() { n = 0 },
        write(b: number) { if (n === 0) ptr = b & 3; else if (n === 1) hi = b; else { regs[ptr] = (hi << 8) | b; if (ptr === 1) conv() } n++ },
        read() { if (n === 0 && ptr === 0) conv(); const v = ptr === 1 ? regs[1] | 0x8000 : regs[ptr]; const out = n % 2 === 0 ? v >> 8 : v & 0xff; n++; return out },
      } as I2CDevice]] }
    }
    case "mcp9808": {
      const g = new Reg16()
      g.r[0x06] = 0x0054; g.r[0x07] = 0x0400; g.r[0x08] = 0x0300
      g.onRead = (reg) => { if (reg === 0x05) { const t = Math.round(T() * 16); g.r[0x05] = t < 0 ? 0x1000 | (t & 0xfff) : t & 0xfff } }
      return { devices: [[addr, g]] }
    }
    case "mcp9600": {
      const g = new Reg16()
      g.r[0x20] = 0x4014; g.r[0x04] = 0x4000
      g.onRead = (reg) => { if (reg <= 0x02) { g.r[0x00] = s16(T() * 16); g.r[0x01] = s16((T() - ctx.ctl("cold")) * 16); g.r[0x02] = s16(ctx.ctl("cold") * 16) } }
      return { devices: [[addr, g]] }
    }
    case "tsl2561": {
      const g = new Regs()
      const w = g.write.bind(g)
      g.write = (b: number) => { w(b); if (g.ptr & 0x80) g.ptr &= 0x0f }
      g.r[0x0a] = 0x50
      g.onRead = () => {
        const tint = [13.7, 101, 402][g.r[0x01] & 3] ?? 402, gain = g.r[0x01] & 0x10 ? 16 : 1
        const scale = (402 / tint) * (16 / gain)
        const ch0 = clamp(Math.round(ctx.ctl("lux") / (0.019 * scale)), 0, 65535)
        g.le(0x0c, ch0); g.le(0x0e, Math.round(ch0 * 0.3))
      }
      return { devices: [[addr, g]] }
    }
    case "veml6040": {
      let cmd = 0, n = 0
      const key: Record<number, string> = { 8: "r", 9: "g", 10: "b", 11: "w" }
      return { devices: [[addr, { start() { n = 0 }, write(b: number) { if (n++ === 0) cmd = b }, read() { const v = key[cmd] ? Math.round(ctx.ctl(key[cmd])) : 0; return n++ % 2 === 1 ? v & 0xff : v >> 8 } } as I2CDevice]] }
    }
    case "mlx90614": case "mlx90615": {
      const amb = chip === "mlx90614" ? 0x06 : 0x26, obj = chip === "mlx90614" ? 0x07 : 0x27
      let cmd = 0, n = 0
      const pec = (bytes: number[]) => { let c = 0; for (const x of bytes) { c ^= x; for (let i = 0; i < 8; i++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff } return c }
      return { devices: [[addr, {
        start() { n = 0 },
        write(b: number) { cmd = b; n = 0 },
        read() {
          const t = cmd === amb ? ctx.ctl("amb") : cmd === obj ? ctx.ctl("obj") : null
          const raw = t === null ? 0 : Math.round((t + 273.15) / 0.02)
          const out = [raw & 0xff, (raw >> 8) & 0xff]
          out.push(pec([addr << 1, cmd, (addr << 1) | 1, ...out]))
          return out[n++ % 3]
        },
      } as I2CDevice]] }
    }
    case "hr50": return { devices: [[addr, { start() {}, write() {}, read: () => Math.round(ctx.ctl("bpm")) & 0xff } as I2CDevice]] }
    case "ak9753": {
      const g = new Regs()
      g.r[0] = 0x48; g.r[1] = 0x13; g.r[4] = 0x01
      g.onRead = () => { for (let i = 0; i < 4; i++) g.le(0x05 + i * 2, s16(ctx.ctl("ir") * (1 - i * 0.1))) }
      return { devices: [[addr, g]] }
    }
    case "ldc1612": {
      let ptr = 0, n = 0
      const reg = (p: number) => { const d = Math.round((ctx.ctl("f") * 1e6 / 40e6) * 2 ** 28); return p === 0x7e ? 0x5449 : p === 0x7f ? 0x3055 : p === 0x00 ? (d >> 16) & 0x0fff : p === 0x01 ? d & 0xffff : 0 }
      return { devices: [[addr, { start() { n = 0 }, write(b: number) { if (n++ === 0) ptr = b }, read() { const v = reg(ptr); const out = n++ % 2 === 1 ? v >> 8 : v & 0xff; return out } } as I2CDevice]] }
    }
    case "vl53l0x": {
      // permissive: the Pololu library's init reads its way through; ranging answers at once
      const g = new Regs()
      g.r[0xc0] = 0xee; g.r[0xc1] = 0xaa; g.r[0xc2] = 0x10; g.r[0x83] = 0x01; g.r[0x92] = 0x83
      for (let i = 0; i < 6; i++) g.r[0xb0 + i] = 0xff
      g.get = (reg) => (reg === 0x13 ? 0x07 : reg === 0x00 ? 0x00 : reg === 0x14 ? 0x5e : undefined)
      g.onRead = () => g.be(0x1e, Math.round(ctx.ctl("mm")))
      return { devices: [[addr, g]] }
    }
    case "mpr121": {
      const g = new Regs()
      g.onWrite = (reg, v) => { if (reg === 0x80 && v === 0x63) g.r[0x5d] = 0x24 }
      g.r[0x5d] = 0x24
      g.onRead = () => { const k = Math.round(ctx.ctl("keys")) & 0xfff; g.le(0x00, k); for (let i = 0; i < 12; i++) { g.le(0x04 + i * 2, k & (1 << i) ? 100 : 200); g.r[0x1e + i] = 200 >> 2 } }
      return { devices: [[addr, g]] }
    }
    case "paj7620": {
      const g = new Regs()
      g.r[0x00] = 0x20; g.r[0x01] = 0x76
      const bits = [0, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80]
      let last = -1
      g.get = (reg) => {
        const gst = Math.round(ctx.ctl("g"))
        if (gst === last) return reg === 0x43 || reg === 0x44 ? 0 : undefined
        if (reg === 0x43) return gst >= 1 && gst <= 8 ? bits[gst] : 0
        if (reg === 0x44) { last = gst; return gst === 9 ? 0x01 : 0 }
        return undefined
      }
      return { devices: [[addr, g]] }
    }
    case "ds1307": return { devices: [[addr, rtc(ctx, "ds1307")]] }
    case "ds3231": return { devices: [[addr, rtc(ctx, "ds3231")]] }
    case "pcf85063": return { devices: [[addr, rtc(ctx, "pcf85063")]] }
    case "ht16k33": {
      const h = new Ht16k33()
      return { devices: [[addr, h]], view: () => ({ rows: ctx.attrs.layout?.startsWith("alnum") ? [0, 1, 2, 3].map((i) => (h.on ? h.ram[i * 2] | (h.ram[i * 2 + 1] << 8) : 0)) : [0, 1, 2, 3, 4, 5, 6, 7].map((r) => (h.on ? h.ram[r * 2] : 0)) }) }
    }
    case "sh1107": { const s = new Sh1107(); let ver = -1, bm: ModView | undefined; return { devices: [[addr, s]], view: () => { if (s.version !== ver) { ver = s.version; bm = { bitmap: s.bitmap() } } return bm } } }
    case "ssd1306": { const o = new SSD1306(); return { devices: [[addr, { start: () => o.start(), write: (b) => o.byte(b) }]], oled: o } }
    case "grovelcd": return groveLcd(ctx, false)
    case "grovelcd-rgb": return groveLcd(ctx, true)
    case "relay4": {
      // Seeed multi-channel relay: [0x10, bits] switches the channels
      let n = 0, cmd = 0
      return { devices: [[addr, { start() { n = 0 }, write(b: number) { if (n++ === 0) cmd = b; else if (cmd === 0x10) ctx.setState({ relays: b }) }, read: () => (cmd === 0x13 ? 0x01 : 0) } as I2CDevice]] }
    }
    case "pca9685": { const g = new Regs(); g.r[0] = 0x11; return { devices: [[addr, g]] } }
    case "tca9548a": { let m = 0; return { devices: [[addr, { start() {}, write(b: number) { m = b }, read: () => m } as I2CDevice]] } }
    case "eeprom": {
      const mem = new Uint8Array(8192)
      let n = 0, ptr = 0
      return { devices: [[addr, { start() { n = 0 }, write(b: number) { if (n === 0) ptr = b << 8; else if (n === 1) ptr |= b; else { mem[ptr & 8191] = b; ptr++ } n++ }, read() { return mem[ptr++ & 8191] } } as I2CDevice]] }
    }
    case "waterlevel": {
      const sections = () => Math.round(clamp(ctx.ctl("level"), 0, 100) / 5) // 20 pads of 5 mm
      const low: I2CDevice = { start() {}, write() {}, read: (() => { let i = 0; return () => { const v = i < sections() ? 200 : 0; i = (i + 1) % 8; return v } })() }
      const high: I2CDevice = { start() {}, write() {}, read: (() => { let i = 0; return () => { const v = i + 8 < sections() ? 200 : 0; i = (i + 1) % 12; return v } })() }
      return { devices: [[0x78, low], [0x77, high]] }
    }
    case "dip6": return { devices: [[addr, { start() {}, write() {}, read: () => Math.round(ctx.ctl("bits")) & 0x3f } as I2CDevice]] }
    case "sink": return { devices: [[addr, { start() {}, write() {}, read: () => 0 } as I2CDevice]] }
  }
  // the models in catalog/models/ (one file per family of parts)
  return CHIPS[chip]?.(ctx, addr) ?? null
}
