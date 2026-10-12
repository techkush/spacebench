// Catalogue parts in the DC solver (circuit.ts). Linear parts become resistors, diodes and
// floating sources; parts whose state depends on voltages (relays, transistors, op-amps,
// gates, regulators) are "active": stamped with their current state each iteration and
// updated from the solution until nothing changes. Flip-flops keep state between solves and
// change on a rising clock edge.
import { ohms } from "../parts"
import type { ModView } from "./look"
import type { CatalogPart, GateFn, Model } from "./types"

export interface Stamp {
  /** conductance between two nets (−1 = unconnected → ignored) */
  cond(a: number, b: number, g: number): void
  /** a source of `v` volts behind `r` ohms from net n to ground */
  src(n: number, v: number, r: number): void
  /** v volts from b to a (a is +) behind r ohms */
  fsrc(a: number, b: number, v: number, r: number): void
  /** a voltage-controlled source at `o`: gain·(v[p] − v[m]) behind r */
  vcvs(o: number, p: number, m: number, gain: number, r: number): void
}
export interface Active {
  stamp(s: Stamp): void
  /** read the solution; true when the state changed (solve again) */
  update(v: Float64Array): boolean
  view?(v: Float64Array): ModView
}
/** state that survives between solves (flip-flops, latches) */
export interface Seq { key(): string; clock(v: Float64Array): boolean }

export interface PartNets {
  part: { id: string; attrs: Record<string, string> }
  n(pin: string): number
  R(a: string, b: string, r: number): void
  D(a: string, c: string, vf: number, index?: number, rs?: number, led?: boolean): void
  ui: { value?: number; active?: boolean; pressed?: boolean; v?: Record<string, number> }
  /** board logic level (5 or 3.3 V) */
  vcc: number
  /** this part's memory between solves (flip-flop state) */
  mem: Record<string, unknown>
}

const OFF = 1e9
const hi = (v: Float64Array, n: number, vcc: number) => n >= 0 && v[n] > vcc / 2
const at = (v: Float64Array, n: number) => (n >= 0 ? v[n] : 0)

function gateOut(fn: GateFn, ins: boolean[]): boolean {
  switch (fn) {
    case "and": return ins.every(Boolean)
    case "nand": return !ins.every(Boolean)
    case "or": return ins.some(Boolean)
    case "nor": return !ins.some(Boolean)
    case "xor": return ins.filter(Boolean).length % 2 === 1
    case "xnor": return ins.filter(Boolean).length % 2 === 0
    case "not": return !ins[0]
    case "buf": return !!ins[0]
  }
}

/** A logic output driven from inputs (gates, 74HC sections, L293D channels). */
function logicOut(out: number, ins: number[], fn: GateFn, supply: (v: Float64Array) => number, vcc: number): Active {
  let level = false
  let vs = vcc
  return {
    stamp: (s) => s.src(out, level ? vs : 0, 50),
    update: (v) => {
      vs = Math.max(0, supply(v)) || 0
      const next = gateOut(fn, ins.map((n) => hi(v, n, vs || vcc)))
      if (next === level) return false
      level = next
      return true
    },
    view: () => ({ glow: [level ? 1 : 0] }),
  }
}

const IC74: Record<string, [number[], number][]> = {
  quad: [[[1, 2], 3], [[4, 5], 6], [[10, 9], 8], [[13, 12], 11]],
  nor: [[[2, 3], 1], [[5, 6], 4], [[8, 9], 10], [[11, 12], 13]],
  hex: [[[1], 2], [[3], 4], [[5], 6], [[9], 8], [[11], 10], [[13], 12]],
}

/**
 * Stamp one catalogue part. Plain elements go straight in through `p`; the rest come back as
 * active elements (and sequential state).
 */
