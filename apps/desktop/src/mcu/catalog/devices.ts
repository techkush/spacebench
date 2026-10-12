// Catalogue parts on the running microcontroller: outputs that follow the user's controls, and
// devices that speak a timed protocol on the board's pins (1-Wire, DHT, TM1637, HX711, UART,
// NEC IR, quadrature encoders, steppers …). sim.ts builds a SimCtx per part and calls these.
import type { Drive, PartUi } from "../circuit"
import type { I2CDevice } from "../devices"
import type { PinTrack } from "../machine"
import type { ModView } from "./look"
import type { CatalogPart } from "./types"
import { PROTO } from "./models"

/**
 * An SPI peripheral, byte by byte. SPI is full duplex: the byte the device shifts out on MISO is
 * fixed before the controller's byte arrives, so `out()` is asked first, then `in()` gets MOSI.
 * The same device works with hardware SPI (SPI.transfer) and with bit-banged clocks.
 */
export interface SpiDevice {
  /** the byte to shift out on MISO next */
  out(): number
  /** a byte shifted in from MOSI */
  in(b: number): void
  /** CS went low / high */
  select?(): void
  deselect?(): void
  /** SPI mode for bit-banged clocks (default 0); hardware SPI needs nothing */
  mode?: 0 | 1 | 2 | 3
  lsbFirst?: boolean
}

/** A UART on the part's pins (see SimCtx.uart). */
export interface UartPort {
  /** send bytes (or text) to the board: hardware RX when the part's TX is on it, else bit-banged */
  send(data: number[] | string): void
}

/** Unique version numbers for ModView.image (the canvas caches by it). */
let imageVersions = 0
export const nextImageVer = () => ++imageVersions

export interface SimCtx {
  readonly hz: number
  now(): number
  /** the board pin on the same net as this part's pin (null if none) */
  pin(partPin: string): string | null
  track(boardPin: string | null): PinTrack | undefined
  /** call fn on every change of a board pin */
  hook(boardPin: string | null, fn: (t: number) => void): void
  /** drive this part's pin now (re-solves); null releases it */
  drive(partPin: string, d: Drive | null): void
  /** set a drive without re-solving (inside drives()) */
  set(partPin: string, d: Drive | null): void
  /** run fn after `seconds` of simulated time */
  after(seconds: number, fn: () => void): void
  i2c(addr: number, dev: I2CDevice): void
  /** a control's value (the slider, else the part attr, else its default) */
  ctl(key: string): number
  ui(): PartUi
  /** volts the board supplies to this part's pin's net (0 when unpowered) */
  supply(partPin: string): number
  /** last solved voltage at this part's pin */
  volts(partPin: string): number
  readonly vcc: number
  /** the board's hardware serial RX/TX pins (data written there goes to Serial) */
  serialIn(text: string): boolean
  readonly attrs: Record<string, string>
  /** other parts of a kind (IR remote → receivers) */
  peers(kind: string): CatDevice[]
  /** chip state the solver needs (an I²C relay board's channels) */
  setState(patch: Record<string, number>): void
  /**
   * An SPI device on this part's pins. Pins default to the part's CS / SCK / MOSI / MISO (or
   * their usual aliases: SS, NSS, CLK, SCLK, SDI, DIN, SDO, DO, SO …). With hardware SPI the
   * bytes arrive while CS is low; bit-banged clocks are decoded from the pins.
   */
  spi(dev: SpiDevice, pins?: { cs?: string; sck?: string; mosi?: string; miso?: string }): void
  /** a part's input pin as the board drives it: true high, false low, null not driven / not wired */
  level(partPin: string): boolean | null
  /**
   * A UART on the part's pins: `onByte` gets what the board sends to the part's RX (the board's
   * hardware TX — Serial / Serial1 — or SoftwareSerial bits); `send` answers on the part's TX.
   */
  uart(o: { rx?: string; tx?: string; baud?: number; onByte?: (b: number) => void }): UartPort
}

export interface CatDevice {
  kind?: string
  /** set module outputs from the controls (no re-solve) */
  drives?(): void
  /** the user changed a control */
  ui?(u: PartUi): void
  /** the circuit was re-solved */
  solved?(): void
  /** every frame: dt seconds of simulated time */
  frame?(dt: number): void
  view?(): ModView | undefined
  /** buzzer tone (Hz), 0 = silent */
  tone?(): number
  /** an IR receiver: play a NEC code on its output */
  ir?(code: number): void
}

const POWER = ["VCC", "VDD", "VIN", "5V", "3V3", "+"]
/** the supply this module sees on whichever power pin it has */
export function moduleVcc(c: CatalogPart, ctx: SimCtx): number {
  for (const p of POWER) if (c.pins.includes(p)) { const v = ctx.supply(p); if (v > 0) return v }
  return 0
}
/** a pin is low: the MCU drives it low (open-drain lines are high otherwise, by a pull-up) */
const low = (t: PinTrack | undefined) => t?.out === false

