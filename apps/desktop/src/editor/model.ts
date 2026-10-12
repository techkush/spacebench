// Schematic document model. Coordinates are integer GRID UNITS (1 unit =
// 1.27 mm = 12.7 px at 100 %), the grid every KiCad pin sits on, so
// connectivity never depends on floating-point comparisons.
import type { Stimulus } from "@/lib/stimulus"
import type { ComponentDef } from "@/kirk/components"
import type { Board } from "@/pcb/board"
import { getSymbol, registerBuiltin, unitLetter, type KPin, type SymbolDef } from "@/lib/kicad"

export const UNIT_PX = 12.7

export type Rot = 0 | 90 | 180 | 270
export type Pt = [number, number]

/** KiCad-style simulation fields (Sim.Device, Sim.Type, Sim.Pins, Sim.Params, Sim.Name). */
export interface SimFields {
  Device?: string
  Type?: string
  Pins?: string
  Params?: string
  Name?: string
  Library?: string
  /** "1" excludes the part from simulation */
  Exclude?: string
}

export interface Part {
  id: string
  /** reference designator shared by all units of one package: R1, U3 … */
  ref: string
  /** KiCad library id "Lib:Name" ("@:label" for net labels) */
  lib: string
  /** 1-based unit of multi-unit symbols (op-amp A/B, gate 1…4, power unit) */
  unit: number
  x: number
  y: number
  rot: Rot
  mirror?: boolean
  /** Value field: "10k", "100n", "2N3904", "+5V" … */
  value: string
  /** per-part simulation overrides (merged over the symbol's Sim.* fields) */
  sim?: SimFields
  /** net name for net labels */
  net?: string
  /** footprint override (KiCad "Lib:Footprint") */
  footprint?: string
  /** extra properties: Tolerance, Power, Tempco, Voltage … */
  fields?: Record<string, string>
}

/** A straight wire segment between two grid points. */
export interface Wire {
  id: string
  a: Pt
  b: Pt
}

export interface Analyses {
  tran: { stop: number; step: number }
  ac: { start: number; stop: number; points?: number }
  dc?: { source: string; start: number; stop: number; step: number }
}

export interface Doc {
  title: string
  description: string
  parts: Part[]
  wires: Wire[]
  analyses: Analyses
  defaultAnalysis: "tran" | "ac" | "op" | "dc"
  probes: string[]
  /** no-connect markers: pins at these points are intentionally left open */
  noConnects?: Pt[]
  /** measurements per run (Kirk expressions, e.g. frequency(V(out), at: 2.5 V)) */
  measures?: Measure[]
  /** pass/fail checks (Kirk expressions, e.g. freq in 6.5 Hz .. 7.2 Hz) */
  asserts?: string[]
  /** multimeter signal */
  dmm?: string
  /** sweeps, Monte Carlo, temperature (Simulation setup dialog / Kirk sweep statements) */
  setup?: SimSetup
  /** PCB layout: placement, tracks, vias, rules (pcb/board.ts) */
  pcb?: Board
  /** data fed to the inputs while simulating — sources, sensors, controls, the room (Kirk `stimulus { }`, lib/stimulus.ts) */
  stimulus?: Stimulus
  /** Kirk components this circuit defines or imports, with their compiled parameter sets (kirk/components.ts) */
  components?: ComponentDef[]
  /** Kirk imports: project files ("lib/filters.kirk") and user libraries ("Filters") */
  imports?: { path: string; library: boolean }[]
  /** set when the file is a library: library Filters version "1.0.0" */
  library?: { name: string; version?: string }
  /** the sketch of each programmable board in the circuit (Arduino, Pico), by reference: A1 → its files */
  firmware?: Record<string, Firmware>
  /** symbols the circuit brought with it (a KiCad schematic's own, not in the bundled library) */
  symbols?: SymbolDef[]
}

/** An Arduino sketch: `sketch.ino` and any other files, plus libraries.txt (one library per line). */
export interface Firmware { files: { name: string; content: string }[]; libraries?: string }

export interface Measure { name: string; expr: string }

export interface SweepSetup {
  enabled: boolean
  /** "R2.value" (a part's value) */
  target: string
  mode: "list" | "lin" | "dec" | "oct"
  /** list mode */
  values: string[]
  /** lin/dec/oct modes */
  start: string
  stop: string
  /** lin: total points; dec/oct: points per decade/octave */
  points: number
}

export interface SimSetup {
  sweep?: SweepSetup
  montecarlo?: { enabled: boolean; runs: number; seed: number }
  temp?: { enabled: boolean; values: string[] }
  overlay: boolean
  parallel: boolean
  keepRaw: boolean
}

