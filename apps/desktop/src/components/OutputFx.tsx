// What output devices do, drawn on the schematic while simulated values are shown:
// a glow behind lit LEDs and lamps, sound waves from speakers, a turning rotor in motors.
// Coordinates are the symbol's own (inside the part transform), so it follows rotation.
import type { OutputState } from "@/editor/outputs"

type Box = [number, number, number, number]

/** Behind the symbol: the light. */
export function OutputGlow({ s, box, id }: { s: OutputState; box: Box; id: string }) {
  if ((s.kind !== "led" && s.kind !== "lamp") || s.level <= 0.01) return null
  const [x, y, w, h] = box
  const cx = x + w / 2, cy = y + h / 2, r = Math.max(w, h) * (0.55 + 0.35 * s.level)
  return (
    <g className="pointer-events-none">
      <defs>
        <radialGradient id={`glow-${id}`}>
          <stop offset="0%" stopColor={s.color} stopOpacity={0.95} />
          <stop offset="35%" stopColor={s.color} stopOpacity={0.55} />
          <stop offset="100%" stopColor={s.color} stopOpacity={0} />
        </radialGradient>
      </defs>
      <circle cx={cx} cy={cy} r={r} fill={`url(#glow-${id})`} opacity={0.25 + 0.75 * s.level} />
    </g>
  )
}

/** In front of the symbol: lit body tint, warning ring, sound waves, rotor. */
export function OutputMarks({ s, box }: { s: OutputState; box: Box }) {
  const [x, y, w, h] = box
  const cx = x + w / 2, cy = y + h / 2
  if (s.kind === "led" || s.kind === "lamp") {
    if (s.level <= 0.01 && !s.overdriven) return null
    return (
      <g className="pointer-events-none">
        <circle cx={cx} cy={cy} r={Math.min(w, h) * 0.32} fill={s.color} opacity={0.35 * s.level} style={{ mixBlendMode: "screen" }} />
        {s.overdriven && <circle cx={cx} cy={cy} r={Math.max(w, h) * 0.75} fill="none" stroke="var(--destructive)" strokeWidth={1.5} strokeDasharray="3 3"><title>Over 30 mA — a real LED would burn out. Add or increase its series resistor.</title></circle>}
      </g>
    )
  }
  if (s.kind === "speaker" || s.kind === "buzzer") {
    if (s.level <= 0.02) return null
    const r0 = Math.max(w, h) * 0.55
    return (
      <g className="pointer-events-none" stroke={s.color} strokeWidth={2} fill="none" strokeLinecap="round" opacity={0.4 + 0.6 * s.level}>
        {[0, 1, 2].map((k) => (
          <path key={k} className="sb-wave" style={{ animationDelay: `${k * 0.3}s` }}
            d={`M ${cx + r0 + k * 7} ${cy - 9 - k * 4} Q ${cx + r0 + 7 + k * 9} ${cy} ${cx + r0 + k * 7} ${cy + 9 + k * 4}`} />
        ))}
      </g>
    )
  }
  // motor: a rotor bar, faster with more current, direction by sign
  if (s.level <= 0.01) return null
  const r = Math.min(w, h) * 0.28
  return (
    <g className="sb-spin" style={{ transformOrigin: `${cx}px ${cy}px`, animationDuration: `${(1.6 - 1.4 * s.level).toFixed(2)}s`, animationDirection: s.current < 0 ? "reverse" : "normal" }}>
      <line x1={cx - r} y1={cy} x2={cx + r} y2={cy} stroke={s.color} strokeWidth={2.5} strokeLinecap="round" />
      <circle cx={cx + r} cy={cy} r={2.5} fill={s.color} />
    </g>
  )
}
