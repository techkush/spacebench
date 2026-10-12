// Connectivity: drawing → nets → engine elements.
// Rules: a wire end joins anything it touches (pins, other wire ends, or the
// middle of another wire); wires that merely cross do NOT connect; net labels
// with the same name are one net, as are power symbols with the same value;
// ground-like power nets (GND, GNDA, Earth…) are SPICE node 0.
import { displayRef, hiddenPowerPins, isLabel, isPower, isVirtual, placedPins, symbolFor, type Doc, type Part, type PlacedPin, type Pt } from "./model"

const key = (p: Pt) => `${p[0]},${p[1]}`

class UnionFind {
  private parent = new Map<string, string>()
  find(a: string): string {
    if (!this.parent.has(a)) this.parent.set(a, a)
    let r = a
    while (this.parent.get(r) !== r) r = this.parent.get(r)!
    let c = a
    while (c !== r) { const n = this.parent.get(c)!; this.parent.set(c, r); c = n }
    return r
  }
  union(a: string, b: string) {
    const ra = this.find(a), rb = this.find(b)
    if (ra !== rb) this.parent.set(ra, rb)
  }
}

/** Is p on segment a–b (inclusive of ends)? Integer geometry, any direction. */
export function onSegment(p: Pt, a: Pt, b: Pt, strict = false): boolean {
  const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
  if (cross !== 0) return false
  if (p[0] < Math.min(a[0], b[0]) || p[0] > Math.max(a[0], b[0]) || p[1] < Math.min(a[1], b[1]) || p[1] > Math.max(a[1], b[1])) return false
  return !(strict && (key(p) === key(a) || key(p) === key(b)))
}

export interface Issue {
  severity: "error" | "warning"
  message: string
  ref?: string
}

export interface Netlist {
  /** "R1.2" → net name (ref + pin number; all units of a package share the ref) */
  pinNet: Map<string, string>
  /** wire id → net name */
  wireNet: Map<string, string>
  /** grid point → net name (pins and wire ends) */
  pointNet: Map<string, string>
  nets: string[]
  junctions: Pt[]
  issues: Issue[]
}

/** Ground-like global net names become SPICE node 0. */
export const isGroundName = (n: string) => /^(gnd|gnda|gndd|gndref|gndpwr|gnds|earth|0)$/i.test(n.trim())

