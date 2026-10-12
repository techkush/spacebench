// Kirk → circuit IR → schematic Doc (spec §8, §9.1).
// Connectivity always comes from the code. Geometry comes from the `layout`
// block (or the previous drawing); wherever the drawing no longer matches the
// code's nets, those wires are dropped and the pins get short net-label stubs,
// so the schematic is always electrically identical to the code.
import { defaultPart, emptyDoc, isLabel, isPower, placedPins, transform, uid, unitOf, type Doc, type Measure, type Part, type Pt, type Rot, type SimSetup, type Wire } from "@/editor/model"
import { deriveNetlist, isGroundName } from "@/editor/netlist"
import { ensureSymbols, getSymbol, loadIndex, unitLetter, type IndexRow, type KPin, type SymbolDef } from "@/lib/kicad"
import type { Diagnostic, Endpoint, Expr, File, Item, LayoutItem, PartDecl, Span, Stmt } from "./ast"
import { candidateLibs, evalNum, resolveConstructor, siText, type PartSpec } from "./kinds"
import { parse } from "./parser"
import { autoLayout } from "./autolayout"
import { compileVariant, componentsOf, evalWith, instanceEnv, ParamError, paramsText, registerComponent, type ComponentDef, type Value } from "./components"
import { resolveFeeds } from "@/lib/feeds"
import { expandFor, propertyChanges, runCheck, unfilled, type SelPart } from "./select"
import type { Stimulus } from "@/lib/stimulus"

export interface IRPart { ref: string; spec: PartSpec; span: Span; exclude: boolean }
export interface IRNet { name: string; ground: boolean; generated: boolean; pins: { ref: string; n: string }[] }
export interface IR {
  name: string
  title?: string
  description?: string
  parts: IRPart[]
  nets: IRNet[]
  noConnects: { ref: string; n: string }[]
}

export interface CompileResult {
  ok: boolean
  diagnostics: Diagnostic[]
  ir: IR | null
  doc: Doc | null
  file: File
}

const strArg = (e: Expr | undefined) => (e?.k === "str" ? e.value : undefined)

class UF {
  private p = new Map<string, string>()
  find(a: string): string {
    if (!this.p.has(a)) this.p.set(a, a)
    let r = a
    while (this.p.get(r) !== r) r = this.p.get(r)!
    this.p.set(a, r)
    return r
  }
  union(a: string, b: string) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p.set(rb, ra) }
  keys() { return [...this.p.keys()] }
}

/** Find a pin of a symbol by number or name (any unit). */
function findPin(sym: SymbolDef, text: string): { pin: KPin; unit: number } | { error: string } {
  const all = sym.units.flatMap((u, i) => u.pins.map((pin) => ({ pin, unit: i + 1 })))
  const byNum = all.filter((x) => x.pin.n === text)
  if (byNum.length) return byNum[0]
  const clean = (s: string) => s.replace(/~\{([^}]*)\}/g, "$1").toLowerCase()
  const byName = all.filter((x) => clean(x.pin.name) === text.toLowerCase())
  if (byName.length === 1) return byName[0]
  if (byName.length > 1) return { error: `pin name “${text}” is used by ${byName.length} pins (${byName.map((x) => x.pin.n).join(", ")}) — use the pin number` }
  const names = [...new Set(all.map((x) => clean(x.pin.name) || x.pin.n))].slice(0, 12).join(", ")
  return { error: `${sym.name} has no pin “${text}” (pins: ${names})` }
}

export interface CompileOptions {
  /** components already known (a component's body compiles with its file's components) */
  components?: Map<string, ComponentDef>
  /** compiling a component body: pins are open nets, no ground needed, no drawing */
  componentMode?: boolean
  depth?: number
  /** read an imported file: a project path ("lib/filters.kirk") or a user library ("Filters") */
  resolve?: (path: string, library: boolean) => Promise<{ text: string; path: string } | null>
}

/** Read the components of imported files (and their imports), once each. */
async function importComponents(file: File, opts: CompileOptions, diag: (d: Omit<Diagnostic, "severity"> & { severity?: Diagnostic["severity"] }) => void, into: Map<string, ComponentDef>, seen = new Set<string>()) {
  for (const it of file.items) {
    if (it.k !== "import") continue
    const key = `${it.library ? "lib:" : ""}${it.path}`
    if (seen.has(key)) continue
    seen.add(key)
    const got = opts.resolve ? await opts.resolve(it.path, it.library).catch(() => null) : null
    if (!got) { diag({ severity: "error", code: "V401", message: it.library ? `no library “${it.path}” — create it in Libraries, or check the name` : `can't find “${it.path}” in this project`, span: it.span }); continue }
    const r = parse(got.text)
    for (const d of r.diagnostics) diag({ severity: "error", code: "V402", message: `${got.path}: ${d.message}`, span: it.span })
    await importComponents(r.file, opts, diag, into, seen)
    for (const c of componentsOf(r.file, got.text, it.library ? `library:${it.path}` : got.path)) into.set(c.name, c)
  }
}

