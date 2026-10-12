// Convert the KiCad symbol libraries (vendor/kicad-symbols, CC-BY-SA 4.0 with
// the design exception) into compact JSON the app loads on demand:
//   apps/desktop/public/kicad/index.json      one row per symbol, for search
//   apps/desktop/public/kicad/lib/<Lib>.json  geometry: per-unit SVG + pins
// Coordinates: KiCad mm, Y up  →  SVG px (10 px/mm), Y down. Pins are emitted
// in grid units (1.27 mm), which every official pin lies on.
//
//   node scripts/build-kicad-symbols.mjs
import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
const writeGz = (file, data) => fs.writeFileSync(file + ".gz", zlib.gzipSync(JSON.stringify(data), { level: 9 }))

const ROOT = path.resolve(import.meta.dirname, "..")
const SRC = path.join(ROOT, "vendor/kicad-symbols")
const OUT = path.join(ROOT, "apps/desktop/public/kicad")
const PX = 10
const GRID = 1.27

// ---------- s-expression parser ----------
function parse(src) {
  let i = 0
  const n = src.length
  function node() {
    while (i < n && /\s/.test(src[i])) i++
    if (src[i] === "(") {
      i++
      const list = []
      for (;;) {
        while (i < n && /\s/.test(src[i])) i++
        if (src[i] === ")") { i++; return list }
        list.push(node())
      }
    }
    if (src[i] === '"') {
      i++
      let s = ""
      while (src[i] !== '"') {
        if (src[i] === "\\") { i++; s += src[i] === "n" ? "\n" : src[i] } else s += src[i]
        i++
      }
      i++
      return { s }
    }
    let a = ""
    while (i < n && !/[\s()]/.test(src[i])) a += src[i++]
    return a
  }
  return node()
}
const str = (v) => (typeof v === "object" && v && "s" in v ? v.s : v)
const kids = (l, tag) => l.filter((c) => Array.isArray(c) && c[0] === tag)
const kid = (l, tag) => kids(l, tag)[0]
const num = (v) => parseFloat(str(v))
const yes = (l, tag) => { const k = kid(l, tag); return !!k && (k.length === 1 || str(k[1]) === "yes") }

// ---------- geometry → SVG ----------
const r2 = (v) => Math.round(v * 100) / 100
const X = (mm) => r2(mm * PX)
const Y = (mm) => r2(-mm * PX)
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

function strokeOf(item) {
  const st = kid(item, "stroke")
  const w = st ? num(kid(st, "width")?.[1] ?? 0) : 0
  const type = st ? str(kid(st, "type")?.[1] ?? "default") : "default"
  const width = r2(Math.max(w || 0.1524, 0.1524) * PX)
  const dash = type === "dash" ? ` stroke-dasharray="${width * 3} ${width * 2}"` : type === "dot" ? ` stroke-dasharray="${width} ${width * 2}"` : ""
  return `stroke-width="${width}"${dash}`
}
function fillOf(item) {
  const f = kid(item, "fill")
  const t = f ? str(kid(f, "type")?.[1] ?? "none") : "none"
  if (t === "outline") return `fill="currentColor"`
  if (t === "background") return `class="kb"`
  return `fill="none"`
}
const box = { minx: Infinity, miny: Infinity, maxx: -Infinity, maxy: -Infinity }
function grow(b, x, y) { b.minx = Math.min(b.minx, x); b.miny = Math.min(b.miny, y); b.maxx = Math.max(b.maxx, x); b.maxy = Math.max(b.maxy, y) }

function angleOf(a) { let v = num(a ?? 0); if (Math.abs(v) > 360) v /= 10; return v }
function textEl(text, x, y, sizeMm, angle, anchor = "middle", baseline = "central", cls = "kt") {
  let t = text
  let over = false
  if (/~\{/.test(t)) { over = true; t = t.replace(/~\{([^}]*)\}/g, "$1") }
  const rot = angle ? ` transform="rotate(${-angle} ${x} ${y})"` : ""
  return `<text x="${x}" y="${y}" font-size="${r2(sizeMm * PX * 1.05)}" text-anchor="${anchor}" dominant-baseline="${baseline}" class="${cls}"${over ? ' text-decoration="overline"' : ""}${rot}>${esc(t)}</text>`
}

