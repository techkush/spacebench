// Models: thermal imaging cameras (Melexis MLX90640, MLX90641, MLX90621 on Grove boards).
//
// Each camera holds a calibration EEPROM laid out bit for bit as in its datasheet, and a RAM
// that it fills subpage by subpage at the refresh rate in its control register. The RAM words
// are computed backwards from the scene: the EEPROM is decoded exactly as Melexis' driver
// (MLX90640_API.cpp / MLX90641_API.cpp / MLX90621_API.cpp) decodes it, and for every pixel the
// driver's temperature formula (gain, Kv, Kta, offsets, alpha, KsTa, ksTo ranges, CP pixel, Vdd
// and Ta from PTAT) is inverted, so the library turns the words back into the scene's
// temperatures. The scene is a background at one temperature and a round hot spot (position,
// size, optional motion) in front of a sensor at the ambient temperature; objects are black
// bodies (emissivity 1).
//
// Pixel layout: MLX9064x pixel p = row * columns + column (row 0 at the top, column 0 at the
// left of the picture); MLX90621 pixel p = column * 4 + row.
import type { I2CDevice } from "../../devices"
import { nextImageVer, type SimCtx } from "../devices"
import type { Chip } from "../i2c"
import type { ModView } from "../look"
import type { ModelGroup } from "./types"

// ── helpers ────────────────────────────────────────────────────────────────────────────────
const K0 = 273.15
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))
const s16 = (v: number) => (v > 32767 ? v - 65536 : v)
const sN = (v: number, bits: number) => (v >= 1 << (bits - 1) ? v - (1 << bits) : v)
const u16 = (v: number) => clamp(Math.round(v), -32768, 32767) & 0xffff
/** deterministic noise for a part's calibration (a mulberry32 stream) */
function rng(seed: number) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
const irand = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1))
/** the Grove board takes 3.3–5 V on VCC; unpowered it answers nothing */
const powered = (ctx: SimCtx) => ctx.supply("VCC") > 0

// ── the scene ──────────────────────────────────────────────────────────────────────────────
export interface Scene { amb: number; bg: number; hot: number; x: number; y: number; d: number }
/** what the camera looks at now (x, y, d in fractions of the view width/height) */
export function sceneOf(ctx: SimCtx): Scene {
  const f = ctx.ctl("spd")
  let x = ctx.ctl("hx") / 100, y = ctx.ctl("hy") / 100
  if (f > 0) { const t = ctx.now() / ctx.hz, w = 2 * Math.PI * f * t; x += 0.3 * Math.sin(w); y += 0.3 * Math.sin(1.37 * w + 0.6) }
  return { amb: ctx.ctl("amb"), bg: ctx.ctl("bg"), hot: ctx.ctl("hot"), x: clamp(x, 0, 1), y: clamp(y, 0, 1), d: ctx.ctl("hs") / 100 }
}
/**
 * Object temperature (°C) each pixel sees: the share of the pixel the hot spot covers blends the
 * radiance (T⁴) of hot spot and background. `aspect` = vertical / horizontal field of view.
 */
export function pixelTemps(s: Scene, cols: number, rows: number, aspect: number): Float64Array {
  const out = new Float64Array(cols * rows)
  const bg4 = (s.bg + K0) ** 4, hot4 = (s.hot + K0) ** 4, r = s.d / 2, N = 4
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    let inside = 0
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const u = (col + (i + 0.5) / N) / cols, v = (row + (j + 0.5) / N) / rows
      const du = u - s.x, dv = (v - s.y) * aspect
      if (du * du + dv * dv <= r * r) inside++
    }
    const c = inside / (N * N)
    out[row * cols + col] = (c * hot4 + (1 - c) * bg4) ** 0.25 - K0
  }
  return out
}

/** iron palette: black → indigo → magenta → orange → yellow → white */
const IRON: [number, number, number][] = [[0, 0, 0], [32, 0, 96], [110, 0, 150], [190, 20, 110], [235, 70, 20], [255, 150, 0], [255, 220, 60], [255, 255, 220]]
export function iron(t: number): [number, number, number] {
  const x = clamp(t, 0, 1) * (IRON.length - 1), i = Math.min(IRON.length - 2, Math.floor(x)), f = x - i
  const a = IRON[i], b = IRON[i + 1]
  return [Math.round(a[0] + (b[0] - a[0]) * f), Math.round(a[1] + (b[1] - a[1]) * f), Math.round(a[2] + (b[2] - a[2]) * f)]
}
/** a false-colour picture of the scene, redrawn only when it changes */
function thermalView(ctx: SimCtx, cols: number, rows: number, aspect: number, order: (row: number, col: number) => number = (r, c) => r * cols + c) {
  let key = "", img: { w: number; h: number; ver: number; data: Uint8ClampedArray } | undefined
  return (): ModView | undefined => {
    if (!powered(ctx)) return undefined
    const s = sceneOf(ctx)
    const k = `${s.bg.toFixed(2)} ${s.hot.toFixed(2)} ${s.x.toFixed(3)} ${s.y.toFixed(3)} ${s.d.toFixed(3)}`
    if (k !== key || !img) {
      key = k
      const t = pixelTemps(s, cols, rows, aspect)
      let lo = Infinity, hi = -Infinity
      for (const v of t) { lo = Math.min(lo, v); hi = Math.max(hi, v) }
      if (hi - lo < 4) { const m = (hi + lo) / 2; lo = m - 2; hi = m + 2 }
      const data = new Uint8ClampedArray(cols * rows * 4)
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const [R, G, B] = iron((t[order(r, c)] - lo) / (hi - lo)), i = (r * cols + c) * 4
        data[i] = R; data[i + 1] = G; data[i + 2] = B; data[i + 3] = 255
      }
      img = { w: cols, h: rows, ver: nextImageVer(), data }
    }
    return { image: img }
  }
}

