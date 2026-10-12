// An AVR microcontroller (ATmega328P, ATmega2560 or ATtiny85) running a compiled sketch, on avr8js.
// It executes in slices of simulated time; every pin change is time-stamped (CPU cycles), so
// the host can see PWM duty cycles, servo pulses and tone frequencies, not just levels.
import {
  AVRADC, AVRClock, AVREEPROM, AVRIOPort, AVRSPI, AVRTimer, AVRTWI, AVRUSART, AVRWatchdog, CPU, EEPROMMemoryBackend,
  adcConfig, atmega328Channels, avrInstruction, clockConfig, eepromConfig, portAConfig, portBConfig, portCConfig,
  portDConfig, portEConfig, portFConfig, portGConfig, portHConfig, portJConfig, portKConfig, portLConfig,
  spiConfig, timer0Config, timer1Config, timer2Config, twiConfig, usart0Config, watchdogConfig, PinState,
  ADCMuxInputType, ADCReference, ATtinyTimer1, attinyTimer1Config,
  type ADCConfig, type ADCMuxConfiguration, type AVRPortConfig, type AVRTimerConfig,
} from "avr8js"
import type { BoardDef, PortName } from "./boards"
import { parseHex } from "./hex"
import { newTrack, takeWindow, trackChange, type I2CController, type I2CEvents, type Machine, type PinTrack } from "./machine"

const PORT_CONFIGS: Record<PortName, AVRPortConfig> = {
  A: portAConfig, B: portBConfig, C: portCConfig, D: portDConfig, E: portEConfig, F: portFConfig,
  G: portGConfig, H: portHConfig, J: portJConfig, K: portKConfig, L: portLConfig,
}

// ── ATmega2560: same register addresses for most peripherals, different interrupt vectors ──
// (vector word address = (vector number − 1) × 2, from the datasheet's vector table)
const v = (n: number) => (n - 1) * 2
const EXT = (index: number, eicr: number, iscOffset: number) => ({ EICR: eicr, EIMSK: 0x3d, EIFR: 0x3c, iscOffset, index, interrupt: v(2 + index) })
const megaPorts: Partial<Record<PortName, AVRPortConfig>> = {
  B: { ...portBConfig, pinChange: { PCIE: 0, PCICR: 0x68, PCIFR: 0x3b, PCMSK: 0x6b, pinChangeInterrupt: v(10), mask: 0xff, offset: 0 }, externalInterrupts: [] },
  D: { ...portDConfig, pinChange: undefined, externalInterrupts: [EXT(0, 0x69, 0), EXT(1, 0x69, 2), EXT(2, 0x69, 4), EXT(3, 0x69, 6)] },
  E: { ...portEConfig, externalInterrupts: [null, null, null, null, EXT(4, 0x6a, 0), EXT(5, 0x6a, 2), EXT(6, 0x6a, 4), EXT(7, 0x6a, 6)] },
  C: { ...portCConfig, pinChange: undefined, externalInterrupts: [] },
  J: { ...portJConfig, pinChange: undefined, externalInterrupts: [] },
  K: { ...portKConfig, pinChange: undefined, externalInterrupts: [] },
}
const PB = portBConfig.PORT, PE = portEConfig.PORT, PG = portGConfig.PORT, PH = portHConfig.PORT, PL = portLConfig.PORT
const t16 = (base: number, timsk: number, tifr: number, vec: number, port: number, pins: [number, number, number]): AVRTimerConfig => ({
  ...timer1Config, TCCRA: base, TCCRB: base + 1, TCCRC: base + 2, TCNT: base + 4, ICR: base + 6, OCRA: base + 8, OCRB: base + 10, OCRC: base + 12,
  TIMSK: timsk, TIFR: tifr, captureInterrupt: v(vec), compAInterrupt: v(vec + 1), compBInterrupt: v(vec + 2), compCInterrupt: v(vec + 3), ovfInterrupt: v(vec + 4),
  compPortA: port, compPinA: pins[0], compPortB: port, compPinB: pins[1], compPortC: port, compPinC: pins[2], externalClockPort: 0, externalClockPin: 0,
})
const MEGA_TIMERS: AVRTimerConfig[] = [
  { ...timer0Config, compAInterrupt: v(22), compBInterrupt: v(23), ovfInterrupt: v(24), compPortA: PB, compPinA: 7, compPortB: PG, compPinB: 5 },
  { ...timer1Config, captureInterrupt: v(17), compAInterrupt: v(18), compBInterrupt: v(19), compCInterrupt: v(20), ovfInterrupt: v(21), compPortA: PB, compPinA: 5, compPortB: PB, compPinB: 6, compPortC: PB, compPinC: 7, OCRC: 0x8c },
  { ...timer2Config, compAInterrupt: v(14), compBInterrupt: v(15), ovfInterrupt: v(16), compPortA: PB, compPinA: 4, compPortB: PH, compPinB: 6 },
  t16(0x90, 0x71, 0x38, 32, PE, [3, 4, 5]),
  t16(0xa0, 0x72, 0x39, 42, PH, [3, 4, 5]),
  t16(0x120, 0x73, 0x3a, 47, PL, [3, 4, 5]),
]
const megaChannels: ADCMuxConfiguration = { ...atmega328Channels }
for (let i = 0; i < 8; i++) megaChannels[0x20 + i] = { type: ADCMuxInputType.SingleEnded, channel: 8 + i }

