// Models: colour TFTs and OLED screens. Each draws what the sketch drew into ModView.image (RGBA):
// the controller's frame memory is written byte by byte from SPI / I²C (cheap typed-array work),
// and the picture is built — and its version bumped — at most once per frame, in view().
//
//  - MIPI-DCS controllers (ILI9341, ILI9488, GC9A01, ST7789): CASET/PASET/RAMWR/RAMWRC, MADCTL
//    (MY/MX/MV rotation, BGR), COLMOD 16/18-bit, SLPIN/SLPOUT, DISPON/DISPOFF, INVON/INVOFF,
//    SWRESET / the RST pin, and the read commands libraries use for IDs (RDDID 0x04, RDDST 0x09,
//    RDMODE 0x0A, RDMADCTL 0x0B, RDPIXFMT 0x0C, RDID4 0xD3; ILI9341's 0xD9 index register).
//  - XPT2046 resistive touch (12-bit X/Y/Z1/Z2 conversions, PENIRQ low while touched) and the
//    CHSC6X capacitive touch on the XIAO round display (I²C 0x2E, INT low while touched). A touch
//    is the user pressing on the part's screen while it runs (ui: pressed + v.tx / v.ty, 0..1).
//  - SSD1306 over 4-wire SPI (the I²C OLEDs' SSD1306 class, fed with DC as the command/data flag).
//  - SSD1327 128×128 4-bit greyscale over I²C (Seeed Grove OLED 1.12", 96×96 visible).
//  - ST7789 over the Grove 1.22" IPS display's 2-wire link: 9-bit 3-line serial (D/C bit + 8 data
//    bits, sampled on SCK rising, CS tied low on the board), as Seeed's Arduino_ST7789_Fast sends.
import type { PartUi } from "../../circuit"
import { SSD1306, paintOled, type I2CDevice } from "../../devices"
import { moduleVcc, nextImageVer, type CatDevice, type SimCtx } from "../devices"
import type { ModView } from "../look"
import type { CatalogPart } from "../types"
import type { ModelGroup } from "./types"

// ── colour helpers ────────────────────────────────────────────────────────────────────────
/** RGB565 → 0xRRGGBB, all 65536 colours */
let rgb565: Uint32Array | null = null
function lut565(): Uint32Array {
  if (rgb565) return rgb565
  const t = new Uint32Array(65536)
  for (let v = 0; v < 65536; v++) {
    const r = v >> 11, g = (v >> 5) & 63, b = v & 31
    t[v] = (((r << 3) | (r >> 2)) << 16) | (((g << 2) | (g >> 4)) << 8) | ((b << 3) | (b >> 2))
  }
  return (rgb565 = t)
}

// ── a MIPI-DCS TFT controller ─────────────────────────────────────────────────────────────
interface Panel {
  /** frame memory size (portrait, the controller's native orientation) */
  gw: number; gh: number
  /** the part of the frame memory the glass shows (defaults to all of it) */
  vis?: { x: number; y: number; w: number; h: number }
  /** the glass is wired mirrored in X (ILI9341-style modules: MADCTL MX=1 is upright) */
  flipX: boolean
  /** BGR glass: colours are right when MADCTL's BGR bit is set */
  bgr: boolean
  /** an IPS glass shows inverted colours unless INVON (ST7789, GC9A01) */
  ips: boolean
  round?: boolean
  /** read-command answers (first byte is the dummy clock for multi-byte reads) */
  ids: Record<number, number[]>
  /** the reset value of COLMOD */
  colmod?: number
}

const ILI9341: Panel = { gw: 240, gh: 320, flipX: true, bgr: true, ips: false, ids: { 0x04: [0, 0x00, 0x93, 0x41], 0xd3: [0, 0x00, 0x93, 0x41] } }
const ILI9488: Panel = { gw: 320, gh: 480, flipX: true, bgr: true, ips: false, ids: { 0x04: [0, 0x54, 0x80, 0x66], 0xd3: [0, 0x00, 0x94, 0x88] } }
const GC9A01: Panel = { gw: 240, gh: 240, flipX: true, bgr: true, ips: true, round: true, ids: { 0x04: [0, 0x00, 0x9a, 0x01] } }
const ST7789: Panel = { gw: 240, gh: 320, vis: { x: 0, y: 0, w: 240, h: 240 }, flipX: false, bgr: false, ips: true, ids: { 0x04: [0, 0x85, 0x85, 0x52] } }

