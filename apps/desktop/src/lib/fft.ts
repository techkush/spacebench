// Spectrum of a transient waveform: resample to a uniform grid, window, FFT,
// single-sided amplitude spectrum, fundamental + harmonics, THD.

export type Window = "hann" | "rect" | "blackman"

export interface Spectrum {
  f: number[]
  amp: number[]
  /** sample rate of the resampled signal */
  fs: number
  n: number
  dc: number
  fundamental: { f: number; amp: number } | null
  harmonics: { k: number; f: number; amp: number }[]
  /** total harmonic distortion (harmonics 2…10 over the fundamental), as a ratio */
  thd: number
}

function fftInPlace(re: Float64Array, im: Float64Array) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]] }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang), wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr
        re[b] = re[a] - tr; im[b] = im[a] - ti
        re[a] += tr; im[a] += ti
        const nr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = nr
      }
    }
  }
}

function win(kind: Window, n: number): Float64Array {
  const w = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const x = (2 * Math.PI * i) / (n - 1)
    w[i] = kind === "rect" ? 1 : kind === "hann" ? 0.5 - 0.5 * Math.cos(x) : 0.42 - 0.5 * Math.cos(x) + 0.08 * Math.cos(2 * x)
  }
  return w
}

export function spectrum(t: number[], y: number[], opts: { from?: number; to?: number; window?: Window; harmonics?: number } = {}): Spectrum {
  const t0 = Math.max(opts.from ?? t[0], t[0]), t1 = Math.min(opts.to ?? t[t.length - 1], t[t.length - 1])
  const inWindow = t.filter((x) => x >= t0 && x <= t1).length
  let n = 1024
  while (n < Math.min(65536, Math.max(inWindow, 1024))) n <<= 1
  const dt = (t1 - t0) / n
  const re = new Float64Array(n), im = new Float64Array(n)
  // linear resampling onto the uniform grid
  let j = 0
  for (let i = 0; i < n; i++) {
    const x = t0 + i * dt
    while (j < t.length - 2 && t[j + 1] < x) j++
    const f = (x - t[j]) / (t[j + 1] - t[j] || 1)
    re[i] = y[j] + Math.min(1, Math.max(0, f)) * (y[j + 1] - y[j])
  }
  const mean = re.reduce((a, b) => a + b, 0) / n
  const w = win(opts.window ?? "hann", n)
  let wsum = 0
  for (let i = 0; i < n; i++) { re[i] = (re[i] - mean) * w[i]; wsum += w[i] }
  fftInPlace(re, im)
  const half = n / 2
  const fs = 1 / dt
  const f: number[] = [], amp: number[] = []
  for (let k = 0; k <= half; k++) {
    f.push((k * fs) / n)
    amp.push(((k === 0 ? 1 : 2) * Math.hypot(re[k], im[k])) / wsum)
  }
  // fundamental: the biggest bin above DC, refined by parabolic interpolation
  let kmax = 2
  for (let k = 2; k <= half; k++) if (amp[k] > amp[kmax]) kmax = k
  // parabolic refinement — only at a true local maximum, and never more than half a bin
  const peak = (k: number) => {
    const a = amp[k - 1] ?? 0, b = amp[k], c = amp[k + 1] ?? 0
    const d = a - 2 * b + c
    if (!(b >= a && b >= c) || !(d < 0)) return { f: (k * fs) / n, amp: b }
    const off = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d))
    return { f: ((k + off) * fs) / n, amp: Math.max(b, b - 0.25 * (a - c) * off) }
  }
  const fund = amp[kmax] > 1e-12 ? peak(kmax) : null
  const harmonics: Spectrum["harmonics"] = []
  if (fund) {
    for (let h = 2; h <= (opts.harmonics ?? 10); h++) {
      const target = (h * fund.f * n) / fs
      if (target > half - 2) break
      // search a little around the expected bin, but never into the neighbouring harmonic's lobe
      const radius = Math.max(0, Math.min(2, Math.floor(((fund.f * n) / fs) * 0.3)))
      let best = Math.round(target)
      for (let k = Math.max(1, Math.round(target) - radius); k <= Math.min(half - 1, Math.round(target) + radius); k++) if (amp[k] > amp[best]) best = k
      harmonics.push({ k: h, ...peak(best) })
    }
  }
  const thd = fund ? Math.sqrt(harmonics.reduce((s, h) => s + h.amp * h.amp, 0)) / fund.amp : NaN
  return { f, amp, fs, n, dc: mean, fundamental: fund, harmonics, thd }
}