// ── ATtiny85: port B only, its own Timer0 / Timer1 / ADC layout, one-word vectors (vector n at
// word address n), no USART / TWI / SPI (ATTinyCore's Serial is software TX on PB0) ──
const TINY_PORTB: AVRPortConfig = {
  PIN: 0x36, DDR: 0x37, PORT: 0x38,
  pinChange: { PCIE: 5, PCICR: 0x5b, PCIFR: 0x5a, PCMSK: 0x35, pinChangeInterrupt: 2, mask: 0x3f, offset: 0 },
  externalInterrupts: [null, null, { EICR: 0x55, EIMSK: 0x5b, EIFR: 0x5a, iscOffset: 0, index: 6, interrupt: 1 }],
}
const TINY_TIMER0: AVRTimerConfig = {
  ...timer0Config, TCCRA: 0x4a, TCCRB: 0x53, TCNT: 0x52, OCRA: 0x49, OCRB: 0x48, TIFR: 0x58, TIMSK: 0x59,
  TOV: 0x02, OCFA: 0x10, OCFB: 0x08, TOIE: 0x02, OCIEA: 0x10, OCIEB: 0x08,
  ovfInterrupt: 5, compAInterrupt: 10, compBInterrupt: 11,
  compPortA: TINY_PORTB.PORT, compPinA: 0, compPortB: TINY_PORTB.PORT, compPinB: 1, externalClockPort: TINY_PORTB.PORT, externalClockPin: 2,
}
const TINY_ADC: ADCConfig = {
  ...adcConfig, ADMUX: 0x27, ADCSRA: 0x26, ADCSRB: 0x23, ADCL: 0x24, ADCH: 0x25, DIDR0: 0x34, adcInterrupt: 8, numChannels: 4, muxInputMask: 0x0f,
  // ADC0 = PB5, ADC1 = PB2, ADC2 = PB4, ADC3 = PB3; 1100 = the 1.1 V bandgap, 1111 = temperature
  muxChannels: {
    0: { type: ADCMuxInputType.SingleEnded, channel: 0 }, 1: { type: ADCMuxInputType.SingleEnded, channel: 1 },
    2: { type: ADCMuxInputType.SingleEnded, channel: 2 }, 3: { type: ADCMuxInputType.SingleEnded, channel: 3 },
    12: { type: ADCMuxInputType.Constant, voltage: 1.1 }, 15: { type: ADCMuxInputType.Temperature },
  },
  adcReferences: [ADCReference.AVCC, ADCReference.AREF, ADCReference.Internal1V1, ADCReference.Reserved],
}