/** argument counts of the commands whose arguments the model keeps */
const KEEP: Record<number, number> = { 0x2a: 4, 0x2b: 4, 0x36: 1, 0x3a: 1, 0xd9: 1, 0x33: 6, 0x37: 2 }

export class Dcs {
  readonly p: Panel
  /** frame memory, 0xRRGGBB per pixel, row-major gw × gh */
  readonly gram: Uint32Array
  private cmd = -1
  private args = new Uint8Array(8)
  private nargs = 0
  madctl = 0
  colmod: number
  private xs = 0; private xe = 0; private ys = 0; private ye = 0
  private cx = 0; private cy = 0
  private writing = false
  private acc = 0; private nb = 0
  sleep = true
  on = false
  inv = false
  /** frame memory or display state changed since the last picture */
  dirty = true
  private resp: number[] | null = null
  private ri = 0
  private d9 = 0
  private lut = lut565()
  // the address mapping, from MADCTL
  private mv = false; private fc = false; private fr = false

  constructor(p: Panel) {
    this.p = p
    this.gram = new Uint32Array(p.gw * p.gh)
    this.colmod = p.colmod ?? 0x66
    this.reset()
  }
  /** hardware reset (RST low) or SWRESET: registers to defaults; the frame memory keeps its contents */
  reset() {
    this.cmd = -1; this.nargs = 0; this.writing = false; this.nb = 0
    this.madctl = 0; this.colmod = this.p.colmod ?? 0x66
    this.xs = 0; this.xe = this.p.gw - 1; this.ys = 0; this.ye = this.p.gh - 1
    this.sleep = true; this.on = false; this.inv = false
    this.resp = null; this.d9 = 0
    this.mapping()
    this.dirty = true
  }
  private mapping() {
    const m = this.madctl
    this.mv = !!(m & 0x20)
    this.fc = !!(m & 0x40) !== this.p.flipX
    this.fr = !!(m & 0x80)
  }
  /** what the controller shifts out on SDO for the next byte */
  out(dc: boolean): number {
    if (dc && this.resp) return this.resp[this.ri++] ?? 0
    return 0
  }
  deselect() { this.resp = null; this.nb = 0 }
  /** a byte from the MCU: dc = data (true) or command (false) */
  write(dc: boolean, b: number) {
    if (!dc) { this.command(b); return }
    if (this.writing) {
      // pixel data: 16-bit RGB565 (2 bytes) or 18-bit (3 bytes, 6 bits each, left-aligned)
      if ((this.colmod & 7) === 6) {
        this.acc = (this.acc << 8) | b
        if (++this.nb < 3) return
        const v = this.acc & 0xfcfcfc
        this.acc = 0; this.nb = 0
        this.pixel(v | ((v >> 6) & 0x030303))
      } else {
        if (this.nb === 0) { this.acc = b; this.nb = 1; return }
        this.nb = 0
        this.pixel(this.lut[(this.acc << 8) | b])
      }
      return
    }
    const want = KEEP[this.cmd]
    if (!want || this.nargs >= want) return
    this.args[this.nargs++] = b
    if (this.nargs < want) return
    const a = this.args
    switch (this.cmd) {
      case 0x2a: this.xs = (a[0] << 8) | a[1]; this.xe = (a[2] << 8) | a[3]; break
      case 0x2b: this.ys = (a[0] << 8) | a[1]; this.ye = (a[2] << 8) | a[3]; break
      case 0x36: this.madctl = a[0]; this.mapping(); this.dirty = true; break
      case 0x3a: this.colmod = a[0]; break
      case 0xd9: this.d9 = a[0] & 0x10 ? a[0] & 0x0f : 0; break
    }
  }
  private command(c: number) {
    this.cmd = c; this.nargs = 0; this.writing = false; this.nb = 0; this.resp = null
    switch (c) {
      case 0x01: this.reset(); break // SWRESET
      case 0x10: this.sleep = true; this.dirty = true; break
      case 0x11: this.sleep = false; this.dirty = true; break
      case 0x20: this.inv = false; this.dirty = true; break
      case 0x21: this.inv = true; this.dirty = true; break
      case 0x28: this.on = false; this.dirty = true; break
      case 0x29: this.on = true; this.dirty = true; break
      case 0x2c: this.writing = true; this.cx = this.xs; this.cy = this.ys; break // RAMWR
      case 0x3c: this.writing = true; break // RAMWRC: continue where the last write stopped
      case 0xd9: return // keeps the read index for the next read command
      default: {
        const r = this.read(c)
        if (r) { this.resp = r.slice(this.d9); this.ri = 0 }
      }
    }
    if (c !== 0xd9) this.d9 = 0
  }
  private read(c: number): number[] | undefined {
    const id = this.p.ids[c]
    if (id) return id
    switch (c) {
      case 0x09: return [0, 0x80 | ((this.madctl & 0xfc) >> 1), this.colmod & 0x77, (this.on ? 0x04 : 0) | (this.inv ? 0x20 : 0), 0]
      case 0x0a: return [0x80 | 0x08 | (this.sleep ? 0 : 0x10) | (this.on ? 0x04 : 0)]
      case 0x0b: return [this.madctl]
      case 0x0c: return [this.colmod]
      case 0x0d: return [this.inv ? 0x20 : 0]
      case 0x0e: return [0]
      case 0x0f: return [0xc0]
    }
    return undefined
  }
  private pixel(rgb: number) {
    const p = this.p
    let c = this.mv ? this.cy : this.cx, r = this.mv ? this.cx : this.cy
    if (this.fc) c = p.gw - 1 - c
    if (this.fr) r = p.gh - 1 - r
    if (c >= 0 && c < p.gw && r >= 0 && r < p.gh) { this.gram[r * p.gw + c] = rgb; this.dirty = true }
    if (++this.cx > this.xe) { this.cx = this.xs; if (++this.cy > this.ye) this.cy = this.ys }
  }
}

