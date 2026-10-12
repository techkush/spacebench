// Models: e-paper panels. Two controller families cover the SPI panels, at command level as GxEPD2
// (Jean-Marc Zingg) drives them, so GxEPD2_BW / GxEPD2_3C / GxEPD2_7C work unchanged:
//  - Solomon SSD16xx (SSD1680 / SSD1681): SW reset 0x12, driver output 0x01, data entry mode 0x11
//    (X/Y increment, X- or Y-first), RAM window 0x44/0x45, counters 0x4E/0x4F, B/W RAM 0x24 and
//    red / "previous" RAM 0x26, display update control 0x21/0x22, master activation 0x20, deep
//    sleep 0x10. BUSY is HIGH while the controller works.
//  - UltraChip UC81xx (UC8176 4.2", UC8179 7.5") and the 5.65" ACeP 7-colour controller: panel
//    setting 0x00, power on/off 0x04/0x02, data 0x10/0x13, refresh 0x12, partial window 0x90 with
//    partial in/out 0x91/0x92, VCOM & data interval 0x50 (data polarity), resolution 0x61, deep
//    sleep 0x07 + 0xA5. BUSY (BUSY_N) is LOW while the controller works.
// The picture changes only on a refresh: the RAM is latched when the refresh starts and drawn when
// BUSY is released. Plus Seeed's Grove Triple Color E-Ink 2.13" — a UART module whose on-board MCU
// takes a whole frame over Serial (the 'c' / 'a' / 'b' handshake of Seeed's demo sketch).
import type { CatalogPart } from "../types"
import { moduleVcc, nextImageVer, type CatDevice, type SimCtx } from "../devices"
import type { ModelGroup, ProtoMaker } from "./types"

type RGB = [number, number, number]
/** the panel's inks as drawn on the canvas (tests compare against these) */
export const INK = {
  white: [236, 236, 228] as RGB,
  black: [24, 24, 28] as RGB,
  red: [196, 32, 36] as RGB,
  green: [40, 132, 64] as RGB,
  blue: [36, 60, 160] as RGB,
  yellow: [232, 204, 40] as RGB,
  orange: [228, 116, 36] as RGB,
}
/** ACeP 4-bit colour codes: black, white, green, blue, red, yellow, orange, clean (shows white) */
const ACEP: RGB[] = [INK.black, INK.white, INK.green, INK.blue, INK.red, INK.yellow, INK.orange, INK.white]

/**
 * A frame for the canvas: `vw`×`vh` view pixels, each taken from the panel's native pixel. Panels
 * whose RAM is portrait (2.13", 2.9") are shown landscape, the way GxEPD2's setRotation(1) draws:
 * view (u, v) = native (visibleWidth − 1 − v, u).
 */
class Screen {
  readonly w: number
  readonly h: number
  ver = nextImageVer()
  data: Uint8ClampedArray
  private nw: number
  private rot: boolean
  constructor(nw: number, nh: number, rot: boolean) {
    this.nw = nw; this.rot = rot
    this.w = rot ? nh : nw; this.h = rot ? nw : nh
    this.data = new Uint8ClampedArray(this.w * this.h * 4)
    this.paint(() => INK.white)
  }
  paint(px: (x: number, y: number) => RGB) {
    const d = this.data, { w, h, nw, rot } = this
    for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) {
      const c = rot ? px(nw - 1 - v, u) : px(u, v)
      const i = (v * w + u) * 4
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255
    }
    this.ver = nextImageVer()
  }
  view() { return { image: { w: this.w, h: this.h, ver: this.ver, data: this.data } } }
}

/** BUSY, RST and power: what both SPI controller families share */
function pins(c: CatalogPart, ctx: SimCtx, activeHigh: boolean, onReset: () => void) {
  let busy = false, inReset = false
  const vcc = () => moduleVcc(c, ctx)
  const level = () => { const v = vcc(); return v > 0 ? { v: busy === activeHigh ? v : 0, r: 100 } : null }
  const rst = ctx.pin("RST")
  ctx.hook(rst, () => {
    const l = ctx.level("RST")
    if (l === false) inReset = true
    else if (l && inReset) { inReset = false; onReset() }
  })
  return {
    get busy() { return busy },
    /** the controller can take bytes: powered and not held in reset */
    alive: () => vcc() > 0 && !inReset,
    setBusy(b: boolean) { if (b !== busy) { busy = b; ctx.drive("BUSY", level()) } },
    drives: () => ctx.set("BUSY", level()),
  }
}

