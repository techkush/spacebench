// Models: spi-sensors — SPI parts modelled at the register / protocol level so the usual
// Arduino libraries work unchanged:
//  - max31856  MAX31856 universal thermocouple converter (Adafruit_MAX31856)
//  - max31865  MAX31865 RTD-to-digital converter, PT100 / PT1000 (Adafruit_MAX31865)
//  - sdcard    a microSD card in SPI mode (SDHC, block addressing) holding a real FAT16
//              volume, pre-formatted with a README.TXT (the Arduino SD library, SdFat)
// See ./index.ts for the API.
import type { CatalogPart } from "../types"
import type { CatDevice, SimCtx } from "../devices"
import type { ModelGroup } from "./types"

/** the supply on the part's power pin (0 when unpowered or not wired) */
function power(c: CatalogPart, ctx: SimCtx): number {
  for (const p of ["VIN", "VCC", "VDD", "3V3", "5V"]) if (c.pins.includes(p)) { const v = ctx.supply(p); if (v > 0) return v }
  return 0
}
const s8 = (v: number) => (v & 0x80 ? v - 0x100 : v)
const s16 = (v: number) => (v & 0x8000 ? v - 0x10000 : v)

// ── MAX31856 ──────────────────────────────────────────────────────────────────────────────
// Registers (read 0x00–0x0F, write 0x80–0x8B), auto-incrementing on multi-byte transfers:
// CR0 CR1 MASK CJHF CJLF LTHFTH LTHFTL LTLFTH LTLFTL CJTO CJTH CJTL LTCBH LTCBM LTCBL SR.
const TC_RANGE: Record<number, [number, number]> = { 0: [250, 1820], 1: [-200, 1000], 2: [-210, 1200], 3: [-200, 1372], 4: [-200, 1300], 5: [-50, 1768], 6: [-50, 1768], 7: [-200, 400] }
const TC_NAME = "BEJKNRST"