function drawItem(item, b) {
  const tag = item[0]
  switch (tag) {
    case "rectangle": {
      const s = kid(item, "start"), e = kid(item, "end")
      const x1 = X(num(s[1])), y1 = Y(num(s[2])), x2 = X(num(e[1])), y2 = Y(num(e[2]))
      grow(b, x1, y1); grow(b, x2, y2)
      return `<rect x="${Math.min(x1, x2)}" y="${Math.min(y1, y2)}" width="${r2(Math.abs(x2 - x1))}" height="${r2(Math.abs(y2 - y1))}" ${strokeOf(item)} ${fillOf(item)}/>`
    }
    case "polyline": case "bezier": {
      const pts = kids(kid(item, "pts"), "xy").map((p) => [X(num(p[1])), Y(num(p[2]))])
      pts.forEach((p) => grow(b, p[0], p[1]))
      if (tag === "bezier" && pts.length === 4) return `<path d="M${pts[0]}C${pts[1]} ${pts[2]} ${pts[3]}" ${strokeOf(item)} ${fillOf(item)}/>`
      return `<polyline points="${pts.map((p) => p.join(",")).join(" ")}" ${strokeOf(item)} ${fillOf(item)}/>`
    }
    case "circle": {
      const c = kid(item, "center"), r = num(kid(item, "radius")[1])
      const cx = X(num(c[1])), cy = Y(num(c[2])), rr = r2(r * PX)
      grow(b, cx - rr, cy - rr); grow(b, cx + rr, cy + rr)
      return `<circle cx="${cx}" cy="${cy}" r="${rr}" ${strokeOf(item)} ${fillOf(item)}/>`
    }
    case "arc": {
      const s = kid(item, "start"), m = kid(item, "mid"), e = kid(item, "end")
      if (!m) return ""
      const p1 = [X(num(s[1])), Y(num(s[2]))], p2 = [X(num(m[1])), Y(num(m[2]))], p3 = [X(num(e[1])), Y(num(e[2]))]
      const d = 2 * (p1[0] * (p2[1] - p3[1]) + p2[0] * (p3[1] - p1[1]) + p3[0] * (p1[1] - p2[1]))
      ;[p1, p2, p3].forEach((p) => grow(b, p[0], p[1]))
      if (Math.abs(d) < 1e-9) return `<polyline points="${p1} ${p3}" ${strokeOf(item)} fill="none"/>`
      const sq = (p) => p[0] * p[0] + p[1] * p[1]
      const ux = (sq(p1) * (p2[1] - p3[1]) + sq(p2) * (p3[1] - p1[1]) + sq(p3) * (p1[1] - p2[1])) / d
      const uy = (sq(p1) * (p3[0] - p2[0]) + sq(p2) * (p1[0] - p3[0]) + sq(p3) * (p2[0] - p1[0])) / d
      const r = r2(Math.hypot(p1[0] - ux, p1[1] - uy))
      // large-arc / sweep from the side the mid point lies on
      const cross = (p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])
      const sweep = cross < 0 ? 1 : 0
      const chordMid = [(p1[0] + p3[0]) / 2, (p1[1] + p3[1]) / 2]
      const midSide = Math.sign((p2[0] - chordMid[0]) * (ux - chordMid[0]) + (p2[1] - chordMid[1]) * (uy - chordMid[1]))
      const large = midSide > 0 ? 1 : 0
      return `<path d="M${p1}A${r} ${r} 0 ${large} ${sweep} ${p3}" ${strokeOf(item)} ${fillOf(item)}/>`
    }
    case "text": {
      const at = kid(item, "at"), eff = kid(item, "effects")
      if (eff && yes(eff, "hide")) return ""
      const size = num(kid(kid(eff, "font"), "size")?.[1] ?? 1.27)
      const x = X(num(at[1])), y = Y(num(at[2]))
      grow(b, x, y)
      return textEl(str(item[1]), x, y, size, angleOf(at[3]))
    }
    case "text_box": {
      const at = kid(item, "at"), sz = kid(item, "size")
      const x = X(num(at[1])), y = Y(num(at[2])), w = r2(num(sz[1]) * PX), h = r2(-num(sz[2]) * PX)
      grow(b, x, y); grow(b, x + w, y + h)
      const lines = str(item[1]).split("\n")
      return `<rect x="${Math.min(x, x + w)}" y="${Math.min(y, y + h)}" width="${Math.abs(w)}" height="${Math.abs(h)}" ${strokeOf(item)} ${fillOf(item)}/>` +
        lines.map((l, k) => textEl(l, x + w / 2, y + h / 2 + (k - (lines.length - 1) / 2) * 13, 1.27)).join("")
    }
  }
  return ""
}

const DIRS = { 0: [1, 0], 90: [0, -1], 180: [-1, 0], 270: [0, 1] } // in SVG space (y down)

function drawPin(pin, sym, b) {
  const at = kid(pin, "at")
  const ang = ((Math.round(num(at[3] ?? 0)) % 360) + 360) % 360
  const len = num(kid(pin, "length")?.[1] ?? 2.54)
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
      // small triangle inside the body edge
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
  return {
    svg,
    pin: { n: numb, name, x: gx, y: gy, a: ang, t: str(pin[1]), ...(hidden ? { h: 1 } : {}) },
  }
}

// ---------- symbols ----------
function propsOf(sym) {
  const out = {}
  for (const p of kids(sym, "property")) {
    const key = str(p[1])
    const at = kid(p, "at")
    const eff = kid(p, "effects")
    out[key] = {
      v: str(p[2]),
      ...(at ? { x: X(num(at[1])), y: Y(num(at[2])), r: num(at[3] ?? 0) } : {}),
      ...(yes(p, "hide") || (eff && yes(eff, "hide")) ? { h: 1 } : {}),
      ...(eff && kid(eff, "justify") ? { j: kid(eff, "justify").slice(1).map(str).join(" ") } : {}),
    }
  }
  return out
}