// ── Solomon SSD16xx (SSD1680, SSD1681) ───────────────────────────────────────────────────────
interface SsdPanel {
  /** RAM width (sources, a multiple of 8) and height (gates); visible width */
  w: number; h: number; vw?: number
  /** 3-colour: RAM 0x26 is red (1 = red); otherwise it's the "previous" picture for partial refresh */
  red?: boolean
  /** shown landscape (portrait RAM) */
  rot?: boolean
  /** full / partial refresh times in seconds (shortened from the panels' 2.5–27 s) */
  full: number; part: number
}
function ssd16xx(p: SsdPanel): ProtoMaker {
  return (c, ctx) => {
    const xb = p.w / 8
    const bw = new Uint8Array(xb * p.h).fill(0xff), rd = new Uint8Array(xb * p.h)
    const scr = new Screen(p.vw ?? p.w, p.h, !!p.rot)
    let cmd = -1, args: number[] = []
    let entry = 3, xs = 0, xe = xb - 1, ys = 0, ye = p.h - 1, xc = 0, yc = 0
    let ctl1 = 0, ctl2 = 0xff, tb = false, sleeping = false, refreshing = false
    const defaults = () => { entry = 3; xs = 0; xe = xb - 1; ys = 0; ye = p.h - 1; xc = 0; yc = 0; ctl1 = 0; ctl2 = 0xff; tb = false; cmd = -1; args = [] }
    const io = pins(c, ctx, true, () => { defaults(); sleeping = false; refreshing = false; io.setBusy(false) })
    const busyFor = (s: number, done?: () => void) => { io.setBusy(true); ctx.after(s, () => { done?.(); io.setBusy(false) }) }
    const step = () => {
      const xlo = Math.min(xs, xe), xhi = Math.max(xs, xe), ylo = Math.min(ys, ye), yhi = Math.max(ys, ye)
      const xi = entry & 1 ? 1 : -1, yi = entry & 2 ? 1 : -1
      const mvX = () => { xc += xi; if (xc > xhi) { xc = xlo; return true } if (xc < xlo) { xc = xhi; return true } return false }
      const mvY = () => { yc += yi; if (yc > yhi) { yc = ylo; return true } if (yc < ylo) { yc = yhi; return true } return false }
      if (entry & 4) { if (mvY()) mvX() } else if (mvX()) mvY()
    }
    const opt = (bit: number, n: number) => (n === 4 ? 0 : n === 8 ? bit ^ 1 : bit)
    const show = (b: Uint8Array, r: Uint8Array, c1: number, flip: boolean) => scr.paint((x, y) => {
      const row = flip ? p.h - 1 - y : y, i = row * xb + (x >> 3), k = 7 - (x & 7)
      if (p.red && opt((r[i] >> k) & 1, c1 >> 4)) return INK.red
      return opt((b[i] >> k) & 1, c1 & 15) ? INK.white : INK.black
    })
    const activate = () => {
      if (refreshing) return
      const display = !!(ctl2 & 0x04), partial = !!(ctl2 & 0x08)
      if (!display) { busyFor(ctl2 & 0x03 ? 0.01 : 0.02); return } // power on / off, load LUT …
      // the controller reads the RAM as it starts the waveform; the picture appears as BUSY ends
      const b = bw.slice(), r = rd.slice(), c1 = ctl1, flip = tb
      refreshing = true
      busyFor(partial ? p.part : p.red ? Math.max(p.full, 1) : p.full, () => { refreshing = false; show(b, r, c1, flip) })
    }
    const command = (b: number) => {
      cmd = b; args = []
      if (b === 0x12) { defaults(); busyFor(0.002) } // SW reset: registers to defaults, RAM kept
      else if (b === 0x20) activate()
    }
    const data = (b: number) => {
      if (cmd === 0x24 || cmd === 0x26) {
        if (xc < xb && yc < p.h) (cmd === 0x24 ? bw : rd)[yc * xb + xc] = b
        step(); return
      }
      const a = args; a.push(b)
      switch (cmd) {
        case 0x01: if (a.length === 3) tb = !!(a[2] & 1); break // driver output: MUX, GD/SM/TB
        case 0x10: if (a[0] & 3) sleeping = true; break // deep sleep until a hardware reset
        case 0x11: entry = a[0] & 7; break
        case 0x21: if (a.length === 1) ctl1 = a[0]; break
        case 0x22: ctl2 = a[0]; break
        case 0x44: if (a.length === 1) xs = a[0] & 0x3f; else if (a.length === 2) xe = a[1] & 0x3f; break
        case 0x45: if (a.length === 2) ys = (a[0] | (a[1] << 8)) & 0x1ff; else if (a.length === 4) ye = (a[2] | (a[3] << 8)) & 0x1ff; break
        case 0x4e: if (a.length === 1) xc = a[0] & 0x3f; break
        case 0x4f: if (a.length === 2) yc = (a[0] | (a[1] << 8)) & 0x1ff; break
      }
    }
    ctx.spi({
      out: () => 0xff,
      in: (b) => {
        if (!io.alive() || sleeping) return
        if (ctx.level("DC") === false) command(b); else data(b)
      },
    })
    return { drives: io.drives, view: () => scr.view() }
  }
}

