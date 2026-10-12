// Live controls drawn on the schematic, under each input part: switches toggle with a
// click, buttons are pressed while held, pots move with − / + or the scroll wheel, and
// sensors show what they read (click opens the Room tab).
import type { PointerEvent, WheelEvent } from "react"
import { displayRef, placedPins, symbolFor, transform, unitOf, UNIT_PX, type Doc, type Part } from "@/editor/model"
import { inputParts, isClosed, isSensor, potPos, setClosed, setPotPos } from "@/editor/inputs"

export interface InputChipApi {
  /** what a sensor reads, e.g. "☀ 300 lx" (null: not a sensor) */
  reading: (part: Part) => string | null
  /** commit: one undo step · preview: live, starts a gesture · cancel: back to before the gesture */
  set: (part: Part, next: Part, mode: "commit" | "preview" | "cancel") => void
  /** open the Lab window, where sensors are fed */
  openLab: () => void
}

/** The part's box on the canvas (px), from its symbol box, rotation and mirror. */
function worldBox(p: Part): [number, number, number, number] | null {
  const u = unitOf(p)
  if (!u) return null
  const [x, y, w, h] = u.box
  const pts = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map(([a, b]) => transform([a, b], p.rot, p.mirror))
  const xs = pts.map((q) => q[0] + p.x * UNIT_PX), ys = pts.map((q) => q[1] + p.y * UNIT_PX)
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

type Box = [number, number, number, number]
const hit = (a: Box, b: Box) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]

/** What a chip must not cover: the part's name / value text and its pin ends (wires and net labels start there). */
function obstacles(p: Part): Box[] {
  const out: Box[] = []
  const sym = symbolFor(p)
  for (const [f, text, size] of [[sym?.fields.Reference, displayRef(p), 11], [sym?.fields.Value, p.value, 10]] as const) {
    if (!f || f.h || f.x === undefined) continue
    const [dx, dy] = transform([f.x / UNIT_PX, (f.y ?? 0) / UNIT_PX], p.rot, p.mirror)
    const x = (p.x + dx) * UNIT_PX, y = (p.y + dy) * UNIT_PX, w = text.length * size * 0.62
    out.push([x - w, y - 8, x + w, y + 8]) // anchor varies with justification: cover both sides
  }
  for (const pin of placedPins(p)) {
    const [x, y] = [pin.at[0] * UNIT_PX, pin.at[1] * UNIT_PX]
    out.push([x - 34, y - 12, x + 34, y + 12])
  }
  return out
}

/** Top-left of a w × 17 chip: below, above, right or left of the part — the first spot that is clear. */
function placeChip(p: Part, b: Box, w: number): [number, number] {
  const obs = obstacles(p)
  const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2
  const spots: [number, number][] = [[cx - w / 2, b[3] + 6], [cx - w / 2, b[1] - 23], [b[2] + 8, cy - 8.5], [b[0] - 8 - w, cy - 8.5], [cx - w / 2, b[3] + 30]]
  return spots.find(([x, y]) => !obs.some((o) => hit([x, y, x + w, y + 17], o))) ?? spots[0]
}

const stop = (e: PointerEvent) => e.stopPropagation()