/** The picture of a DCS panel: built lazily, versioned only when it changed. */
class Picture {
  readonly w: number; readonly h: number
  readonly data: Uint8ClampedArray
  private px: Uint32Array
  private mask: Uint8Array | null = null
  ver = nextImageVer()
  private key = ""
  constructor(w: number, h: number, round = false) {
    this.w = w; this.h = h
    this.data = new Uint8ClampedArray(w * h * 4)
    this.px = new Uint32Array(this.data.buffer)
    this.px.fill(0xff000000)
    if (round) {
      this.mask = new Uint8Array(w * h)
      const r = w / 2
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) this.mask[y * w + x] = (x + 0.5 - r) ** 2 + (y + 0.5 - r) ** 2 <= r * r ? 1 : 0
    }
  }
  /** rebuild from a DCS frame memory when it (or the state) changed */
  fromDcs(d: Dcs, lit: boolean): ModView["image"] {
    const p = d.p, v = p.vis ?? { x: 0, y: 0, w: p.gw, h: p.gh }
    const show = lit && d.on && !d.sleep
    const key = `${show}|${d.inv}|${d.madctl & 8}`
    if (d.dirty || key !== this.key) {
      d.dirty = false; this.key = key
      const px = this.px, g = d.gram, m = this.mask
      if (!show) px.fill(0xff000000)
      else {
        const swap = !!(d.madctl & 8) !== p.bgr, inv = d.inv !== p.ips
        for (let y = 0; y < v.h; y++) {
          let i = y * this.w, s = (v.y + y) * p.gw + v.x
          for (let x = 0; x < v.w; x++, i++, s++) {
            let c = g[s]
            if (inv) c = ~c & 0xffffff
            // RGBA in memory (little endian): 0xAABBGGRR
            px[i] = swap ? 0xff000000 | c : 0xff000000 | ((c & 0xff) << 16) | (c & 0xff00) | ((c >> 16) & 0xff)
          }
        }
        if (m) for (let i = 0; i < m.length; i++) if (!m[i]) px[i] = 0xff111111
      }
      this.ver = nextImageVer()
    }
    return { w: this.w, h: this.h, ver: this.ver, data: this.data }
  }
}

// ── pin helpers ───────────────────────────────────────────────────────────────────────────
/** a part pin's board pin, resolved once; high = the board drives it high */
function line(ctx: SimCtx, pin: string) {
  const bp = ctx.pin(pin)
  return { bp, high: () => ctx.track(bp)?.out === true, low: () => ctx.track(bp)?.out === false }
}
/** powered: the part has no power pin (a XIAO carrier), or its supply is on */
const powered = (c: CatalogPart, ctx: SimCtx) => !["VCC", "VDD", "VIN", "5V", "3V3"].some((p) => c.pins.includes(p)) || moduleVcc(c, ctx) > 0
/** the backlight pin: lit unless the board drives it low (unwired: lit) */
function backlight(ctx: SimCtx, pin: string | undefined) {
  if (!pin) return () => true
  const l = line(ctx, pin)
  return () => !l.low()
}
/** reset pin: calls fn on its falling edge */
function onReset(ctx: SimCtx, pin: string | undefined, fn: () => void) {
  if (!pin) return
  const l = line(ctx, pin)
  if (!l.bp) return
  let was = true
  ctx.hook(l.bp, () => { const lo = l.low(); if (lo && was) fn(); was = !lo })
}

