// Fabrication output: Gerber RS-274X (X2 attributes) for copper, mask, silkscreen
// and outline, an Excellon drill file, all zipped. Units mm, format 4.6.
import { LABEL_H, labelSize, type Board, type BoardPad, type BoardPart, type Layer } from "./board"

const f = (v: number) => Math.round(v * 1e6).toString()
const header = (fn: string, title: string) => [
  "%TF.GenerationSoftware,SpaceBench,Space Bench,0.1*%", `%TF.FileFunction,${fn}*%`, "%TF.FilePolarity,Positive*%",
  "%FSLAX46Y46*%", "%MOMM*%", `G04 ${title}*`, "%LPD*%",
]

class Apertures {
  private map = new Map<string, number>()
  private next = 10
  defs: string[] = []
  get(def: string): number {
    let d = this.map.get(def)
    if (d === undefined) { d = this.next++; this.map.set(def, d); this.defs.push(`%ADD${d}${def}*%`) }
    return d
  }
}

/** Gerber Y grows upwards: flip the board's y (down) to keep the image the right way up. */
const Y = (b: Board, y: number) => b.height - y

function padAperture(ap: Apertures, p: BoardPad, grow = 0): number {
  const w = p.aw + 2 * grow, h = p.ah + 2 * grow
  if (p.shape === "circle") return ap.get(`C,${w.toFixed(4)}`)
  if (p.shape === "oval") return ap.get(`O,${w.toFixed(4)}X${h.toFixed(4)}`)
  return ap.get(`R,${w.toFixed(4)}X${h.toFixed(4)}`)
}

function copper(b: Board, parts: BoardPart[], layer: Layer): string {
  const ap = new Apertures()
  const body: string[] = []
  let cur = -1
  const use = (d: number) => { if (d !== cur) { body.push(`D${d}*`); cur = d } }
  for (const p of parts.flatMap((x) => x.pads)) {
    if (!p.layers.includes(layer)) continue
    use(padAperture(ap, p))
    body.push(`X${f(p.ax)}Y${f(Y(b, p.ay))}D03*`)
  }
  for (const v of b.vias) { use(ap.get(`C,${v.dia.toFixed(4)}`)); body.push(`X${f(v.x)}Y${f(Y(b, v.y))}D03*`) }
  for (const t of b.tracks) {
    if (t.layer !== layer) continue
    use(ap.get(`C,${t.width.toFixed(4)}`))
    body.push(`X${f(t.a[0])}Y${f(Y(b, t.a[1]))}D02*`, `X${f(t.b[0])}Y${f(Y(b, t.b[1]))}D01*`)
  }
  return [...header(`Copper,L${layer === "F" ? 1 : 2},${layer === "F" ? "Top" : "Bot"}`, `${layer}.Cu`), ...ap.defs, "G01*", ...body, "M02*", ""].join("\n")
}

function mask(b: Board, parts: BoardPart[], layer: Layer): string {
  const ap = new Apertures()
  const body: string[] = []
  for (const p of parts.flatMap((x) => x.pads)) {
    if (!p.layers.includes(layer)) continue
    body.push(`D${padAperture(ap, p, 0.05)}*`, `X${f(p.ax)}Y${f(Y(b, p.ay))}D03*`)
  }
  return [...header(`Soldermask,${layer === "F" ? "Top" : "Bot"}`, `${layer}.Mask`), ...ap.defs, ...body, "M02*", ""].join("\n")
}

/** Solder paste stencil: SMD pads only (through-hole pads are wave / hand soldered). */
function paste(b: Board, parts: BoardPart[]): string {
  const ap = new Apertures()
  const body: string[] = []
  for (const p of parts.flatMap((x) => x.pads)) {
    if (p.drill) continue
    body.push(`D${padAperture(ap, p)}*`, `X${f(p.ax)}Y${f(Y(b, p.ay))}D03*`)
  }
  return [...header("Paste,Top", "F.Paste"), ...ap.defs, ...body, "M02*", ""].join("\n")
}

