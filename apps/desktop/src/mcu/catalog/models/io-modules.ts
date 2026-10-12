// Models: io-modules — input / output modules that talk I²C or UART with their own little
// protocol: gesture sensor, encoder wheel, NFC reader, LED matrices with a driver MCU, M5Stack
// Chain units, the XIAO COB LED carrier, a voice recorder, a touch keypad, a fingerprint
// scanner and a UART ultrasonic sensor. Each is modelled at the level its Arduino library
// talks to it (registers, frames, checksums), so the library works unchanged.
import type { PartUi } from "../../circuit"
import type { I2CDevice } from "../../devices"
import { moduleVcc, nextImageVer, type CatDevice, type SimCtx, type UartPort } from "../devices"
import type { ModView } from "../look"
import type { CatalogPart } from "../types"
import type { ModelGroup } from "./types"

type RGB = [number, number, number]
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))
const sum8 = (b: number[]) => b.reduce((a, x) => a + x, 0) & 0xff

// ── Seeed's 8×8 font, icons and bars (Seeed_Font.h of Grove_LED_Matrix_Driver_HT16K33, MIT) ──
// one uint64 per glyph: byte r (LSB first) is row r from the top, bit x is column x from the left
const ASCII_HEX = "0000000000000000180018183c3c180000000000286c6c006c6cfe6cfe6c6c00103c40380478100060660c1830660600fc66a6143c663c000000000c181818006030181818306000060c1818180c0600006c38fe386c00000010107c10100000060c0c0c000000000000003c00000000060600000000000000060c18306000001c2222222222221c1c08080808080c083e0408102020221c1c2220201820221c20203e22242830201c2220201e02023e1c2222221e02221c040404081020203e1c2222221c22221c1c22203c2222221c00181800181800000c181800181800006030180c1830600000003c003c000000060c1830180c06001800183860663c00003c421a3a221c000033333f33331e0c003f66663e66663f003c66030303663c001f36666666361f007f46161e16467f000f06161e16467f007c66730303663c003333333f333333001e0c0c0c0c0c1e001e333330303078006766361e366667007f66460606060f0063636b7f7f7763006363737b6f6763001c36636363361c000f06063e66663f00381e3b3333331e006766363e66663f001e33380e07331e001e0c0c0c0c2d3f003f333333333333000c1e33333333330063777f6b6363630063361c1c366363001e0c0c1e333333007f664c1831637f7818181818187800006030180c0600001e18181818181e0000000082442810007e000000000000000000000060303000006e333e301e0000003b66663e060607001e3303331e0000006e33333e303038001e033f331e0000000f06060f06361c1f303e33336e0000006766666e360607001e0c0c0c0e000c1e333330303000300067361e36660607001e0c0c0c0c0c0e00636b7f7f33000000333333331f0000001e3333331e00000f063e66663b000078303e33336e0000000f06666e3b0000001f301e033e000000182c0c0c3e0c08006e333333330000000c1e333333000000367f7f6b6300000063361c366300001f303e3333330000003f260c193f00007018180c1818700000080808080808000e18183018180e00000000365c000000"
const ICONS_HEX = "ffffffffffffffff383838fe7c38100010387cfe3838380010307efe7e3010001018fcfefc181000fefe7c7c383810001038387c7cfefe00061e7efe7e1e0600c0f0fcfefcf0c0007c92aa82aa827c00003c42000066000010387cfefeee440010387cfe7c381000381054fe5438100038107cfe7c38100000387c7c7c380000ffc7838383c7ffff0038444444380000ffc7bbbbbbc7ffff0c12129ca0c0f00038444438107c1000060e0c0808281800066eecc88898f000105438ee3854100010385410543810006666006666666600002844fe44280000fe8282c66c381000002400e7a5bde700"
const BARS_HEX = "000000000000000018000000000000003c000000000000007e00000000000000ff00000000000000ff18000000000000ff3c000000000000ff7e000000000000ffff000000000000ffff180000000000ffff3c0000000000ffff7e0000000000ffffff0000000000ffffff1800000000ffffff3c00000000ffffff7e00000000ffffffff00000000ffffffff18000000ffffffff3c000000ffffffff7e000000ffffffffff000000ffffffffff180000ffffffffff3c0000ffffffffff7e0000ffffffffffff0000ffffffffffff1800ffffffffffff3c00ffffffffffff7e00ffffffffffffff00ffffffffffffff18ffffffffffffff3cffffffffffffff7effffffffffffffff"
const glyphs = (hex: string): number[][] => Array.from({ length: hex.length / 16 }, (_, g) => Array.from({ length: 8 }, (_, r) => parseInt(hex.slice(g * 16 + 14 - 2 * r, g * 16 + 16 - 2 * r), 16)))
const FONT = glyphs(ASCII_HEX), ICONS = glyphs(ICONS_HEX), BARS = glyphs(BARS_HEX)
const glyph = (ch: number) => FONT[ch - 32] ?? FONT[0]

/** an 8×8 picture shown as a tiny RGB image (the version changes only with the picture) */
class Pic8 {
  private data = new Uint8ClampedArray(256)
  private sig = ""
  private ver = nextImageVer()
  show(px: (x: number, y: number) => RGB): ModView {
    let s = ""
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { const c = px(x, y), i = (y * 8 + x) * 4; this.data[i] = c[0]; this.data[i + 1] = c[1]; this.data[i + 2] = c[2]; this.data[i + 3] = 255; s += c.join(",") + ";" }
    if (s !== this.sig) { this.sig = s; this.ver = nextImageVer() }
    return { image: { w: 8, h: 8, ver: this.ver, data: this.data } }
  }
}
const hsv = (h: number, s = 1, v = 1): RGB => {
  const f = (n: number) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)) }
  return [Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255)]
}
const scale = (c: RGB, k: number): RGB => [Math.round(c[0] * k), Math.round(c[1] * k), Math.round(c[2] * k)]
const OFF: RGB = [0, 0, 0]
/** rotate a pixel coordinate by 0/90/180/270° (clockwise) on the 8×8 grid */
const rot = (x: number, y: number, r: number): [number, number] => (r & 3) === 1 ? [y, 7 - x] : (r & 3) === 2 ? [7 - x, 7 - y] : (r & 3) === 3 ? [7 - y, x] : [x, y]

/** text as columns (8 per character) for scrolling */
const textColumns = (s: string): number[] => {
  const cols: number[] = []
  for (const ch of s) { const g = glyph(ch.charCodeAt(0)); for (let x = 0; x < 8; x++) { let col = 0; for (let y = 0; y < 8; y++) if (g[y] & (1 << x)) col |= 1 << y; cols.push(col) } }
  return cols
}

// ── PAG7660 Smart IR Gesture Sensor (Seeed "Grove Gesture" library, pag7660 class) ────────────
// I²C 0x68: ID 0x7660 at 0x00/0x01, 0x04 bit1 = frame ready (cleared by writing 0), 0x22 mode,
// the gesture output block (pag7660_reg_out_t, 38 bytes) from 0x3C.
const GESTURES = ["none", "1 finger", "2 fingers", "3 fingers", "4 fingers", "5 fingers", "rotate CW", "rotate CCW", "swipe left", "swipe right",
  "1-finger push", "2-finger push", "3-finger push", "4-finger push", "5-finger push", "thumb up", "thumb down", "tap", "grab", "pinch"]
