// Turn a simulation result into a short text the model can reason about.
import type { JobResult } from "@/lib/engine"
import { response } from "@/lib/instruments"
import { stats } from "@/lib/measure"
import { formatSI } from "@/lib/units"
import type { AssertOutcome, MeasureOutcome } from "@/kirk/measure"

const unit = (s: string) => (s.startsWith("I") ? "A" : "V")
const f = (v: number, u: string, d = 4) => (Number.isFinite(v) ? formatSI(Math.abs(v) < 1e-15 ? 0 : v, u, d) : "—")
const dB = (v: number) => (Math.abs(v) < 0.005 ? 0 : v).toFixed(2)

/** Signals worth reporting: probes first, then node voltages, then currents (capped). */
function pick(names: string[], probes: string[], max = 14): string[] {
  const first = probes.filter((p) => names.includes(p))
  const volts = names.filter((n) => n.startsWith("V(") && !first.includes(n))
  const amps = names.filter((n) => /^I[a-z]*\(/.test(n) && !first.includes(n))
  return [...first, ...volts, ...amps].slice(0, max)
}

export function summarizeResult(r: JobResult, probes: string[], measures: Record<string, MeasureOutcome> = {}, asserts: { expr: string; outcome: AssertOutcome }[] = [], ms?: number): string {
  const lines: string[] = []
  const took = ms !== undefined ? ` · ${Math.round(ms)} ms` : ""
  if (r.type === "op") {
    lines.push(`Operating point${took}`)
    pick(r.names, probes, 30).forEach((n) => lines.push(`${n} = ${f(r.values[r.names.indexOf(n)], unit(n))}`))
  } else if (r.type === "tran") {
    lines.push(`Transient 0 → ${f(r.time[r.time.length - 1], "s")} · ${r.time.length} points${took}`)
    for (const n of pick(r.names, probes)) {
      const y = r.data[r.names.indexOf(n)], s = stats(r.time, y), u = unit(n)
      lines.push(`${n}: min ${f(s.min, u)} · max ${f(s.max, u)} · avg ${f(s.avg, u)} · pp ${f(s.pp, u)} · rms ${f(s.rms, u)}${Number.isFinite(s.freq) ? ` · f ${f(s.freq, "Hz")}` : ""} · final ${f(y[y.length - 1], u)}`)
    }
  } else if (r.type === "ac") {
    lines.push(`AC sweep ${f(r.freq[0], "Hz")} → ${f(r.freq[r.freq.length - 1], "Hz")}${took} (gain relative to the AC source amplitude)`)
    for (const n of pick(r.names, probes).filter((x) => x.startsWith("V("))) {
      const x = response(r.freq, r, r.names.indexOf(n))
      const at = (fr: number) => { let j = 0; while (j < r.freq.length - 1 && r.freq[j] < fr) j++; return j }
      const j1k = at(1000)
      lines.push(`${n}: peak ${dB(x.peak)} dB · at ${f(r.freq[j1k], "Hz", 3)} ${dB(x.gain[j1k])} dB, ${(Math.abs(x.phase[j1k]) < 0.05 ? 0 : x.phase[j1k]).toFixed(1)}° · f_L ${Number.isFinite(x.fL) ? f(x.fL, "Hz") : "below range"} · f_H ${Number.isFinite(x.fH) ? f(x.fH, "Hz") : "above range"}${Number.isFinite(x.slope) ? ` · roll-off ${x.slope.toFixed(0)} dB/dec` : ""}`)
    }
  } else {
    lines.push(`DC sweep of ${r.sweep_name} ${r.sweep[0]} → ${r.sweep[r.sweep.length - 1]}${took}`)
    for (const n of pick(r.names, probes)) {
      const y = r.data[r.names.indexOf(n)]
      lines.push(`${n}: ${f(y[0], unit(n))} → ${f(y[y.length - 1], unit(n))} (min ${f(Math.min(...y), unit(n))}, max ${f(Math.max(...y), unit(n))})`)
    }
  }
  const ms_ = Object.entries(measures)
  if (ms_.length) lines.push("Measurements: " + ms_.map(([k, m]) => `${k} = ${m.ok ? formatSI(m.value.value, m.value.unit === "deg" ? "°" : m.value.unit, 4) : `error (${m.error})`}`).join(" · "))
  if (asserts.length) lines.push("Asserts: " + asserts.map(({ expr, outcome: a }) => `${expr} ${a.ok ? (a.pass ? "✓" : "✗") : `error (${a.error})`}`).join(" · "))
  if (r.log?.length) lines.push(`ngspice: ${r.log.slice(0, 3).join(" | ")}`)
  return lines.join("\n")
}
