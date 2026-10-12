// A board whose chip runs outside the simulation worker — a Raspberry Pi's Linux VM, a Renode
// board — as the simulator sees it. The main thread runs the chip in lockstep frames (src/linux,
// src/renode: the same ChipLink as in schematics) and feeds each frame here: the pins' states at
// its start and every change with its time. Time only advances as far as the frames fed so far;
// input levels the circuit sets are handed back for the next frame.
import type { BoardDef } from "./boards"
import type { FrameOut } from "@/cosim/chip"
import { newTrack, takeWindow, trackChange, type I2CController, type I2CEvents, type Machine, type PinTrack } from "./machine"

export class FedMachine implements Machine {
  readonly board: BoardDef
  /** nanoseconds */
  readonly hz = 1e9
  readonly track = new Map<string, PinTrack>()
  onPinChange: ((pins: string[]) => void) | null = null
  onSerial: ((text: string) => void) | null = null
  /** input levels changed: the main thread sends them with the next frame */
  onInputs: ((levels: [string, boolean][]) => void) | null = null
  private t = 0
  /** how far the fed frames reach */
  private known = 0
  private queue: { at: number; pin: string; out: boolean | null; pu: boolean; pd: boolean }[] = []
  private inputs = new Map<string, boolean>()
  private timers: { at: number; fn: () => void }[] = []

  constructor(board: BoardDef) {
    this.board = board
    for (const pin of Object.keys(board.pins)) this.track.set(pin, newTrack())
  }
  get now() { return this.t }
  get seconds() { return this.t / 1e9 }

  /** A frame from the chip, in its own seconds (it starts where the last one ended). */
  feed(f: FrameOut, seconds: number) {
    const t0 = this.known
    const set = (pin: string, out: 0 | 1 | -1, pu: boolean, pd: boolean, at: number) => this.queue.push({ at, pin, out: out === -1 ? null : out === 1, pu, pd })
    for (const [pin, s] of f.start) if (this.track.has(pin)) set(pin, s.out, s.pu, s.pd, t0)
    for (const e of f.events) if (this.track.has(e.pin)) set(e.pin, e.out, e.pu, e.pd, t0 + Math.round(e.t * 1e9))
    this.queue.sort((a, b) => a.at - b.at)
    this.known = t0 + Math.round(seconds * 1e9)
    if (f.serial) this.onSerial?.(f.serial)
  }

  /** Time passes — but never past what the chip has run. */
  runFor(ticks: number) {
    const end = Math.min(this.t + ticks, this.known)
    while (true) {
      const q = this.queue[0], tm = this.timers[0]
      const next = Math.min(q && q.at <= end ? q.at : Infinity, tm && tm.at <= end ? tm.at : Infinity)
      if (next === Infinity) break
      this.t = Math.max(this.t, next)
      if (q && q.at === next) {
        this.queue.shift()
        if (trackChange(this.track.get(q.pin)!, q.out, q.pu, q.pd, this.t)) this.onPinChange?.([q.pin])
      } else {
        this.timers.shift()!.fn()
      }
    }
    this.t = Math.max(this.t, end)
  }

  setInput(pin: string, high: boolean) {
    if (this.inputs.get(pin) === high) return
    this.inputs.set(pin, high)
    this.onInputs?.([...this.inputs])
  }
  /** no ADC on these boards' bridges yet */
  setAnalog() {}
  serialWrite() { /* the Serial Monitor talks to the chip on the main thread */ }
  takeWindow() { return takeWindow(this.track, this.t) }
  schedule(fn: () => void, ticks: number) {
    this.timers.push({ at: this.t + Math.max(1, Math.round(ticks)), fn })
    this.timers.sort((a, b) => a.at - b.at)
  }
  attachI2C(_events: I2CEvents): I2CController {
    const nop = () => {}
    return { completeStart: nop, completeStop: nop, completeConnect: nop, completeWrite: nop, completeRead: nop }
  }
}
