// Current through every wire segment, for the current-flow animation.
// Each pin injects the current its device pushes into the net (from ngspice's
// device currents); on each net's wire graph a spanning tree carries those
// injections by Kirchhoff's current law. Loops in the wiring carry no extra
// circulating current (the drawing can't tell), which is what you'd expect.
import { resolveSim } from "@/lib/spice"
import { isVirtual, placedPins, type Doc, type Pt } from "./model"
import { onSegment, type Netlist } from "./netlist"

const key = (p: Pt) => `${p[0]},${p[1]}`

/**
 * Current leaving each device pin into its net (A), keyed "x,y" of the pin.
 * Conventions (ngspice): I(R1) flows into pin 1 and out of pin 2; I(V1) flows
 * into + through the source; Ic/Ib/Ie(Q1) and Id/Is(M1) flow into the device.
 */
export function pinInjections(doc: Doc, values: Record<string, number>): Map<string, number> {
  const out = new Map<string, number>()
  const add = (at: Pt, i: number) => { if (Number.isFinite(i)) out.set(key(at), (out.get(key(at)) ?? 0) + i) }
  for (const part of doc.parts) {
    const sim = resolveSim(part)
    if (!sim || "error" in sim) continue
    const pins = placedPins(part)
    const at = (role: string) => {
      const n = Object.entries(sim.pins).find(([, r]) => r.toLowerCase() === role.toLowerCase())?.[0]
      return pins.find((p) => p.n === n)?.at
    }
    const roles = Object.values(sim.pins)
    switch (sim.kind) {
      case "R": case "C": case "L": case "V": case "I": case "D": {
        if (sim.type === "POT") break
        const i = values[`I(${part.ref})`]
        if (i === undefined) break
        const [first, second] = sim.kind === "D" ? ["A", "K"] : sim.kind === "V" || sim.kind === "I" ? [roles.includes("+") ? "+" : roles[0], roles.includes("-") ? "-" : roles[1]] : [roles[0], roles[1]]
        const a = at(first), b = at(second)
        // positive current enters the device at the first terminal, so it leaves the net there
        if (a) add(a, -i)
        if (b) add(b, i)
        break
      }
      case "NPN": case "PNP": {
        for (const [role, sig] of [["C", "Ic"], ["B", "Ib"], ["E", "Ie"]] as const) {
          const p = at(role), i = values[`${sig}(${part.ref})`]
          if (p && i !== undefined) add(p, -i)
        }
        break
      }
      case "NMOS": case "PMOS": case "NJFET": case "PJFET": {
        const d = at("D"), s = at("S"), i = values[`Id(${part.ref})`]
        if (i === undefined) break
        if (d) add(d, -i)
        if (s) add(s, i)
        break
      }
    }
  }
  return out
}

/** Signed current along each wire, positive from wire.a to wire.b. */
export function wireCurrents(doc: Doc, nl: Netlist, values: Record<string, number>): Map<string, number> {
  const inj = pinInjections(doc, values)
  // graph: grid points joined by wire segments (split at interior touches)
  const pts = new Set<string>()
  for (const w of doc.wires) { pts.add(key(w.a)); pts.add(key(w.b)) }
  for (const k of inj.keys()) pts.add(k)
  type Edge = { wire: string; from: string; to: string; sign: number }
  const adj = new Map<string, Edge[]>()
  const edge = (wire: string, a: string, b: string, sign: number) => {
    if (a === b) return
    if (!adj.has(a)) adj.set(a, [])
    if (!adj.has(b)) adj.set(b, [])
    adj.get(a)!.push({ wire, from: a, to: b, sign })
    adj.get(b)!.push({ wire, from: b, to: a, sign: -sign })
  }
  const parse = (k: string) => k.split(",").map(Number) as Pt
  for (const w of doc.wires) {
    // points lying on this wire, ordered from a to b
    const on = [...pts].map(parse).filter((p) => onSegment(p, w.a, w.b))
    on.sort((p, q) => Math.hypot(p[0] - w.a[0], p[1] - w.a[1]) - Math.hypot(q[0] - w.a[0], q[1] - w.a[1]))
    for (let i = 1; i < on.length; i++) edge(w.id, key(on[i - 1]), key(on[i]), 1)
  }

  // power symbols and labels join their net by name: link them through a virtual node
  for (const part of doc.parts) {
    if (!isVirtual(part)) continue
    for (const pin of placedPins(part)) {
      const net = nl.pointNet.get(key(pin.at))
      if (net) edge("", key(pin.at), `net:${net}`, 1)
    }
  }

  const flow = new Map<string, number>()
  const seen = new Set<string>()
  for (const root of adj.keys()) {
    if (seen.has(root)) continue
    // BFS tree; then push each subtree's net injection up to its parent
    const order: string[] = []
    const parent = new Map<string, Edge>()
    seen.add(root)
    for (let q = [root]; q.length; ) {
      const n = q.shift()!
      order.push(n)
      for (const e of adj.get(n) ?? []) {
        if (seen.has(e.to)) continue
        seen.add(e.to)
        parent.set(e.to, e)
        q.push(e.to)
      }
    }
    const sub = new Map<string, number>(order.map((n) => [n, inj.get(n) ?? 0]))
    for (const n of order.reverse()) {
      const e = parent.get(n)
      if (!e) continue
      const i = sub.get(n)! // current that must flow from n towards its parent
      sub.set(e.from, sub.get(e.from)! + i)
      // edge e goes parent(from) → n(to); current n → parent is −i along e
      const cur = -i * e.sign
      const prev = flow.get(e.wire)
      if (prev === undefined || Math.abs(cur) > Math.abs(prev)) flow.set(e.wire, cur)
    }
  }
  // a wire split into several pieces keeps its largest piece's current
  const out = new Map<string, number>()
  for (const w of doc.wires) out.set(w.id, flow.get(w.id) ?? 0)
  return out
}
