// Kirk's scripting statements (the ideas of kicad-skip, as language):
//   for i in 1..8 { R{i} = R(1k) … }          generate parts and wiring
//   R1.footprint = "…"   parts(R*).MPN = "…"   set properties of one part or a selection
//   check connected(U1.OUT, R3.1)              design rules, checked on every compile
// A selection is parts(pattern, value:, lib:, on:, footprint:) — the pattern is a glob over
// references (R*, U?, C1*) or a /regex/.
import { parseValue } from "@/lib/spice"
import type { Diagnostic, Expr, Span, Stmt } from "./ast"
import { evalNum, siText } from "./kinds"

type Diag = (d: Omit<Diagnostic, "severity"> & { severity?: Diagnostic["severity"] }) => void

// ---------------------------------------------------------------- for loops

/** Integer arithmetic in a name template: i, i+1, 2*i-1, i*j. */
function evalIndex(text: string, env: Map<string, number>): number | null {
  const toks = text.match(/[A-Za-z_]\w*|\d+|[+\-*]/g)
  if (!toks || toks.join("") !== text) return null
  let k = 0
  const atom = (): number | null => {
    const t = toks[k++]
    if (t === "-") { const v = atom(); return v === null ? null : -v }
    if (t === undefined) return null
    if (/^\d+$/.test(t)) return Number(t)
    return env.has(t) ? env.get(t)! : null
  }
  const term = (): number | null => {
    let v = atom()
    while (v !== null && toks[k] === "*") { k++; const b = atom(); v = b === null ? null : v * b }
    return v
  }
  let v = term()
  while (v !== null && (toks[k] === "+" || toks[k] === "-")) { const op = toks[k++]; const b = term(); v = b === null ? null : op === "+" ? v + b : v - b }
  return k === toks.length ? v : null
}

/** R{i} → R3; templates whose variables aren't bound (an inner loop's) are left as they are. */
function fill(name: string, env: Map<string, number>): string {
  return name.replace(/\{([A-Za-z0-9_+\-*]+)\}/g, (m, e: string) => { const v = evalIndex(e, env); return v === null ? m : String(v) })
}

/** A copy of a statement with every name template filled (string literals stay as written). */
function subst<T>(node: T, env: Map<string, number>): T {
  if (Array.isArray(node)) return node.map((x) => subst(x, env)) as T
  if (!node || typeof node !== "object") return node
  const o = node as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) {
    if (k === "span") out[k] = v
    else if (typeof v === "string" && o.k !== "str" && o.k !== "num") out[k] = fill(v, env)
    else out[k] = subst(v, env)
  }
  return out as T
}

/** The values a loop runs over: 1..8 (integers, both ends included) or a list [1, 2, 5]. */
function loopValues(e: Expr, diag: Diag): number[] {
  if (e.k === "range") {
    const a = evalNum(e.a), b = evalNum(e.b)
    if (!a || !b || !Number.isInteger(a.value) || !Number.isInteger(b.value)) { diag({ code: "V501", message: "a for loop runs over whole numbers, e.g. 1..8", span: e.span }); return [] }
    const n = Math.abs(b.value - a.value) + 1
    if (n > 1000) { diag({ code: "V501", message: `${n} iterations is too many (at most 1000)`, span: e.span }); return [] }
    const d = b.value >= a.value ? 1 : -1
    return Array.from({ length: n }, (_, i) => a.value + i * d)
  }
  if (e.k === "list") {
    const vs = e.items.map((x) => evalNum(x)?.value)
    if (vs.some((v) => v === undefined || !Number.isInteger(v))) { diag({ code: "V501", message: "a for loop's list holds whole numbers, e.g. [1, 2, 5]", span: e.span }); return [] }
    return vs as number[]
  }
  diag({ code: "V501", message: "a for loop runs over a range (1..8) or a list ([1, 2, 5])", span: e.span })
  return []
}

/** The circuit body with every for loop unrolled (nested loops too). */
export function expandFor(body: Stmt[], diag: Diag, env = new Map<string, number>()): Stmt[] {
  const out: Stmt[] = []
  for (const s of body) {
    if (s.k !== "for") { out.push(env.size ? subst(s, env) : s); continue }
    for (const v of loopValues(s.values, diag)) {
      const inner = new Map(env).set(s.name, v)
      out.push(...expandFor(s.body, diag, inner))
    }
  }
  return out
}

/** A name a loop should have filled but didn't (an unknown variable in R{x}). */
export const unfilled = (name: string) => /\{[^}]*\}/.test(name)

// ---------------------------------------------------------------- selections

/** What a selection or a check needs to know about a part. */
export interface SelPart {
  ref: string
  lib: string
  value: string
  footprint?: string
  fields: Record<string, string>
  exclude: boolean
  /** pin number → net name */
  nets: Map<string, string>
}