/** the driver's To(x) for compensated IR data x is monotonic: solve To(x) = T (°C) */
function invert(T: number, taTr: number, alpha: number, to: (x: number) => number): number {
  const G = (T + K0) ** 4 - taTr
  let x = G * alpha
  for (let k = 0; k < 12; k++) {
    const t = to(x)
    if (!Number.isFinite(t)) { x *= 0.5; continue }
    const g = (t + K0) ** 4 - taTr
    const dx = (G - g) * alpha
    x += dx
    if (Math.abs(dx) < 1e-4) break
  }
  return x
}

/**
 * Ta from PTAT (MLX9064x): Ta = (PTATart / (1 + KvPTAT·ΔV) − VPTAT25) / KtPTAT + 25 with
 * PTATart = PTAT / (PTAT·αPTAT + VBE) · 2¹⁸ — the VBE / PTAT pair closest to `ta`.
 */
function ptatWords(ta: number, vdd: number, p: { KvPTAT: number; KtPTAT: number; vPTAT25: number; alphaPTAT: number }): [number, number] {
  const P = ((ta - 25) * p.KtPTAT + p.vPTAT25) * (1 + p.KvPTAT * (vdd - 3.3))
  let best: [number, number] = [19500, 0], err = Infinity
  for (let vbe = 19460; vbe <= 19540; vbe++) {
    const ptat = Math.round((P * vbe) / (262144 - P * p.alphaPTAT))
    const art = (ptat / (ptat * p.alphaPTAT + vbe)) * 262144
    const t = (art / (1 + p.KvPTAT * (vdd - 3.3)) - p.vPTAT25) / p.KtPTAT + 25
    if (Math.abs(t - ta) < err) { err = Math.abs(t - ta); best = [vbe, ptat] }
  }
  return best
}
const taFrom = (vbe: number, ptat: number, vdd: number, p: { KvPTAT: number; KtPTAT: number; vPTAT25: number; alphaPTAT: number }) =>
  ((s16(ptat) / (s16(ptat) * p.alphaPTAT + s16(vbe))) * 262144 / (1 + p.KvPTAT * (vdd - 3.3)) - p.vPTAT25) / p.KtPTAT + 25

// ── MLX9064x: 16-bit addresses, 16-bit big-endian words ────────────────────────────────────
/** the I²C side of a MLX9064x: the first two bytes written are the address, then data words */
class Mem16 implements I2CDevice {
  private n = 0
  private hi = 0
  private ptr = 0
  private rd = 0
  private word = 0
  private get: (a: number) => number
  private set: (a: number, v: number) => void
  private touch: () => void
  private on: () => boolean
  constructor(get: (a: number) => number, set: (a: number, v: number) => void, touch: () => void, on: () => boolean) { this.get = get; this.set = set; this.touch = touch; this.on = on }
  start() { this.n = 0; this.rd = 0; this.touch() }
  write(b: number) {
    if (!this.on()) return
    if (this.n === 0) this.hi = b
    else if (this.n === 1) this.ptr = (this.hi << 8) | b
    else if (this.n % 2 === 0) this.hi = b
    else { this.set(this.ptr, (this.hi << 8) | b); this.ptr = (this.ptr + 1) & 0xffff }
    this.n++
  }
  read() {
    if (!this.on()) return 0xff
    if (this.rd++ % 2 === 0) { this.word = this.get(this.ptr) & 0xffff; return this.word >> 8 }
    this.ptr = (this.ptr + 1) & 0xffff
    return this.word & 0xff
  }
}

const RATES = [0.5, 1, 2, 4, 8, 16, 32, 64]

/**
 * Status 0x8000 (bits 0–2 last subpage, bit 3 new data, bit 4 overwrite enable) and control
 * 0x800D (bit 3 subpage repeat, bits 4–6 subpage, 7–9 refresh rate, 10–11 ADC resolution, 12
 * chess pattern). A subpage is measured every 1 / refresh-rate seconds.
 */
class Measure {
  status = 0x0000
  ctrl: number
  i2cConf = 0x0000
  private next: number
  private sub = 1
  private ctx: SimCtx
  private done: (sub: number) => void
  constructor(ctx: SimCtx, ctrl: number, done: (sub: number) => void) {
    this.ctx = ctx; this.done = done
    this.ctrl = ctrl
    this.next = this.period()
  }
  period() { return 1 / RATES[(this.ctrl >> 7) & 7] }
  private t() { return this.ctx.now() / this.ctx.hz }
  /** measure every subpage that finished since the last look */
  update() {
    const now = this.t()
    if (now < this.next) return
    const n = Math.floor((now - this.next) / this.period()) + 1
    this.next += n * this.period()
    for (let k = Math.max(0, n - 2); k < n; k++) {
      this.sub = this.ctrl & 0x0008 ? (this.ctrl >> 4) & 1 : this.sub ^ 1
      this.done(this.sub)
    }
    this.status = (this.status & 0xfff0) | 0x0008 | (this.sub & 7)
  }
  writeStatus(v: number) { this.status = (this.status & 0x0007) | (v & 0x0030) | (v & 0x0008 ? this.status & 0x0008 : 0) }
  writeCtrl(v: number) {
    const old = this.period()
    this.ctrl = v & 0xffff
    if (this.period() !== old) this.next = this.t() + this.period()
  }
}

// ── MLX90640 (32×24) ───────────────────────────────────────────────────────────────────────
export interface P640 {
  kVdd: number; vdd25: number; KvPTAT: number; KtPTAT: number; vPTAT25: number; alphaPTAT: number; gainEE: number; tgc: number
  resolutionEE: number; KsTa: number; ksTo: number[]; ct: number[]; alpha: Float64Array; offset: Float64Array; kta: Float64Array; kv: Float64Array
  cpAlpha: number[]; cpOffset: number[]; cpKv: number; cpKta: number; ilChessC: number[]; calibrationModeEE: number
}