function pag7660(_c: CatalogPart, ctx: SimCtx): CatDevice {
  const r = new Uint8Array(256)
  let ptr = 0, fresh = true, pending = 0, lastFrame = -1e12
  const reset = () => { r.fill(0); r[0x00] = 0x60; r[0x01] = 0x76; r[0x22] = 5 }
  reset()
  const isStatic = (g: number) => (g >= 1 && g <= 5) || g === 15 || g === 16
  const fill = (g: number) => {
    r.fill(0, 0x3c, 0x3c + 38)
    if (g <= 0) return
    const o = 0x3c, fingers = g <= 5 ? g : g >= 10 && g <= 14 ? g - 9 : g >= 17 ? 1 : 0
    r[o] = 1 | (((1 << fingers) - 1) << 1) // palm + tips valid
    r[o + 1] = 200; r[o + 2] = 200; r[o + 3] = 90; r[o + 4] = 180 // palm x, y, r, b
    for (let i = 0; i < fingers; i++) { const t = o + 7 + i * 4; r[t] = 120 + i * 40; r[t + 1] = 120; r[t + 2] = 200; r[t + 3] = i }
    const res = o + 27
    let type = 0, cursor = 0, sel = 0, thumbUp = 0, thumbDown = 0, ang = 0
    if (g <= 5) type = g
    else if (g === 6) { type = 6; ang = Math.round(ctx.ctl("angle")) }
    else if (g === 7) { type = 7; ang = -Math.round(ctx.ctl("angle")) }
    else if (g === 8) type = 8
    else if (g === 9) type = 9
    else if (g <= 14) type = 19 + (g - 10)
    else if (g === 15) thumbUp = 1
    else if (g === 16) thumbDown = 1
    else { cursor = g - 16; sel = 1 }
    r[res] = thumbUp | (cursor << 1) | (type << 3)
    r[res + 1] = sel
    r[res + 2] = 200; r[res + 3] = 200 // cursor x, y (low bytes)
    r[res + 4] = thumbDown
    r[res + 5] = ang & 0xff; r[res + 6] = (ang >> 8) & 0xff
  }
  const ready = () => {
    if (moduleVcc(_c, ctx) <= 0) return false
    if (r[0x04] & 2) return true
    const g = Math.round(ctx.ctl("gesture"))
    if (pending) { fill(pending); r[0x04] |= 2; return true }
    if (isStatic(g) && (ctx.now() - lastFrame) / ctx.hz >= 1 / 30) { fill(g); r[0x04] |= 2; lastFrame = ctx.now(); return true }
    return false
  }
  const dev: I2CDevice = {
    start() { fresh = true },
    write(b) {
      if (fresh) { ptr = b; fresh = false; return }
      if (ptr === 0x04) { if (!(b & 2)) { r[0x04] = b; pending = 0 } }
      else r[ptr] = b
      ptr = (ptr + 1) & 0xff
    },
    read() { if (ptr === 0x04) ready(); const v = r[ptr]; ptr = (ptr + 1) & 0xff; return v },
  }
  ctx.i2c(0x68, dev)
  return {
    ui(u: PartUi) { const g = u.v?.gesture; if (g !== undefined && Math.round(g) > 0 && !isStatic(Math.round(g))) pending = Math.round(g) },
    view: () => { const g = Math.round(ctx.ctl("gesture")); return { text: g > 0 ? GESTURES[g] ?? "" : "" } },
  }
}

// ── Pimoroni RGB Encoder Wheel: Nuvoton MS51 "ioexpander" (0x13) + IS31FL3731 (0x77) ──────────
// IOE: chip ID 0xE26A at 0xFA/0xFB, reset via CTRL 0xFE (USER_FLASH 0xD0 reads 0x78 after),
// bit-addressed port registers P0–P3 (writes are (state << 3) | bit), PxM1/PxM2 modes,
// INT_MASK_P0/P1, INT 0xF9 (TRIGD, OUT_EN, PIN_SWAP), encoder ENC_EN 0x04 / ENC_1_CFG 0x05 /
// ENC_1_COUNT 0x06 (8-bit, microsteps = 2 per detent). Buttons: up P0.7, down P1.4, left P0.6,
// right P1.0, centre P1.5 (low when pressed).
const WHEEL_LEDS: [number, number, number][] = [
  [128, 32, 48], [129, 33, 49], [130, 17, 50], [131, 18, 34], [132, 19, 35], [133, 20, 36], [134, 21, 37], [112, 80, 96],
  [113, 81, 97], [114, 82, 98], [115, 83, 99], [116, 84, 100], [117, 68, 101], [118, 69, 85], [127, 47, 63], [121, 41, 57],
  [122, 25, 58], [123, 26, 42], [124, 27, 43], [125, 28, 44], [126, 29, 45], [15, 95, 111], [8, 89, 105], [9, 90, 106],
]
const PORT_REG = [0x40, 0x50, 0x60, 0x70]
/** IS31FL3731: eight frames of 0xB4 bytes (enable, blink, PWM) and the function bank 0x0B */
class Is31fl3731 implements I2CDevice {
  readonly frames = Array.from({ length: 8 }, () => new Uint8Array(0xb4))
  readonly fn = new Uint8Array(0x0d)
  bank = 0
  private ptr = 0
  private fresh = true
  start() { this.fresh = true }
  write(b: number) {
    if (this.fresh) { this.ptr = b; this.fresh = false; return }
    if (this.ptr === 0xfd) this.bank = b
    else if (this.bank === 0x0b) { if (this.ptr < 0x0d) this.fn[this.ptr] = b }
    else if (this.bank < 8 && this.ptr < 0xb4) this.frames[this.bank][this.ptr] = b
    this.ptr = (this.ptr + 1) & 0xff
  }
  read() {
    const p = this.ptr
    this.ptr = (this.ptr + 1) & 0xff
    if (p === 0xfd) return this.bank
    if (this.bank === 0x0b) return p < 0x0d ? this.fn[p] : 0
    return this.bank < 8 && p < 0xb4 ? this.frames[this.bank][p] : 0
  }
  /** the displayed frame's PWM for LED `n` (0–143), 0 when shut down or not enabled */
  led(n: number) {
    if (!(this.fn[0x0a] & 1)) return 0
    const f = this.frames[this.fn[0x01] & 7]
    return f[n >> 3] & (1 << (n & 7)) ? f[0x24 + n] : 0
  }
}
function encoderWheel(c: CatalogPart, ctx: SimCtx): CatDevice {
  const r = new Uint8Array(256)
  const latch = [0, 0, 0, 0]
  let ptr = 0, fresh = true, encBase = 0, lastPins = -1, lastCount = 0
  const BUTTONS: [string, number, number][] = [["up", 0, 7], ["down", 1, 4], ["left", 0, 6], ["right", 1, 0], ["centre", 1, 5]]
  const reset = () => { r.fill(0); latch.fill(0xff); r[0xfa] = 0x6a; r[0xfb] = 0xe2; r[0xfc] = 2; r[0xd0] = 0x78; encBase = rawCount() }
  const edges = () => Math.round(ctx.ctl("turn")) * 2 // two quadrature edges per detent
  const rawCount = () => (r[0x04] & 2 ? edges() : Math.floor(edges() / 4))
  const external = (port: number) => { let v = 0xff; for (const [k, p, bit] of BUTTONS) if (p === port && ctx.ctl(k) >= 0.5) v &= ~(1 << bit); return v }
  const pinsWord = () => (external(0) | (external(1) << 8)) & ((r[0x00] | (r[0x01] << 8)) || 0xffff)
  reset()
  /** a masked input changed or the encoder moved: raise the interrupt */
  const poll = () => {
    const w = pinsWord(), cnt = rawCount()
    if ((lastPins >= 0 && w !== lastPins) || cnt !== lastCount) { r[0xf9] |= 1; intPin(true) }
    lastPins = w; lastCount = cnt
  }
  const intActive = () => (r[0xf9] & 3) === 3
  const intPin = (now: boolean) => { const v = moduleVcc(c, ctx); (now ? ctx.drive : ctx.set)("INT", intActive() ? { v: 0, r: 50 } : { v, r: 10e3 }) }
  const ioe: I2CDevice = {
    start() { fresh = true },
    write(b) {
      if (fresh) { ptr = b; fresh = false; return }
      const port = PORT_REG.indexOf(ptr)
      if (port >= 0) { const bit = b & 7; if (b & 8) latch[port] |= 1 << bit; else latch[port] &= ~(1 << bit) }
      else if (ptr === 0xfe) { if (b & 2) { reset(); return } r[ptr] = b }
      else if (ptr === 0x06) { encBase = rawCount() - (b << 24 >> 24) }
      else if (ptr === 0xf9) { r[ptr] = b; intPin(true) }
      else if (ptr !== 0xfa && ptr !== 0xfb && ptr !== 0xfc) r[ptr] = b
      ptr = (ptr + 1) & 0xff
    },
    read() {
      const p = ptr
      ptr = (ptr + 1) & 0xff
      const port = PORT_REG.indexOf(p)
      if (port >= 0) return latch[port] & external(port)
      if (p === 0x06) return (rawCount() - encBase) & 0xff
      return r[p]
    },
  }
  const leds = new Is31fl3731()
  ctx.i2c(0x13, ioe)
  ctx.i2c(0x77, leds)
  const tick = () => { poll(); ctx.after(0.005, tick) }
  ctx.after(0.005, tick)
  return {
    drives: () => intPin(false),
    ui: () => poll(),
    view: () => ({ pix: WHEEL_LEDS.map(([a, b, d]) => [leds.led(a), leds.led(b), leds.led(d)] as RGB) }),
  }
}

