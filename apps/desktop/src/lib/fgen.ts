// Function generator: read and write a voltage source as sine / square / triangle / DC.
import type { Part } from "@/editor/model"
import { formatParams, parseParams, parseValue } from "@/lib/spice"

export type Shape = "sine" | "square" | "triangle" | "dc"
export const SHAPES: [Shape, string][] = [["sine", "Sine"], ["square", "Square"], ["triangle", "Triangle"], ["dc", "DC"]]

export function shapeOf(part: Part): Shape {
  const name = part.lib.split(":")[1]
  if (name === "VSIN") return "sine"
  if (name === "VDC") return "dc"
  const pr = parseParams(part.sim?.Params)
  const per = parseValue(pr.per) ?? 0, tr = parseValue(pr.tr) ?? 0
  return per > 0 && tr >= per * 0.4 ? "triangle" : "square"
}

/** Amplitude/offset/frequency of a source, whatever its type. */
export function readGen(part: Part) {
  const pr = parseParams(part.sim?.Params)
  const name = part.lib.split(":")[1]
  if (name === "VSIN") return { f: parseValue(pr.f) ?? 1e3, amp: parseValue(pr.ampl) ?? 1, off: parseValue(pr.dc) ?? 0 }
  if (name === "VPULSE") {
    const y1 = parseValue(pr.y1) ?? 0, y2 = parseValue(pr.y2) ?? 1, per = parseValue(pr.per) ?? 1e-3
    return { f: 1 / per, amp: (y2 - y1) / 2, off: (y1 + y2) / 2 }
  }
  return { f: 1e3, amp: 0, off: parseValue(part.value) ?? 0 }
}

export function genPatch(part: Part, shape: Shape, g: { f: number; amp: number; off: number }): Partial<Part> {
  const pr = parseParams(part.sim?.Params)
  const ac: Record<string, string> = pr.ac ? { ac: pr.ac } : {}
  const T = 1 / Math.max(g.f, 1e-12)
  const n = (v: number) => String(Number(v.toPrecision(6)))
  if (shape === "sine") return { lib: "Simulation_SPICE:VSIN", value: "VSIN", sim: { ...part.sim, Params: formatParams({ dc: n(g.off), ampl: n(g.amp), f: n(g.f), ...ac }) } }
  if (shape === "dc") return { lib: "Simulation_SPICE:VDC", value: n(g.off), sim: { ...part.sim, Params: undefined } }
  const edge = shape === "triangle" ? T / 2 : T / 1000
  const width = shape === "triangle" ? 0 : T / 2 - edge
  return { lib: "Simulation_SPICE:VPULSE", value: "VPULSE", sim: { ...part.sim, Params: formatParams({ y1: n(g.off - g.amp), y2: n(g.off + g.amp), td: "0", tr: n(edge), tf: n(edge), tw: n(width), per: n(T), ...ac }) } }
}