/** a calibration EEPROM in the MLX90640's layout (0x2400–0x273F), values like a BAA part's */
export function eeprom640(seed: number): Uint16Array {
  const r = rng(seed), ee = new Uint16Array(832)
  ee[0] = 0x00ae; ee[1] = 0x499a; ee[2] = 0x0000; ee[3] = 0x2061; ee[4] = 0x0005; ee[5] = 0x0320; ee[6] = 0x03e0
  ee[7] = seed & 0xffff; ee[8] = (seed >>> 16) & 0xffff; ee[9] = 0x0c2b // device ID
  ee[10] = 0x0000 // bit 6 = 0: MLX90640; bit 11 = 0: calibrated in chess mode
  ee[12] = 0x1901; ee[13] = 0x0000; ee[15] = 0xbe33
  // offsets: αPTAT = 4/4 + 8 = 9, row scale 2, column scale 1, remainder scale 0
  ee[16] = 0x4210; ee[17] = u16(-69)
  const nib = (vals: number[], at: number) => { for (let i = 0; i < vals.length / 4; i++) ee[at + i] = (vals[4 * i] & 15) | ((vals[4 * i + 1] & 15) << 4) | ((vals[4 * i + 2] & 15) << 8) | ((vals[4 * i + 3] & 15) << 12) }
  nib(Array.from({ length: 24 }, () => irand(r, -6, 6)), 18)
  nib(Array.from({ length: 32 }, () => irand(r, -6, 6)), 24)
  // alpha: scale 8 + 30, row and column scales 8, remainder scale 6; edges see less (vignetting)
  ee[32] = 0x8886; ee[33] = 33000
  nib(Array.from({ length: 24 }, (_, i) => Math.round(3 - 7 * ((i - 11.5) / 11.5) ** 2)), 34)
  nib(Array.from({ length: 32 }, (_, j) => Math.round(3 - 7 * ((j - 15.5) / 15.5) ** 2)), 40)
  ee[48] = 6383 // gain
  ee[49] = 12273 // VPTAT25
  ee[50] = (22 << 10) | 338 // KvPTAT 22/4096, KtPTAT 338/8
  ee[51] = 0x9d68 // kVdd −99·32, VDD25 ((0x68 − 256)·32) − 8192
  ee[52] = 0x5454 // Kv per row/column parity
  ee[53] = 0x0994 // interleaved / chess corrections
  ee[54] = 0x5354; ee[55] = 0x5354 // Kta per row/column parity
  ee[56] = 0x2363 // resolution 2 (18 bit), Kv scale 3, Kta scale 6 + 8, Kta scale 2 = 3
  ee[57] = (4 << 10) | 155 // CP alpha
  ee[58] = ((-2 & 63) << 10) | (-75 & 1023) // CP offsets −75, −77
  ee[59] = 0x044b // CP Kv, CP Kta
  ee[60] = 0xf000 // KsTa −16/8192, TGC 0
  ee[61] = 0x9797; ee[62] = 0x9797 // ksTo (scale 2^17)
  ee[63] = 0x2889 // step 20 °C, CT3 = 160 °C, CT4 = 320 °C, ksTo scale 9 + 8
  for (let p = 0; p < 768; p++) {
    const off = irand(r, -12, 12), al = irand(r, -12, 12), kt = irand(r, -2, 2)
    let w = ((off & 63) << 10) | ((al & 63) << 4) | ((kt & 7) << 1)
    if (w === 0) w = 1 << 4
    ee[64 + p] = w
  }
  return ee
}

/** MLX90640_ExtractParameters, as in Melexis' driver */
export function params640(ee: Uint16Array): P640 {
  let kVdd = sN((ee[51] & 0xff00) >> 8, 8) * 32
  let vdd25 = ((ee[51] & 0xff) - 256) * 32 - 8192
  const KvPTAT = sN((ee[50] & 0xfc00) >> 10, 6) / 4096, KtPTAT = sN(ee[50] & 0x3ff, 10) / 8
  const vPTAT25 = ee[49], alphaPTAT = (ee[16] & 0xf000) / 2 ** 14 + 8
  const gainEE = s16(ee[48]), tgc = sN(ee[60] & 0xff, 8) / 32, resolutionEE = (ee[56] & 0x3000) >> 12
  const KsTa = sN((ee[60] & 0xff00) >> 8, 8) / 8192
  const step = ((ee[63] & 0x3000) >> 12) * 10
  const ct = [-40, 0, ((ee[63] & 0xf0) >> 4) * step, 0]
  ct[3] = ct[2] + ((ee[63] & 0xf00) >> 8) * step
  const ksToScale = 1 << ((ee[63] & 15) + 8)
  const ksTo = [ee[61] & 0xff, ee[61] >> 8, ee[62] & 0xff, ee[62] >> 8].map((v) => sN(v, 8) / ksToScale)
  const nibs = (at: number, n: number) => Array.from({ length: n }, (_, i) => sN((ee[at + (i >> 2)] >> ((i & 3) * 4)) & 15, 4))
  // alpha
  const accRem = ee[32] & 15, accCol = (ee[32] & 0xf0) >> 4, accRow = (ee[32] & 0xf00) >> 8, alphaScale = ((ee[32] & 0xf000) >> 12) + 30
  const aRow = nibs(34, 24), aCol = nibs(40, 32)
  const alpha = new Float64Array(768), offset = new Float64Array(768), kta = new Float64Array(768), kv = new Float64Array(768)
  const occRem = ee[16] & 15, occCol = (ee[16] & 0xf0) >> 4, occRow = (ee[16] & 0xf00) >> 8, offRef = s16(ee[17])
  const oRow = nibs(18, 24), oCol = nibs(24, 32)
  const KtaRC = [sN(ee[54] >> 8, 8), sN(ee[55] >> 8, 8), sN(ee[54] & 0xff, 8), sN(ee[55] & 0xff, 8)]
  const ktaScale1 = ((ee[56] & 0xf0) >> 4) + 8, ktaScale2 = ee[56] & 15
  const KvT = [sN(ee[52] >> 12, 4), sN((ee[52] >> 4) & 15, 4), sN((ee[52] >> 8) & 15, 4), sN(ee[52] & 15, 4)]
  const kvScale = (ee[56] & 0xf00) >> 8
  for (let i = 0; i < 24; i++) for (let j = 0; j < 32; j++) {
    const p = 32 * i + j, w = ee[64 + p]
    alpha[p] = (ee[33] + (aRow[i] << accRow) + (aCol[j] << accCol) + sN((w & 0x3f0) >> 4, 6) * (1 << accRem)) / 2 ** alphaScale
    offset[p] = offRef + (oRow[i] << occRow) + (oCol[j] << occCol) + sN((w & 0xfc00) >> 10, 6) * (1 << occRem)
    const split = 2 * (Math.floor(p / 32) - Math.floor(p / 64) * 2) + (p % 2)
    kta[p] = (KtaRC[split] + sN((w & 0xe) >> 1, 3) * (1 << ktaScale2)) / 2 ** ktaScale1
    kv[p] = KvT[split] / 2 ** kvScale
  }
  // compensation pixels
  const cpAlphaScale = ((ee[32] & 0xf000) >> 12) + 27
  const off0 = sN(ee[58] & 0x3ff, 10), off1 = sN((ee[58] & 0xfc00) >> 10, 6) + off0
  const a0 = sN(ee[57] & 0x3ff, 10) / 2 ** cpAlphaScale, a1 = (1 + sN((ee[57] & 0xfc00) >> 10, 6) / 128) * a0
  const cpKta = sN(ee[59] & 0xff, 8) / 2 ** ktaScale1, cpKv = sN(ee[59] >> 8, 8) / 2 ** kvScale
  const calibrationModeEE = ((ee[10] & 0x0800) >> 4) ^ 0x80
  const ilChessC = [sN(ee[53] & 0x3f, 6) / 16, sN((ee[53] & 0x7c0) >> 6, 5) / 2, sN((ee[53] & 0xf800) >> 11, 5) / 8]
  kVdd = kVdd | 0; vdd25 = vdd25 | 0
  return { kVdd, vdd25, KvPTAT, KtPTAT, vPTAT25, alphaPTAT, gainEE, tgc, resolutionEE, KsTa, ksTo, ct, alpha, offset, kta, kv, cpAlpha: [a0, a1], cpOffset: [off0, off1], cpKv, cpKta, ilChessC, calibrationModeEE }
}

