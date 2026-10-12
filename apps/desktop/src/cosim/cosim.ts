// Circuit + firmware, simulated together. The schematic runs on ngspice and every programmable
// board in it runs its real firmware on the emulator; they advance in lockstep frames:
//
//   1. each chip runs one frame (e.g. 20 ms) with the input levels / ADC voltages the circuit had
//      at the end of the previous frame;
//   2. what its pins did — every edge, with its time — becomes PWL sources on the board's pins;
//   3. ngspice simulates the whole circuit over the same frame, starting from the previous
//      frame's node voltages (.ic), so capacitors keep their charge;
//   4. the pin voltages at the end of the frame are what the chips read next.
//
// Outputs are exact to the edge; inputs lag by one frame (the chip reads the circuit as it was
// when the frame began). Inductor currents restart at each frame boundary.
import type { LivePin } from "@/mcu/sim"
import type { Doc } from "@/editor/model"
import { deriveNetlist, type Netlist } from "@/editor/netlist"
import type { JobResult, TranResult } from "@/lib/engine"
import { getSymbol } from "@/lib/kicad"
import { buildNetlist, type SpiceNetlist } from "@/lib/spice"
import type { BoardDef } from "@/mcu/boards"
import { pinRole, type BoardDrive, type PinDrive, type Wave } from "./boards"
import type { ChipLink, FrameOut, PinEvent, PinState } from "./chip"

export type Simulator = (net: SpiceNetlist) => Promise<JobResult>

export interface CoSimBoard { ref: string; board: BoardDef; chip: ChipLink }

export interface CoSimOptions {
  /** simulated seconds per frame */
  frame?: number
  /** seconds of history kept in `window` */
  window?: number
  /** a pin with more edges than this in a frame is averaged (serial lines, NeoPixel data) */
  maxEdges?: number
}

export interface CoSimFrame {
  t0: number
  t1: number
  /** the rolling history of every signal, in absolute time */
  window: TranResult
  /** every signal's time-averaged value over the frame (LED brightness, wire colours, meters) */
  avg: Record<string, number>
  /** what each board printed this frame, by reference */
  serial: Record<string, string>
  /** wall-clock ms spent running the chips and in ngspice */
  chipMs: number
  spiceMs: number
  netlist: string
  /** each board's pins as its sketch sees them (the live code view), by reference */
  live: Record<string, Record<string, LivePin>>
}

interface BoardIo extends CoSimBoard {
  /** chip pin → schematic net */
  nets: Map<string, string>
  /** input levels the chip last read (Schmitt-trigger memory) */
  levels: Map<string, boolean>
}

const ADC_POINTS = 400

export class CoSim {
  /** simulated seconds */
  t = 0
  private doc: Doc
  private nl: Netlist
  private boards: BoardIo[]
  /** net → volts at the end of the last frame */
  private end = new Map<string, number>()
  private started = false
  private hist = new History()
  private o: Required<CoSimOptions>
  private simulate: Simulator

  constructor(doc: Doc, boards: CoSimBoard[], simulate: Simulator, o: CoSimOptions = {}) {
    this.simulate = simulate
    this.o = { frame: 0.02, window: 2, maxEdges: 400, ...o }
    this.doc = doc
    this.nl = deriveNetlist(doc)
    this.boards = boards.map((b) => ({ ...b, nets: new Map(), levels: new Map() }))
    this.mapPins()
  }

  /** The circuit changed while running (a value tuned, a switch flipped): the next frame uses it. */
  setDoc(doc: Doc) {
    this.doc = doc
    this.nl = deriveNetlist(doc)
    this.mapPins()
  }

  private mapPins() {
    for (const b of this.boards) {
      b.nets.clear()
      const part = this.doc.parts.find((p) => p.ref === b.ref)
      const sym = part && getSymbol(part.lib)
      if (!sym) continue
      for (const pin of sym.units.flatMap((u) => u.pins)) {
        const role = pinRole(b.board, pin.name)
        const net = this.nl.pinNet.get(`${b.ref}.${pin.n}`)
        if (role?.k === "io" && net !== undefined && !b.nets.has(role.pin)) b.nets.set(role.pin, net)
      }
    }
  }

  private volts(net: string) { return net === "0" ? 0 : this.end.get(net) ?? 0 }