export async function compileKirk(src: string, prev?: Doc | null, opts: CompileOptions = {}): Promise<CompileResult> {
  const { file, diagnostics } = parse(src)
  const diag = (d: Omit<Diagnostic, "severity"> & { severity?: Diagnostic["severity"] }) => diagnostics.push({ severity: "error", ...d })
  // ---- components: inherited, imported, then this file's own
  const defs = new Map<string, ComponentDef>(opts.components ?? [])
  await importComponents(file, opts, diag, defs)
  for (const c of componentsOf(file, src)) {
    const old = prev?.components?.find((x) => x.name === c.name && x.source === c.source)
    defs.set(c.name, old ? { ...c, variants: old.variants } : c)
  }
  for (const c of defs.values()) registerComponent(c)
  const circuit = file.items.find((i): i is Extract<Item, { k: "circuit" }> => i.k === "circuit")
  if (!circuit) {
    // a library: check each component compiles with its default parameters
    const own = componentsOf(file, src)
    if (own.length) {
      for (const c of own) {
        const item = file.items.find((i) => i.k === "component" && i.name === c.name)!
        if (c.params.some((p) => p.def === undefined)) continue
        try {
          const v = await compileVariant(defs.get(c.name)!, instanceEnv(defs.get(c.name)!, new Map()), { defs, depth: (opts.depth ?? 0) + 1, compile: (s, o) => compileKirk(s, null, { ...opts, ...o }) })
          if ("error" in v) diag({ code: "V403", message: v.error, span: item.span })
        } catch (e) { diag({ code: "V403", message: `${c.name}: ${e instanceof Error ? e.message : String(e)}`, span: item.span }) }
      }
      return { ok: !diagnostics.some((d) => d.severity === "error"), diagnostics, ir: null, doc: null, file }
    }
    if (!diagnostics.length) diag({ code: "V002", message: "no circuit — write  circuit Name { … }  (or  component Name { … }  for a library)", span: { from: 0, to: Math.min(1, src.length) } })
    return { ok: false, diagnostics, ir: null, doc: null, file }
  }

  // ---- for loops unrolled: the rest of the compiler sees plain statements
  const body = expandFor(circuit.body, diag)
  // ---- collect part declarations (statements and inline in chains)
  const decls: PartDecl[] = []
  const supplies: Extract<Stmt, { k: "supply" }>[] = []
  const grounds: string[] = []
  for (const s of body) {
    if (s.k === "part") decls.push(s)
    if (s.k === "conn") { for (const e of s.ends) if (e.k === "inline") decls.push(e.decl) }
    if (s.k === "supply") supplies.push(s)
    if (s.k === "ground") grounds.push(...s.names)
  }
  const groundName = grounds[0] ?? "GND"

  // ---- load symbols the parts may need
  let index: IndexRow[] | null = null
  try { index = await loadIndex() } catch { index = null }
  const have = (id: string) => !index || index.some((r) => `${r.lib}:${r.name}` === id)
  const wanted = new Set<string>(["Simulation_SPICE:VDC", "power:GND", "power:VCC", "@:label"])
  for (const d of decls) for (const id of candidateLibs(d.call)) if (have(id)) wanted.add(id)
  const layout = file.items.find((i): i is Extract<Item, { k: "layout" }> => i.k === "layout")
  for (const it of layout?.items ?? []) if (it.k === "power") wanted.add(it.lib)
  for (const id of wanted) { try { await ensureSymbols([id]) } catch { /* reported below */ } }
  // bare-name constructors found through the index (U1 = LM393)
  for (const d of decls) {
    const name = d.call.k === "id" ? d.call.name : d.call.fn
    const row = index?.find((r) => r.name === name)
    if (row) { try { await ensureSymbols([`${row.lib}:${row.name}`]) } catch { /* ignore */ } }
  }

  // ---- resolve parts
  const parts: IRPart[] = []
  const byRef = new Map<string, IRPart>()
  for (const d of decls) {
    if (unfilled(d.ref)) { diag({ code: "V505", message: `${d.ref}: the name uses a variable no for loop defines`, span: d.span }); continue }
    if (byRef.has(d.ref)) { diag({ code: "V203", message: `${d.ref} is declared twice`, span: d.span }); continue }
    // an instance of a Kirk component: compile its parameter set into a subcircuit
    const cdef = defs.get(d.call.k === "call" ? d.call.fn : d.call.name)
    if (cdef) {
      try {
        const given = new Map<string, Value>()
        const args = d.call.k === "call" ? d.call.args : []
        args.forEach((a, i) => {
          const name = a.name ?? cdef.params[i]?.name
          if (!name || !cdef.params.some((p) => p.name === name)) throw new ParamError(`${cdef.name} has no parameter “${a.name ?? `#${i + 1}`}” (parameters: ${cdef.params.map((p) => p.name).join(", ") || "none"})`)
          given.set(name, evalWith(a.value, new Map()))
        })
        const env = instanceEnv(cdef, given)
        const v = await compileVariant(cdef, env, { defs, depth: (opts.depth ?? 0) + 1, compile: (s, o) => compileKirk(s, null, { ...opts, ...o }) })
        if ("error" in v) { diag({ code: "V403", message: v.error, span: d.span }); continue }
        const spec: PartSpec = { lib: `kirk:${cdef.name}`, value: cdef.name, sim: { Device: "SUBCKT", Name: v.model, Pins: cdef.pins.map((p, i) => `${i + 1}=${p}`).join(" "), Params: paramsText(env) } }
        const p: IRPart = { ref: d.ref, spec, span: d.span, exclude: d.annotations.some((a) => a.name === "nosim") }
        parts.push(p); byRef.set(d.ref, p)
      } catch (e) { diag({ code: "V404", message: e instanceof Error ? e.message : String(e), span: d.call.span }) }
      continue
    }
    const spec = resolveConstructor({ diag, index }, d.call)
    if (!spec) continue
    if (!getSymbol(spec.lib)) { try { await ensureSymbols([spec.lib]) } catch { /* ignore */ } }
    if (!getSymbol(spec.lib)) { diag({ code: "V202", message: `symbol ${spec.lib} could not be loaded`, span: d.call.span }); continue }
    const p: IRPart = { ref: d.ref, spec, span: d.span, exclude: d.annotations.some((a) => a.name === "nosim") }
    parts.push(p); byRef.set(d.ref, p)
  }
  for (const s of supplies) {
    const v = evalNum(s.value)
    const ref = `V_${s.name.replace(/[^\w]/g, "_")}`
    if (byRef.has(ref)) continue
    const p: IRPart = { ref, spec: { lib: "Simulation_SPICE:VDC", value: siText(v?.value ?? 0) }, span: s.span, exclude: false }
    parts.push(p); byRef.set(ref, p)
  }

  // ---- nets
  const uf = new UF()
  const netNames = new Map<string, Span>() // declared/mentioned net names in order
  const ncPins: { ref: string; n: string }[] = []
  let anon = 0
  const netKey = (name: string) => {
    const n = grounds.includes(name) || isGroundName(name) ? groundName : name
    if (!netNames.has(n)) netNames.set(n, { from: 0, to: 0 })
    return `net:${n}`
  }
  for (const g of grounds) uf.union(netKey(groundName), netKey(g))
  const pinKey = (ref: string, text: string, span: Span): string | null => {
    const part = byRef.get(ref)
    if (!part) { diag({ code: "V204", message: `unknown part “${ref}”`, span }); return null }
    const r = findPin(getSymbol(part.spec.lib)!, text)
    if ("error" in r) { diag({ code: "V205", message: `${ref}: ${r.error}`, span }); return null }
    return `pin:${ref}.${r.pin.n}`
  }
  const sides = (e: Endpoint): { left: string | null; right: string | null; nc?: boolean } => {
    switch (e.k) {
      case "nc": return { left: null, right: null, nc: true }
      case "anon": { const k = `anon:${++anon}`; return { left: k, right: k } }
      case "pins": {
        const keys = e.pins.map((p) => pinKey(p.ref, p.pin, p.span)).filter((k): k is string => !!k)
        for (const k of keys.slice(1)) uf.union(keys[0], k)
        return { left: keys[0] ?? null, right: keys[0] ?? null }
      }
      case "inline": case "name": {
        const ref = e.k === "inline" ? e.decl.ref : e.name
        const part = byRef.get(ref)
        if (!part) {
          if (e.k === "inline") return { left: null, right: null }
          return { left: netKey(e.name), right: netKey(e.name) }
        }
        const sym = getSymbol(part.spec.lib)!
        const through = e.k === "name" ? e.through : undefined
        const all = sym.units.flatMap((u) => u.pins)
        if (!through && all.length !== 2) {
          diag({ code: "V206", message: `${ref} has ${all.length} pins — in a chain write ${ref}(IN→OUT) or connect its pins by name (${ref}.PIN)`, span: e.span })
          return { left: null, right: null }
        }
        let a = through ? pinKey(ref, through[0], e.span) : `pin:${ref}.${all[0].n}`
        let b = through ? pinKey(ref, through[1], e.span) : `pin:${ref}.${all[1].n}`
        if (e.k === "name" && e.reversed) [a, b] = [b, a]
        return { left: a, right: b }
      }
    }
  }
  for (const s of body) {
    if (s.k !== "conn") continue
    const sd = s.ends.map(sides)
    for (let i = 0; i + 1 < sd.length; i++) {
      const A = sd[i], B = sd[i + 1]
      if (A.nc || B.nc) {
        const k = A.nc ? B.left : A.right
        if (k?.startsWith("pin:")) { const [ref, n] = k.slice(4).split("."); ncPins.push({ ref, n }) }
        continue
      }
      if (A.right && B.left) uf.union(A.right, B.left)
    }
  }
  for (const s of supplies) {
    const ref = `V_${s.name.replace(/[^\w]/g, "_")}`
    uf.union(`pin:${ref}.1`, netKey(s.name))
    uf.union(`pin:${ref}.2`, netKey(groundName))
  }

  // groups → nets
  const groups = new Map<string, string[]>()
  for (const k of uf.keys()) { const r = uf.find(k); groups.set(r, [...(groups.get(r) ?? []), k]) }
  const nets: IRNet[] = []
  let gen = 0
  for (const keys of groups.values()) {
    const names = keys.filter((k) => k.startsWith("net:")).map((k) => k.slice(4))
    const pins = keys.filter((k) => k.startsWith("pin:")).map((k) => { const [ref, n] = k.slice(4).split("."); return { ref, n } })
    const ground = names.includes(groundName)
    if (names.length > 1 && !ground) diagnostics.push({ severity: "warning", code: "V301", message: `nets ${names.join(" and ")} are connected; keeping ${names[0]}`, span: circuit.span })
    nets.push({ name: ground ? groundName : names[0] ?? `_n${++gen}`, ground, generated: !names.length, pins })
  }
  // ERC-style checks on the code
  for (const p of parts) {
    const sym = getSymbol(p.spec.lib)!
    const connected = new Set(nets.flatMap((n) => n.pins.filter((x) => x.ref === p.ref).map((x) => x.n)))
    const ncs = new Set(ncPins.filter((x) => x.ref === p.ref).map((x) => x.n))
    const open = sym.units.flatMap((u) => u.pins).filter((x) => !x.h && !connected.has(x.n) && !ncs.has(x.n))
    if (open.length && open.length < 6) diagnostics.push({ severity: "warning", code: "V302", message: `${p.ref}: pin${open.length > 1 ? "s" : ""} ${open.map((x) => x.name && x.name !== "~" ? `${x.n} (${x.name.replace(/~\{([^}]*)\}/g, "$1")})` : x.n).join(", ")} not connected — add “-- nc” if intended`, span: p.span })
  }
  // ---- properties (R1.footprint = …, parts(R*).MPN = …) and design checks (check …)
  const sel: SelPart[] = parts.map((p) => ({
    ref: p.ref, lib: p.spec.lib, value: p.spec.value, footprint: p.spec.footprint, fields: { ...p.spec.fields }, exclude: p.exclude,
    nets: new Map(nets.flatMap((n) => n.pins.filter((x) => x.ref === p.ref).map((x) => [x.n, n.name] as [string, string]))),
  }))
  for (const ch of propertyChanges(body, sel, diag)) {
    const p = byRef.get(ch.ref)!
    if (ch.prop === "value") p.spec = { ...p.spec, value: ch.text }
    else if (ch.prop === "footprint") p.spec = { ...p.spec, footprint: ch.text }
    else if (ch.prop === "exclude") p.exclude = ch.text === "1"
    else p.spec = { ...p.spec, fields: { ...p.spec.fields, [ch.field!]: ch.text } }
  }
  const checkCtx = {
    parts: sel, nets: new Set(nets.map((n) => n.name)),
    pin: (ref: string, text: string) => { const part = byRef.get(ref); if (!part) return { error: `unknown part “${ref}”` }; const r = findPin(getSymbol(part.spec.lib)!, text); return "error" in r ? r : { n: r.pin.n } },
  }
  for (const s of body) {
    if (s.k !== "check") continue
    const why = runCheck(s, checkCtx, diag)
    if (why) diag({ code: "V510", message: `check failed: ${why}`, span: s.span })
  }

  if (parts.length && !opts.componentMode && !nets.some((n) => n.ground && n.pins.length)) diagnostics.push({ severity: "error", code: "V303", message: "nothing is connected to ground — connect a pin to GND", span: circuit.span })

  const title = strArg(circuit.annotations.find((a) => a.name === "title")?.args[0]?.value)
  const description = strArg(circuit.annotations.find((a) => a.name === "description")?.args[0]?.value)
  const ir: IR = { name: circuit.name, title, description, parts, nets, noConnects: ncPins }

  const errors = diagnostics.filter((d) => d.severity === "error")
  if (errors.length) return { ok: false, diagnostics, ir, doc: null, file }

  const doc = buildDoc(ir, file, src, prev ?? null, !!opts.componentMode)
  // symbols the circuit carries (from a KiCad schematic) stay with it while its parts use them
  const usedLibs = new Set(doc.parts.map((p) => p.lib))
  const carried = prev?.symbols?.filter((s) => usedLibs.has(s.id))
  if (carried?.length) doc.symbols = carried
  // components (with the parameter sets compiled so far), imports and the library header travel with the circuit
  if (defs.size) doc.components = [...defs.values()]
  const imports = file.items.filter((i): i is Extract<Item, { k: "import" }> => i.k === "import").map((i) => ({ path: i.path, library: i.library }))
  if (imports.length) doc.imports = imports
  const libItem = file.items.find((i): i is Extract<Item, { k: "library" }> => i.k === "library")
  if (libItem) doc.library = { name: libItem.name, version: libItem.version }
  // feeds: a bad one is reported but doesn't stop the circuit (the run skips it)
  const spans = file.items.flatMap((i) => (i.k === "stimulus" ? i.feeds.map((f) => f.span) : i.k === "environment" ? i.entries.map((e) => e.span) : []))
  for (const pr of resolveFeeds(doc, doc.analyses.tran.stop).problems) {
    const k = doc.stimulus?.feeds.indexOf(pr.feed) ?? -1
    diag({ severity: "warning", code: "V301", message: `${pr.feed.target}: ${pr.message}`, span: spans[k] ?? { from: 0, to: 1 } })
  }
  return { ok: true, diagnostics, ir, doc, file }
}

