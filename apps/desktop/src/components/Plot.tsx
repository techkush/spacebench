import { useEffect, useRef, useState } from "react"
import uPlot from "uplot"

import { formatSI } from "@/lib/units"

export interface Trace {
  label: string
  y: number[]
  color: string
  /** "y" (default) or "phase" for the secondary Bode axis */
  scale?: "y" | "phase"
  dash?: number[]
}

export interface Marker { x: number; label: string; color: string }

interface Props {
  /** vertical markers (cursors, playback time) — redrawn without rebuilding the plot */
  markers?: Marker[]
  /** click on the plot: x value, shift held */
  onPick?: (x: number, shift: boolean) => void
  /** show uPlot's legend (default true) */
  legend?: boolean
  x: number[]
  traces: Trace[]
  logX?: boolean
  xUnit: string
  yUnit: string
}

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888"

/** Thin React wrapper around uPlot: fast enough for 100k-point transients. */
export function Plot({ x, traces, logX, xUnit, yUnit, markers, onPick, legend = true }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const plot = useRef<uPlot | null>(null)
  const markersRef = useRef<Marker[]>(markers ?? [])
  const pickRef = useRef(onPick)
  pickRef.current = onPick
  useEffect(() => { markersRef.current = markers ?? []; plot.current?.redraw(false) }, [markers])
  // grid, axis and label colours come from the theme: rebuild when <html class="dark"> changes
  const [themeTick, setThemeTick] = useState(0)
  useEffect(() => {
    const mo = new MutationObserver(() => setThemeTick((n) => n + 1))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
    return () => mo.disconnect()
  }, [])

  useEffect(() => {
    const el = host.current!
    const grid = css("--chart-grid"), axis = css("--muted-foreground")
    const hasPhase = traces.some((t) => t.scale === "phase")
    const drawMarkers = (u: uPlot) => {
      const ctx = u.ctx
      const { top, height } = u.bbox
      ctx.save()
      for (const m of markersRef.current) {
        const px = u.valToPos(m.x, "x", true)
        if (!Number.isFinite(px) || px < u.bbox.left || px > u.bbox.left + u.bbox.width) continue
        ctx.strokeStyle = m.color
        ctx.lineWidth = devicePixelRatio
        ctx.setLineDash([4 * devicePixelRatio, 3 * devicePixelRatio])
        ctx.beginPath(); ctx.moveTo(px, top); ctx.lineTo(px, top + height); ctx.stroke()
        if (m.label) {
          ctx.setLineDash([])
          ctx.font = `${10 * devicePixelRatio}px Geist Mono Variable`
          const w = ctx.measureText(m.label).width + 8 * devicePixelRatio
          ctx.fillStyle = css("--popover"); ctx.fillRect(px + 2 * devicePixelRatio, top + 2 * devicePixelRatio, w, 14 * devicePixelRatio)
          ctx.strokeStyle = css("--border"); ctx.strokeRect(px + 2 * devicePixelRatio, top + 2 * devicePixelRatio, w, 14 * devicePixelRatio)
          ctx.fillStyle = css("--foreground"); ctx.fillText(m.label, px + 6 * devicePixelRatio, top + 12.5 * devicePixelRatio)
        }
      }
      ctx.restore()
    }
    const opts: uPlot.Options = {
      hooks: {
        draw: [drawMarkers],
        ready: [(u) => {
          u.over.addEventListener("click", (e) => {
            const xv = u.posToVal(e.offsetX, "x")
            if (Number.isFinite(xv)) pickRef.current?.(xv, e.shiftKey)
          })
        }],
      },
      width: el.clientWidth,
      height: el.clientHeight,
      legend: { show: legend, live: true },
      cursor: { drag: { x: true, y: false }, points: { size: 6 } },
      scales: {
        x: { time: false, distr: logX ? 3 : 1 },
        y: { auto: true },
        ...(hasPhase ? { phase: { auto: true } } : {}),
      },
      axes: [
        { stroke: axis, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, values: (_u, vals) => vals.map((v) => (v == null ? "" : formatSI(v, xUnit))), font: "11px Geist Mono Variable" },
        { stroke: axis, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, values: (_u, vals) => vals.map((v) => (v == null ? "" : formatSI(v, yUnit))), font: "11px Geist Mono Variable", size: 64 },
        ...(hasPhase ? [{ scale: "phase", side: 1 as const, stroke: axis, grid: { show: false }, values: (_u: uPlot, vals: number[]) => vals.map((v) => `${Math.round(v)}°`), font: "11px Geist Mono Variable", size: 52 }] : []),
      ],
      series: [
        { label: xUnit === "Hz" ? "f" : xUnit === "s" ? "t" : xUnit === "V" ? "V" : "x", value: (_u, v) => (v == null ? "—" : formatSI(v, xUnit, 4)) },
        ...traces.map((t) => ({
          label: t.label,
          stroke: t.color.startsWith("var(") ? css(t.color.slice(4, -1)) : t.color,
          width: 1.6,
          scale: t.scale ?? "y",
          dash: t.dash,
          value: (_u: uPlot, v: number | null) => (v == null ? "—" : t.scale === "phase" ? `${v.toFixed(1)}°` : formatSI(v, yUnit, 4)),
        })),
      ],
    }
    const data: uPlot.AlignedData = [x, ...traces.map((t) => t.y)]
    plot.current?.destroy()
    plot.current = new uPlot(opts, data, el)
    const ro = new ResizeObserver(() => plot.current?.setSize({ width: el.clientWidth, height: Math.max(80, el.clientHeight - 28) }))
    ro.observe(el)
    return () => { ro.disconnect(); plot.current?.destroy(); plot.current = null }
  }, [x, traces, logX, xUnit, yUnit, legend, themeTick])

  return <div ref={host} className="sb-plot h-full w-full" />
}