/**
 * A bit-banged UART line (ATTinyCore's software Serial TX): the bit time is the shortest run of one
 * level seen (snapped to a standard baud), each frame is sampled mid-bit from its start edge.
 */
class SoftUartRx {
  private edges: [number, number][] = []  // [cycle, level]
  private bit = 0
  // unknown until the pin first drives high: its first low (becoming an output) is not a start bit
  private level = 0
  out = ""
  private hz: number
  constructor(hz: number) { this.hz = hz }
  edge(cycle: number, level: number) {
    if (level === this.level) return
    const last = this.edges[this.edges.length - 1]
    if (last) {
      const run = cycle - last[0]
      const bauds = [230400, 115200, 57600, 38400, 19200, 9600, 4800, 2400, 1200]
      const b = bauds.find((x) => Math.abs(this.hz / x - run) / (this.hz / x) < 0.2)
      if (b && (!this.bit || this.hz / b < this.bit)) this.bit = this.hz / b
    }
    this.edges.push([cycle, level])
    this.level = level
  }
  /** decode every frame that has fully passed by `now` */
  flush(now: number) {
    const bit = this.bit
    if (!bit) { if (this.edges.length > 400) this.edges.splice(0, this.edges.length - 400); return }
    const at = (t: number) => { let lv = 1; for (const [c, l] of this.edges) { if (c > t) break; lv = l } return lv }
    while (this.edges.length) {
      const i = this.edges.findIndex(([, l]) => l === 0)
      if (i < 0) { this.edges = this.edges.slice(-1); return }
      const t0 = this.edges[i][0]
      if (now < t0 + 10 * bit) { this.edges = this.edges.slice(Math.max(0, i - 1)); return }
      let byte = 0
      for (let k = 0; k < 8; k++) if (at(t0 + (1.5 + k) * bit)) byte |= 1 << k
      if (at(t0 + 9.5 * bit)) this.out += String.fromCharCode(byte)
      // continue after this frame's stop bit
      const end = t0 + 9.5 * bit
      const lvl = at(end)
      this.edges = [[end, lvl] as [number, number], ...this.edges.filter(([c]) => c > end)]
      if (lvl === 1) this.edges = this.edges.filter(([c, l], j) => j > 0 || l === 1 || c > end)
    }
  }
}

export type { PinTrack } from "./machine"

export interface AvrStats { cycles: number; seconds: number; speed: number }

export class AvrMachine implements Machine {
  readonly cpu: CPU
  readonly ports = new Map<PortName, AVRIOPort>()
  /** absent on the ATtiny85 (no hardware UART / TWI / SPI) */
  readonly usart?: AVRUSART
  readonly adc: AVRADC
  readonly twi?: AVRTWI
  readonly spi?: AVRSPI
  /** ATtiny85: Serial is bit-banged on PB0 */
  private softTx: SoftUartRx | null = null
  readonly timers: AVRTimer[] = []
  readonly eeprom: AVREEPROM
  /** board pin name → its port bit (pins with a port bit only) */
  readonly track = new Map<string, PinTrack>()
  private byPortBit = new Map<string, string[]>()
  /** called after any pin's output level / direction changes (inside a slice) */
  onPinChange: ((pins: string[]) => void) | null = null
  onSerial: ((text: string) => void) | null = null
  private serialBuf = ""

  readonly board: BoardDef