function patternRe(p: string): RegExp {
  const m = /^\/(.*)\/([i]*)$/.exec(p)
  if (m) return new RegExp(`^(?:${m[1]})$`, m[2])
  return new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`)
}
const globRe = (p: string) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i")

/** Same value? 10k = 10000 = "10K"; text compares as a glob. */
function sameValue(text: string, want: Expr): boolean {
  if (want.k === "str") return globRe(want.value).test(text)
  const w = evalNum(want)
  if (w) {
    const v = parseValue(text)
    return v !== null && Math.abs(v - w.value) <= Math.abs(w.value) * 1e-9 + 1e-18
  }
  if (want.k === "id") return text.toLowerCase() === want.name.toLowerCase()
  return false
}

/** The parts a selection picks, in declaration order. */
export function select(sel: Extract<Expr, { k: "sel" }>, parts: SelPart[], diag: Diag): SelPart[] {
  let re: RegExp | null = null
  if (sel.pattern !== undefined) {
    try { re = patternRe(sel.pattern) } catch { diag({ code: "V502", message: `“${sel.pattern}” isn't a valid pattern`, span: sel.span }); return [] }
  }
  const tests: ((p: SelPart) => boolean)[] = []
  for (const f of sel.filters) {
    const v = f.value
    const text = v.k === "str" ? v.value : v.k === "id" ? v.name : null
    switch (f.name) {
      case "value": tests.push((p) => sameValue(p.value, v)); break
      case "lib": if (text !== null) { const g = globRe(text); tests.push((p) => g.test(p.lib)) } break
      case "footprint": if (text !== null) { const g = globRe(text); tests.push((p) => g.test(p.footprint ?? "")) } break
      case "on": if (text !== null) tests.push((p) => [...p.nets.values()].some((n) => n.toLowerCase() === text.toLowerCase())); break
      default: {
        // any other property: parts(R*, MPN: "") → the ones without an MPN
        const field = f.name ?? ""
        if (text !== null) { const g = globRe(text); tests.push((p) => g.test(p.fields[FIELD[field.toLowerCase()] ?? field] ?? "")) }
        else diag({ code: "V502", message: `filter ${f.name}: expects a value or "text"`, span: f.span })
      }
    }
  }
  return parts.filter((p) => (!re || re.test(p.ref)) && tests.every((t) => t(p)))
}

// ---------------------------------------------------------------- setting properties

/** What a set statement changes: the part's value, footprint, simulation flag or a field. */
export type PropChange = { ref: string; prop: "value" | "footprint" | "exclude" | "field"; field?: string; text: string }

/** Text for a property from its expression: 10k, "Resistor_SMD:R_0603", 1 % … */
function propText(prop: string, e: Expr, diag: Diag, span: Span): string | null {
  if (e.k === "str") return e.value
  if (e.k === "id") return e.name
  const v = evalNum(e)
  if (!v) { diag({ code: "V503", message: `${prop}: expects a value or "text"`, span }); return null }
  if (/^(tol|tolerance)$/i.test(prop)) return String(v.unit === "%" ? v.value : v.value * 100)
  return siText(v.value)
}

const FIELD: Record<string, string> = { tol: "Tolerance", tolerance: "Tolerance", power: "Power", voltage: "Voltage", mpn: "MPN", datasheet: "Datasheet", manufacturer: "Manufacturer", description: "Description" }

/** The changes the set statements make, in order (later ones win). */
export function propertyChanges(stmts: Stmt[], parts: SelPart[], diag: Diag): PropChange[] {
  const out: PropChange[] = []
  const byRef = new Map(parts.map((p) => [p.ref, p]))
  for (const s of stmts) {
    if (s.k !== "set") continue
    const targets = s.target.k === "ref" ? (byRef.has(s.target.ref) ? [byRef.get(s.target.ref)!] : []) : select(s.target, parts, diag)
    if (s.target.k === "ref" && !targets.length) { diag({ code: "V204", message: `unknown part “${s.target.ref}”`, span: s.target.span }); continue }
    if (!targets.length && s.target.k === "sel") { diag({ severity: "warning", code: "V504", message: `parts(${s.target.pattern ?? ""}${s.target.filters.length ? "…" : ""}) selects no part`, span: s.target.span }); continue }
    const text = propText(s.prop, s.value, diag, s.value.span)
    if (text === null) continue
    const key = s.prop.toLowerCase()
    for (const p of targets) {
      if (key === "value") { out.push({ ref: p.ref, prop: "value", text }); p.value = text }
      else if (key === "footprint") { out.push({ ref: p.ref, prop: "footprint", text }); p.footprint = text }
      else if (key === "nosim" || key === "exclude") { const on = /^(1|true|yes|on)$/i.test(text); out.push({ ref: p.ref, prop: "exclude", text: on ? "1" : "" }); p.exclude = on }
      else { const field = FIELD[key] ?? s.prop; out.push({ ref: p.ref, prop: "field", field, text }); p.fields[field] = text }
    }
  }
  return out
}

