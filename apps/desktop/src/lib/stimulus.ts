// Data fed into a circuit's inputs while it simulates (Kirk `stimulus { }`): a power supply that
// sags and surges, a temperature that drifts at random, light that ramps, a recorded series…
// Each feed is a Kirk expression compiled to a signal s(t); the netlist turns time-varying
// signals into PWL sources (see lib/spice.ts), constant ones into plain values.
import type { Arg, Expr } from "@/kirk/ast"

export interface Feed {
  /** "V1" (a source), "TH1" / "LDR1.light" (a sensor input), "RV1" / "SW1" (a control), "room.temp" */
  target: string
  /** Kirk expression, e.g. "12 V + noise(sd: 0.2 V)" */
  expr: string
}
export interface Stimulus { feeds: Feed[]; seed?: number }

export interface Signal {
  at: (t: number) => number
  constant: boolean
  unit?: string
  /** times where the signal jumps (sampled on both sides) */
  breaks: number[]
}

export class SignalError extends Error {}

// ---------------------------------------------------------------- seeded random

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const hash = (s: string) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0 }
function gauss(rnd: () => number) {
  const u = Math.max(rnd(), 1e-12), v = rnd()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

// ---------------------------------------------------------------- compile

export interface SignalContext {
  /** simulation length (s): default random step and ramp length */
  tstop: number
  seed: number
  /** salt for this feed's random streams (the target) */
  salt: string
}

const UNIT_ALIAS: Record<string, string> = { lux: "lx", ohm: "Ω" }
const constant = (v: number, unit?: string): Signal => ({ at: () => v, constant: true, unit, breaks: [] })

/** Compile a Kirk expression to a signal. Throws SignalError with a readable message. */
export function compileSignal(e: Expr, ctx: SignalContext): Signal {
  let calls = 0
  const go = (e: Expr): Signal => {
    switch (e.k) {
      case "num": return constant(e.value, e.unit ? UNIT_ALIAS[e.unit] ?? e.unit : undefined)
      case "neg": { const a = go(e.a); return { ...a, at: (t) => -a.at(t) } }
      case "id": {
        if (/^(on|true|closed|high)$/i.test(e.name)) return constant(1)
        if (/^(off|false|open|low)$/i.test(e.name)) return constant(0)
        throw new SignalError(`“${e.name}” is not a value — use a number, on / off, or a signal like ramp(…)`)
      }
      case "bin": {
        const a = go(e.a), b = go(e.b)
        const op = e.op
        if ((op === "+" || op === "-") && a.unit && b.unit && a.unit !== b.unit) throw new SignalError(`can't ${op === "+" ? "add" : "subtract"} ${b.unit} ${op === "+" ? "to" : "from"} ${a.unit}`)
        const f = op === "+" ? (x: number, y: number) => x + y : op === "-" ? (x: number, y: number) => x - y : op === "*" ? (x: number, y: number) => x * y : op === "/" ? (x: number, y: number) => x / y : null
        if (!f) throw new SignalError(`operator “${op}” can't be used in a feed`)
        const unit = op === "+" || op === "-" ? a.unit ?? b.unit : op === "*" ? a.unit ?? b.unit : a.unit && !b.unit ? a.unit : undefined
        return { at: (t) => f(a.at(t), b.at(t)), constant: a.constant && b.constant, unit, breaks: [...a.breaks, ...b.breaks] }
      }
      case "call": return call(e.fn, e.args, ++calls)
      default: throw new SignalError("expected a number or a signal, e.g. 12 V, ramp(from: 0 V, to: 5 V, over: 10 ms)")
    }
  }

  const call = (fn: string, args: Arg[], n: number): Signal => {
    const named = new Map(args.filter((a) => a.name).map((a) => [a.name!, a.value]))
    const pos = args.filter((a) => !a.name).map((a) => a.value)
    const num = (name: string, i?: number, fallback?: number): { v: number; unit?: string } => {
      const e = named.get(name) ?? (i !== undefined ? pos[i] : undefined)
      if (!e) {
        if (fallback !== undefined) return { v: fallback }
        throw new SignalError(`${fn}() needs ${name}:`)
      }
      const s = go(e)
      if (!s.constant) throw new SignalError(`${fn}(${name}:) must be a plain number`)
      return { v: s.at(0), unit: s.unit }
    }
    const time = (name: string, i: number | undefined, fallback: number) => {
      const r = num(name, i, fallback)
      if (r.unit && r.unit !== "s") throw new SignalError(`${fn}(${name}:) is a time, e.g. 1 ms`)
      return r.v
    }
    const pct = (name: string, fallback: number) => { const r = num(name, undefined, fallback); return r.unit === "%" ? r.v / 100 : r.v }
    const rng = () => mulberry32(hash(`${ctx.seed}:${ctx.salt}:${n}:${named.has("seed") ? num("seed").v : ""}`))
    const unitOf = (...rs: { unit?: string }[]) => rs.find((r) => r.unit)?.unit
    const held = (every: number, value: (k: number) => number, smooth: boolean): Signal => {
      if (!(every > 0)) throw new SignalError(`${fn}(every:) must be above 0`)
      const count = Math.min(200000, Math.ceil(ctx.tstop / every) + 2)
      const vals: number[] = []
      const k = (i: number) => { while (vals.length <= i && vals.length < count) vals.push(value(vals.length)); return vals[Math.min(i, count - 1)] }
      return {
        at: (t) => {
          const x = Math.max(0, t) / every, i = Math.floor(x)
          return smooth ? k(i) + (k(i + 1) - k(i)) * (x - i) : k(i)
        },
        constant: false, breaks: smooth ? [] : Array.from({ length: Math.min(count, 4000) }, (_, i) => i * every).slice(1),
      }
    }

    switch (fn) {
      case "ramp": {
        const a = num("from", 0), b = num("to", 1)
        const start = time("start", undefined, 0), over = time("over", 2, ctx.tstop - start)
        return { at: (t) => (t <= start ? a.v : t >= start + over ? b.v : a.v + (b.v - a.v) * (t - start) / over), constant: false, unit: unitOf(a, b), breaks: [] }
      }
      case "step": {
        const a = num("from", 0), b = num("to", 1), at = time("at", 2, ctx.tstop / 2)
        return { at: (t) => (t < at ? a.v : b.v), constant: false, unit: unitOf(a, b), breaks: [at] }
      }
      case "sine": case "sin": {
        const mean = num("mean", undefined, 0), amp = num("amp", 0), f = num("freq", 1)
        if (f.unit && f.unit !== "Hz") throw new SignalError("sine(freq:) is in Hz")
        const ph = num("phase", undefined, 0).v * Math.PI / 180
        return { at: (t) => mean.v + amp.v * Math.sin(2 * Math.PI * f.v * t + ph), constant: false, unit: unitOf(mean, amp), breaks: [] }
      }
      case "square": case "pulse": {
        const lo = num("low", 0), hi = num("high", 1), per = time("period", 2, ctx.tstop / 4), duty = pct("duty", 0.5), delay = time("delay", undefined, 0)
        if (!(per > 0)) throw new SignalError(`${fn}(period:) must be above 0`)
        const edges: number[] = []
        for (let t = delay; t <= ctx.tstop && edges.length < 4000; t += per) edges.push(t, t + per * duty)
        return { at: (t) => (t < delay ? lo.v : ((t - delay) % per) / per < duty ? hi.v : lo.v), constant: false, unit: unitOf(lo, hi), breaks: edges }
      }
      case "random": {
        const lo = num("min", 0), hi = num("max", 1), every = time("every", undefined, ctx.tstop / 50), r = rng()
        return { ...held(every, () => lo.v + (hi.v - lo.v) * r(), named.get("smooth")?.k === "id" && (named.get("smooth") as { name: string }).name === "true"), unit: unitOf(lo, hi) }
      }
      case "normal": case "noise": {
        const mean = fn === "noise" ? { v: 0 } : num("mean", 0)
        const sd = num("sd", fn === "noise" ? 0 : 1), every = time("every", undefined, ctx.tstop / 200), r = rng()
        return { ...held(every, () => mean.v + sd.v * gauss(r), false), unit: unitOf(mean, sd) }
      }
      case "walk": {
        // random walk (drift): each step adds N(0, sd); optional bounds reflect it back
        const start = num("start", 0), sd = num("sd", 1), every = time("every", undefined, ctx.tstop / 100), r = rng()
        const lo = named.has("min") ? num("min").v : -Infinity, hi = named.has("max") ? num("max").v : Infinity
        let x = start.v
        return { ...held(every, (k) => { if (k > 0) { x += sd.v * gauss(r); if (x < lo) x = 2 * lo - x; if (x > hi) x = 2 * hi - x } return x }, true), unit: unitOf(start, sd) }
      }
      case "samples": {
        const list = named.get("values") ?? pos[0]
        if (list?.k !== "list" || !list.items.length) throw new SignalError("samples() needs a list, e.g. samples([12 V, 11.5 V, 13 V], every: 1 ms)")
        const vals = list.items.map((it) => { const s = go(it); if (!s.constant) throw new SignalError("samples() takes plain numbers"); return { v: s.at(0), unit: s.unit } })
        const every = time("every", 1, ctx.tstop / Math.max(1, vals.length - 1))
        const hold = named.get("hold")?.k === "id"
        return {
          at: (t) => { const x = Math.max(0, t) / every, i = Math.floor(x); if (i >= vals.length - 1) return vals[vals.length - 1].v; return hold ? vals[i].v : vals[i].v + (vals[i + 1].v - vals[i].v) * (x - i) },
          constant: vals.length === 1, unit: unitOf(...vals), breaks: hold ? vals.map((_, i) => i * every).slice(1) : [],
        }
      }
      case "pwl": {
        const s = pos[0]
        if (s?.k !== "str") throw new SignalError('pwl() needs "time value …" pairs, e.g. pwl("0 12 5m 9 10m 13.8")')
        const nums = s.value.trim().split(/[\s,]+/).map(parseSpiceNumber)
        if (nums.length < 2 || nums.length % 2 || nums.some((x) => !Number.isFinite(x))) throw new SignalError('pwl() needs pairs of numbers: "time value time value …"')
        const pts: [number, number][] = []
        for (let i = 0; i < nums.length; i += 2) pts.push([nums[i], nums[i + 1]])
        pts.sort((a, b) => a[0] - b[0])
        return {
          at: (t) => {
            if (t <= pts[0][0]) return pts[0][1]
            for (let i = 1; i < pts.length; i++) if (t <= pts[i][0]) { const [t0, v0] = pts[i - 1], [t1, v1] = pts[i]; return t1 === t0 ? v1 : v0 + (v1 - v0) * (t - t0) / (t1 - t0) }
            return pts[pts.length - 1][1]
          },
          constant: pts.length === 1, breaks: [],
        }
      }
      default:
        throw new SignalError(`unknown signal “${fn}” — use ramp, step, sine, square, random, normal, noise, walk, samples or pwl`)
    }
  }
  return go(e)
}

const SPICE_SUFFIX: Record<string, number> = { f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, "µ": 1e-6, m: 1e-3, k: 1e3, meg: 1e6, g: 1e9 }
function parseSpiceNumber(s: string): number {
  const m = /^([-+]?\d*\.?\d+(?:e[-+]?\d+)?)(meg|[fpnuµmkg])?/i.exec(s)
  return m ? Number(m[1]) * (m[2] ? SPICE_SUFFIX[m[2].toLowerCase()] : 1) : NaN
}

/** Sample a signal over 0…tstop as a PWL table: an even grid plus both sides of every jump. */
export function samplePwl(sig: Signal, tstop: number, n = 1000): [number, number][] {
  const eps = tstop * 1e-6
  const ts = new Set<number>()
  for (let i = 0; i <= n; i++) ts.add((tstop * i) / n)
  for (const b of sig.breaks) if (b > 0 && b < tstop) { ts.add(Math.max(0, b - eps)); ts.add(b) }
  return [...ts].sort((a, b) => a - b).map((t) => [t, sig.at(t)])
}

/** "PWL(0 12 1e-05 11.98 …)" */
export const pwlSpec = (pts: [number, number][]) => `PWL(${pts.map(([t, v]) => `${fmt(t)} ${fmt(v)}`).join(" ")})`
const fmt = (v: number) => (Number.isFinite(v) ? Number(v.toPrecision(7)).toString() : "0")