// ── NXP PN532 NFC over I²C (0x24): Adafruit_PN532 and Seeed's PN532_I2C ──────────────────────
// Host frames 00 00 FF LEN LCS D4 cmd… DCS 00; each read starts with the ready byte (0x01 when a
// frame waits), then the ACK (00 00 FF 00 FF 00) or the response frame; a NACK asks for the last
// response again. Tags: MIFARE Classic 1K (4-byte UID, keys FF…FF, auth/read/write) and NTAG213
// (7-byte UID, 45 pages, read 4 pages / write 1). Their memory lasts while the sketch runs.
interface Tag { kind: "classic" | "ntag"; uid: number[]; mem: Uint8Array }
function makeTag(kind: "classic" | "ntag", id: number): Tag {
  if (kind === "classic") {
    const uid = [(id >> 24) & 0xff || 0xde, (id >> 16) & 0xff, (id >> 8) & 0xff, id & 0xff]
    const mem = new Uint8Array(64 * 16)
    mem.set([...uid, uid.reduce((a, b) => a ^ b, 0), 0x08, 0x04, 0x00, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69], 0)
    for (let s = 0; s < 16; s++) mem.set([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x07, 0x80, 0x69, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], (s * 4 + 3) * 16)
    return { kind, uid, mem }
  }
  const uid = [0x04, (id >> 24) & 0xff, (id >> 16) & 0xff, (id >> 8) & 0xff, id & 0xff, 0x5a, 0x80]
  const mem = new Uint8Array(45 * 4)
  const bcc0 = 0x88 ^ uid[0] ^ uid[1] ^ uid[2], bcc1 = uid[3] ^ uid[4] ^ uid[5] ^ uid[6]
  mem.set([uid[0], uid[1], uid[2], bcc0, uid[3], uid[4], uid[5], uid[6], bcc1, 0x48, 0, 0, 0xe1, 0x10, 0x12, 0x00, 0x01, 0x03, 0xa0, 0x0c, 0x34, 0x03, 0x00, 0xfe], 0)
  mem.set([0x04, 0x00, 0x00, 0xff, 0x00, 0x05, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0], 41 * 4)
  return { kind, uid, mem }
}
function pn532(c: CatalogPart, ctx: SimCtx): CatDevice {
  const tags = new Map<string, Tag>()
  const ACK = [0x00, 0x00, 0xff, 0x00, 0xff, 0x00]
  let queue: number[][] = [], last: number[] | null = null
  let rx: number[] = [], reading = 0
  let retries = 0xff, waiting: ((t: Tag | null) => void) | null = null, active: Tag | null = null, authSector = -1
  const present = (): Tag | null => {
    if (moduleVcc(c, ctx) <= 0 || ctx.ctl("tag") < 0.5) return null
    const kind = ctx.ctl("type") >= 0.5 ? "ntag" : "classic", id = Math.round(ctx.ctl("uid")) >>> 0
    const key = `${kind}:${id}`
    let t = tags.get(key)
    if (!t) tags.set(key, (t = makeTag(kind, id)))
    return t
  }
  const frame = (data: number[]) => { const len = data.length; return [0x00, 0x00, 0xff, len, (0x100 - len) & 0xff, ...data, (0x100 - sum8(data)) & 0xff, 0x00] }
  const reply = (data: number[]) => queue.push(frame([0xd5, ...data]))
  const listed = (t: Tag) => { active = t; authSector = -1; reply([0x4b, 1, 1, 0x00, t.kind === "classic" ? 0x04 : 0x44, t.kind === "classic" ? 0x08 : 0x00, t.uid.length, ...t.uid]) }
  const exchange = (d: number[]) => {
    const t = present()
    if (!active || !t || t !== active) { active = null; reply([0x41, 0x01]); return } // timeout: the tag left
    const [cmd, addr] = d
    if (t.kind === "classic") {
      const block = addr & 63, sector = block >> 2, trailer = (sector * 4 + 3) * 16
      if (cmd === 0x60 || cmd === 0x61) {
        const key = d.slice(2, 8), want = Array.from(t.mem.slice(cmd === 0x60 ? trailer : trailer + 10, cmd === 0x60 ? trailer + 6 : trailer + 16))
        if (key.length === 6 && key.every((k, i) => k === want[i])) { authSector = sector; reply([0x41, 0x00]) } else { authSector = -1; reply([0x41, 0x14]) }
      } else if (cmd === 0x30) {
        if (authSector !== sector) { reply([0x41, 0x14]); return }
        const b = Array.from(t.mem.slice(block * 16, block * 16 + 16))
        if ((block & 3) === 3) b.fill(0, 0, 6) // key A never reads back
        reply([0x41, 0x00, ...b])
      } else if (cmd === 0xa0 && d.length >= 18) {
        if (authSector !== sector) { reply([0x41, 0x14]); return }
        if (block !== 0) t.mem.set(d.slice(2, 18), block * 16)
        reply([0x41, 0x00])
      } else reply([0x41, 0x27])
      return
    }
    const page = addr
    if (cmd === 0x30) {
      if (page >= 45) { reply([0x41, 0x14]); return }
      const out: number[] = []
      for (let i = 0; i < 16; i++) out.push(t.mem[((page * 4 + i) % (45 * 4))])
      reply([0x41, 0x00, ...out])
    } else if ((cmd === 0xa2 && d.length >= 6) || (cmd === 0xa0 && d.length >= 18)) {
      if (page < 2 || page >= 45) { reply([0x41, 0x14]); return }
      t.mem.set(d.slice(2, 6), page * 4)
      reply([0x41, 0x00])
    } else reply([0x41, 0x27])
  }
  const command = (d: number[]) => {
    const [cmd, ...a] = d
    switch (cmd) {
      case 0x02: reply([0x03, 0x32, 0x01, 0x06, 0x07]); return
      case 0x14: reply([0x15]); return
      case 0x12: reply([0x13]); return
      case 0x32: if (a[0] === 0x05 && a.length >= 4) retries = a[3]; reply([0x33]); return
      case 0x0c: reply([0x0d, 0xff, 0xff, 0x00]); return
      case 0x0e: reply([0x0f]); return
      case 0x06: reply([0x07, ...Array((a.length / 2) | 0).fill(0)]); return
      case 0x08: reply([0x09]); return
      case 0x00: reply([0x01, ...a.slice(1)]); return
      case 0x44: case 0x52: active = null; reply([cmd + 1, 0x00]); return
      case 0x4a: {
        if (a[1] !== 0x00) { reply([0x4b, 0]); return } // only 106 kbps type A cards
        const t = present()
        if (t) { listed(t); return }
        if (retries === 0xff) { waiting = (tag) => { if (tag) listed(tag) }; return }
        ctx.after(0.005 * (retries + 1), () => { const tag = present(); if (tag) listed(tag); else reply([0x4b, 0]) })
        return
      }
      case 0x40: exchange(a.slice(1)); return
      default: queue.push([0x00, 0x00, 0xff, 0x01, 0xff, 0x7f, 0x81, 0x00]) // syntax error frame
    }
  }
  const received = (b: number[]) => {
    if (moduleVcc(c, ctx) <= 0) return
    let i = 0
    while (i < b.length && b[i] === 0x00 && b[i + 1] !== 0xff) i++
    if (b[i] !== 0x00 || b[i + 1] !== 0xff) return
    const len = b[i + 2], lcs = b[i + 3]
    if (len === 0xff && lcs === 0x00) { if (last) queue.unshift(last); return } // NACK: send it again
    if (len === 0x00 && lcs === 0xff) { queue = []; waiting = null; return } // ACK from the host aborts
    if (((len + lcs) & 0xff) !== 0 || b.length < i + 5 + len) return
    const body = b.slice(i + 4, i + 4 + len)
    if (body[0] !== 0xd4 || ((sum8(body) + b[i + 4 + len]) & 0xff) !== 0) return
    queue = [ACK]; waiting = null
    ctx.after(0.001, () => command(body.slice(1)))
  }
  const finishRead = () => { if (reading >= 2 && queue.length) last = queue.shift()!; reading = 0 }
  ctx.i2c(0x24, {
    start() { finishRead(); rx = [] },
    write(b) { rx.push(b) },
    read() {
      if (moduleVcc(c, ctx) <= 0) return 0
      if (reading++ === 0) return queue.length ? 0x01 : 0x00
      return queue[0]?.[reading - 2] ?? 0
    },
    stop() { finishRead(); if (rx.length) received(rx); rx = [] },
  })
  return {
    ui(u) { if (u.v?.tag !== undefined || u.v?.type !== undefined || u.v?.uid !== undefined) { const t = present(); if (!t || t !== active) active = null; if (t && waiting) { const w = waiting; waiting = null; w(t) } } },
    view: () => { const t = present(); return { text: t ? (t.kind === "classic" ? "MIFARE 1K" : "NTAG213") : "" } },
  }
}