  /** What the circuit puts on each board's inputs: logic levels (with hysteresis) and ADC volts. */
  private inputs(b: BoardIo) {
    const digital: [string, boolean][] = []
    const analog: [number, number][] = []
    const vcc = b.board.vcc
    for (const [pin, net] of b.nets) {
      const v = this.volts(net)
      const def = b.board.pins[pin]
      if (def.adc !== undefined) analog.push([def.adc, Math.max(0, Math.min(vcc, v))])
      if (def.bit < 0) continue
      // between the thresholds: the last level read (Schmitt trigger); an input that has never had a
      // defined level (floating) isn't set at all, so the chip's own pull-ups decide
      const prev = b.levels.get(pin)
      const high = v > 0.6 * vcc ? true : v < 0.3 * vcc ? false : prev
      if (high === undefined) continue
      b.levels.set(pin, high)
      digital.push([pin, high])
    }
    return { digital, analog }
  }

  /** Every pin of a board over the frame just run: its mode, level, PWM duty and volts. */
  private live(b: BoardIo, out: FrameOut, T: number): Record<string, LivePin> {
    const evs = new Map<string, PinEvent[]>()
    for (const e of out.events) { const l = evs.get(e.pin); if (l) l.push(e); else evs.set(e.pin, [e]) }
    const vcc = b.board.vcc
    const live: Record<string, LivePin> = {}
    for (const [pin, st] of out.start) {
      let s = st, t = 0, high = 0, toggles = 0
      for (const e of evs.get(pin) ?? []) {
        if (s.out === 1) high += e.t - t
        if ((s.out === 1) !== (e.out === 1)) toggles++
        s = e; t = e.t
      }
      if (s.out === 1) high += T - t
      const duty = T > 0 ? Math.min(1, high / T) : s.out === 1 ? 1 : 0
      const net = b.nets.get(pin)
      const mode = s.out !== -1 ? "out" : s.pu ? "pullup" : s.pd ? "pulldown" : "in"
      const v = net ? this.volts(net) : s.out !== -1 ? (toggles > 1 ? duty * vcc : s.out ? vcc : 0) : s.pu ? vcc : 0
      const floating = !net && mode === "in"
      live[pin] = { mode, v, level: floating ? 2 : v > vcc / 2 ? 1 : 0, duty, toggles }
    }
    return live
  }

  /** The PWL drive of every wired pin of a board over a frame. */
  private drives(b: BoardIo, out: FrameOut, T: number): BoardDrive {
    const evs = new Map<string, PinEvent[]>()
    for (const e of out.events) if (b.nets.has(e.pin)) { const l = evs.get(e.pin); if (l) l.push(e); else evs.set(e.pin, [e]) }
    const d: BoardDrive = new Map()
    for (const [pin, st] of out.start) if (b.nets.has(pin)) d.set(pin, pinDrive(st, evs.get(pin) ?? [], b.board.vcc, T, this.o.maxEdges))
    return d
  }

  /** Simulate one frame. The first call also finds the circuit's starting point (operating point). */
  async step(): Promise<CoSimFrame> {
    const T = this.o.frame
    let chipMs = 0
    if (!this.started) {
      // at reset every pin is an input: the operating point of the circuit around the boards
      const c0 = performance.now()
      const outs = await Promise.all(this.boards.map((b) => b.chip.frame({ seconds: 0, digital: [], analog: [] })))
      chipMs += performance.now() - c0
      const boards = new Map(this.boards.map((b, i) => [b.ref, this.drives(b, outs[i], T)]))
      const op = await this.simulate(buildNetlist(this.doc, this.nl, "op", { boards }))
      if (op.type === "op") op.names.forEach((n, i) => { const m = /^V\((.*)\)$/.exec(n); if (m) this.end.set(m[1], op.values[i]) })
      this.started = true
    }

    const c0 = performance.now()
    const outs = await Promise.all(this.boards.map((b) => b.chip.frame({ seconds: T, ...this.inputs(b) })))
    chipMs += performance.now() - c0

    const boards = new Map(this.boards.map((b, i) => [b.ref, this.drives(b, outs[i], T)]))
    const fdoc: Doc = { ...this.doc, analyses: { ...this.doc.analyses, tran: { stop: T, step: T / 500 } } }
    const net = buildNetlist(fdoc, this.nl, "tran", { boards, ic: this.end })
    const s0 = performance.now()
    const res = await this.simulate(net)
    const spiceMs = performance.now() - s0
    if (res.type !== "tran") throw new Error("ngspice didn't return a transient result")

    const t0 = this.t
    this.t += T
    const avg: Record<string, number> = {}
    const n = res.time.length
    const span = res.time[n - 1] - res.time[0]
    res.names.forEach((name, i) => {
      const y = res.data[i]
      let area = 0
      for (let k = 1; k < n; k++) area += ((y[k] + y[k - 1]) / 2) * (res.time[k] - res.time[k - 1])
      avg[name] = span > 0 ? area / span : y[n - 1]
      const m = /^V\((.*)\)$/.exec(name)
      if (m) this.end.set(m[1], y[n - 1])
    })
    this.hist.add(t0, res)
    this.hist.trim(this.t - this.o.window)
    return {
      t0, t1: this.t, window: this.hist.result(), avg, chipMs, spiceMs, netlist: net.text,
      serial: Object.fromEntries(this.boards.map((b, i) => [b.ref, outs[i].serial])),
      live: Object.fromEntries(this.boards.map((b, i) => [b.ref, this.live(b, outs[i], T)])),
    }
  }