// ---------------------------------------------------------------- checks

export interface CheckCtx {
  parts: SelPart[]
  /** net names (as the code writes them) */
  nets: Set<string>
  /** a pin by number or name → its number, or an error */
  pin: (ref: string, text: string) => { n: string } | { error: string }
}

const propOf = (p: SelPart, prop: string): string => {
  const k = prop.toLowerCase()
  if (k === "value") return p.value
  if (k === "footprint") return p.footprint ?? ""
  if (k === "lib") return p.lib
  return p.fields[FIELD[k] ?? prop] ?? ""
}

/** The nets an argument of connected() is on: a pin (U1.OUT) → its net, a part → all its nets, a net → itself. */
function netsOf(e: Expr, c: CheckCtx): { nets: Set<string>; what: string } | { error: string } {
  if (e.k === "member" && e.obj.k === "id") {
    const ref = e.obj.name
    const part = c.parts.find((p) => p.ref === ref)
    if (!part) return { error: `unknown part “${ref}”` }
    const r = c.pin(part.ref, e.prop)
    if ("error" in r) return { error: `${part.ref}: ${r.error}` }
    const n = part.nets.get(r.n)
    return { nets: new Set(n ? [n] : []), what: `${part.ref}.${e.prop}` }
  }
  if (e.k === "id") {
    const part = c.parts.find((p) => p.ref === e.name)
    if (part) return { nets: new Set(part.nets.values()), what: part.ref }
    const net = [...c.nets].find((n) => n.toLowerCase() === e.name.toLowerCase())
    if (net) return { nets: new Set([net]), what: net }
    return { error: `“${e.name}” is not a part or a net` }
  }
  return { error: "connected() takes pins (U1.OUT), parts (R1) or nets (VCC)" }
}

/** Run one check: null when it holds, else why it doesn't. */
export function runCheck(s: Extract<Stmt, { k: "check" }>, c: CheckCtx, diag: Diag): string | null {
  const e = s.expr
  const result = (ok: boolean, why: string): string | null => (ok !== s.negate ? null : s.negate ? `expected not: ${why.replace(/^not /, "")}` : why)
  // connected(a, b, …): all on one net
  if (e.k === "call" && e.fn === "connected") {
    if (e.args.length < 2) { diag({ code: "V511", message: "connected() needs two or more pins, parts or nets", span: e.span }); return null }
    const sets: { nets: Set<string>; what: string }[] = []
    for (const a of e.args) {
      const r = netsOf(a.value, c)
      if ("error" in r) { diag({ code: "V511", message: r.error, span: a.value.span }); return null }
      sets.push(r)
    }
    const common = [...sets[0].nets].filter((n) => sets.every((x) => x.nets.has(n)))
    return result(common.length > 0, `${sets.map((x) => x.what).join(", ")} are not connected (${sets.map((x) => `${x.what}: ${[...x.nets].join("/") || "open"}`).join(", ")})`)
  }
  // parts(…).count <op> n
  const cmp = (a: number, op: string, b: number) => (op === "==" ? a === b : op === "!=" ? a !== b : op === "<" ? a < b : op === ">" ? a > b : op === "<=" ? a <= b : op === ">=" ? a >= b : false)
  if (e.k === "bin" && e.a.k === "member" && e.a.obj.k === "sel") {
    const sel = select(e.a.obj, c.parts, diag)
    const prop = e.a.prop
    if (prop === "count") {
      const n = evalNum(e.b)
      if (!n) { diag({ code: "V511", message: "compare the count with a number", span: e.b.span }); return null }
      return result(cmp(sel.length, e.op, n.value), `${sel.length} parts selected, expected ${e.op} ${n.value}`)
    }
    // parts(…).prop == value  /  != value: every selected part
    if (e.op === "==" || e.op === "!=") {
      const bad = sel.filter((p) => sameValue(propOf(p, prop), e.b) !== (e.op === "=="))
      return result(!bad.length, `${prop} ${e.op === "==" ? "differs" : "matches"} on ${bad.map((p) => `${p.ref} (${propOf(p, prop) || "empty"})`).join(", ")}`)
    }
  }
  // parts(…).prop: every selected part has it
  if (e.k === "member" && e.obj.k === "sel") {
    const sel = select(e.obj, c.parts, diag)
    if (e.prop === "count") return result(sel.length > 0, "no part selected")
    const bad = sel.filter((p) => !propOf(p, e.prop))
    return result(!bad.length, `no ${e.prop} on ${bad.map((p) => p.ref).join(", ")}`)
  }
  diag({ code: "V511", message: "a check is connected(…), parts(…).property, parts(…).property == value or parts(…).count == n", span: e.span })
  return null
}
