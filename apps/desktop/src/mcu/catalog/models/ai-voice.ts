// Models: AI vision and voice modules. They "see" and "hear" what the user picks with the part's
// controls (objects with IDs and boxes, a spoken command) and report it through the module's real
// protocol, so the usual Arduino libraries work unchanged:
//  - DFRobot HuskyLens: its 0x55 0xAA 0x11 frame protocol over I²C (0x32) or UART (9600)   — HUSKYLENS library
//  - Seeed Grove Vision AI V2 (SSCMA firmware): AT commands over the I²C transport (0x62)  — Seeed_Arduino_SSCMA
//  - Seeed Grove Speech Recognizer: one byte per command (1–22) at 9600 baud
//  - Seeed Grove Offline Voice Recognition (VC-02): 5-byte frames at 115200, code in byte 1 — Seeed-GroveOfflineVoiceRecognition
//  - DFRobot DF2301Q: CMDID / play / mute / volume / wake-time registers at 0x64, or its UART frames — DFRobot_DF2301Q
//  - ReSpeaker Lite: the XU316's I²C control (0x42: VNR, mic mute, speaker enable, version), the
//    AIC3204 codec's registers (0x18), the USR / MUTE button lines and the WS2812 LED
import { NeoPixelDecoder } from "../../devices"
import type { I2CDevice } from "../../devices"
import { moduleVcc, nextImageVer, type SimCtx } from "../devices"
import type { ModView } from "../look"
import type { CatalogPart } from "../types"
import type { ModelGroup } from "./types"

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))
const u16 = (v: number) => [v & 0xff, (v >> 8) & 0xff]

/**
 * A command the user "says" (or an object they show) from a control: a click says the selected
 * one again; moving the slider says the new one once it settles (a drag doesn't say every value).
 */
function sayer(ctx: SimCtx, key: string, say: (v: number) => void) {
  let token = 0
  return (u: { active?: boolean; v?: Record<string, number> }) => {
    if (u.v && u.v[key] !== undefined) {
      const mine = ++token
      ctx.after(0.25, () => { if (mine === token) say(Math.round(ctx.ctl(key))) })
    } else if (u.active) say(Math.round(ctx.ctl(key)))
  }
}

// ── a tiny raster for the camera views ─────────────────────────────────────────────────────
class Raster {
  readonly data: Uint8ClampedArray
  readonly w: number
  readonly h: number
  constructor(w: number, h: number) { this.w = w; this.h = h; this.data = new Uint8ClampedArray(w * h * 4) }
  fill(c: [number, number, number]) { for (let i = 0; i < this.w * this.h; i++) this.data.set([c[0], c[1], c[2], 255], i * 4) }
  px(x: number, y: number, c: [number, number, number]) {
    x = Math.round(x); y = Math.round(y)
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return
    this.data.set([c[0], c[1], c[2], 255], (y * this.w + x) * 4)
  }
  rect(x0: number, y0: number, x1: number, y1: number, c: [number, number, number]) {
    for (let x = x0; x <= x1; x++) { this.px(x, y0, c); this.px(x, y1, c) }
    for (let y = y0; y <= y1; y++) { this.px(x0, y, c); this.px(x1, y, c) }
  }
  line(x0: number, y0: number, x1: number, y1: number, c: [number, number, number]) {
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))))
    for (let i = 0; i <= n; i++) this.px(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, c)
  }
}
const PALETTE: [number, number, number][] = [[160, 160, 160], [64, 160, 255], [255, 96, 96], [80, 220, 120], [255, 200, 40], [200, 100, 255], [40, 220, 220], [255, 140, 40]]

