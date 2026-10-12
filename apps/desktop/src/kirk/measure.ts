// Kirk measurements and assertions (spec §5.8), evaluated on simulation results.
//   measure f   = frequency(V(out), at: 2.5 V)
//   measure g   = gain_db(V(out) / V(in), at: 1 kHz)
//   assert  f in 6.5 Hz .. 7.2 Hz
import type { JobResult } from "@/lib/engine"
import { crossings, duty, riseTime, stats } from "@/lib/measure"
import type { Arg, Expr } from "./ast"
import { evalNum } from "./kinds"
import { parse } from "./parser"

export interface Quantity { value: number; unit: string }
type Val =
  | { k: "num"; v: number; unit: string }
  | { k: "sig"; x: number[]; y: number[]; xunit: string; unit: string }
  | { k: "ac"; f: number[]; re: number[]; im: number[]; unit: string }
  | { k: "bool"; v: boolean }

class MeasureError extends Error {}
const fail = (m: string): never => { throw new MeasureError(m) }

function parseExpr(text: string): Expr {
  const { file, diagnostics } = parse(`measure _m = ${text}`)
  if (diagnostics.length) fail(diagnostics[0].message)
  const it = file.items[0]
  if (!it || it.k !== "measure") fail("not an expression")
  return (it as Extract<typeof it, { k: "measure" }>).expr
}

function signal(r: JobResult, fn: string, args: Arg[]): Val {
  const name = (e: Expr | undefined) => (e?.k === "id" ? (e.name === "GND" ? "0" : e.name) : e?.k === "str" ? e.value : fail(`${fn}() needs a net or part name`))
  const sig = `${fn}(${name(args[0]?.value)})`
  const unit = fn === "V" ? "V" : "A"
  const pick = (s: string): Val => {
    if (s === "V(0)") {
      if (r.type === "tran") return { k: "sig", x: r.time, y: r.time.map(() => 0), xunit: "s", unit }
      if (r.type === "ac") return { k: "ac", f: r.freq, re: r.freq.map(() => 0), im: r.freq.map(() => 0), unit }
      return { k: "num", v: 0, unit }
    }
    const i = r.names.indexOf(s)
    if (i < 0) fail(`no signal ${s} in the ${r.type} result`)
    if (r.type === "tran") return { k: "sig", x: r.time, y: r.data[i], xunit: "s", unit }
    if (r.type === "dc") return { k: "sig", x: r.sweep, y: r.data[i], xunit: "V", unit }
    if (r.type === "ac") return { k: "ac", f: r.freq, re: r.re[i], im: r.im[i], unit }
    return { k: "num", v: r.values[i], unit }
  }
  const a = pick(sig)
  if (fn === "V" && args[1]) return arith("-", a, pick(`V(${name(args[1].value)})`))
  return a
}