export function stampPart(c: CatalogPart, p: PartNets, out: { actives: Active[]; seqs: Seq[]; fsrcs: [number, number, number, number][]; views: Map<string, (v: Float64Array) => ModView> }) {
  const m: Model = c.model
  const id = p.part.id
  const a = p.part.attrs
  const n = p.n
  const gnd = n("GND")
  const add = (x: Active) => { out.actives.push(x); if (x.view) out.views.set(id, x.view) }
  switch (m.m) {
    case "passive":
      if (m.kind === "R") p.R(c.pins[0], c.pins[1], ohms(a.value, m.value))
      else if (m.kind === "L") p.R(c.pins[0], c.pins[1], 0.1)
      // a capacitor is open at DC
      break
    case "lres": p.R(m.a, m.b, m.r(p.ui.value ?? m.ctl.def)); break
    case "diode":
      p.D("A", "K", m.vf, 0, 1, false)
      if (m.vz) p.D("K", "A", m.vz, 1, 1, false)
      break
    case "battery": out.fsrcs.push([n("+"), n("-"), m.v, m.r]); break
    case "supply": out.fsrcs.push([n("+"), n("-"), Number(a.voltage ?? 12) || 0, 0.05]); break
    case "led": p.D(m.pin, "GND", m.color === "blue" || m.color === "white" || m.color === "purple" ? 3 : 1.9, 0, 470, true); break
    case "button": if (m.led) p.D(m.led, "GND", a.color === "yellow" ? 2 : 1.9, 0, 470, true); break
    case "load": p.R(m.a, m.b ?? "GND", m.r); { const na = n(m.a), nb = n(m.b ?? "GND"); out.views.set(id, (v) => ({ on: Math.min(1, Math.abs(at(v, na) - at(v, nb)) / p.vcc) })) } break
    case "motor": p.R(m.a, m.b ?? "GND", m.r ?? 20); { const na = n(m.a), nb = n(m.b ?? "GND"); out.views.set(id, (v) => ({ on: Math.max(-1, Math.min(1, (at(v, na) - at(v, nb)) / p.vcc)) })) } break
    case "relay": {
      // modules (SIG to GND) switch through a transistor at ~1.5 V; bare coils need ~3.5 V
      const bare = m.coil.length === 2
      const c1 = n(m.coil[0]), c2 = bare ? n(m.coil[1]) : gnd
      if (c1 >= 0) p.R(m.coil[0], bare ? m.coil[1] : "GND", m.ssr ? 1000 : bare ? 70 : 5000)
      const vOn = m.vOn ?? (bare ? 3.5 : 1.5)
      let on = false
      add({
        stamp: (s) => m.com.forEach((com, i) => {
          s.cond(n(com), n(m.no[i]), on ? 20 : 1 / OFF)
          if (m.nc?.[i]) s.cond(n(com), n(m.nc[i]), on ? 1 / OFF : 20)
        }),
        update: (v) => { const next = Math.abs(at(v, c1) - at(v, c2)) > vOn && c1 >= 0 && c2 >= 0; if (next === on) return false; on = next; return true },
        view: () => ({ on: on ? 1 : 0, glow: [on ? 1 : 0] }),
      })
      break
    }
    case "bjt": {
      const [b, cc, e] = [n("B"), n("C"), n("E")]
      if (m.pnp) p.D("E", "B", 0.65, 0, 12, false); else p.D("B", "E", 0.65, 0, 12, false)
      let r = OFF
      add({
        stamp: (s) => s.cond(cc, e, 1 / r),
        update: (v) => {
          const ib = Math.max(0, ((m.pnp ? at(v, e) - at(v, b) : at(v, b) - at(v, e)) - 0.65) / 12)
          const next = ib > 1e-7 ? Math.max(0.5, 0.2 / (m.beta * ib)) : OFF
          if (Math.abs(next - r) / Math.max(r, 1e-9) < 0.05) return false
          r = next
          return true
        },
      })
      break
    }
    case "fet": {
      const [g, d, s0] = [n("G"), n("D"), n("S")]
      let on = false
      add({
        stamp: (s) => s.cond(d, s0, on ? 1 / m.ron : 1 / OFF),
        update: (v) => { const vgs = m.p ? at(v, s0) - at(v, g) : at(v, g) - at(v, s0); const next = g >= 0 && vgs > m.vth; if (next === on) return false; on = next; return true },
      })
      break
    }
    case "opto": {
      const [cc, e] = [n("C"), n("E")]
      p.D("A", "K", 1.2, 0, 12, false)
      const na = n("A"), nk = n("K")
      let r = OFF
      add({
        stamp: (s) => s.cond(cc, e, 1 / r),
        update: (v) => {
          const ifw = Math.max(0, (at(v, na) - at(v, nk) - 1.2) / 12)
          const next = ifw > 1e-6 ? Math.max(1, 0.2 / (m.ctr * ifw)) : OFF
          if (Math.abs(next - r) / r < 0.05) return false
          r = next
          return true
        },
      })
      break
    }
    case "opamp": {
      const [ip, im, o] = [n("IN+"), n("IN-"), n("OUT")]
      const top = c.title.startsWith("LM358") || c.title.startsWith("LM324") ? p.vcc - 1.5 : c.title.startsWith("LM741") ? p.vcc - 2 : p.vcc
      let sat: 0 | 1 | -1 = 0
      add({
        stamp: (s) => { if (o < 0) return; if (sat === 0) s.vcvs(o, ip, im, 1e5, 50); else s.src(o, sat > 0 ? top : 0, 50) },
        update: (v) => {
          const want = 1e5 * (at(v, ip) - at(v, im))
          let next: 0 | 1 | -1 = sat
          if (sat === 0) next = at(v, o) > top + 1e-3 ? 1 : at(v, o) < -1e-3 ? -1 : 0
          else if (sat > 0 && want < top) next = 0
          else if (sat < 0 && want > 0) next = 0
          if (next === sat) return false
          sat = next
          return true
        },
        view: (v) => ({ text: `${at(v, o).toFixed(2)} V` }),
      })
      break
    }
    case "regulator": {
      const nin = n("IN"), nout = n("OUT"), adj = n("ADJ")
      let ok = true
      add({
        stamp: (s) => { if (nout < 0) return; if (m.adj) { if (ok) s.fsrc(nout, adj, 1.25, 0.1) } else if (ok) s.fsrc(nout, gnd, m.v, 0.1) },
        update: (v) => {
          const head = m.adj ? at(v, nin) - at(v, nout) : m.v > 0 ? at(v, nin) - at(v, gnd) - m.v : at(v, gnd) - at(v, nin) + m.v
          const next = nin >= 0 && head > (m.adj ? 1.5 : 1.8)
          if (next === ok) return false
          ok = next
          return true
        },
      })
      break
    }
    case "gate": {
      const ins = c.pins.slice(0, -1).map(n)
      add(logicOut(n("Y"), ins, m.fn, () => p.vcc, p.vcc))
      break
    }
    case "ic74": {
      const map = m.fn === "not" ? IC74.hex : m.fn === "nor" ? IC74.nor : IC74.quad
      const vccPin = n("14"), gndPin = n("7")
      const supply = (v: Float64Array) => (vccPin >= 0 ? at(v, vccPin) - at(v, gndPin) : 0)
      for (const [ins, o] of map) out.actives.push(logicOut(n(String(o)), ins.map((x) => n(String(x))), m.fn, supply, p.vcc))
      break
    }
    case "proto":
      if (m.kind === "hbridge") {
        const vs = n("VS"), en = [n("EN1"), n("EN2")]
        let vsup = p.vcc
        const ch: [string, string, number][] = [["IN1", "OUT1", 0], ["IN2", "OUT2", 0], ["IN3", "OUT3", 1], ["IN4", "OUT4", 1]]
        for (const [i, o, e] of ch) {
          const ni = n(i), no = n(o), ne = en[e]
          let st: 0 | 1 | 2 = 2 // 2 = high impedance
          out.actives.push({
            stamp: (s) => { if (st === 1) s.src(no, vsup, 1); else if (st === 0) s.src(no, 0, 1) },
            update: (v) => {
              vsup = vs >= 0 ? at(v, vs) : p.vcc
              const next: 0 | 1 | 2 = !hi(v, ne, p.vcc) ? 2 : hi(v, ni, p.vcc) ? 1 : 0
              if (next === st) return false
              st = next
              return true
            },
          })
        }
      } else if (m.kind === "divider") {
        const k = Number(a.ratio ?? 3) || 3
        p.R("IN+", "SIG", 10e3 * (k - 1)); p.R("SIG", "IN-", 10e3); p.R("IN-", "GND", 0.01)
      } else if (m.kind === "keypad") {
        for (const [k, on] of Object.entries(p.ui.v ?? {})) { const x = /^k(\d)(\d)$/.exec(k); if (x && on) p.R(`R${+x[1] + 1}`, `C${+x[2] + 1}`, 0.01) }
      } else if (m.kind === "gearmotor") {
        p.R("M+", "M-", 15)
        const na = n("M+"), nb = n("M-")
        out.views.set(id, (v) => ({ on: Math.max(-1, Math.min(1, (at(v, na) - at(v, nb)) / 6)) }))
      }
      break
    case "i2c":
      if (m.chip === "relay4") {
        const bits = p.ui.v?.relays ?? 0
        if (c.pins.includes("COM1")) for (let i = 1; i <= 4; i++) { if (bits & (1 << (i - 1))) p.R(`COM${i}`, `NO${i}`, 0.05); else p.R(`COM${i}`, `NC${i}`, 0.05) }
        else for (let i = 1; i <= 8; i++) if (bits & (1 << (i - 1))) p.R(`A${i}`, `B${i}`, 0.05)
        out.views.set(id, () => ({ glow: [bits ? 1 : 0] }))
      }
      break
    case "ff": {
      const q = n("Q"), qn = n("QN"), clk = n("CLK")
      const st = (p.mem.ff ??= { q: false, clk: false }) as { q: boolean; clk: boolean }
      out.actives.push({ stamp: (s) => { s.src(q, st.q ? p.vcc : 0, 50); s.src(qn, st.q ? 0 : p.vcc, 50) }, update: () => false, view: () => ({ glow: [st.q ? 1 : 0] }) })
      out.views.set(id, () => ({ glow: [st.q ? 1 : 0] }))
      out.seqs.push({
        key: () => `${st.q ? 1 : 0}${st.clk ? 1 : 0}`,
        clock: (v) => {
          const c1 = hi(v, clk, p.vcc)
          const rise = c1 && !st.clk
          st.clk = c1
          if (!rise) return false
          const prev = st.q
          if (m.kind === "D") st.q = hi(v, n("D"), p.vcc)
          else if (m.kind === "T") { if (hi(v, n("T"), p.vcc)) st.q = !st.q }
          else { const j = hi(v, n("J"), p.vcc), k = hi(v, n("K"), p.vcc); st.q = j && k ? !st.q : j ? true : k ? false : st.q }
          return st.q !== prev
        },
      })
      break
    }
    case "probe": {
      const [pa, pb] = [n(c.pins[0]), n(c.pins[1])]
      if (m.kind === "A") p.R(c.pins[0], c.pins[1], 0.01)
      out.views.set(id, (v) => {
        if (pa < 0 || pb < 0) return { text: "--" }
        const d = at(v, pa) - at(v, pb)
        if (m.kind === "V") return { text: `${d.toFixed(Math.abs(d) < 10 ? 3 : 2)} V` }
        const i = d / 0.01
        return { text: Math.abs(i) < 1 ? `${(i * 1e3).toFixed(1)} mA` : `${i.toFixed(3)} A` }
      })
      break
    }
  }
}