// ── Grove Red LED Matrix w/Driver: HT16K33 (Seeed's Grove_LED_Matrix_Driver_HT16K33) ──────────
// Seeed's Matrix_8x8 puts picture column x in RAM byte 2·(7−x), row y in bit 7−y.
class Ht16k33 implements I2CDevice {
  readonly ram = new Uint8Array(16)
  osc = false
  on = false
  blink = 0
  private ptr = -1
  start() { this.ptr = -1 }
  write(b: number) {
    if (this.ptr === -1) {
      const h = b & 0xf0
      if (h === 0x00) { this.ptr = b & 15; return }
      if (h === 0x20) this.osc = !!(b & 1)
      else if (h === 0x80) { this.on = !!(b & 1); this.blink = (b >> 1) & 3 }
      this.ptr = -2
      return
    }
    if (this.ptr >= 0) { this.ram[this.ptr] = b; this.ptr = (this.ptr + 1) & 15 }
  }
  read() { return 0 }
}
function seeedMatrix(ctx: SimCtx, addr: number) {
  const h = new Ht16k33()
  return {
    devices: [[addr, h]] as [number, I2CDevice][],
    view: (): ModView => {
      const blinkHz = [0, 2, 1, 0.5][h.blink], dark = blinkHz > 0 && ((ctx.now() / ctx.hz) * blinkHz) % 1 > 0.5
      const lit = h.osc && h.on && !dark
      return { rows: Array.from({ length: 8 }, (_, y) => { let row = 0; for (let x = 0; x < 8; x++) if (lit && h.ram[2 * (7 - x)] & (0x80 >> y)) row |= 1 << x; return row }) }
    },
  }
}

