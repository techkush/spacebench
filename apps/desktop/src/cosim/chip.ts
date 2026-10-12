// The chip side of a co-simulation: a board's real firmware on the emulator, run one frame at a
// time. Each frame starts with the levels and voltages the circuit put on its input pins, and
// reports every pin change with its time, so the circuit can be simulated over the same frame.
import { AvrMachine } from "@/mcu/avr"
import type { BoardDef } from "@/mcu/boards"
import type { Machine } from "@/mcu/machine"
import { Rp2040Machine } from "@/mcu/rp2040"

/** What a pin is doing: drives low/high (0/1) or is an input (-1), and its pull resistors. */
export interface PinState { out: 0 | 1 | -1; pu: boolean; pd: boolean }
/** A pin change, `t` seconds after the frame started. */
export interface PinEvent extends PinState { pin: string; t: number }

export interface FrameIn {
  /** simulated seconds to run */
  seconds: number
  /** input pins: the level the circuit puts on them */
  digital: [string, boolean][]
  /** ADC channels: volts */
  analog: [number, number][]
}
export interface FrameOut {
  /** every pin's state when the frame started */
  start: [string, PinState][]
  events: PinEvent[]
  serial: string
  /** the chip's clock after the frame */
  seconds: number
}

/** Talks to a chip, in a worker (the app) or in-process (tests). */
export interface ChipLink {
  frame(f: FrameIn): Promise<FrameOut>
  serialWrite(text: string): void
  dispose(): void
  /** a part's control changed on the canvas (Linux boards: the camera / microphone feeders) */
  ui?(part: string, u: { v?: Record<string, number> }): void
}

export class ChipRunner {
  readonly machine: Machine
  private readonly pins: string[]
  private events: PinEvent[] = []
  private serial = ""
  private t0 = 0

  constructor(board: BoardDef, firmware: string | Uint8Array) {
    if (board.chip === "rp2040") {
      if (typeof firmware === "string") throw new Error("The Pico needs a .bin flash image")
      this.machine = new Rp2040Machine(board, firmware)
    } else if (board.chip === "atmega328p" || board.chip === "atmega2560" || board.chip === "attiny85") {
      if (typeof firmware !== "string") throw new Error("AVR boards need an Intel HEX file")
      this.machine = new AvrMachine(board, firmware)
    } else throw new Error(`${board.name} can't run inside a schematic yet`)
    this.pins = Object.keys(board.pins)
    this.machine.onSerial = (s) => { this.serial += s }
    this.machine.onPinChange = (pins) => {
      const t = (this.machine.now - this.t0) / this.machine.hz
      for (const pin of pins) this.events.push({ pin, t, ...this.state(pin) })
    }
  }

  private state(pin: string): PinState {
    const tr = this.machine.track.get(pin)
    return { out: tr?.out === true ? 1 : tr?.out === false ? 0 : -1, pu: !!tr?.pullup, pd: !!tr?.pulldown }
  }

  frame(f: FrameIn): FrameOut {
    for (const [pin, high] of f.digital) this.machine.setInput(pin, high)
    for (const [ch, v] of f.analog) this.machine.setAnalog(ch, v)
    this.t0 = this.machine.now
    const start = this.pins.map((p): [string, PinState] => [p, this.state(p)])
    this.events = []
    this.machine.runFor(Math.round(f.seconds * this.machine.hz))
    const out: FrameOut = { start, events: this.events, serial: this.serial, seconds: this.machine.seconds }
    this.events = []
    this.serial = ""
    return out
  }

  serialWrite(text: string) { this.machine.serialWrite(text) }
}

/** The chip on this thread (tests, or when workers aren't available). */
export function localChip(board: BoardDef, firmware: string | Uint8Array): ChipLink {
  const r = new ChipRunner(board, firmware)
  return { frame: async (f) => r.frame(f), serialWrite: (t) => r.serialWrite(t), dispose: () => {} }
}
