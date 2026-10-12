// A KiCad schematic (.kicad_sch, KiCad 6–9) → the app's schematic Doc, so a KiCad design opens
// as a Space Bench circuit and as Kirk code. Symbols: the bundled KiCad library's when the
// schematic uses it (or a project copy with the same pins — KiCad's "rescue" libraries); the
// schematic's own definition otherwise (kept in doc.symbols so it saves with the circuit).
import { emptyDoc, transform, uid, type Doc, type Part, type Pt, type Rot, type SimFields, type Wire } from "@/editor/model"
import { ensureSymbols, getSymbol, loadIndex, registerBuiltin, type IndexRow, type SymbolDef } from "@/lib/kicad"
import { parseValue } from "@/lib/spice"
import { kid, kids, num, parseSexpr, str, type List } from "./sexpr"
import { convertSymbol } from "./symbol"

const GRID = 1.27

export interface ImportResult {
  doc: Doc
  /** what didn't come across (sub-sheets, buses, off-grid parts …) */
  warnings: string[]
  /** symbols taken from the schematic itself (not in the bundled library) */
  custom: string[]
}

/** KiCad (angle counter-clockwise, then mirror) → Doc (mirror, then clockwise). */
export function fromKicadOrient(angle: number, mirror: "x" | "y" | null): { rot: Rot; mirror: boolean } {
  const a = ((Math.round(angle / 90) * 90) % 360 + 360) % 360
  const cw = ((360 - a) % 360) as Rot
  if (!mirror) return { rot: cw, mirror: false }
  // mirror y (left ↔ right) after the rotation = mirror before rotating the other way
  const r = mirror === "y" ? a : (a + 180) % 360
  return { rot: r as Rot, mirror: true }
}

/** Doc → KiCad: the inverse of fromKicadOrient (always written as mirror y). */
export function toKicadOrient(rot: Rot, mirror: boolean): { angle: number; mirror: "y" | null } {
  if (!mirror) return { angle: (360 - rot) % 360, mirror: null }
  return { angle: rot, mirror: "y" }
}

const pinsKey = (s: SymbolDef) => s.units.map((u) => u.pins.map((p) => `${p.n}@${p.x},${p.y}`).sort().join(" ")).join(" | ")

const PREFERRED = ["Device", "Simulation_SPICE", "power", "Connector", "Connector_Generic", "Transistor_BJT", "Transistor_FET", "Diode", "Amplifier_Operational", "Timer", "Switch"]

/** A bundled symbol with the same name and pins as the schematic's own copy, if there is one. */
async function libraryTwin(def: SymbolDef, index: IndexRow[] | null): Promise<string | null> {
  if (!index) return null
  const want = pinsKey(def)
  // only the bundled library counts (not symbols an earlier import registered)
  const rows = index.filter((r) => r.name === def.name || r.name === def.name.replace(/^(.*)_\d+$/, "$1"))
  rows.sort((a, b) => (`${a.lib}:${a.name}` === def.id ? -1 : 0) - (`${b.lib}:${b.name}` === def.id ? -1 : 0) || (PREFERRED.indexOf(a.lib) + 1 || 99) - (PREFERRED.indexOf(b.lib) + 1 || 99))
  const ids = rows.map((r) => `${r.lib}:${r.name}`)
  for (const id of ids) {
    try { await ensureSymbols([id]) } catch { continue }
    const s = getSymbol(id)
    if (s && s.power === def.power && pinsKey(s) === want) return id
  }
  return null
}

const onGrid = (mm: number) => Math.abs(mm / GRID - Math.round(mm / GRID)) < 0.02
const g = (mm: number) => Math.round(mm / GRID)

/** Analyses from the schematic's simulation directives (.tran, .ac, .op); the first one found runs by default. */
function directives(root: List, doc: Doc) {
  const found: Doc["defaultAnalysis"][] = []
  for (const t of kids(root, "text")) {
    for (const line of str(t[1]).split("\n").map((l) => l.trim())) {
      const w = line.split(/\s+/)
      if (w[0] === ".tran" && w.length >= 3) {
        const step = parseValue(w[1]), stop = parseValue(w[2])
        if (step && stop) { doc.analyses.tran = { step, stop }; found.push("tran") }
      } else if (w[0] === ".ac" && w.length >= 5) {
        const pts = Number(w[2]), a = parseValue(w[3]), b = parseValue(w[4])
        if (a && b) { doc.analyses.ac = { start: a, stop: b, ...(pts ? { points: pts } : {}) }; found.push("ac") }
      } else if (w[0] === ".op") found.push("op")
    }
  }
  if (found.length) doc.defaultAnalysis = found[0]
}

