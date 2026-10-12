// Chips that talk a protocol to the microcontroller: the HD44780 LCD controller (parallel
// 4/8-bit, or behind a PCF8574 I²C backpack), the SSD1306 OLED (I²C), and the I²C bus that
// routes avr8js's TWI events to them by address.
import type { I2CController, I2CEvents } from "./machine"

// ── HD44780 ────────────────────────────────────────────────────────────────────────────────
export class HD44780 {
  /** DDRAM: 0x00–0x27 line 1, 0x40–0x67 line 2 (lines 3/4 of a 20×4 continue lines 1/2) */
  ddram = new Uint8Array(0x80).fill(0x20)
  cgram = new Uint8Array(64)
  addr = 0
  cgMode = false
  increment = true
  shiftDisplay = false
  displayOn = false
  cursor = false
  blink = false
  shift = 0
  fourBit = false
  private nibble: number | null = null
  backlight = true
  version = 0

  readonly cols: number
  readonly rows: number
  constructor(cols: number, rows: number) { this.cols = cols; this.rows = rows }

  /** A byte from the MCU: rs = data (true) or command (false). */
  write(rs: boolean, value: number) {
    this.version++
    if (rs) {
      if (this.cgMode) { this.cgram[this.addr & 0x3f] = value; this.addr = (this.addr + 1) & 0x3f }
      else { this.ddram[this.addr & 0x7f] = value; this.move(); if (this.shiftDisplay) this.shift += this.increment ? 1 : -1 }
      return
    }
    if (value & 0x80) { this.cgMode = false; this.addr = value & 0x7f }
    else if (value & 0x40) { this.cgMode = true; this.addr = value & 0x3f }
    else if (value & 0x20) { this.fourBit = !(value & 0x10) }
    else if (value & 0x10) { if (value & 0x08) this.shift += value & 0x04 ? 1 : -1; else this.addr = (this.addr + (value & 0x04 ? 1 : -1)) & 0x7f }
    else if (value & 0x08) { this.displayOn = !!(value & 4); this.cursor = !!(value & 2); this.blink = !!(value & 1) }
    else if (value & 0x04) { this.increment = !!(value & 2); this.shiftDisplay = !!(value & 1) }
    else if (value & 0x02) { this.addr = 0; this.shift = 0; this.cgMode = false }
    else if (value & 0x01) { this.ddram.fill(0x20); this.addr = 0; this.shift = 0; this.increment = true; this.cgMode = false }
  }
  private move() { this.addr = (this.addr + (this.increment ? 1 : -1)) & 0x7f }

  /** A 4-bit transfer (high nibble first once in 4-bit mode). */
  writeNibble(rs: boolean, nib: number) {
    if (!this.fourBit) { this.write(rs, nib << 4); return } // the init sequence sends 0x3/0x2 nibbles in 8-bit mode
    if (this.nibble === null) this.nibble = nib
    else { this.write(rs, (this.nibble << 4) | nib); this.nibble = null }
  }

  /** The characters on screen, row by row (rows × cols). */
  characters(): Uint8Array {
    const out = new Uint8Array(this.cols * this.rows).fill(0x20)
    if (!this.displayOn) return out
    const base = [0x00, 0x40, this.cols, 0x40 + this.cols]
    for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) {
      const a = base[r] + ((c + this.shift) % 40 + 40) % 40
      out[r * this.cols + c] = this.ddram[a & 0x7f]
    }
    return out
  }
  get cursorPos(): { x: number; y: number } {
    const a = this.addr
    const row = a >= 0x40 ? (a - 0x40 >= this.cols && this.rows > 2 ? 3 : 1) : a >= this.cols && this.rows > 2 ? 2 : 0
    const col = (a & 0x3f) - (row >= 2 ? this.cols : 0)
    return { x: col - this.shift, y: row }
  }
}

/** PCF8574 backpack wiring (LiquidCrystal_I2C): P0 RS, P1 RW, P2 E, P3 backlight, P4–P7 D4–D7. */
export class LcdI2C {
  private last = 0
  readonly lcd: HD44780
  constructor(lcd: HD44780) { this.lcd = lcd }
  write(v: number) {
    const fallingE = (this.last & 0x04) && !(v & 0x04)
    this.lcd.backlight = !!(v & 0x08)
    if (fallingE && !(v & 0x02)) this.lcd.writeNibble(!!(v & 0x01), (v >> 4) & 0x0f)
    this.last = v
  }
}

// ── SSD1306 ────────────────────────────────────────────────────────────────────────────────
export class SSD1306 {
  readonly ram = new Uint8Array(128 * 8)
  private col = 0; private page = 0
  private colStart = 0; private colEnd = 127; private pageStart = 0; private pageEnd = 7
  private mode = 2 // 0 horizontal, 1 vertical, 2 page
  private pending: number[] = []
  private need = 0
  on = false
  invert = false
  version = 0

