// Small SVG charts for what uPlot doesn't do: bars (FFT, histograms) and X–Y curves.
import { formatSI } from "@/lib/units"

function ticks(lo: number, hi: number, n = 5): number[] {
  if (!(hi > lo)) return [lo]
  const raw = (hi - lo) / n
  const p = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? raw
  const out: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)))
  return out
}

const W = 1000, H = 260, L = 56, R = 16, T = 14, B = 30

interface Frame { x0: number; x1: number; y0: number; y1: number; xUnit: string; yUnit: string; children: React.ReactNode; className?: string; title?: string }

function ChartFrame({ x0, x1, y0, y1, xUnit, yUnit, children, className, title }: Frame) {
  const sx = (v: number) => L + ((v - x0) / (x1 - x0 || 1)) * (W - L - R)
  const sy = (v: number) => H - B - ((v - y0) / (y1 - y0 || 1)) * (H - T - B)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={className} preserveAspectRatio="none" role="img" aria-label={title}>
      {ticks(y0, y1).map((v) => (
        <g key={`y${v}`}>
          <line x1={L} x2={W - R} y1={sy(v)} y2={sy(v)} stroke="var(--chart-grid)" vectorEffect="non-scaling-stroke" />
          <text x={L - 6} y={sy(v)} textAnchor="end" dominantBaseline="central" fontSize={11} fill="var(--muted-foreground)" className="font-mono">{formatSI(v, yUnit, 3)}</text>
        </g>
      ))}
      {ticks(x0, x1, 8).map((v) => (
        <g key={`x${v}`}>
          <line x1={sx(v)} x2={sx(v)} y1={T} y2={H - B} stroke="var(--chart-grid)" vectorEffect="non-scaling-stroke" />
          <text x={sx(v)} y={H - B + 16} textAnchor="middle" fontSize={11} fill="var(--muted-foreground)" className="font-mono">{formatSI(v, xUnit, 3)}</text>
        </g>
      ))}
      <g>{children}</g>
    </svg>
  )
}

export interface Bar { x: number; w: number; y: number; color?: string; label?: string }

/** Bars (FFT stems, histogram bins) with optional vertical marker lines. */
export function BarChart({ bars, xUnit, yUnit, markers = [], className, x0, x1 }: { bars: Bar[]; xUnit: string; yUnit: string; markers?: { x: number; label: string; color: string }[]; className?: string; x0?: number; x1?: number }) {
  if (!bars.length) return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">No data</div>
  const lo = x0 ?? Math.min(...bars.map((b) => b.x - b.w / 2)), hi = x1 ?? Math.max(...bars.map((b) => b.x + b.w / 2))
  const ymax = Math.max(...bars.map((b) => b.y)) * 1.1 || 1
  const sx = (v: number) => L + ((v - lo) / (hi - lo || 1)) * (W - L - R)
  const sy = (v: number) => H - B - (v / ymax) * (H - T - B)
  return (
    <ChartFrame x0={lo} x1={hi} y0={0} y1={ymax} xUnit={xUnit} yUnit={yUnit} className={className}>
      {bars.map((b, i) => (
        <rect key={i} x={sx(b.x - b.w / 2) + 0.5} width={Math.max(1.5, sx(b.x + b.w / 2) - sx(b.x - b.w / 2) - 1)} y={sy(b.y)} height={Math.max(0, sy(0) - sy(b.y))} fill={b.color ?? "var(--chart-1)"}>
          {b.label && <title>{b.label}</title>}
        </rect>
      ))}
      {markers.map((m, i) => (
        <g key={`m${i}`}>
          <line x1={sx(m.x)} x2={sx(m.x)} y1={T} y2={H - B} stroke={m.color} strokeDasharray="5 4" strokeWidth={1.4} vectorEffect="non-scaling-stroke" />
          <text x={sx(m.x) + 4} y={T + 12} fontSize={11} fill={m.color} className="font-mono">{m.label}</text>
        </g>
      ))}
    </ChartFrame>
  )
}

/** X–Y plot (Lissajous figures, transfer curves): one polyline per series. */
export function XYChart({ series, xUnit, yUnit, className }: { series: { x: number[]; y: number[]; color: string; label: string }[]; xUnit: string; yUnit: string; className?: string }) {
  const all = series.filter((s) => s.x.length)
  if (!all.length) return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Choose X and Y signals</div>
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (const s of all) for (let i = 0; i < s.x.length; i++) { x0 = Math.min(x0, s.x[i]); x1 = Math.max(x1, s.x[i]); y0 = Math.min(y0, s.y[i]); y1 = Math.max(y1, s.y[i]) }
  const padY = (y1 - y0) * 0.05 || 1, padX = (x1 - x0) * 0.02 || 1
  ;[x0, x1, y0, y1] = [x0 - padX, x1 + padX, y0 - padY, y1 + padY]
  const sx = (v: number) => L + ((v - x0) / (x1 - x0)) * (W - L - R)
  const sy = (v: number) => H - B - ((v - y0) / (y1 - y0)) * (H - T - B)
  return (
    <ChartFrame x0={x0} x1={x1} y0={y0} y1={y1} xUnit={xUnit} yUnit={yUnit} className={className}>
      {all.map((s, k) => {
        const step = Math.max(1, Math.floor(s.x.length / 4000))
        const pts: string[] = []
        for (let i = 0; i < s.x.length; i += step) pts.push(`${sx(s.x[i]).toFixed(1)},${sy(s.y[i]).toFixed(1)}`)
        return <polyline key={k} points={pts.join(" ")} fill="none" stroke={s.color} strokeWidth={1.6} vectorEffect="non-scaling-stroke"><title>{s.label}</title></polyline>
      })}
    </ChartFrame>
  )
}
