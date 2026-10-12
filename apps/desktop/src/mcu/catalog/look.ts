// Drawings for catalogue parts: each look kind turns a part into an SVG with its pins on the
// 2.54 mm grid (9.6 px at 96 dpi, the breadboard pitch), and becomes a custom element with the
// same `pinInfo` contract as wokwi-elements. A `state` property paints what the simulation
// shows on the part (an LED's glow, pixels, digits, a matrix, a spinning fan, a meter's text).
import type { CatalogPart, GateFn, Icon, Look } from "./types"

export const PITCH = 9.6
export interface PinPos { name: string; x: number; y: number }
export interface Drawing { w: number; h: number; svg: string; pins: PinPos[]; /** where live state is painted */ live: { x: number; y: number; w: number; h: number } }

/** What the simulation paints on a part. */
export interface ModView {
  /** indicator / LED brightness 0..1 per LED */
  glow?: number[]
  /** relay / motor / buzzer / load is on (0..1) */
  on?: number
  /** rotation in degrees (fans, motors, steppers) */
  angle?: number
  /** addressable pixels */
  pix?: [number, number, number][]
  /** seven-segment digits: 8 bits per digit (A–G, DP), plus colon */
  segs?: number[]
  colon?: boolean
  /** a matrix: one byte per row (8×8), or 16-bit words for 14-segment digits */
  rows?: number[]
  /** a meter's text */
  text?: string
  /** a 1-bpp bitmap (SH1107 …): w×h, row-major bytes of 8 horizontal pixels */
  bitmap?: { w: number; h: number; data: Uint8Array }
  /** RGB backlight of a Grove LCD */
  backlight?: [number, number, number]
  /**
   * a colour screen (TFT, e-paper, greyscale OLED): w×h RGBA pixels. `ver` changes with the
   * picture (nextImageVer()); frames carry `data` only when it changed — the canvas keeps the rest.
   */
  image?: { w: number; h: number; ver: number; data?: Uint8ClampedArray }
}

/** data: URLs of recent images, by version */
const imageUrls = new Map<number, string>()
function imageUrl(im: { w: number; h: number; ver: number; data?: Uint8ClampedArray }): string | null {
  const hit = imageUrls.get(im.ver)
  if (hit) return hit
  if (!im.data || typeof document === "undefined") return null
  const cv = document.createElement("canvas")
  cv.width = im.w; cv.height = im.h
  const ctx = cv.getContext("2d")
  if (!ctx) return null
  ctx.putImageData(new ImageData(new Uint8ClampedArray(im.data), im.w, im.h), 0, 0)
  const url = cv.toDataURL()
  imageUrls.set(im.ver, url)
  if (imageUrls.size > 64) imageUrls.delete(imageUrls.keys().next().value!)
  return url
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const FONT = `font-family="ui-monospace,Menlo,monospace"`

/** A short name to print on the part. */
export function shortLabel(p: CatalogPart): string {
  const m = /\(([^)]+)\)/.exec(p.title)
  const base = p.title.replace(/^(Grove|Gravity)\s*[-:–]\s*/, "").replace(/\s*\([^)]*\)/g, "")
  // whole words up to ~20 characters, without a dangling "/" or "-"
  let words = ""
  for (const w of base.split(/\s+/)) { if (words && (words + " " + w).length > 20) break; words = words ? `${words} ${w}` : w }
  words = words.replace(/[\s/–-]+$/, "")
  return m && m[1].length <= 12 ? m[1] : words
}

function pinRow(names: string[], x0: number, y: number, label = true, up = false): { svg: string; pins: PinPos[] } {
  let svg = ""
  const pins: PinPos[] = []
  names.forEach((n, i) => {
    const x = x0 + i * PITCH
    pins.push({ name: n, x, y })
    svg += `<rect x="${x - 2.4}" y="${y - 2.4}" width="4.8" height="4.8" rx="0.8" fill="#d4a017" stroke="#7c5c0a" stroke-width="0.6"/>`
    if (label) svg += `<text x="${x}" y="${up ? y + 9 : y - 5}" font-size="4.4" fill="#fff" text-anchor="middle" ${FONT} transform="rotate(-90 ${x} ${up ? y + 9 : y - 5})" dominant-baseline="middle">${esc(n.replace(/\.\d+$/, ""))}</text>`
  })
  return { svg, pins }
}

