// A KiCad symbol definition (from a schematic's lib_symbols) → the app's SymbolDef: per-unit SVG
// and pins in grid units. The same conversion scripts/build-kicad-symbols.mjs does for the
// bundled libraries, so an imported symbol draws exactly like a library one.
import type { KField, KPin, KUnit, SymbolDef } from "@/lib/kicad"
import { kid, kids, num, str, yes, type List, type Node } from "./sexpr"

const PX = 10
const GRID = 1.27
const r2 = (v: number) => Math.round(v * 100) / 100
const X = (mm: number) => r2(mm * PX)
const Y = (mm: number) => r2(-mm * PX)
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

interface Box { minx: number; miny: number; maxx: number; maxy: number }
const grow = (b: Box, x: number, y: number) => { b.minx = Math.min(b.minx, x); b.miny = Math.min(b.miny, y); b.maxx = Math.max(b.maxx, x); b.maxy = Math.max(b.maxy, y) }

function strokeOf(item: List) {
  const st = kid(item, "stroke")
  const w = st ? num(kid(st, "width")?.[1] ?? "0") : 0
  const type = st ? str(kid(st, "type")?.[1] ?? "default") : "default"
  const width = r2(Math.max(w || 0.1524, 0.1524) * PX)
  const dash = type === "dash" ? ` stroke-dasharray="${width * 3} ${width * 2}"` : type === "dot" ? ` stroke-dasharray="${width} ${width * 2}"` : ""
  return `stroke-width="${width}"${dash}`
}
function fillOf(item: List) {
  const f = kid(item, "fill")
  const t = f ? str(kid(f, "type")?.[1] ?? "none") : "none"
  if (t === "outline") return `fill="currentColor"`
  if (t === "background") return `class="kb"`
  return `fill="none"`
}
const angleOf = (a: Node | undefined) => { let v = num(a ?? "0"); if (Math.abs(v) > 360) v /= 10; return v || 0 }
function textEl(text: string, x: number, y: number, sizeMm: number, angle: number, anchor = "middle", baseline = "central", cls = "kt") {
  let t = text
  let over = false
  if (/~\{/.test(t)) { over = true; t = t.replace(/~\{([^}]*)\}/g, "$1") }
  const rot = angle ? ` transform="rotate(${-angle} ${x} ${y})"` : ""
  return `<text x="${x}" y="${y}" font-size="${r2(sizeMm * PX * 1.05)}" text-anchor="${anchor}" dominant-baseline="${baseline}" class="${cls}"${over ? ' text-decoration="overline"' : ""}${rot}>${esc(t)}</text>`
}

function drawItem(item: List, b: Box): string {
  switch (item[0]) {
    case "rectangle": {
      const s = kid(item, "start")!, e = kid(item, "end")!
      const x1 = X(num(s[1])), y1 = Y(num(s[2])), x2 = X(num(e[1])), y2 = Y(num(e[2]))
      grow(b, x1, y1); grow(b, x2, y2)
      return `<rect x="${Math.min(x1, x2)}" y="${Math.min(y1, y2)}" width="${r2(Math.abs(x2 - x1))}" height="${r2(Math.abs(y2 - y1))}" ${strokeOf(item)} ${fillOf(item)}/>`
    }
    case "polyline": case "bezier": {
      const pts = kids(kid(item, "pts") ?? [], "xy").map((p) => [X(num(p[1])), Y(num(p[2]))])
      pts.forEach((p) => grow(b, p[0], p[1]))
      if (item[0] === "bezier" && pts.length === 4) return `<path d="M${pts[0]}C${pts[1]} ${pts[2]} ${pts[3]}" ${strokeOf(item)} ${fillOf(item)}/>`
      return `<polyline points="${pts.map((p) => p.join(",")).join(" ")}" ${strokeOf(item)} ${fillOf(item)}/>`
    }
    case "circle": {
      const c = kid(item, "center")!, r = num(kid(item, "radius")![1])
      const cx = X(num(c[1])), cy = Y(num(c[2])), rr = r2(r * PX)
      grow(b, cx - rr, cy - rr); grow(b, cx + rr, cy + rr)
      return `<circle cx="${cx}" cy="${cy}" r="${rr}" ${strokeOf(item)} ${fillOf(item)}/>`
    }
    case "arc": {
      const s = kid(item, "start"), m = kid(item, "mid"), e = kid(item, "end")
      if (!s || !m || !e) return ""
      const p1 = [X(num(s[1])), Y(num(s[2]))], p2 = [X(num(m[1])), Y(num(m[2]))], p3 = [X(num(e[1])), Y(num(e[2]))]
      const d = 2 * (p1[0] * (p2[1] - p3[1]) + p2[0] * (p3[1] - p1[1]) + p3[0] * (p1[1] - p2[1]))
      ;[p1, p2, p3].forEach((p) => grow(b, p[0], p[1]))
      if (Math.abs(d) < 1e-9) return `<polyline points="${p1} ${p3}" ${strokeOf(item)} fill="none"/>`
      const sq = (p: number[]) => p[0] * p[0] + p[1] * p[1]
      const ux = (sq(p1) * (p2[1] - p3[1]) + sq(p2) * (p3[1] - p1[1]) + sq(p3) * (p1[1] - p2[1])) / d
      const uy = (sq(p1) * (p3[0] - p2[0]) + sq(p2) * (p1[0] - p3[0]) + sq(p3) * (p2[0] - p1[0])) / d
      const r = r2(Math.hypot(p1[0] - ux, p1[1] - uy))
      const cross = (p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])
      const sweep = cross < 0 ? 1 : 0
      const chordMid = [(p1[0] + p3[0]) / 2, (p1[1] + p3[1]) / 2]
      const midSide = Math.sign((p2[0] - chordMid[0]) * (ux - chordMid[0]) + (p2[1] - chordMid[1]) * (uy - chordMid[1]))
      return `<path d="M${p1}A${r} ${r} 0 ${midSide > 0 ? 1 : 0} ${sweep} ${p3}" ${strokeOf(item)} ${fillOf(item)}/>`
    }
    case "text": {
      const at = kid(item, "at"), eff = kid(item, "effects")
      if (!at || (eff && yes(eff, "hide"))) return ""
      const size = num(kid(kid(eff, "font"), "size")?.[1] ?? "1.27")
      const x = X(num(at[1])), y = Y(num(at[2]))
      grow(b, x, y)
      return textEl(str(item[1]), x, y, size, angleOf(at[3]))
    }
  }
  return ""
}

