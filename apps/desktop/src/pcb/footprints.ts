// Footprints, generated from KiCad footprint names (no footprint library needed):
// DIP-8_W7.62mm, SOIC-8_3.9x4.9mm_P1.27mm, R_0603_1608Metric, R_Axial_…_P10.16mm,
// CP_Radial_D5.0mm_P2.00mm, LED_D3.0mm, TO-92_Inline, TO-220-3_Vertical, SOT-23,
// PinHeader_1x02_P2.54mm … Pad numbers follow KiCad, so they match symbol pin numbers.
// All coordinates in mm, origin at pad 1 (THT) or the body centre (SMD).
import { resolveSim } from "@/lib/spice"
import { symbolFor, type Part } from "@/editor/model"

export type PadShape = "rect" | "circle" | "oval" | "roundrect"
export interface Pad { n: string; x: number; y: number; w: number; h: number; shape: PadShape; /** THT drill Ø; SMD pads have none */ drill?: number }
export type Silk = { k: "line"; a: [number, number]; b: [number, number] } | { k: "circle"; c: [number, number]; r: number }
export interface Footprint {
  name: string
  /** short human name: "DIP-8 · 7.62 mm" */
  label: string
  pads: Pad[]
  silk: Silk[]
  /** courtyard box [x0, y0, x1, y1] */
  court: [number, number, number, number]
  smd: boolean
}

const num = (s: string | undefined, d: number) => { const v = s ? parseFloat(s) : NaN; return Number.isFinite(v) ? v : d }
const rect = (x0: number, y0: number, x1: number, y1: number): Silk[] => [
  { k: "line", a: [x0, y0], b: [x1, y0] }, { k: "line", a: [x1, y0], b: [x1, y1] },
  { k: "line", a: [x1, y1], b: [x0, y1] }, { k: "line", a: [x0, y1], b: [x0, y0] },
]
const bbox = (pads: Pad[], silk: Silk[], margin = 0.5): Footprint["court"] => {
  const xs: number[] = [], ys: number[] = []
  for (const p of pads) { xs.push(p.x - p.w / 2, p.x + p.w / 2); ys.push(p.y - p.h / 2, p.y + p.h / 2) }
  for (const s of silk) {
    if (s.k === "line") { xs.push(s.a[0], s.b[0]); ys.push(s.a[1], s.b[1]) }
    else { xs.push(s.c[0] - s.r, s.c[0] + s.r); ys.push(s.c[1] - s.r, s.c[1] + s.r) }
  }
  return [Math.min(...xs) - margin, Math.min(...ys) - margin, Math.max(...xs) + margin, Math.max(...ys) + margin]
}
const fp = (name: string, label: string, pads: Pad[], silk: Silk[], smd = false): Footprint => ({ name, label, pads, silk, court: bbox(pads, silk), smd })
const tht = (n: number | string, x: number, y: number, d = 1.6, drill = 0.8, first = false): Pad => ({ n: String(n), x, y, w: d, h: d, shape: first ? "rect" : "circle", drill })

/** Two rows, numbered down the left and up the right (DIP / SOIC style). */
function dualRow(n: number, pitch: number, rowGap: number, pad: (k: number, x: number, y: number) => Pad): Pad[] {
  const half = n / 2, out: Pad[] = []
  for (let i = 0; i < half; i++) out.push(pad(i + 1, 0, i * pitch))
  for (let i = 0; i < half; i++) out.push(pad(half + i + 1, rowGap, (half - 1 - i) * pitch))
  return out
}

const CHIP: Record<string, { p: number; w: number; h: number; L: number; W: number }> = {
  "0402": { p: 0.51, w: 0.54, h: 0.64, L: 1.0, W: 0.5 }, "0603": { p: 0.825, w: 0.8, h: 0.95, L: 1.6, W: 0.8 },
  "0805": { p: 0.95, w: 1.0, h: 1.45, L: 2.0, W: 1.25 }, "1206": { p: 1.475, w: 1.15, h: 1.8, L: 3.2, W: 1.6 },
  "1210": { p: 1.475, w: 1.15, h: 2.7, L: 3.2, W: 2.5 }, "2512": { p: 2.95, w: 1.5, h: 3.35, L: 6.3, W: 3.2 },
}

