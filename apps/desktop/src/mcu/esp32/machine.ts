// The ESP32 as the simulator sees it: QEMU runs the firmware in real time elsewhere; pin activity
// arrives as bridge frames (A5 cmd pin lo hi — see bridge.ts) and inputs go back the same way.
// Time is in nanoseconds of wall-clock time (QEMU runs at real speed).
import type { BoardDef } from "../boards"
import { newTrack, takeWindow, trackChange, type I2CController, type I2CEvents, type Machine, type PinTrack } from "../machine"

export class Esp32Machine implements Machine {
  readonly board: BoardDef
  readonly hz = 1e9
  readonly track = new Map<string, PinTrack>()
  onPinChange: ((pins: string[]) => void) | null = null
  onSerial: ((text: string) => void) | null = null
  /** frames to send to the firmware; those made before anyone listens wait in `queued` */
  private out: ((bytes: number[]) => void) | null = null
  private queued: number[] = []
  get onOutput() { return this.out }
  set onOutput(fn: ((bytes: number[]) => void) | null) { this.out = fn; if (fn && this.queued.length) fn(this.queued.splice(0)) }
  private emit(bytes: number[]) { if (this.out) this.out(bytes); else this.queued.push(...bytes) }
  private t = 0
  private rx: number[] = []
  private byGpio = new Map<number, string[]>()
  private mode = new Map<number, number>()
  private sentIn = new Map<number, number>()
  private sentMv = new Map<number, number>()
  private pwm = new Map<number, number>()

  constructor(board: BoardDef) {
    this.board = board
    for (const [pin, bp] of Object.entries(board.pins)) {
      this.track.set(pin, newTrack())
      this.byGpio.set(bp.bit, [...(this.byGpio.get(bp.bit) ?? []), pin])
    }
  }
  get now() { return this.t }
  get seconds() { return this.t / 1e9 }

  /** bridge bytes from QEMU's UART2 */
  feed(bytes: number[]) {
    this.rx.push(...bytes)
    while (this.rx.length >= 5) {
      if (this.rx[0] !== 0xa5) { this.rx.shift(); continue }
      const [, cmd, gpio, lo, hi] = this.rx.splice(0, 5)
      const v = lo | (hi << 8)
      const pins = this.byGpio.get(gpio) ?? []
      const set = (out: boolean | null, pullup: boolean, pulldown: boolean) => {
        const changed = pins.filter((p) => trackChange(this.track.get(p)!, out, pullup, pulldown, this.t))
        if (changed.length) this.onPinChange?.(changed)
      }
      if (cmd === 0x4d) { // 'M' pinMode: 0x01 INPUT, 0x03 OUTPUT, 0x05 INPUT_PULLUP, 0x09 INPUT_PULLDOWN (arduino-esp32)
        this.mode.set(gpio, v)
        if (v & 0x02) set(false, false, false)
        else set(null, !!(v & 0x04), !!(v & 0x08))
      } else if (cmd === 0x57) set(v ? true : false, false, false) // 'W' digitalWrite
      else if (cmd === 0x50) { this.pwm.set(gpio, v); set(v > 0, false, false) } // 'P' ledcWrite duty: edges made in runFor
    }
  }
  setInput(pin: string, high: boolean) {
    const g = this.board.pins[pin]?.bit
    if (g === undefined || this.sentIn.get(g) === +high) return
    this.sentIn.set(g, +high)
    this.emit([0xa5, 0x49, g, high ? 1 : 0, 0])
  }
  /** `channel` is the GPIO number on the ESP32 */
  setAnalog(channel: number, volts: number) {
    const mv = Math.round(Math.max(0, Math.min(3.3, volts)) * 1000)
    if (Math.abs((this.sentMv.get(channel) ?? -100) - mv) < 3) return
    this.sentMv.set(channel, mv)
    this.emit([0xa5, 0x41, channel, mv & 0xff, mv >> 8])
  }
  serialWrite() { /* the Serial Monitor talks to QEMU's UART0 directly (main thread) */ }
  /** Time passes; PWM pins (ledcWrite reports a duty, not edges) toggle at 1 kHz with that duty. */
  runFor(ticks: number) {
    const end = this.t + ticks
    const pwm = [...this.pwm].filter(([, d]) => d > 0 && d < 255)
    if (!pwm.length) { this.t = end; return }
    const P = 1e6 // 1 ms period
    while (this.t < end) {
      const start = this.t
      for (const [g] of pwm) this.edge(g, true, start)
      for (const [g, d] of [...pwm].sort((a, b) => a[1] - b[1])) this.edge(g, false, start + (d / 255) * P)
      this.t = Math.min(end, start + P)
    }
  }
  private edge(gpio: number, high: boolean, at: number) {
    const saved = this.t
    this.t = at
    const changed = (this.byGpio.get(gpio) ?? []).filter((p) => trackChange(this.track.get(p)!, high, false, false, at))
    if (changed.length) this.onPinChange?.(changed)
    this.t = saved
  }
  takeWindow() { return takeWindow(this.track, this.t) }
  schedule(fn: () => void, ticks: number) { setTimeout(fn, ticks / 1e6) }
  attachI2C(_events: I2CEvents): I2CController {
    const nop = () => {}
    return { completeStart: nop, completeStop: nop, completeConnect: nop, completeWrite: nop, completeRead: nop }
  }
}