/** the driver's two-step To for compensated IR data x (MLX90640: range from ksTo[1]) */
function to640(x: number, ac: number, taTr: number, P: P640, corr: number[]): number {
  const Sx = Math.sqrt(Math.sqrt(ac ** 3 * (x + ac * taTr))) * P.ksTo[1]
  const t0 = Math.sqrt(Math.sqrt(x / (ac * (1 - P.ksTo[1] * K0) + Sx) + taTr)) - K0
  const r = t0 < P.ct[1] ? 0 : t0 < P.ct[2] ? 1 : t0 < P.ct[3] ? 2 : 3
  return Math.sqrt(Math.sqrt(x / (ac * corr[r] * (1 + P.ksTo[r] * (t0 - P.ct[r]))) + taTr)) - K0
}

/** RAM words 0x0400–0x073F for one measured subpage of the scene */
export function frame640(ram: Uint16Array, P: P640, ctrl: number, sub: number, temps: Float64Array, ta: number, vdd: number) {
  const resRAM = (ctrl & 0x0c00) >> 10, resCorr = 2 ** P.resolutionEE / 2 ** resRAM
  // VDD, gain and Ta words, then the values the driver gets back from them
  const vWord = u16((P.vdd25 + P.kVdd * (vdd - 3.3)) / resCorr)
  const vddD = (resCorr * s16(vWord) - P.vdd25) / P.kVdd + 3.3
  const [vbe, ptat] = ptatWords(ta, vddD, P)
  const taD = taFrom(vbe, ptat, vddD, P)
  const gWord = u16(P.gainEE * 2 ** (resRAM - P.resolutionEE)), gain = P.gainEE / s16(gWord)
  const mode = (ctrl & 0x1000) >> 5
  const dt = taD - 25, dv = vddD - 3.3
  const cpOff = [P.cpOffset[0], P.cpOffset[1] + (mode === P.calibrationModeEE ? 0 : P.ilChessC[0])]
  const cpWords = cpOff.map((o) => u16((o * (1 + P.cpKta * dt) * (1 + P.cpKv * dv)) / gain))
  const cp = cpWords.map((w, i) => s16(w) * gain - cpOff[i] * (1 + P.cpKta * dt) * (1 + P.cpKv * dv))
  ram[0x300] = u16(vbe); ram[0x320] = u16(ptat); ram[0x30a] = gWord; ram[0x32a] = vWord
  ram[0x308] = cpWords[0]; ram[0x328] = cpWords[1]
  const taTr = (taD + K0) ** 4
  const corr = [1 / (1 + P.ksTo[0] * 40), 1, 1 + P.ksTo[2] * P.ct[2], 0]
  corr[3] = corr[2] * (1 + P.ksTo[3] * (P.ct[3] - P.ct[2]))
  for (let p = 0; p < 768; p++) {
    const il = Math.floor(p / 32) - Math.floor(p / 64) * 2
    const chess = il ^ (p - Math.floor(p / 2) * 2)
    if ((mode === 0 ? il : chess) !== sub) continue
    const conv = (Math.floor((p + 2) / 4) - Math.floor((p + 3) / 4) + Math.floor((p + 1) / 4) - Math.floor(p / 4)) * (1 - 2 * il)
    const ac = (P.alpha[p] - P.tgc * P.cpAlpha[sub]) * (1 + P.KsTa * dt)
    const x = invert(temps[p], taTr, ac, (v) => to640(v, ac, taTr, P, corr))
    let raw = x + P.tgc * cp[sub] + P.offset[p] * (1 + P.kta[p] * dt) * (1 + P.kv[p] * dv)
    if (mode !== P.calibrationModeEE) raw -= P.ilChessC[2] * (2 * il - 1) - P.ilChessC[1] * conv
    ram[p] = u16(raw / gain)
  }
}