/** where the user touches the screen: 0..1 across and down the screen as drawn, or null */
function touchAt(ctx: SimCtx): { x: number; y: number } | null {
  const u = ctx.ui()
  const x = u.v?.tx, y = u.v?.ty
  if (!u.pressed || x === undefined || y === undefined) return null
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) }
}

// ── XPT2046 touch controller ──────────────────────────────────────────────────────────────
/**
 * XPT2046 / ADS7846 on its own SPI pins. A control byte (S=1, A2..A0, MODE, SER/DFR, PD) starts a
 * conversion; the 12-bit result follows on DOUT after one busy clock — the next two bytes read
 * (r >> 5, r << 3). Channel 001 is the position across the long side, 101 across the short side
 * (as the red 2.8"/3.5" modules are wired: with XPT2046_Touchscreen and the TFT both at rotation 1,
 * p.x grows to the right and p.y downwards, raw ≈ 200…3900).
 */
function xpt2046(c: CatalogPart, ctx: SimCtx, pins: { cs: string; sck: string; mosi: string; miso: string; irq: string }): CatDevice {
  const q = [0, 0]
  let qi = 2
  const raw = (f: number) => Math.round(200 + f * 3700)
  const convert = (ctl: number) => {
    const t = touchAt(ctx), a = (ctl >> 4) & 7
    let r: number
    switch (a) {
      case 1: r = t ? raw(t.y) : 0; break // the long side (landscape X)
      case 5: r = t ? raw(1 - t.x) : 0; break // the short side (landscape Y)
      case 3: r = t ? 900 : 0; break // Z1
      case 4: r = t ? 3000 : 4095; break // Z2
      case 0: case 7: r = 820; break // temperature diodes
      case 2: r = Math.round(((moduleVcc(c, ctx) || ctx.vcc) / 4 / 2.5) * 4095) & 0xfff; break // VBAT/4 against 2.5 V
      default: r = 0
    }
    if (ctl & 0x08) r &= 0xff0 // 8-bit mode: the low bits read as zero
    q[0] = (r >> 5) & 0x7f; q[1] = (r << 3) & 0xf8; qi = 0
  }
  ctx.spi({ out: () => (qi < 2 ? q[qi++] : 0), in: (b) => { if (b & 0x80) convert(b) }, select: () => { qi = 2 } }, { cs: pins.cs, sck: pins.sck, mosi: pins.mosi, miso: pins.miso })
  const irq = (now: boolean) => {
    const vcc = ctx.vcc, d = touchAt(ctx) ? { v: 0, r: 50 } : { v: vcc, r: 50e3 }
    if (now) ctx.drive(pins.irq, d); else ctx.set(pins.irq, d)
  }
  return { drives: () => irq(false), ui: () => irq(true) }
}

// ── the TFT parts ─────────────────────────────────────────────────────────────────────────
interface TftPins { cs: string; dc: string; sck: string; mosi: string; miso: string; rst?: string; led?: string }

function tft(c: CatalogPart, ctx: SimCtx, panel: Panel, pins: TftPins, touch?: "xpt2046" | "chsc6x"): CatDevice {
  const d = new Dcs(panel)
  const dc = line(ctx, pins.dc)
  ctx.spi({ out: () => d.out(dc.high()), in: (b) => d.write(dc.high(), b), deselect: () => d.deselect() }, { cs: pins.cs, sck: pins.sck, mosi: pins.mosi, miso: pins.miso })
  onReset(ctx, pins.rst, () => d.reset())
  const lit = backlight(ctx, pins.led)
  const pic = new Picture(panel.vis?.w ?? panel.gw, panel.vis?.h ?? panel.gh, panel.round)
  let t: CatDevice | undefined
  if (touch === "xpt2046") {
    t = xpt2046(c, ctx, { cs: "T_CS", sck: "T_CLK", mosi: "T_DIN", miso: "T_DO", irq: "T_IRQ" })
  } else if (touch === "chsc6x") t = chsc6x(ctx, "D7")
  return {
    drives: () => t?.drives?.(),
    ui: (u: PartUi) => t?.ui?.(u),
    view: () => ({ image: pic.fromDcs(d, powered(c, ctx) && lit()) }),
  }
}

