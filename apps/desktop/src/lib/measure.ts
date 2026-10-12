// Display-side measurements on engine results (mirrors sb_engine::measure).

export function crossings(t: number[], y: number[], level: number, rising = true): number[] {
  const out: number[] = []
  for (let i = 1; i < y.length; i++) {
    const a = y[i - 1], b = y[i]
    if (rising ? a < level && b >= level : a > level && b <= level) out.push(t[i - 1] + ((level - a) / (b - a)) * (t[i] - t[i - 1]))
  }
  return out
}

export function stats(t: number[], y: number[]) {
  let mn = Infinity, mx = -Infinity, area = 0, sq = 0
  for (let i = 0; i < y.length; i++) {
    mn = Math.min(mn, y[i]); mx = Math.max(mx, y[i])
    if (i) { const dt = t[i] - t[i - 1]; area += 0.5 * (y[i] + y[i - 1]) * dt; sq += 0.5 * (y[i] ** 2 + y[i - 1] ** 2) * dt }
  }
  const span = t[t.length - 1] - t[0] || 1
  const mid = (mn + mx) / 2
  const c = crossings(t, y, mid)
  const use = c.length >= 3 ? c.slice(1) : c
  const freq = use.length >= 2 && mx - mn > 1e-9 ? (use.length - 1) / (use[use.length - 1] - use[0]) : NaN
  return { min: mn, max: mx, pp: mx - mn, avg: area / span, rms: Math.sqrt(sq / span), freq }
}

export function db(re: number, im: number) {
  return 20 * Math.log10(Math.max(Math.hypot(re, im), 1e-300))
}

/** First −3 dB corner relative to the lowest-frequency gain (log-interpolated). */
export function corner(f: number[], mag: number[]): number {
  const target = mag[0] - 3.0103
  for (let i = 1; i < mag.length; i++) {
    if (mag[i - 1] >= target && mag[i] < target) {
      const fr = (target - mag[i - 1]) / (mag[i] - mag[i - 1])
      return 10 ** (Math.log10(f[i - 1]) + fr * (Math.log10(f[i]) - Math.log10(f[i - 1])))
    }
  }
  return NaN
}

/** Fraction of each period spent above the mid level (from rising/falling mid crossings). */
export function duty(t: number[], y: number[]): number {
  let mn = Infinity, mx = -Infinity
  for (const v of y) { mn = Math.min(mn, v); mx = Math.max(mx, v) }
  if (!(mx - mn > 1e-9)) return NaN
  const mid = (mn + mx) / 2
  const up = crossings(t, y, mid, true), down = crossings(t, y, mid, false)
  if (up.length < 2) return NaN
  let high = 0, total = 0
  for (let k = 0; k + 1 < up.length; k++) {
    const fall = down.find((d) => d > up[k] && d < up[k + 1])
    if (fall === undefined) continue
    high += fall - up[k]
    total += up[k + 1] - up[k]
  }
  return total ? high / total : NaN
}

/** 10 %–90 % rise time of the first full rising edge. */
export function riseTime(t: number[], y: number[]): number {
  let mn = Infinity, mx = -Infinity
  for (const v of y) { mn = Math.min(mn, v); mx = Math.max(mx, v) }
  if (!(mx - mn > 1e-9)) return NaN
  const lo = mn + 0.1 * (mx - mn), hi = mn + 0.9 * (mx - mn)
  const a = crossings(t, y, lo, true), b = crossings(t, y, hi, true)
  for (const x of a) { const y90 = b.find((v) => v >= x); if (y90 !== undefined) return y90 - x }
  return NaN
}