// ── DFRobot HuskyLens ──────────────────────────────────────────────────────────────────────
export const HUSKY_ALGOS = ["face recognition", "object tracking", "object recognition", "line tracking", "colour recognition", "tag recognition", "object classification"]
const HL = {
  REQUEST: 0x20, REQUEST_BLOCKS: 0x21, REQUEST_ARROWS: 0x22, REQUEST_LEARNED: 0x23, REQUEST_BLOCKS_LEARNED: 0x24, REQUEST_ARROWS_LEARNED: 0x25,
  REQUEST_BY_ID: 0x26, REQUEST_BLOCKS_BY_ID: 0x27, REQUEST_ARROWS_BY_ID: 0x28, RETURN_INFO: 0x29, RETURN_BLOCK: 0x2a, RETURN_ARROW: 0x2b,
  KNOCK: 0x2c, ALGORITHM: 0x2d, RETURN_OK: 0x2e, CUSTOMNAMES: 0x2f, LEARN: 0x36, FORGET: 0x37, IS_PRO: 0x3b,
} as const
/** a HuskyLens frame: 0x55 0xAA 0x11, length, command, data, checksum (low byte of the sum) */
export function huskyFrame(cmd: number, data: number[] = []): number[] {
  const f = [0x55, 0xaa, 0x11, data.length, cmd, ...data]
  return [...f, f.reduce((a, b) => a + b, 0) & 0xff]
}

function huskylens(c: CatalogPart, ctx: SimCtx) {
  let algo = clamp(Math.round(ctx.ctl("algo")), 0, 6)
  let frame = 0
  let forgotten = false
  const extraLearned = new Set<number>()
  const names = new Map<number, string>()
  const powered = () => moduleVcc(c, ctx) > 0
  const objects = () => {
    const n = clamp(Math.round(ctx.ctl("n")), 0, 3), out: { id: number; a: number; b: number; cw: number; d: number }[] = []
    for (let i = 1; i <= n; i++) out.push({ id: forgotten ? 0 : Math.max(0, Math.round(ctx.ctl(`id${i}`))), a: Math.round(ctx.ctl(`x${i}`)), b: Math.round(ctx.ctl(`y${i}`)), cw: Math.round(ctx.ctl(`w${i}`)), d: Math.round(ctx.ctl(`h${i}`)) })
    return out
  }
  const learned = () => { const s = new Set<number>(extraLearned); if (!forgotten) for (const o of objects()) if (o.id > 0) s.add(o.id); return s.size }
  const reply = (cmd: number, data: number[]): number[] => {
    const arrows = algo === 3
    const ok = huskyFrame(HL.RETURN_OK)
    const id = data.length >= 2 ? data[0] | (data[1] << 8) : 0
    switch (cmd) {
      case HL.KNOCK: return ok
      case HL.ALGORITHM: if (id <= 6) algo = id; return ok
      case HL.LEARN: extraLearned.add(id); forgotten = false; return ok
      case HL.FORGET: extraLearned.clear(); forgotten = true; return ok
      case HL.CUSTOMNAMES: { const n = data[1] ?? 0; names.set(data[0], String.fromCharCode(...data.slice(2, 2 + Math.max(0, n - 1)))); return ok }
      case HL.IS_PRO: return huskyFrame(HL.IS_PRO, u16(0))
      case HL.REQUEST: case HL.REQUEST_BLOCKS: case HL.REQUEST_ARROWS: case HL.REQUEST_LEARNED: case HL.REQUEST_BLOCKS_LEARNED: case HL.REQUEST_ARROWS_LEARNED:
      case HL.REQUEST_BY_ID: case HL.REQUEST_BLOCKS_BY_ID: case HL.REQUEST_ARROWS_BY_ID: {
        const wantBlocks = ![HL.REQUEST_ARROWS, HL.REQUEST_ARROWS_LEARNED, HL.REQUEST_ARROWS_BY_ID].includes(cmd as 0x22)
        const wantArrows = ![HL.REQUEST_BLOCKS, HL.REQUEST_BLOCKS_LEARNED, HL.REQUEST_BLOCKS_BY_ID].includes(cmd as 0x21)
        let items = objects().filter(() => (arrows ? wantArrows : wantBlocks))
        if ([HL.REQUEST_LEARNED, HL.REQUEST_BLOCKS_LEARNED, HL.REQUEST_ARROWS_LEARNED].includes(cmd as 0x23)) items = items.filter((o) => o.id > 0)
        if (cmd >= HL.REQUEST_BY_ID && cmd <= HL.REQUEST_ARROWS_BY_ID) items = items.filter((o) => o.id === id)
        frame = (frame + 1) & 0xffff
        const out = huskyFrame(HL.RETURN_INFO, [...u16(items.length), ...u16(learned()), ...u16(frame), 0, 0, 0, 0])
        for (const o of items) out.push(...huskyFrame(arrows ? HL.RETURN_ARROW : HL.RETURN_BLOCK, [...u16(o.a), ...u16(o.b), ...u16(o.cw), ...u16(o.d), ...u16(o.id)]))
        return out
      }
      default: return cmd >= 0x30 && cmd <= 0x3c ? ok : [] // photo, knowledges, custom text, sensor, screenshot, firmware version …
    }
  }
  // the frame parser (one per transport)
  const parser = (answer: (bytes: number[]) => void) => {
    let buf: number[] = []
    return (b: number) => {
      if (!powered()) { buf = []; return }
      buf.push(b)
      if (buf[0] !== 0x55) { buf = []; return }
      if (buf.length === 2 && b !== 0xaa) { buf = b === 0x55 ? [0x55] : []; return }
      if (buf.length < 5 || buf.length < buf[3] + 6) return
      const f = buf; buf = []
      if ((f.slice(0, -1).reduce((a, x) => a + x, 0) & 0xff) !== f[f.length - 1]) return
      const r = reply(f[4], f.slice(5, -1))
      if (r.length) answer(r)
    }
  }
  // I²C: the library writes a frame, then reads 16-byte chunks until a whole answer has arrived
  let out: number[] = []
  const onI2c = parser((r) => { out = [...out, ...r] })
  const dev: I2CDevice = { write: (b) => onI2c(b), read: () => (out.length ? out.shift()! : 0) }
  ctx.i2c(0x32, dev)
  // UART at 9600: T (TX) answers, R (RX) listens
  const port = ctx.uart({ rx: "R/SCL", tx: "T/SDA", baud: 9600, onByte: parser((r) => ctx.after(0.001, () => port.send(r))) })

  let ver = 0, key = ""
  const img = new Raster(80, 60)
  return {
    ui(u: { v?: Record<string, number> }) { if (u.v?.algo !== undefined) algo = clamp(Math.round(u.v.algo), 0, 6); if (u.v && Object.keys(u.v).some((k) => /^(id|n)/.test(k))) forgotten = false },
    view(): ModView | undefined {
      if (!powered()) return { image: { w: 80, h: 60, ver: 0, data: new Uint8ClampedArray(80 * 60 * 4) } }
      const objs = objects()
      const k = `${algo}|${JSON.stringify(objs)}`
      if (k !== key || !ver) {
        key = k; ver = nextImageVer()
        img.fill([12, 16, 28])
        for (const o of objs) {
          const col = PALETTE[o.id % PALETTE.length]
          if (algo === 3) { img.line(o.a / 4, o.b / 4, o.cw / 4, o.d / 4, col); img.rect(o.cw / 4 - 1, o.d / 4 - 1, o.cw / 4 + 1, o.d / 4 + 1, col) }
          else img.rect(Math.round((o.a - o.cw / 2) / 4), Math.round((o.b - o.d / 2) / 4), Math.round((o.a + o.cw / 2) / 4), Math.round((o.b + o.d / 2) / 4), col)
        }
        for (let i = 0; i <= algo; i++) img.px(1 + i * 2, 1, [255, 255, 255]) // algorithm dots, top left
      }
      return { image: { w: 80, h: 60, ver, data: img.data } }
    },
  }
}

