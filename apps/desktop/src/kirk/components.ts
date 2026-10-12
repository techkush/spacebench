// Kirk components — reusable parts (classes) written in Kirk:
//
//   component RCLowPass(r: Resistance = 1.6k, c: Capacitance = 100n) {
//       description "first-order RC low-pass"
//       pins in, out, gnd
//       R1 = R(r)
//       C1 = C(c)
//       in -- R1 -- out -- C1 -- gnd
//   }
//
// An instance (F1 = RCLowPass(r: 2k)) is drawn as a box with the component's pins and simulated
// as an ngspice subcircuit. Each parameter set compiles once (the body, with the parameters put in,
// goes through the normal Kirk compiler) and is kept in the document, so netlisting stays instant.
import type { Doc, Part } from "@/editor/model"
import { deriveNetlist } from "@/editor/netlist"
import { registerBuiltin, type KPin, type SymbolDef } from "@/lib/kicad"
import { buildNetlist, parseParams } from "@/lib/spice"
import type { Expr, File, Item, Span, Stmt } from "./ast"
import { siText } from "./kinds"
import { parse } from "./parser"

export interface ComponentDef {
  name: string
  params: { name: string; type?: string; def?: string }[]
  pins: string[]
  description?: string
  sides?: Partial<Record<"left" | "right" | "top" | "bottom", string[]>>
  /** the whole `component …{ … }` block, as written */
  source: string
  /** the text between its braces */
  body: string
  /** the file it was imported from (then it isn't written back into this file) */
  from?: string
  library?: { name: string; version?: string }
  /** compiled parameter sets: model name → the .subckt (and the models it needs), with its parameters */
  variants: Record<string, { models: Record<string, string>; params: Record<string, string> }>
}

export type Value = { k: "num"; v: number; unit?: string } | { k: "str"; v: string }

/** Unit a parameter type expects. */
const TYPE_UNIT: Record<string, string> = { Resistance: "Ω", Capacitance: "F", Inductance: "H", Voltage: "V", Current: "A", Frequency: "Hz", Time: "s", Power: "W", Temperature: "°C" }
const UNIT_ALIAS: Record<string, string> = { ohm: "Ω", lux: "lx" }

/** The components a parsed file defines. */
export function componentsOf(file: File, src: string, from?: string): ComponentDef[] {
  const lib = file.items.find((i): i is Extract<Item, { k: "library" }> => i.k === "library")
  return file.items.filter((i): i is Extract<Item, { k: "component" }> => i.k === "component").map((c) => {
    const pins = c.body.flatMap((s) => (s.k === "pins" ? s.names : []))
    const sides = c.body.find((s): s is Extract<Stmt, { k: "symbolbox" }> => s.k === "symbolbox")?.sides
    const description = c.body.find((s): s is Extract<Stmt, { k: "describe" }> => s.k === "describe")?.text
    return {
      name: c.name, pins, sides, description,
      params: c.params.map((p) => ({ name: p.name, type: p.type, def: p.def ? src.slice(p.def.span.from, p.def.span.to) : undefined })),
      source: src.slice(c.span.from, c.span.to), body: src.slice(c.bodySpan.from, c.bodySpan.to),
      ...(from ? { from } : {}), ...(lib ? { library: { name: lib.name, version: lib.version } } : {}),
      variants: {},
    }
  })
}

// ---------------------------------------------------------------- expressions with parameters

export class ParamError extends Error {}

const FUNCS: Record<string, (...a: number[]) => number> = {
  sqrt: Math.sqrt, exp: Math.exp, ln: Math.log, log: Math.log10, log10: Math.log10, abs: Math.abs, pow: Math.pow,
  min: Math.min, max: Math.max, sin: Math.sin, cos: Math.cos, tan: Math.tan, atan: Math.atan, floor: Math.floor, ceil: Math.ceil, round: Math.round,
}