// ── UltraChip UC81xx (UC8176, UC8179) and the ACeP 5.65" 7-colour controller ──────────────────
interface UcPanel {
  w: number; h: number
  kind: "uc8176" | "uc8179" | "acep"
  /** full refresh (LUT from OTP) / fast refresh (LUT from registers) in seconds */
  full: number; part: number
}
function uc81xx(p: UcPanel): ProtoMaker {
  return (c, ctx) => {
    const acep = p.kind === "acep"
    const size = acep ? (p.w * p.h) / 2 : (p.w * p.h) / 8
    const ram1 = new Uint8Array(size).fill(acep ? 0x11 : 0xff), ram2 = new Uint8Array(size).fill(0xff)
    const scr = new Screen(p.w, p.h, false)
    let cmd = -1, args: number[] = []
    let psr = acep ? 0xef : 0x1f, ddx = 1, resW = p.w, resH = p.h
    let partial = false, hs = 0, he = p.w - 1, vs = 0, ve = p.h - 1
    let ax = 0, ay = 0, sleeping = false, refreshing = false
    let lutFrames = 0 // frames in the VCOM LUT (0x20): groups of level, 4 phase lengths, repeat
    const defaults = () => { psr = acep ? 0xef : 0x1f; ddx = 1; resW = p.w; resH = p.h; partial = false; hs = 0; he = p.w - 1; vs = 0; ve = p.h - 1; cmd = -1; args = [] }
    const io = pins(c, ctx, false, () => {
      defaults(); sleeping = false; refreshing = false
      io.setBusy(true); ctx.after(0.002, () => io.setBusy(false)) // the controller boots after reset
    })
    const busyFor = (s: number, done?: () => void) => { io.setBusy(true); ctx.after(s, () => { done?.(); io.setBusy(false) }) }
    const ppb = acep ? 2 : 8 // pixels per byte
    const refresh = () => {
      if (refreshing) return
      const a = ram1.slice(), b = ram2.slice(), mode = psr, pol = ddx
      const kw = !!(mode & 0x10), up = !!(mode & 0x08), right = !!(mode & 0x04)
      refreshing = true
      // LUT from registers: a short VCOM waveform is GxEPD2's fast (partial) refresh
      const fast = !acep && !!(mode & 0x20) && lutFrames < 100
      busyFor(fast ? p.part : p.full, () => {
        refreshing = false
        scr.paint((x0, y0) => {
          const x = acep || right ? x0 : p.w - 1 - x0, y = acep || up ? y0 : p.h - 1 - y0
          if (acep) { const v = a[(y * p.w + x) >> 1]; return ACEP[(x & 1 ? v : v >> 4) & 7] }
          const i = y * (p.w / 8) + (x >> 3), k = 7 - (x & 7)
          const bitNew = (b[i] >> k) & 1, bitOld = (a[i] >> k) & 1
          // DDX[0] = 1: 1 is white (GxEPD2); 0: inverted (Waveshare's ~image)
          if (kw) return bitNew ^ (pol & 1 ? 0 : 1) ? INK.white : INK.black
          // B/W/R: B/W from 0x10, red from 0x13 (DDX[1] = 1: 0 is red)
          if (bitNew === (pol & 2 ? 0 : 1)) return INK.red
          return bitOld ^ (pol & 1 ? 0 : 1) ? INK.white : INK.black
        })
      })
    }
    const command = (b: number) => {
      cmd = b; args = []
      switch (b) {
        case 0x02: busyFor(0.01); break // power off
        case 0x04: busyFor(0.02); break // power on
        case 0x10: case 0x13: // data start: from the partial window's corner, or the top left
          ax = partial ? hs & ~(ppb - 1) : 0; ay = partial ? vs : 0; break
        case 0x12: refresh(); break
        case 0x20: if (!acep) lutFrames = 0; break
        case 0x91: partial = true; break
        case 0x92: partial = false; break
      }
    }
    const data = (b: number) => {
      if (cmd === 0x10 || cmd === 0x13) {
        if (acep && cmd === 0x13) return
        const ram = cmd === 0x10 ? ram1 : ram2
        if (ax < p.w && ay < p.h) ram[(ay * p.w + ax) / ppb] = b
        const x0 = partial ? hs & ~(ppb - 1) : 0, x1 = partial ? Math.min(he, resW - 1) : resW - 1
        ax += ppb
        if (ax > x1) { ax = x0; ay++; if (ay > (partial ? Math.min(ve, resH - 1) : resH - 1)) ay = partial ? vs : 0 }
        return
      }
      const a = args; a.push(b)
      switch (cmd) {
        case 0x00: if (a.length === 1) { if (!acep && !(b & 1)) { defaults(); busyFor(0.002) } psr = b } break
        case 0x07: if (b === 0xa5) sleeping = true; break
        case 0x20: { const k = (a.length - 1) % 6; if (!acep && k === 5) lutFrames += (a[a.length - 5] + a[a.length - 4] + a[a.length - 3] + a[a.length - 2]) * Math.max(1, b) } break
        case 0x50: if (a.length === 1) ddx = p.kind === "uc8176" ? (b >> 4) & 3 : b & 3; break
        case 0x61: if (a.length === 4) { resW = Math.min(p.w, ((a[0] << 8) | a[1]) & 0x3f8 || p.w); resH = Math.min(p.h, ((a[2] << 8) | a[3]) & 0x3ff || p.h) } break
        case 0x90:
          if (a.length === 2) hs = ((a[0] << 8) | a[1]) & 0x3f8
          else if (a.length === 4) he = ((a[2] << 8) | a[3]) | 7
          else if (a.length === 6) vs = ((a[4] << 8) | a[5]) & 0x3ff
          else if (a.length === 8) ve = ((a[6] << 8) | a[7]) & 0x3ff
          break
      }
    }
    ctx.spi({
      out: () => 0xff,
      in: (b) => {
        if (!io.alive() || sleeping) return
        if (ctx.level("DC") === false) command(b); else data(b)
      },
    })
    return { drives: io.drives, view: () => scr.view() }
  }
}

