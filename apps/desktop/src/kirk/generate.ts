// Schematic → Kirk code (spec §9.2). The circuit body says *what is connected*
// (parts and nets); the machine-managed `layout` block at the end says *where
// things are drawn*, so compiling the generated code reproduces the drawing.
import { displayRef, isLabel, isPower, isVirtual, placedPins, symbolFor, type Doc, type Part, type Pt } from "@/editor/model"
import type { Netlist } from "@/editor/netlist"
import { unitLetter } from "@/lib/kicad"
import { partToKirk, qty } from "./kinds"

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const RESERVED = new Set("circuit component supply ground net nc import library lib use simulate measure assert probe scope meter funcgen bode logger sweep montecarlo temp environment stimulus for in param pins symbol footprint model behavior draw export layout true false wire label power at rot mirror unit".split(" "))

/** A net name as Kirk source: plain identifier or `back-ticked`. */
export const netRef = (name: string) => (IDENT.test(name) && !RESERVED.has(name) ? name : `\`${name}\``)

/** Circuit identifier from a title: "RC low-pass filter" → RcLowPassFilter */
export function circuitName(title: string): string {
  const s = title.replace(/[^A-Za-z0-9]+/g, " ").trim().split(" ").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join("")
  return /^[A-Za-z_]/.test(s) ? s : `C${s || "ircuit"}`
}

const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`

/** How to write a pin: its name when unique and identifier-safe (U1.TRIG), else its number (R1.1). */
function pinText(part: Part, n: string): string {
  const sym = symbolFor(part)
  if (!sym) return n
  const all = sym.units.flatMap((u) => u.pins)
  if (all.length <= 2) return n
  const pin = all.find((p) => p.n === n)
  const name = pin?.name.replace(/~\{([^}]*)\}/g, "$1") ?? ""
  if (name && IDENT.test(name) && !/^\d/.test(name) && all.filter((p) => p.name.replace(/~\{([^}]*)\}/g, "$1").toLowerCase() === name.toLowerCase()).length === 1) return name
  return /^\d+$/.test(n) ? n : `\`${n}\``
}

/** Merge chained wire segments into polylines (fewer, readable `wire` lines). */
function polylines(doc: Doc): Pt[][] {
  const key = (p: Pt) => `${p[0]},${p[1]}`
  const deg = new Map<string, number>()
  for (const w of doc.wires) for (const p of [w.a, w.b]) deg.set(key(p), (deg.get(key(p)) ?? 0) + 1)
  // points where pins sit also stop a polyline (so it stays readable)
  for (const p of doc.parts) for (const pin of placedPins(p)) deg.set(key(pin.at), (deg.get(key(pin.at)) ?? 0) + 2)
  const used = new Set<string>()
  const out: Pt[][] = []
  for (const w of doc.wires) {
    if (used.has(w.id)) continue
    used.add(w.id)
    const line: Pt[] = [w.a, w.b]
    for (let grew = true; grew; ) {
      grew = false
      const end = line[line.length - 1]
      if (deg.get(key(end)) !== 2) break
      const nxt = doc.wires.find((v) => !used.has(v.id) && (key(v.a) === key(end) || key(v.b) === key(end)))
      if (nxt) { used.add(nxt.id); line.push(key(nxt.a) === key(end) ? nxt.b : nxt.a); grew = true }
    }
    out.push(line)
  }
  return out
}

const IN_CTOR: Record<string, RegExp> = { Tolerance: /\btol:/, Power: /\bpower:/, Voltage: /\bvoltage:/ }

/** R1.footprint = "…" and R1.MPN = "…" lines for what a part's constructor leaves out. */
function propertyLines(p: Doc["parts"][number], ctor: string): string[] {
  const out: string[] = []
  if (p.footprint && !/\bfootprint:/.test(ctor)) out.push(`    ${p.ref}.footprint = ${q(p.footprint)}`)
  for (const [k, v] of Object.entries(p.fields ?? {})) {
    if (!v || IN_CTOR[k]?.test(ctor)) continue
    const name = /^[A-Za-z_]\w*$/.test(k) && !RESERVED.has(k) ? k : `\`${k}\``
    out.push(`    ${p.ref}.${name} = ${q(v)}`)
  }
  return out
}

