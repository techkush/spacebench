// Read-only drawing of a whole circuit (example previews, file dialogs).
import { isLabel, unitOf, UNIT_PX, type Doc } from "@/editor/model"
import { partTransform, UnitArt } from "./SymbolView"

export function CircuitThumb({ doc, className }: { doc: Doc; className?: string }) {
  const xs: number[] = [], ys: number[] = []
  for (const w of doc.wires) for (const p of [w.a, w.b]) { xs.push(p[0]); ys.push(p[1]) }
  for (const p of doc.parts) {
    const u = unitOf(p)
    const r = u ? Math.max(Math.abs(u.box[0]), Math.abs(u.box[1]), Math.abs(u.box[0] + u.box[2]), Math.abs(u.box[1] + u.box[3])) / UNIT_PX : 3
    xs.push(p.x - r, p.x + r); ys.push(p.y - r, p.y + r)
  }
  if (!xs.length) return <svg className={className} />
  const pad = 2
  const [x0, x1, y0, y1] = [Math.min(...xs) - pad, Math.max(...xs) + pad, Math.min(...ys) - pad, Math.max(...ys) + pad].map((v) => v * UNIT_PX)
  return (
    <svg viewBox={`${x0} ${y0} ${x1 - x0} ${y1 - y0}`} className={className} preserveAspectRatio="xMidYMid meet">
      {doc.wires.map((w) => <line key={w.id} x1={w.a[0] * UNIT_PX} y1={w.a[1] * UNIT_PX} x2={w.b[0] * UNIT_PX} y2={w.b[1] * UNIT_PX} stroke="var(--canvas-wire)" strokeWidth={2.4} strokeLinecap="round" />)}
      {doc.parts.map((p) => {
        const u = unitOf(p)
        if (!u) return null
        return (
          <g key={p.id} style={{ color: isLabel(p) ? "var(--chart-5)" : "var(--canvas-symbol)" }}>
            <g transform={partTransform(p)}><UnitArt unit={u} /></g>
            {isLabel(p) && <text x={p.x * UNIT_PX + 22} y={p.y * UNIT_PX - 13} fontSize={11} fontWeight={600} fill="var(--chart-5)">{p.net}</text>}
          </g>
        )
      })}
    </svg>
  )
}