function max31856(c: CatalogPart, ctx: SimCtx): CatDevice {
  const R = new Uint8Array(16)
  const reset = () => { R.fill(0); R.set([0x00, 0x03, 0xff, 0x7f, 0xc0, 0x7f, 0xff, 0x80, 0x00, 0x00], 0) }
  reset()
  let addr = -1, write = false, wroteCr0 = false, converting = false, powered = false
  let sr = 0 // latched faults (interrupt mode)

  const hot = () => ctx.ctl("t")
  /** the cold junction: the die temperature plus the CJTO offset, or the host's CJTH/CJTL when CJ is disabled */
  const cold = () => (R[0] & 0x08 ? s16((R[10] << 8) | R[11]) / 256 : ctx.ctl("cj") + s8(R[9]) / 16)
  const open = () => ctx.ctl("open") >= 0.5
  /** the fault bits for the present conditions */
  const faults = () => {
    const t = hot(), cj = cold(), type = R[1] & 0x0f
    let f = 0
    const rng = TC_RANGE[type]
    if (cj < -55 || cj > 125) f |= 0x80
    if (rng && (t < rng[0] || t > rng[1])) f |= 0x40
    if (cj > s8(R[3])) f |= 0x20
    if (cj < s8(R[4])) f |= 0x10
    if (t > s16((R[5] << 8) | R[6]) / 16) f |= 0x08
    if (t < s16((R[7] << 8) | R[8]) / 16) f |= 0x04
    if ((R[0] & 0x30) && open()) f |= 0x01
    return f
  }
  /** one conversion: the linearized, cold-junction-compensated temperature into LTC and CJT */
  const convert = () => {
    const cj = cold(), type = R[1] & 0x0f
    if (!(R[0] & 0x08)) { const w = (Math.round(cj * 64) << 2) & 0xffff; R[10] = w >> 8; R[11] = w & 0xff }
    const f = faults()
    sr = R[0] & 0x04 ? sr | f : f
    if (f & 0x01) return // an open thermocouple: the last reading stays
    let code: number
    if (type & 0x08) {
      // voltage modes (gain 8 / 32): the thermocouple EMF (a type-K-like 41 µV/°C) scaled
      const gain = type & 0x04 ? 32 : 8
      code = Math.round((hot() - cj) * 41e-6 * gain * 1.6 * 2 ** 17)
    } else code = Math.round(hot() / 0.0078125)
    code = Math.max(-(2 ** 18), Math.min(2 ** 18 - 1, code))
    const w = (code << 5) & 0xffffff
    R[12] = w >> 16; R[13] = (w >> 8) & 0xff; R[14] = w & 0xff
  }
  const auto = () => (R[0] & 0x80) !== 0
  const read = (a: number): number => {
    if (a === 15) { if (auto()) { const f = faults(); sr = R[0] & 0x04 ? sr | f : f }; return sr }
    if (auto() && a >= 10 && a <= 14) convert()
    return R[a]
  }
  const writeReg = (a: number, v: number) => {
    if (a > 0x0b || (a >= 0x0a && !(R[0] & 0x08))) return // read-only (CJT writable only with the CJ sensor off)
    if (a === 0) {
      if (v & 0x02) sr = 0 // FAULTCLR, self-clearing
      v &= ~0x02
      if (converting) v |= 0x40
      wroteCr0 = true
    }
    R[a] = v
  }
  ctx.spi({
    mode: 1,
    select: () => { addr = -1; write = false; wroteCr0 = false; powered = power(c, ctx) > 0 },
    deselect: () => {
      // a one-shot conversion starts when CS goes high
      if (wroteCr0 && !auto() && R[0] & 0x40 && !converting) {
        converting = true
        const hz50 = R[0] & 0x01, avg = 1 << Math.min(4, (R[1] >> 4) & 7)
        const ms = (hz50 ? 169 : 143) + (avg - 1) * (hz50 ? 40 : 33.33)
        ctx.after(ms / 1000, () => { converting = false; convert(); R[0] &= ~0x40 })
      }
    },
    out: () => (!powered || addr < 0 || write ? 0xff : read(addr & 0x0f)),
    in: (b) => {
      if (!powered) return
      if (addr < 0) { write = (b & 0x80) !== 0; addr = b & 0x7f; return }
      if (write) writeReg(addr & 0x0f, b)
      addr = (addr + 1) & 0x0f
    },
  })
  return {
    view: () => {
      if (power(c, ctx) <= 0) return undefined
      if ((R[0] & 0x30) && open()) return { text: "OPEN" }
      const type = R[1] & 0x0f
      return { text: `${type & 0x08 ? "V" : TC_NAME[type] ?? "?"} ${hot().toFixed(1)}°C` }
    },
  }
}

// ── MAX31865 ──────────────────────────────────────────────────────────────────────────────
// Registers: 00 config, 01/02 RTD MSB/LSB (bit 0 = fault), 03/04 high fault threshold,
// 05/06 low fault threshold, 07 fault status. Writes at 0x80–0x86.
const CVD_A = 3.9083e-3, CVD_B = -5.775e-7, CVD_C = -4.183e-12
/** Callendar–Van Dusen: an RTD's resistance at t °C */
export function rtdOhms(t: number, r0: number): number {
  return r0 * (1 + CVD_A * t + CVD_B * t * t + (t < 0 ? CVD_C * (t - 100) * t * t * t : 0))
}