// ── Grove RGB LED Matrix w/Driver (0x65): Seeed's grove_two_rgb_led_matrix command protocol ────
// one command per transaction (0x81 continues a long one); colours are a hue byte (0x00 red …
// 0xAA blue …, 0xFE white, 0xFF black). Bars, emoji, numbers and strings use Seeed's 8×8 font.
const hue = (b: number): RGB => (b === 0xfe ? [255, 255, 255] : b === 0xff ? OFF : hsv((b * 360) / 254))
const EMOJI: [number, number][] = [
  [9, 0x18], [10, 0x18], [9, 0x12], [10, 0x00], [9, 0x00], [10, 0xaa], [9, 0x52], [28, 0xaa], [10, 0xdc], [9, 0xc3], [11, 0x00], [12, 0x00],
  [11, 0xdc], [15, 0xaa], [5, 0x12], [16, 0x52], [18, 0x52], [1, 0xfe], [1, 0x12], [1, 0x7f], [27, 0x12], [14, 0x52], [13, 0xdc], [6, 0xaa],
  [23, 0x7f], [19, 0xc3], [20, 0x00], [21, 0x18], [22, 0xfe], [17, 0x18], [1, 0x52], [2, 0x52], [4, 0x52], [3, 0x52], [9, 0x7f],
]
function rgbMatrix(ctx: SimCtx, addr: number) {
  type Show = { draw: (t: number) => (x: number, y: number) => RGB; start: number; ms: number; forever: boolean } | null
  let show: Show = null, rotation = 0, offX = 0, offY = 0
  let got: number[] = [], staged: number[] | null = null, out: number[] = []
  const frames: Uint8Array[] = [], flash: Uint8Array[] = []
  const pic = new Pic8()
  const at = () => ctx.now() / ctx.hz
  const play = (ms: number, forever: boolean, draw: (t: number) => (x: number, y: number) => RGB) => { show = { draw, start: at(), ms, forever } }
  const bits = (g: number[], c: RGB) => (x: number, y: number): RGB => (g[y] & (1 << x) ? c : OFF)
  const scroll = (s: string, c: RGB) => {
    if (s.length <= 1) return () => bits(glyph(s.charCodeAt(0) || 32), c)
    const cols = [...textColumns(s), ...Array(8).fill(0)]
    return (t: number) => { const o = Math.floor(t / 0.06) % cols.length; return (x: number, y: number) => (cols[(o + x) % cols.length] & (1 << y) ? c : OFF) }
  }
  const showFrames = (list: Uint8Array[], ms: number, forever: boolean) => {
    if (!list.length) return
    play(ms * list.length, forever, (t) => { const f = list[Math.floor(t / Math.max(0.01, ms / 1000)) % list.length]; return (x, y) => hue(f[y * 8 + x]) })
  }
  const run = (d: number[]) => {
    const u16 = (i: number) => d[i] | (d[i + 1] << 8)
    switch (d[0]) {
      case 0x00: out = [0x86, 0x28, 0x05, 0x80]; break
      case 0x01: { const g = BARS[Math.min(32, d[1])], c = hue(d[5]); play(u16(2), !!d[4], () => bits(g, c)); break }
      case 0x02: { const [icon, col] = EMOJI[d[1]] ?? EMOJI[0]; play(u16(2), !!d[4], () => bits(ICONS[icon], hue(col))); break }
      case 0x03: { const n = (u16(1) << 16) >> 16; play(u16(3), !!d[5], scroll(String(n), hue(d[6]))); break }
      case 0x04: { const len = d[4], s = String.fromCharCode(...d.slice(6, 6 + len)); play(u16(2), !!d[1], scroll(s, hue(d[5]))); break }
      case 0x05: { // a 72-byte custom frame arrives in three parts
        const idx = d[5]
        frames[idx] = Uint8Array.from(d.slice(8, 72))
        if (idx === 0) showFrames(frames.slice(0, Math.max(1, d[4])).filter(Boolean), u16(1), !!d[3])
        break
      }
      case 0x06: show = null; break
      case 0x08: showFrames(flash.slice(d[4], d[5] + 1).filter(Boolean), u16(1), !!d[3]); break
      case 0x09: { const level = Math.min(32, d[1]); play(u16(2), !!d[4], () => (x, y) => (BARS[level][y] & (1 << x) ? hsv((7 - y) * 40) : OFF)); break }
      case 0x0a: { const base = hue(d[1]); play(u16(2), !!d[4], (t) => (x, y) => scale(base, 0.5 + 0.5 * Math.sin(t * 6 + (x + y) * 0.8))); break }
      case 0x0b: { const cw = d[1] ? 1 : -1, big = !!d[2]; play(u16(3), !!d[5], (t) => (x, y) => { const a = (Math.atan2(y - 3.5, x - 3.5) + Math.PI * 2.5) % (Math.PI * 2), h = (cw * t * 2 + Math.PI * 4) % (Math.PI * 2), r = Math.hypot(x - 3.5, y - 3.5); return Math.abs(a - h) < 0.5 && (big || r < 3) ? hsv((a * 180) / Math.PI) : OFF }); break }
      case 0x0c: { const fire = d[1] === 254; play(u16(3), !!d[5], (t) => (x, y) => (fire ? hsv(10 + 30 * Math.abs(Math.sin(t * 7 + x * 1.3 + y)), 1, Math.max(0, Math.min(1, (y + 2) / 9 + 0.2 * Math.sin(t * 9 + x)))) : hsv(((x + y) * 22 + t * 180) % 360))); break }
      case 0x0d: { const c: RGB = [d[1], d[2], d[3]]; play(u16(4), !!d[6], () => () => c); break }
      case 0xa0: frames.forEach((f, i) => (flash[i] = f)); break
      case 0xa1: flash.length = 0; break
      case 0xb4: rotation = d[1] & 3; break
      case 0xb5: offX = d[1] - 8; offY = d[2] - 8; break
      case 0xe2: out = [0x01, 0x00, 0x00]; break
      case 0xf1: out = Array.from({ length: 12 }, (_, i) => (addr * 31 + i * 17) & 0xff); break
    }
  }
  const dev: I2CDevice = {
    start() { got = [] },
    write(b) { got.push(b) },
    read() { return out.length ? out.shift()! : 0 },
    stop() {
      const d = got
      got = []
      if (!d.length) return
      if (d[0] === 0x81 && staged) { staged.push(...d.slice(1)) }
      else staged = d.slice()
      const s = staged
      const need = s[0] === 0x05 ? 72 : s[0] === 0x04 ? 6 + Math.min(28, s[4] ?? 0) : 0
      if (s.length >= need) { staged = null; run(s) }
    },
  }
  return {
    devices: [[addr, dev]] as [number, I2CDevice][],
    view: (): ModView => {
      const s = show
      if (s && !s.forever && s.ms > 0 && (at() - s.start) * 1000 > s.ms) show = null
      const px = show ? show.draw(at() - show.start) : () => OFF
      return pic.show((x, y) => { const [sx, sy] = rot(x - offX, y - offY, 4 - rotation); return sx < 0 || sx > 7 || sy < 0 || sy > 7 ? OFF : px(sx, sy) })
    },
  }
}

