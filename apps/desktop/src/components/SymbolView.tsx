// Rendering of KiCad symbol units: on the canvas (transformed) and as
// thumbnails/previews (fitted into a box).
import { memo } from "react"

import { displayRef, transform, UNIT_PX, unitOf, type Part, type Pt } from "@/editor/model"
import type { KField, KUnit, SymbolDef } from "@/lib/kicad"
import { parseParams } from "@/lib/spice"
import { cn } from "@/lib/utils"

/** The unit's artwork in local px coordinates (no transform). */
export const UnitArt = memo(function UnitArt({ unit }: { unit: KUnit }) {
  return <g className="ksym" dangerouslySetInnerHTML={{ __html: unit.svg }} />
})

export const partTransform = (p: Pick<Part, "x" | "y" | "rot" | "mirror">) =>
  `translate(${p.x * UNIT_PX} ${p.y * UNIT_PX}) rotate(${p.rot})${p.mirror ? " scale(-1 1)" : ""}`

/** Fitted preview of a symbol unit. */
export function SymbolThumb({ sym, unit = 1, className, pad = 10 }: { sym: SymbolDef | undefined; unit?: number; className?: string; pad?: number }) {
  const u = sym?.units[Math.min(unit, sym.units.length) - 1]
  if (!u) return <svg className={cn("text-muted-foreground", className)} viewBox="0 0 10 10" />
  const [x, y, w, h] = u.box
  const size = Math.max(w, h, 40)
  const cx = x + w / 2, cy = y + h / 2
  return (
    <svg viewBox={`${cx - size / 2 - pad} ${cy - size / 2 - pad} ${size + 2 * pad} ${size + 2 * pad}`} className={cn("text-canvas-symbol", className)}>
      <UnitArt unit={u} />
    </svg>
  )
}

/** Short description of a source's waveform from Sim.Params. */
export function sourceSummary(part: Part, sym: SymbolDef | undefined): string | null {
  if (sym?.lib !== "Simulation_SPICE" || !/^[VI]/.test(sym.name)) return null
  const p = parseParams(part.sim?.Params ?? sym.sim?.Params)
  const u = sym.name.startsWith("I") ? "A" : "V"
  const n = (k: string) => (p[k] !== undefined ? p[k] : "?")
  switch (sym.name.slice(1)) {
    case "DC": return `${part.value}${/[a-zA-Z]$/.test(part.value) ? "" : ` ${u}`} DC`
    case "SIN": return `SIN ${n("ampl")}${u} ${n("f")}Hz${p.dc && p.dc !== "0" ? ` +${p.dc}${u}` : ""}`
    case "PULSE": return `PULSE ${n("y1")}→${n("y2")}${u} T=${n("per")}s`
    case "EXP": return `EXP ${n("y1")}→${n("y2")}${u}`
    case "PWL": return "PWL"
    default: return null
  }
}

interface FieldsProps {
  part: Part
  sym: SymbolDef
  color: string
}

/** Reference and value texts at the symbol's field positions, kept upright. */
export function PartFields({ part, sym, color }: FieldsProps) {
  const lines: { f: KField | undefined; text: string; kind: "ref" | "value" }[] = []
  if (!sym.power) lines.push({ f: sym.fields.Reference, text: displayRef(part), kind: "ref" })
  const summary = sourceSummary(part, sym)
  if (!sym.fields.Value?.h || sym.power) lines.push({ f: sym.fields.Value, text: summary ?? part.value, kind: "value" })
  return (
    <>
      {lines.map(({ f, text, kind }) => {
        if (f?.h) return null
        const local: Pt = f?.x !== undefined ? [f.x / UNIT_PX, (f.y ?? 0) / UNIT_PX] : [3, kind === "ref" ? -1 : 1]
        const [dx, dy] = transform(local, part.rot, part.mirror)
        const x = (part.x + dx) * UNIT_PX, y = (part.y + dy) * UNIT_PX
        // keep text horizontal; anchor away from the body
        const just = f?.j ?? ""
        const leftJust = /left/.test(just), rightJust = /right/.test(just)
        const flip = part.rot === 180 !== !!part.mirror
        const anchor = part.rot === 90 || part.rot === 270 ? (dx > 0.5 ? "start" : dx < -0.5 ? "end" : "middle")
          : leftJust ? (flip ? "end" : "start") : rightJust ? (flip ? "start" : "end") : "middle"
        return (
          <text key={kind} x={x} y={y} textAnchor={anchor} dominantBaseline="central"
            className={cn("pointer-events-none select-none", kind === "ref" ? "font-sans font-semibold" : "font-mono")}
            fill={kind === "ref" ? color : "var(--muted-foreground)"} fontSize={kind === "ref" ? 11 : 10}>
            {text}
          </text>
        )
      })}
    </>
  )
}

export { unitOf }