/** Evaluate an expression where identifiers are parameters. */
export function evalWith(e: Expr, env: Map<string, Value>): Value {
  switch (e.k) {
    case "num": return { k: "num", v: e.value, unit: e.unit ? UNIT_ALIAS[e.unit] ?? e.unit : undefined }
    case "str": return { k: "str", v: e.value }
    case "neg": { const a = evalWith(e.a, env); if (a.k !== "num") throw new ParamError("can't negate text"); return { ...a, v: -a.v } }
    case "id": {
      const v = env.get(e.name)
      if (v) return v
      if (e.name === "pi") return { k: "num", v: Math.PI }
      throw new ParamError(`unknown parameter “${e.name}”`)
    }
    case "bin": {
      const a = evalWith(e.a, env), b = evalWith(e.b, env)
      if (a.k !== "num" || b.k !== "num") throw new ParamError("arithmetic needs numbers")
      const op = e.op
      const v = op === "+" ? a.v + b.v : op === "-" ? a.v - b.v : op === "*" ? a.v * b.v : op === "/" ? a.v / b.v : op === "^" || op === "**" ? Math.pow(a.v, b.v) : NaN
      if (Number.isNaN(v)) throw new ParamError(`operator “${op}” can't be used here`)
      if ((op === "+" || op === "-") && a.unit && b.unit && a.unit !== b.unit) throw new ParamError(`can't ${op === "+" ? "add" : "subtract"} ${b.unit} and ${a.unit}`)
      const unit = op === "+" || op === "-" ? a.unit ?? b.unit : op === "*" ? (a.unit && b.unit ? undefined : a.unit ?? b.unit) : a.unit && !b.unit ? a.unit : undefined
      return { k: "num", v, unit }
    }
    case "call": {
      const f = FUNCS[e.fn]
      if (!f) throw new ParamError(`unknown function “${e.fn}”`)
      const xs = e.args.map((a) => evalWith(a.value, env))
      if (xs.some((x) => x.k !== "num")) throw new ParamError(`${e.fn}() needs numbers`)
      return { k: "num", v: f(...xs.map((x) => (x as { v: number }).v)) }
    }
    default: throw new ParamError("expected a number, a parameter or a calculation")
  }
}

const refs = (e: Expr, names: Set<string>): boolean => {
  switch (e.k) {
    case "id": return names.has(e.name)
    case "neg": return refs(e.a, names)
    case "bin": return refs(e.a, names) || refs(e.b, names)
    case "call": return e.args.some((a) => refs(a.value, names))
    case "list": return e.items.some((x) => refs(x, names))
    default: return false
  }
}

/** Kirk text for a value (units stuck to the number so they lex as one token). */
export function literal(v: Value): string {
  if (v.k === "str") return JSON.stringify(v.v)
  return `${siText(v.v)}${v.unit && v.unit !== "%" ? v.unit : v.unit === "%" ? "%" : ""}`
}

/** The parameter values of an instance: its arguments, then the defaults (which may use earlier ones). */
export function instanceEnv(def: ComponentDef, given: Map<string, Value>): Map<string, Value> {
  const env = new Map<string, Value>()
  for (const p of def.params) {
    let v = given.get(p.name)
    if (!v) {
      if (p.def === undefined) throw new ParamError(`${def.name}() needs ${p.name}:`)
      v = evalWith(parseExpr(p.def), env)
    }
    const want = p.type ? TYPE_UNIT[p.type] : undefined
    if (want && v.k === "num" && v.unit && v.unit !== want) throw new ParamError(`${p.name} is a ${p.type!.toLowerCase()} (${want}), not ${v.unit}`)
    if (want && v.k === "num" && !v.unit) v = { ...v, unit: want }
    env.set(p.name, v)
  }
  return env
}

function parseExpr(src: string): Expr {
  const r = parse(`stimulus {\n    x = ${src}\n}\n`)
  const it = r.file.items[0]
  if (r.diagnostics.length || it?.k !== "stimulus" || !it.feeds[0]) throw new ParamError(`can't read “${src}”`)
  return it.feeds[0].value
}

/** "r=2k c=100n q=\"2N3904\"" ⇄ values. */
export const paramsText = (env: Map<string, Value>) => [...env].map(([k, v]) => `${k}=${v.k === "str" ? JSON.stringify(v.v) : literal(v)}`).join(" ")
export function envFromParams(def: ComponentDef, text: string | undefined): Map<string, Value> {
  const raw = parseParams(text)
  const given = new Map<string, Value>()
  for (const p of def.params) {
    const t = raw[p.name.toLowerCase()]
    if (t === undefined) continue
    given.set(p.name, /^"/.test(t) || !/^[-+.\d]/.test(t) ? { k: "str", v: t.replace(/^"|"$/g, "") } : evalWith(parseExpr(t), new Map()))
  }
  return instanceEnv(def, given)
}

const hash = (s: string) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0).toString(36) }
export const modelName = (def: ComponentDef, env: Map<string, Value>) => `K_${def.name.toUpperCase()}_${hash(paramsText(env))}`

// ---------------------------------------------------------------- compiling one parameter set

export interface ComponentContext {
  defs: Map<string, ComponentDef>
  depth: number
  /** compileKirk, passed in to avoid an import cycle */
  compile: (src: string, opts: { components: Map<string, ComponentDef>; componentMode: true; depth: number }) => Promise<{ ok: boolean; doc: Doc | null; diagnostics: { severity: string; message: string }[] }>
}