// ── MLX90641 (16×12) ───────────────────────────────────────────────────────────────────────
export interface P641 {
  kVdd: number; vdd25: number; KvPTAT: number; KtPTAT: number; vPTAT25: number; alphaPTAT: number; gainEE: number; tgc: number
  resolutionEE: number; KsTa: number; ksTo: number[]; ct: number[]; alpha: Float64Array; offset: [Float64Array, Float64Array]; kta: Float64Array; kv: Float64Array
  cpAlpha: number; cpOffset: number; cpKv: number; cpKta: number
}
/** words 16… of the MLX90641 EEPROM carry 11 data bits and 5 Hamming parity bits */
export function hamming(d: number): number {
  const D = (i: number) => (d >> i) & 1
  const p0 = D(0) ^ D(1) ^ D(3) ^ D(4) ^ D(6) ^ D(8) ^ D(10)
  const p1 = D(0) ^ D(2) ^ D(3) ^ D(5) ^ D(6) ^ D(9) ^ D(10)
  const p2 = D(1) ^ D(2) ^ D(3) ^ D(7) ^ D(8) ^ D(9) ^ D(10)
  const p3 = D(4) ^ D(5) ^ D(6) ^ D(7) ^ D(8) ^ D(9) ^ D(10)
  let w = (d & 0x7ff) | (p0 << 11) | (p1 << 12) | (p2 << 13) | (p3 << 14)
  let all = 0
  for (let i = 0; i < 15; i++) all ^= (w >> i) & 1
  w |= all << 15
  return w
}
/** a calibration EEPROM in the MLX90641's layout; `fov` 110 (BCA) or 55 (BCB) */
export function eeprom641(seed: number, fov: number): Uint16Array {
  const r = rng(seed), d = new Uint16Array(832) // 11-bit data, encoded below
  const s11 = (v: number) => v & 0x7ff
  d[0] = 0x00ae; d[1] = 0x499a; d[7] = seed & 0xffff; d[8] = (seed >>> 16) & 0xffff; d[9] = 0x0641
  d[10] = 0x0040 // bit 6 = 1: MLX90641
  d[12] = 0x0901; d[15] = 0xbe33
  const scaleOffset = 2
  d[16] = scaleOffset << 5
  const offRef = -500 + 65536; d[17] = offRef >> 5; d[18] = offRef & 31
  d[21] = s11(600); d[22] = (17 << 5) | 2 // Kta average 600 / 2^17, pixel Kta · 2^2
  d[23] = s11(500); d[24] = (10 << 5) | 3 // Kv average 500 / 2^10, pixel Kv · 2^3
  d[25] = (11 << 5) | 11; d[26] = (11 << 5) | 11; d[27] = (11 << 5) | 11 // alpha row scales 2^31
  const rowMax = fov < 80 ? 260 : 320
  for (let i = 0; i < 6; i++) d[28 + i] = rowMax
  d[34] = s11(-66) // KsTa −66/32768
  d[35] = 512 // emissivity 1.0
  d[36] = 6383 >> 5; d[37] = 6383 & 31 // gain
  d[38] = s11(-408); d[39] = s11(-99) // VDD25 ·32, KVdd ·32
  d[40] = 12273 >> 5; d[41] = 12273 & 31 // VPTAT25
  d[42] = 338; d[43] = 22; d[44] = 9 * 128 // KtPTAT ·8, KvPTAT ·4096, αPTAT ·128
  d[45] = 687; d[46] = 36 // CP alpha 687 / 2^36
  const cpo = -200 + 65536; d[47] = cpo >> 5; d[48] = cpo & 31
  d[49] = (14 << 6) | 10; d[50] = (4 << 6) | 8 // CP Kta 10/2^14, CP Kv 8/2^4
  d[51] = 2 << 9 // resolution 2, TGC 0
  d[52] = 20 // ksTo scale 2^20
  const ks = [-430, -425, -419, -410, -400, -390, -380, -370]
  ;[53, 54, 55, 56, 57, 59, 61, 63].forEach((a, i) => (d[a] = s11(ks[i])))
  d[58] = 200; d[60] = 300; d[62] = 400 // CT6–CT8 (°C)
  for (let p = 0; p < 192; p++) {
    const row = Math.floor(p / 16), col = p % 16
    const vig = 1 - 0.18 * (((row - 5.5) / 5.5) ** 2 + ((col - 7.5) / 7.5) ** 2) / 2
    const o = irand(r, -60, 60)
    d[64 + p] = s11(o); d[640 + p] = s11(o + irand(r, -8, 8))
    d[256 + p] = clamp(Math.round(2047 * vig) - irand(r, 0, 40), 1200, 2047)
    d[448 + p] = ((irand(r, -20, 20) & 63) << 5) | (irand(r, -10, 10) & 31)
  }
  const ee = new Uint16Array(832)
  for (let a = 0; a < 832; a++) ee[a] = a < 16 ? d[a] : hamming(d[a])
  return ee
}
/** MLX90641_ExtractParameters (after the Hamming decode), as in Melexis' driver */
export function params641(eeRaw: Uint16Array): P641 {
  const ee = eeRaw.map((w, a) => (a < 16 ? w : w & 0x7ff))
  const kVdd = sN(ee[39], 11) * 32, vdd25 = sN(ee[38], 11) * 32
  const KvPTAT = sN(ee[43], 11) / 4096, KtPTAT = sN(ee[42], 11) / 8, vPTAT25 = 32 * ee[40] + ee[41], alphaPTAT = ee[44] / 128
  const gainEE = s16(32 * ee[36] + ee[37]), tgc = sN(ee[51] & 0x1ff, 9) / 64, resolutionEE = (ee[51] & 0x600) >> 9
  const KsTa = sN(ee[34], 11) / 32768
  const ct = [-40, -20, 0, 80, 120, ee[58], ee[60], ee[62]]
  const ksToScale = 2 ** ee[52]
  const ksTo = [53, 54, 55, 56, 57, 59, 61, 63].map((a) => sN(ee[a], 11) / ksToScale)
  // CP (the driver extracts it after alpha: alpha sees cpAlpha = 0 unless TGC is 0 anyway)
  const cpAlpha = sN(ee[45], 11) / 2 ** ee[46], cpOffset = s16(32 * ee[47] + ee[48])
  const cpKta = (ee[49] & 0x1f) / 2 ** (ee[49] >> 6), cpKv = (ee[50] & 0x1f) / 2 ** (ee[50] >> 6)
  // alpha: 1e-6 / (α − TGC·αCP) rounded to 16 bits with a common scale
  const scaleRow = [ee[25] >> 5, ee[25] & 31, ee[26] >> 5, ee[26] & 31, ee[27] >> 5, ee[27] & 31].map((v) => v + 20)
  const tmp = new Float64Array(192)
  for (let i = 0; i < 6; i++) for (let j = 0; j < 32; j++) {
    const p = 32 * i + j
    tmp[p] = 1e-6 / (ee[256 + p] * (ee[28 + i] / 2 ** scaleRow[i] / 2047))
  }
  let m = Math.max(...tmp), aScale = 0
  while (m < 32768) { m *= 2; aScale++ }
  const alpha = new Float64Array(192)
  for (let p = 0; p < 192; p++) alpha[p] = 1e-6 * 2 ** aScale / Math.floor(tmp[p] * 2 ** aScale + 0.5)
  // offsets per subpage
  const so = 1 << (ee[16] >> 5), offRef = s16(32 * ee[17] + ee[18])
  const off0 = new Float64Array(192), off1 = new Float64Array(192)
  for (let p = 0; p < 192; p++) { off0[p] = sN(ee[64 + p], 11) * so + offRef; off1[p] = sN(ee[640 + p], 11) * so + offRef }
  // Kta, Kv: rescaled to 8 bits with a common scale
  const rescale = (vals: Float64Array) => {
    let mx = Math.max(...vals.map(Math.abs)), s = 0
    while (mx < 64) { mx *= 2; s++ }
    return vals.map((v) => { const t = v * 2 ** s; return ((((t < 0 ? Math.ceil(t - 0.5) : Math.floor(t + 0.5)) + 128) & 255) - 128) / 2 ** s })
  }
  const ktaAvg = sN(ee[21], 11), ktaS1 = ee[22] >> 5, ktaS2 = ee[22] & 31
  const kvAvg = sN(ee[23], 11), kvS1 = ee[24] >> 5, kvS2 = ee[24] & 31
  const kta = rescale(new Float64Array(192).map((_, p) => (sN(ee[448 + p] >> 5, 6) * 2 ** ktaS2 + ktaAvg) / 2 ** ktaS1))
  const kv = rescale(new Float64Array(192).map((_, p) => (sN(ee[448 + p] & 31, 5) * 2 ** kvS2 + kvAvg) / 2 ** kvS1))
  return { kVdd, vdd25, KvPTAT, KtPTAT, vPTAT25, alphaPTAT, gainEE, tgc, resolutionEE, KsTa, ksTo, ct, alpha, offset: [off0, off1], kta, kv, cpAlpha, cpOffset, cpKv, cpKta }
}
function to641(x: number, ac: number, taTr: number, P: P641, corr: number[]): number {
  const Sx = Math.sqrt(Math.sqrt(ac ** 3 * (x + ac * taTr))) * P.ksTo[2]
  const t0 = Math.sqrt(Math.sqrt(x / (ac * (1 - P.ksTo[2] * K0) + Sx) + taTr)) - K0
  let r = 0
  while (r < 7 && t0 >= P.ct[r + 1]) r++
  return Math.sqrt(Math.sqrt(x / (ac * corr[r] * (1 + P.ksTo[r] * (t0 - P.ct[r]))) + taTr)) - K0
}
/** RAM 0x0400–0x05BF: pixel p of subpage s at 0x0400 + 64·(p ≫ 5) + 32·s + (p & 31) */
export function frame641(ram: Uint16Array, P: P641, ctrl: number, sub: number, temps: Float64Array, ta: number, vdd: number) {
  const resRAM = (ctrl & 0x0c00) >> 10, resCorr = 2 ** P.resolutionEE / 2 ** resRAM
  const vWord = u16((P.vdd25 + P.kVdd * (vdd - 3.3)) / resCorr)
  const vddD = (resCorr * s16(vWord) - P.vdd25) / P.kVdd + 3.3
  const [vbe, ptat] = ptatWords(ta, vddD, P)
  const taD = taFrom(vbe, ptat, vddD, P)
  const gWord = u16(P.gainEE * 2 ** (resRAM - P.resolutionEE)), gain = P.gainEE / s16(gWord)
  const dt = taD - 25, dv = vddD - 3.3
  const cpTerm = P.cpOffset * (1 + P.cpKta * dt) * (1 + P.cpKv * dv)
  const cpWord = u16(cpTerm / gain), cp = s16(cpWord) * gain - cpTerm
  ram[0x180] = u16(vbe); ram[0x1a0] = u16(ptat); ram[0x18a] = gWord; ram[0x1aa] = vWord; ram[0x188] = cpWord
  const taTr = (taD + K0) ** 4
  const k = P.ksTo, c = P.ct
  const corr = [0, 1 / (1 + k[1] * 20), 1, 1 + k[2] * c[3], 0, 0, 0, 0]
  corr[0] = corr[1] / (1 + k[0] * 20)
  for (let i = 4; i < 8; i++) corr[i] = corr[i - 1] * (1 + k[i - 1] * (c[i] - c[i - 1]))
  for (let p = 0; p < 192; p++) {
    const ac = P.alpha[p] * (1 + P.KsTa * dt)
    const x = invert(temps[p], taTr, ac, (v) => to641(v, ac, taTr, P, corr))
    const raw = x + P.tgc * cp + P.offset[sub][p] * (1 + P.kta[p] * dt) * (1 + P.kv[p] * dv)
    ram[64 * (p >> 5) + 32 * sub + (p & 31)] = u16(raw / gain)
  }
}