function icon(i: Icon | undefined, cx: number, cy: number, s: number): string {
  const r = s / 2
  switch (i) {
    case "led": return `<circle cx="${cx}" cy="${cy}" r="${r * 0.55}" fill="#fff" fill-opacity="0.25" stroke="#ddd" stroke-width="1"/>`
    case "button": return `<rect x="${cx - r * 0.7}" y="${cy - r * 0.7}" width="${r * 1.4}" height="${r * 1.4}" rx="2" fill="#222"/><circle cx="${cx}" cy="${cy}" r="${r * 0.45}" fill="#444"/>`
    case "knob": return `<circle cx="${cx}" cy="${cy}" r="${r * 0.75}" fill="#333" stroke="#111"/><line x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy - r * 0.6}" stroke="#eee" stroke-width="1.6"/>`
    case "slider": return `<rect x="${cx - r}" y="${cy - 2}" width="${s}" height="4" rx="2" fill="#222"/><rect x="${cx - 4}" y="${cy - 7}" width="8" height="14" rx="1.5" fill="#ddd"/>`
    case "buzzer": case "speaker": return `<circle cx="${cx}" cy="${cy}" r="${r * 0.8}" fill="#111"/><circle cx="${cx}" cy="${cy}" r="${r * 0.18}" fill="#444"/>`
    case "fan": case "motor": return `<circle cx="${cx}" cy="${cy}" r="${r * 0.85}" fill="#444" stroke="#222"/>`
    case "mic": return `<circle cx="${cx}" cy="${cy}" r="${r * 0.4}" fill="#9ca3af" stroke="#333"/>`
    case "drop": return `<path d="M${cx} ${cy - r * 0.7} q${r * 0.6} ${r * 0.8} 0 ${r * 1.3} q${-r * 0.6} ${-r * 0.5} 0 ${-r * 1.3}z" fill="#7dd3fc"/>`
    case "flame": return `<path d="M${cx} ${cy - r * 0.7} q${r * 0.7} ${r * 0.7} 0 ${r * 1.3} q${-r * 0.7} ${-r * 0.6} 0 ${-r * 1.3}z" fill="#fb923c"/>`
    case "eye": return `<ellipse cx="${cx}" cy="${cy}" rx="${r * 0.7}" ry="${r * 0.4}" fill="#111"/><circle cx="${cx}" cy="${cy}" r="${r * 0.22}" fill="#6b7280"/>`
    case "heart": return `<path d="M${cx} ${cy + r * 0.5} l${-r * 0.6} ${-r * 0.6} a${r * 0.3} ${r * 0.3} 0 0 1 ${r * 0.6} ${-r * 0.4} a${r * 0.3} ${r * 0.3} 0 0 1 ${r * 0.6} ${r * 0.4}z" fill="#ef4444"/>`
    case "antenna": return `<path d="M${cx - r * 0.6} ${cy + r * 0.4} h${r * 1.2} M${cx} ${cy + r * 0.4} v${-r} m${-r * 0.4} 0 h${r * 0.8}" stroke="#ddd" stroke-width="1.5" fill="none"/>`
    case "coil": return `<path d="M${cx - r * 0.7} ${cy} ${[0, 1, 2, 3].map(() => `a${r * 0.18} ${r * 0.3} 0 0 1 ${r * 0.35} 0`).join(" ")}" stroke="#d97706" stroke-width="1.6" fill="none"/>`
    case "touch": return `<circle cx="${cx}" cy="${cy}" r="${r * 0.6}" fill="none" stroke="#ddd" stroke-width="1.2"/><circle cx="${cx}" cy="${cy}" r="${r * 0.3}" fill="#ddd"/>`
    case "joystick": return `<circle cx="${cx}" cy="${cy}" r="${r * 0.8}" fill="#222"/><circle cx="${cx}" cy="${cy}" r="${r * 0.45}" fill="#555"/>`
    case "gps": case "chip": return `<rect x="${cx - r * 0.6}" y="${cy - r * 0.6}" width="${r * 1.2}" height="${r * 1.2}" fill="#222" rx="1"/>`
    case "camera": return `<rect x="${cx - r * 0.6}" y="${cy - r * 0.6}" width="${r * 1.2}" height="${r * 1.2}" fill="#111" rx="2"/><circle cx="${cx}" cy="${cy}" r="${r * 0.35}" fill="#1e3a8a" stroke="#666"/>`
    case "clock": return `<circle cx="${cx}" cy="${cy}" r="${r * 0.6}" fill="#e5e7eb" stroke="#111"/><path d="M${cx} ${cy} v${-r * 0.4} M${cx} ${cy} h${r * 0.3}" stroke="#111" stroke-width="1"/>`
    case "magnet": return `<path d="M${cx - r * 0.5} ${cy - r * 0.5} v${r * 0.6} a${r * 0.5} ${r * 0.5} 0 0 0 ${r} 0 v${-r * 0.6}" stroke="#ef4444" stroke-width="3" fill="none"/>`
    case "switch": return `<rect x="${cx - r * 0.6}" y="${cy - r * 0.3}" width="${r * 1.2}" height="${r * 0.6}" fill="#222" rx="1"/><rect x="${cx - r * 0.5}" y="${cy - r * 0.2}" width="${r * 0.5}" height="${r * 0.4}" fill="#ddd"/>`
    case "probe": return `<line x1="${cx - r * 0.8}" y1="${cy}" x2="${cx + r * 0.8}" y2="${cy}" stroke="#bbb" stroke-width="3" stroke-linecap="round"/>`
    case "sd": return `<path d="M${cx - r * 0.5} ${cy - r * 0.7} h${r * 0.8} l${r * 0.3} ${r * 0.3} v${r * 1.1} h${-r * 1.1}z" fill="#111" stroke="#888"/>`
    case "plug": return `<rect x="${cx - r * 0.6}" y="${cy - r * 0.4}" width="${r * 1.2}" height="${r * 0.8}" fill="#ddd"/>`
    case "bars": case "matrix": case "digits": return ""
    default: return ""
  }
}