export function generateKirk(doc: Doc, nl: Netlist): string {
  const L: string[] = []
  const name = circuitName(doc.title)
  L.push(`// ${doc.title} — Kirk (Space Bench). The layout block at the end is managed by the schematic.`)
  // the library header, imports and this file's own components come first, as written
  if (doc.library) L.push(`library ${doc.library.name}${doc.library.version ? ` version ${q(doc.library.version)}` : ""}`)
  for (const im of doc.imports ?? []) L.push(`import ${im.library ? "library " : ""}${q(im.path)}`)
  const own = (doc.components ?? []).filter((c) => !c.from)
  if (doc.library || doc.imports?.length) L.push("")
  for (const c of own) { L.push(c.source); L.push("") }
  L.push(`@title(${q(doc.title)})${doc.description ? ` @description(${q(doc.description)})` : ""}`)
  L.push(`circuit ${name} {`)
  L.push("    ground GND")

  // parts: one declaration per reference (all units of a package share it)
  const seen = new Set<string>()
  const electrical = doc.parts.filter((p) => !isVirtual(p))
  const props: string[] = []
  for (const p of electrical) {
    if (seen.has(p.ref)) continue
    seen.add(p.ref)
    const ann = p.sim?.Exclude === "1" ? "@nosim " : ""
    const ctor = partToKirk(p)
    L.push(`    ${ann}${p.ref} = ${ctor}`)
    props.push(...propertyLines(p, ctor))
  }
  // footprints and fields the constructor doesn't carry (MPN, Manufacturer …)
  if (props.length) { L.push(""); L.push(...props) }

  // connections: one line per net, pins first, then the net
  const byNet = new Map<string, string[]>()
  for (const p of electrical) {
    for (const pin of placedPins(p)) {
      const net = nl.pinNet.get(`${p.ref}.${pin.n}`)
      if (net === undefined) continue
      const list = byNet.get(net) ?? []
      const t = `${p.ref}.${pinText(p, pin.n)}`
      if (!list.includes(t)) list.push(t)
      byNet.set(net, list)
    }
  }
  const named = new Set(doc.parts.filter(isVirtual).map((p) => (isLabel(p) ? p.net : p.value)))
  const conns: string[] = []
  for (const [net, pins] of byNet) {
    const auto = /^N\d{3,}$/.test(net)
    if (pins.length < 2 && (auto || !named.has(net)) && net !== "0") continue
    conns.push(`    ${pins.join(", ")} -- ${net === "0" ? "GND" : netRef(net)}`)
  }
  // explicit no-connects
  const ncs = new Set((doc.noConnects ?? []).map((p) => `${p[0]},${p[1]}`))
  for (const p of electrical) for (const pin of placedPins(p)) if (ncs.has(`${pin.at[0]},${pin.at[1]}`)) conns.push(`    ${p.ref}.${pinText(p, pin.n)} -- nc`)
  if (conns.length) { L.push(""); L.push(...conns) }
  L.push("}")
  L.push("")

  // analyses (the default one first)
  const a = doc.analyses
  const sims: Record<string, string> = {
    tran: `simulate tran(stop: ${qty(a.tran.stop, "s")}, step: ${qty(a.tran.step, "s")})`,
    ac: `simulate ac(from: ${qty(a.ac.start, "Hz")}, to: ${qty(a.ac.stop, "Hz")}, points: ${a.ac.points ?? 60}/dec)`,
    op: "simulate op",
    ...(a.dc ? { dc: `simulate dc(${a.dc.source}, from: ${qty(a.dc.start, "V")}, to: ${qty(a.dc.stop, "V")}, step: ${qty(a.dc.step, "V")})` } : {}),
  }
  const order = [doc.defaultAnalysis, ...Object.keys(sims).filter((k) => k !== doc.defaultAnalysis)]
  for (const k of order) if (sims[k]) L.push(sims[k])

  for (const m of doc.measures ?? []) L.push(`measure ${m.name} = ${m.expr}`)
  for (const s of doc.asserts ?? []) L.push(`assert ${s}`)

  const st = doc.setup
  if (st?.sweep?.enabled) {
    const sw = st.sweep
    L.push(sw.mode === "list" ? `sweep ${sw.target} in [${sw.values.join(", ")}]`
      : `sweep ${sw.target} in ${sw.start} .. ${sw.stop} ${sw.mode === "lin" ? "lin" : "log"} ${sw.points} points`)
  }
  if (st?.montecarlo?.enabled) L.push(`montecarlo ${st.montecarlo.runs} runs seed ${st.montecarlo.seed}`)
  if (st?.temp?.enabled) L.push(`temp in [${st.temp.values.join(", ")}]`)
  const stim = doc.stimulus
  if (stim?.feeds.length) {
    L.push("")
    L.push("stimulus {")
    if (stim.seed !== undefined) L.push(`    seed: ${stim.seed}`)
    for (const f of stim.feeds) L.push(`    ${f.target} = ${f.expr}`)
    L.push("}")
  }

  if (doc.probes.length) {
    L.push("")
    L.push("scope Scope1 {")
    doc.probes.forEach((s, i) => L.push(`    ch${i + 1} = ${signalText(s)}`))
    L.push("}")
  }
  if (doc.dmm) L.push(`meter DMM1 = ${signalText(doc.dmm)}`)

  // layout (machine-managed)
  L.push("")
  L.push("layout {")
  for (const p of electrical) {
    const sym = symbolFor(p)
    const unit = sym && sym.units.length > 1 ? ` unit ${unitLetter(p.unit)}` : ""
    L.push(`    ${p.ref}${unit} at (${p.x}, ${p.y})${p.rot ? ` rot ${p.rot}` : ""}${p.mirror ? " mirror" : ""}`)
  }
  for (const p of doc.parts) {
    if (isLabel(p)) L.push(`    label ${netRef(p.net ?? "net")} at (${p.x}, ${p.y})${p.rot ? ` rot ${p.rot}` : ""}`)
    else if (isPower(p)) L.push(`    power ${netRef(p.value)}${p.lib !== `power:${p.value}` ? ` ${q(p.lib)}` : ""} at (${p.x}, ${p.y})${p.rot ? ` rot ${p.rot}` : ""}`)
  }
  for (const line of polylines(doc)) L.push(`    wire ${line.map((p) => `(${p[0]}, ${p[1]})`).join(" ")}`)
  for (const p of doc.noConnects ?? []) L.push(`    nc at (${p[0]}, ${p[1]})`)
  L.push("}")
  return L.join("\n") + "\n"
}

/** V(out), I(R1), Ic(Q1) with net names quoted when needed. */
export function signalText(s: string): string {
  const m = /^(V|I[a-z]*)\((.*)\)$/.exec(s)
  if (!m) return s
  return m[1] === "V" ? `V(${m[2] === "0" ? "GND" : netRef(m[2])})` : s
}

export { displayRef }