  serialWrite(ref: string, text: string) { this.boards.find((b) => b.ref === ref)?.chip.serialWrite(text) }

  dispose() { for (const b of this.boards) b.chip.dispose() }
}

/** One pin over a frame: its start state and changes → steps of level, drive, pull-up, pull-down. */
export function pinDrive(st: PinState, events: PinEvent[], vcc: number, T: number, maxEdges: number): PinDrive {
  const ch = { v: [] as [number, number][], en: [] as [number, number][], pu: [] as [number, number][], pd: [] as [number, number][] }
  const push = (k: keyof typeof ch, t: number, x: number) => {
    const l = ch[k]
    if (l.length && l[l.length - 1][1] === x) return
    if (l.length && l[l.length - 1][0] === t) l[l.length - 1][1] = x
    else l.push([t, x])
  }
  for (const [t, s] of [[0, st] as const, ...events.map((e) => [e.t, e] as const)]) {
    if (s.out !== -1) push("v", t, s.out ? vcc : 0)
    else if (!ch.v.length) push("v", t, 0)
    push("en", t, s.out === -1 ? 0 : 1)
    push("pu", t, s.out === -1 && s.pu ? 1 : 0)
    push("pd", t, s.out === -1 && s.pd ? 1 : 0)
  }
  const wave = (l: [number, number][]): Wave => (l.length === 1 ? l[0][1] : l)
  const v = ch.v.length > maxEdges ? averaged(ch.v, T, ADC_POINTS) : ch.v
  return { v: wave(v), en: wave(ch.en), pu: wave(ch.pu), pd: wave(ch.pd) }
}

/** Steps → their mean over `bins` equal slices (a fast-toggling pin as the level a circuit integrates). */
function averaged(steps: [number, number][], T: number, bins: number): [number, number][] {
  const out: [number, number][] = []
  const w = T / bins
  let k = 0
  for (let b = 0; b < bins; b++) {
    const a = b * w, z = a + w
    let area = 0
    while (k + 1 < steps.length && steps[k + 1][0] <= a) k++
    for (let j = k; j < steps.length && steps[j][0] < z; j++) {
      const from = Math.max(a, steps[j][0]), to = Math.min(z, steps[j + 1]?.[0] ?? Infinity)
      if (to > from) area += steps[j][1] * (to - from)
    }
    const mean = area / w
    if (!out.length || Math.abs(out[out.length - 1][1] - mean) > 1e-9) out.push([a, mean])
  }
  return out
}

/** The frames so far, stitched into one transient result (at most ~400 points per frame). */
class History {
  private time: number[] = []
  private cols = new Map<string, number[]>()

  add(t0: number, r: TranResult) {
    const n = r.time.length
    const stride = Math.max(1, Math.ceil(n / 400))
    const keep: number[] = []
    // the first point repeats the previous frame's last one
    for (let k = this.time.length ? 1 : 0; k < n; k += stride) keep.push(k)
    if (keep[keep.length - 1] !== n - 1) keep.push(n - 1)
    const before = this.time.length
    for (const k of keep) this.time.push(t0 + r.time[k])
    const seen = new Set<string>()
    r.names.forEach((name, i) => {
      seen.add(name)
      let col = this.cols.get(name)
      if (!col) this.cols.set(name, (col = new Array(before).fill(NaN)))
      for (const k of keep) col.push(r.data[i][k])
    })
    for (const [name, col] of this.cols) if (!seen.has(name)) for (let j = 0; j < keep.length; j++) col.push(NaN)
  }

  trim(from: number) {
    let i = 0
    while (i < this.time.length && this.time[i] < from) i++
    if (!i) return
    this.time.splice(0, i)
    for (const col of this.cols.values()) col.splice(0, i)
  }

  result(): TranResult {
    return { type: "tran", time: this.time.slice(), names: [...this.cols.keys()], data: [...this.cols.values()].map((c) => c.slice()), steps_accepted: 0, steps_rejected: 0 }
  }
}