/** Compile `def` with these parameters into a .subckt; returns its model name (and stores the variant on def). */
export async function compileVariant(def: ComponentDef, env: Map<string, Value>, ctx: ComponentContext): Promise<{ model: string } | { error: string }> {
  const model = modelName(def, env)
  if (def.variants[model]) return { model }
  if (ctx.depth > 8) return { error: `${def.name}: components nested more than 8 deep (does it use itself?)` }
  if (!def.pins.length) return { error: `${def.name}: add a  pins …  line (the connections it offers)` }
  // the body as a circuit, with the parameters written in
  const head = `circuit K_${def.name} {\n`
  const text = `${head}${def.body}\n}\n`
  const r = parse(text)
  const circ = r.file.items.find((i): i is Extract<Item, { k: "circuit" }> => i.k === "circuit")
  if (!circ) return { error: `${def.name}: ${r.diagnostics[0]?.message ?? "can't read its body"}` }
  const names = new Set(def.params.map((p) => p.name))
  const edits: { span: Span; text: string }[] = []
  // an argument runs to the next top-level “,” or “)” (an expression's span can stop before its closing parentheses)
  const argEnd = (from: number) => {
    let depth = 0
    for (let i = from; i < text.length; i++) {
      const ch = text[i]
      if (ch === '"') { i = text.indexOf('"', i + 1); if (i < 0) return text.length; continue }
      if (ch === "(" || ch === "[") depth++
      else if (ch === ")" || ch === "]") { if (depth === 0) return i; depth-- }
      else if (ch === "," && depth === 0) return i
      else if (ch === "\n" && depth === 0) return i
    }
    return text.length
  }
  const put = (e: Expr) => { if (refs(e, names)) edits.push({ span: { from: e.span.from, to: Math.max(e.span.to, argEnd(e.span.from)) }, text: literal(evalWith(e, env)) }) }
  try {
    for (const st of circ.body) {
      if (st.k === "pins" || st.k === "symbolbox" || st.k === "describe") { edits.push({ span: st.span, text: "" }); continue }
      if (st.k === "part" && st.call.k === "call") for (const a of st.call.args) put(a.value)
      if (st.k === "conn") for (const end of st.ends) if (end.k === "inline" && end.decl.call.k === "call") for (const a of end.decl.call.args) put(a.value)
      if (st.k === "supply") put(st.value)
    }
  } catch (e) { return { error: `${def.name}: ${e instanceof Error ? e.message : String(e)}` } }
  let filled = text
  for (const ed of edits.sort((a, b) => b.span.from - a.span.from)) filled = filled.slice(0, ed.span.from) + ed.text + filled.slice(ed.span.to)
  const res = await ctx.compile(`${filled}simulate op\n`, { components: ctx.defs, componentMode: true, depth: ctx.depth + 1 })
  const bad = res.diagnostics.find((d) => d.severity === "error")
  if (!res.ok || !res.doc || bad) return { error: `${def.name}: ${bad?.message ?? "its body doesn't compile"}` }
  const net = buildNetlist(res.doc, deriveNetlist(res.doc), "op")
  // the body: element lines; models and nested subcircuits go alongside
  const models: Record<string, string> = {}
  const elements: string[] = []
  const lines = net.text.split("\n").slice(1)
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (/^\.(options|temp|op|tran|ac|dc|end)\b/i.test(l) || !l.trim()) continue
    if (/^\.model\s/i.test(l)) { models[l.split(/\s+/)[1]] = l; continue }
    if (/^\.subckt\s/i.test(l)) { const name = l.split(/\s+/)[1]; const blk = [l]; while (++i < lines.length && !/^\.ends/i.test(lines[i])) blk.push(lines[i]); blk.push(lines[i] ?? ".ends"); models[name] = blk.join("\n"); continue }
    elements.push(l)
  }
  // nested components: their subcircuits too
  for (const p of res.doc.parts) {
    const inner = p.lib.startsWith("kirk:") ? ctx.defs.get(p.value) : undefined
    const v = inner && p.sim?.Name ? inner.variants[p.sim.Name] : undefined
    if (v) Object.assign(models, v.models)
  }
  const nodeOf = (pin: string) => [...net.nodes].find(([, n]) => n === pin)?.[0] ?? (/^(gnd|0)$/i.test(pin) ? "0" : `nc_${pin.toLowerCase()}`)
  models[model] = `.subckt ${model} ${def.pins.map(nodeOf).join(" ")}\n${elements.join("\n")}\n.ends ${model}`
  def.variants[model] = { models, params: Object.fromEntries([...env].map(([k, v]) => [k, v.k === "str" ? JSON.stringify(v.v) : literal(v)])) }
  return { model }
}