// ---------------------------------------------------------------- analyses, measures, instruments


function analysesFrom(file: File, src: string, base: Doc) {
  const out = { analyses: structuredClone(base.analyses), defaultAnalysis: base.defaultAnalysis, measures: [] as Measure[], asserts: [] as string[], probes: [] as string[], dmm: undefined as string | undefined, setup: { overlay: true, parallel: true, keepRaw: false } as SimSetup, stimulus: undefined as Stimulus | undefined }
  let first = true
  const text = (e: Expr) => src.slice(e.span.from, e.span.to)
  for (const it of file.items) {
    if (it.k === "simulate") {
      const arg = (n: string, i?: number) => it.args.find((a) => a.name === n)?.value ?? (i !== undefined ? it.args.filter((a) => !a.name)[i]?.value : undefined)
      const v = (n: string, i?: number) => { const e = arg(n, i); return e ? evalNum(e)?.value : undefined }
      const a = it.analysis
      if (a === "tran") out.analyses.tran = { stop: v("stop", 0) ?? out.analyses.tran.stop, step: v("step", 1) ?? out.analyses.tran.step }
      if (a === "ac") out.analyses.ac = { start: v("from", 0) ?? out.analyses.ac.start, stop: v("to", 1) ?? out.analyses.ac.stop, points: v("points") ?? out.analyses.ac.points }
      if (a === "dc") { const src0 = arg("source", 0); out.analyses.dc = { source: src0?.k === "id" ? src0.name : "V1", start: v("from") ?? 0, stop: v("to") ?? 5, step: v("step") ?? 0.1 } }
      if (first && (a === "tran" || a === "ac" || a === "op" || a === "dc")) { out.defaultAnalysis = a; first = false }
    } else if (it.k === "measure") out.measures.push({ name: it.name, expr: text(it.expr) })
    else if (it.k === "assert") out.asserts.push(text(it.expr) + (it.severity ? ` severity: ${it.severity}` : ""))
    else if (it.k === "instrument") {
      const sig = (e: Expr) => text(e).replace(/`([^`]*)`/g, "$1").replace(/^V\(GND\)$/, "V(0)")
      if (it.kind === "scope") for (const l of it.lines) { if (/^ch\d$/.test(l.key) && l.args[0]) out.probes.push(sig(l.args[0])) }
      if (it.kind === "meter" && it.value) out.dmm = sig(it.value)
    } else if (it.k === "sweep") {
      const target = text(it.target)
      if (it.values.k === "list") out.setup.sweep = { enabled: true, target, mode: "list", values: it.values.items.map(text), start: "", stop: "", points: 10 }
      else if (it.values.k === "range") out.setup.sweep = { enabled: true, target, mode: it.spacing?.mode === "log" ? "dec" : "lin", values: [], start: text(it.values.a), stop: text(it.values.b), points: Number(evalNum(it.spacing?.points ?? { k: "num", value: 10, text: "10", span: it.span })?.value ?? 10) }
    } else if (it.k === "montecarlo") out.setup.montecarlo = { enabled: true, runs: it.runs, seed: it.seed ?? 1 }
    else if (it.k === "temp" && it.values.k === "list") out.setup.temp = { enabled: true, values: it.values.items.map(text) }
    else if (it.k === "stimulus") {
      const seed = it.seed ? evalNum(it.seed)?.value : undefined
      out.stimulus = { feeds: [...(out.stimulus?.feeds ?? []), ...it.feeds.map((f) => ({ target: f.target, expr: text(f.value) }))], ...(seed !== undefined ? { seed } : out.stimulus?.seed !== undefined ? { seed: out.stimulus.seed } : {}) }
    }
    // the first version of the room: environment { light: 300 lux } — the same as room.light = 300 lux
    else if (it.k === "environment") out.stimulus = { ...out.stimulus, feeds: [...(out.stimulus?.feeds ?? []), ...it.entries.map((e) => ({ target: `room.${e.key}`, expr: text(e.value) }))] }
  }
  return out
}

// ---------------------------------------------------------------- IR → Doc (geometry)

const key = (p: Pt) => `${p[0]},${p[1]}`
/** outward direction of a pin (away from the body), in world grid coordinates */
function outward(part: Part, pin: KPin): Pt {
  const local: Pt = pin.a === 0 ? [-1, 0] : pin.a === 90 ? [0, 1] : pin.a === 180 ? [1, 0] : [0, -1]
  return transform(local, part.rot, part.mirror)
}

function buildDoc(ir: IR, file: File, src: string, prev: Doc | null, componentMode = false): Doc {
  const base = prev ?? emptyDoc()
  const layout = file.items.find((i): i is Extract<Item, { k: "layout" }> => i.k === "layout")?.items ?? null
  const extra = analysesFrom(file, src, base)
  const doc: Doc = {
    ...emptyDoc(),
    title: ir.title ?? prev?.title ?? ir.name.replace(/([a-z])([A-Z])/g, "$1 $2"),
    description: ir.description ?? prev?.description ?? "",
    analyses: extra.analyses, defaultAnalysis: extra.defaultAnalysis,
    probes: extra.probes, measures: extra.measures, asserts: extra.asserts, dmm: extra.dmm,
    setup: extra.setup.sweep || extra.setup.montecarlo || extra.setup.temp ? extra.setup : prev?.setup,
    // feeds live in the code like the analyses: no block, no feeds
    stimulus: extra.stimulus,
    // the board layout is not part of the code; keep it across code edits
    pcb: prev?.pcb,
    // so are the boards' sketches
    firmware: prev?.firmware,
  }

  // which units of each part to draw
  const usedPins = new Map<string, Set<string>>()
  for (const n of ir.nets) for (const p of n.pins) { if (!usedPins.has(p.ref)) usedPins.set(p.ref, new Set()); usedPins.get(p.ref)!.add(p.n) }
  const at = new Map<string, Extract<LayoutItem, { k: "at" }>>()
  for (const it of layout ?? []) if (it.k === "at") at.set(`${it.target}/${it.unit ?? "A"}`, it)
  const prevPart = (ref: string, unit: number, lib: string) => prev?.parts.find((p) => p.ref === ref && p.unit === unit && p.lib === lib)

  const placed: Part[] = []
  const unplaced: Part[] = []
  for (const p of ir.parts) {
    const sym = getSymbol(p.spec.lib)!
    let units = sym.units.map((_, i) => i + 1).filter((u) => {
      if (sym.units.length === 1) return true
      if (at.has(`${p.ref}/${unitLetter(u)}`)) return true
      const pins = sym.units[u - 1].pins
      const used = usedPins.get(p.ref) ?? new Set()
      return pins.some((x) => used.has(x.n))
    })
    if (!units.length) units = [1]
    for (const u of units) {
      const lay = at.get(`${p.ref}/${unitLetter(u)}`) ?? (sym.units.length === 1 ? at.get(`${p.ref}/A`) : undefined)
      const old = prevPart(p.ref, u, p.spec.lib)
      const part: Part = {
        ...defaultPart(sym, u), id: old?.id ?? uid("p"), ref: p.ref, lib: p.spec.lib, unit: u, value: p.spec.value,
        x: lay?.x ?? old?.x ?? 0, y: lay?.y ?? old?.y ?? 0, rot: ((lay?.rot ?? old?.rot ?? 0) % 360) as Rot, mirror: lay ? lay.mirror || undefined : old?.mirror,
        ...(p.spec.sim || p.exclude ? { sim: { ...p.spec.sim, ...(p.exclude ? { Exclude: "1" } : {}) } } : {}),
        ...(p.spec.fields ? { fields: p.spec.fields } : {}),
        ...(p.spec.footprint ? { footprint: p.spec.footprint } : {}),
      }
      ;(lay || old ? placed : unplaced).push(part)
    }
  }

  // fresh code and the AI's circuits: lay the whole circuit out as a wired schematic
  let auto: ReturnType<typeof autoLayout> | null = null
  // (code without a layout block = "draw it for me"; Kirk writes the block once you arrange parts yourself)
  if (!layout && !componentMode && placed.length + unplaced.length) {
    unplaced.unshift(...placed.splice(0))
    auto = autoLayout(unplaced, ir, { gnd: "power:GND", supply: () => (getSymbol("power:VCC") ? "power:VCC" : "power:GND") })
    if ((globalThis as { process?: { env?: Record<string, string> } }).process?.env?.SB_LAYOUT_DEBUG) console.warn("[layout]", auto.unrouted, auto.why)
  }
  // otherwise auto-place parts without a position: rows below what is drawn
  const xs = placed.map((p) => p.x), ys = placed.map((p) => p.y)
  let cx = placed.length ? Math.min(...xs) : 12, cy = placed.length ? Math.max(...ys) + 12 : 14
  const startX = cx
  unplaced.sort((a, b) => Number(/^Simulation_SPICE:[VI]/.test(b.lib)) - Number(/^Simulation_SPICE:[VI]/.test(a.lib)))
  for (const p of auto ? [] : unplaced) {
    const u = unitOf(p)
    const w = u ? Math.ceil(u.box[2] / 12.7) : 6, h = u ? Math.ceil(u.box[3] / 12.7) : 6
    p.x = cx + Math.ceil(w / 2); p.y = cy + Math.ceil(h / 2)
    cx += Math.max(w, 4) + 10
    if (cx - startX > 64) { cx = startX; cy += 18 }
  }
  doc.parts = [...placed, ...unplaced]

  // geometry from the layout block (or the previous drawing when there is no layout block)
  const wires: Wire[] = []
  if (layout) {
    for (const it of layout) {
      if (it.k === "wire") for (let i = 1; i < it.points.length; i++) wires.push({ id: uid("w"), a: it.points[i - 1], b: it.points[i] })
      else if (it.k === "label") doc.parts.push({ id: uid("p"), ref: `#LBL_${it.net}_${it.x}_${it.y}`, lib: "@:label", unit: 1, x: it.x, y: it.y, rot: (it.rot % 360) as Rot, value: "net", net: it.net })
      else if (it.k === "power" && getSymbol(it.lib)) doc.parts.push({ id: uid("p"), ref: "#PWR", lib: it.lib, unit: 1, x: it.x, y: it.y, rot: (it.rot % 360) as Rot, value: it.name })
      else if (it.k === "nc") (doc.noConnects ??= []).push([it.x, it.y])
    }
  }
  doc.wires = wires
  if (auto) { doc.wires.push(...auto.wires); doc.parts.push(...auto.symbols) }
  let pwr = 0
  for (const p of doc.parts) if (p.ref === "#PWR") p.ref = `#PWR${String(++pwr).padStart(2, "0")}`
  const nextPwr = () => `#PWR${String(++pwr).padStart(2, "0")}`

  // no-connect markers declared in code
  for (const nc of ir.noConnects) {
    const part = doc.parts.find((p) => p.ref === nc.ref && placedPins(p).some((x) => x.n === nc.n))
    const pin = part && placedPins(part).find((x) => x.n === nc.n)
    if (pin && !(doc.noConnects ?? []).some((q) => key(q) === key(pin.at))) (doc.noConnects ??= []).push(pin.at)
  }

  reconcile(doc, ir, nextPwr)
  return doc
}