// ── Seeed Grove Vision AI V2 (Himax WiseEye2, SSCMA firmware) ─────────────────────────────
function sscma(c: CatalogPart, ctx: SimCtx) {
  const kit = c.type.includes("kit")
  const ID = kit ? "6c1e0a4f" : "3a8f5d21"
  const powered = () => moduleVcc(c, ctx) > 0
  let tx: number[] = [] // bytes waiting for the host (\r{json}\n …)
  let line = ""
  let invoking = 0, tscore = 60, tiou = 55, seq = 0
  let got: number[] = []
  let reply: number[] = []
  const send = (o: unknown) => { for (const ch of `\r${JSON.stringify(o)}\n`) tx.push(ch.charCodeAt(0)) }
  const objects = () => {
    const n = clamp(Math.round(ctx.ctl("n")), 0, 3), out: { target: number; score: number; x: number; y: number; w: number; h: number }[] = []
    for (let i = 1; i <= n; i++) out.push({ target: Math.round(ctx.ctl(`t${i}`)), score: Math.round(ctx.ctl(`s${i}`)), x: Math.round(ctx.ctl(`x${i}`)), y: Math.round(ctx.ctl(`y${i}`)), w: Math.round(ctx.ctl(`w${i}`)), h: Math.round(ctx.ctl(`h${i}`)) })
    return out
  }
  const classify = () => Math.round(ctx.ctl("model")) === 1
  const event = () => {
    const objs = objects().filter((o) => o.score >= tscore || classify())
    const data: Record<string, unknown> = { count: seq++, perf: [7, classify() ? 16 : 48, 1] }
    if (classify()) data.classes = objs.map((o) => [o.score, o.target])
    else data.boxes = objs.map((o) => [o.x, o.y, o.w, o.h, o.score, o.target])
    data.resolution = [240, 240]
    send({ type: 1, name: "INVOKE", code: 0, data })
  }
  const loop = (left: number) => {
    if (!invoking || !powered()) return
    event()
    if (left > 1 || left <= 0) ctx.after(0.06, () => loop(left > 0 ? left - 1 : left))
    else invoking = 0
  }
  const at = (cmd: string) => {
    if (!cmd.startsWith("AT+")) return
    const body = cmd.slice(3)
    const eq = body.indexOf("=")
    const name = eq < 0 ? body : body.slice(0, eq)
    const args = eq < 0 ? [] : body.slice(eq + 1).split(",")
    const ok = (data: unknown) => send({ type: 0, name, code: 0, data })
    switch (name) {
      case "ID?": return ok(ID)
      case "NAME?": return ok("Grove Vision AI V2")
      case "VER?": return ok({ at_api: "v0", software: "2024.08.16", hardware: "1" })
      case "STAT?": return ok({ boot_count: 1, is_ready: 1 })
      case "INFO?": return ok({ crc16_maxim: 13777, info: "" })
      case "MODEL?": return ok({ id: 1, type: classify() ? 4 : 3, address: 4194304, size: 1048576 })
      case "MODELS?": return ok([1])
      case "SENSORS?": return ok([{ id: 1, type: 1, state: 1, opt_id: 1, opt_detail: "240x240 Auto" }])
      case "TSCORE?": return ok(tscore)
      case "TIOU?": return ok(tiou)
      case "TSCORE": tscore = clamp(Number(args[0]) || 0, 0, 100); return ok(tscore)
      case "TIOU": tiou = clamp(Number(args[0]) || 0, 0, 100); return ok(tiou)
      case "BREAK": invoking = 0; return ok({})
      case "RST": invoking = 0; return ok({})
      case "ACTION": return ok({ crc16_maxim: 0 })
      case "INVOKE": {
        const times = Number(args[0] ?? 1)
        ok({ model: { id: 1, type: classify() ? 4 : 3, address: 4194304, size: 1048576 }, algorithm: { type: classify() ? 4 : 3, category: classify() ? 2 : 1, input_from: 1 }, sensor: { id: 1, type: 1, state: 1, opt_id: 1, opt_detail: "240x240 Auto" } })
        invoking = 1
        ctx.after(0.05, () => loop(times))
        return
      }
      default: return send({ type: 0, name, code: 8, data: {} }) // CMD_ENOTSUP
    }
  }
  // the I²C transport: [0x10, cmd, len_hi, len_lo, payload…, (2 checksum bytes)]
  const transport = () => {
    const g = got; got = []
    if (g.length < 4 || g[0] !== 0x10 || !powered()) return
    const cmd = g[1], len = (g[2] << 8) | g[3]
    if (cmd === 0x02) { // write
      for (const b of g.slice(4, 4 + len)) {
        line += String.fromCharCode(b)
        if (line.endsWith("\r\n")) { at(line.slice(0, -2).trim()); line = "" }
        if (line.length > 4096) line = ""
      }
    } else if (cmd === 0x03) { const n = Math.min(tx.length, 0xffff); reply = [n >> 8, n & 0xff] } // available
    else if (cmd === 0x01) reply = tx.splice(0, len) // read
    else if (cmd === 0x06) { tx = []; line = ""; invoking = 0 } // reset
  }
  const dev: I2CDevice = {
    start: () => { if (got.length) transport() },
    write: (b) => got.push(b),
    read: () => { if (got.length) transport(); return reply.length ? reply.shift()! : 0 },
    stop: () => transport(),
  }
  ctx.i2c(0x62, dev)

  let ver = 0, key = ""
  const img = new Raster(60, 60)
  return {
    view(): ModView | undefined {
      if (!powered()) return { image: { w: 60, h: 60, ver: 0, data: new Uint8ClampedArray(60 * 60 * 4) } }
      const objs = objects(), k = `${classify()}|${JSON.stringify(objs)}`
      if (k !== key || !ver) {
        key = k; ver = nextImageVer()
        img.fill([14, 22, 18])
        objs.forEach((o, i) => {
          const col = PALETTE[(o.target + 1) % PALETTE.length]
          if (classify()) { for (let x = 2; x < 2 + (o.score / 100) * 56; x++) for (let y = 4 + i * 8; y < 9 + i * 8; y++) img.px(x, y, col) }
          else img.rect(Math.round((o.x - o.w / 2) / 4), Math.round((o.y - o.h / 2) / 4), Math.round((o.x + o.w / 2) / 4), Math.round((o.y + o.h / 2) / 4), col)
        })
      }
      return { image: { w: 60, h: 60, ver, data: img.data } }
    },
  }
}