// ── M5Stack Chain bus (M5Chain library): Chain Mono / RGB 8×8 matrices ────────────────────────
// 115200 baud packets AA 55 LEN(LE) ID CMD DATA… CRC 55 AA (CRC = sum of ID, CMD, DATA). The unit
// whose RX/TX reach the board answers for the whole chain: enumeration (CMD 0xFE to ID 0xFF)
// counts the units in the chain (this one, then the other Chain units in the circuit), and a
// packet for ID n is handled by the n-th unit.
interface ChainUnit extends CatDevice { kind: "m5chain"; head: boolean; handle(cmd: number, d: number[]): number[] | null }
function chainPacket(id: number, cmd: number, data: number[]) {
  const len = data.length + 3
  return [0xaa, 0x55, len & 0xff, len >> 8, id, cmd, ...data, sum8([id, cmd, ...data]), 0x55, 0xaa]
}
function chainUnit(c: CatalogPart, ctx: SimCtx, rgb: boolean): ChainUnit {
  const buf = new Uint16Array(64) // RGB565, or 0/1 for mono
  let mode = 0, rotation = 0, bright = rgb ? 50 : 7, statusLed = 50
  let scroll = { dir: 0, mode: 0, ms: 100, color: 0xffff, text: "", state: 2, start: 0, frozen: 0 }
  const pic = new Pic8()
  const at = () => ctx.now() / ctx.hz
  const xy = (b: number) => [(b >> 3) & 7, b & 7]
  const rgb565 = (v: number): RGB => [((v >> 11) & 31) * 255 / 31 | 0, ((v >> 5) & 63) * 255 / 63 | 0, (v & 31) * 255 / 31 | 0]
  const ok = [1]
  const handle = (cmd: number, d: number[]): number[] | null => {
    switch (cmd) {
      case 0xfb: return rgb ? [0x0e, 0x00] : [0x0d, 0x00]
      case 0xfa: return [1]
      case 0xf9: return [1]
      case 0xf8: return [1, ...Array.from({ length: d[0] === 1 ? 12 : 4 }, (_, i) => (c.type.length * 13 + i * 29) & 0xff)]
      case 0xff: buf.fill(0); mode = 0; return ok
      case 0x22: statusLed = d[0] ?? statusLed; return ok
      case 0x23: return [statusLed]
      case 0x20: return ok
      case 0x21: return [1, ...Array((d[1] ?? 1) * 3).fill(0)]
      case 0x10: mode = d[0] & 1; if (mode) { scroll.start = at() } return ok
      case 0x11: return [mode]
      case 0x30: {
        const n = d[0]
        for (let i = 0; i < n; i++) {
          if (rgb) { const [x, y] = xy(d[1 + i * 3]); buf[y * 8 + x] = d[2 + i * 3] | (d[3 + i * 3] << 8) }
          else { const b = d[1 + i]; const [x, y] = xy(b); buf[y * 8 + x] = (b >> 6) & 1 }
        }
        return ok
      }
      case 0x31:
        if (rgb) for (let i = 0; i < 64; i++) buf[i] = d[i * 2] | (d[i * 2 + 1] << 8)
        else for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) buf[y * 8 + x] = (d[y] >> x) & 1
        return ok
      case 0x32: {
        const n = d[0], o: number[] = []
        for (let i = 0; i < n; i++) { const [x, y] = xy(d[1 + i]); const v = buf[y * 8 + x]; if (rgb) o.push(v & 0xff, v >> 8); else o.push(v ? 1 : 0) }
        return o
      }
      case 0x33:
        if (rgb) return Array.from(buf).flatMap((v) => [v & 0xff, v >> 8])
        return Array.from({ length: 8 }, (_, y) => { let row = 0; for (let x = 0; x < 8; x++) if (buf[y * 8 + x]) row |= 1 << x; return row })
      case 0x34: {
        const g = glyph(d[0]), ox = (d[1] >> 4) & 7, oy = d[1] & 7, col = rgb ? d[2] | (d[3] << 8) : 1
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (g[y] & (1 << x) && x + ox < 8 && y + oy < 8) buf[(y + oy) * 8 + x + ox] = col
        return ok
      }
      case 0x40: {
        const k = rgb ? 6 : 4
        scroll = { dir: d[0] >> 4, mode: d[0] & 15, ms: Math.max(10, d[1] | (d[2] << 8)), color: rgb ? d[3] | (d[4] << 8) : 0xffff, text: String.fromCharCode(...d.slice(k, k + d[k - 1])), state: 0, start: at(), frozen: 0 }
        return ok
      }
      case 0x41: { const t = [...scroll.text].map((ch) => ch.charCodeAt(0)); return rgb ? [(scroll.dir << 4) | scroll.mode, scroll.ms & 0xff, scroll.ms >> 8, scroll.color & 0xff, scroll.color >> 8, t.length, ...t] : [(scroll.dir << 4) | scroll.mode, scroll.ms & 0xff, scroll.ms >> 8, t.length, ...t] }
      case 0x42:
        if (d[0] === 1 && scroll.state === 0) scroll.frozen = (at() - scroll.start) * 1000
        if (d[0] === 0 && scroll.state === 1) scroll.start = at() - scroll.frozen / 1000
        if (d[0] === 0 && scroll.state === 2) scroll.start = at()
        scroll.state = d[0]
        return ok
      case 0x43: return [scroll.state]
      case 0xe0: rotation = d[0] & 3; return ok
      case 0xe1: return [rotation]
      case 0xe2: bright = d[0]; return ok
      case 0xe3: return [bright]
      case 0xe4: buf.fill(0); return ok
    }
    return null
  }
  /** the scrolling text's pixel at (x, y) */
  const scrollPx = (x: number, y: number): boolean => {
    if (!scroll.text || scroll.state === 2) return false
    const horiz = scroll.dir < 2
    // horizontal: one column (bits = rows) per step; vertical: the characters stacked, one row per step
    const seq = horiz ? textColumns(scroll.text) : [...scroll.text].flatMap((ch) => glyph(ch.charCodeAt(0)))
    const n = seq.length + 8
    let step = Math.floor((scroll.state === 1 ? scroll.frozen : (at() - scroll.start) * 1000) / scroll.ms)
    if (scroll.mode === 0) step = Math.min(step, n)
    else if (scroll.mode === 2) { const p = 2 * n; step %= p; if (step > n) step = p - step } else step %= n
    const along = horiz ? x : y, across = horiz ? y : x
    const idx = scroll.dir === 0 || scroll.dir === 2 ? along + step - 8 : along - step + seq.length
    const v = seq[idx]
    return v !== undefined && !!(v & (1 << across))
  }
  const dev: ChainUnit = {
    kind: "m5chain",
    head: !!(ctx.pin("RX") || ctx.pin("TX")),
    handle,
    view: () => {
      const on = moduleVcc(c, ctx) > 0
      const level = rgb ? bright / 100 : [0, 0.031, 0.062, 0.125, 0.25, 0.44, 0.69, 0.97][bright & 7] ?? 1
      const lit = Math.min(1, level * 1.2 + (level > 0 ? 0.25 : 0))
      return pic.show((x, y) => {
        if (!on) return OFF
        const [sx, sy] = rot(x, y, 4 - rotation)
        if (mode === 1) return scrollPx(sx, sy) ? scale(rgb ? rgb565(scroll.color) : [255, 255, 255], lit) : OFF
        const v = buf[sy * 8 + sx]
        return v ? scale(rgb ? rgb565(v) : [255, 255, 255], lit) : OFF
      })
    },
  }
  if (dev.head) {
    let inb: number[] = []
    let port: UartPort | null = null
    port = ctx.uart({
      baud: 115200,
      onByte: (b) => {
        if (moduleVcc(c, ctx) <= 0) return
        inb.push(b)
        if (inb.length > 600) inb = inb.slice(-300)
        for (;;) {
          const h = inb.findIndex((x, i) => x === 0xaa && inb[i + 1] === 0x55)
          if (h < 0) { inb = inb.slice(-1); return }
          if (h > 0) inb = inb.slice(h)
          if (inb.length < 4) return
          const size = 4 + (inb[2] | (inb[3] << 8)) + 2
          if (size < 9 || size > 300) { inb = inb.slice(1); continue }
          if (inb.length < size) return
          const p = inb.slice(0, size)
          if (p[size - 2] !== 0x55 || p[size - 1] !== 0xaa || sum8(p.slice(4, size - 3)) !== p[size - 3]) { inb = inb.slice(1); continue }
          inb = inb.slice(size)
          const id = p[4], cmd = p[5], data = p.slice(6, size - 3)
          const units = [dev, ...ctx.peers("m5chain").filter((u) => u !== dev && !(u as ChainUnit).head)] as ChainUnit[]
          let ans: number[] | null = null
          if (id === 0xff && cmd === 0xfd) ans = []
          else if (id === 0xff && cmd === 0xfe) ans = [units.length]
          else ans = units[id - 1]?.handle(cmd, data) ?? null
          if (ans) { const out = chainPacket(id, cmd, ans); ctx.after(0.0003, () => port?.send(out)) }
        }
      },
    })
  }
  return dev
}