const DIRS: Record<number, [number, number]> = { 0: [1, 0], 90: [0, -1], 180: [-1, 0], 270: [0, 1] }
interface PinStyle { power: boolean; pinNamesHidden: boolean; pinNumbersHidden: boolean; pinNameOffset: number }

function drawPin(pin: List, sym: PinStyle, b: Box): { svg: string; pin: KPin } {
  const at = kid(pin, "at")!
  const ang = ((Math.round(num(at[3] ?? "0")) % 360) + 360) % 360
  const len = num(kid(pin, "length")?.[1] ?? "2.54")
  const shape = str(pin[2])
  const x = X(num(at[1])), y = Y(num(at[2]))
  const [dx, dy] = DIRS[ang] ?? [1, 0]
  const L = len * PX
  const bx = r2(x + dx * L), by = r2(y + dy * L)
  grow(b, x, y); grow(b, bx, by)
  const name = str(kid(pin, "name")?.[1] ?? "")
  const numb = str(kid(pin, "number")?.[1] ?? "")
  const hidden = yes(pin, "hide")
  let svg = ""
  if (!hidden) {
    const bubble = /inverted/.test(shape)
    const lineEnd = bubble ? [r2(bx - dx * 5), r2(by - dy * 5)] : [bx, by]
    if (L > 0) svg += `<line x1="${x}" y1="${y}" x2="${lineEnd[0]}" y2="${lineEnd[1]}" class="kp"/>`
    if (bubble) svg += `<circle cx="${r2(bx - dx * 2.5)}" cy="${r2(by - dy * 2.5)}" r="2.5" class="kp" fill="none"/>`
    if (/clock/.test(shape)) {
      const px = -dy, py = dx
      svg += `<polyline points="${r2(bx + px * 4)},${r2(by + py * 4)} ${r2(bx + dx * 5)},${r2(by + dy * 5)} ${r2(bx - px * 4)},${r2(by - py * 4)}" class="kp" fill="none"/>`
    }
    if (/_low/.test(shape)) svg += `<polyline points="${r2(bx - dx * 6)},${r2(by - dy * 6 - (dx ? 4 : 0))} ${bx},${by}" class="kp" fill="none"/>`
    const vertical = dx === 0
    const showName = !sym.pinNamesHidden && name && name !== "~"
    const showNum = !sym.pinNumbersHidden && numb && !sym.power
    const off = sym.pinNameOffset
    if (showName && off > 0) {
      const tx = r2(bx + dx * off * PX), ty = r2(by + dy * off * PX)
      const anchor = vertical ? (dy > 0 ? "start" : "end") : dx > 0 ? "start" : "end"
      svg += textEl(name, tx, ty, 1.27, vertical ? 90 : 0, anchor, "central")
    } else if (showName) {
      const mx = (x + bx) / 2, my = (y + by) / 2
      svg += vertical ? textEl(name, r2(mx - 3), r2(my), 1.27, 90, "middle", "text-after-edge") : textEl(name, r2(mx), r2(my - 3), 1.27, 0, "middle", "text-after-edge")
    }
    if (showNum) {
      const mx = (x + bx) / 2, my = (y + by) / 2
      svg += vertical ? textEl(numb, r2(mx - 2), r2(my), 1.0, 90, "middle", "text-after-edge", "kn") : textEl(numb, r2(mx), r2(my - 2), 1.0, 0, "middle", showName && off === 0 ? "hanging" : "text-after-edge", "kn")
    }
  }
  const gx = Math.round(num(at[1]) / GRID), gy = Math.round(-num(at[2]) / GRID)
  return { svg, pin: { n: numb, name, x: gx, y: gy, a: ang, t: str(pin[1]), ...(hidden ? { h: 1 as const } : {}) } }
}

