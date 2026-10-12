// A Raspberry Pi Pico (RP2040, Cortex-M0+ at 125 MHz) running a compiled sketch, on rp2040js.
// The arduino-pico core's flash image (.bin) boots through the real B1 boot ROM. `Serial` is
// USB CDC (enumerated by rp2040js's USB host), `Serial1` is UART0 (GP0/GP1); both go to the
// Serial Monitor. Time is in nanoseconds.
import { GPIOPinState, I2CMode, RP2040, USBCDC } from "rp2040js"
import type { BoardDef } from "./boards"
import { newTrack, takeWindow, trackChange, type I2CController, type I2CEvents, type Machine, type PinTrack } from "./machine"
import { bootromB1 } from "./rp2040-bootrom"

const CYCLE_NS = 1e9 / 125e6
/** rp2040js's SimulationClock (the default clock of an RP2040) */
interface SimulationClock { readonly nanos: number; readonly nanosToNextAlarm: number; tick(nanos: number): void; createAlarm(cb: () => void): { schedule(nanos: number): void } }

export class Rp2040Machine implements Machine {
  readonly board: BoardDef
  readonly mcu: RP2040
  readonly hz = 1e9
  readonly track = new Map<string, PinTrack>()
  onPinChange: ((pins: string[]) => void) | null = null
  onSerial: ((text: string) => void) | null = null
  private clock: SimulationClock
  private cdc: USBCDC
  private connected = false
  private pending: number[] = []
  private out = ""
  private decoder = new TextDecoder()

  constructor(board: BoardDef, firmware: Uint8Array) {
    this.board = board
    this.mcu = new RP2040()
    this.clock = this.mcu.clock as unknown as SimulationClock
    this.mcu.loadBootrom(bootromB1)
    if (firmware.length > this.mcu.flash.length) throw new Error(`The program is larger than the Pico's flash (${this.mcu.flash.length} bytes)`)
    this.mcu.flash.set(firmware, 0)
    this.mcu.core.PC = 0x10000000
    // PIO: rp2040js runs it on its own timer; here it steps with the CPU clock instead
    for (const pio of this.mcu.pio) (pio as unknown as { run: () => void }).run = () => {}
    // USB serial (Serial) and UART0 (Serial1)
    this.cdc = new USBCDC(this.mcu.usbCtrl)
    this.cdc.onDeviceConnected = () => { this.connected = true; for (const b of this.pending.splice(0)) this.cdc.sendSerialByte(b) }
    this.cdc.onSerialData = (buf) => { this.out += this.decoder.decode(buf, { stream: true }) }
    this.mcu.uart.forEach((u, port) => { u.onByte = (v) => { if (port === 0) this.out += String.fromCharCode(v); this.onUartTx?.(port, v) } })
    for (const [pin, bp] of Object.entries(board.pins)) {
      const g = this.mcu.gpio[bp.bit]
      if (!g) continue
      const t = newTrack()
      this.track.set(pin, t)
      g.addListener((state) => {
        const out = state === GPIOPinState.High ? true : state === GPIOPinState.Low ? false : null
        if (trackChange(t, out, state === GPIOPinState.InputPullUp, state === GPIOPinState.InputPullDown, this.now)) this.onPinChange?.([pin])
      })
    }
  }

  get now() { return this.clock.nanos }
  get seconds() { return this.clock.nanos / 1e9 }

  setInput(pin: string, high: boolean) {
    const bp = this.board.pins[pin]
    if (bp) this.mcu.gpio[bp.bit]?.setInputValue(high)
  }
  /** ADC channels 0–3 are GP26–GP29; 12-bit against 3.3 V. */
  setAnalog(channel: number, volts: number) {
    this.mcu.adc.channelValues[channel] = Math.round(Math.max(0, Math.min(1, volts / 3.3)) * 4095)
  }
  serialWrite(text: string) {
    for (const b of new TextEncoder().encode(text)) {
      if (this.connected) this.cdc.sendSerialByte(b); else this.pending.push(b)
      this.mcu.uart[0].feedByte(b)
    }
  }