// ── Seeed Grove Speech Recognizer (Nuvoton ISD9160) ───────────────────────────────────────
export const SPEECH_COMMANDS = ["Turn on the light", "Turn off the light", "Play music", "Pause", "Next", "Previous", "Up", "Down", "Turn on the TV", "Turn off the TV", "Increase temperature", "Decrease temperature", "What's the time", "Open the door", "Close the door", "Left", "Right", "Stop", "Start", "Mode 1", "Mode 2", "Go"]

function voiceUart(c: CatalogPart, ctx: SimCtx, baud: number, frame: (cmd: number) => number[], label: (cmd: number) => string) {
  const port = ctx.uart({ rx: "RX", tx: "TX", baud })
  let heard = "", until = 0
  const say = (cmd: number) => {
    if (moduleVcc(c, ctx) <= 0) return
    port.send(frame(cmd))
    heard = label(cmd); until = ctx.now() + 2 * ctx.hz
  }
  return {
    ui: sayer(ctx, "cmd", say),
    view: (): ModView => ({ text: moduleVcc(c, ctx) > 0 ? (ctx.now() < until ? heard : "listening") : "" }),
  }
}

// ── Seeed Grove Offline Voice Recognition (Ai-Thinker VC-02, wake word "Hello pudding") ────
export const OFFLINE_VOICE: string[] = [
  "Hello pudding (wake)", "see you later", "match the air conditioner", "turn on the air conditioner", "turn off the air conditioner", "automatic mode", "cold mode", "heat mode", "dry mode", "fan mode",
  "sleeping mode", "automatic fan", "low fan", "medium fan", "high fan", "higher the fan", "lower the fan", "sixteen centigrade", "seventeen centigrade", "eighteen centigrade",
  "nineteen centigrade", "twenty centigrade", "twenty one centigrade", "twenty two centigrade", "twenty three centigrade", "twenty four centigrade", "twenty five centigrade", "twenty six centigrade", "twenty seven centigrade", "twenty eight centigrade",
  "twenty nine centigrade", "thirty centigrade", "warmer", "cooler", "start to fan", "stop to fan", "air swing up and down", "air swing left and right", "air conditioner reset", "turn on the light",
  "turn off the light", "cold light turn on", "cold light turn off", "warm light turn on", "warm light turn off",
]
/** the module's 5-byte report: the command's code is byte 1 (what the library and Seeed's ESPHome example read) */
export const offlineVoiceFrame = (code: number) => [0x5a, code & 0xff, 0x00, 0x00, (0x5a + code) & 0xff]