/** a MLX9064x on the bus: EEPROM 0x2400…, RAM 0x0400…, status 0x8000, control 0x800D */
function mlx9064x(ctx: SimCtx, addr: number, o: { ee: Uint16Array; ctrl: number; cols: number; rows: number; aspect: number; ramWords: number; fill: (ram: Uint16Array, ctrl: number, sub: number, temps: Float64Array, ta: number) => void }): Chip {
  const ram = new Uint16Array(o.ramWords)
  const m = new Measure(ctx, o.ctrl, (sub) => o.fill(ram, m.ctrl, sub, pixelTemps(sceneOf(ctx), o.cols, o.rows, o.aspect), ctx.ctl("amb")))
  const get = (a: number) => {
    if (a >= 0x2400 && a < 0x2400 + o.ee.length) return o.ee[a - 0x2400]
    if (a >= 0x0400 && a < 0x0400 + o.ramWords) return ram[a - 0x0400]
    if (a === 0x8000) return m.status
    if (a === 0x800d) return m.ctrl
    if (a === 0x800f) return m.i2cConf
    return 0
  }
  const set = (a: number, v: number) => {
    if (a === 0x8000) m.writeStatus(v)
    else if (a === 0x800d) m.writeCtrl(v)
    else if (a === 0x800f) m.i2cConf = v
  }
  const dev = new Mem16(get, set, () => m.update(), () => powered(ctx))
  return { devices: [[addr, dev]], view: thermalView(ctx, o.cols, o.rows, o.aspect) }
}

