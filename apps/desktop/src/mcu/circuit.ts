// The electrical side of a microcontroller diagram: wires join pins into nets, and a DC
// nodal solve finds every net's voltage for the current pin states — output pins are 5 V / 0 V
// sources behind ~25 Ω, pull-ups are 37 kΩ, LEDs are diodes (Vf + series resistance),
// pots and switches are resistors. From it come LED currents (brightness), the level every
// input pin reads, ADC voltages, and warnings (an LED without a resistor, a shorted supply).
import { canonicalPin, isBoardType, type BoardDef } from "./boards"
import { splitEnd, type Diagram, type DiagramPart } from "./diagram"
import { ohms } from "./parts"
import { catalogPart } from "./catalog"
import { stampPart, type Active, type Seq } from "./catalog/elements"
import type { ModView } from "./catalog/look"

/** Something outside the solver driving a part's pin: a sensor module's output, a device's data line. */
export interface Drive { v: number; r: number }
/** What the user is doing to a part (button held, knob position, switch side). */
export interface PartUi { pressed?: boolean; value?: number; values?: number[]; x?: number; y?: number; active?: boolean; /** catalogue parts' named controls */ v?: Record<string, number> }

export interface PinLevel { out: boolean | null; pullup: boolean; pulldown?: boolean }

export interface Led { part: string; index: number; current: number }
export interface Solution {
  v: Float64Array
  leds: Led[]
  /** board pin → level it reads (inputs) */
  inputs: Map<string, boolean>
  /** analog channel → volts */
  adc: Map<number, number>
  /** board pin → current out of it (A) */
  pinCurrent: Map<string, number>
  warnings: string[]
  /** what catalogue parts show (relay on, meter text …) */
  views: Map<string, ModView>
}

const R_OUT = 25, R_PULLUP = 37e3, LEAK = 1e-9, R_ON = 0.05

const VF: Record<string, number> = { red: 1.8, orange: 1.9, yellow: 2.0, green: 2.1, lime: 2.1, blue: 3.0, white: 3.0, purple: 3.0, violet: 3.0 }
export const LED_NOMINAL = 0.02

export interface Res { a: number; b: number; r: number; part?: string; what?: string }
export interface Diode { a: number; c: number; vf: number; rs: number; part: string; index: number; color?: string; /** false: a junction, not a light */ led?: boolean }
interface Ext { actives: Active[]; seqs: Seq[]; fsrcs: [number, number, number, number][]; views: Map<string, (v: Float64Array) => ModView> }
interface Src { n: number; v: number; r: number; what: string }

export class Circuit {
  readonly netCount: number
  private parent: number[] = []
  private key = new Map<string, number>()
  /** board pin (canonical) → net */
  readonly boardNet = new Map<string, number>()
  readonly boardId: string | null
  /** net → names of the pins on it (for the Inspector and wire colours) */
  readonly members: string[][] = []

  readonly diagram: Diagram
  readonly board: BoardDef | undefined
  /** per-part memory that outlives a solve (flip-flops) */
  private mem = new Map<string, Record<string, unknown>>()
  /** sequential state, part of the solution cache key */
  stateKey(): string { let s = ""; for (const [id, m] of this.mem) if (m.ff) { const f = m.ff as { q: boolean; clk: boolean }; s += `${id}${+f.q}${+f.clk}` } return s }

  constructor(diagram: Diagram, board: BoardDef | undefined) {
    this.diagram = diagram
    this.board = board
    const boardPart = diagram.parts.find((p) => isBoardType(p.type))
    this.boardId = boardPart?.id ?? null
    const canon = (end: string) => {
      const [id, pin] = splitEnd(end)
      return `${id}:${canonicalPin(id === this.boardId ? board : undefined, pin)}`
    }
    const node = (k: string) => { let n = this.key.get(k); if (n === undefined) { n = this.parent.length; this.parent.push(n); this.key.set(k, n) } return n }
    for (const [a, b] of diagram.connections) this.union(node(canon(a)), node(canon(b)))
    // every pin of every part gets a node, so lookups never fail
    if (board && this.boardId) for (const pin of [...Object.keys(board.pins), ...Object.keys(board.power), "GND", "AREF", "RESET"]) node(`${this.boardId}:${pin}`)
    // compress to 0..n-1
    const root = new Map<number, number>()
    const final = new Map<string, number>()
    for (const [k, n] of this.key) {
      const r = this.find(n)
      if (!root.has(r)) root.set(r, root.size)
      final.set(k, root.get(r)!)
    }
    this.key = final
    this.netCount = root.size
    for (let i = 0; i < this.netCount; i++) this.members.push([])
    for (const [k, n] of final) this.members[n].push(k)
    if (this.boardId) for (const [k, n] of final) if (k.startsWith(`${this.boardId}:`)) this.boardNet.set(k.slice(this.boardId.length + 1), n)
  }