// ── Seeed Grove Triple Color E-Ink 2.13" (UART, 104×212, B/W/R) ──────────────────────────────
/**
 * The module's MCU announces itself with 'c' until the board answers 'a'; it acknowledges with 'b'
 * and then takes 2756 bytes of black plane and 2756 bytes of red plane (104×212, 13 bytes a row,
 * 0 = ink), refreshes, and starts announcing again.
 */
const groveEink: ProtoMaker = (c, ctx) => {
  const W = 104, H = 212, PLANE = (W / 8) * H
  const scr = new Screen(W, H, true)
  let state: "idle" | "frame" | "refresh" = "idle"
  const buf: number[] = []
  let lastByte = 0
  const port = ctx.uart({
    baud: 230400,
    onByte: (b) => {
      if (moduleVcc(c, ctx) <= 0) return
      if (state === "idle") { if (b === 0x61) { state = "frame"; buf.length = 0; lastByte = ctx.now(); port.send("b") } return }
      if (state !== "frame") return
      // a frame that stalls for 5 s is dropped
      if ((ctx.now() - lastByte) / ctx.hz > 5) buf.length = 0
      lastByte = ctx.now()
      buf.push(b)
      if (buf.length < 2 * PLANE) return
      const k = buf.slice(0, PLANE), r = buf.slice(PLANE, 2 * PLANE)
      state = "refresh"
      ctx.after(1.0, () => {
        scr.paint((x, y) => {
          const i = y * (W / 8) + (x >> 3), m = 0x80 >> (x & 7)
          return !(r[i] & m) ? INK.red : !(k[i] & m) ? INK.black : INK.white
        })
        state = "idle"
      })
    },
  })
  const hello = () => { if (state === "idle" && moduleVcc(c, ctx) > 0) port.send("c"); ctx.after(0.1, hello) }
  ctx.after(0.05, hello)
  const dev: CatDevice = { view: () => scr.view() }
  return dev
}

const group: ModelGroup = {
  proto: {
    "epd-154-ssd1681": ssd16xx({ w: 200, h: 200, full: 0.6, part: 0.3 }),
    "epd-213-ssd1680": ssd16xx({ w: 128, vw: 122, h: 250, rot: true, full: 0.6, part: 0.3 }),
    "epd-213c-ssd1680": ssd16xx({ w: 128, vw: 122, h: 250, rot: true, red: true, full: 1, part: 1 }),
    "epd-290-ssd1680": ssd16xx({ w: 128, h: 296, rot: true, full: 0.6, part: 0.3 }),
    "epd-290c-ssd1680": ssd16xx({ w: 128, h: 296, rot: true, red: true, full: 1, part: 1 }),
    "epd-420-uc8176": uc81xx({ w: 400, h: 300, kind: "uc8176", full: 0.6, part: 0.3 }),
    "epd-565-acep": uc81xx({ w: 600, h: 448, kind: "acep", full: 1, part: 1 }),
    "epd-750-uc8179": uc81xx({ w: 800, h: 480, kind: "uc8179", full: 0.8, part: 0.4 }),
    "grove-eink-213": groveEink,
  },
}
export default group
