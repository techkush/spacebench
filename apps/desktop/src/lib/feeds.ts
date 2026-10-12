// Which inputs a circuit has (sources, sensors, controls, the room) and the signals its
// `stimulus { }` block feeds them. Used by the netlist, the Kirk compiler and the Lab window.
import { displayRef, isVirtual, type Doc, type Part } from "@/editor/model"
import { inputParts, isSensor, senseOf, type InputKind } from "@/editor/inputs"
import type { Expr } from "@/kirk/ast"
import { parse } from "@/kirk/parser"
import { QUANTITIES, QUANTITY_LIST, type Quantity, type QuantityInfo } from "./sensors"
import { compileSignal, SignalError, type Feed, type Signal } from "./stimulus"

export type TargetKind = "source" | "sensor" | "control" | "room"
export interface FeedTarget {
  /** what you write in Kirk: V1, TH1, RV1, room.temp */
  target: string
  kind: TargetKind
  /** what is fed: supply voltage, temperature, light … */
  quantity: string
  unit?: "V" | "A" | NonNullable<QuantityInfo["unit"]>
  /** value without a feed */
  base: number
  part?: Part
  input?: InputKind
  /** what a sensor or room property senses */
  sense?: Quantity
}



/** Is this part an independent source (its value can be fed)? */
export function sourceKind(p: Pick<Part, "lib">): "V" | "I" | null {
  const [lib, name = ""] = p.lib.split(":")
  if (lib === "Simulation_SPICE" && /^V(DC|SIN|PULSE|PWL|EXP|SFFM|AM|TRRANDOM|TRNOISE)?$/.test(name)) return "V"
  if (lib === "Simulation_SPICE" && /^I(DC|SIN|PULSE|PWL|EXP|SFFM|AM|TRRANDOM|TRNOISE)?$/.test(name)) return "I"
  if (lib === "Device" && /^Battery/.test(name)) return "V"
  return null
}

const num = (s: string | undefined) => { const m = /^\s*([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s*(k|m|u|µ|n|meg)?/i.exec(s ?? ""); return m ? Number(m[1]) * ({ k: 1e3, m: 1e-3, u: 1e-6, "µ": 1e-6, n: 1e-9, meg: 1e6 }[m[2]?.toLowerCase() ?? ""] ?? 1) : 0 }

/** Every input of the circuit, in the order the Lab shows them. */
export function feedTargets(doc: Doc): FeedTarget[] {
  const out: FeedTarget[] = []
  const seen = new Set<string>()
  for (const p of doc.parts) {
    if (isVirtual(p) || seen.has(p.ref)) continue
    const s = sourceKind(p)
    if (!s) continue
    seen.add(p.ref)
    out.push({ target: displayRef(p), kind: "source", quantity: s === "V" ? "voltage" : "current", unit: s === "V" ? "V" : "A", base: num(/dc=(\S+)/i.exec(p.sim?.Params ?? "")?.[1] ?? p.value), part: p })
  }
  for (const { part, kind } of inputParts(doc)) {
    if (isSensor(kind)) {
      const sense = senseOf(kind), qi = QUANTITIES[sense]
      out.push({ target: displayRef(part), kind: "sensor", quantity: qi.label, unit: qi.unit, base: qi.base, part, input: kind, sense })
    } else {
      out.push({ target: displayRef(part), kind: "control", quantity: kind === "pot" ? "wiper position (0…1)" : "state (0 off · 1 on)", base: kind === "pot" ? 0.5 : 0, part, input: kind })
    }
  }
  for (const sense of QUANTITY_LIST) {
    const qi = QUANTITIES[sense]
    out.push({ target: `room.${sense}`, kind: "room", quantity: `${qi.label} for every sensor without its own feed`, unit: qi.unit, base: qi.base, sense })
  }
  return out
}

/** Parse the expression text of a feed. */
export function parseFeedExpr(src: string): { expr: Expr } | { error: string } {
  const r = parse(`stimulus {\n    x = ${src}\n}\n`)
  const it = r.file.items[0]
  if (r.diagnostics.length || it?.k !== "stimulus" || !it.feeds[0]) return { error: r.diagnostics[0]?.message ?? "not a valid expression" }
  return { expr: it.feeds[0].value }
}

/** Find the target a feed names (TH1, TH1.temp, room.temp …), case-insensitive. */
export function findTarget(targets: FeedTarget[], name: string): FeedTarget | null {
  const n = name.trim().toUpperCase()
  const t = targets.find((x) => x.target.toUpperCase() === n)
  if (t) return t
  // TH1.temp / LDR1.light — the sensor's own quantity spelled out
  const [ref, prop] = n.split(".")
  const s = targets.find((x) => x.kind === "sensor" && x.target.toUpperCase() === ref)
  if (s && prop && s.sense?.toUpperCase() === prop) return s
  return null
}

export interface ResolvedFeed { target: FeedTarget; signal: Signal; feed: Feed }

/** Compile every feed of the circuit; problems come back as messages (the run ignores bad feeds). */
export function resolveFeeds(doc: Doc, tstop: number): { feeds: Map<string, ResolvedFeed>; problems: { feed: Feed; message: string }[] } {
  const feeds = new Map<string, ResolvedFeed>()
  const problems: { feed: Feed; message: string }[] = []
  const targets = feedTargets(doc)
  for (const feed of doc.stimulus?.feeds ?? []) {
    const target = findTarget(targets, feed.target)
    if (!target) { problems.push({ feed, message: `nothing called “${feed.target}” takes a feed — inputs: ${targets.filter((t) => t.kind !== "room").map((t) => t.target).join(", ") || "none"}, room.<property>` }); continue }
    const p = parseFeedExpr(feed.expr)
    if ("error" in p) { problems.push({ feed, message: p.error }); continue }
    try {
      const signal = compileSignal(p.expr, { tstop: tstop > 0 ? tstop : 1e-3, seed: doc.stimulus?.seed ?? 1, salt: target.target })
      if (signal.unit && target.unit && signal.unit !== target.unit && !(target.unit === "lx" && signal.unit === "lux")) {
        problems.push({ feed, message: `${target.target} takes ${target.unit} (${target.quantity}), not ${signal.unit}` }); continue
      }
      if (signal.unit && !target.unit && signal.unit !== "%") { problems.push({ feed, message: `${target.target} takes a plain number (${target.quantity}), not ${signal.unit}` }); continue }
      // "30 %" for a 0…1 control (a pot position) means 0.3; for humidity / level it stays 30 %
      const sig = signal.unit === "%" && !target.unit ? { ...signal, at: (t: number) => signal.at(t) / 100, unit: undefined } : signal
      feeds.set(target.target.toUpperCase(), { target, signal: sig, feed })
    } catch (e) {
      problems.push({ feed, message: e instanceof SignalError ? e.message : String(e) })
    }
  }
  return { feeds, problems }
}

/** The signal feeding a sensor: its own feed, else the room's, else none. */
export function sensorSignal(feeds: Map<string, ResolvedFeed>, ref: string, sense: Quantity): Signal | null {
  return feeds.get(ref.toUpperCase())?.signal ?? feeds.get(`ROOM.${sense.toUpperCase()}`)?.signal ?? null
}