  private find(n: number): number { while (this.parent[n] !== n) n = this.parent[n] = this.parent[this.parent[n]]; return n }
  private union(a: number, b: number) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.parent[ra] = rb }

  /** The net of a part's pin (canonical name), or -1 when it is not wired. */
  net(partId: string, pin: string): number {
    const n = this.key.get(`${partId}:${canonicalPin(partId === this.boardId ? this.board : undefined, pin)}`)
    return n ?? -1
  }
  /** Is this part's pin on a net with another part's pin? */
  wired(partId: string, pin: string) { const n = this.net(partId, pin); return n >= 0 && this.members[n].length > 1 }

  /** Supply voltage present on a net from the board's power pins (5 V / 3.3 V), else 0. */
  supply(n: number): number {
    if (n < 0) return 0
    for (const [pin, v] of Object.entries(this.board?.power ?? {})) if (n === this.boardNet.get(pin)) return v
    return 0
  }
  isGround(n: number) { return n >= 0 && n === this.boardNet.get("GND") }

  solve(pins: Map<string, PinLevel>, ui: Record<string, PartUi>, drives: Map<string, Drive>, prevInputs?: Map<string, boolean>): Solution {
    const res: Res[] = [], diodes: Diode[] = [], srcs: Src[] = []
    const warnings: string[] = []
    const N = this.netCount
    const b = this.board
    // board: power, ground, pins
    if (b && this.boardId) {
      const add = (pin: string, v: number, r: number) => { const n = this.boardNet.get(pin); if (n !== undefined && this.members[n].length > 1) srcs.push({ n, v, r, what: pin }) }
      for (const [pin, v] of Object.entries(b.power)) add(pin, v, v < 4 ? 0.5 : R_ON)
      add("GND", 0, R_ON)
      for (const [pin, lv] of pins) {
        const n = this.boardNet.get(pin)
        if (n === undefined) continue
        if (lv.out !== null) srcs.push({ n, v: lv.out ? b.vcc : 0, r: R_OUT, what: pin })
        else if (lv.pullup) srcs.push({ n, v: b.vcc, r: R_PULLUP, what: `${pin} pull-up` })
        else if (lv.pulldown) srcs.push({ n, v: 0, r: R_PULLUP * 1.5, what: `${pin} pull-down` })
      }
    }
    const ext: Ext = { actives: [], seqs: [], fsrcs: [], views: new Map() }
    for (const part of this.diagram.parts) this.stamp(part, ui[part.id] ?? {}, res, diodes, ext)
    for (const [k, d] of drives) {
      const [id, pin] = splitEnd(k)
      const n = this.net(id, pin)
      if (n >= 0) srcs.push({ n, v: d.v, r: d.r, what: k })
    }

    // nodal solve with diode on/off and active-element iteration
    const on = diodes.map(() => false)
    let v: Float64Array = new Float64Array(N)
    const iterate = () => { for (let iter = 0; iter < 40; iter++) {
      const G = Array.from({ length: N }, () => new Float64Array(N))
      const I = new Float64Array(N)
      for (let i = 0; i < N; i++) G[i][i] += LEAK
      const cond = (a: number, c: number, g: number) => {
        if (a >= 0) G[a][a] += g
        if (c >= 0) G[c][c] += g
        if (a >= 0 && c >= 0) { G[a][c] -= g; G[c][a] -= g }
      }
      for (const r of res) if (r.a !== r.b) cond(r.a, r.b, 1 / Math.max(r.r, 1e-3))
      for (const s of srcs) { const g = 1 / s.r; G[s.n][s.n] += g; I[s.n] += s.v * g }
      const fsrc = (a: number, b: number, volts: number, r: number) => { if (a < 0 || b < 0) return; cond(a, b, 1 / r); I[a] += volts / r; I[b] -= volts / r }
      for (const [a, b2, volts, r] of ext.fsrcs) fsrc(a, b2, volts, r)
      const st = {
        cond: (a: number, c: number, g: number) => { if (a >= 0 && c >= 0 && a !== c) cond(a, c, g) },
        src: (n: number, volts: number, r: number) => { if (n >= 0) { G[n][n] += 1 / r; I[n] += volts / r } },
        fsrc,
        vcvs: (o: number, p: number, m: number, gain: number, r: number) => { if (o < 0) return; const g = 1 / r; G[o][o] += g; if (p >= 0) G[o][p] -= g * gain; if (m >= 0) G[o][m] += g * gain },
      }
      for (const a of ext.actives) a.stamp(st)
      diodes.forEach((d, i) => {
        if (d.a < 0 || d.c < 0 || d.a === d.c) return
        if (on[i]) { const g = 1 / d.rs; cond(d.a, d.c, g); I[d.a] += d.vf * g; I[d.c] -= d.vf * g }
        else cond(d.a, d.c, LEAK)
      })
      v = gauss(G, I)
      let changed = false
      diodes.forEach((d, i) => {
        if (d.a < 0 || d.c < 0) return
        const vd = v[d.a] - v[d.c]
        const want = on[i] ? (vd - d.vf) / d.rs > -1e-9 : vd > d.vf
        if (want !== on[i]) { on[i] = want; changed = true }
      })
      for (const a of ext.actives) if (a.update(v)) changed = true
      if (!changed) break
    } }
    iterate()
    // flip-flops: a rising clock edge changes their outputs — solve again
    for (let k = 0; k < 4; k++) { let edge = false; for (const s of ext.seqs) if (s.clock(v)) edge = true; if (!edge) break; iterate() }

    const views = new Map<string, ModView>()
    for (const [id, f] of ext.views) views.set(id, f(v))
    const leds: Led[] = diodes.filter((d) => d.led !== false).map((d) => ({ d, i: diodes.indexOf(d) })).map(({ d, i }) => ({ part: d.part, index: d.index, current: on[i] && d.a >= 0 && d.c >= 0 ? Math.max(0, (v[d.a] - v[d.c] - d.vf) / d.rs) : 0 }))
    const inputs = new Map<string, boolean>()
    const adc = new Map<number, number>()
    const pinCurrent = new Map<string, number>()
    if (b) {
      for (const [pin, bp] of Object.entries(b.pins)) {
        const n = this.boardNet.get(pin)
        if (n === undefined) continue
        const volts = v[n]
        if (bp.adc !== undefined) adc.set(bp.adc, Math.max(0, Math.min(b.vcc, volts)))
        const lv = pins.get(pin)
        if (lv && lv.out === null && bp.bit >= 0) {
          const prev = prevInputs?.get(pin) ?? false
          inputs.set(pin, volts > b.vcc * 0.6 ? true : volts < b.vcc * 0.3 ? false : prev)
        }
      }
    }
    for (const s of srcs) {
      const i = (s.v - v[s.n]) / s.r
      if (s.r === R_OUT) {
        pinCurrent.set(s.what, i)
        const max = b?.chip === "rp2040" ? 0.012 : 0.04 // RP2040: 12 mA drive setting; AVR: 40 mA absolute maximum
        if (Math.abs(i) > max) warnings.push(`Pin ${s.what} ${i > 0 ? "sources" : "sinks"} ${(Math.abs(i) * 1e3).toFixed(0)} mA — over the ${max * 1e3} mA ${b?.chip === "rp2040" ? "drive limit" : "absolute maximum"}`)
      } else if (s.r === R_ON && Math.abs(i) > 0.5) warnings.push(`${s.what} is shorted — ${Math.abs(i).toFixed(1)} A`)
    }
    for (const l of leds) {
      if (l.current > 0.03) {
        const d = diodes.find((x) => x.part === l.part && x.index === l.index)!
        const need = Math.round(((this.board?.vcc ?? 5) - d.vf) / LED_NOMINAL / 10) * 10
        warnings.push(`${l.part} draws ${(l.current * 1e3).toFixed(0)} mA — add a series resistor (about ${need} Ω)`)
      }
    }
    return { v, leds, inputs, adc, pinCurrent, warnings: [...new Set(warnings)], views }
  }

  /** The passive elements of the circuit for these controls (for exporting to SPICE). */
  elements(ui: Record<string, PartUi>): { res: Res[]; diodes: Diode[] } {
    const res: Res[] = [], diodes: Diode[] = []
    for (const part of this.diagram.parts) this.stamp(part, ui[part.id] ?? {}, res, diodes)
    return { res, diodes }
  }

  private stamp(p: DiagramPart, u: PartUi, res: Res[], diodes: Diode[], ext?: Ext) {
    const n = (pin: string) => this.net(p.id, pin)
    const R = (a: string, c: string, r: number) => res.push({ a: n(a), b: n(c), r, part: p.id, what: `${a}–${c}` })
    const D = (a: string, c: string, vf: number, index = 0, rs = 12, led = true) => diodes.push({ a: n(a), c: n(c), vf, rs, part: p.id, index, color: p.attrs.color, led })
    const t = p.type.replace(/^wokwi-/, "")
    switch (t) {
      case "resistor": R("1", "2", ohms(p.attrs.value, 1000)); break
      case "pushbutton": case "pushbutton-6mm": if (u.pressed) R("1", "2", 0.01); break
      case "slide-switch": if ((u.value ?? Number(p.attrs.value ?? 0)) ? true : false) R("2", "3", 0.01); else R("1", "2", 0.01); break
      case "tilt-switch": break
      case "dip-switch-8": for (let i = 0; i < 8; i++) if (u.values?.[i]) R(`${i + 1}a`, `${i + 1}b`, 0.01); break
      case "potentiometer": case "slide-potentiometer": {
        const max = t === "potentiometer" ? 1023 : 100
        const ratio = Math.min(1, Math.max(0, (u.value ?? Number(p.attrs.value ?? max / 2)) / max))
        const total = ohms(p.attrs.resistance, 10e3)
        R("VCC", "SIG", Math.max(1, total * (1 - ratio))); R("SIG", "GND", Math.max(1, total * ratio))
        break
      }
      case "led": D("A", "C", VF[p.attrs.color ?? "red"] ?? 2); break
      case "rgb-led": {
        const anode = p.attrs.common === "anode"
        ;(["R", "G", "B"] as const).forEach((c, i) => (anode ? D("COM", c, c === "R" ? 1.8 : 3, i) : D(c, "COM", c === "R" ? 1.8 : 3, i)))
        break
      }
      case "led-bar-graph": for (let i = 1; i <= 10; i++) D(`A${i}`, `C${i}`, 2, i - 1); break
      case "7segment": {
        const digits = Number(p.attrs.digits ?? 1) || 1
        const anode = p.attrs.common === "anode"
        const segs = ["A", "B", "C", "D", "E", "F", "G", "DP"]
        for (let d = 0; d < digits; d++) {
          const com = digits === 1 ? "COM" : `DIG${d + 1}`
          segs.forEach((s, i) => (anode ? D(com, s, 2, d * 8 + i) : D(s, com, 2, d * 8 + i)))
        }
        break
      }
      case "buzzer": R("1", "2", 1000); break
      default: {
        const c = catalogPart(p.type)
        if (!c || c.legacy) break
        let mem = this.mem.get(p.id)
        if (!mem) this.mem.set(p.id, (mem = {}))
        stampPart(c, { part: p, n, R, D, ui: u, vcc: this.board?.vcc ?? 5, mem }, ext ?? { actives: [], seqs: [], fsrcs: [], views: new Map() })
      }
    }
  }
}

/** Solve G·x = I (Gaussian elimination with partial pivoting). */
export function gauss(G: Float64Array[], I: Float64Array): Float64Array {
  const n = I.length
  const A = G.map((row, i) => { const r = new Float64Array(n + 1); r.set(row); r[n] = I[i]; return r })
  for (let c = 0; c < n; c++) {
    let best = c
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[best][c])) best = r
    if (best !== c) [A[best], A[c]] = [A[c], A[best]]
    const piv = A[c][c]
    if (Math.abs(piv) < 1e-300) continue
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / piv
      if (f === 0) continue
      const Ar = A[r], Ac = A[c]
      for (let k = c; k <= n; k++) Ar[k] -= f * Ac[k]
    }
  }
  const x = new Float64Array(n)
  for (let r = n - 1; r >= 0; r--) {
    let s = A[r][n]
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k]
    x[r] = Math.abs(A[r][r]) < 1e-300 ? 0 : s / A[r][r]
  }
  return x
}