function arith(op: string, a: Val, b: Val): Val {
  const num = (x: number, y: number) => (op === "+" ? x + y : op === "-" ? x - y : op === "*" ? x * y : op === "/" ? x / y : x ** y)
  const ua = a.k !== "bool" ? a.unit : "", ub = b.k !== "bool" ? b.unit : ""
  const unit = op === "*" ? ((ua === "V" && ub === "A") || (ua === "A" && ub === "V") ? "W" : (ua === "A" && ub === "Ω") || (ua === "Ω" && ub === "A") ? "V" : ua && ub ? `${ua}·${ub}` : ua || ub)
    : op === "/" ? (ua === ub ? "" : !ua && ub === "Hz" ? "s" : !ua && ub === "s" ? "Hz" : ua === "V" && ub === "A" ? "Ω" : ua === "V" && ub === "Ω" ? "A" : ub ? `${ua}/${ub}` : ua)
    : ua || ub
  if (a.k === "bool" || b.k === "bool") return fail("can't do arithmetic on true/false")
  if (a.k === "num" && b.k === "num") return { k: "num", v: num(a.v, b.v), unit }
  if (a.k === "ac" || b.k === "ac") {
    const A = a.k === "ac" ? a : null, B = b.k === "ac" ? b : null
    const f = (A ?? B)!.f
    const re = (v: Val, j: number) => (v.k === "ac" ? v.re[j] : v.k === "num" ? v.v : 0)
    const im = (v: Val, j: number) => (v.k === "ac" ? v.im[j] : 0)
    const R: number[] = [], I: number[] = []
    for (let j = 0; j < f.length; j++) {
      const ar = re(a, j), ai = im(a, j), br = re(b, j), bi = im(b, j)
      if (op === "+") { R.push(ar + br); I.push(ai + bi) }
      else if (op === "-") { R.push(ar - br); I.push(ai - bi) }
      else if (op === "*") { R.push(ar * br - ai * bi); I.push(ar * bi + ai * br) }
      else if (op === "/") { const d = br * br + bi * bi || 1e-300; R.push((ar * br + ai * bi) / d); I.push((ai * br - ar * bi) / d) }
      else fail("^ is not defined for AC signals")
    }
    return { k: "ac", f, re: R, im: I, unit }
  }
  const S = (a.k === "sig" ? a : b) as Extract<Val, { k: "sig" }>
  const at = (v: Val, j: number) => (v.k === "sig" ? v.y[j] : (v as { v: number }).v)
  return { k: "sig", x: S.x, xunit: S.xunit, y: S.x.map((_, j) => num(at(a, j), at(b, j))), unit }
}

function windowed(s: Extract<Val, { k: "sig" }>, from?: number, to?: number) {
  if (from === undefined && to === undefined) return s
  const x: number[] = [], y: number[] = []
  s.x.forEach((t, j) => { if ((from === undefined || t >= from) && (to === undefined || t <= to)) { x.push(t); y.push(s.y[j]) } })
  if (x.length < 2) fail("the from/to window has no samples")
  return { ...s, x, y }
}

function evaluate(e: Expr, r: JobResult, env: Record<string, Quantity>): Val {
  switch (e.k) {
    case "num": { const q = evalNum(e)!; return { k: "num", v: q.value, unit: q.unit ?? "" } }
    case "id": {
      if (env[e.name]) return { k: "num", v: env[e.name].value, unit: env[e.name].unit }
      if (e.name === "pi") return { k: "num", v: Math.PI, unit: "" }
      return fail(`unknown name “${e.name}”`)
    }
    case "neg": { const a = evaluate(e.a, r, env); return arith("*", a, { k: "num", v: -1, unit: "" }) }
    case "bin": {
      if (e.op === "in") {
        const v = num(evaluate(e.a, r, env))
        if (e.b.k !== "range") fail("use  x in low .. high")
        const rb = e.b as Extract<Expr, { k: "range" }>
        return { k: "bool", v: v >= num(evaluate(rb.a, r, env)) && v <= num(evaluate(rb.b, r, env)) }
      }
      if (["<", ">", "<=", ">=", "==", "!="].includes(e.op)) {
        const a = num(evaluate(e.a, r, env)), b = num(evaluate(e.b, r, env))
        const v = e.op === "<" ? a < b : e.op === ">" ? a > b : e.op === "<=" ? a <= b : e.op === ">=" ? a >= b : e.op === "==" ? Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a)) : a !== b
        return { k: "bool", v }
      }
      return arith(e.op, evaluate(e.a, r, env), evaluate(e.b, r, env))
    }
    case "call": return call(e, r, env)
    default: return fail("unsupported expression")
  }
}

const num = (v: Val): number => (v.k === "num" ? v.v : v.k === "bool" ? Number(v.v) : fail("expected a number here, got a waveform — wrap it in max(), avg(), at(…)…"))