// ── 1-Wire slave (DS18B20, MAX31850K) ─────────────────────────────────────────────────────
function crc8(bytes: number[]): number {
  let crc = 0
  for (let b of bytes) for (let i = 0; i < 8; i++) { const mix = (crc ^ b) & 1; crc >>= 1; if (mix) crc ^= 0x8c; b >>= 1 }
  return crc
}
type Step = { send: number[] } | { recv: number; done: (bits: number[]) => void }

class OneWire {
  private fallAt = -1
  private steps: Step[] = []
  private bits: number[] = []
  private selected = true
  private readSlot = false
  readonly rom: number[]
  private ctx: SimCtx
  private dq: string
  private scratch: () => number[]
  constructor(ctx: SimCtx, dq: string, family: number, scratch: () => number[], serial: number) {
    this.ctx = ctx; this.dq = dq; this.scratch = scratch
    const r = [family, serial & 0xff, (serial >> 8) & 0xff, (serial >> 16) & 0xff, 0x51, 0x5b, 0]
    this.rom = [...r, crc8(r)]
    const bp = ctx.pin(dq)
    ctx.hook(bp, (t) => this.edge(t))
  }
  private edge(t: number) {
    const tr = this.ctx.track(this.ctx.pin(this.dq))
    const us = (c: number) => (c / this.ctx.hz) * 1e6
    if (low(tr)) {
      this.fallAt = t
      // a read slot: answer a 0 by holding the line low for 30 µs
      const s = this.steps[0]
      if (s && "send" in s && this.selected) {
        const bit = s.send.shift()!
        if (!s.send.length) this.steps.shift()
        if (!bit) { this.ctx.drive(this.dq, { v: 0, r: 20 }); this.ctx.after(30e-6, () => this.ctx.drive(this.dq, null)) }
        this.readSlot = true // its release isn't a bit written to us
      }
      return
    }
    if (this.fallAt < 0) return
    const w = us(t - this.fallAt)
    this.fallAt = -1
    if (w > 400) { this.reset(); return }
    if (this.readSlot) { this.readSlot = false; return }
    const s = this.steps[0]
    if (s && "recv" in s) {
      this.bits.push(w < 15 ? 1 : 0)
      if (this.bits.length === s.recv) { const b = this.bits; this.bits = []; this.steps.shift(); s.done(b) }
    }
  }
  private reset() {
    this.steps = []; this.bits = []; this.selected = true; this.readSlot = false
    // presence pulse
    this.ctx.after(30e-6, () => { this.ctx.drive(this.dq, { v: 0, r: 20 }); this.ctx.after(120e-6, () => this.ctx.drive(this.dq, null)) })
    this.recvByte((cmd) => this.rom_(cmd))
  }
  private recvByte(done: (b: number) => void, n = 1, all: number[] = []) {
    this.steps.push({ recv: 8, done: (bits) => { const b = bits.reduce((v, x, i) => v | (x << i), 0); all.push(b); if (all.length < n) this.recvByte(done, n, all); else done(n === 1 ? b : (all as unknown as number)) } })
  }
  private sendBytes(bytes: number[]) { this.steps.push({ send: bytes.flatMap((b) => [0, 1, 2, 3, 4, 5, 6, 7].map((i) => (b >> i) & 1)) }) }
  private rom_(cmd: number) {
    if (cmd === 0xcc) this.recvByte((f) => this.fn(f))
    else if (cmd === 0x33) this.sendBytes(this.rom)
    else if (cmd === 0x55) {
      const got: number[] = []
      const next = () => this.recvByte((b) => { got.push(b); if (got.length < 8) next(); else { this.selected = got.every((x, i) => x === this.rom[i]); if (this.selected) this.recvByte((f) => this.fn(f)) } })
      next()
    } else if (cmd === 0xf0) this.search(0)
  }
  private search(i: number) {
    if (i === 64) { this.recvByte((f) => this.fn(f)); return }
    const bit = (this.rom[i >> 3] >> (i & 7)) & 1
    this.steps.push({ send: [bit, bit ^ 1] })
    this.steps.push({ recv: 1, done: ([dir]) => { if (dir !== bit) { this.selected = false; this.steps = [] } else this.search(i + 1) } })
  }
  private fn(f: number) {
    if (f === 0x44) this.steps.push({ send: Array(64).fill(1) }) // conversion done at once
    else if (f === 0xbe) { const s = this.scratch(); this.sendBytes([...s, crc8(s)]) }
    else if (f === 0xb4) this.steps.push({ send: [1] })
    else if (f === 0x4e) this.recvByte(() => {}, 3)
  }
}