export function InputChips({ doc, api }: { doc: Doc; api: InputChipApi }) {
  return (
    <g className="font-mono" fontSize={10.5}>
      {inputParts(doc).map(({ part, kind }) => {
        const b = worldBox(part)
        if (!b) return null
        const sensorText = isSensor(kind) ? api.reading(part) ?? "" : ""
        const width = isSensor(kind) ? sensorText.length * 6.4 + 12 : kind === "switch" ? 44 : kind === "button" ? 52 : 96
        const [left, top] = placeChip(part, b, width)
        const cx = left + width / 2
        if (isSensor(kind)) {
          const text = sensorText, w = width
          return (
            <g key={part.ref} className="cursor-pointer" onPointerDown={stop} onClick={api.openLab}>
              <title>{`${part.ref}: what it senses — click to feed it data in the Lab`}</title>
              <rect x={cx - w / 2} y={top} width={w} height={17} rx={8.5} fill="var(--popover)" stroke="var(--border)" />
              <text x={cx} y={top + 12} textAnchor="middle" fill="var(--muted-foreground)">{text}</text>
            </g>
          )
        }
        if (kind === "switch") {
          const on = isClosed(part)
          return (
            <g key={part.ref} className="cursor-pointer" onPointerDown={stop} onClick={() => api.set(part, setClosed(part, !on), "commit")}>
              <title>{`${part.ref}: click to switch ${on ? "off" : "on"}`}</title>
              <rect x={cx - 22} y={top} width={44} height={17} rx={8.5} fill={on ? "var(--success)" : "var(--popover)"} stroke={on ? "var(--success)" : "var(--border)"} />
              <circle cx={on ? cx + 13 : cx - 13} cy={top + 8.5} r={5.5} fill={on ? "#fff" : "var(--muted-foreground)"} />
              <text x={on ? cx - 5 : cx + 5} y={top + 12} textAnchor="middle" fill={on ? "#fff" : "var(--muted-foreground)"} fontWeight={600}>{on ? "ON" : "OFF"}</text>
            </g>
          )
        }
        if (kind === "button") {
          const on = isClosed(part)
          const down = (e: PointerEvent) => { e.stopPropagation(); (e.currentTarget as Element).setPointerCapture(e.pointerId); api.set(part, setClosed(part, true), "preview") }
          const up = () => api.set(part, part, "cancel")
          return (
            <g key={part.ref} className="cursor-pointer select-none" onPointerDown={down} onPointerUp={up} onPointerCancel={up}>
              <title>{`${part.ref}: hold to press`}</title>
              <rect x={cx - 26} y={top} width={52} height={17} rx={4} fill={on ? "var(--primary)" : "var(--popover)"} stroke={on ? "var(--primary)" : "var(--border)"} />
              <text x={cx} y={top + 12} textAnchor="middle" fill={on ? "var(--primary-foreground)" : "var(--foreground)"} fontWeight={600}>{on ? "PRESSED" : "PRESS"}</text>
            </g>
          )
        }
        // potentiometer / slider / knob
        const pos = potPos(part)
        const nudge = (d: number) => api.set(part, setPotPos(part, pos + d), "commit")
        const wheel = (e: WheelEvent) => { e.stopPropagation(); e.preventDefault(); nudge(e.deltaY < 0 ? 0.02 : -0.02) }
        return (
          <g key={part.ref} onPointerDown={stop} onWheel={wheel}>
            <title>{`${part.ref}: − / + or scroll to move the wiper`}</title>
            {/* [−] ━━━━━━ 80% [+] */}
            <rect x={left} y={top} width={96} height={17} rx={8.5} fill="var(--popover)" stroke="var(--border)" />
            <rect x={left + 18} y={top + 7} width={38} height={3} rx={1.5} fill="var(--muted)" />
            <rect x={left + 18} y={top + 7} width={38 * pos} height={3} rx={1.5} fill="var(--primary)" />
            <text x={left + 61} y={top + 12} fontSize={9.5} fill="var(--muted-foreground)">{Math.round(pos * 100)}%</text>
            <g className="cursor-pointer" onClick={() => nudge(-0.05)}><rect x={left} y={top} width={17} height={17} rx={8.5} fill="transparent" /><text x={left + 9} y={top + 12.5} textAnchor="middle" fontWeight={700} fill="var(--foreground)">−</text></g>
            <g className="cursor-pointer" onClick={() => nudge(0.05)}><rect x={left + 79} y={top} width={17} height={17} rx={8.5} fill="transparent" /><text x={left + 87} y={top + 12.5} textAnchor="middle" fontWeight={700} fill="var(--foreground)">+</text></g>
          </g>
        )
      })}
    </g>
  )
}