// ── CHSC6X capacitive touch (XIAO round display) ──────────────────────────────────────────
/** I²C 0x2E: a 5-byte report [points, 0, x, 0, y] (Seeed_Arduino_RoundDisplay); INT low while touched */
function chsc6x(ctx: SimCtx, int: string): CatDevice {
  let i = 0
  const report = () => { const t = touchAt(ctx); return t ? [1, 0, Math.min(239, Math.round(t.x * 240)), 0, Math.min(239, Math.round(t.y * 240))] : [0, 0, 0, 0, 0] }
  let r = report()
  const dev: I2CDevice = { start() { i = 0; r = report() }, write() {}, read: () => r[i++ % 5] }
  ctx.i2c(0x2e, dev)
  const irq = (now: boolean) => { const d = touchAt(ctx) ? { v: 0, r: 50 } : { v: ctx.vcc, r: 10e3 }; if (now) ctx.drive(int, d); else ctx.set(int, d) }
  return { drives: () => irq(false), ui: () => irq(true) }
}

// ── ST7789 on the Grove 1.22" IPS display: 9-bit 3-line serial on SCK/SDA ─────────────────
function grove7789(c: CatalogPart, ctx: SimCtx): CatDevice {
  const d = new Dcs(ST7789)
  const sck = line(ctx, "SCL"), sda = line(ctx, "SDA")
  let bits = 0, v = 0, last = 0
  if (sck.bp) ctx.hook(sck.bp, (t) => {
    if (!sck.high()) return
    // a frame that stalls for 5 ms is abandoned (the link has no chip select to resync on)
    if (bits && t - last > ctx.hz * 0.005) bits = 0
    last = t
    v = (v << 1) | (sda.high() ? 1 : 0)
    if (++bits === 9) { d.write(!!(v & 0x100), v & 0xff); bits = 0; v = 0 }
  })
  const pic = new Picture(240, 240)
  return { view: () => ({ image: pic.fromDcs(d, powered(c, ctx)) }) }
}

// ── SSD1306 over 4-wire SPI ───────────────────────────────────────────────────────────────
function ssd1306spi(c: CatalogPart, ctx: SimCtx): CatDevice {
  let o = new SSD1306()
  const dc = line(ctx, "DC")
  let mode = -1
  ctx.spi({ out: () => 0xff, in: (b) => { const m = dc.high() ? 1 : 0; if (m !== mode) { mode = m; o.start(); o.byte(m ? 0x40 : 0x00) } o.byte(b) } }, { cs: "CS", sck: "D0", mosi: "D1", miso: "D1" })
  onReset(ctx, "RES", () => { o = new SSD1306(); mode = -1 })
  const data = new Uint8ClampedArray(128 * 64 * 4)
  let ver = 0, seen = -1, on = true, img: ModView["image"]
  return {
    view: () => {
      const p = powered(c, ctx)
      if (o.version !== seen || p !== on || !img) {
        seen = o.version; on = p
        paintOled({ ram: o.ram, on: o.on && p, invert: o.invert && p }, { data } as unknown as ImageData)
        ver = nextImageVer()
        img = { w: 128, h: 64, ver, data }
      }
      return { image: img }
    },
  }
}

// ── SSD1327 greyscale OLED on I²C ─────────────────────────────────────────────────────────
/**
 * SSD1327: 128×128 × 4-bit GDDRAM, a column address per two pixels (0x15), rows (0x75), remap
 * (0xA0: column remap, nibble remap, vertical increment, COM remap), start line, normal / all-on /
 * all-off / inverse, display on/off. The Seeed 96×96 glass shows segments 16–111 of rows 0–95
 * (as U8g2's SSD1327_SEEED_96X96 driver addresses it; COM remap flips it top to bottom).
 */