/** Build a footprint from a KiCad footprint name ("Lib:Name" or just "Name"), or null if it isn't a known family. */
export function footprintFromName(full: string): Footprint | null {
  const name = full.includes(":") ? full.split(":")[1] : full
  let m: RegExpExecArray | null
  // ---- DIP-N_W7.62mm
  if ((m = /^DIP-(\d+)_W([\d.]+)mm/.exec(name))) {
    const n = Number(m[1]), w = num(m[2], 7.62)
    const pads = dualRow(n, 2.54, w, (k, x, y) => ({ n: String(k), x, y, w: 1.6, h: 1.6, shape: k === 1 ? "rect" : "oval", drill: 0.8 }))
    const h = (n / 2 - 1) * 2.54
    const silk = [...rect(1.27, -1.33, w - 1.27, h + 1.33), { k: "circle" as const, c: [w / 2, -0.6] as [number, number], r: 0.5 }]
    return fp(full, `DIP-${n} · ${w} mm`, pads, silk)
  }
  // ---- SOIC-N_3.9x4.9mm_P1.27mm (also SOP / TSSOP)
  if ((m = /^(SOIC|SOP|TSSOP|MSOP)-(\d+)_([\d.]+)x([\d.]+)mm_P([\d.]+)mm/.exec(name))) {
    const n = Number(m[2]), bw = num(m[3], 3.9), p = num(m[5], 1.27)
    const gap = bw + 1.5
    const pads = dualRow(n, p, gap, (k, x, y) => ({ n: String(k), x, y, w: 1.55, h: Math.min(0.6, p * 0.6), shape: "roundrect" }))
    const h = (n / 2 - 1) * p
    // centre the body on the origin
    for (const q of pads) { q.x -= gap / 2; q.y -= h / 2 }
    const silk = rect(-bw / 2, -h / 2 - 0.9, bw / 2, h / 2 + 0.9)
    silk.push({ k: "circle", c: [-gap / 2, -h / 2 - 1.1], r: 0.2 })
    return fp(full, `${m[1]}-${n} · ${p} mm`, pads, silk, true)
  }
  // ---- chip resistors / capacitors / inductors / LEDs: R_0603_1608Metric
  if ((m = /^(R|C|L|LED|D|CP_Elec)_(\d{4})_/.exec(name)) && CHIP[m[2]]) {
    const c = CHIP[m[2]]
    const pads: Pad[] = [{ n: "1", x: -c.p, y: 0, w: c.w, h: c.h, shape: "roundrect" }, { n: "2", x: c.p, y: 0, w: c.w, h: c.h, shape: "roundrect" }]
    const silk: Silk[] = [{ k: "line", a: [-c.L / 2 + 0.1, -c.W / 2 - 0.25], b: [c.L / 2 - 0.1, -c.W / 2 - 0.25] }, { k: "line", a: [-c.L / 2 + 0.1, c.W / 2 + 0.25], b: [c.L / 2 - 0.1, c.W / 2 + 0.25] }]
    return fp(full, `${m[1]}-${m[2]} (SMD)`, pads, silk, true)
  }
  // ---- axial THT: R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal, D_DO-35_SOD27_P7.62mm_Horizontal
  if ((m = /_P([\d.]+)mm_Horizontal/.exec(name)) && /Axial|DO-|SOD|_P[\d.]+mm_Horizontal/.test(name)) {
    const p = num(m[1], 10.16)
    const L = num(/_L([\d.]+)mm/.exec(name)?.[1], Math.min(p - 3, 6.3)), D = num(/_D([\d.]+)mm/.exec(name)?.[1], 2.5)
    const diode = /^D_/.test(name)
    const pads = [tht(1, 0, 0, 1.6, 0.8, diode), tht(2, p, 0, 1.6, 0.8)]
    const x0 = (p - L) / 2, x1 = (p + L) / 2
    const silk: Silk[] = [...rect(x0, -D / 2, x1, D / 2), { k: "line", a: [0.9, 0], b: [x0, 0] }, { k: "line", a: [x1, 0], b: [p - 0.9, 0] }]
    if (diode) silk.push({ k: "line", a: [x0 + 0.6, -D / 2], b: [x0 + 0.6, D / 2] })
    return fp(full, `${diode ? "Diode" : "Axial"} · ${p} mm pitch`, pads, silk)
  }
  // ---- radial capacitors / LEDs: CP_Radial_D5.0mm_P2.00mm, C_Disc_D5.0mm_W2.5mm_P5.00mm, LED_D3.0mm
  if ((m = /^(CP_Radial|C_Radial|C_Disc|LED)_D([\d.]+)mm/.exec(name))) {
    const d = num(m[2], 5), p = num(/_P([\d.]+)mm/.exec(name)?.[1], m[1] === "LED" ? 2.54 : d >= 8 ? 3.5 : 2.0)
    const first = m[1] !== "C_Disc"
    const pads = [tht(1, 0, 0, 1.6, 0.8, first), tht(2, p, 0, 1.6, 0.8)]
    const silk: Silk[] = m[1] === "C_Disc" ? rect(p / 2 - d / 2, -1.25, p / 2 + d / 2, 1.25) : [{ k: "circle", c: [p / 2, 0], r: d / 2 + 0.12 }]
    if (m[1] === "CP_Radial") silk.push({ k: "line", a: [-1.6, -d / 4], b: [-0.6, -d / 4] }, { k: "line", a: [-1.1, -d / 4 - 0.5], b: [-1.1, -d / 4 + 0.5] })
    return fp(full, `${m[1] === "LED" ? "LED" : m[1] === "CP_Radial" ? "CP radial" : "C"} Ø${d} mm`, pads, silk)
  }
  // ---- TO-92 (E B C inline)
  if (/^TO-92/.test(name)) {
    const pads: Pad[] = [0, 1, 2].map((i) => ({ n: String(i + 1), x: i * 1.27, y: 0, w: 1.05, h: 1.5, shape: i === 0 ? "rect" : "oval", drill: 0.75 }))
    const silk: Silk[] = [{ k: "line", a: [-0.53, 1.85], b: [3.07, 1.85] }, { k: "circle", c: [1.27, 0], r: 2.48 }]
    return fp(full, "TO-92 inline", pads, silk)
  }
  // ---- TO-220-3_Vertical (and TO-220-N)
  if ((m = /^TO-220-(\d+)/.exec(name))) {
    const n = Number(m[1]), p = n > 3 ? 1.7 : 2.54
    const pads: Pad[] = Array.from({ length: n }, (_, i) => ({ n: String(i + 1), x: i * p, y: 0, w: 1.905, h: 2.0, shape: i === 0 ? "rect" : "oval", drill: 1.1 }))
    const w = (n - 1) * p
    const silk = [...rect(w / 2 - 5.2, -3.3, w / 2 + 5.2, 1.3), { k: "line" as const, a: [w / 2 - 5.2, -2.0] as [number, number], b: [w / 2 + 5.2, -2.0] as [number, number] }]
    return fp(full, `TO-220-${n}`, pads, silk)
  }
  // ---- SOT-23 (3 pins: 1 left-bottom, 2 right-bottom, 3 top)
  if (/^SOT-23(-3)?$|^SOT-23_/.test(name)) {
    const pads: Pad[] = [
      { n: "1", x: -0.95, y: 1.1, w: 0.9, h: 0.8, shape: "roundrect" }, { n: "2", x: 0.95, y: 1.1, w: 0.9, h: 0.8, shape: "roundrect" },
      { n: "3", x: 0, y: -1.1, w: 0.9, h: 0.8, shape: "roundrect" },
    ]
    return fp(full, "SOT-23", pads, rect(-1.5, -0.7, 1.5, 0.7), true)
  }
  // ---- pin headers / connectors: PinHeader_1x02_P2.54mm_Vertical, *_1x03_*
  if ((m = /_1x(\d+)_/.exec(name)) || (m = /PinHeader_1x(\d+)/.exec(name))) {
    const n = Number(m[1]), p = num(/_P([\d.]+)mm/.exec(name)?.[1], 2.54)
    const pads = Array.from({ length: n }, (_, i) => ({ ...tht(i + 1, 0, i * p, 1.7, 1.0, i === 0), shape: (i === 0 ? "rect" : "oval") as PadShape }))
    return fp(full, `Header 1×${n} · ${p} mm`, pads, rect(-1.33, -1.33, 1.33, (n - 1) * p + 1.33))
  }
  return null
}