// ---- a tiny stroke font (uppercase, digits, a few symbols) on a 4 × 6 grid
const FONT: Record<string, number[][]> = {
  "0": [[0, 0, 4, 0, 4, 6, 0, 6, 0, 0], [0, 6, 4, 0]], "1": [[1, 1, 2, 0, 2, 6], [1, 6, 3, 6]], "2": [[0, 1, 1, 0, 3, 0, 4, 1, 4, 2, 0, 6, 4, 6]],
  "3": [[0, 0, 4, 0, 2, 2, 4, 3, 4, 5, 3, 6, 0, 6]], "4": [[3, 6, 3, 0, 0, 4, 4, 4]], "5": [[4, 0, 0, 0, 0, 2, 3, 2, 4, 3, 4, 5, 3, 6, 0, 6]],
  "6": [[4, 0, 1, 0, 0, 2, 0, 6, 4, 6, 4, 3, 0, 3]], "7": [[0, 0, 4, 0, 1, 6]], "8": [[0, 0, 4, 0, 4, 6, 0, 6, 0, 0], [0, 3, 4, 3]],
  "9": [[4, 3, 0, 3, 0, 0, 4, 0, 4, 4, 3, 6, 0, 6]], A: [[0, 6, 0, 2, 2, 0, 4, 2, 4, 6], [0, 3, 4, 3]], B: [[0, 0, 0, 6, 3, 6, 4, 5, 4, 4, 3, 3, 0, 3], [0, 0, 3, 0, 4, 1, 4, 2, 3, 3]],
  C: [[4, 0, 0, 0, 0, 6, 4, 6]], D: [[0, 0, 0, 6, 3, 6, 4, 5, 4, 1, 3, 0, 0, 0]], E: [[4, 0, 0, 0, 0, 6, 4, 6], [0, 3, 3, 3]], F: [[4, 0, 0, 0, 0, 6], [0, 3, 3, 3]],
  G: [[4, 0, 0, 0, 0, 6, 4, 6, 4, 3, 2, 3]], H: [[0, 0, 0, 6], [4, 0, 4, 6], [0, 3, 4, 3]], I: [[1, 0, 3, 0], [2, 0, 2, 6], [1, 6, 3, 6]],
  J: [[4, 0, 4, 5, 3, 6, 1, 6, 0, 5]], K: [[0, 0, 0, 6], [4, 0, 0, 3, 4, 6]], L: [[0, 0, 0, 6, 4, 6]], M: [[0, 6, 0, 0, 2, 3, 4, 0, 4, 6]],
  N: [[0, 6, 0, 0, 4, 6, 4, 0]], O: [[0, 0, 4, 0, 4, 6, 0, 6, 0, 0]], P: [[0, 6, 0, 0, 4, 0, 4, 3, 0, 3]], Q: [[0, 0, 4, 0, 4, 6, 0, 6, 0, 0], [2, 4, 4, 6]],
  R: [[0, 6, 0, 0, 4, 0, 4, 3, 0, 3, 4, 6]], S: [[4, 0, 0, 0, 0, 3, 4, 3, 4, 6, 0, 6]], T: [[0, 0, 4, 0], [2, 0, 2, 6]], U: [[0, 0, 0, 6, 4, 6, 4, 0]],
  V: [[0, 0, 2, 6, 4, 0]], W: [[0, 0, 1, 6, 2, 3, 3, 6, 4, 0]], X: [[0, 0, 4, 6], [4, 0, 0, 6]], Y: [[0, 0, 2, 3, 4, 0], [2, 3, 2, 6]], Z: [[0, 0, 4, 0, 0, 6, 4, 6]],
  "-": [[1, 3, 3, 3]], "+": [[1, 3, 3, 3], [2, 2, 2, 4]], ".": [[2, 5.5, 2, 6]], "_": [[0, 6, 4, 6]], "/": [[0, 6, 4, 0]],
}
/** Strokes of a text (cap height h mm) starting at x, y (baseline, y down). */
export function textStrokes(text: string, x: number, y: number, h = 1.0): [number, number][][] {
  const s = h / 6, out: [number, number][][] = []
  let cx = x
  for (const ch of text.toUpperCase()) {
    for (const poly of FONT[ch] ?? []) {
      const pts: [number, number][] = []
      for (let i = 0; i < poly.length; i += 2) pts.push([cx + poly[i] * s, y - h + poly[i + 1] * s])
      out.push(pts)
    }
    cx += 5.5 * s
  }
  return out
}