function call(e: Extract<Expr, { k: "call" }>, r: JobResult, env: Record<string, Quantity>): Val {
  const fn = e.fn
  if (fn === "V" || /^I[a-z]*$/.test(fn)) return signal(r, fn, e.args)
  const pos = e.args.filter((a) => !a.name).map((a) => a.value)
  const named = (n: string) => e.args.find((a) => a.name === n)?.value
  const numArg = (x: Expr | undefined, d?: number) => (x ? num(evaluate(x, r, env)) : d)
  const first = () => (pos[0] ? evaluate(pos[0], r, env) : fail(`${fn}() needs a signal`))
  const tsig = (): Extract<Val, { k: "sig" }> => {
    const v = first()
    if (v.k !== "sig") fail(`${fn}() needs a transient or DC-sweep signal${v.k === "ac" ? " (this is an AC result)" : ""}`)
    return windowed(v as Extract<Val, { k: "sig" }>, numArg(named("from")), numArg(named("to")))
  }
  const acsig = (): Extract<Val, { k: "ac" }> => { const v = first(); if (v.k !== "ac") fail(`${fn}() needs an AC result — run the AC sweep`); return v as Extract<Val, { k: "ac" }> }
  const magDb = (v: Extract<Val, { k: "ac" }>) => v.re.map((x, j) => 20 * Math.log10(Math.max(Math.hypot(x, v.im[j]), 1e-300)))
  const interp = (xs: number[], ys: number[], x: number) => {
    if (x <= xs[0]) return ys[0]
    for (let j = 1; j < xs.length; j++) if (xs[j] >= x) return ys[j - 1] + ((x - xs[j - 1]) / (xs[j] - xs[j - 1])) * (ys[j] - ys[j - 1])
    return ys[ys.length - 1]
  }
  switch (fn) {
    case "avg": case "rms": case "pp": case "max": case "min": {
      if (pos[0] && pos.length > 1 && (fn === "max" || fn === "min")) { const vs = pos.map((p) => num(evaluate(p, r, env))); return { k: "num", v: fn === "max" ? Math.max(...vs) : Math.min(...vs), unit: "" } }
      const v = first()
      if (v.k === "num") return v
      const s = tsig()
      const st = stats(s.x, s.y)
      return { k: "num", v: fn === "avg" ? st.avg : fn === "rms" ? st.rms : fn === "pp" ? st.pp : fn === "max" ? st.max : st.min, unit: s.unit }
    }
    case "final": { const v = first(); if (v.k === "num") return v; const s = tsig(); return { k: "num", v: s.y[s.y.length - 1], unit: s.unit } }
    case "at": {
      const v = first(), x = numArg(pos[1] ?? named("t") ?? named("f"))
      if (x === undefined) fail("at(signal, time) needs a time or frequency")
      if (v.k === "sig") return { k: "num", v: interp(v.x, v.y, x!), unit: v.unit }
      if (v.k === "ac") return { k: "num", v: interp(v.f, v.re.map((a, j) => Math.hypot(a, v.im[j])), x!), unit: v.unit }
      return v
    }
    case "frequency": case "period": {
      const s = tsig()
      const level = numArg(named("at") ?? pos[1])
      let f: number
      if (level === undefined) f = stats(s.x, s.y).freq
      else { const c = crossings(s.x, s.y, level, true); const use = c.length >= 3 ? c.slice(1) : c; f = use.length >= 2 ? (use.length - 1) / (use[use.length - 1] - use[0]) : NaN }
      if (!Number.isFinite(f)) fail("the signal does not cross its level at least twice")
      return fn === "frequency" ? { k: "num", v: f, unit: "Hz" } : { k: "num", v: 1 / f, unit: "s" }
    }
    case "duty": { const s = tsig(); const d = duty(s.x, s.y); if (!Number.isFinite(d)) fail("no full periods found"); return { k: "num", v: d * 100, unit: "%" } }
    case "rise_time": case "fall_time": {
      const s = tsig()
      const y = fn === "fall_time" ? s.y.map((v) => -v) : s.y
      const t = riseTime(s.x, y)
      if (!Number.isFinite(t)) fail(`no ${fn === "rise_time" ? "rising" : "falling"} edge found`)
      return { k: "num", v: t, unit: "s" }
    }
    case "gain_db": case "phase": {
      const v = acsig(), f = numArg(named("at") ?? pos[1])
      if (f === undefined) fail(`${fn}(signal, at: frequency)`)
      if (fn === "gain_db") return { k: "num", v: interp(v.f, magDb(v), f!), unit: "dB" }
      return { k: "num", v: interp(v.f, v.re.map((a, j) => (Math.atan2(v.im[j], a) * 180) / Math.PI), f!), unit: "deg" }
    }
    case "fc": case "bandwidth": {
      const v = acsig(), drop = numArg(named("drop") ?? pos[1], 3.0103)!
      const m = magDb(v), target = m[0] - drop
      for (let j = 1; j < m.length; j++) if (m[j - 1] >= target && m[j] < target) {
        const fr = (target - m[j - 1]) / (m[j] - m[j - 1])
        return { k: "num", v: 10 ** (Math.log10(v.f[j - 1]) + fr * (Math.log10(v.f[j]) - Math.log10(v.f[j - 1]))), unit: "Hz" }
      }
      return fail("the response never drops that far in the sweep range")
    }
    case "abs": return { k: "num", v: Math.abs(num(first())), unit: (first() as { unit?: string }).unit ?? "" }
    case "sqrt": return { k: "num", v: Math.sqrt(num(first())), unit: "" }
    case "log10": return { k: "num", v: Math.log10(num(first())), unit: "" }
    case "exp": return { k: "num", v: Math.exp(num(first())), unit: "" }
    default: return fail(`unknown function ${fn}() — try avg rms pp max min at frequency period duty rise_time fall_time gain_db phase fc bandwidth`)
  }
}