/** Make the drawing match the code's nets: drop mismatched wiring, stub pins with labels, rename labels. */
function reconcile(doc: Doc, ir: IR, nextPwr: () => string) {
  const codeNetOf = new Map<string, IRNet>()
  for (const n of ir.nets) for (const p of n.pins) codeNetOf.set(`${p.ref}.${p.n}`, n)
  const pinKeys = (n: IRNet) => n.pins.map((p) => `${p.ref}.${p.n}`).filter((k) => doc.parts.some((q) => `${q.ref}` === k.split(".")[0] && placedPins(q).some((x) => `${q.ref}.${x.n}` === k)))
  const label = (n: IRNet) => (n.ground ? "GND" : n.name)

  for (let pass = 0; pass < 6; pass++) {
    const geo = deriveNetlist(doc)
    const geoPins = new Map<string, Set<string>>()
    for (const [k, net] of geo.pinNet) { if (!geoPins.has(net)) geoPins.set(net, new Set()); geoPins.get(net)!.add(k) }
    const dirty: IRNet[] = []
    for (const n of ir.nets) {
      const keys = pinKeys(n)
      if (!keys.length) continue
      if (keys.length === 1 && n.generated) continue // a single unconnected pin
      const g = new Set(keys.map((k) => geo.pinNet.get(k)))
      if (g.size !== 1) { dirty.push(n); continue }
      const gname = [...g][0]!
      const members = geoPins.get(gname) ?? new Set()
      if (members.size !== keys.length || keys.some((k) => !members.has(k))) { dirty.push(n); continue }
      // same pins: make the drawn name match the code's name
      const want = n.ground ? "0" : n.name
      if (gname !== want && !n.generated) {
        const tags = doc.parts.filter((p) => (isLabel(p) || isPower(p)) && geo.pointNet.get(key(placedPins(p)[0]?.at ?? [0, 0])) === gname)
        if (tags.length) for (const t of tags) { if (isLabel(t)) t.net = label(n); else t.value = label(n) }
        else {
          // wired right but unnamed (the auto-layout's wires): name it with one label on a wire corner
          const pinAt = new Set(doc.parts.flatMap((p) => placedPins(p).map((x) => key(x.at))))
          const ends = doc.wires.filter((w) => geo.wireNet.get(w.id) === gname).flatMap((w) => [w.a, w.b])
          const at = ends.find((e) => !pinAt.has(key(e))) ?? ends[0]
          if (at) doc.parts.push({ id: uid("p"), ref: `#LBL_${n.name}_${at[0]}_${at[1]}`, lib: "@:label", unit: 1, x: at[0], y: at[1], rot: 0, value: "net", net: label(n) })
          else dirty.push(n)
        }
      }
    }
    if (!dirty.length) return
    // a drawn net whose pins all belong to the dirty code net keeps its wiring (it only gains pins);
    // a drawn net that mixes pins of other nets is dropped
    const keep = new Set<string>(), drop = new Set<string>()
    const codeOf = (k: string) => codeNetOf.get(k)
    for (const n of dirty) for (const k of pinKeys(n)) {
      const g = geo.pinNet.get(k)
      if (!g || keep.has(g) || drop.has(g)) continue
      const members = [...(geoPins.get(g) ?? [])]
      if (members.length > 1 && members.every((m) => codeOf(m) === n)) keep.add(g); else drop.add(g)
    }
    doc.wires = doc.wires.filter((w) => !drop.has(geo.wireNet.get(w.id) ?? ""))
    doc.parts = doc.parts.filter((p) => !((isLabel(p) || isPower(p)) && drop.has(geo.pointNet.get(key(placedPins(p)[0]?.at ?? [0, 0])) ?? "")))
    for (const n of dirty) {
      const keys = pinKeys(n)
      if (keys.length < 2 && n.generated) continue
      const kept = [...new Set(keys.map((k) => geo.pinNet.get(k)).filter((g): g is string => !!g && keep.has(g)))]
      // kept pieces carry the code's net name (a label on one of their wire points), so all pieces join
      const needsName = kept.length + keys.filter((k) => !kept.includes(geo.pinNet.get(k) ?? "")).length > 1
      for (const g of kept) {
        const named = doc.parts.some((p) => (isLabel(p) ? p.net : isPower(p) ? p.value : null) === label(n) && geo.pointNet.get(key(placedPins(p)[0]?.at ?? [0, 0])) === g)
        if (named || !needsName) continue
        const w = doc.wires.find((x) => geo.wireNet.get(x.id) === g)
        if (w) doc.parts.push({ id: uid("p"), ref: `#LBL_${n.name}_${w.a[0]}_${w.a[1]}`, lib: "@:label", unit: 1, x: w.a[0], y: w.a[1], rot: 0, value: "net", net: label(n) })
      }
      for (const k of keys) {
        if (kept.includes(geo.pinNet.get(k) ?? "")) continue
        const [ref, pn] = k.split(".")
        const part = doc.parts.find((q) => q.ref === ref && placedPins(q).some((x) => x.n === pn))!
        const pin = placedPins(part).find((x) => x.n === pn)!
        addStub(doc, part, pin, n, nextPwr)
      }
    }
  }
}