// ── Seeed COB LED Driver Board for XIAO ───────────────────────────────────────────────────────
// VCC port always on; D0, D1 high-power MOSFET switches (active high); D2, D3, D8, D9 dimmable
// low-power ports (active low PWM — analogWrite(pin, 255 − brightness)).
const COB: [string | null, boolean][] = [[null, false], ["D0", false], ["D1", false], ["D2", true], ["D3", true], ["D8", true], ["D9", true]]
function cobLed(c: CatalogPart, ctx: SimCtx): CatDevice {
  const duty = (pin: string): number | null => {
    const tr = ctx.track(ctx.pin(pin))
    if (!tr || tr.out === null) return null
    const now = ctx.now()
    if (tr.period > 0 && now - tr.lastChange < tr.period * 3) return clamp(tr.pulse / tr.period, 0, 1)
    return tr.out ? 1 : 0
  }
  const level = () => COB.map(([pin, low]) => {
    if (moduleVcc(c, ctx) <= 0) return 0
    if (!pin) return 1
    const d = duty(pin)
    if (d === null) return 0
    return low ? 1 - d : d >= 0.5 ? 1 : 0 // D0/D1 are plain switches
  })
  return { view: () => ({ pix: level().map((v) => [Math.round(255 * v), Math.round(214 * v), Math.round(170 * v)] as RGB) }) }
}

// ── Grove Recorder v3.0 (ISD9160): SIG = PLAY (LOW pulse plays), SIG2 = REC (LOW records) ─────
function recorder(c: CatalogPart, ctx: SimCtx): CatDevice {
  let recAt = -1, length = 0, playAt = -1, pressAt = -1
  const t = () => ctx.now() / ctx.hz
  const powered = () => moduleVcc(c, ctx) > 0
  const startRec = () => { if (powered() && recAt < 0) { recAt = t(); playAt = -1 } }
  const stopRec = () => { if (recAt >= 0) { length = Math.min(83, t() - recAt); recAt = -1 } }
  const play = () => { if (powered() && recAt < 0 && length > 0) playAt = t() }
  const playing = () => playAt >= 0 && t() - playAt < length
  const rec = ctx.pin("SIG2"), pl = ctx.pin("SIG")
  ctx.hook(rec, () => { const lo = ctx.track(rec)?.out === false; if (lo) startRec(); else stopRec() })
  let plLow = false
  ctx.hook(pl, () => { const lo = ctx.track(pl)?.out === false; if (lo && !plLow) play(); plLow = lo })
  return {
    ui(u) {
      const b = u.v?.button
      if (b === undefined) return
      if (b >= 0.5) { pressAt = t(); ctx.after(2, () => { if (pressAt >= 0 && t() - pressAt >= 1.99) startRec() }) }
      else { if (recAt >= 0) stopRec(); else if (pressAt >= 0) play(); pressAt = -1 }
    },
    tone() {
      if (!playing()) return 0
      const s = t() - playAt // a voice-like pitch contour: syllables of ~0.2 s
      const syl = Math.floor(s / 0.22), ph = (s % 0.22) / 0.22
      if (ph > 0.85) return 0
      return Math.round(170 + 60 * Math.sin(syl * 2.3) + 50 * Math.sin(ph * Math.PI) + 15 * Math.sin(s * 40))
    },
    view: () => ({ glow: [recAt >= 0 ? 1 : playing() ? 0.6 : 0], text: recAt >= 0 ? `REC ${(t() - recAt).toFixed(1)} s` : playing() ? "PLAY" : length > 0 ? `${length.toFixed(1)} s` : "" }),
  }
}

// ── Grove 12-Channel Capacitive Touch Keypad (ATtiny1616): one byte per key at 9600 baud ──────
const KEY_NAMES = ["", "1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"]
function touchKeypad(c: CatalogPart, ctx: SimCtx): CatDevice {
  const port = ctx.uart({ baud: 9600 })
  let shown = ""
  return {
    ui(u) {
      const k = u.v?.key
      if (k === undefined) return
      const n = Math.round(k)
      if (n >= 1 && n <= 12 && moduleVcc(c, ctx) > 0) { port.send([0xe0 + n]); shown = KEY_NAMES[n] }
    },
    view: () => ({ text: shown }),
  }
}