function max31865(c: CatalogPart, ctx: SimCtx): CatDevice {
  const R = new Uint8Array(8)
  R.set([0x00, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00, 0x00])
  let addr = -1, write = false, wroteCfg = false, converting = false, powered = false

  const r0 = () => (ctx.ctl("r0") >= 550 ? 1000 : 100)
  const rref = () => Math.max(1, ctx.ctl("rref"))
  const fault = () => Math.round(ctx.ctl("fault")) // 0 none, 1 open, 2 short
  const ohms = () => (fault() === 1 ? Infinity : fault() === 2 ? 0 : rtdOhms(ctx.ctl("t"), r0()))
  const convert = () => {
    let code = 0
    if (R[0] & 0x80) code = Math.max(0, Math.min(0x7fff, Math.round((ohms() / rref()) * 32768)))
    const hi = ((R[3] << 8) | R[4]) >> 1, lo = ((R[5] << 8) | R[6]) >> 1
    if (code >= hi) R[7] |= 0x80
    if (code <= lo) R[7] |= 0x40
    const w = (code << 1) | (R[7] ? 1 : 0)
    R[1] = w >> 8; R[2] = w & 0xff
  }
  const auto = () => (R[0] & 0xc0) === 0xc0
  const writeReg = (a: number, v: number) => {
    if (a === 0) {
      if (v & 0x02) R[7] = 0 // fault status clear, self-clearing
      v &= ~0x02
      if ((v & 0x0c) === 0x04 || (v & 0x0c) === 0x08) {
        // a fault detection cycle (automatic, or manual first step): it checks the input voltages
        ctx.after(100e-6, () => { if (fault() === 1) R[7] |= 0x08; if ((R[0] & 0x0c) === 0x04) R[0] &= ~0x0c })
      }
      if ((v & 0x0c) === 0x0c) { if (fault() === 1) R[7] |= 0x08; v &= ~0x0c } // manual cycle finished
      if (converting) v |= 0x20
      wroteCfg = true
      R[0] = v
    } else if (a >= 3 && a <= 6) R[a] = v
  }
  ctx.spi({
    mode: 1,
    select: () => { addr = -1; write = false; wroteCfg = false; powered = power(c, ctx) > 0 },
    deselect: () => {
      // a 1-shot conversion starts when CS goes high (52 ms at 60 Hz, 62.5 ms at 50 Hz)
      if (wroteCfg && R[0] & 0x20 && !converting && !auto()) {
        converting = true
        ctx.after(R[0] & 0x01 ? 0.0625 : 0.052, () => { converting = false; convert(); R[0] &= ~0x20 })
      }
    },
    out: () => {
      if (!powered || addr < 0 || write) return 0xff
      const a = addr & 7
      if (auto() && (a === 1 || a === 2)) { if (a === 1) convert() }
      return R[a]
    },
    in: (b) => {
      if (!powered) return
      if (addr < 0) { write = (b & 0x80) !== 0; addr = b & 0x7f; return }
      if (write) writeReg(addr & 7, b)
      addr = (addr + 1) & 7
    },
  })
  return {
    view: () => {
      if (power(c, ctx) <= 0) return undefined
      const f = fault()
      return { text: f === 1 ? "OPEN" : f === 2 ? "SHORT" : `PT${r0()} ${ohms().toFixed(1)}Ω` }
    },
  }
}

// ── microSD card (SPI mode) ───────────────────────────────────────────────────────────────
const BLOCKS = 262144 // 128 MiB
const PART_START = 2048
const SPC = 8 // sectors per cluster (4 KiB)
const RESERVED = 1, ROOT_ENTRIES = 512, ROOT_SECTORS = (ROOT_ENTRIES * 32) / 512

function crc16(d: Uint8Array): number {
  let crc = 0
  for (const b of d) { crc ^= b << 8; for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff }
  return crc
}
function crc7(d: number[]): number {
  let crc = 0
  for (const b of d) for (let i = 7; i >= 0; i--) { const bit = ((b >> i) & 1) ^ ((crc >> 6) & 1); crc = (crc << 1) & 0x7f; if (bit) crc ^= 0x09 }
  return (crc << 1) | 1
}
const le16 = (a: Uint8Array, o: number, v: number) => { a[o] = v & 0xff; a[o + 1] = (v >> 8) & 0xff }
const le32 = (a: Uint8Array, o: number, v: number) => { le16(a, o, v & 0xffff); le16(a, o + 2, (v >>> 16) & 0xffff) }
const ascii = (a: Uint8Array, o: number, s: string) => { for (let i = 0; i < s.length; i++) a[o + i] = s.charCodeAt(i) }