function silk(b: Board, parts: BoardPart[]): string {
  const ap = new Apertures()
  const d = ap.get("C,0.1500")
  const body: string[] = [`D${d}*`]
  const line = (a: [number, number], c: [number, number]) => body.push(`X${f(a[0])}Y${f(Y(b, a[1]))}D02*`, `X${f(c[0])}Y${f(Y(b, c[1]))}D01*`)
  for (const p of parts) {
    const at = p.at
    const T = (q: [number, number]): [number, number] => { const r = at.rot === 90 ? [-q[1], q[0]] : at.rot === 180 ? [-q[0], -q[1]] : at.rot === 270 ? [q[1], -q[0]] : q; return [r[0] + at.x, r[1] + at.y] }
    for (const s of p.fp.silk) {
      if (s.k === "line") line(T(s.a), T(s.b))
      else {
        // circle as 24 chords
        const c = T(s.c)
        for (let i = 0; i < 24; i++) line([c[0] + s.r * Math.cos((i / 24) * 2 * Math.PI), c[1] + s.r * Math.sin((i / 24) * 2 * Math.PI)], [c[0] + s.r * Math.cos(((i + 1) / 24) * 2 * Math.PI), c[1] + s.r * Math.sin(((i + 1) / 24) * 2 * Math.PI)])
      }
    }
    // labels: (x, y) is the text box's top-left; rotated labels read bottom-to-top
    const L = p.label
    for (const poly of textStrokes(p.ref, 0, LABEL_H)) for (let i = 1; i < poly.length; i++) {
      const tr = (q: [number, number]): [number, number] => (L.rot === 90 ? [L.x + q[1], L.y + labelSize(p.ref).w - q[0]] : [L.x + q[0], L.y + q[1]])
      line(tr(poly[i - 1]), tr(poly[i]))
    }
  }
  return [...header("Legend,Top", "F.Silkscreen"), ...ap.defs, "G01*", ...body, "M02*", ""].join("\n")
}

function outline(b: Board): string {
  const ap = new Apertures()
  const d = ap.get("C,0.1000")
  const c: [number, number][] = [[0, 0], [b.width, 0], [b.width, b.height], [0, b.height], [0, 0]]
  return [...header("Profile,NP", "Edge.Cuts"), ...ap.defs, "G01*", `D${d}*`, `X${f(c[0][0])}Y${f(Y(b, c[0][1]))}D02*`, ...c.slice(1).map((p) => `X${f(p[0])}Y${f(Y(b, p[1]))}D01*`), "M02*", ""].join("\n")
}

/** Excellon drill file (plated holes: THT pads and vias). */
export function drill(b: Board, parts: BoardPart[]): string {
  const holes: { d: number; x: number; y: number }[] = []
  for (const p of parts.flatMap((x) => x.pads)) if (p.drill) holes.push({ d: p.drill, x: p.ax, y: p.ay })
  for (const v of b.vias) holes.push({ d: v.drill, x: v.x, y: v.y })
  const sizes = [...new Set(holes.map((h) => h.d.toFixed(3)))].sort()
  const out = ["M48", "; DRILL file · Space Bench", "; FORMAT={-:-/ absolute / metric / decimal}", "FMAT,2", "METRIC,TZ"]
  sizes.forEach((s, i) => out.push(`T${i + 1}C${s}`))
  // absolute coordinates are a header setting; G05 (drill mode) starts the body
  out.push("G90", "%", "G05")
  sizes.forEach((s, i) => {
    out.push(`T${i + 1}`)
    for (const h of holes.filter((q) => q.d.toFixed(3) === s)) out.push(`X${h.x.toFixed(3)}Y${Y(b, h.y).toFixed(3)}`)
  })
  out.push("T0", "M30", "")
  return out.join("\n")
}

export function fabricationFiles(b: Board, parts: BoardPart[], name: string): Record<string, string> {
  return {
    [`${name}-F_Cu.gbr`]: copper(b, parts, "F"),
    [`${name}-B_Cu.gbr`]: copper(b, parts, "B"),
    [`${name}-F_Mask.gbr`]: mask(b, parts, "F"),
    [`${name}-F_Paste.gbr`]: paste(b, parts),
    [`${name}-B_Mask.gbr`]: mask(b, parts, "B"),
    [`${name}-F_Silkscreen.gbr`]: silk(b, parts),
    [`${name}-Edge_Cuts.gbr`]: outline(b),
    [`${name}.drl`]: drill(b, parts),
  }
}

// ---------------------------------------------------------------- zip (stored, no compression)

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })()
export function crc32(d: Uint8Array): number { let c = 0xffffffff; for (const b of d) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }

export function zip(files: Record<string, string>): Uint8Array {
  const enc = new TextEncoder()
  const chunks: Uint8Array[] = [], central: Uint8Array[] = []
  let offset = 0
  const u16 = (v: number) => [v & 0xff, (v >> 8) & 0xff], u32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]
  for (const [name, text] of Object.entries(files)) {
    const data = enc.encode(text), nm = enc.encode(name), crc = crc32(data)
    const local = new Uint8Array([...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nm.length), ...u16(0), ...nm])
    chunks.push(local, data)
    central.push(new Uint8Array([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nm.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...nm]))
    offset += local.length + data.length
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0)
  const end = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(central.length), ...u16(central.length), ...u32(cdSize), ...u32(offset), ...u16(0)])
  const all = [...chunks, ...central, end]
  const out = new Uint8Array(all.reduce((s, c) => s + c.length, 0))
  let o = 0
  for (const c of all) { out.set(c, o); o += c.length }
  return out
}