  constructor(board: BoardDef, hex: string, eepromBytes?: Uint8Array) {
    this.board = board
    const prog = parseHex(hex, board.flash)
    const mega = board.chip === "atmega2560"
    // avr8js puts SRAM after 0x100 bytes of registers; the ATmega2560's extended I/O runs to 0x1FF,
    // so its SRAM (and the stack at RAMEND 0x21FF) starts 0x100 higher
    this.cpu = new CPU(new Uint16Array(prog.buffer), board.sram + (mega ? 0x100 : 0))
    const tiny = board.chip === "attiny85"
    const usedPorts = new Set(Object.values(board.pins).filter((p) => p.bit >= 0 && p.port).map((p) => p.port!))
    for (const name of usedPorts) {
      const cfg = tiny ? TINY_PORTB : (mega && megaPorts[name]) || PORT_CONFIGS[name]
      const port = new AVRIOPort(this.cpu, cfg)
      this.ports.set(name, port)
      port.addListener(() => this.portChanged(name))
    }
    for (const [pin, bp] of Object.entries(board.pins)) {
      if (bp.bit < 0) continue
      const k = `${bp.port}${bp.bit}`
      this.byPortBit.set(k, [...(this.byPortBit.get(k) ?? []), pin])
      this.track.set(pin, newTrack())
    }
    if (tiny) {
      this.timers.push(new AVRTimer(this.cpu, TINY_TIMER0))
      new ATtinyTimer1(this.cpu, attinyTimer1Config)
      this.adc = new AVRADC(this.cpu, TINY_ADC)
      this.softTx = new SoftUartRx(board.hz)
    } else {
      for (const cfg of mega ? MEGA_TIMERS : [timer0Config, timer1Config, timer2Config]) this.timers.push(new AVRTimer(this.cpu, cfg))
      this.usart = new AVRUSART(this.cpu, mega ? { ...usart0Config, rxCompleteInterrupt: v(26), dataRegisterEmptyInterrupt: v(27), txCompleteInterrupt: v(28) } : usart0Config, board.hz)
      this.usart.onByteTransmit = (b) => { this.serialBuf += String.fromCharCode(b); this.onUartTx?.(0, b) }
      // UCSR0A's RXC and UDRE are read-only and TXC clears only when written 1, but avr8js's write
      // hook wipes them: a second Serial.begin() (it writes UCSR0A while TXEN is already on) left
      // UDRE clear forever and Serial silent. Keep them across the write.
      const ucsra = usart0Config.UCSRA, writeA = this.cpu.writeHooks[ucsra]
      this.cpu.writeHooks[ucsra] = (value, old, addr, mask) => {
        const keep = this.cpu.data[ucsra] & (0x80 | 0x20 | (value & 0x40 ? 0 : 0x40))
        const r = writeA(value, old, addr, mask)
        this.cpu.data[ucsra] |= keep
        return r
      }
      this.adc = new AVRADC(this.cpu, mega ? { ...adcConfig, adcInterrupt: v(30), numChannels: 16, muxChannels: megaChannels } : adcConfig)
      this.twi = new AVRTWI(this.cpu, mega ? { ...twiConfig, twiInterrupt: v(40) } : twiConfig, board.hz)
      this.spi = new AVRSPI(this.cpu, mega ? { ...spiConfig, spiInterrupt: v(25) } : spiConfig, board.hz)
    }
    const backend = new EEPROMMemoryBackend(mega ? 4096 : tiny ? 512 : 1024)
    this.eepromBackend = backend
    if (eepromBytes) backend.memory.set(eepromBytes.subarray(0, backend.memory.length))
    this.eeprom = new AVREEPROM(this.cpu, backend, mega ? { ...eepromConfig, eepromReadyInterrupt: v(31) } : tiny ? { ...eepromConfig, eepromReadyInterrupt: 6, EECR: 0x3c, EEDR: 0x3d, EEARL: 0x3e, EEARH: 0x3f } : eepromConfig)
    const clock = new AVRClock(this.cpu, board.hz, tiny ? { CLKPR: 0x46 } : clockConfig)
    new AVRWatchdog(this.cpu, mega ? { ...watchdogConfig, watchdogInterrupt: v(13) } : tiny ? { watchdogInterrupt: 12, MCUSR: 0x54, WDTCSR: 0x41 } : watchdogConfig, clock)
  }