function convert(sym) {
  const name = str(sym[1])
  const props = propsOf(sym)
  const ext = kid(sym, "extends")
  const fields = {}
  for (const k of ["Reference", "Value"]) if (props[k]) fields[k] = props[k]
  const sim = {}
  for (const [k, p] of Object.entries(props)) if (k.startsWith("Sim.")) sim[k.slice(4)] = p.v
  for (const k of ["Spice_Primitive", "Spice_Model", "Spice_Node_Sequence"]) if (props[k]) sim[k] = props[k].v
  const base = {
    desc: props.Description?.v || undefined,
    ds: props.Datasheet?.v && props.Datasheet.v !== "~" ? props.Datasheet.v : undefined,
    fp: props.Footprint?.v || undefined,
    fpf: props.ki_fp_filters?.v || undefined,
    fields,
    ...(Object.keys(sim).length ? { sim } : {}),
    ...(yes(sym, "exclude_from_sim") ? { nosim: 1 } : {}),
  }
  if (ext) return { name, def: { extends: str(ext[1]), ...base }, props }

  const pinNamesK = kid(sym, "pin_names")
  const pinNumsK = kid(sym, "pin_numbers")
  const s = {
    power: !!kid(sym, "power"),
    pinNamesHidden: !!pinNamesK && yes(pinNamesK, "hide"),
    pinNumbersHidden: !!pinNumsK && yes(pinNumsK, "hide"),
    pinNameOffset: pinNamesK && kid(pinNamesK, "offset") ? num(kid(pinNamesK, "offset")[1]) : 0.508,
  }
  // sub-symbols NAME_unit_style; unit 0 = common, style 0 = common, style 2 = De Morgan (skipped)
  const parts = new Map()
  let maxUnit = 1
  const unitNames = {}
  for (const sub of kids(sym, "symbol")) {
    const m = /_(\d+)_(\d+)$/.exec(str(sub[1]))
    if (!m) continue
    const u = +m[1], st = +m[2]
    if (st === 2) continue
    maxUnit = Math.max(maxUnit, u)
    if (kid(sub, "unit_name")) unitNames[u] = str(kid(sub, "unit_name")[1])
    if (!parts.has(u)) parts.set(u, [])
    parts.get(u).push(sub)
  }
  const units = []
  for (let u = 1; u <= maxUnit; u++) {
    const b = { ...box }
    let svg = ""
    const pins = []
    for (const sub of [...(parts.get(0) ?? []), ...(parts.get(u) ?? [])]) {
      for (const item of sub.slice(2)) {
        if (!Array.isArray(item)) continue
        if (item[0] === "pin") { const r = drawPin(item, s, b); svg += r.svg; pins.push(r.pin) } else svg += drawItem(item, b)
      }
    }
    if (!isFinite(b.minx)) { b.minx = b.miny = -5; b.maxx = b.maxy = 5 }
    units.push({
      ...(unitNames[u] ? { name: unitNames[u] } : {}),
      svg,
      pins,
      box: [r2(b.minx), r2(b.miny), r2(b.maxx - b.minx), r2(b.maxy - b.miny)],
    })
  }
  return { name, def: { ...base, ...(s.power ? { power: 1 } : {}), units }, props }
}

// ---------- main ----------
// keep sim-index.json.gz (generated by `pnpm kicad:sim-index` from the app's resolver)
fs.rmSync(path.join(OUT, "lib"), { recursive: true, force: true })
fs.mkdirSync(path.join(OUT, "lib"), { recursive: true })
const index = []
let symbols = 0
const libs = fs.readdirSync(SRC).filter((d) => d.endsWith(".kicad_symdir")).sort()
for (const dir of libs) {
  const lib = dir.replace(/\.kicad_symdir$/, "")
  const out = {}
  const rows = []
  for (const f of fs.readdirSync(path.join(SRC, dir)).filter((f) => f.endsWith(".kicad_sym")).sort()) {
    const tree = parse(fs.readFileSync(path.join(SRC, dir, f), "utf8"))
    for (const sym of kids(tree, "symbol")) {
      const { name, def, props } = convert(sym)
      out[name] = def
      rows.push({ name, def, props })
      symbols++
    }
  }
  // index rows need inherited data (units, ref prefix, power) from the parent
  for (const { name, def, props } of rows) {
    const parent = def.extends ? out[def.extends] : def
    const ref = props.Reference?.v ?? parent?.fields?.Reference?.v ?? "U"
    const kw = props.ki_keywords?.v ?? ""
    index.push([lib, name, def.desc ?? parent?.desc ?? "", kw, ref, parent?.units?.length ?? 1, parent?.power ? 1 : 0])
  }
  writeGz(path.join(OUT, "lib", `${lib}.json`), out)
}
writeGz(path.join(OUT, "index.json"), ({ columns: ["lib", "name", "desc", "keywords", "ref", "units", "power"], rows: index }))
fs.copyFileSync(path.join(SRC, "LICENSE.md"), path.join(OUT, "LICENSE.md"))
console.log(`${libs.length} libraries, ${symbols} symbols → ${path.relative(ROOT, OUT)}`)