// ── DFRobot Gravity DF2301Q ────────────────────────────────────────────────────────────────
export const DF2301Q_WORDS: Record<number, string> = {
  1: "Wake word (learned)", 2: "Hello robot", 22: "Go forward", 23: "Retreat", 24: "Park a car", 25: "Turn left 90°", 26: "Turn left 45°", 27: "Turn left 30°", 28: "Turn right 90°", 29: "Turn right 45°", 30: "Turn right 30°",
  31: "Shift down a gear", 32: "Line tracking mode", 33: "Light tracking mode", 34: "Bluetooth mode", 35: "Obstacle avoidance mode", 36: "Face recognition", 37: "Object tracking", 38: "Object recognition", 39: "Line tracking", 40: "Color recognition",
  41: "Tag recognition", 42: "Object sorting", 43: "QR code recognition", 44: "General settings", 45: "Clear screen", 46: "Learn once", 47: "Forget", 48: "Load model", 49: "Save model", 50: "Take photos and save them",
  51: "Save and return", 62: "Display smiley face", 63: "Display crying face", 64: "Display heart", 65: "Turn off dot matrix", 66: "Read current posture", 67: "Read ambient light", 68: "Read compass", 69: "Read temperature", 70: "Read acceleration",
  71: "Read sound intensity", 72: "Calibrate gyroscope", 73: "Turn on the camera", 74: "Turn off the camera", 75: "Turn on the fan", 76: "Turn off the fan", 77: "Fan speed gear 1", 78: "Fan speed gear 2", 79: "Fan speed gear 3", 80: "Start oscillating",
  81: "Stop oscillating", 82: "Reset", 83: "Servo to 10°", 84: "Servo to 30°", 85: "Servo to 45°", 86: "Servo to 60°", 87: "Servo to 90°", 88: "Turn on the buzzer", 89: "Turn off the buzzer", 90: "Turn on the speaker",
  91: "Turn off the speaker", 92: "Play music", 93: "Stop playing", 94: "The last track", 95: "The next track", 96: "Repeat this track", 97: "Volume up", 98: "Volume down", 99: "Volume to maximum", 100: "Volume to minimum",
  101: "Volume to medium", 102: "Play poem", 103: "Turn on the light", 104: "Turn off the light", 105: "Brighten the light", 106: "Dim the light", 107: "Brightness to maximum", 108: "Brightness to minimum", 109: "Increase color temperature", 110: "Decrease color temperature",
  111: "Color temperature to maximum", 112: "Color temperature to minimum", 113: "Daylight mode", 114: "Moonlight mode", 115: "Color mode", 116: "Set to red", 117: "Set to orange", 118: "Set to yellow", 119: "Set to green", 120: "Set to cyan",
  121: "Set to blue", 122: "Set to purple", 123: "Set to white", 124: "Turn on AC", 125: "Turn off AC", 126: "Increase temperature", 127: "Decrease temperature", 128: "Cool mode", 129: "Heat mode", 130: "Auto mode",
  131: "Dry mode", 132: "Fan mode", 133: "Enable blowing up & down", 134: "Disable blowing up & down", 135: "Enable blowing right & left", 136: "Disable blowing right & left", 137: "Open the window", 138: "Close the window", 139: "Open curtain", 140: "Close curtain",
  141: "Open the door", 142: "Close the door", 200: "Learning wake word", 201: "Learning command word", 202: "Re-learn", 203: "Exit learning", 204: "I want to delete", 205: "Delete wake word", 206: "Delete command word", 207: "Exit deleting", 208: "Delete all",
}
for (let i = 0; i <= 9; i++) DF2301Q_WORDS[52 + i] = `Display number ${i}`
for (let i = 1; i <= 17; i++) DF2301Q_WORDS[4 + i] = `Learned command ${i}`
const dfWord = (id: number) => DF2301Q_WORDS[id] ?? `Command ${id}`
/** a DF2301Q UART frame: F4 F5, length (LE), type, cmd, seq, data, checksum (LE sum of type..data), FB */
export function df2301qFrame(type: number, cmd: number, seq: number, data: number[]): number[] {
  const body = [type, cmd, seq, ...data]
  const sum = body.reduce((a, b) => a + b, 0) & 0xffff
  return [0xf4, 0xf5, ...u16(data.length), ...body, ...u16(sum), 0xfb]
}