export async function importKicadSch(text: string, name = "KiCad schematic"): Promise<ImportResult> {
  const root = parseSexpr(text)
  if (root[0] !== "kicad_sch") throw new Error("not a KiCad schematic (.kicad_sch from KiCad 6 or later)")
  const warnings: string[] = []
  const doc: Doc = emptyDoc()
  const title = str(kid(kid(root, "title_block"), "title")?.[1])
  doc.title = title || name.replace(/\.kicad_sch$/, "")
  directives(root, doc)

  // ---- symbol definitions: the bundled library's where they match, else the file's own
  let index: IndexRow[] | null = null
  try { index = await loadIndex() } catch { index = null }
  const defs = new Map<string, List>()
  for (const s of kids(kid(root, "lib_symbols") ?? [], "symbol")) defs.set(str(s[1]), s)
  const symFor = new Map<string, string>()
  const custom: SymbolDef[] = []
  for (const [id, s] of defs) {
    const def = convertSymbol(s, defs)
    const twin = await libraryTwin(def, index)
    if (twin) symFor.set(id, twin)
    else { registerBuiltin(def); custom.push(def); symFor.set(id, id) }
  }

  // ---- placed symbols
  let offGrid = 0
  for (const s of kids(root, "symbol")) {
    const libId = str(kid(s, "lib_id")?.[1])
    const at = kid(s, "at")
    if (!libId || !at) continue
    const props = new Map(kids(s, "property").map((p) => [str(p[1]), str(p[2])]))
    const instRef = str(kid(kid(kid(kid(s, "instances"), "project"), "path"), "reference")?.[1])
    let ref = props.get("Reference") ?? "?"
    if (/\?$/.test(ref) && instRef) ref = instRef
    const lib = symFor.get(libId) ?? libId
    if (!getSymbol(lib)) { try { await ensureSymbols([lib]) } catch { /* reported below */ } }
    const sym = getSymbol(lib)
    if (!sym) { warnings.push(`${ref}: symbol ${libId} isn't in the file or the library — skipped`); continue }
    const mx = str(kid(s, "mirror")?.[1])
    const o = fromKicadOrient(num(at[3] ?? "0"), mx === "x" || mx === "y" ? mx : null)
    const x = num(at[1]), y = num(at[2])
    if (!onGrid(x) || !onGrid(y)) offGrid++
    const sim: SimFields = {}
    const fields: Record<string, string> = {}
    for (const [k, v] of props) {
      if (k.startsWith("Sim.")) { if (v) (sim as Record<string, string>)[k.slice(4)] = v; continue }
      if (["Reference", "Value", "Footprint", "Datasheet", "Description", "Fieldname"].includes(k) || k.startsWith("ki_")) continue
      if (v) fields[k] = v
    }
    if (kid(s, "exclude_from_sim") && str(kid(s, "exclude_from_sim")![1]) === "yes") sim.Exclude = "1"
    const ds = props.get("Datasheet")
    if (ds && ds !== "~" && ds !== sym.datasheet) fields.Datasheet = ds
    let value = props.get("Value") ?? sym.value
    // KiCad's "${SIM.PARAMS}" value shows the simulation parameters
    if (/^\$\{SIM\.PARAMS\}$/i.test(value)) value = sim.Params ?? sym.value
    const part: Part = {
      id: uid("p"), ref, lib, unit: Math.max(1, num(kid(s, "unit")?.[1] ?? "1") || 1), x: g(x), y: g(y), rot: o.rot, ...(o.mirror ? { mirror: true } : {}), value,
      ...(Object.keys(sim).length ? { sim } : {}),
      // the symbol's default footprint isn't a choice the design made
      ...(props.get("Footprint") && props.get("Footprint") !== sym.footprint ? { footprint: props.get("Footprint") } : {}),
      ...(Object.keys(fields).length ? { fields } : {}),
    }
    doc.parts.push(part)
  }
  if (offGrid) warnings.push(`${offGrid} symbol${offGrid > 1 ? "s were" : " was"} off the 1.27 mm grid and moved onto it`)

  // ---- wires, labels, no-connects
  for (const w of kids(root, "wire")) {
    const pts = kids(kid(w, "pts") ?? [], "xy").map((p): Pt => [g(num(p[1])), g(num(p[2]))])
    for (let k = 0; k + 1 < pts.length; k++) if (pts[k][0] !== pts[k + 1][0] || pts[k][1] !== pts[k + 1][1]) doc.wires.push({ id: uid("w"), a: pts[k], b: pts[k + 1] } satisfies Wire)
  }
  let lbl = 0
  for (const tag of ["label", "global_label", "hierarchical_label"]) {
    for (const l of kids(root, tag)) {
      const at = kid(l, "at")
      if (!at) continue
      const net = str(l[1])
      const a = ((Math.round(num(at[3] ?? "0") / 90) * 90) % 360 + 360) % 360
      doc.parts.push({ id: uid("l"), ref: `#LBL${++lbl}`, lib: "@:label", unit: 1, x: g(num(at[1])), y: g(num(at[2])), rot: ((360 - a) % 360) as Rot, value: net, net })
    }
  }
  doc.noConnects = kids(root, "no_connect").map((n) => { const at = kid(n, "at")!; return [g(num(at[1])), g(num(at[2]))] as Pt })
  if (!doc.noConnects.length) delete doc.noConnects

  // ---- what isn't imported
  const n = (tag: string) => kids(root, tag).length
  if (n("sheet")) warnings.push(`${n("sheet")} sub-sheet${n("sheet") > 1 ? "s are" : " is"} not imported (only the root sheet)`)
  if (n("bus")) warnings.push(`${n("bus")} bus${n("bus") > 1 ? "es are" : " is"} not imported — labels on the bus members still connect`)
  if (custom.length) doc.symbols = custom
  return { doc, warnings, custom: custom.map((c) => c.id) }
}

/** Where each placed pin of the doc lands (for checks): "R1.2" → [x, y]. */
export function pinPoints(doc: Doc): Map<string, Pt> {
  const out = new Map<string, Pt>()
  for (const p of doc.parts) {
    const s = getSymbol(p.lib)
    const u = s?.units[Math.min(Math.max(p.unit, 1), s.units.length) - 1]
    for (const q of u?.pins ?? []) {
      const [dx, dy] = transform([q.x, q.y], p.rot, p.mirror)
      out.set(`${p.ref}.${q.n}`, [p.x + dx, p.y + dy])
    }
  }
  return out
}

export const isKicadSch = (text: string) => /^\s*\(kicad_sch\b/.test(text)