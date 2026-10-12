// The logic analyser's capture: level changes per pin (seconds, 0 / 1 / 2 = floating), kept for
// the last `keep` seconds; measurements; export as VCD (GTKWave, PulseView, sigrok).

export class LogicBuffer {
  readonly channels = new Map<string, { t: number; l: number }[]>()
  pins: string[] = []
  now = 0
  keep = 30
  version = 0

  reset() { this.channels.clear(); this.pins = []; this.now = 0; this.version++ }

  push(events: [string, number, number][], pins: string[], now: number) {
    this.pins = pins
    for (const [pin, t, l] of events) {
      let ch = this.channels.get(pin)
      if (!ch) this.channels.set(pin, (ch = []))
      ch.push({ t, l })
    }
    this.now = now
    // forget what is older than `keep`, but keep each channel's level at the cut
    const cut = now - this.keep
    for (const ch of this.channels.values()) {
      let i = 0
      while (i < ch.length - 1 && ch[i + 1].t < cut) i++
      if (i > 0) ch.splice(0, i)
    }
    this.version++
  }

  /** Level of a pin at time t. */
  levelAt(pin: string, t: number): number {
    const ch = this.channels.get(pin)
    if (!ch?.length) return 2
    let lo = 0, hi = ch.length - 1
    if (t < ch[0].t) return 2
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ch[m].t <= t) lo = m; else hi = m - 1 }
    return ch[lo].l
  }

  /** Frequency, duty and pulse width over [t0, t1] from rising / falling edges. */
  measure(pin: string, t0: number, t1: number): { freq: number | null; duty: number | null; edges: number } {
    const ch = (this.channels.get(pin) ?? []).filter((e) => e.t >= t0 && e.t <= t1)
    const rises = ch.filter((e, i) => e.l === 1 && (i === 0 ? this.levelAt(pin, e.t - 1e-12) !== 1 : ch[i - 1].l !== 1)).map((e) => e.t)
    let high = 0, prevT = t0, prevL = this.levelAt(pin, t0)
    for (const e of ch) { if (prevL === 1) high += e.t - prevT; prevT = e.t; prevL = e.l }
    if (prevL === 1) high += t1 - prevT
    const freq = rises.length >= 2 ? (rises.length - 1) / (rises[rises.length - 1] - rises[0]) : null
    return { freq, duty: t1 > t0 ? high / (t1 - t0) : null, edges: ch.length }
  }

  /** Value Change Dump of the capture (1 ns resolution). */
  toVCD(pins = this.pins, title = "Space Bench"): string {
    const ids = pins.map((_, i) => String.fromCharCode(33 + (i % 90)) + (i >= 90 ? String(Math.floor(i / 90)) : ""))
    const head = [
      `$date ${new Date().toISOString()} $end`, `$version ${title} logic analyser $end`, "$timescale 1ns $end", "$scope module board $end",
      ...pins.map((p, i) => `$var wire 1 ${ids[i]} ${p.replace(/\s/g, "_")} $end`), "$upscope $end", "$enddefinitions $end",
    ]
    const events: [number, number, number][] = []
    pins.forEach((p, i) => { for (const e of this.channels.get(p) ?? []) events.push([Math.round(e.t * 1e9), i, e.l]) })
    events.sort((a, b) => a[0] - b[0])
    const body: string[] = []
    let last = -1
    const ch = (l: number) => (l === 1 ? "1" : l === 0 ? "0" : "z")
    for (const [t, i, l] of events) { if (t !== last) { body.push(`#${t}`); last = t } body.push(`${ch(l)}${ids[i]}`) }
    return [...head, ...body, ""].join("\n")
  }
}