function df2301q(c: CatalogPart, ctx: SimCtx) {
  const powered = () => moduleVcc(c, ctx) > 0
  // registers: 0x02 CMDID (latched until read), 0x03 play by CMDID, 0x04 mute, 0x05 volume, 0x06 wake time
  const reg = { cmdid: 0, mute: 0, volume: 5, wake: 20 }
  let ptr = 0, first = true, played = "", heard = "", until = 0, awakeUntil = 0, seq = 0
  const show = (t: string) => { heard = t; until = ctx.now() + 2 * ctx.hz }
  const play = (id: number) => { played = dfWord(id); show(`▶ ${played}`); if (id === 1 || id === 2) awakeUntil = ctx.now() + reg.wake * ctx.hz }
  const dev: I2CDevice = {
    start: () => { first = true },
    write: (b) => {
      if (first) { ptr = b; first = false; return }
      if (!powered()) return
      if (ptr === 0x03) play(b)
      else if (ptr === 0x04) reg.mute = b ? 1 : 0
      else if (ptr === 0x05) reg.volume = b
      else if (ptr === 0x06) reg.wake = b
    },
    read: () => {
      if (!powered()) return 0
      if (ptr === 0x02) { const v = reg.cmdid; reg.cmdid = 0; return v }
      if (ptr === 0x04) return reg.mute
      if (ptr === 0x05) return reg.volume
      if (ptr === 0x06) return reg.wake
      return 0
    },
  }
  ctx.i2c(0x64, dev)
  // UART mode (9600): the Gravity pins are D/T (SDA = TX) and C/R (SCL = RX)
  let rx: number[] = []
  const port = ctx.uart({
    rx: "SCL", tx: "SDA", baud: 9600, onByte: (b) => {
      rx.push(b)
      if (rx[0] !== 0xf4 || (rx.length >= 2 && rx[1] !== 0xf5)) { rx = b === 0xf4 ? [0xf4] : []; return }
      if (rx.length < 4) return
      const n = rx[2] | (rx[3] << 8)
      if (n > 16) { rx = []; return }
      if (rx.length < n + 10) return
      const f = rx; rx = []
      const [type, cmd] = [f[4], f[5]], data = f.slice(7, 7 + n)
      if (f[f.length - 1] !== 0xfb || type !== 0xa1 || !powered()) return
      if (cmd === 0x92 && data[1] === 0x92) play(data[2])
      else if (cmd === 0x96) { const v = data[1]; if (data[0] === 0x80) reg.volume = v; else if (data[0] === 0x83) reg.mute = v ? 1 : 0; else if (data[0] === 0x84) reg.wake = v; else if (data[0] === 0x81) awakeUntil = ctx.now() + reg.wake * ctx.hz }
    },
  })
  const say = (id: number) => {
    if (!powered()) return
    reg.cmdid = id & 0xff
    if (id === 1 || id === 2) awakeUntil = ctx.now() + reg.wake * ctx.hz
    show(dfWord(id))
    port.send(df2301qFrame(0xa0, 0x91, seq++ & 0xff, [id & 0xff]))
  }
  return {
    ui: sayer(ctx, "cmd", say),
    view: (): ModView => ({ text: !powered() ? "" : ctx.now() < until ? heard : ctx.now() < awakeUntil ? "awake" : "asleep" }),
  }
}

