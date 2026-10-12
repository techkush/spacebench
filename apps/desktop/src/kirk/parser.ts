// Kirk parser: tokens → syntax tree. Recursive descent over the grammar in
// spec Appendix A. Error-tolerant: on a syntax error it records a diagnostic
// and skips to the next line, so one typo never blanks the whole schematic.
import type { Annotation, Arg, ComponentParam, Diagnostic, Endpoint, Expr, File, InstrumentLine, Item, LayoutItem, PartDecl, Span, Stmt } from "./ast"

/** parameter types a component may declare (they set the expected unit) */
export const PARAM_TYPES = new Set(["Resistance", "Capacitance", "Inductance", "Voltage", "Current", "Frequency", "Time", "Power", "Ratio", "Number", "Text", "Model", "Temperature"])
import { lex, type Token, type TokKind } from "./lexer"

class ParseError extends Error {
  diag: Diagnostic
  constructor(diag: Diagnostic) { super(diag.message); this.diag = diag }
}

const INSTRUMENTS = new Set(["scope", "meter", "funcgen", "bode", "spectrum", "logger"])

export function parse(src: string): { file: File; diagnostics: Diagnostic[] } {
  const all = lex(src)
  const comments = all.filter((t) => t.kind === "comment").map((t) => ({ text: t.text, span: { from: t.from, to: t.to } }))
  const toks = all.filter((t) => t.kind !== "comment")
  let p = 0
  const diagnostics: Diagnostic[] = []

  const peek = (o = 0): Token => toks[Math.min(p + o, toks.length - 1)]
  const at = (kind: TokKind, text?: string) => peek().kind === kind && (text === undefined || peek().text === text)
  const atWord = (w: string) => peek().kind === "ident" && peek().text === w
  const next = () => toks[p++]
  const skipNl = () => { while (peek().kind === "newline") p++ }
  const fail = (msg: string, t: Token = peek(), help?: string): never => {
    throw new ParseError({ code: "V001", severity: "error", message: msg, span: { from: t.from, to: Math.max(t.to, t.from + 1) }, help })
  }
  const expect = (kind: TokKind, what?: string): Token => {
    if (peek().kind !== kind) fail(`expected ${what ?? `“${kind}”`}, found ${peek().kind === "newline" ? "end of line" : peek().kind === "eof" ? "end of file" : `“${peek().text}”`}`)
    return next()
  }
  const ident = (what = "a name"): string => {
    const t = peek()
    if (t.kind === "ident") { p++; return t.text }
    if (t.kind === "quoted") { p++; return t.unit ?? "" }
    return fail(`expected ${what}, found “${t.text || t.kind}”`)
  }
  const span = (from: number): Span => ({ from, to: toks[Math.max(0, p - 1)].to })
  const recover = () => {
    // skip to the end of the line (or a closing brace) so the next statement can parse
    while (!at("newline") && !at("eof") && !at("}")) p++
  }

  // ---------------------------------------------------------------- expressions
  function expr(): Expr {
    return range()
  }
  function range(): Expr {
    const a = compare()
    if (at("..")) { next(); const b = compare(); return { k: "range", a, b, span: { from: a.span.from, to: b.span.to } } }
    return a
  }
  function compare(): Expr {
    let a = additive()
    while (at("<") || at(">") || at("<=") || at(">=") || at("==") || at("!=") || atWord("in")) {
      const op = next().text
      const b = op === "in" ? range() : additive()
      a = { k: "bin", op, a, b, span: { from: a.span.from, to: b.span.to } }
    }
    return a
  }
  function additive(): Expr {
    let a = term()
    while (at("+") || at("-")) { const op = next().text; const b = term(); a = { k: "bin", op, a, b, span: { from: a.span.from, to: b.span.to } } }
    return a
  }
  function term(): Expr {
    let a = power()
    while (at("*") || at("/")) { const op = next().text; const b = power(); a = { k: "bin", op, a, b, span: { from: a.span.from, to: b.span.to } } }
    return a
  }
  function power(): Expr {
    const a = unary()
    if (at("^")) { next(); const b = power(); return { k: "bin", op: "^", a, b, span: { from: a.span.from, to: b.span.to } } }
    return a
  }
  function unary(): Expr {
    if (at("-")) { const t = next(); const a = unary(); return { k: "neg", a, span: { from: t.from, to: a.span.to } } }
    return postfix()
  }
  function postfix(): Expr {
    let e = primary()
    while (at(".") && (peek(1).kind === "ident" || peek(1).kind === "number" || peek(1).kind === "quoted")) {
      next()
      const t = next()
      e = { k: "member", obj: e, prop: t.kind === "quoted" ? t.unit ?? "" : t.text, span: { from: e.span.from, to: t.to } }
    }
    return e
  }
  function args(): Arg[] {
    const out: Arg[] = []
    expect("(")
    skipNl()
    while (!at(")")) {
      const s = peek().from
      if ((peek().kind === "ident") && peek(1).kind === ":") {
        const name = next().text
        next()
        out.push({ name, value: expr(), span: span(s) })
      } else out.push({ value: expr(), span: span(s) })
      skipNl()
      if (at(",")) { next(); skipNl() } else break
    }
    expect(")", "“)”")
    return out
  }
  function primary(): Expr {
    const t = peek()
    if (t.kind === "number") {
      next()
      let unit = t.unit, text = t.text, value = t.value!, to = t.to
      // "10 uF", "5 V", "1 kHz": a separate unit word right after the number
      if (!unit && peek().kind === "ident") {
        const m = splitUnitWord(peek().text)
        if (m) { const u = next(); unit = m.unit; value *= m.scale; text = `${text} ${u.text}`; to = u.to }
      }
      // "2 V/div", "50 ms/div"
      if (unit && at("/") && peek(1).kind === "ident" && peek(1).text === "div") { next(); const d = next(); unit = `${unit}/div`; text += `/div`; to = d.to }
      return { k: "num", value, unit, text, span: { from: t.from, to } }
    }
    if (t.kind === "string") { next(); return { k: "str", value: t.unit ?? "", span: { from: t.from, to: t.to } } }
    if (t.kind === "quoted") { next(); return { k: "id", name: t.unit ?? "", quoted: true, span: { from: t.from, to: t.to } } }
    if (t.kind === "(") { next(); const e = expr(); expect(")", "“)”"); return e }
    if (t.kind === "[") {
      next(); skipNl()
      const items: Expr[] = []
      while (!at("]")) { items.push(expr()); skipNl(); if (at(",")) { next(); skipNl() } else break }
      expect("]", "“]”")
      return { k: "list", items, span: span(t.from) }
    }
    if (t.kind === "ident") {
      if (t.text === "parts" && peek(1).kind === "(") return selector()
      next()
      if (at("(")) return { k: "call", fn: t.text, args: args(), span: span(t.from) }
      return { k: "id", name: t.text, span: { from: t.from, to: t.to } }
    }
    return fail(`expected a value, found “${t.text || t.kind}”`, t)
  }

  /** parts(R*), parts("U?", lib: "Amplifier_Operational:*"), parts(value: 100n, on: VCC) */
  function selector(): Extract<Expr, { k: "sel" }> {
    const s = next().from
    expect("(")
    skipNl()
    let pattern: string | undefined
    const named = () => peek().kind === "ident" && peek(1).kind === ":"
    if (!at(")") && !named()) {
      if (at("string")) pattern = next().unit ?? ""
      else {
        // a bare pattern: everything up to the comma, as written (R*, C1?, /R[0-9]+/)
        const a = peek().from
        let b = a
        while (!at(",") && !at(")") && !at("newline") && !at("eof")) b = next().to
        pattern = src.slice(a, b)
      }
      skipNl()
      if (at(",")) { next(); skipNl() }
    }
    const filters: Arg[] = []
    while (!at(")")) {
      const fs = peek().from
      if (!named()) fail("expected a filter: value: 10k, lib: \"Device:R\", on: VCC or footprint: \"\"")
      const name = next().text
      next()
      filters.push({ name, value: expr(), span: span(fs) })
      skipNl()
      if (at(",")) { next(); skipNl() } else break
    }
    expect(")", "“)”")
    return { k: "sel", pattern, filters, span: span(s) }
  }

  // ---------------------------------------------------------------- circuit statements
  function annotations(): Annotation[] {
    const out: Annotation[] = []
    while (at("@")) {
      const s = next().from
      const name = ident("an annotation name")
      out.push({ name, args: at("(") ? args() : [], span: span(s) })
      skipNl()
    }
    return out
  }
  function call(): Expr & { k: "call" | "id" } {
    const e = primary()
    if (e.k !== "call" && e.k !== "id") return fail("expected a part, e.g. R(10k) or lib(\"Device:R\")")
    return e
  }
  function endpoint(): Endpoint {
    const s = peek().from
    if (atWord("nc")) { next(); return { k: "nc", span: span(s) } }
    if (atWord("_")) { next(); return { k: "anon", span: span(s) } }
    if (peek().kind !== "ident" && peek().kind !== "quoted") return fail(`expected a net, part or pin, found “${peek().text || peek().kind}”`)
    // inline part creation inside a chain: R1 = R(1k)
    if (peek().kind === "ident" && peek(1).kind === "=") {
      const ref = next().text; next()
      const c = call()
      const decl: PartDecl = { k: "part", ref, call: c, annotations: [], span: span(s) }
      return { k: "inline", decl, span: span(s) }
    }
    // pin or pin list: U1.OUT, U1.RST
    if (peek().kind === "ident" && peek(1).kind === "." ) {
      const pins: { ref: string; pin: string; span: Span }[] = []
      for (;;) {
        const ps = peek().from
        const ref = ident()
        expect(".", "“.”")
        const pt = next()
        if (pt.kind !== "ident" && pt.kind !== "number" && pt.kind !== "quoted" && pt.kind !== "+" && pt.kind !== "-") fail("expected a pin name or number", pt)
        let pin = pt.kind === "quoted" ? pt.unit ?? "" : pt.text
        // pin names like "IN+" / "V-" written as U1.IN+ … only via backticks; numbers keep their text
        if (pt.kind === "number") pin = pt.text
        pins.push({ ref, pin, span: span(ps) })
        if (at(",") && peek(1).kind === "ident" && peek(2).kind === ".") { next(); continue }
        break
      }
      return { k: "pins", pins, span: span(s) }
    }
    const name = ident()
    let reversed = false
    let through: [string, string] | undefined
    if (at("'")) { next(); reversed = true }
    if (at("(") && (peek(2).kind === "→" || peek(2).kind === "->")) {
      next(); const a = ident(); next(); const b = ident(); expect(")"); through = [a, b]
    }
    return { k: "name", name, reversed, through, span: span(s) }
  }
  function stmt(): Stmt {
    const s = peek().from
    const anns = annotations()
    if (atWord("supply")) { next(); const name = ident("a net name"); expect("=", "“=”"); return { k: "supply", name, value: expr(), span: span(s) } }
    if (atWord("ground")) { next(); const names = [ident("a net name")]; while (at(",")) { next(); names.push(ident()) } return { k: "ground", names, span: span(s) } }
    if (atWord("net")) { next(); const names = [ident("a net name")]; while (at(",")) { next(); names.push(ident()) } return { k: "net", names, span: span(s) } }
    if (atWord("param")) { next(); const name = ident(); expect("=", "“=”"); return { k: "param", name, value: expr(), span: span(s) } }
    if (atWord("pins") && peek(1).kind === "ident") { next(); const names = [ident("a pin name")]; while (at(",")) { next(); names.push(ident("a pin name")) } return { k: "pins", names, span: span(s) } }
    if (atWord("description") && peek(1).kind === "string") { next(); return { k: "describe", text: next().unit ?? "", span: span(s) } }
    if (atWord("symbol") && peek(1).kind === "ident" && peek(1).text === "box") {
      next(); next()
      const sides: Partial<Record<"left" | "right" | "top" | "bottom", string[]>> = {}
      for (const a of at("(") ? args() : []) {
        if (!a.name || !["left", "right", "top", "bottom"].includes(a.name)) fail("symbol box takes left:, right:, top:, bottom: lists of pins")
        const v = a.value
        sides[a.name as "left"] = v.k === "list" ? v.items.map((x) => (x.k === "id" ? x.name : "")) : v.k === "id" ? [v.name] : []
      }
      return { k: "symbolbox", sides, span: span(s) }
    }
    if (atWord("for") && peek(1).kind === "ident" && peek(2).kind === "ident" && peek(2).text === "in") {
      next(); const name = next().text; next()
      const values = expr()
      return { k: "for", name, values, body: block(stmt), span: span(s) }
    }
    if (atWord("check") && peek(1).kind !== "=" && peek(1).kind !== "--") {
      next()
      const negate = atWord("not") ? (next(), true) : false
      return { k: "check", negate, expr: expr(), span: span(s) }
    }
    // R1.footprint = "…"  /  R1.`Manufacturer PN` = "…"
    if (peek().kind === "ident" && peek(1).kind === "." && (peek(2).kind === "ident" || peek(2).kind === "quoted") && peek(3).kind === "=") {
      const rt = next(); next()
      const pt = next(); next()
      return { k: "set", target: { k: "ref", ref: rt.text, span: { from: rt.from, to: rt.to } }, prop: pt.kind === "quoted" ? pt.unit ?? "" : pt.text, value: expr(), span: span(s) }
    }
    // parts(R*).footprint = "…"
    if (atWord("parts") && peek(1).kind === "(") {
      const e = postfix()
      if (e.k !== "member" || e.obj.k !== "sel") fail("expected a property after the selection, e.g. parts(R*).footprint = \"Resistor_SMD:R_0603_1608Metric\"")
      const m = e as Extract<Expr, { k: "member" }>
      expect("=", "“=”")
      return { k: "set", target: m.obj as Extract<Expr, { k: "sel" }>, prop: m.prop, value: expr(), span: span(s) }
    }
    if (peek().kind === "ident" && peek(1).kind === "=" ) {
      const ref = next().text; next()
      const c = call()
      const decl: PartDecl = { k: "part", ref, call: c, annotations: anns, span: span(s) }
      if (at("--")) {
        // a declaration that starts a chain: R1 = R(1k) -- out
        const ends: Endpoint[] = [{ k: "inline", decl, span: decl.span }]
        while (at("--")) { next(); skipNl(); ends.push(endpoint()) }
        return { k: "conn", ends, span: span(s) }
      }
      return decl
    }
    const ends: Endpoint[] = [endpoint()]
    if (!at("--")) fail(`expected “--” to connect ${ends[0].k === "name" ? `“${ends[0].name}”` : "it"}`, peek(), "a connection looks like  A -- R1 -- B  or  U1.OUT -- OUT")
    while (at("--")) { next(); skipNl(); ends.push(endpoint()) }
    return { k: "conn", ends, span: span(s) }
  }
  function block<T>(one: () => T): T[] {
    expect("{", "“{”")
    const out: T[] = []
    for (;;) {
      skipNl()
      if (at("}")) { next(); break }
      if (at("eof")) fail("missing “}”")
      try {
        out.push(one())
        if (!at("newline") && !at("}") && !at("eof")) fail(`unexpected “${peek().text}” after the statement`)
      } catch (e) {
        if (!(e instanceof ParseError)) throw e
        diagnostics.push(e.diag)
        recover()
      }
    }
    return out
  }

  // ---------------------------------------------------------------- layout block
  function num(): number {
    const neg = at("-") ? (next(), -1) : 1
    const t = expect("number", "a number")
    return neg * parseFloat(t.text)
  }
  function point(): [number, number] {
    expect("(", "“(”"); const x = num(); expect(",", "“,”"); const y = num(); expect(")", "“)”")
    return [x, y]
  }
  function transformTail() {
    let rot = 0, mirror = false
    for (;;) {
      if (atWord("rot")) { next(); rot = num() }
      else if (atWord("mirror")) { next(); mirror = true }
      else break
    }
    return { rot, mirror }
  }
  function layoutItem(): LayoutItem {
    const s = peek().from
    if (atWord("wire")) {
      next()
      const points: [number, number][] = []
      if (at("[")) next()
      while (at("(")) { points.push(point()); if (at(",")) next() }
      if (at("]")) next()
      return { k: "wire", points, span: span(s) }
    }
    if (atWord("label")) { next(); const net = ident("a net name"); expectWord("at"); const [x, y] = point(); const { rot } = transformTail(); return { k: "label", net, x, y, rot, span: span(s) } }
    if (atWord("power")) {
      next(); const name = ident("a power net"); let lib = `power:${name}`
      if (at("string")) lib = next().unit ?? lib
      expectWord("at"); const [x, y] = point(); const { rot } = transformTail()
      return { k: "power", name, lib, x, y, rot, span: span(s) }
    }
    if (atWord("nc")) { next(); expectWord("at"); const [x, y] = point(); return { k: "nc", x, y, span: span(s) } }
    const target = ident("a part reference")
    let unit: string | undefined
    if (atWord("unit")) { next(); unit = ident("a unit letter") }
    expectWord("at")
    const [x, y] = point()
    const { rot, mirror } = transformTail()
    return { k: "at", target, unit, x, y, rot, mirror, span: span(s) }
  }
  function expectWord(w: string) { if (!atWord(w)) fail(`expected “${w}”`); next() }

  // ---------------------------------------------------------------- top level
  function instrument(kind: string, s: number): Item {
    const name = ident(`a ${kind} name`)
    let target: string | undefined
    if (at("->")) { next(); target = ident("a net name") }
    if (at("=")) { next(); return { k: "instrument", kind, name, target, value: expr(), lines: [], span: span(s) } }
    const lines: InstrumentLine[] = []
    const line = (): InstrumentLine => {
      const ls = peek().from
      const key = ident("an instrument setting")
      const a: Expr[] = []
      if (at("=")) next()
      while (!at("newline") && !at("}") && !at("eof") && !at(";")) {
        if (peek().kind === "ident" && !["V", "I"].includes(peek().text) && peek(1).kind !== "(" && a.length > 0) {
          // "ch1 = V(OUT) scale 2 V/div" → extra keyword pair
          const k2 = next().text
          a.push({ k: "id", name: k2, span: span(ls) })
          continue
        }
        a.push(expr())
        if (at(",")) next()
      }
      return { key, args: a, span: span(ls) }
    }
    if (at("{")) {
      expect("{")
      for (;;) {
        skipNl()
        if (at("}")) { next(); break }
        if (at("eof")) fail("missing “}”")
        try { lines.push(line()); while (at(";")) next() } catch (e) { if (!(e instanceof ParseError)) throw e; diagnostics.push(e.diag); recover() }
      }
    } else {
      while (!at("newline") && !at("eof")) lines.push(line())
    }
    return { k: "instrument", kind, name, target, lines, span: span(s) }
  }
  function item(): Item {
    const s = peek().from
    const anns = annotations()
    const w = peek().kind === "ident" ? peek().text : ""
    switch (w) {
      case "import": { next(); const library = atWord("library") ? (next(), true) : false; const t = expect("string", "a quoted path"); return { k: "import", path: t.unit ?? "", library, span: span(s) } }
      case "use": { next(); let path = ident(); while (at(".")) { next(); path += `.${ident()}` } return { k: "use", path, span: span(s) } }
      case "circuit": { next(); const name = ident("a circuit name"); const body = block(stmt); return { k: "circuit", name, body, annotations: anns, span: span(s) } }
      case "component": {
        next()
        const name = ident("a component name")
        const params: ComponentParam[] = []
        if (at("(")) {
          next()
          skipNl()
          while (!at(")")) {
            const ps = peek().from
            const pname = ident("a parameter name")
            let type: string | undefined, def: Expr | undefined
            if (at(":")) {
              next()
              // `r: Resistance = 1k` (a type) or `r: 1k` (a default)
              if (peek().kind === "ident" && PARAM_TYPES.has(peek().text) && (peek(1).kind === "=" || peek(1).kind === "," || peek(1).kind === ")")) type = next().text
              else def = expr()
            }
            if (at("=")) { next(); def = expr() }
            params.push({ name: pname, type, def, span: span(ps) })
            skipNl()
            if (at(",")) next()
            else if (!at(")")) fail("expected “,” or “)” in the parameter list")
            skipNl()
          }
          expect(")", "“)”")
        }
        const open = peek()
        const body = block(stmt)
        const close = toks[p - 1]
        return { k: "component", name, params, body, bodySpan: { from: open.to, to: close.from }, annotations: anns, span: span(s) }
      }
      case "library": {
        next()
        const name = ident("a library name")
        let version: string | undefined
        if (atWord("version")) { next(); version = expect("string", "a quoted version, e.g. \"1.0.0\"").unit }
        return { k: "library", name, version, span: span(s) }
      }
      case "param": { next(); const name = ident(); expect("=", "“=”"); return { k: "param", name, value: expr(), span: span(s) } }
      case "simulate": {
        next()
        let name: string | undefined
        if (peek(1).kind === "=") { name = ident(); next() }
        const analysis = ident("an analysis (op, tran, ac, dc)")
        return { k: "simulate", name, analysis, args: at("(") ? args() : [], span: span(s) }
      }
      case "measure": { next(); const name = ident("a measurement name"); expect("=", "“=”"); return { k: "measure", name, expr: expr(), span: span(s) } }
      case "assert": {
        next(); const e = expr(); let severity: string | undefined
        if (atWord("severity")) { next(); expect(":"); severity = ident() }
        return { k: "assert", expr: e, severity, span: span(s) }
      }
      case "sweep": {
        next(); const target = postfix(); expectWord("in"); const values = expr()
        let spacing: { mode: "lin" | "log"; points: Expr } | undefined
        if (atWord("lin") || atWord("log")) { const mode = next().text as "lin" | "log"; const points = primary(); expectWord("points"); spacing = { mode, points } }
        return { k: "sweep", target, values, spacing, span: span(s) }
      }
      case "montecarlo": {
        next(); const runs = num(); expectWord("runs")
        let seed: number | undefined
        if (atWord("seed")) { next(); seed = num() }
        const tolerances = at("{") ? block(() => { expectWord("tolerance"); const glob = next().text + (at("*") ? next().text : ""); return { glob, value: expr() } }) : []
        return { k: "montecarlo", runs, seed, tolerances, span: span(s) }
      }
      case "temp": { next(); expectWord("in"); return { k: "temp", values: expr(), span: span(s) } }
      case "layout": { next(); return { k: "layout", items: block(layoutItem), span: span(s) } }
      case "stimulus": {
        next()
        let seed: Expr | undefined
        const feeds: { target: string; value: Expr; span: Span }[] = []
        block(() => {
          const ls = peek().from
          if (atWord("seed") && peek(1).kind === ":") { next(); next(); seed = expr(); return null }
          let target = ident("an input (V1, TH1, RV1, room.temp …)")
          if (at(".")) { next(); target += `.${ident("a property")}` }
          expect("=", "“=”")
          feeds.push({ target, value: expr(), span: span(ls) })
          return null
        })
        return { k: "stimulus", seed, feeds, span: span(s) }
      }
      case "environment": {
        next()
        const entries = block(() => { const ks = peek().from; const key = ident("a room property (light, temp, sound, tone)"); expect(":", "“:”"); return { key, value: expr(), span: span(ks) } })
        return { k: "environment", entries, span: span(s) }
      }
      default:
        if (INSTRUMENTS.has(w)) { next(); return instrument(w, s) }
        return fail(w ? `unknown statement “${w}”` : `unexpected “${peek().text}”`, peek(), "top-level statements: circuit, component, library, import, simulate, measure, assert, scope, meter, sweep, stimulus, layout …")
    }
  }

  const items: Item[] = []
  for (;;) {
    skipNl()
    if (at("eof")) break
    const before = p
    try {
      items.push(item())
      if (!at("newline") && !at("eof")) fail(`unexpected “${peek().text}” after the statement`)
    } catch (e) {
      if (!(e instanceof ParseError)) throw e
      diagnostics.push(e.diag)
      recover()
      if (p === before) p++
    }
  }
  return { file: { items, comments }, diagnostics }
}

function splitUnitWord(w: string): { scale: number; unit: string } | null {
  const PREFIX: Record<string, number> = { f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, "µ": 1e-6, m: 1e-3, k: 1e3, M: 1e6, Meg: 1e6, G: 1e9, T: 1e12 }
  const UNITS = ["Vpp", "V", "A", "Ω", "ohm", "F", "H", "Hz", "s", "W", "°C", "%", "ppm", "dB", "deg", "rad", "lux", "lx", "Pa", "cm", "mm", "N", "g", "T"]
  for (const u of UNITS) {
    if (!w.endsWith(u)) continue
    const pre = w.slice(0, w.length - u.length)
    if (pre === "") return { scale: 1, unit: u }
    if (pre in PREFIX) return { scale: PREFIX[pre], unit: u }
  }
  return null
}