function addStub(doc: Doc, part: Part, pin: KPin & { at: Pt }, net: IRNet, nextPwr: () => string) {
  const d = outward(part, pin)
  const occupied = new Set<string>()
  for (const p of doc.parts) for (const x of placedPins(p)) occupied.add(key(x.at))
  for (const w of doc.wires) { occupied.add(key(w.a)); occupied.add(key(w.b)) }
  let len = 2
  let end: Pt = [pin.at[0] + d[0] * len, pin.at[1] + d[1] * len]
  while (occupied.has(key(end)) && len < 8) { len++; end = [pin.at[0] + d[0] * len, pin.at[1] + d[1] * len] }
  doc.wires.push({ id: uid("w"), a: pin.at, b: end })
  const gnd = net.ground
  if (gnd && d[1] === 1 && getSymbol("power:GND")) {
    doc.parts.push({ id: uid("p"), ref: nextPwr(), lib: "power:GND", unit: 1, x: end[0], y: end[1], rot: 0, value: "GND" })
  } else {
    doc.parts.push({ id: uid("p"), ref: `#LBL_${net.name}_${end[0]}_${end[1]}`, lib: "@:label", unit: 1, x: end[0], y: end[1], rot: 0, value: "net", net: gnd ? "GND" : net.name })
  }
}
