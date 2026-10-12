// Data collection (Instruments & data panel): while recording, every transient
// result is captured — aligned on a trigger — into a buffer that exports as CSV.
import { useSyncExternalStore } from "react"

import type { TranResult } from "@/lib/engine"
import { crossings } from "@/lib/measure"

export interface Trigger { signal: string | null; level: number; rising: boolean; /** fraction of the window kept before the trigger */ pre: number }
export interface Frame { label: string; at: number; triggered: boolean; time: number[]; cols: Record<string, number[]> }
export interface RecorderState { recording: boolean; started: number | null; stopped: number | null; signals: string[]; trigger: Trigger; frames: Frame[] }

let state: RecorderState = { recording: false, started: null, stopped: null, signals: [], trigger: { signal: null, level: 0, rising: true, pre: 0.1 }, frames: [] }
const listeners = new Set<() => void>()
const set = (s: Partial<RecorderState>) => { state = { ...state, ...s }; listeners.forEach((l) => l()) }

export const getRecorder = () => state
export function useRecorder(): RecorderState {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l) } }, () => state)
}

export function startRecording(signals: string[], trigger: Partial<Trigger> = {}) {
  set({ recording: true, started: Date.now(), stopped: null, signals, trigger: { ...state.trigger, ...trigger }, frames: [] })
}
export function stopRecording() { set({ recording: false, stopped: Date.now() }) }
export function setTrigger(t: Partial<Trigger>) { set({ trigger: { ...state.trigger, ...t } }) }
export function setSignals(signals: string[]) { set({ signals }) }

/** Cut one transient to the trigger window and keep the recorded signals. */
export function captureFrame(r: TranResult, label: string, s: RecorderState = state): Frame | null {
  const sigs = s.signals.filter((n) => r.names.includes(n))
  if (!sigs.length || r.time.length < 2) return null
  let from = 0, triggered = false
  const tr = s.trigger
  if (tr.signal && r.names.includes(tr.signal)) {
    const y = r.data[r.names.indexOf(tr.signal)]
    const tc = crossings(r.time, y, tr.level, tr.rising)[0]
    if (tc !== undefined) {
      triggered = true
      const span = r.time[r.time.length - 1] - r.time[0]
      const t0 = Math.max(r.time[0], tc - tr.pre * span)
      from = Math.max(0, r.time.findIndex((t) => t >= t0))
    }
  }
  const time = r.time.slice(from)
  const cols = Object.fromEntries(sigs.map((n) => [n, r.data[r.names.indexOf(n)].slice(from)]))
  return { label, at: Date.now(), triggered, time, cols }
}

export function addFrame(r: TranResult, label: string) {
  if (!state.recording) return
  const f = captureFrame(r, label)
  if (f) set({ frames: [...state.frames, f].slice(-200) })
}

/** Bytes held in the buffer (8 bytes per sample). */
export const bufferBytes = (s: RecorderState) => s.frames.reduce((b, f) => b + f.time.length * (1 + Object.keys(f.cols).length) * 8, 0)

/** One CSV: frame, label, triggered, time, then one column per signal. */
export function recordingCsv(s: RecorderState = state): string {
  const sigs = s.signals
  const head = ["frame", "label", "triggered", "time_s", ...sigs].join(",")
  const rows: string[] = [head]
  s.frames.forEach((f, k) => {
    for (let j = 0; j < f.time.length; j++) {
      rows.push([k + 1, `"${f.label.replace(/"/g, "'")}"`, f.triggered ? 1 : 0, f.time[j].toPrecision(9), ...sigs.map((n) => (f.cols[n] ? f.cols[n][j].toPrecision(9) : ""))].join(","))
    }
  })
  return rows.join("\n")
}