export const defaultSetup = (): SimSetup => ({ overlay: true, parallel: true, keepRaw: false })

export const isLabel = (p: Pick<Part, "lib">) => p.lib === "@:label"
export const symbolFor = (p: Pick<Part, "lib">): SymbolDef | undefined => getSymbol(p.lib)
export const isPower = (p: Pick<Part, "lib">) => !!symbolFor(p)?.power
/** Parts that are only connectivity (labels, power flags/ground). */
export const isVirtual = (p: Pick<Part, "lib">) => isLabel(p) || isPower(p)

export function unitOf(p: Pick<Part, "lib" | "unit">) {
  const s = symbolFor(p)
  return s?.units[Math.min(Math.max(p.unit, 1), s.units.length) - 1]
}

/** Displayed reference: U1A for multi-unit symbols. */
export function displayRef(p: Pick<Part, "ref" | "lib" | "unit">): string {
  const s = symbolFor(p)
  return s && s.units.length > 1 ? `${p.ref}${unitLetter(p.unit)}` : p.ref
}

/** Rotate a grid point by 0/90/180/270° clockwise on screen (Y down), after an optional mirror. */
export function transform([x, y]: Pt, rot: number, mirror = false): Pt {
  if (mirror) x = -x
  switch (((rot % 360) + 360) % 360) {
    case 90: return [-y, x]
    case 180: return [-x, -y]
    case 270: return [y, -x]
    default: return [x, y]
  }
}

export interface PlacedPin extends KPin { at: Pt }

/** Visible pins of the part's unit, in world grid coordinates. */
export function placedPins(p: Part): PlacedPin[] {
  const u = unitOf(p)
  if (!u) return []
  const power = isPower(p)
  return u.pins
    .filter((q) => !q.h || power) // hidden IC power pins connect by name, not by position
    .map((q) => {
      const [dx, dy] = transform([q.x, q.y], p.rot, p.mirror)
      return { ...q, at: [p.x + dx, p.y + dy] as Pt }
    })
}

/** Hidden power_in pins of the unit (old-style ICs): they join the global net of their name. */
export function hiddenPowerPins(p: Part): KPin[] {
  const u = unitOf(p)
  return u && !isPower(p) ? u.pins.filter((q) => q.h && q.t === "power_in") : []
}

/** pin number → world position */
export function pinPositions(p: Part): Record<string, Pt> {
  return Object.fromEntries(placedPins(p).map((q) => [q.n, q.at]))
}

let seq = 0
export const uid = (prefix: string) => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`

/** Next free reference for a prefix: R1, R2… (power symbols: #PWR01…). */
export function nextRef(parts: Part[], prefix: string): string {
  const used = new Set(parts.map((p) => p.ref))
  const pad = prefix.startsWith("#") ? 2 : 0
  for (let i = 1; ; i++) {
    const r = `${prefix}${String(i).padStart(pad, "0")}`
    if (!used.has(r)) return r
  }
}

/** A new part of a symbol (caller sets id/ref/x/y). */
export function defaultPart(sym: SymbolDef, unit = 1): Omit<Part, "id" | "ref" | "x" | "y"> {
  // KiCad's generic passives carry their letter as Value ("R", "C"); start them at a usable value
  const GENERIC: Record<string, string> = { "Device:R": "1k", "Device:R_Small": "1k", "Device:R_US": "1k", "Device:C": "100n", "Device:C_Small": "100n", "Device:C_Polarized": "10u", "Device:L": "1m", "Device:L_Small": "1m", "Device:R_Potentiometer": "10k" }
  const value = sym.lib === "Simulation_SPICE" && /^[VI]DC$/.test(sym.name) ? "5" : GENERIC[sym.id] ?? sym.value
  return { lib: sym.id, unit, rot: 0, value, ...(sym.id === "@:label" ? { net: "net" } : {}) }
}

export function emptyDoc(): Doc {
  return {
    title: "Untitled circuit",
    description: "",
    parts: [],
    wires: [],
    analyses: { tran: { stop: 10e-3, step: 10e-6 }, ac: { start: 10, stop: 100e3 } },
    defaultAnalysis: "tran",
    probes: [],
  }
}

/** Every library id the document uses (to preload symbols); the symbols it carries are registered first. */
export function docSymbols(d: Doc): Set<string> {
  for (const s of d.symbols ?? []) registerBuiltin(s)
  return new Set(d.parts.map((p) => p.lib))
}