/** A symbol's properties: name → value and where it's drawn. */
export function propsOf(sym: List): Record<string, KField> {
  const out: Record<string, KField> = {}
  for (const p of kids(sym, "property")) {
    const key = str(p[1])
    const at = kid(p, "at")
    const eff = kid(p, "effects")
    out[key] = {
      v: str(p[2]),
      ...(at ? { x: X(num(at[1])), y: Y(num(at[2])), r: num(at[3] ?? "0") } : {}),
      ...(yes(p, "hide") || (eff && yes(eff, "hide")) ? { h: 1 as const } : {}),
      ...(eff && kid(eff, "justify") ? { j: kid(eff, "justify")!.slice(1).map(str).join(" ") } : {}),
    }
  }
  return out
}

/** One lib_symbols entry → SymbolDef (`all` resolves `extends` within the same file). */
export function convertSymbol(sym: List, all?: Map<string, List>): SymbolDef {
  const id = str(sym[1])
  const i = id.indexOf(":")
  const lib = i > 0 ? id.slice(0, i) : "kicad"
  const name = i > 0 ? id.slice(i + 1) : id
  const props = propsOf(sym)
  // a derived symbol draws its base's graphics with its own fields
  const ext = kid(sym, "extends")
  const baseSym = ext ? all?.get(i > 0 ? `${lib}:${str(ext[1])}` : str(ext[1])) : undefined
  const geo = baseSym ?? sym
  const sim: Record<string, string> = {}
  for (const [k, p] of Object.entries(props)) if (k.startsWith("Sim.")) sim[k.slice(4)] = p.v
  const pinNamesK = kid(geo, "pin_names"), pinNumsK = kid(geo, "pin_numbers")
  const style: PinStyle = {
    power: !!kid(geo, "power") || geo.includes("power"),
    pinNamesHidden: !!pinNamesK && yes(pinNamesK, "hide"),
    pinNumbersHidden: !!pinNumsK && yes(pinNumsK, "hide"),
    pinNameOffset: pinNamesK && kid(pinNamesK, "offset") ? num(kid(pinNamesK, "offset")![1]) : 0.508,
  }
  // sub-symbols NAME_unit_style; unit 0 = common to all units, style 2 = De Morgan (skipped)
  const parts = new Map<number, List[]>()
  let maxUnit = 1
  const unitNames: Record<number, string> = {}
  for (const sub of kids(geo, "symbol")) {
    const m = /_(\d+)_(\d+)$/.exec(str(sub[1]))
    if (!m) continue
    const u = +m[1], st = +m[2]
    if (st === 2) continue
    maxUnit = Math.max(maxUnit, u)
    const un = kid(sub, "unit_name")
    if (un) unitNames[u] = str(un[1])
    parts.set(u, [...(parts.get(u) ?? []), sub])
  }
  const units: KUnit[] = []
  for (let u = 1; u <= maxUnit; u++) {
    const b: Box = { minx: Infinity, miny: Infinity, maxx: -Infinity, maxy: -Infinity }
    let svg = ""
    const pins: KPin[] = []
    for (const sub of [...(parts.get(0) ?? []), ...(parts.get(u) ?? [])]) {
      for (const item of sub.slice(2)) {
        if (!Array.isArray(item)) continue
        if (item[0] === "pin") { const r = drawPin(item, style, b); svg += r.svg; pins.push(r.pin) } else svg += drawItem(item, b)
      }
    }
    if (!isFinite(b.minx)) { b.minx = b.miny = -5; b.maxx = b.maxy = 5 }
    units.push({ ...(unitNames[u] ? { name: unitNames[u] } : {}), svg, pins, box: [r2(b.minx), r2(b.miny), r2(b.maxx - b.minx), r2(b.maxy - b.miny)] })
  }
  const fields = { Reference: props.Reference, Value: props.Value }
  return {
    id, lib, name, bases: ext ? [str(ext[1])] : [],
    desc: props.Description?.v ?? "",
    datasheet: props.Datasheet?.v && props.Datasheet.v !== "~" ? props.Datasheet.v : undefined,
    footprint: props.Footprint?.v || undefined,
    footprintFilters: props.ki_fp_filters?.v?.split(/\s+/).filter(Boolean),
    refPrefix: (props.Reference?.v ?? "U").replace(/\?$/, ""),
    value: props.Value?.v ?? name,
    power: style.power,
    units,
    fields,
    sim: Object.keys(sim).length ? sim : undefined,
    excludeFromSim: yes(sym, "exclude_from_sim"),
  }
}