// ── Grove Capacitive Fingerprint Scanner (KCT202, Seeed_Arduino_KCT202) at 57600 baud ─────────
// packets EF 01 ADDR(4) PID LEN(2) DATA… SUM(2); auto-register (0x31) collects N captures of the
// finger on the pad, auto-verify (0x32) matches it against the stored templates.
function kct202(c: CatalogPart, ctx: SimCtx): CatDevice {
  const templates = new Map<number, number>() // template ID → finger number
  let pass = 0
  let led = { fn: 4, color: 0 }
  let job: { kind: "reg" | "ver"; id: number; need: number; got: number; param: number; since: number } | null = null
  const port = ctx.uart({ baud: 57600, onByte: (b) => rx(b) })
  let inb: number[] = []
  const send = (confirm: number, params: number[] = []) => {
    const len = params.length + 3, body = [0x07, len >> 8, len & 0xff, confirm, ...params]
    const s = body.reduce((a, x) => a + x, 0) & 0xffff
    const pkt = [0xef, 0x01, 0xff, 0xff, 0xff, 0xff, ...body, s >> 8, s & 0xff]
    ctx.after(0.003, () => port.send(pkt))
  }
  const finger = () => (moduleVcc(c, ctx) > 0 ? Math.round(ctx.ctl("finger")) : 0)
  const command = (d: number[]) => {
    const [cmd, ...a] = d
    switch (cmd) {
      case 0x31: job = { kind: "reg", id: (a[0] << 8) | a[1], need: Math.max(1, a[2] || 1), got: 0, param: (a[3] << 8) | a[4], since: -1 }; return
      case 0x32: job = { kind: "ver", id: (a[1] << 8) | a[2], need: 1, got: 0, param: (a[3] << 8) | a[4], since: -1 }; return
      case 0x0c: { const id = (a[0] << 8) | a[1], n = (a[2] << 8) | a[3]; for (let i = 0; i < Math.max(1, n); i++) templates.delete(id + i); send(0x00); return }
      case 0x0d: templates.clear(); send(0x00); return
      case 0x33: send(0x00); return
      case 0x1d: send(0x00, [templates.size >> 8, templates.size & 0xff]); return
      case 0x1f: { const page = a[0] ?? 0, map = Array(32).fill(0); for (const id of templates.keys()) if (id >> 8 === page) map[(id & 255) >> 3] |= 1 << (id & 7); send(0x00, map); return }
      case 0x12: pass = ((a[0] << 24) | (a[1] << 16) | (a[2] << 8) | a[3]) >>> 0; send(0x00); return
      case 0x13: send((((a[0] << 24) | (a[1] << 16) | (a[2] << 8) | a[3]) >>> 0) === pass ? 0x00 : 0x13); return
      case 0x30: job = null; send(0x00); return
      case 0x3c: led = { fn: a[0], color: a[1] }; send(0x00); return
      case 0x0e: send(0x00); return
      default: send(0x01)
    }
  }
  function rx(b: number) {
    if (moduleVcc(c, ctx) <= 0) return
    inb.push(b)
    while (inb.length >= 2 && !(inb[0] === 0xef && inb[1] === 0x01)) inb.shift()
    if (inb.length < 9) return
    const len = (inb[7] << 8) | inb[8]
    if (inb.length < 9 + len) return
    const p = inb.splice(0, 9 + len)
    const s = p.slice(6, 7 + len).reduce((a, x) => a + x, 0) & 0xffff
    if (s !== ((p[7 + len] << 8) | p[8 + len])) return
    if (p[6] === 0x01) command(p.slice(9, 7 + len))
  }
  const tick = () => {
    ctx.after(0.05, tick)
    if (!job) return
    const f = finger(), now = ctx.now() / ctx.hz
    if (f <= 0) { job.since = -1; return }
    if (job.since < 0) job.since = now
    if (now - job.since < 0.5) return
    job.since = now
    if (job.kind === "ver") {
      let found = -1
      for (const [id, fg] of templates) if (fg === f && (job.id === 0xffff || job.id === id)) { found = id; break }
      job = null
      if (found >= 0) send(0x00, [0x05, found >> 8, found & 0xff, 0x00, 0x64]); else send(0x09, [0x05, 0, 0, 0, 0])
      return
    }
    job.got++
    if (!(job.param & 0x04)) send(0x00, [0x02, job.got])
    if (job.got < job.need) return
    const j = job
    job = null
    if (templates.has(j.id) && !(j.param & 0x08)) { send(0x22, [0x06, 0xf2]); return }
    if (j.param & 0x10 && [...templates.values()].includes(f)) { send(0x27, [0x06, 0xf2]); return }
    templates.set(j.id, f)
    send(0x00, [0x06, 0xf2])
  }
  ctx.after(0.05, tick)
  const COL = ["off", "blue", "green", "cyan", "red", "purple", "yellow", "white"]
  return { view: () => ({ text: moduleVcc(c, ctx) > 0 && led.fn !== 4 && led.color ? `${COL[led.color & 7]} ${["", "breath", "blink", "on"][led.fn] ?? ""}` : "" }) }
}

// ── Grove Ultrasonic Sensor (SMS812) on UART, 115200 baud (SeeedStudio_SMS812_Sensor) ─────────
// commands AA AA CMD 01 00 SUM: F8 IO mode, FE UART mode (100 Hz reports), FA request mode,
// FC request one report. Reports AA AA FD 04 MATERIAL DIST_L DIST_H STRENGTH SUM (mm).
function sms812(c: CatalogPart, ctx: SimCtx): CatDevice {
  let mode: "io" | "uart" | "req" = "uart"
  let inb: number[] = []
  const report = () => {
    const mm = Math.round(clamp(ctx.ctl("mm"), 0, 65535)), soft = ctx.ctl("soft") >= 0.5 ? 1 : 0
    const strength = clamp(Math.round(240 - mm / 25 - soft * 60), 5, 255)
    const f = [0xaa, 0xaa, 0xfd, 0x04, soft, mm & 0xff, mm >> 8, strength]
    port.send([...f, sum8(f)])
  }
  const port = ctx.uart({
    baud: 115200,
    onByte: (b) => {
      if (moduleVcc(c, ctx) <= 0) return
      inb.push(b)
      while (inb.length >= 2 && !(inb[0] === 0xaa && inb[1] === 0xaa)) inb.shift()
      if (inb.length < 6) return
      const p = inb.splice(0, 6)
      if (sum8(p.slice(0, 5)) !== p[5]) return
      if (p[2] === 0xf8) mode = "io"
      else if (p[2] === 0xfe) mode = "uart"
      else if (p[2] === 0xfa) mode = "req"
      else if (p[2] === 0xfc && mode !== "io") ctx.after(0.002, report)
    },
  })
  const tick = () => {
    ctx.after(0.01, tick)
    if (moduleVcc(c, ctx) <= 0) return
    if (mode === "uart") report()
    else if (mode === "io") ctx.drive("TX", { v: ctx.ctl("soft") >= 0.5 ? moduleVcc(c, ctx) : 0, r: 100 })
  }
  ctx.after(0.05, tick)
  return { view: () => ({ text: moduleVcc(c, ctx) > 0 ? `${Math.round(ctx.ctl("mm"))} mm` : "" }) }
}

const group: ModelGroup = {
  proto: {
    pag7660,
    "rgb-encoder-wheel": encoderWheel,
    pn532,
    "m5chain-mono": (c, ctx) => chainUnit(c, ctx, false),
    "m5chain-rgb": (c, ctx) => chainUnit(c, ctx, true),
    "xiao-cob": cobLed,
    "recorder-v3": recorder,
    "touch-keypad-12": touchKeypad,
    kct202,
    sms812,
  },
  chips: {
    "seeed-ht16k33-matrix": (ctx, addr) => seeedMatrix(ctx, addr),
    "seeed-rgb-matrix": (ctx, addr) => rgbMatrix(ctx, addr),
  },
}
export default group