// ── MLX90621 (16×4): EEPROM at 0x50, RAM and commands at 0x60 ─────────────────────────────
export interface P621 { vTh25: number; kT1: number; kT2: number; tgc: number; KsTa: number; ksTo: number; alpha: Float64Array; ai: Float64Array; bi: Float64Array; cpAlpha: number; cpA: number; cpB: number }
/** 256 calibration bytes in the MLX90621's layout, like a BAB (60°×16°) part's */
export function eeprom621(seed: number): Uint8Array {
  const r = rng(seed), ee = new Uint8Array(256)
  const le = (a: number, v: number) => { ee[a] = v & 0xff; ee[a + 1] = (v >> 8) & 0xff }
  for (let i = 0; i < 64; i++) {
    const col = Math.floor(i / 4), row = i % 4
    ee[i] = irand(r, 10, 60) // offset above A_common
    ee[0x40 + i] = irand(r, 60, 100) // offset slope (signed)
    ee[0x80 + i] = clamp(Math.round(200 - 140 * ((col - 7.5) / 7.5) ** 2 - 20 * ((row - 1.5) / 1.5) ** 2) + irand(r, -6, 6), 0, 255) // Δα
  }
  ee[0xc0] = 0x00 // Ks4 scale (+8)
  ee[0xc4] = 0x00 // Ks4 = 0
  le(0xd0, -540) // A_common
  ee[0xd2] = 0x8b // KT1 scale 8, KT2 scale 11 + 10
  le(0xd3, -560); ee[0xd5] = 80 // A_CP, B_CP
  le(0xd6, 3298) // α_CP / 2^40
  ee[0xd8] = 8 // TGC 8/32
  ee[0xd9] = 0x08 // Ai scale 0, Bi scale 8
  le(0xda, 6700) // VTh(25)
  le(0xdc, 6016) // KT1 = 23.5 · 2^8
  le(0xde, 24746) // KT2 · 2^21
  le(0xe0, 50000); ee[0xe2] = 40; ee[0xe3] = 35 // α0 / 2^40, Δα / 2^35
  le(0xe4, 0x8000) // emissivity 1.0
  le(0xe6, -315) // KsTa / 2^20
  ee[0xf5] = 0x3e; ee[0xf6] = 0x46 // configuration: 1 Hz, 18-bit ADC
  ee[0xf7] = 0x20 // oscillator trim
  ee[0xf8] = seed & 0xff; ee[0xf9] = (seed >> 8) & 0xff
  return ee
}
const i16le = (ee: Uint8Array, a: number) => s16(ee[a] | (ee[a + 1] << 8))
const i8 = (b: number) => (b > 127 ? b - 256 : b)
/** the MLX90621 datasheet's parameters at ADC resolution `res` (0–3) */
export function params621(ee: Uint8Array, res: number): P621 {
  const rs = 3 - res, rc = 2 ** rs
  const kt1Scale = (ee[0xd2] >> 4) + rs, kt2Scale = (ee[0xd2] & 15) + 10 + rs
  const vTh25 = i16le(ee, 0xda) / rc, kT1 = i16le(ee, 0xdc) / 2 ** kt1Scale, kT2 = i16le(ee, 0xde) / 2 ** kt2Scale
  const tgc = ee[0xd8] / 32, KsTa = i16le(ee, 0xe6) / 2 ** 20
  const ksTo = i8(ee[0xc4]) / 2 ** ((ee[0xc0] & 15) + 8)
  const alphaCom = (ee[0xe0] | (ee[0xe1] << 8)) / 2 ** ee[0xe2], dScale = 2 ** ee[0xe3]
  const aScale = ee[0xd9] >> 4, bScale = 2 ** ((ee[0xd9] & 15) + rs), aCom = i16le(ee, 0xd0)
  const alpha = new Float64Array(64), ai = new Float64Array(64), bi = new Float64Array(64)
  for (let i = 0; i < 64; i++) {
    alpha[i] = (alphaCom + ee[0x80 + i] / dScale) / rc
    ai[i] = (aCom + (ee[i] << aScale)) / rc
    bi[i] = i8(ee[0x40 + i]) / bScale
  }
  const cpAlpha = (ee[0xd6] | (ee[0xd7] << 8)) / 2 ** ee[0xe2] / rc
  return { vTh25, kT1, kT2, tgc, KsTa, ksTo, alpha, ai, bi, cpAlpha, cpA: i16le(ee, 0xd3) / rc, cpB: i8(ee[0xd5]) / bScale }
}
/** RAM 0x00–0x3F IR (pixel = column·4 + row), 0x40 PTAT, 0x41 compensation pixel */
export function frame621(ram: Uint16Array, P: P621, temps: Float64Array, ta: number) {
  const d = ta - 25
  const ptat = u16(P.vTh25 + P.kT1 * d + P.kT2 * d * d)
  const taD = (-P.kT1 + Math.sqrt(P.kT1 ** 2 - 4 * P.kT2 * (P.vTh25 - s16(ptat)))) / (2 * P.kT2) + 25
  const dt = taD - 25
  const cpWord = u16(P.cpA + P.cpB * dt), cp = s16(cpWord) - (P.cpA + P.cpB * dt)
  ram[0x40] = ptat; ram[0x41] = cpWord
  const taTr = (taD + K0) ** 4
  for (let i = 0; i < 64; i++) {
    const ac = (P.alpha[i] - P.tgc * P.cpAlpha) * (1 + P.KsTa * dt)
    const to = (x: number) => { const Sx = Math.sqrt(Math.sqrt(ac ** 3 * (x + ac * taTr))) * P.ksTo; return Math.sqrt(Math.sqrt(x / (ac * (1 - P.ksTo * K0) + Sx) + taTr)) - K0 }
    const x = invert(temps[i], taTr, ac, to)
    ram[i] = u16(x + P.tgc * cp + P.ai[i] + P.bi[i] * dt)
  }
}

