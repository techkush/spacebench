// Real-time mode: replay a transient result as a moving time cursor, so wire
// colours, voltage tags, current flow and readings animate with the circuit.
import { useCallback, useEffect, useRef, useState } from "react"

import type { JobResult, TranResult } from "@/lib/engine"

/** Playback speeds: simulated seconds per real second ("fit" plays the whole run in ~4 s). */
export const SPEEDS = ["fit", "1", "0.1", "0.01", "0.001"] as const
export type Speed = (typeof SPEEDS)[number]
export const speedLabel = (s: Speed) => (s === "fit" ? "Fit (4 s)" : `${s}× real time`)

/** Index of the last sample at or before t. */
export function sampleIndex(time: number[], t: number): number {
  let lo = 0, hi = time.length - 1
  if (t <= time[0]) return 0
  if (t >= time[hi]) return hi
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (time[mid] <= t) lo = mid; else hi = mid
  }
  return lo
}

/** Every signal of a transient result at time t (linear interpolation). */
export function valuesAt(r: TranResult, t: number): Record<string, number> {
  const i = sampleIndex(r.time, t)
  const j = Math.min(i + 1, r.time.length - 1)
  const f = j > i ? (t - r.time[i]) / (r.time[j] - r.time[i]) : 0
  const out: Record<string, number> = {}
  r.names.forEach((n, k) => { out[n] = r.data[k][i] + (r.data[k][j] - r.data[k][i]) * Math.min(1, Math.max(0, f)) })
  return out
}

export interface Playback {
  /** current simulated time, or null when not playing a transient */
  t: number | null
  playing: boolean
  speed: Speed
  setSpeed: (s: Speed) => void
  play: () => void
  pause: () => void
  stop: () => void
  seek: (t: number) => void
}

/**
 * `autoplay` (real-time mode) starts playback whenever a new transient arrives.
 * Stop holds playback at t = 0 until Play is pressed again; Play with no
 * transient yet asks the caller to run one and plays it when it arrives.
 */
export function usePlayback(result: JobResult | null, autoplay: boolean): Playback {
  const tran = result?.type === "tran" ? result : null
  const [t, setT] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<Speed>("fit")
  const tRef = useRef(0)
  const stopped = useRef(false)
  const pendingPlay = useRef(false)
  const end = tran ? tran.time[tran.time.length - 1] : 0
  const start = tran ? tran.time[0] : 0

  useEffect(() => {
    if (!tran) { setT(null); setPlaying(false); return }
    tRef.current = Math.min(Math.max(tRef.current, start), end)
    if (pendingPlay.current || (autoplay && !stopped.current)) {
      pendingPlay.current = false
      stopped.current = false
      setT(tRef.current)
      setPlaying(true)
    } else if (stopped.current) {
      setT(tRef.current) // stopped: hold the clock where Stop put it
      setPlaying(false)
    } else {
      setT(null) // accurate mode: show end-of-run values until Play
      setPlaying(false)
    }
  }, [tran, autoplay, start, end])

  useEffect(() => {
    if (!playing || !tran) return
    const rate = speed === "fit" ? (end - start) / 4 : Number(speed)
    let last = performance.now()
    let frame = 0
    let raf = 0
    const tick = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      let next = tRef.current + dt * rate
      if (next > end) next = start + ((next - start) % Math.max(end - start, 1e-15)) // loop
      tRef.current = next
      if (++frame % 2 === 0) setT(next) // ~30 fps is plenty
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, tran, speed, start, end])

  const play = useCallback(() => {
    stopped.current = false
    if (tran) { setT(tRef.current); setPlaying(true) } else pendingPlay.current = true
  }, [tran])
  const pause = useCallback(() => setPlaying(false), [])
  const stop = useCallback(() => {
    stopped.current = true
    pendingPlay.current = false
    setPlaying(false)
    tRef.current = start
    setT(tran ? start : null)
  }, [start, tran])
  const seek = useCallback((x: number) => { tRef.current = Math.min(Math.max(x, start), end); setT(tRef.current) }, [start, end])
  return { t, playing, speed, setSpeed, play, pause, stop, seek }
}
