// SI-prefixed numbers, as used everywhere in Space Bench and Kirk.
// Note: "M" = mega, "m" = milli (Kirk spec §3); "Meg" is also accepted.

const PREFIX: Record<string, number> = {
  f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, "µ": 1e-6, m: 1e-3,
  k: 1e3, K: 1e3, M: 1e6, Meg: 1e6, meg: 1e6, G: 1e9, T: 1e12,
}

/** Parse "4.7k", "10 uF", "1.6kΩ", "100n", "2.2Meg" → number (unit letters ignored). */
export function parseSI(text: string): number | null {
  const m = text.trim().match(/^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*(Meg|meg|[fpnuµmkKMGT])?\s*[A-Za-zΩ]*$/)
  if (!m) return null
  // apply the prefix as a decimal exponent so "100u" is exactly 1e-4 (not 100 × 1e-6)
  if (!m[2]) return parseFloat(m[1])
  return /e/i.test(m[1]) ? parseFloat(m[1]) * PREFIX[m[2]] : parseFloat(`${m[1]}e${Math.round(Math.log10(PREFIX[m[2]]))}`)
}

const ENG: [number, string][] = [
  [1e12, "T"], [1e9, "G"], [1e6, "M"], [1e3, "k"], [1, ""], [1e-3, "m"], [1e-6, "µ"], [1e-9, "n"], [1e-12, "p"], [1e-15, "f"],
]

/** 0.00235 → "2.35 m" (+ unit). */
export function formatSI(v: number, unit = "", digits = 3): string {
  if (!Number.isFinite(v)) return "—"
  if (v === 0) return `0 ${unit}`.trim()
  const a = Math.abs(v)
  for (const [scale, p] of ENG) {
    if (a >= scale * 0.9995) {
      const n = v / scale
      return `${Number(n.toPrecision(digits))} ${p}${unit}`.trim()
    }
  }
  return `${v.toExponential(2)} ${unit}`.trim()
}