function mlx90621(ctx: SimCtx, addr: number): Chip {
  const ee = eeprom621(0x90621 + addr)
  const ram = new Uint16Array(0x94)
  let config = 0x403e // after POR: flag (bit 10) clear until the sketch writes the configuration
  let trim = 0
  const res = () => (config >> 4) & 3
  const cols = 16, rows = 4, aspect = 16 / 60
  const fill = () => {
    const t = pixelTemps(sceneOf(ctx), cols, rows, aspect)
    const byPixel = new Float64Array(64)
    for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) byPixel[c * 4 + r] = t[r * cols + c]
    frame621(ram, params621(ee, res()), byPixel, ctx.ctl("amb"))
  }
  // EEPROM: one address byte, then sequential reads
  let eptr = 0, efresh = true
  const eep: I2CDevice = {
    start() { efresh = true },
    write(b) { if (efresh && powered(ctx)) { eptr = b; efresh = false } },
    read() { if (!powered(ctx)) return 0xff; const v = ee[eptr]; eptr = (eptr + 1) & 0xff; return v },
  }
  // commands: 0x02 read (start, step, count), 0x03 write configuration, 0x04 write oscillator trim
  let got: number[] = [], out: number[] = []
  const word = (a: number) => (a < 0x42 ? ram[a] : a === 0x92 ? config : a === 0x93 ? trim : 0)
  const cmd: I2CDevice = {
    start() { got = [] },
    write(b) {
      if (!powered(ctx)) return
      got.push(b)
      const [c, x1, x2, x3, x4] = got
      if (c === 0x02 && got.length === 4) {
        if (x1 < 0x42) fill()
        out = []
        for (let k = 0, a = x1; k < Math.max(1, x3); k++, a = (a + x2) & 0xff) { const w = word(a); out.push(w & 0xff, w >> 8) }
      } else if ((c === 0x03 || c === 0x04) && got.length === 5) {
        const chk = c === 0x03 ? 0x55 : 0xaa
        if (((x2 - chk) & 0xff) !== x1 || ((x4 - chk) & 0xff) !== x3) return
        const v = x2 | (x4 << 8)
        if (c === 0x03) config = v; else trim = v
      }
    },
    read() { return powered(ctx) && out.length ? out.shift()! : 0xff },
  }
  return { devices: [[0x50, eep], [addr, cmd]], view: thermalView(ctx, cols, rows, aspect, (r, c) => r * cols + c) }
}

const group: ModelGroup = {
  chips: {
    mlx90640: (ctx, addr) => {
      const ee = eeprom640(0x90640000 + addr), P = params640(ee)
      return mlx9064x(ctx, addr, { ee, ctrl: 0x1901, cols: 32, rows: 24, aspect: 75 / 110, ramWords: 0x340, fill: (ram, ctrl, sub, t, ta) => frame640(ram, P, ctrl, sub, t, ta, 3.3) })
    },
    "mlx90641-110": (ctx, addr) => {
      const ee = eeprom641(0x90641110 + addr, 110), P = params641(ee)
      return mlx9064x(ctx, addr, { ee, ctrl: 0x0901, cols: 16, rows: 12, aspect: 75 / 110, ramWords: 0x1c0, fill: (ram, ctrl, sub, t, ta) => frame641(ram, P, ctrl, sub, t, ta, 3.3) })
    },
    "mlx90641-55": (ctx, addr) => {
      const ee = eeprom641(0x90641055 + addr, 55), P = params641(ee)
      return mlx9064x(ctx, addr, { ee, ctrl: 0x0901, cols: 16, rows: 12, aspect: 35 / 55, ramWords: 0x1c0, fill: (ram, ctrl, sub, t, ta) => frame641(ram, P, ctrl, sub, t, ta, 3.3) })
    },
    mlx90621: (ctx, addr) => mlx90621(ctx, addr),
  },
}
export default group