  get eepromMemory(): Uint8Array { return this.eepromBackend.memory }
  private eepromBackend: EEPROMMemoryBackend

  private portChanged(name: PortName) {
    const port = this.ports.get(name)!
    const now = this.cpu.cycles
    const changed: string[] = []
    for (let bit = 0; bit < 8; bit++) {
      const pins = this.byPortBit.get(`${name}${bit}`)
      if (!pins) continue
      const st = port.pinState(bit)
      const out = st === PinState.High ? true : st === PinState.Low ? false : null
      const pullup = st === PinState.InputPullUp
      for (const pin of pins) {
        if (trackChange(this.track.get(pin)!, out, pullup, false, now)) changed.push(pin)
      }
      // ATtiny85: Serial's TX is PB0
      if (this.softTx && name === "B" && bit === 0 && out !== null) this.softTx.edge(now, out ? 1 : 0)
    }
    if (changed.length) this.onPinChange?.(changed)
  }

  /** Drive an input pin from outside (a button, another chip, a net's voltage). */
  setInput(pin: string, high: boolean) {
    const bp = this.board.pins[pin]
    if (!bp || bp.bit < 0) return
    if (bp.port) this.ports.get(bp.port)?.setPin(bp.bit, high)
  }

  /** The voltage the ADC sees on an analog channel. */
  setAnalog(channel: number, volts: number) { this.adc.channelValues[channel] = volts }

  /** Send text to the sketch's Serial (as if typed in the Serial Monitor). */
  serialWrite(text: string) { this.rx.push(...Array.from(text, (c) => c.charCodeAt(0) & 0xff)) }
  private rx: number[] = []

  /** Run for `cycles` CPU cycles, in sub-slices of `step` cycles with a callback between them. */
  run(cycles: number, step = 1000, between?: () => void) {
    const cpu = this.cpu
    const end = cpu.cycles + cycles
    while (cpu.cycles < end) {
      const stop = Math.min(end, cpu.cycles + step)
      while (cpu.cycles < stop) {
        avrInstruction(cpu)
        cpu.tick()
      }
      if (this.rx.length && this.usart?.writeByte(this.rx[0])) this.rx.shift()
      between?.()
    }
    if (this.softTx) { this.softTx.flush(cpu.cycles); if (this.softTx.out) { this.serialBuf += this.softTx.out; this.softTx.out = "" } }
    if (this.serialBuf) { const s = this.serialBuf; this.serialBuf = ""; this.onSerial?.(s) }
  }

  takeWindow() { return takeWindow(this.track, this.cpu.cycles) }

  get hz() { return this.board.hz }
  get now() { return this.cpu.cycles }
  runFor(ticks: number) { this.run(ticks, 1000) }
  schedule(fn: () => void, ticks: number) { this.cpu.addClockEvent(fn, Math.max(1, Math.round(ticks))) }
  onUartTx: ((port: number, b: number) => void) | null = null
  uartFeed(port: number, bytes: number[]) { if (port === 0) this.rx.push(...bytes) }
  attachSpi(transfer: (bus: number, mosi: number) => number) {
    if (this.spi) this.spi.onTransfer = (v) => transfer(0, v) & 0xff
  }
  attachI2C(events: I2CEvents): I2CController {
    if (!this.twi) { const nop = () => {}; return { completeStart: nop, completeStop: nop, completeConnect: nop, completeWrite: nop, completeRead: nop } }
    this.twi.eventHandler = {
      start: (r) => events.start(r), stop: () => events.stop(), connectToSlave: (a, w) => events.connectToSlave(a, w),
      writeByte: (v) => events.writeByte(v), readByte: (ack) => events.readByte(ack),
    }
    return this.twi
  }

  /** Simulated seconds so far. */
  get seconds() { return this.cpu.cycles / this.board.hz }
}