/** a sparse 512-byte block store holding an MBR and a FAT16 volume */
export class SdImage {
  readonly blocks = new Map<number, Uint8Array>()
  readonly total = BLOCKS
  readonly fatStart: number
  readonly fatSize: number
  readonly rootStart: number
  readonly dataStart: number
  constructor(files: Record<string, string> = {}) {
    const vol = BLOCKS - PART_START
    let fat = 1
    for (let i = 0; i < 8; i++) { const clusters = Math.floor((vol - RESERVED - ROOT_SECTORS - 2 * fat) / SPC); fat = Math.ceil(((clusters + 2) * 2) / 512) }
    this.fatSize = fat
    this.fatStart = PART_START + RESERVED
    this.rootStart = this.fatStart + 2 * fat
    this.dataStart = this.rootStart + ROOT_SECTORS
    // MBR with one FAT16 (LBA) partition
    const mbr = this.block(0)
    mbr[446] = 0x00; mbr.set([0x20, 0x21, 0x00], 447); mbr[450] = 0x06; mbr.set([0xfe, 0xff, 0xff], 451)
    le32(mbr, 454, PART_START); le32(mbr, 458, vol); mbr[510] = 0x55; mbr[511] = 0xaa
    // boot sector / BPB
    const bs = this.block(PART_START)
    bs.set([0xeb, 0x3c, 0x90]); ascii(bs, 3, "SPCBENCH")
    le16(bs, 11, 512); bs[13] = SPC; le16(bs, 14, RESERVED); bs[16] = 2; le16(bs, 17, ROOT_ENTRIES); le16(bs, 19, 0)
    bs[21] = 0xf8; le16(bs, 22, fat); le16(bs, 24, 63); le16(bs, 26, 255); le32(bs, 28, PART_START); le32(bs, 32, vol)
    bs[36] = 0x80; bs[38] = 0x29; le32(bs, 39, 0x5bc0ffee); ascii(bs, 43, "SPACEBENCH "); ascii(bs, 54, "FAT16   ")
    bs[510] = 0x55; bs[511] = 0xaa
    // FATs: media + end-of-chain
    this.setFat(0, 0xfff8); this.setFat(1, 0xffff)
    // root: the volume label, then the files
    const root = this.block(this.rootStart)
    ascii(root, 0, "SPACEBENCH "); root[11] = 0x08
    let next = 2, slot = 1
    const date = ((2026 - 1980) << 9) | (1 << 5) | 1, time = 12 << 11
    for (const [name, text] of Object.entries(files)) {
      const data = new TextEncoder().encode(text)
      const [base, ext = ""] = name.toUpperCase().split(".")
      const e = slot * 32
      ascii(root, e, base.padEnd(8).slice(0, 8)); ascii(root, e + 8, ext.padEnd(3).slice(0, 3)); root[e + 11] = 0x20
      le16(root, e + 14, time); le16(root, e + 16, date); le16(root, e + 18, date); le16(root, e + 22, time); le16(root, e + 24, date)
      const n = Math.max(1, Math.ceil(data.length / (SPC * 512)))
      le16(root, e + 26, data.length ? next : 0); le32(root, e + 28, data.length)
      if (data.length) {
        for (let k = 0; k < n; k++) this.setFat(next + k, k === n - 1 ? 0xffff : next + k + 1)
        for (let o = 0; o < data.length; o += 512) this.block(this.dataStart + (next - 2) * SPC + o / 512).set(data.subarray(o, o + 512))
        next += n
      }
      slot++
    }
  }
  private setFat(i: number, v: number) {
    for (const f of [0, 1]) { const b = this.block(this.fatStart + f * this.fatSize + ((i * 2) >> 9)); le16(b, (i * 2) & 511, v) }
  }
  /** the block, created on first touch */
  block(n: number): Uint8Array {
    let b = this.blocks.get(n)
    if (!b) { b = new Uint8Array(512); this.blocks.set(n, b) }
    return b
  }
  read(n: number): Uint8Array { return this.blocks.get(n) ?? new Uint8Array(512) }
  write(n: number, d: Uint8Array) { this.blocks.set(n, d.slice(0, 512)) }
  /** the root directory's files (8.3 names) */
  files(): string[] {
    const out: string[] = []
    for (let s = 0; s < ROOT_SECTORS; s++) {
      const b = this.blocks.get(this.rootStart + s)
      if (!b) continue
      for (let e = 0; e < 512; e += 32) {
        if (b[e] === 0) return out
        if (b[e] === 0xe5 || b[e + 11] === 0x0f || b[e + 11] & 0x08) continue
        const name = String.fromCharCode(...b.subarray(e, e + 8)).trimEnd(), ext = String.fromCharCode(...b.subarray(e + 8, e + 11)).trimEnd()
        out.push(ext ? `${name}.${ext}` : name)
      }
    }
    return out
  }
}