export type MeasureOutcome = { ok: true; value: Quantity } | { ok: false; error: string }
export type AssertOutcome = { ok: true; pass: boolean; severity: "error" | "warning" } | { ok: false; error: string }

/** Evaluate measurements in order (later ones may use earlier names). */
export function runMeasures(list: { name: string; expr: string }[], r: JobResult): Record<string, MeasureOutcome> {
  const env: Record<string, Quantity> = {}
  const out: Record<string, MeasureOutcome> = {}
  for (const m of list) {
    try {
      const v = evaluate(parseExpr(m.expr), r, env)
      if (v.k === "bool") throw new MeasureError("a measurement must be a number (use assert for checks)")
      if (v.k !== "num") throw new MeasureError("this is a waveform — reduce it with max(), avg(), rms(), at(…)…")
      env[m.name] = { value: v.v, unit: v.unit }
      out[m.name] = { ok: true, value: env[m.name] }
    } catch (e) {
      out[m.name] = { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
  return out
}

export function runAsserts(list: string[], measures: Record<string, MeasureOutcome>, r: JobResult): AssertOutcome[] {
  const env: Record<string, Quantity> = {}
  for (const [k, v] of Object.entries(measures)) if (v.ok) env[k] = v.value
  return list.map((text) => {
    const sev = /severity\s*:\s*warning/.test(text) ? "warning" : "error"
    try {
      const v = evaluate(parseExpr(text.replace(/\s*severity\s*:\s*\w+\s*$/, "")), r, env)
      if (v.k !== "bool") throw new MeasureError("an assert must be a comparison, e.g. f > 1 kHz or f in 6 Hz .. 7 Hz")
      return { ok: true as const, pass: v.v, severity: sev as "error" | "warning" }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })
}

/** Check an expression's syntax only (for the editor fields). */
export function checkExpr(text: string): string | null {
  try { parseExpr(text); return null } catch (e) { return e instanceof Error ? e.message : String(e) }
}

export type SignalValue =
  | { kind: "real"; x: number[]; y: number[]; unit: string; xunit: string }
  | { kind: "ac"; f: number[]; re: number[]; im: number[]; unit: string }

/** Evaluate a math trace (e.g. V(OUT)*I(R3), V(out)/V(in)) as a whole waveform. */
export function evalSignal(text: string, r: JobResult): SignalValue | { error: string } {
  try {
    const v = evaluate(parseExpr(text), r, {})
    if (v.k === "sig") return { kind: "real", x: v.x, y: v.y, unit: v.unit, xunit: v.xunit }
    if (v.k === "ac") return { kind: "ac", f: v.f, re: v.re, im: v.im, unit: v.unit }
    return { error: "this gives a single number — use measure for that" }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}