export function deriveNetlist(doc: Doc): Netlist {
  const uf = new UnionFind()
  const pins: { part: Part; pin: PlacedPin; at: Pt }[] = []
  for (const part of doc.parts) {
    for (const pin of placedPins(part)) {
      pins.push({ part, pin, at: pin.at })
      uf.find(key(pin.at))
    }
  }
  for (const w of doc.wires) uf.union(key(w.a), key(w.b))

  // every pin / wire end that lies on a wire joins that wire
  const points = new Map<string, Pt>()
  for (const p of pins) points.set(key(p.at), p.at)
  for (const w of doc.wires) { points.set(key(w.a), w.a); points.set(key(w.b), w.b) }
  for (const [k, p] of points) for (const w of doc.wires) if (onSegment(p, w.a, w.b)) uf.union(k, key(w.a))

  // global names: net labels, power symbols (their Value) and hidden power pins (their name)
  const globalRoot = new Map<string, string>()
  const joinGlobal = (name: string, k: string) => {
    const n = isGroundName(name) ? "0" : name.trim() || "net"
    const prev = globalRoot.get(n)
    if (prev) uf.union(k, prev)
    else globalRoot.set(n, k)
  }
  for (const p of pins) {
    if (isLabel(p.part)) joinGlobal(p.part.net ?? "net", key(p.at))
    else if (isPower(p.part) && !/^PWR_FLAG$/i.test(p.part.value)) joinGlobal(p.part.value, key(p.at))
  }
  for (const part of doc.parts) {
    for (const hp of hiddenPowerPins(part)) {
      const k = `hidden:${part.ref}.${hp.n}`
      uf.find(k)
      joinGlobal(hp.name, k)
    }
  }

  const issues: Issue[] = []
  const names = new Map<string, string>()
  if (globalRoot.has("0")) names.set(uf.find(globalRoot.get("0")!), "0")
  for (const [name, k] of [...globalRoot].sort()) {
    if (name === "0") continue
    const r = uf.find(k)
    const existing = names.get(r)
    if (existing && existing !== name) {
      issues.push({ severity: "warning", message: existing === "0" ? `Net “${name}” is connected to ground` : `One net has two names: “${existing}” and “${name}”` })
      continue
    }
    names.set(r, name)
  }
  let auto = 0
  const sorted = [...points.values()].sort((a, b) => a[1] - b[1] || a[0] - b[0])
  for (const p of sorted) {
    const r = uf.find(key(p))
    if (!names.has(r)) names.set(r, `N${String(++auto).padStart(3, "0")}`)
  }

  const pointNet = new Map<string, string>()
  for (const [k] of points) pointNet.set(k, names.get(uf.find(k))!)
  const pinNet = new Map<string, string>()
  for (const p of pins) if (!isVirtual(p.part)) pinNet.set(`${p.part.ref}.${p.pin.n}`, names.get(uf.find(key(p.at)))!)
  for (const part of doc.parts) {
    for (const hp of hiddenPowerPins(part)) {
      const r = uf.find(`hidden:${part.ref}.${hp.n}`)
      if (!names.has(r)) names.set(r, hp.name)
      pinNet.set(`${part.ref}.${hp.n}`, names.get(r)!)
    }
  }
  const wireNet = new Map<string, string>()
  for (const w of doc.wires) wireNet.set(w.id, names.get(uf.find(key(w.a)))!)

  // junction dots: ≥ 3 connections meet (an interior touch counts as 2)
  const junctions: Pt[] = []
  for (const p of points.values()) {
    let deg = 0
    for (const w of doc.wires) {
      if (key(w.a) === key(p)) deg++
      if (key(w.b) === key(p)) deg++
      if (onSegment(p, w.a, w.b, true)) deg += 2
    }
    deg += pins.filter((q) => key(q.at) === key(p) && !isLabel(q.part)).length
    if (deg >= 3) junctions.push(p)
  }

  // electrical rules check
  const members = new Map<string, number>()
  for (const p of pins) { const r = uf.find(key(p.at)); members.set(r, (members.get(r) ?? 0) + 1) }
  const wireEnds = new Set(doc.wires.flatMap((w) => [key(w.a), key(w.b)]))
  const unconnected = new Map<string, string[]>()
  const noConnect = new Set((doc.noConnects ?? []).map(key))
  for (const p of pins) {
    if (isVirtual(p.part) || noConnect.has(key(p.at)) || p.pin.t === "no_connect" || p.pin.t === "unspecified" && p.part.lib.startsWith("Connector")) continue
    // a development board or a programmable chip (Arduino, Pico, Raspberry Pi header, STM32, ATtiny,
    // ESP32 module): most of its pins are unused on purpose
    if (/^(MCU_Module:|Connector:Raspberry_Pi|MCU_ST_STM32|MCU_Microchip_ATtiny:|RF_Module:ESP32)/.test(p.part.lib)) continue
    const touched = wireEnds.has(key(p.at)) || doc.wires.some((w) => onSegment(p.at, w.a, w.b))
    if (members.get(uf.find(key(p.at))) === 1 && !touched) {
      const ref = displayRef(p.part)
      unconnected.set(ref, [...(unconnected.get(ref) ?? []), p.pin.name && p.pin.name !== "~" ? `${p.pin.n} (${p.pin.name.replace(/~\{([^}]*)\}/g, "$1")})` : p.pin.n])
    }
  }
  for (const [ref, list] of unconnected) {
    issues.push({ severity: "warning", message: `${ref}: pin${list.length > 1 ? "s" : ""} ${list.join(", ")} not connected`, ref: ref })
  }
  const electrical = doc.parts.filter((p) => !isVirtual(p))
  if (electrical.length && !globalRoot.has("0")) issues.push({ severity: "error", message: "No ground. Place a ground symbol (G) — the simulator needs a 0 V reference." })
  const seen = new Map<string, Part>()
  for (const p of electrical) {
    const k = `${p.ref}/${p.unit}`
    const other = seen.get(k)
    if (other) issues.push({ severity: "error", message: `Duplicate reference ${displayRef(p)}`, ref: p.ref })
    else {
      const sameRef = [...seen.values()].find((q) => q.ref === p.ref && q.lib !== p.lib)
      if (sameRef) issues.push({ severity: "error", message: `${p.ref} is used by two different parts`, ref: p.ref })
      seen.set(k, p)
    }
  }
  const missing = doc.parts.filter((p) => !symbolFor(p))
  if (missing.length) issues.push({ severity: "error", message: `Missing symbol${missing.length > 1 ? "s" : ""}: ${[...new Set(missing.map((p) => p.lib))].join(", ")}` })

  return { pinNet, wireNet, pointNet, nets: [...new Set(names.values())], junctions, issues }
}
