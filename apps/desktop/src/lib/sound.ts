// Speakers and buzzers in a transient play through the computer: the simulated current
// through the device becomes an audio buffer at real pitch (simulated seconds = real
// seconds), looped while the playback runs.
import type { TranResult } from "./engine"

const RATE = 44100
const MAX_SECONDS = 10

/** Signal → audio samples at RATE, trimmed to whole periods so the loop has no click, normalised. */
export function toAudio(time: number[], y: number[], level: number): Float32Array | null {
  if (time.length < 4) return null
  const t0 = time[0], span = Math.min(time[time.length - 1] - t0, MAX_SECONDS)
  const n = Math.floor(span * RATE)
  if (n < 64) return null
  const mean = y.reduce((s, v) => s + v, 0) / y.length
  const out = new Float32Array(n)
  let j = 0
  for (let k = 0; k < n; k++) {
    const t = t0 + k / RATE
    while (j < time.length - 2 && time[j + 1] < t) j++
    const f = (t - time[j]) / (time[j + 1] - time[j] || 1)
    out[k] = y[j] + (y[j + 1] - y[j]) * Math.min(1, Math.max(0, f)) - mean
  }
  // loop on rising zero crossings: first one to last one
  const ups: number[] = []
  for (let k = 1; k < n; k++) if (out[k - 1] < 0 && out[k] >= 0) ups.push(k)
  const seg = ups.length >= 2 && ups[ups.length - 1] - ups[0] > RATE * 0.02 ? out.subarray(ups[0], ups[ups.length - 1]) : out
  const peak = seg.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
  if (peak < 1e-9) return null
  const gain = (0.05 + 0.3 * level) / peak
  return Float32Array.from(seg, (v) => v * gain)
}

let ctx: AudioContext | null = null
// browsers start audio suspended until the user interacts; unlock on the first click / key
if (typeof document !== "undefined") {
  const unlock = () => { ctx ??= new AudioContext(); if (ctx.state === "suspended") ctx.resume().catch(() => {}) }
  document.addEventListener("pointerdown", unlock, { capture: true, once: true })
  document.addEventListener("keydown", unlock, { capture: true, once: true })
}
let playing: { src: AudioBufferSourceNode; key: string } | null = null

/** Play (loop) the sound of these devices; replaces whatever was playing. Null stops. */
export function playOutputs(r: TranResult | null, refs: { ref: string; level: number }[], key: string) {
  if (playing?.key === key) return
  stopOutputs()
  if (!r || !refs.length) return
  const tracks = refs.map(({ ref, level }) => {
    const k = r.names.indexOf(`I(${ref})`)
    return k < 0 ? null : toAudio(r.time, r.data[k], level)
  }).filter((x): x is Float32Array => !!x)
  if (!tracks.length) return
  const len = Math.max(...tracks.map((t) => t.length))
  const mix = new Float32Array(len)
  for (const t of tracks) for (let k = 0; k < len; k++) mix[k] += t[k % t.length] / tracks.length
  ctx ??= new AudioContext()
  if (ctx.state === "suspended") ctx.resume().catch(() => {})
  const buf = ctx.createBuffer(1, len, RATE)
  buf.copyToChannel(mix, 0)
  const src = ctx.createBufferSource()
  src.buffer = buf
  src.loop = true
  src.connect(ctx.destination)
  src.start()
  playing = { src, key }
}

export function stopOutputs() {
  if (!playing) return
  try { playing.src.stop() } catch { /* already stopped */ }
  playing.src.disconnect()
  playing = null
}

/** For the UI and tests: is a sound looping, and is audio allowed to play yet. */
export const soundState = () => ({ playing: !!playing, key: playing?.key ?? null, audio: ctx?.state ?? "not started" })