// ── Seeed ReSpeaker Lite (XMOS XU316, 2 mics) ──────────────────────────────────────────────
function respeakerLite(c: CatalogPart, ctx: SimCtx) {
  const powered = () => moduleVcc(c, ctx) > 0
  let micMuted = Math.round(ctx.ctl("mute")) ? 1 : 0
  let speaker = 1
  // XMOS device-control over I²C at 0x42: write [resid, cmd, n, payload…]; a read command
  // (cmd bit 7) is followed by a read of n bytes: a status byte, then n-1 payload bytes
  let got: number[] = [], reply: number[] = []
  const transport = () => {
    const g = got; got = []
    if (g.length < 3) return
    const [resid, cmd, n] = g
    if (!powered()) { reply = []; return }
    if (cmd & 0x80) {
      const payload = (): number[] | null => {
        if (resid === 0xf1 && cmd === 0x80) return [clamp(Math.round(ctx.ctl("vnr")), 0, 100)]
        if (resid === 0xf1 && cmd === 0x81) return [micMuted]
        if (resid === 0xf0 && cmd === 0xd8) return [1, 1, 0] // firmware v1.1.0 (I²S)
        return null
      }
      const p = payload()
      reply = p ? [0, ...p, ...Array(Math.max(0, n - 1 - p.length)).fill(0)].slice(0, Math.max(1, n)) : [2] // CONTROL_BAD_COMMAND
    } else if (resid === 0xf1 && cmd === 0x10 && g.length >= 4) speaker = g[3] ? 1 : 0
  }
  ctx.i2c(0x42, {
    start: () => { if (got.length) transport() },
    write: (b) => got.push(b),
    read: () => { if (got.length) transport(); return reply.length ? reply.shift()! : 0 },
    stop: () => transport(),
  })
  // the TLV320AIC3204 codec on the same bus (0x18): page 0 / page 1 register files
  const pages = [new Uint8Array(128), new Uint8Array(128)]
  let page = 0, cptr = 0, cfirst = true
  ctx.i2c(0x18, {
    start: () => { cfirst = true },
    write: (b) => { if (cfirst) { cptr = b & 0x7f; cfirst = false; return } if (cptr === 0) page = b & 1; else pages[page][cptr] = b; cptr = (cptr + 1) & 0x7f },
    read: () => { const v = cptr === 0 ? page : pages[page][cptr]; cptr = (cptr + 1) & 0x7f; return v },
  })
  // the WS2812 LED (XIAO_WS2812 pad)
  const dec = new NeoPixelDecoder(ctx.hz, 1)
  const rgbPin = ctx.pin("RGB")
  ctx.hook(rgbPin, (t) => dec.edge(ctx.track(rgbPin)?.out === true, t))
  // the MUTE line: the button pulls it low; a host pulling it low (ESPHome's mute toggle) toggles the mic mute
  const mutePin = ctx.pin("MUTE")
  let lowSince = -1
  ctx.hook(mutePin, () => {
    const out = ctx.track(mutePin)?.out
    if (out === false && lowSince < 0) lowSince = ctx.now()
    else if (out !== false && lowSince >= 0) { lowSince = -1; if (powered()) micMuted ^= 1 }
  })
  let mutePress = false
  const lines = (now: boolean) => {
    const v = powered() ? ctx.vcc : 0, set = now ? ctx.drive : ctx.set
    set("USR", Math.round(ctx.ctl("usr")) ? { v: 0, r: 50 } : { v, r: 10e3 })
    set("MUTE", mutePress ? { v: 0, r: 50 } : { v, r: 10e3 })
  }
  return {
    drives: () => lines(false),
    ui(u: { active?: boolean; v?: Record<string, number> }) {
      if (u.v?.mute !== undefined) {
        const want = Math.round(u.v.mute) ? 1 : 0
        if (want !== micMuted && powered()) { micMuted = want; mutePress = true; lines(true); ctx.after(0.15, () => { mutePress = false; lines(true) }) }
      }
    },
    view: (): ModView => {
      if (!powered()) return {}
      const [r, g, b] = dec.colors[0] ?? [0, 0, 0]
      const led = r + g + b ? ` ●${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}` : ""
      return { text: `VNR ${clamp(Math.round(ctx.ctl("vnr")), 0, 100)}${micMuted ? " MUTED" : ""}${speaker ? "" : " spk off"}${led}` }
    },
  }
}

const group: ModelGroup = {
  proto: {
    huskylens: (c, ctx) => huskylens(c, ctx),
    sscma: (c, ctx) => sscma(c, ctx),
    "speech-recognizer": (c, ctx) => voiceUart(c, ctx, 9600, (cmd) => [clamp(cmd, 1, 22)], (cmd) => SPEECH_COMMANDS[clamp(cmd, 1, 22) - 1]),
    "offline-voice": (c, ctx) => voiceUart(c, ctx, 115200, offlineVoiceFrame, (cmd) => OFFLINE_VOICE[cmd] ?? `0x${cmd.toString(16)}`),
    df2301q: (c, ctx) => df2301q(c, ctx),
    "respeaker-lite": (c, ctx) => respeakerLite(c, ctx),
  },
}
export default group