/** Generic fallback: an inline header for 1–3 pins, a DIP for more. */
export function genericFootprint(pinNumbers: string[]): Footprint {
  const nums = [...pinNumbers].sort((a, b) => (Number(a) || 0) - (Number(b) || 0) || a.localeCompare(b))
  if (nums.length <= 3) {
    const pads = nums.map((n, i) => ({ ...tht(n, i * 2.54, 0, 1.7, 1.0, i === 0), shape: (i === 0 ? "rect" : "oval") as PadShape }))
    return fp(`Generic:Inline_${nums.length}`, `Inline ${nums.length}-pin · 2.54 mm`, pads, rect(-1.33, -1.33, (nums.length - 1) * 2.54 + 1.33, 1.33))
  }
  const n = nums.length + (nums.length % 2)
  const base = footprintFromName(`DIP-${n}_W7.62mm`)!
  const pads = base.pads.slice(0, nums.length).map((p, i) => ({ ...p, n: nums[i] }))
  return { ...base, name: `Generic:DIP-${n}`, label: `DIP-${n} (generic)`, pads }
}

/** Default footprint name for a part: its own field, its symbol's, or one by kind. */
export function defaultFootprintName(part: Part): string {
  if (part.footprint) return part.footprint
  const sym = symbolFor(part)
  if (sym?.footprint) return sym.footprint
  const name = sym?.name ?? ""
  const sim = resolveSim(part)
  const kind = sim && !("error" in sim) ? sim.kind : ""
  const filters = sym?.footprintFilters?.join(" ") ?? ""
  if (/^CP|C_Polarized/i.test(name) || /CP_\*/.test(filters)) return "Capacitor_THT:CP_Radial_D5.0mm_P2.00mm"
  if (/^LED/i.test(name)) return "LED_THT:LED_D3.0mm"
  if (kind === "R" && /Pot/i.test(name)) return "Generic:Inline_3"
  if (kind === "R") return "Resistor_SMD:R_0603_1608Metric"
  if (kind === "C") return "Capacitor_SMD:C_0603_1608Metric"
  if (kind === "L") return "Inductor_SMD:L_1206_3216Metric"
  if (kind === "D") return "Diode_THT:D_DO-35_SOD27_P7.62mm_Horizontal"
  if (/DIP\*W7\.62mm/.test(filters)) {
    const pins = new Set(sym?.units.flatMap((u) => u.pins.map((p) => p.n)) ?? []).size
    return `Package_DIP:DIP-${Math.max(8, pins + (pins % 2))}_W7.62mm`
  }
  if (/TO\?220/.test(filters)) return "Package_TO_SOT_THT:TO-220-3_Vertical"
  if (/TO\?92/.test(filters)) return "Package_TO_SOT_THT:TO-92_Inline"
  if (/SOT\?23|SOT-23/.test(filters)) return "Package_TO_SOT_SMD:SOT-23"
  // sources, batteries and connectors become a header the supply / signal plugs into
  if (kind === "V" || kind === "I" || /Battery|Conn_01x02/i.test(name)) return "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical"
  const m = /Conn_01x(\d+)/.exec(name)
  if (m) return `Connector_PinHeader_2.54mm:PinHeader_1x${m[1]}_P2.54mm_Vertical`
  return ""
}

/** The footprint a part gets on the board; pads are checked against its symbol pins. */
export function footprintFor(part: Part): Footprint {
  const sym = symbolFor(part)
  const pins = [...new Set(sym?.units.flatMap((u) => u.pins.map((p) => p.n)) ?? [])]
  const name = defaultFootprintName(part)
  const f = name ? footprintFromName(name) : null
  if (f && pins.every((n) => f.pads.some((p) => p.n === n))) return f
  return genericFootprint(pins.length ? pins : ["1", "2"])
}