  /** A control byte then data: 0x00 = commands follow, 0x40 = display data follows. */
  private control = -1
  start() { this.control = -1 }
  byte(v: number) {
    if (this.control < 0) { this.control = v; return }
    if (this.control & 0x40) this.data(v)
    else this.command(v)
  }
  private data(v: number) {
    this.ram[this.page * 128 + this.col] = v
    this.version++
    if (this.mode === 0) {
      if (++this.col > this.colEnd) { this.col = this.colStart; if (++this.page > this.pageEnd) this.page = this.pageStart }
    } else if (this.mode === 1) {
      if (++this.page > this.pageEnd) { this.page = this.pageStart; if (++this.col > this.colEnd) this.col = this.colStart }
    } else if (++this.col > 127) this.col = 0
  }
  private command(v: number) {
    if (this.need) {
      this.pending.push(v)
      if (--this.need) return
      const [c, a, b] = this.pending
      if (c === 0x20) this.mode = a & 3
      else if (c === 0x21) { this.colStart = a & 127; this.colEnd = b & 127; this.col = this.colStart }
      else if (c === 0x22) { this.pageStart = a & 7; this.pageEnd = b & 7; this.page = this.pageStart }
      this.pending = []
      return
    }
    const args: Record<number, number> = { 0x20: 1, 0x21: 2, 0x22: 2, 0x81: 1, 0x8d: 1, 0xa8: 1, 0xd3: 1, 0xd5: 1, 0xd9: 1, 0xda: 1, 0xdb: 1, 0x26: 6, 0x27: 6, 0x29: 5, 0x2a: 5, 0xa3: 2 }
    if (args[v]) { this.pending = [v]; this.need = args[v]; return }
    if (v === 0xae) { this.on = false; this.version++ }
    else if (v === 0xaf) { this.on = true; this.version++ }
    else if (v === 0xa6 || v === 0xa7) { this.invert = v === 0xa7; this.version++ }
    else if (v >= 0xb0 && v <= 0xb7) this.page = v & 7
    else if (v <= 0x0f) this.col = (this.col & 0xf0) | v
    else if (v >= 0x10 && v <= 0x1f) this.col = ((v & 0x0f) << 4) | (this.col & 0x0f)
  }
  paint(img: ImageData) { paintOled(this, img) }
}

/** Paint an SSD1306's RAM into the element's 128×64 ImageData. */
export function paintOled(o: { ram: Uint8Array; on: boolean; invert: boolean }, img: ImageData) {
  {
    const d = img.data
    for (let y = 0; y < 64; y++) for (let x = 0; x < 128; x++) {
      let lit = o.on && !!(o.ram[(y >> 3) * 128 + x] & (1 << (y & 7)))
      if (o.invert) lit = !lit
      const i = (y * 128 + x) * 4
      d[i] = lit ? 0x9f : 0; d[i + 1] = lit ? 0xe8 : 0; d[i + 2] = lit ? 0xff : 0; d[i + 3] = 255
    }
  }
}

// ── I²C bus ────────────────────────────────────────────────────────────────────────────────
export interface I2CDevice { start?(): void; write(byte: number): void; read?(): number; stop?(): void }

export class I2CBus implements I2CEvents {
  readonly devices = new Map<number, I2CDevice>()
  private current: I2CDevice | null = null
  /** addresses the sketch talked to that nobody answers (shown as a hint) */
  readonly missing = new Set<number>()
  private twi: I2CController
  /** `attach` connects the bus to a chip's I²C controller and returns that controller */
  constructor(attach: (events: I2CEvents) => I2CController) { this.twi = attach(this) }
  start() { this.twi.completeStart() }
  stop() { this.current?.stop?.(); this.current = null; this.twi.completeStop() }
  connectToSlave(addr: number) {
    this.current = this.devices.get(addr) ?? null
    if (this.current) this.current.start?.()
    else this.missing.add(addr)
    this.twi.completeConnect(!!this.current)
  }
  writeByte(value: number) {
    if (this.current) { this.current.write(value); this.twi.completeWrite(true) }
    else this.twi.completeWrite(false)
  }
  readByte() { this.twi.completeRead(this.current?.read?.() ?? 0xff) }
}

// ── NeoPixel (WS2812) bit-stream decoding from DIN edge timing ─────────────────────────────
export class NeoPixelDecoder {
  private bits = 0; private byte = 0; private bytes: number[] = []
  private riseAt = -1; private fallAt = -1
  colors: [number, number, number][] = []
  version = 0
  private hz: number
  private count: number
  constructor(hz: number, count = 1) { this.hz = hz; this.count = count }
  /** DIN went `high` at CPU cycle `t`. */
  edge(high: boolean, t: number) {
    const us = (c: number) => (c / this.hz) * 1e6
    if (high) {
      if (this.fallAt >= 0 && us(t - this.fallAt) > 50) this.latch() // reset gap
      this.riseAt = t
    } else if (this.riseAt >= 0) {
      const w = us(t - this.riseAt)
      this.push(w > 0.55 ? 1 : 0)
      this.fallAt = t
    }
  }
  private push(bit: number) {
    this.byte = (this.byte << 1) | bit
    if (++this.bits === 8) { this.bytes.push(this.byte); this.bits = 0; this.byte = 0 }
  }
  /** Called at frame end too: a long idle low also means "latch". */
  idle(t: number) { if (this.bytes.length && this.fallAt >= 0 && ((t - this.fallAt) / this.hz) * 1e6 > 50) this.latch() }
  private latch() {
    if (this.bytes.length >= 3) {
      const out: [number, number, number][] = []
      for (let i = 0; i + 2 < this.bytes.length && out.length < Math.max(this.count, 256); i += 3) out.push([this.bytes[i + 1], this.bytes[i], this.bytes[i + 2]]) // GRB → RGB
      this.colors = out
      this.version++
    }
    this.bytes = []; this.bits = 0; this.byte = 0
  }
}
