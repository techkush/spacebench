// The app's schematic Doc → a KiCad schematic (.kicad_sch, KiCad 8 format — KiCad 8 and 9 open
// it). Symbols are written from the app's own data (pins exactly, graphics from their drawing);
// in KiCad, "Update Symbols from Library" swaps in the library's originals if wanted.
import { isLabel, isPower, transform, type Doc, type Pt } from "@/editor/model"
import { deriveNetlist } from "@/editor/netlist"
import { getSymbol, type KUnit, type SymbolDef } from "@/lib/kicad"
import { printSexpr, type List, type Node } from "./sexpr"
import { toKicadOrient } from "./schImport"

const GRID = 1.27
const q = (s: string): Node => ({ s })
const mm = (v: number) => String(Math.round(v * 10000) / 10000)
const uuid = () => (globalThis.crypto?.randomUUID?.() ?? "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 0x3) | 0x8).toString(16) }))
const font = (size = 1.27): List => ["font", ["size", mm(size), mm(size)]]
const effects = (hide = false, justify?: string): List => ["effects", font(), ...(justify ? [["justify", ...justify.split(" ")] as List] : []), ...(hide ? ["hide"] : [])]

// ---------------------------------------------------------------- symbol definitions

const attr = (el: string, name: string) => { const m = new RegExp(`\\b${name}="([^"]*)"`).exec(el); return m ? m[1] : undefined }
const pxX = (v: number) => mm(v / 10)
const pxY = (v: number) => mm(-v / 10)
const strokeW = (el: string) => { const w = Number(attr(el, "stroke-width") ?? "1.524") / 10; return ["stroke", ["width", mm(w <= 0.1524 ? 0 : w)], ["type", /stroke-dasharray/.test(el) ? "dash" : "default"]] as List }
const fillK = (el: string): List => ["fill", ["type", /fill="currentColor"/.test(el) ? "outline" : /class="kb"/.test(el) ? "background" : "none"]]

/** The drawing of a unit (its SVG, without the pins) as KiCad graphic items. */
function graphics(svg: string): List[] {
  const out: List[] = []
  for (const el of svg.match(/<(rect|polyline|path|circle)\b[^>]*>/g) ?? []) {
    if (/class="kp"/.test(el)) continue // pin lines, bubbles, clock marks: drawn by the pins
    if (el.startsWith("<rect")) {
      const x = Number(attr(el, "x")), y = Number(attr(el, "y")), w = Number(attr(el, "width")), h = Number(attr(el, "height"))
      out.push(["rectangle", ["start", pxX(x), pxY(y)], ["end", pxX(x + w), pxY(y + h)], strokeW(el), fillK(el)])
    } else if (el.startsWith("<polyline")) {
      const pts = (attr(el, "points") ?? "").trim().split(/\s+/).map((p) => p.split(",").map(Number))
      if (pts.length >= 2) out.push(["polyline", ["pts", ...pts.map(([x, y]) => ["xy", pxX(x), pxY(y)] as List)], strokeW(el), fillK(el)])
    } else if (el.startsWith("<circle")) {
      out.push(["circle", ["center", pxX(Number(attr(el, "cx"))), pxY(Number(attr(el, "cy")))], ["radius", mm(Number(attr(el, "r")) / 10)], strokeW(el), fillK(el)])
    } else {
      const d = attr(el, "d") ?? ""
      const c = /^M([-\d.]+),([-\d.]+)C([-\d.]+),([-\d.]+) ([-\d.]+),([-\d.]+) ([-\d.]+),([-\d.]+)$/.exec(d)
      if (c) {
        const n = c.slice(1).map(Number)
        out.push(["bezier", ["pts", ["xy", pxX(n[0]), pxY(n[1])], ["xy", pxX(n[2]), pxY(n[3])], ["xy", pxX(n[4]), pxY(n[5])], ["xy", pxX(n[6]), pxY(n[7])]], strokeW(el), fillK(el)])
        continue
      }
      const a = /^M([-\d.]+),([-\d.]+)A([-\d.]+) ([-\d.]+) 0 ([01]) ([01]) ([-\d.]+),([-\d.]+)$/.exec(d)
      if (a) {
        const [x1, y1, r, , large, sweep, x2, y2] = a.slice(1).map(Number)
        // the centre: on the chord's bisector, on the side the flags pick
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, dx = x2 - x1, dy = y2 - y1, chord = Math.hypot(dx, dy)
        const h = Math.sqrt(Math.max(0, r * r - (chord / 2) ** 2))
        const sgn = large === sweep ? -1 : 1
        const cx = mx - (sgn * h * dy) / chord, cy = my + (sgn * h * dx) / chord
        let a1 = Math.atan2(y1 - cy, x1 - cx), a2 = Math.atan2(y2 - cy, x2 - cx)
        if (sweep) { while (a2 < a1) a2 += 2 * Math.PI } else { while (a2 > a1) a2 -= 2 * Math.PI }
        const am = (a1 + a2) / 2
        out.push(["arc", ["start", pxX(x1), pxY(y1)], ["mid", pxX(cx + r * Math.cos(am)), pxY(cy + r * Math.sin(am))], ["end", pxX(x2), pxY(y2)], strokeW(el), fillK(el)])
      }
    }
  }
  return out
}

const PIN_TYPES = new Set(["input", "output", "bidirectional", "tri_state", "passive", "free", "unspecified", "power_in", "power_out", "open_collector", "open_emitter", "no_connect"])

function pinItems(u: KUnit, power: boolean): List[] {
  return u.pins.map((p) => {
    const px = Math.round(p.x * GRID * 1000) / 100, py = Math.round(p.y * GRID * 1000) / 100
    // the pin's line in the drawing gives its length
    const line = (u.svg.match(/<line\b[^>]*class="kp"[^>]*>/g) ?? []).find((l) => Math.abs(Number(attr(l, "x1")) - px) < 0.02 && Math.abs(Number(attr(l, "y1")) - py) < 0.02)
    let len = line ? Math.hypot(Number(attr(line, "x2")) - px, Number(attr(line, "y2")) - py) / 10 : power ? 0 : 2.54
    len = Math.round(len / GRID * 2) * GRID / 2
    return ["pin", PIN_TYPES.has(p.t) ? p.t : "passive", "line", ["at", mm(p.x * GRID), mm(-p.y * GRID), String(p.a)], ["length", mm(len)], ...(p.h ? ["hide"] : []),
      ["name", q(p.name || "~"), effects()], ["number", q(p.n), effects()]] as List
  })
}

function symbolDef(def: SymbolDef, id: string): List {
  const name = id.slice(id.indexOf(":") + 1)
  const svgAll = def.units.map((u) => u.svg).join("")
  const numbersShown = /class="kn"/.test(svgAll)
  const prop = (k: string, v: string, hide: boolean, f?: { x?: number; y?: number }): List =>
    ["property", q(k), q(v), ["at", pxX(f?.x ?? 0), pxY(f?.y ?? 0), "0"], effects(hide)]
  const body: List = ["symbol", q(id)]
  if (def.power) body.push(["power"])
  if (!numbersShown) body.push(["pin_numbers", "hide"])
  body.push(["pin_names", ["offset", "0.508"]], ["exclude_from_sim", def.excludeFromSim ? "yes" : "no"], ["in_bom", def.power ? "no" : "yes"], ["on_board", def.power ? "no" : "yes"])
  body.push(prop("Reference", def.power ? "#PWR" : def.refPrefix, !!def.fields.Reference?.h || def.power, def.fields.Reference))
  body.push(prop("Value", def.value, !!def.fields.Value?.h, def.fields.Value))
  body.push(prop("Footprint", def.footprint ?? "", true))
  body.push(prop("Datasheet", def.datasheet ?? "", true))
  body.push(prop("Description", def.desc ?? "", true))
  for (const [k, v] of Object.entries(def.sim ?? {})) if (!/^Spice_/.test(k)) body.push(prop(`Sim.${k}`, v, true))
  def.units.forEach((u, i) => body.push(["symbol", q(`${name}_${i + 1}_1`), ...graphics(u.svg), ...pinItems(u, def.power)]))
  return body
}

// ---------------------------------------------------------------- the sheet

const PAPERS: [string, number, number][] = [["A4", 297, 210], ["A3", 420, 297], ["A2", 594, 420], ["A1", 841, 594], ["A0", 1189, 841]]

/** Every point the drawing uses, in grid units (parts' pins and origins, wires, labels). */
function extent(doc: Doc): { minx: number; miny: number; maxx: number; maxy: number } {
  const xs: number[] = [], ys: number[] = []
  const add = ([x, y]: Pt) => { xs.push(x); ys.push(y) }
  for (const p of doc.parts) {
    add([p.x, p.y])
    const s = getSymbol(p.lib)
    const u = s?.units[Math.min(Math.max(p.unit, 1), s.units.length) - 1]
    if (u) {
      const [bx, by, bw, bh] = u.box.map((v) => v / (GRID * 10))
      for (const c of [[bx, by], [bx + bw, by + bh]] as Pt[]) { const [dx, dy] = transform(c, p.rot, p.mirror); add([p.x + dx, p.y + dy]) }
    }
  }
  for (const w of doc.wires) { add(w.a); add(w.b) }
  if (!xs.length) return { minx: 0, miny: 0, maxx: 0, maxy: 0 }
  return { minx: Math.min(...xs), miny: Math.min(...ys), maxx: Math.max(...xs), maxy: Math.max(...ys) }
}

export function exportKicadSch(doc: Doc, project = "spacebench"): string {
  const root = uuid()
  const e = extent(doc)
  // move the drawing onto the page: 20 grid units (25.4 mm) from the top-left corner
  const ox = 20 - e.minx, oy = 20 - e.miny
  const X = (gx: number) => mm((gx + ox) * GRID), Y = (gy: number) => mm((gy + oy) * GRID)
  const wmm = (e.maxx - e.minx + 40) * GRID, hmm = (e.maxy - e.miny + 48) * GRID
  const paper = PAPERS.find(([, w, h]) => w >= wmm && h >= hmm)?.[0] ?? "A0"

  const sheet: List = ["kicad_sch", ["version", "20231120"], ["generator", q("spacebench")], ["generator_version", q("1.0")], ["uuid", q(root)], ["paper", q(paper)]]
  sheet.push(["title_block", ["title", q(doc.title)], ...(doc.description ? [["comment", "1", q(doc.description.slice(0, 200))] as List] : [])])

  // symbol definitions, once per library id
  const libs: List = ["lib_symbols"]
  const used = [...new Set(doc.parts.filter((p) => !isLabel(p)).map((p) => p.lib))]
  for (const id of used) { const def = getSymbol(id); if (def) libs.push(symbolDef(def, id)) }
  sheet.push(libs)

  // junctions where three or more connections meet
  const nl = deriveNetlist(doc)
  for (const j of nl.junctions) sheet.push(["junction", ["at", X(j[0]), Y(j[1])], ["diameter", "0"], ["color", "0", "0", "0", "0"], ["uuid", q(uuid())]])
  for (const n of doc.noConnects ?? []) sheet.push(["no_connect", ["at", X(n[0]), Y(n[1])], ["uuid", q(uuid())]])
  for (const w of doc.wires) sheet.push(["wire", ["pts", ["xy", X(w.a[0]), Y(w.a[1])], ["xy", X(w.b[0]), Y(w.b[1])]], ["stroke", ["width", "0"], ["type", "default"]], ["uuid", q(uuid())]])
  for (const l of doc.parts.filter(isLabel)) {
    const angle = (360 - l.rot) % 360
    sheet.push(["label", q(l.net ?? l.value), ["at", X(l.x), Y(l.y), String(angle)], ["fields_autoplaced", "yes"], effects(false, angle === 180 || angle === 270 ? "right bottom" : "left bottom"), ["uuid", q(uuid())]])
  }

  // placed symbols
  let pwr = 0
  for (const p of doc.parts) {
    if (isLabel(p)) continue
    const def = getSymbol(p.lib)
    if (!def) continue
    const o = toKicadOrient(p.rot, !!p.mirror)
    const unit = def.units[Math.min(Math.max(p.unit, 1), def.units.length) - 1]
    const power = isPower(p)
    const ref = power && !p.ref.startsWith("#") ? `#PWR0${++pwr}` : p.ref
    // a field's place: the symbol's own, turned with the part
    const at = (f: { x?: number; y?: number } | undefined): List => {
      const [dx, dy] = transform([(f?.x ?? 0) / (GRID * 10), (f?.y ?? 0) / (GRID * 10)], p.rot, p.mirror)
      return ["at", mm((p.x + ox + dx) * GRID), mm((p.y + oy + dy) * GRID), p.rot % 180 ? "90" : "0"]
    }
    const prop = (k: string, v: string, hide: boolean, f?: { x?: number; y?: number }): List => ["property", q(k), q(v), at(f), effects(hide)]
    const sim = { ...def.sim, ...p.sim }
    const sym: List = ["symbol", ["lib_id", q(p.lib)], ["at", X(p.x), Y(p.y), String(o.angle)], ...(o.mirror ? [["mirror", o.mirror] as List] : []), ["unit", String(p.unit || 1)],
      ["exclude_from_sim", sim.Exclude === "1" || def.excludeFromSim ? "yes" : "no"], ["in_bom", power ? "no" : "yes"], ["on_board", power ? "no" : "yes"], ["dnp", "no"], ["uuid", q(uuid())]]
    sym.push(prop("Reference", ref, power || !!def.fields.Reference?.h, def.fields.Reference))
    sym.push(prop("Value", p.value, !!def.fields.Value?.h, def.fields.Value))
    sym.push(prop("Footprint", p.footprint ?? def.footprint ?? "", true))
    sym.push(prop("Datasheet", p.fields?.Datasheet ?? def.datasheet ?? "", true))
    sym.push(prop("Description", def.desc ?? "", true))
    for (const [k, v] of Object.entries(p.fields ?? {})) if (k !== "Datasheet" && v) sym.push(prop(k, v, true))
    for (const [k, v] of Object.entries(p.sim ?? {})) if (v && k !== "Exclude") sym.push(prop(`Sim.${k}`, v, true))
    for (const pin of unit?.pins ?? []) sym.push(["pin", q(pin.n), ["uuid", q(uuid())]])
    sym.push(["instances", ["project", q(project), ["path", q(`/${root}`), ["reference", q(ref)], ["unit", String(p.unit || 1)]]]])
    sheet.push(sym)
  }

  // the analysis as a simulation directive below the drawing
  const a = doc.analyses
  const dir = doc.defaultAnalysis === "ac" ? `.ac dec ${a.ac.points ?? 60} ${a.ac.start} ${a.ac.stop}` : doc.defaultAnalysis === "op" ? ".op" : `.tran ${a.tran.step} ${a.tran.stop}`
  sheet.push(["text", q(dir), ["exclude_from_sim", "no"], ["at", X(e.minx), Y(e.maxy + 6), "0"], effects(false, "left bottom"), ["uuid", q(uuid())]])
  sheet.push(["sheet_instances", ["path", q("/"), ["page", q("1")]]])
  return printSexpr(sheet)
}