/** After an instance's parameters change outside Kirk (the Inspector), compile the variants it needs. */
export async function refreshVariants(doc: Doc, compile: ComponentContext["compile"]): Promise<Doc | null> {
  const defs = new Map((doc.components ?? []).map((d) => [d.name, { ...d, variants: { ...d.variants } }]))
  let changed = false
  const parts: Part[] = []
  for (const p of doc.parts) {
    const def = p.lib.startsWith("kirk:") ? defs.get(p.value) : undefined
    if (!def) { parts.push(p); continue }
    try {
      const env = envFromParams(def, p.sim?.Params)
      const v = await compileVariant(def, env, { defs, depth: 0, compile })
      if ("model" in v && v.model !== p.sim?.Name) { parts.push({ ...p, sim: { ...p.sim, Name: v.model } }); changed = true; continue }
    } catch { /* keep the part; the netlist reports it */ }
    parts.push(p)
  }
  const comps = [...defs.values()]
  if (comps.some((d, i) => Object.keys(d.variants).length !== Object.keys(doc.components![i].variants).length)) changed = true
  return changed ? { ...doc, parts, components: comps } : null
}

// ---------------------------------------------------------------- the box symbol

const PX = 12.7
/** Which side each pin goes on: as written in  symbol box(…), else by name. */
export function pinSides(def: ComponentDef): Record<"left" | "right" | "top" | "bottom", string[]> {
  const out = { left: [] as string[], right: [] as string[], top: [] as string[], bottom: [] as string[] }
  const placed = new Set<string>()
  for (const side of ["left", "right", "top", "bottom"] as const) for (const p of def.sides?.[side] ?? []) if (def.pins.includes(p)) { out[side].push(p); placed.add(p) }
  for (const p of def.pins) {
    if (placed.has(p)) continue
    if (/^(vcc|vdd|v\+|vp|vs|vin\+?|pwr|supply|vbat|bat\+?)$/i.test(p)) out.top.push(p)
    else if (/^(gnd|vss|v-|vn|0|com|ground)$/i.test(p)) out.bottom.push(p)
    else if (/^(out|o|q|y|vout|outp|outn|out\d*|.*out)$/i.test(p)) out.right.push(p)
    else out.left.push(p)
  }
  return out
}

export function componentSymbol(def: ComponentDef): SymbolDef {
  const s = pinSides(def)
  const rows = Math.max(s.left.length, s.right.length, 1), cols = Math.max(s.top.length, s.bottom.length, 1)
  const wGrid = Math.max(6, cols * 2 + 2, Math.ceil(def.name.length * 0.6) + 2), hGrid = Math.max(4, rows * 2 + 2)
  const hw = (wGrid / 2) * PX, hh = (hGrid / 2) * PX
  const kp: KPin[] = []
  let svg = `<rect x="${-hw}" y="${-hh}" width="${2 * hw}" height="${2 * hh}" rx="3" stroke-width="2" fill="var(--canvas-symbol-fill, none)"/>`
  svg += `<text x="0" y="4" font-size="9" text-anchor="middle" fill="currentColor" stroke="none" font-family="ui-sans-serif,system-ui" font-weight="600">${def.name}</text>`
  let n = 0
  for (const side of ["left", "right", "top", "bottom"] as const) {
    const list = s[side]
    list.forEach((name, i) => {
      const along = (i - (list.length - 1) / 2) * 2
      const [gx, gy, a] = side === "top" ? [along, -hGrid / 2 - 1, 270] : side === "bottom" ? [along, hGrid / 2 + 1, 90] : side === "left" ? [-wGrid / 2 - 1, along, 0] : [wGrid / 2 + 1, along, 180]
      kp.push({ n: String(def.pins.indexOf(name) + 1 || ++n), name, x: gx, y: gy, a, t: "passive" })
      const [x0, y0] = [gx * PX, gy * PX]
      const [x1, y1] = side === "top" ? [x0, -hh] : side === "bottom" ? [x0, hh] : side === "left" ? [-hw, y0] : [hw, y0]
      svg += `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" class="kp"/>`
      const [tx, ty, anchor] = side === "top" ? [x0, -hh + 10, "middle"] : side === "bottom" ? [x0, hh - 4, "middle"] : side === "left" ? [-hw + 4, y0 + 3.5, "start"] : [hw - 4, y0 + 3.5, "end"]
      svg += `<text x="${tx}" y="${ty}" font-size="7.5" text-anchor="${anchor}" fill="currentColor" stroke="none" font-family="ui-monospace,monospace">${name}</text>`
    })
  }
  return {
    id: `kirk:${def.name}`, lib: "kirk", name: def.name, bases: [], desc: def.description ?? `Kirk component ${def.name}`, refPrefix: "X", value: def.name, power: false, excludeFromSim: false,
    units: [{ svg, pins: kp, box: [-hw - PX, -hh - PX, 2 * hw + 2 * PX, 2 * hh + 2 * PX] }],
    fields: { Reference: { v: "X", x: hw + 6, y: -hh + 2, j: "left" }, Value: { v: def.name, x: hw + 6, y: -hh + 16, j: "left" } },
  }
}

export const registerComponent = (def: ComponentDef) => registerBuiltin(componentSymbol(def))