const README = "Space Bench virtual microSD card (128 MB, FAT16).\r\nFiles your sketch writes here last while the simulation runs.\r\n"

/** CSD v2.0 (SDHC): 512-byte blocks, C_SIZE from the card size */
function csd(): number[] {
  const cs = BLOCKS / 1024 - 1
  const r = [0x40, 0x0e, 0x00, 0x32, 0x5b, 0x59, 0x00, (cs >> 16) & 0x3f, (cs >> 8) & 0xff, cs & 0xff, 0x7f, 0x80, 0x0a, 0x40, 0x00]
  return [...r, crc7(r)]
}
function cid(): number[] {
  const r = [0x1b, 0x53, 0x42, 0x53, 0x50, 0x41, 0x43, 0x45, 0x10, 0x12, 0x34, 0x56, 0x78, 0x01, 0x9a]
  return [...r, crc7(r)]
}

function sdcard(c: CatalogPart, ctx: SimCtx): CatDevice {
  const img = new SdImage({ "README.TXT": README })
  let queue: number[] = [] // bytes for MISO
  let busy = 0 // busy (0x00) bytes after a write
  let cmd: number[] = [] // a command frame being received
  let state: "idle" | "token" | "data" | "mtoken" | "mdata" | "mread" = "idle"
  let spiMode = false, idle = true, app = false, acmd41 = 0
  let wrBlock = 0, wrBuf: number[] = [], mrBlock = 0
  let powered = false, inserted = true, lastAct = -1e12, filesVer = -1, fileCount = 0, ver = 0
  let eraseFrom = 0, eraseTo = 0

  const reset = () => { queue = []; busy = 0; cmd = []; state = "idle"; spiMode = false; idle = true; app = false; acmd41 = 0 }
  const present = () => ctx.ctl("card") >= 0.5
  const check = () => {
    const p = present()
    if (p !== inserted) { inserted = p; reset() }
    return inserted && powered
  }
  const blockOut = (n: number) => { const d = img.read(n); const crc = crc16(d); queue.push(0xff, 0xfe, ...d, crc >> 8, crc & 0xff); lastAct = ctx.now() }
  const r1 = (extra = 0) => (idle ? 0x01 : 0x00) | extra
  const command = (f: number[]) => {
    const n = f[0] & 0x3f, arg = ((f[1] << 24) | (f[2] << 16) | (f[3] << 8) | f[4]) >>> 0
    const isApp = app
    app = false
    queue = [0xff] // N_CR: one byte before the response
    if (!spiMode && n !== 0) return void (queue = []) // not in SPI mode yet: silent
    if (isApp) {
      switch (n) {
        case 41: // SD_SEND_OP_COND: idle for a couple of polls, then ready
          if (++acmd41 >= 2) idle = false
          queue.push(r1()); return
        case 13: { queue.push(r1(), 0x00); const d = new Uint8Array(64); const crc = crc16(d); queue.push(0xff, 0xfe, ...d, crc >> 8, crc & 0xff); return } // SD_STATUS
        case 22: { queue.push(r1()); const d = new Uint8Array([0, 0, 0, 0]); const crc = crc16(d); queue.push(0xff, 0xfe, ...d, crc >> 8, crc & 0xff); return }
        case 23: case 42: queue.push(r1()); return
        case 51: { queue.push(r1()); const d = new Uint8Array([0x02, 0x35, 0x80, 0x00, 0, 0, 0, 0]); const crc = crc16(d); queue.push(0xff, 0xfe, ...d, crc >> 8, crc & 0xff); return } // SCR
        default: break // other ACMDs fall through as normal commands
      }
    }
    const inRange = (b: number) => b < img.total
    switch (n) {
      case 0: spiMode = true; idle = true; acmd41 = 0; state = "idle"; queue.push(0x01); return
      case 8: queue.push(r1(), 0x00, 0x00, (arg >> 8) & 0x0f, arg & 0xff); return
      case 55: app = true; queue.push(r1()); return
      case 58: queue.push(r1(), idle ? 0x40 : 0xc0, 0xff, 0x80, 0x00); return // OCR: CCS (SDHC), power-up done once ready
      case 59: case 16: queue.push(r1()); return
      case 1: if (++acmd41 >= 2) idle = false; queue.push(r1()); return
    }
    if (idle) { queue.push(0x05); return } // illegal while initialising
    switch (n) {
      case 9: case 10: { const d = new Uint8Array(n === 9 ? csd() : cid()); const crc = crc16(d); queue.push(0x00, 0xff, 0xfe, ...d, crc >> 8, crc & 0xff); return }
      case 13: queue.push(0x00, 0x00); return
      case 12: state = "idle"; queue.push(0x00); busy = 2; return
      case 17: if (!inRange(arg)) { queue.push(0x40); return } queue.push(0x00); blockOut(arg); return
      case 18: if (!inRange(arg)) { queue.push(0x40); return } queue.push(0x00); mrBlock = arg; state = "mread"; return
      case 24: if (!inRange(arg)) { queue.push(0x40); return } queue.push(0x00); wrBlock = arg; state = "token"; return
      case 25: if (!inRange(arg)) { queue.push(0x40); return } queue.push(0x00); wrBlock = arg; state = "mtoken"; return
      case 32: eraseFrom = arg; queue.push(0x00); return
      case 33: eraseTo = arg; queue.push(0x00); return
      case 38: for (let b = eraseFrom; b <= eraseTo && b < img.total; b++) img.blocks.delete(b); queue.push(0x00); busy = 8; lastAct = ctx.now(); return
      default: queue.push(0x04) // illegal command
    }
  }
  ctx.spi({
    select: () => { powered = power(c, ctx) > 0; if (!powered) reset() },
    deselect: () => { queue = []; cmd = []; if (state === "mread") state = "idle" },
    out: () => {
      if (!check()) return 0xff
      if (!queue.length && !cmd.length && state === "mread") { blockOut(mrBlock); mrBlock = (mrBlock + 1) % img.total }
      if (queue.length) return queue.shift()!
      if (busy > 0) { busy--; return 0x00 }
      return 0xff
    },
    in: (b) => {
      if (!check()) return
      if (cmd.length) { cmd.push(b); if (cmd.length === 6) { const f = cmd; cmd = []; command(f) } return }
      if (state === "data" || state === "mdata") {
        wrBuf.push(b)
        if (wrBuf.length === 514) {
          img.write(wrBlock, new Uint8Array(wrBuf.slice(0, 512))); lastAct = ctx.now(); ver++
          wrBuf = []
          queue = [0xe5]; busy = 4 // data accepted, then programming
          if (state === "mdata") { wrBlock++; state = "mtoken" } else state = "idle"
        }
        return
      }
      if (state === "token" && b === 0xfe) { state = "data"; wrBuf = []; return }
      if (state === "mtoken" && b === 0xfc) { state = "mdata"; wrBuf = []; return }
      if (state === "mtoken" && b === 0xfd) { state = "idle"; queue = [0xff]; busy = 4; return }
      if ((b & 0xc0) === 0x40) { cmd = [b]; queue = [] }
    },
  })
  return {
    drives: () => {
      // CD: the socket's switch pulls it to GND while a card is in (a 10 kΩ pull-up otherwise)
      if (!c.pins.includes("CD")) return
      ctx.set("CD", present() ? { v: 0, r: 100 } : { v: ctx.supply("VCC"), r: 10e3 })
    },
    view: () => {
      if (!present()) return { text: "no card" }
      if (power(c, ctx) <= 0) return undefined
      if ((ctx.now() - lastAct) / ctx.hz < 0.08) return { glow: [1] }
      if (filesVer !== ver) { filesVer = ver; fileCount = img.files().length }
      return { text: `${fileCount} file${fileCount === 1 ? "" : "s"}` }
    },
  }
}

const group: ModelGroup = {
  proto: { max31856, max31865, sdcard },
}
export default group