// ── I²C address probes the controller bit-bangs ─────────────────────────────────────────────
/**
 * Answer a bit-banged address probe (used for every I²C part on the Pico — sim.ts) with an ACK on SDA: arduino-pico's Wire sends a zero-length
 * write (Adafruit_I2CDevice::detected, a bus scan) by toggling the pins itself, not through the
 * I²C block, so the bus model never sees it.
 */
export function i2cProbeAck(ctx: SimCtx, addrs: number[], powered: () => boolean = () => true) {
  const scl = ctx.pin("SCL"), sda = ctx.pin("SDA")
  if (!scl || !sda) return
  let bits = -1, byte = 0, acking = false, sclHigh = true, sdaHigh = true
  const high = (pin: string) => ctx.level(pin) !== false
  const release = () => { if (acking) { acking = false; ctx.drive("SDA", null) } }
  ctx.hook(sda, () => {
    const h = high("SDA")
    if (h === sdaHigh) return
    sdaHigh = h
    if (!sclHigh || acking) return
    if (!h) { bits = 0; byte = 0 } else { bits = -1; release() } // START / STOP
  })
  ctx.hook(scl, () => {
    const h = high("SCL")
    if (h === sclHigh) return
    sclHigh = h
    if (bits < 0) return
    if (h && bits < 8) { byte = (byte << 1) | (high("SDA") ? 1 : 0); bits++ }
    else if (h && bits === 8) bits = 9
    else if (!h && bits === 8 && !acking) { if (addrs.includes(byte >> 1) && powered()) { acking = true; ctx.drive("SDA", { v: 0, r: 50 }) } else bits = -1 }
    else if (!h && bits === 9) { release(); bits = -1 }
  })
}


// ── UART (device side) ────────────────────────────────────────────────────────────────────
export function uartSend(ctx: SimCtx, tx: string, bytes: number[], baud = 9600) {
  const rx = ctx.pin(tx)
  if (rx && ctx.serialIn(String.fromCharCode(...bytes))) return
  const bit = 1 / baud
  let t = 0
  for (const b of bytes) {
    const levels = [0, ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (b >> i) & 1), 1]
    for (const l of levels) { const v = l ? ctx.vcc : 0; ctx.after(t, () => ctx.drive(tx, { v, r: 100 })); t += bit }
  }
}
export function uartListen(ctx: SimCtx, rxPin: string, onByte: (b: number) => void, baud = 9600) {
  const bp = ctx.pin(rxPin)
  let busy = false
  ctx.hook(bp, () => {
    if (busy || !low(ctx.track(bp))) return
    busy = true
    const bit = 1 / baud
    let v = 0
    for (let i = 0; i < 8; i++) ctx.after(bit * (1.5 + i), () => { if (!low(ctx.track(bp))) v |= 1 << i })
    ctx.after(bit * 9.5, () => { busy = false; onByte(v) })
  })
}

