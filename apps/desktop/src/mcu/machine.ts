// What every emulated chip offers the simulator (avr.ts: ATmega328P / 2560, rp2040.ts: RP2040):
// time-stamped pin activity, inputs, ADC, serial, timed events and an I²C controller.
import type { BoardDef } from "./boards"

/** What one board pin did. Times are in the machine's ticks (`hz` per second). */
export interface PinTrack {
  /** current output level (true = high) when driven, null when the pin is an input */
  out: boolean | null
  pullup: boolean
  pulldown: boolean
  /** ticks spent high in the current window */
  highCycles: number
  windowStart: number
  lastChange: number
  /** the last complete high pulse and the period (rising edge to rising edge), in ticks */
  pulse: number
  period: number
  lastRise: number
  /** level transitions in the window */
  toggles: number
}

export const newTrack = (): PinTrack => ({ out: null, pullup: false, pulldown: false, highCycles: 0, windowStart: 0, lastChange: 0, pulse: 0, period: 0, lastRise: -1, toggles: 0 })

/** Record a pin's new state at `now`; false when nothing changed. */
export function trackChange(t: PinTrack, out: boolean | null, pullup: boolean, pulldown: boolean, now: number): boolean {
  if (t.out === out && t.pullup === pullup && t.pulldown === pulldown) return false
  const wasHigh = t.out === true, isHigh = out === true
  if (wasHigh) t.highCycles += now - Math.max(t.lastChange, t.windowStart)
  if (wasHigh !== isHigh) {
    t.toggles++
    if (isHigh) { if (t.lastRise >= 0) t.period = now - t.lastRise; t.lastRise = now }
    else if (t.lastRise >= 0) t.pulse = now - t.lastRise
  }
  t.out = out; t.pullup = pullup; t.pulldown = pulldown; t.lastChange = now
  return true
}

/** Duty cycle and transitions per pin since the last call, and restart the window. */
export function takeWindow(track: Map<string, PinTrack>, now: number): Map<string, { duty: number; toggles: number }> {
  const out = new Map<string, { duty: number; toggles: number }>()
  for (const [pin, t] of track) {
    const span = now - t.windowStart
    let high = t.highCycles
    if (t.out === true) high += now - Math.max(t.lastChange, t.windowStart)
    out.set(pin, { duty: span > 0 ? Math.min(1, high / span) : t.out ? 1 : 0, toggles: t.toggles })
    t.highCycles = 0; t.toggles = 0; t.windowStart = now
  }
  return out
}

/** The I²C controller side, as both avr8js's TWI and rp2040js's I2C expose it. */
export interface I2CController {
  completeStart(): void
  completeStop(): void
  completeConnect(ack: boolean): void
  completeWrite(ack: boolean): void
  completeRead(value: number): void
}
/** Bus events from the controller (what the firmware does). */
export interface I2CEvents {
  start(repeated: boolean): void
  stop(): void
  connectToSlave(addr: number, write: boolean): void
  writeByte(value: number): void
  readByte(ack: boolean): void
}

export interface Machine {
  readonly board: BoardDef
  /** ticks per second of `now` */
  readonly hz: number
  readonly now: number
  readonly seconds: number
  readonly track: Map<string, PinTrack>
  onPinChange: ((pins: string[]) => void) | null
  onSerial: ((text: string) => void) | null
  setInput(pin: string, high: boolean): void
  /** volts on an ADC channel */
  setAnalog(channel: number, volts: number): void
  serialWrite(text: string): void
  /** run `ticks` of simulated time */
  runFor(ticks: number): void
  takeWindow(): Map<string, { duty: number; toggles: number }>
  /** call `fn` after `ticks` of simulated time */
  schedule(fn: () => void, ticks: number): void
  /** connect an I²C bus to the chip's controller (bus 0) */
  attachI2C(events: I2CEvents): I2CController
  /**
   * connect the chip's hardware SPI controllers: `transfer` gets each byte the firmware sends on
   * a bus (0, 1 …) and returns the byte read back on MISO. Chips without one leave it out.
   */
  attachSpi?(transfer: (bus: number, mosi: number) => number): void
  /** a byte the firmware sent on a hardware UART (port 0 = Serial on the AVR, Serial1 on the Pico) */
  onUartTx?: ((port: number, b: number) => void) | null
  /** bytes arriving on a hardware UART's RX */
  uartFeed?(port: number, bytes: number[]): void
}