function pcb(w: number, h: number, color: string, holes = true): string {
  return `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="3" fill="${color}" stroke="#0003"/>` +
    (holes ? [[5, 5], [w - 5, 5]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2.4" fill="#0006" stroke="#d4a01780"/>`).join("") : "")
}
const title = (text: string, x: number, y: number, size = 6, fill = "#fff") => `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" text-anchor="middle" ${FONT}>${esc(text)}</text>`
/** a label that fits `w` px (monospace glyphs are ~0.6 em wide) */
const fitTitle = (text: string, x: number, y: number, w: number, size = 5.4) => title(text, x, y, Math.max(3.2, Math.min(size, w / (Math.max(1, text.length) * 0.62))))
const chip = (text: string, cx: number, cy: number) => { const w = Math.max(18, text.length * 3.6 + 6); return `<rect x="${cx - w / 2}" y="${cy - 6}" width="${w}" height="12" rx="1" fill="#1f1f1f"/>${title(text, cx, cy + 2, 4.4, "#cfcfcf")}` }

/** Grove-style twigs and plain breakout modules: pins along the bottom edge. */
function module(p: CatalogPart, color: string, ic?: string, ico?: Icon, label?: string, w0?: number, h0?: number): Drawing {
  const n = p.pins.length
  const w = Math.max(w0 ?? 0, 60, n * PITCH + 10)
  const h = h0 ?? Math.max(60, n > 14 ? 70 : 60)
  const x0 = (w - (n - 1) * PITCH) / 2
  const row = pinRow(p.pins, x0, h - 5)
  const cx = w / 2
  let svg = pcb(w, h, color)
  if (ico) svg += icon(ico, cx, h / 2 - 8, 22)
  if (ic) svg += chip(ic, cx, ico ? h / 2 + 8 : h / 2 - 6)
  svg += fitTitle(label ?? shortLabel(p), cx, 11, w - 16)
  svg += row.svg
  return { w, h, svg, pins: row.pins, live: { x: cx - 11, y: h / 2 - 19, w: 22, h: 22 } }
}

function board(p: CatalogPart, l: Extract<Look, { k: "board" }>): Drawing {
  const n = p.pins.length
  const top = p.pins.slice(0, Math.ceil(n / 2)), bot = p.pins.slice(Math.ceil(n / 2))
  const w = Math.max(l.w ?? 0, 110, top.length * PITCH + 20)
  const h = l.h ?? 90
  const t = pinRow(top, 10 + PITCH / 2, 6, true, true), b = pinRow(bot, 10 + PITCH / 2, h - 6)
  let svg = pcb(w, h, l.color)
  svg += chip(l.chip, w / 2, h / 2)
  if (l.usb) svg += `<rect x="-2" y="${h / 2 - 8}" width="12" height="16" rx="1.5" fill="#c0c0c0" stroke="#666"/>`
  svg += fitTitle(l.label ?? p.title, w / 2, h / 2 + 18, w - 24, 5.2)
  svg += t.svg + b.svg
  return { w, h, svg, pins: [...t.pins, ...b.pins], live: { x: w / 2 - 10, y: h / 2 - 22, w: 20, h: 10 } }
}

function dip(p: CatalogPart, label: string): Drawing {
  const n = p.pins.length, half = Math.ceil(n / 2)
  const w = half * PITCH + 6, h = 3 * PITCH + 4
  const bottom = p.pins.slice(0, half), top = p.pins.slice(half).reverse()
  const y0 = 2, y1 = 2 + 3 * PITCH
  let svg = `<rect x="2" y="${y0 + 4}" width="${w - 4}" height="${y1 - y0 - 8}" rx="1.5" fill="#262626"/><path d="M2 ${(y0 + y1) / 2 - 3} a3 3 0 0 1 0 6" fill="#555"/>`
  svg += title(label, w / 2, (y0 + y1) / 2 + 2, 5.2, "#ddd")
  const pins: PinPos[] = []
  bottom.forEach((name, i) => { const x = 3 + PITCH / 2 + i * PITCH; pins.push({ name, x, y: y1 }); svg += `<rect x="${x - 1.6}" y="${y1 - 4}" width="3.2" height="5" fill="#c0c0c0"/>` + title(String(i + 1), x, y1 - 6, 3.4, "#aaa") })
  top.forEach((name, i) => { const x = 3 + PITCH / 2 + i * PITCH; pins.push({ name, x, y: y0 }); svg += `<rect x="${x - 1.6}" y="${y0 - 1}" width="3.2" height="5" fill="#c0c0c0"/>` + title(String(n - i), x, y0 + 9, 3.4, "#aaa") })
  return { w, h, svg, pins, live: { x: 0, y: 0, w: 0, h: 0 } }
}

function threeLead(p: CatalogPart, label: string, big: boolean): Drawing {
  const w = 3 * PITCH + 4, h = big ? 54 : 34
  const row = pinRow(p.pins, 2 + PITCH / 2, h - 3, false)
  let svg = big
    ? `<rect x="3" y="0" width="${w - 6}" height="10" rx="1" fill="#b0b0b0"/><circle cx="${w / 2}" cy="5" r="2.6" fill="#666"/><rect x="2" y="10" width="${w - 4}" height="${h - 24}" rx="1" fill="#262626"/>`
    : `<path d="M3 ${h - 14} v-12 a${w / 2 - 3} ${w / 2 - 3} 0 0 1 ${w - 6} 0 v12z" fill="#262626"/>`
  svg += title(label, w / 2, big ? 26 : h - 19, 4.2, "#ddd")
  p.pins.forEach((name, i) => { const x = 2 + PITCH / 2 + i * PITCH; svg += `<line x1="${x}" y1="${h - 14}" x2="${x}" y2="${h - 3}" stroke="#bbb" stroke-width="1.4"/>` + title(name, x, h - 15, 3.4, "#777") })
  svg += row.svg
  return { w, h, svg, pins: row.pins, live: { x: 0, y: 0, w: 0, h: 0 } }
}

function twoLead(p: CatalogPart, body: string, bw: number, bh: number, labels = true): Drawing {
  const w = 4 * PITCH + 4, h = Math.max(bh + 8, 20)
  const y = h / 2
  const x1 = 2, x2 = w - 2
  let svg = `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="#bbb" stroke-width="1.3"/>`
  svg += `<g transform="translate(${w / 2 - bw / 2} ${y - bh / 2})">${body}</g>`
  const pins = [{ name: p.pins[0], x: x1 + 0.4, y }, { name: p.pins[1], x: x2 - 0.4, y }]
  if (labels) svg += title(p.pins[0], x1 + 4, y - 4, 3.6, "#888") + title(p.pins[1], x2 - 4, y - 4, 3.6, "#888")
  svg += pins.map((q) => `<circle cx="${q.x}" cy="${q.y}" r="1.6" fill="#d4a017"/>`).join("")
  return { w, h, svg, pins, live: { x: w / 2 - 6, y: 0, w: 12, h: 6 } }
}

/**
 * A logic gate drawn to its inputs: the body is as tall as the input pins need, the output leaves
 * from the tip on the centre line, and each input line stops where it meets the body (on the
 * curved back of OR / NOR / XOR). Even input counts skip the middle slot, so the output stays on the
 * 2.54 mm grid, as in standard gate symbols.
 */
function gate(p: CatalogPart, fn: GateFn): Drawing {
  const P = PITCH
  const ins = p.pins.slice(0, -1)
  const n = Math.max(1, ins.length)
  const slots = n % 2 ? n : n + 1
  const mid = (slots + 1) / 2
  // input slot rows (1-based), skipping the middle one for an even count
  const rows: number[] = []
  for (let r = 1; rows.length < n; r++) if (n % 2 || r !== mid) rows.push(r)
  const top = 0.35 * P, bot = (slots + 0.65) * P, c = mid * P, H = bot - top
  const x0 = 1.6 * P
  const single = fn === "not" || fn === "buf"
  const curved = fn === "or" || fn === "nor" || fn === "xor" || fn === "xnor"
  const bubble = fn === "nand" || fn === "nor" || fn === "xnor" || fn === "not"
  const r = 0.28 * P
  const W = single ? Math.max(2.6 * P, H * 0.9) : Math.max(3.4 * P, H * 1.05)
  const tip = x0 + W
  // the back of an OR is a curve: where an input line at height y meets it
  const k = 0.32 * P + H * 0.08
  const backX = (y: number) => { if (!curved) return x0; const t = (y - top) / H; return x0 + 2 * t * (1 - t) * k }
  let body: string
  if (single) body = `M${x0} ${top} L${tip} ${c} L${x0} ${bot} Z`
  else if (!curved) {
    // AND / NAND: a flat back, a half-round front
    const rr = H / 2, xs = tip - rr
    body = `M${x0} ${top} H${xs} A${rr} ${rr} 0 0 1 ${xs} ${bot} H${x0} Z`
  } else {
    body = `M${x0} ${top} Q${x0 + W * 0.55} ${top} ${tip} ${c} Q${x0 + W * 0.55} ${bot} ${x0} ${bot} Q${x0 + k} ${c} ${x0} ${top} Z`
  }
  const sw = 1.2
  let svg = `<path d="${body}" fill="#fafafa" stroke="#222" stroke-width="${sw}" stroke-linejoin="round"/>`
  if (fn === "xor" || fn === "xnor") svg += `<path d="M${x0 - 0.3 * P} ${top} Q${x0 - 0.3 * P + k} ${c} ${x0 - 0.3 * P} ${bot}" fill="none" stroke="#222" stroke-width="${sw}"/>`
  const outX = tip + (bubble ? 2 * r : 0)
  if (bubble) svg += `<circle cx="${tip + r}" cy="${c}" r="${r}" fill="#fafafa" stroke="#222" stroke-width="${sw}"/>`
  // the part is a whole number of grid steps wide, so both sides land on the grid
  const w = Math.ceil((outX + 1.2 * P) / P) * P
  const pins: PinPos[] = []
  ins.forEach((name, i) => {
    const y = rows[i] * P
    const xEnd = fn === "xor" || fn === "xnor" ? backX(y) - 0.3 * P : backX(y)
    pins.push({ name, x: 0, y })
    svg += `<line x1="0" y1="${y}" x2="${xEnd.toFixed(2)}" y2="${y}" stroke="#222" stroke-width="${sw}"/>` + title(name, 0.55 * P, y - 1.6, 3.6, "#666")
  })
  pins.push({ name: "Y", x: w, y: c })
  svg += `<line x1="${outX}" y1="${c}" x2="${w}" y2="${c}" stroke="#222" stroke-width="${sw}"/>` + title("Y", w - 0.55 * P, c - 1.6, 3.6, "#666")
  // the gate's name inside its body
  const label = fn.toUpperCase()
  const lx = single ? x0 + W * 0.36 : curved ? x0 + W * 0.48 : x0 + W * 0.42
  svg += title(label, lx, c + 1.6, Math.min(4.6, H / 4.5), "#888")
  return { w, h: (slots + 1) * P, svg, pins, live: { x: w - 10, y: c - 10, w: 8, h: 8 } }
}

function ff(p: CatalogPart, label: string): Drawing {
  const ins = p.pins.filter((n) => n !== "Q" && n !== "QN")
  const h = (Math.max(ins.length, 2) + 1) * PITCH, w = 7 * PITCH
  let svg = `<rect x="${PITCH}" y="2" width="${w - 2 * PITCH}" height="${h - 4}" fill="#fafafa" stroke="#222" stroke-width="1.4"/>` + title(label, w / 2, h / 2 + 2, 6, "#222")
  const pins: PinPos[] = []
  ins.forEach((n, i) => { const y = (i + 1) * PITCH; pins.push({ name: n, x: 0, y }); svg += `<line x1="0" y1="${y}" x2="${PITCH}" y2="${y}" stroke="#222"/>` + title(n === "CLK" ? "▷" : n, PITCH + 6, y + 2, 4.6, "#222") })
  ;["Q", "QN"].forEach((n, i) => { const y = (i + 1) * PITCH; pins.push({ name: n, x: w, y }); svg += `<line x1="${w - PITCH}" y1="${y}" x2="${w}" y2="${y}" stroke="#222"/>` + title(n === "QN" ? "Q̅" : n, w - PITCH - 6, y + 2, 4.6, "#222") })
  return { w, h, svg, pins, live: { x: w - PITCH - 16, y: h - 12, w: 10, h: 8 } }
}

function probe(p: CatalogPart, label: string): Drawing {
  const w = Math.max(60, p.pins.length * PITCH + 20), h = 50
  const row = pinRow(p.pins, (w - (p.pins.length - 1) * PITCH) / 2, h - 5)
  const svg = `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="4" fill="#fbbf24" stroke="#92400e"/><rect x="6" y="6" width="${w - 12}" height="18" rx="2" fill="#1f2a1f"/>` + title(label, w / 2, 34, 6, "#3f2a00") + row.svg
  return { w, h, svg, pins: row.pins, live: { x: 6, y: 6, w: w - 12, h: 18 } }
}

function screen(p: CatalogPart, l: Extract<Look, { k: "screen" }>): Drawing {
  const n = p.pins.length
  const w = Math.max(l.w ?? 0, l.sw + 16, n * PITCH + 10), h = Math.max(l.h ?? 0, l.sh + 30)
  const row = pinRow(p.pins, (w - (n - 1) * PITCH) / 2, h - 5)
  const sx = (w - l.sw) / 2, sy = 8
  const svg = pcb(w, h, l.color, false) + `<rect x="${sx - 2}" y="${sy - 2}" width="${l.sw + 4}" height="${l.sh + 4}" fill="#000"/><rect x="${sx}" y="${sy}" width="${l.sw}" height="${l.sh}" fill="${l.tint ?? "#0b1020"}"/>` + row.svg
  return { w, h, svg, pins: row.pins, live: { x: sx, y: sy, w: l.sw, h: l.sh } }
}

function strip(p: CatalogPart, l: Extract<Look, { k: "strip" }>): Drawing {
  const n = l.count
  if (l.ring) {
    const r = Math.max(22, n * 2.4), w = 2 * r + 16, h = 2 * r + 30
    const row = pinRow(p.pins, (w - (p.pins.length - 1) * PITCH) / 2, h - 5)
    const svg = `<circle cx="${w / 2}" cy="${r + 8}" r="${r + 6}" fill="${l.color ?? "#111"}"/><circle cx="${w / 2}" cy="${r + 8}" r="${r - 6}" fill="#0000" stroke="#0000"/>` + row.svg
    return { w, h, svg, pins: row.pins, live: { x: w / 2 - r, y: 8, w: 2 * r, h: 2 * r } }
  }
  const cols = Math.min(n, 15), rows = Math.ceil(n / cols)
  const w = Math.max(cols * 10 + 10, p.pins.length * PITCH + 10), h = rows * 10 + 30
  const row = pinRow(p.pins, 8, h - 5)
  const svg = pcb(w, h, l.color ?? "#111", false) + row.svg
  return { w, h, svg, pins: row.pins, live: { x: 5, y: 5, w: cols * 10, h: rows * 10 } }
}

function relay(p: CatalogPart, l: Extract<Look, { k: "relay" }>): Drawing {
  const n = p.pins.length
  const w = Math.max(70, n * PITCH + 10), h = 70
  const row = pinRow(p.pins, (w - (n - 1) * PITCH) / 2, h - 5)
  const ch = l.channels ?? 1
  const bw = Math.min(30, (w - 16) / ch - 4)
  let svg = pcb(w, h, l.color === "#111" ? "#2a2a2a" : "#1f6fb2")
  for (let i = 0; i < ch; i++) svg += `<rect x="${8 + i * (bw + 4)}" y="14" width="${bw}" height="26" rx="2" fill="${l.color ?? "#2563eb"}" stroke="#0005"/>`
  svg += title(l.label, w / 2, 11, 5)
  svg += row.svg
  return { w, h, svg, pins: row.pins, live: { x: w - 14, y: 44, w: 8, h: 8 } }
}

export function draw(p: CatalogPart): Drawing {
  const l = p.look
  switch (l.k) {
    case "grove": return module(p, l.color ?? "#2f6db5", l.chip, l.icon, l.label)
    case "module": return module(p, l.color, l.chip, l.icon, l.label, l.w, l.h)
    case "board": return board(p, l)
    case "dip": return dip(p, l.label)
    case "to92": return threeLead(p, l.label, false)
    case "to220": return threeLead(p, l.label, true)
    case "cap": return twoLead(p, l.polar ? `<rect width="14" height="20" rx="2" fill="#1e3a8a"/><rect x="10" width="4" height="20" fill="#cbd5e1"/>${title(l.label, 7, 30, 4, "#888")}` : `<ellipse cx="7" cy="6" rx="7" ry="6" fill="#d97706"/>${title(l.label, 7, 18, 4, "#888")}`, 14, l.polar ? 20 : 12, !!l.polar)
    case "inductor": return twoLead(p, `<rect width="22" height="12" rx="6" fill="#065f46"/>${title(l.label, 11, 20, 4, "#888")}`, 22, 12, false)
    case "diode": return twoLead(p, `<rect width="20" height="9" rx="2" fill="${l.zener ? "#c2410c" : l.schottky ? "#334155" : "#111"}"/><rect x="15" width="3" height="9" fill="#ddd"/>${title(l.label, 10, 17, 4, "#888")}`, 20, 9, true)
    case "battery": return twoLead(p, `<rect width="34" height="16" rx="2" fill="${l.v >= 9 ? "#111" : "#b45309"}"/>${title(`${l.label} ${l.v}V`, 17, 10.5, 4.6, "#fff")}`, 34, 16, true)
    case "gate": return gate(p, l.fn)
    case "ff": return ff(p, l.label)
    case "probe": return probe(p, l.label)
    case "screen": return screen(p, l)
    case "strip": return strip(p, l)
    case "relay": return relay(p, l)
  }
}

// ── live state painting ──────────────────────────────────────────────────────────────────
const SEG: [number, number, number, number][] = [[1, 0, 6, 1], [7, 1, 1, 5], [7, 7, 1, 5], [1, 12, 6, 1], [0, 7, 1, 5], [0, 1, 1, 5], [1, 6, 6, 1]]
const LED_RGB: Record<string, string> = { red: "#ff3030", green: "#30ff60", blue: "#3080ff", yellow: "#ffe030", white: "#ffffff", purple: "#c060ff", orange: "#ff9020", rainbow: "#ff40c0", infrared: "#a855f7", lime: "#a3ff30" }
const rgb = (c: [number, number, number]) => `rgb(${c[0]},${c[1]},${c[2]})`

export function paint(p: CatalogPart, d: Drawing, s: ModView | undefined, attrs: Record<string, string>): string {
  if (!s) return ""
  const L = d.live
  let out = ""
  const glow = s.glow?.[0] ?? 0
  if (s.pix && p.look.k === "strip") {
    const l = p.look
    const n = l.count
    for (let i = 0; i < n; i++) {
      const c = s.pix[i] ?? [0, 0, 0]
      let x: number, y: number
      if (l.ring) { const a = (i / n) * Math.PI * 2 - Math.PI / 2; x = L.x + L.w / 2 + Math.cos(a) * (L.w / 2); y = L.y + L.h / 2 + Math.sin(a) * (L.h / 2) }
      else { const cols = Math.min(n, 15); x = L.x + 5 + (i % cols) * 10; y = L.y + 5 + Math.floor(i / cols) * 10 }
      const lit = c[0] + c[1] + c[2] > 0
      out += `<circle cx="${x}" cy="${y}" r="3.6" fill="${lit ? rgb(c) : "#333"}" ${lit ? `filter="url(#g)"` : ""}/>`
    }
    return out
  }
  if (s.segs) {
    const digits = Math.max(1, Math.ceil(s.segs.length))
    const dw = Math.min(14, (d.w - 12) / digits)
    const x0 = (d.w - digits * dw) / 2, y0 = 16, k = dw / 10
    out += `<rect x="${x0 - 3}" y="${y0 - 3}" width="${digits * dw + 6}" height="${16 * k + 6}" fill="#111"/>`
    s.segs.forEach((bits, i) => SEG.forEach(([x, y, w, h], j) => { out += `<rect x="${x0 + i * dw + x * k}" y="${y0 + y * k}" width="${w * k}" height="${h * k}" fill="${bits & (1 << j) ? "#ff2a2a" : "#3a0d0d"}"/>` }))
    if (s.colon) out += `<circle cx="${x0 + 2 * dw - 1}" cy="${y0 + 4 * k}" r="${k * 0.8}" fill="#ff2a2a"/><circle cx="${x0 + 2 * dw - 1}" cy="${y0 + 9 * k}" r="${k * 0.8}" fill="#ff2a2a"/>`
    return out
  }
  if (s.rows) {
    if (attrs.layout?.startsWith("alnum")) {
      const n = attrs.layout === "alnum2" ? 2 : 4
      out += `<rect x="8" y="16" width="${d.w - 16}" height="24" fill="#111"/>`
      for (let i = 0; i < n; i++) out += title(alnumChar(s.rows[i] ?? 0), 8 + ((i + 0.5) * (d.w - 16)) / n, 34, 14, "#ff2a2a")
      return out
    }
    const size = 32, x0 = d.w / 2 - size / 2, y0 = 16
    out += `<rect x="${x0 - 2}" y="${y0 - 2}" width="${size + 4}" height="${size + 4}" fill="#111"/>`
    for (let r = 0; r < 8; r++) for (let col = 0; col < 8; col++) out += `<circle cx="${x0 + col * 4 + 2}" cy="${y0 + r * 4 + 2}" r="1.5" fill="${(s.rows[r] ?? 0) & (1 << col) ? "#ff2a2a" : "#3a0d0d"}"/>`
    return out
  }
  if (s.image) {
    const url = imageUrl(s.image)
    if (url) out += `<image x="${L.x}" y="${L.y}" width="${L.w}" height="${L.h}" href="${url}" preserveAspectRatio="none" style="image-rendering:pixelated"/>`
    return out
  }
  if (s.bitmap && typeof document !== "undefined") {
    const cv = document.createElement("canvas")
    cv.width = s.bitmap.w; cv.height = s.bitmap.h
    const ctx = cv.getContext("2d")
    if (ctx) {
      const img = ctx.createImageData(s.bitmap.w, s.bitmap.h)
      for (let y = 0; y < s.bitmap.h; y++) for (let x = 0; x < s.bitmap.w; x++) {
        const on = s.bitmap.data[y * (s.bitmap.w >> 3) + (x >> 3)] & (0x80 >> (x & 7))
        const i = (y * s.bitmap.w + x) * 4
        img.data[i] = on ? 0x9f : 0; img.data[i + 1] = on ? 0xe8 : 0; img.data[i + 2] = on ? 0xff : 0; img.data[i + 3] = 255
      }
      ctx.putImageData(img, 0, 0)
      out += `<image x="${L.x}" y="${L.y}" width="${L.w}" height="${L.h}" href="${cv.toDataURL()}" style="image-rendering:pixelated"/>`
    }
    return out
  }
  if (s.text !== undefined) {
    out += title(s.text, L.x + L.w / 2, L.y + L.h / 2 + 3, Math.min(9, L.h * 0.55), "#7CFC7C")
    return out
  }
  if (s.angle !== undefined && (p.look.k === "module" || p.look.k === "grove")) {
    const cx = L.x + L.w / 2, cy = L.y + L.h / 2, r = L.w / 2 - 2
    out += `<g transform="rotate(${s.angle} ${cx} ${cy})">${[0, 120, 240].map((a) => `<path d="M${cx} ${cy} L${cx + r} ${cy - 4} A${r} ${r} 0 0 1 ${cx + r} ${cy + 4}z" fill="#cbd5e1" transform="rotate(${a} ${cx} ${cy})"/>`).join("")}<circle cx="${cx}" cy="${cy}" r="2.5" fill="#111"/></g>`
    return out
  }
  if (glow > 0.03 || (s.on ?? 0) > 0.03) {
    const v = Math.max(glow, s.on ?? 0)
    const col = LED_RGB[attrs.color ?? ""] ?? (p.model.m === "led" ? LED_RGB[p.model.color] : undefined) ?? "#ff3030"
    const cx = L.x + L.w / 2, cy = L.y + L.h / 2
    out += `<circle cx="${cx}" cy="${cy}" r="${Math.max(3, Math.min(L.w, L.h) / 2.4)}" fill="${col}" fill-opacity="${0.35 + 0.65 * v}" filter="url(#g)"/>`
  }
  return out
}

/** HT16K33 14-segment word → the closest ASCII character (for drawing). */
function alnumChar(w: number): string {
  for (const [ch, code] of Object.entries(ALNUM)) if (code === (w & 0x7fff)) return ch
  return w ? "▪" : " "
}
// Adafruit LED Backpack's 14-segment font, a few characters (enough to show text)
const ALNUM: Record<string, number> = {
  "0": 0x0c3f, "1": 0x0006, "2": 0x00db, "3": 0x008f, "4": 0x00e6, "5": 0x2069, "6": 0x00fd, "7": 0x0007, "8": 0x00ff, "9": 0x00ef,
  A: 0x00f7, B: 0x128f, C: 0x0039, D: 0x120f, E: 0x00f9, F: 0x0071, G: 0x00bd, H: 0x00f6, I: 0x1209, J: 0x001e, K: 0x2470, L: 0x0038, M: 0x0536, N: 0x2136, O: 0x003f,
  P: 0x00f3, Q: 0x203f, R: 0x20f3, S: 0x018d, T: 0x1201, U: 0x003e, V: 0x0c30, W: 0x2836, X: 0x2d00, Y: 0x1500, Z: 0x0c09, "-": 0x00c0, " ": 0,
}

// ── custom elements ───────────────────────────────────────────────────────────────────────
const drawings = new Map<string, Drawing>()
export const drawingOf = (p: CatalogPart) => { let d = drawings.get(p.type); if (!d) drawings.set(p.type, (d = draw(p))); return d }

export function definePart(p: CatalogPart) {
  if (typeof customElements === "undefined" || customElements.get(p.type)) return
  if (p.base) {
    const Base = customElements.get(p.base)
    if (Base) customElements.define(p.type, class extends (Base as typeof HTMLElement) {})
    return
  }
  if (!p.type.startsWith("sb-")) return
  const d = drawingOf(p)
  customElements.define(p.type, class extends HTMLElement {
    private live: SVGGElement | null = null
    private last = ""
    private _state: ModView | undefined
    private _attrs: Record<string, string> = { ...(p.attrs ?? {}) }
    constructor() { super(); this.attachShadow({ mode: "open" }) }
    connectedCallback() {
      this.shadowRoot!.innerHTML = `<style>:host{display:inline-block;line-height:0}svg{display:block;overflow:visible}</style><svg width="${d.w}" height="${d.h}" viewBox="0 0 ${d.w} ${d.h}"><defs><filter id="g" x="-1" y="-1" width="3" height="3"><feGaussianBlur stdDeviation="1.6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>${d.svg}<g id="live"></g></svg>`
      this.live = this.shadowRoot!.getElementById("live") as SVGGElement | null
      this.repaint()
    }
    get pinInfo() { return d.pins.map((x) => ({ ...x, signals: [] })) }
    set state(s: ModView | undefined) { this._state = s; this.repaint() }
    get state() { return this._state }
    /** the diagram part's attrs (LED colour, layout …) */
    set attrs(a: Record<string, string>) { this._attrs = { ...(p.attrs ?? {}), ...a }; this.repaint() }
    get attrs() { return this._attrs }
    private repaint() {
      if (!this.live) return
      const html = paint(p, d, this._state, this._attrs)
      if (html !== this.last) { this.last = html; this.live.innerHTML = html }
    }
  })
}