export class Ssd1327 implements I2CDevice {
  readonly ram = new Uint8Array(64 * 128)
  private ctrl = -1
  private single = false
  private cmd = -1
  private args: number[] = []
  private need = 0
  private c0 = 0; private c1 = 63; private r0 = 0; private r1 = 127
  private col = 0; private row = 0
  remap = 0
  start_ = 0
  mode = 0xa4
  on = false
  version = 0
  start() { this.ctrl = -1 }
  write(b: number) {
    if (this.ctrl < 0) { this.ctrl = b; this.single = !!(b & 0x80); return }
    if (this.ctrl & 0x40) this.data(b); else this.command(b)
    if (this.single) this.ctrl = -1 // Co = 1: one byte, then another control byte
  }
  private data(b: number) {
    this.ram[this.row * 64 + this.col] = b
    this.version++
    if (this.remap & 4) { if (++this.row > this.r1) { this.row = this.r0; if (++this.col > this.c1) this.col = this.c0 } }
    else if (++this.col > this.c1) { this.col = this.c0; if (++this.row > this.r1) this.row = this.r0 }
  }
  private static ARGS: Record<number, number> = { 0x15: 2, 0x75: 2, 0x81: 1, 0xa0: 1, 0xa1: 1, 0xa2: 1, 0xa8: 1, 0xab: 1, 0xb1: 1, 0xb3: 1, 0xb6: 1, 0xb8: 15, 0xbc: 1, 0xbe: 1, 0xd5: 1, 0xfd: 1, 0x23: 1, 0x26: 7, 0x27: 7 }
  private command(b: number) {
    if (this.need) {
      this.args.push(b)
      if (--this.need) return
      const [a, c] = this.args
      switch (this.cmd) {
        case 0x15: this.c0 = a & 63; this.c1 = c & 63; this.col = this.c0; break
        case 0x75: this.r0 = a & 127; this.r1 = c & 127; this.row = this.r0; break
        case 0xa0: this.remap = a; this.version++; break
        case 0xa1: this.start_ = a & 127; this.version++; break
      }
      return
    }
    const n = Ssd1327.ARGS[b]
    if (n) { this.cmd = b; this.args = []; this.need = n; return }
    if (b === 0xae || b === 0xaf) { this.on = b === 0xaf; this.version++ }
    else if (b >= 0xa4 && b <= 0xa7) { this.mode = b; this.version++ }
  }
  /** the 96×96 picture, grey 0..15 per pixel */
  paint(px: Uint32Array, lit: boolean) {
    const colRemap = !!(this.remap & 1), nib = !!(this.remap & 2), comRemap = !!(this.remap & 0x10)
    for (let y = 0; y < 96; y++) {
      const r = (((comRemap ? y : 95 - y) + this.start_) & 127) * 64
      for (let x = 0; x < 96; x++) {
        // the glass shows segment 111 - x; a segment comes from a byte and one of its nibbles
        const seg = 111 - x
        const byte = colRemap ? 63 - (seg >> 1) : seg >> 1
        const hi = ((seg & 1) === 1) !== nib
        let g = hi ? this.ram[r + byte] >> 4 : this.ram[r + byte] & 15
        if (this.mode === 0xa5) g = 15; else if (this.mode === 0xa6) g = 0; else if (this.mode === 0xa7) g = 15 - g
        if (!this.on || !lit) g = 0
        const k = g * 17
        px[y * 96 + x] = 0xff000000 | (k << 16) | (k << 8) | k
      }
    }
  }
}

// ── the group ─────────────────────────────────────────────────────────────────────────────
const ili9341Pins = (c: CatalogPart): TftPins => c.pins.includes("D/C")
  ? { cs: "CS", dc: "D/C", sck: "SCK", mosi: "MOSI", miso: "MISO", rst: "RST", led: "LED" }
  : { cs: "CS", dc: "DC", sck: "SCK", mosi: "SDI", miso: "SDO", rst: "RESET", led: "LED" }

const group: ModelGroup = {
  proto: {
    ili9341: (c, ctx) => tft(c, ctx, ILI9341, ili9341Pins(c)),
    "ili9341-touch": (c, ctx) => tft(c, ctx, ILI9341, ili9341Pins(c), "xpt2046"),
    "ili9488-touch": (c, ctx) => tft(c, ctx, ILI9488, ili9341Pins(c), "xpt2046"),
    "gc9a01-touch": (c, ctx) => tft(c, ctx, GC9A01, { cs: "D1", dc: "D3", sck: "D8", mosi: "D10", miso: "D9", led: "D6" }, "chsc6x"),
    "st7789-grove": (c, ctx) => grove7789(c, ctx),
    "ssd1306-spi": (c, ctx) => ssd1306spi(c, ctx),
  },
  chips: {
    ssd1327: (_ctx, addr) => {
      const o = new Ssd1327()
      const data = new Uint8ClampedArray(96 * 96 * 4), px = new Uint32Array(data.buffer)
      let seen = -1, img: ModView["image"]
      return {
        devices: [[addr, o]],
        view: () => {
          if (o.version !== seen || !img) { seen = o.version; o.paint(px, true); img = { w: 96, h: 96, ver: nextImageVer(), data } }
          return { image: img }
        },
      }
    },
  },
}
export default group