// ── the devices ───────────────────────────────────────────────────────────────────────────
export function makeDevice(c: CatalogPart, ctx: SimCtx): CatDevice | null {
  const m = c.model
  const vccOf = () => moduleVcc(c, ctx)
  if (m.m === "analog") {
    return {
      drives() {
        const vcc = vccOf()
        const v = vcc > 0 ? Math.max(0, Math.min(vcc, m.f(ctx.ctl("value"), vcc))) : 0
        ctx.set(m.pin, { v, r: 100 })
        if (m.dout) ctx.set(m.dout, { v: v > vcc * (m.thr ?? 0.5) ? 0 : vcc, r: 100 })
      },
    }
  }
  if (m.m === "digital") {
    let until = 0
    return {
      drives() {
        const vcc = vccOf(), on = !!ctx.ui().active || ctx.now() < until
        ctx.set(m.pin, { v: on !== !!m.low ? vcc : 0, r: 100 })
      },
      ui(u) {
        if (u.active && m.pulse) { until = ctx.now() + m.pulse * ctx.hz; ctx.after(m.pulse, () => ctx.drive(m.pin, { v: m.low ? vccOf() : 0, r: 100 })) }
      },
      view: () => ({ glow: [ctx.ui().active || ctx.now() < until ? 1 : 0] }),
    }
  }
  if (m.m === "button") {
    return {
      drives() {
        const vcc = vccOf()
        const on = m.latch ? !!ctx.ui().active : !!ctx.ui().pressed
        ctx.set(m.pin, on ? { v: m.low ? 0 : vcc, r: 50 } : { v: m.low ? vcc : 0, r: 10e3 })
      },
    }
  }
  if (m.m === "buzzer") {
    return {
      tone() {
        const tr = ctx.track(ctx.pin(m.pin))
        if (!tr) return 0
        if (m.active) return tr.out === true || ctx.volts(m.pin) > 1.5 ? 2400 : 0
        return tr.period > 0 && ctx.now() - tr.lastChange < ctx.hz * 0.05 ? ctx.hz / tr.period : 0
      },
    }
  }
  if (m.m === "motor" || m.m === "load") {
    let angle = 0
    return { frame(dt) { const on = ctx.volts(m.a) - (m.m === "motor" && m.b ? ctx.volts(m.b) : 0); angle = (angle + (on / Math.max(1, ctx.vcc)) * 1440 * dt) % 360 }, view: () => (m.m === "motor" ? { angle } : undefined) }
  }
  if (m.m === "siggen") {
    const a = ctx.attrs
    let t0 = -1
    const tick = () => {
      const f = Math.max(0.01, Number(a.freq ?? 1)), amp = Number(a.amp ?? 1), off = Number(a.offset ?? 2.5)
      const s = ctx.now() / ctx.hz
      if (t0 < 0) t0 = s
      const ph = ((s - t0) * f) % 1
      const w = a.wave === "square" ? (ph < 0.5 ? 1 : -1) : a.wave === "triangle" ? 4 * Math.abs(ph - 0.5) - 1 : Math.sin(2 * Math.PI * ph)
      ctx.drive("SIG", { v: off + amp * w, r: 50 })
      ctx.after(1 / Math.min(20000, Math.max(50, f * 40)), tick)
    }
    ctx.after(0, tick)
    return { view: () => ({ text: `${a.wave ?? "sine"} ${a.freq ?? 1} Hz` }) }
  }
  if (m.m !== "proto") return null
  const pins = m.pins ?? {}
  switch (m.kind) {
    case "ds18b20": case "max31850": {
      const max = m.kind === "max31850"
      const dq = c.pins.includes("DQ") ? "DQ" : "SIG"
      const ow = new OneWire(ctx, dq, max ? 0x3b : 0x28, () => {
        const raw = Math.round(ctx.ctl("t") * 16) & 0xffff
        if (max) { const cj = Math.round(25 * 16) & 0xfff0; return [raw & 0xfc, raw >> 8, cj & 0xff, cj >> 8, 0xf0, 0xff, 0xff, 0xff] }
        return [raw & 0xff, raw >> 8, 0x4b, 0x46, 0x7f, 0xff, 0x0c, 0x10]
      }, c.type.length * 7919)
      void ow // it answers through its pin hooks
      return { drives: () => { if (max) ctx.set(dq, { v: vccOf(), r: 4.7e3 }) } }
    }
    case "dht11": case "dht22": {
      const sig = pins.sig ?? "SIG", bp = ctx.pin(sig)
      let lowAt = -1
      ctx.hook(bp, () => {
        const tr = ctx.track(bp)
        if (!tr) return
        if (tr.out === false) { lowAt = ctx.now(); return }
        if (tr.out !== null || lowAt < 0 || (ctx.now() - lowAt) / ctx.hz < 500e-6) return
        lowAt = -1
        const t = ctx.ctl("t"), h = ctx.ctl("h")
        let bytes: number[]
        if (m.kind === "dht11") bytes = [Math.round(h), 0, Math.trunc(t), Math.round((t % 1) * 10)]
        else { const hh = Math.round(h * 10), tt = Math.round(t * 10), tw = tt < 0 ? 0x8000 | -tt : tt; bytes = [hh >> 8, hh & 0xff, tw >> 8, tw & 0xff] }
        bytes.push(bytes.reduce((a, b) => a + b, 0) & 0xff)
        const seq: [boolean, number][] = [[false, 80], [true, 80]]
        for (const b of bytes) for (let i = 7; i >= 0; i--) seq.push([false, 50], [true, b & (1 << i) ? 70 : 26])
        seq.push([false, 50])
        let at = 30
        const pull = { v: vccOf(), r: 10e3 }
        for (const [high, us] of seq) { ctx.after(at * 1e-6, () => ctx.drive(sig, high ? pull : { v: 0, r: 20 })); at += us }
        ctx.after(at * 1e-6, () => ctx.drive(sig, pull))
      })
      return { drives: () => ctx.set(sig, { v: vccOf(), r: 10e3 }) }
    }
    case "max6675": {
      const sck = ctx.pin("SCK"), cs = ctx.pin("CS")
      let word = 0, bit = 15
      ctx.hook(cs, () => { if (low(ctx.track(cs))) { word = (Math.max(0, Math.round(ctx.ctl("t") * 4)) & 0xfff) << 3; bit = 15; ctx.drive("SO", { v: (word >> bit) & 1 ? vccOf() : 0, r: 100 }) } })
      ctx.hook(sck, () => {
        const tr = ctx.track(sck)
        if (!low(ctx.track(cs))) return
        if (tr?.out === false && bit > 0) { bit--; ctx.drive("SO", { v: (word >> bit) & 1 ? vccOf() : 0, r: 100 }) }
      })
      return {}
    }
    case "hx711": {
      const sck = ctx.pin("SCK"), dt = "DT"
      let n = 0, raw = 0
      const ready = () => { n = 0; raw = Math.max(-0x800000, Math.min(0x7fffff, Math.round(ctx.ctl("w") * 420))) & 0xffffff; ctx.drive(dt, { v: 0, r: 100 }) }
      ctx.hook(sck, () => {
        const high = ctx.track(sck)?.out === true
        if (!high) return
        n++
        if (n <= 24) ctx.drive(dt, { v: (raw >> (24 - n)) & 1 ? vccOf() : 0, r: 100 })
        else if (n === 25) { ctx.drive(dt, { v: vccOf(), r: 100 }); ctx.after(0.012, ready) }
      })
      ctx.after(0.01, ready)
      return { drives: () => { if (n === 0) ctx.set(dt, { v: 0, r: 100 }) } }
    }
    case "tm1637": {
      const clk = ctx.pin("CLK"), dio = ctx.pin("DIO")
      const reg = [0, 0, 0, 0, 0, 0]
      let started = false, byte = 0, nb = 0, addr = 0, first = true, on = false, auto = true
      let lastClk = true, lastDio = true
      const lvl = (p: string | null) => !low(ctx.track(p))
      const onByte = (b: number) => {
        if (first) {
          first = false
          if ((b & 0xc0) === 0x40) auto = !(b & 0x04)
          else if ((b & 0xc0) === 0xc0) { addr = b & 7; first = false; return }
          else if ((b & 0xc0) === 0x80) on = !!(b & 0x08)
          return
        }
        reg[addr % 6] = b
        if (auto) addr++
      }
      const edge = () => {
        const cl = lvl(clk), d = lvl(dio)
        if (cl && lastClk && d !== lastDio) {
          if (!d) { started = true; byte = 0; nb = 0; first = true } // start
          else started = false // stop
        } else if (started && cl && !lastClk) {
          if (nb < 8) { byte |= (d ? 1 : 0) << nb; nb++ }
          else { nb = 0; byte = 0 } // the ack clock
        } else if (started && !cl && lastClk && nb === 8) {
          onByte(byte)
          ctx.drive("DIO", { v: 0, r: 50 }) // ack
          ctx.after(8e-6, () => ctx.drive("DIO", { v: vccOf(), r: 10e3 }))
        }
        lastClk = cl; lastDio = d
      }
      ctx.hook(clk, edge); ctx.hook(dio, edge)
      return {
        drives: () => { ctx.set("DIO", { v: vccOf(), r: 10e3 }); ctx.set("CLK", { v: vccOf(), r: 10e3 }) },
        view: () => ({ segs: on ? reg.slice(0, 4).map((x) => x & 0x7f) : [0, 0, 0, 0], colon: on && !!(reg[1] & 0x80) }),
      }
    }
    case "my9221": {
      const dcki = ctx.pin("DCKI"), di = ctx.pin("DI")
      const count = Number(ctx.attrs.pixels ?? 10)
      const frames = Math.ceil(count / 12)
      let bits: number[] = [], words: number[] = []
      ctx.hook(dcki, () => {
        bits.push(low(ctx.track(di)) ? 0 : 1)
        if (bits.length === 208 * frames) {
          const w: number[] = []
          for (let f = 0; f < frames; f++) for (let i = 0; i < 12; i++) { let x = 0; for (let k = 0; k < 16; k++) x = (x << 1) | bits[f * 208 + 16 + i * 16 + k]; w.push(x) }
          words = w; bits = []
        }
      })
      return { view: () => { const g = words.slice(0, count).map((x) => (x ? Math.min(1, 0.3 + x / 255) : 0)); return c.look.k === "strip" ? { pix: g.map((x) => [0, Math.round(255 * x), 0] as [number, number, number]) } : { glow: g } } }
    }
    case "p9813": {
      const ck = ctx.pin(pins.clk ?? "CI"), da = ctx.pin(pins.data ?? "DI")
      let sh = 0, n = 0, idx = 0
      let pix: [number, number, number][] = []
      ctx.hook(ck, () => {
        if (ctx.track(ck)?.out !== true) return
        sh = ((sh << 1) | (low(ctx.track(da)) ? 0 : 1)) >>> 0
        if (++n < 32) return
        n = 0
        if (sh === 0) { idx = 0; return }
        const next = pix.slice(); next[idx++] = [sh & 0xff, (sh >> 8) & 0xff, (sh >> 16) & 0xff]; pix = next
      })
      return { view: () => ({ pix }) }
    }
    case "ws2812": return { kind: "ws2812" } // sim.ts decodes the stream (NeoPixelDecoder)
    case "gps": {
      const send = () => {
        const lat = ctx.ctl("lat"), lon = ctx.ctl("lon"), sats = Math.round(ctx.ctl("sats"))
        const s = new Date(Date.now())
        const hms = `${String(s.getUTCHours()).padStart(2, "0")}${String(s.getUTCMinutes()).padStart(2, "0")}${String(s.getUTCSeconds()).padStart(2, "0")}.00`
        const dmy = `${String(s.getUTCDate()).padStart(2, "0")}${String(s.getUTCMonth() + 1).padStart(2, "0")}${String(s.getUTCFullYear() % 100).padStart(2, "0")}`
        const dm = (v: number, w: number) => { const a = Math.abs(v), d = Math.floor(a); return `${String(d).padStart(w, "0")}${((a - d) * 60).toFixed(5).padStart(8, "0")}` }
        const fix = sats >= 3
        const body = [
          `GPRMC,${hms},${fix ? "A" : "V"},${dm(lat, 2)},${lat < 0 ? "S" : "N"},${dm(lon, 3)},${lon < 0 ? "W" : "E"},0.00,0.00,${dmy},,,A`,
          `GPGGA,${hms},${dm(lat, 2)},${lat < 0 ? "S" : "N"},${dm(lon, 3)},${lon < 0 ? "W" : "E"},${fix ? 1 : 0},${String(sats).padStart(2, "0")},0.9,12.0,M,-95.0,M,,`,
        ]
        const text = body.map((b) => { let cs = 0; for (const ch of b) cs ^= ch.charCodeAt(0); return `$${b}*${cs.toString(16).toUpperCase().padStart(2, "0")}\r\n` }).join("")
        uartSend(ctx, "TX", [...text].map((ch) => ch.charCodeAt(0)))
        ctx.after(1, send)
      }
      ctx.after(0.5, send)
      return { drives: () => ctx.set("TX", { v: vccOf(), r: 100 }) }
    }
    case "mhz16": {
      const buf: number[] = []
      uartListen(ctx, "RX", (b) => {
        buf.push(b); if (buf.length > 9) buf.shift()
        if (buf.length === 9 && buf[0] === 0xff && buf[2] === 0x86) {
          const ppm = Math.round(ctx.ctl("co2"))
          const r = [0xff, 0x86, ppm >> 8, ppm & 0xff, 0x47, 0, 0, 0]
          r.push((0xff - (r.slice(1).reduce((a, x) => a + x, 0) & 0xff) + 1) & 0xff)
          buf.length = 0
          ctx.after(0.002, () => uartSend(ctx, "TX", r))
        }
      })
      return { drives: () => ctx.set("TX", { v: vccOf(), r: 100 }) }
    }
    case "rfid125": return {
      drives: () => ctx.set("TX", { v: vccOf(), r: 100 }),
      ui(u) {
        if (!u.active) return
        const id = Math.round(ctx.ctl("tag")) >>> 0
        const hex = (0x0a00000000 + id).toString(16).toUpperCase().padStart(10, "0").slice(-10)
        let x = 0; for (let i = 0; i < 10; i += 2) x ^= parseInt(hex.slice(i, i + 2), 16)
        const frame = `\x02${hex}${x.toString(16).toUpperCase().padStart(2, "0")}\x03`
        uartSend(ctx, "TX", [...frame].map((ch) => ch.charCodeAt(0)))
      },
    }
    case "irrecv": {
      const out = pins.out ?? "SIG"
      return {
        kind: "irrecv",
        drives: () => ctx.set(out, { v: vccOf(), r: 100 }),
        ir(code) {
          const bytes = [0x00, 0xff, code & 0xff, ~code & 0xff]
          const seq: [boolean, number][] = [[false, 9000], [true, 4500]]
          for (const b of bytes) for (let i = 0; i < 8; i++) seq.push([false, 562], [true, (b >> i) & 1 ? 1687 : 562])
          seq.push([false, 562])
          let t = 0
          for (const [h, us] of seq) { ctx.after(t * 1e-6, () => ctx.drive(out, { v: h ? vccOf() : 0, r: 100 })); t += us }
          ctx.after(t * 1e-6, () => ctx.drive(out, { v: vccOf(), r: 100 }))
        },
      }
    }
    case "irremote": return { ui(u) { const code = u.v?.code; if (u.pressed && code !== undefined) for (const r of ctx.peers("irrecv")) r.ir?.(code) } }
    case "encoder": {
      const a = pins.a ?? "A", b = pins.b ?? "B"
      let pos = 0
      const AB = [[1, 1], [0, 1], [0, 0], [1, 0]]
      let phase = 0
      const set = () => { const v = vccOf(); ctx.drive(a, { v: AB[phase][0] ? v : 0, r: 100 }); ctx.drive(b, { v: AB[phase][1] ? v : 0, r: 100 }) }
      let t = 0
      return {
        drives: () => { const v = vccOf(); ctx.set(a, { v: AB[phase][0] ? v : 0, r: 100 }); ctx.set(b, { v: AB[phase][1] ? v : 0, r: 100 }); if (pins.sw) ctx.set(pins.sw, ctx.ui().pressed ? { v: 0, r: 50 } : { v: v, r: 10e3 }) },
        ui(u) {
          const target = u.v?.pos
          if (target === undefined || target === pos) return
          const dir = target > pos ? 1 : -1
          for (; pos !== target; pos += dir) for (let k = 0; k < 4; k++) { t += 0.002; ctx.after(t, () => { phase = (phase + dir + 4) % 4; set() }) }
          ctx.after(t, () => { t = 0 })
        },
      }
    }
    case "joystick2": return { drives: () => { const v = vccOf(); ctx.set("X", { v: (v / 2) * (1 + ctx.ctl("x")), r: 100 }); ctx.set("Y", { v: (v / 2) * (1 + ctx.ctl("y")), r: 100 }) } }
    case "adxl335": return { drives: () => { const v = vccOf(); for (const [p, k] of [["X", "ax"], ["Y", "ay"], ["Z", "az"]]) ctx.set(p, { v: Math.max(0, Math.min(v, v / 2 + ctx.ctl(k) * 0.3 * (v / 3.3))), r: 100 }) } }
    case "pulse": case "lowpulse": case "ecg": {
      const out = pins.out ?? "SIG"
      if (m.kind === "ecg") {
        const tick = () => {
          const bpm = ctx.ctl("bpm"), s = ctx.now() / ctx.hz, ph = (s * bpm / 60) % 1
          const g = (mu: number, w: number, a: number) => a * Math.exp(-((ph - mu) ** 2) / (2 * w * w))
          const y = g(0.18, 0.025, 0.12) - g(0.29, 0.008, 0.1) + g(0.31, 0.01, 1) - g(0.33, 0.008, 0.25) + g(0.55, 0.04, 0.3)
          ctx.drive(out, { v: vccOf() * (0.4 + 0.45 * y), r: 100 }); ctx.after(0.004, tick)
        }
        ctx.after(0, tick)
        return {}
      }
      const tick = () => {
        if (m.kind === "pulse") {
          const period = 60 / Math.max(1, ctx.ctl("bpm"))
          ctx.drive(out, { v: vccOf(), r: 100 }); ctx.after(0.06, () => ctx.drive(out, { v: 0, r: 100 })); ctx.after(period, tick)
        } else {
          const ratio = Math.min(0.9, ctx.ctl("pcs") / 52000) // share of time LOW
          ctx.drive(out, { v: 0, r: 100 }); ctx.after(0.1 * ratio, () => ctx.drive(out, { v: vccOf(), r: 100 })); ctx.after(0.1, tick)
        }
      }
      ctx.after(0.05, tick)
      return { drives: () => ctx.set(out, { v: m.kind === "lowpulse" ? vccOf() : 0, r: 100 }) }
    }
    case "ultrasonic1": {
      const sig = pins.sig ?? "SIG", bp = ctx.pin(sig)
      let rise = -1
      ctx.hook(bp, () => {
        const tr = ctx.track(bp)
        if (tr?.out === true) { rise = ctx.now(); return }
        if (rise < 0 || (ctx.now() - rise) / ctx.hz < 5e-6) return
        rise = -1
        const cm = Math.max(3, Math.min(350, ctx.ctl("cm")))
        ctx.after(200e-6, () => { ctx.drive(sig, { v: vccOf(), r: 100 }); ctx.after(cm * 58e-6, () => ctx.drive(sig, null)) })
      })
      return {}
    }
    case "dialer": return {
      ui(u) {
        const d = u.v?.digit
        if (u.active === undefined || d === undefined) return
        const n = d === 0 ? 10 : d
        ctx.drive("DIAL", { v: 0, r: 50 })
        let t = 0.05
        for (let i = 0; i < n; i++) { ctx.after(t, () => ctx.drive("PULSE", { v: 0, r: 50 })); ctx.after(t + 0.06, () => ctx.drive("PULSE", null)); t += 0.1 }
        ctx.after(t + 0.05, () => ctx.drive("DIAL", null))
      },
    }
    case "servo": {
      const bp = ctx.pin(pins.pwm ?? "SIG")
      let angle = 90
      return {
        frame() { const tr = ctx.track(bp); if (tr && tr.pulse > 0) { const us = (tr.pulse / ctx.hz) * 1e6; if (us > 400 && us < 2700) angle = Math.max(0, Math.min(180, ((us - 544) / (2400 - 544)) * 180)) } },
        view: () => ({ angle: angle - 90, text: undefined }),
      }
    }
    case "a4988": {
      const step = ctx.pin("STEP"), dir = ctx.pin("DIR"), en = ctx.pin("EN")
      let n = 0
      const PH: [number, number, number, number][] = [[1, 0, 1, 0], [0, 1, 1, 0], [0, 1, 0, 1], [1, 0, 0, 1]]
      // EN is active low; the coils follow a full-step sequence at the motor supply
      const coil = (now: boolean) => {
        const vm = ctx.supply("VMOT") || ctx.volts("VMOT") || 12, p = PH[((n % 4) + 4) % 4], off = !!en && ctx.track(en)?.out === true
        for (const [k, pin] of ["1A", "1B", "2A", "2B"].entries()) (now ? ctx.drive : ctx.set)(pin, off ? null : { v: p[k] ? vm : 0, r: 1 })
      }
      ctx.hook(step, () => { if (ctx.track(step)?.out !== true) return; n += ctx.track(dir)?.out === true ? -1 : 1; coil(true) })
      return { drives: () => coil(false) }
    }
    case "stepper": {
      const two = c.pins.includes("A1+")
      const coils = two ? [["A1+", "A1-", "B1+", "B1-"], ["A2+", "A2-", "B2+", "B2-"]] : [["A+", "A-", "B+", "B-"]]
      const st = coils.map(() => ({ last: NaN, turn: 0 }))
      return {
        solved() {
          coils.forEach((cp, i) => {
            const a = ctx.volts(cp[0]) - ctx.volts(cp[1]), b = ctx.volts(cp[2]) - ctx.volts(cp[3])
            if (Math.abs(a) + Math.abs(b) < 0.5) return
            const e = Math.atan2(b, a)
            const s = st[i]
            if (!Number.isNaN(s.last)) { let d = e - s.last; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; s.turn += d }
            s.last = e
          })
        },
        view: () => ({ angle: (st[0].turn / (2 * Math.PI)) * 7.2, rows: two ? [Math.round((st[1].turn / (2 * Math.PI)) * 7.2 * 100)] : undefined }),
      }
    }
    case "keypad": case "dualbutton": {
      if (m.kind === "dualbutton") return { drives: () => { const v = vccOf(), u = ctx.ui(); ctx.set("SIG1", u.v?.b1 ? { v: 0, r: 50 } : { v, r: 10e3 }); ctx.set("SIG2", u.v?.b2 ? { v: 0, r: 50 } : { v, r: 10e3 }) } }
      return {} // the keypad joins rows to columns in the solver (elements.ts)
    }
    case "gearmotor": {
      let angle = 0, edges = 0
      return {
        frame(dt) {
          const on = (ctx.volts("M+") - ctx.volts("M-")) / 6
          angle = (angle + on * 1080 * dt) % 360
          const pulses = Math.round(Math.abs(on) * 330 * dt * 4) // 11 PPR × 30:1, both edges
          for (let i = 0; i < Math.min(pulses, 400); i++) ctx.after((i * dt) / Math.max(1, pulses), () => { edges += on > 0 ? 1 : -1; const ph = ((edges % 4) + 4) % 4, v = vccOf(); ctx.drive("A", { v: ph === 1 || ph === 2 ? v : 0, r: 100 }); ctx.drive("B", { v: ph >= 2 ? v : 0, r: 100 }) })
        },
        view: () => ({ angle }),
      }
    }
    case "mcp3008": {
      // SPI mode 0, bit-banged or through the SPI pins: start bit, SGL/DIFF, D2..D0, then 10 bits out
      const clk = ctx.pin("CLK"), cs = ctx.pin("CS"), din = ctx.pin("DIN")
      let n = 0, cmd = 0, out = 0
      ctx.hook(cs, () => { if (low(ctx.track(cs))) { n = 0; cmd = 0 } else ctx.drive("DOUT", null) })
      ctx.hook(clk, () => {
        if (!low(ctx.track(cs))) return
        const rising = ctx.track(clk)?.out === true
        if (rising) {
          if (cmd === 0 && n === 0 && low(ctx.track(din))) return // waiting for the start bit
          n++
          if (n <= 5) cmd = (cmd << 1) | (low(ctx.track(din)) ? 0 : 1)
          if (n === 5) {
            const ch = cmd & 7
            const vref = ctx.supply("VREF") || ctx.volts("VREF") || ctx.vcc
            out = Math.max(0, Math.min(1023, Math.round((ctx.volts(`CH${ch}`) / vref) * 1023)))
          }
        } else if (n >= 6 && n <= 16) {
          // falling edges after the null bit shift the result out MSB first
          const k = n - 6
          ctx.drive("DOUT", { v: k === 0 ? 0 : (out >> (10 - k)) & 1 ? ctx.vcc : 0, r: 100 })
        }
      })
      return {}
    }
  }
  // the models in catalog/models/ (one file per family of parts)
  return PROTO[m.kind]?.(c, ctx) ?? null
}