  runFor(ticks: number) {
    const { mcu, clock } = this
    const end = clock.nanos + ticks
    while (clock.nanos < end) {
      if (mcu.core.waiting) {
        const next = clock.nanosToNextAlarm
        let dt = next > 0 ? Math.min(next, end - clock.nanos) : end - clock.nanos
        if (this.pioOn()) { dt = Math.max(CYCLE_NS, Math.min(dt, 256 * CYCLE_NS)); this.advance(Math.round(dt / CYCLE_NS)) }
        else clock.tick(dt)
      } else this.advance(mcu.core.executeInstruction())
    }
    if (this.out) { const s = this.out; this.out = ""; this.onSerial?.(s) }
  }

  // ── PIO with real timing ──
  // rp2040js executes one PIO instruction per step and leaves delays and the clock divider to
  // the caller; here every state machine runs its next instruction when its time comes:
  // (1 + delay cycles) × clock divider system cycles after the previous one.
  private sysCycles = 0
  private smNext = new Map<object, number>()
  private pioOn() { return (this.mcu.pio as unknown as { stopped: boolean }[]).some((p) => !p.stopped) }
  private advance(cycles: number) {
    if (!this.pioOn()) { this.sysCycles += cycles; this.clock.tick(cycles * CYCLE_NS); return }
    type SM = { enabled: boolean; cycles: number; clockDivInt: number; clockDivFrac: number; step(): void }
    const pios = this.mcu.pio as unknown as { stopped: boolean; machines: SM[]; checkChangedPins(): void }[]
    for (let k = 0; k < cycles; k++) {
      const now = this.sysCycles++
      for (const p of pios) {
        if (p.stopped) continue
        let ran = false
        for (const sm of p.machines) {
          if (!sm.enabled || (this.smNext.get(sm) ?? 0) > now) continue
          const before = sm.cycles
          sm.step()
          const spent = Math.max(1, sm.cycles - before)
          const div = (sm.clockDivInt || 65536) + sm.clockDivFrac / 256
          this.smNext.set(sm, now + spent * Math.max(1, div))
          ran = true
        }
        if (ran) p.checkChangedPins()
      }
      this.clock.tick(CYCLE_NS)
    }
  }

  takeWindow() { return takeWindow(this.track, this.now) }
  schedule(fn: () => void, ticks: number) { this.clock.createAlarm(fn).schedule(Math.max(1, ticks)) }

  onUartTx: ((port: number, b: number) => void) | null = null
  uartFeed(port: number, bytes: number[]) { for (const b of bytes) this.mcu.uart[port]?.feedByte(b) }
  /** SPI0 / SPI1 (arduino-pico: SPI on GP16–19, SPI1 on GP10–12). */
  attachSpi(transfer: (bus: number, mosi: number) => number) {
    // 16-bit frames (SPI.transfer16 sets DSS to 16) reach the devices as two bytes, MSB first
    this.mcu.spi.forEach((s, bus) => { s.onTransmit = (v) => s.completeTransmit(s.dataBits > 8 ? ((transfer(bus, (v >> 8) & 0xff) & 0xff) << 8) | (transfer(bus, v & 0xff) & 0xff) : transfer(bus, v) & 0xff) })
  }

  /** Wire (I2C0: GP4 = SDA, GP5 = SCL by default in arduino-pico). */
  attachI2C(events: I2CEvents): I2CController {
    const i2c = this.mcu.i2c[0]
    i2c.onStart = (repeated) => events.start(repeated)
    i2c.onStop = () => events.stop()
    i2c.onConnect = (addr, mode) => events.connectToSlave(addr, mode === I2CMode.Write)
    i2c.onWriteByte = (v) => events.writeByte(v)
    i2c.onReadByte = (ack) => events.readByte(ack)
    return i2c
  }
}
