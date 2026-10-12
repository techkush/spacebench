// The catalogue itself. Part names are the makers' product names (Seeed Grove, DFRobot
// Gravity, Espressif, …); pinouts and I²C addresses come from the parts' datasheets. The
// descriptions are generated from each part's model (see `describe`) so they always say what
// the simulation actually does.
import { boardByType } from "../boards"
import type { CatalogPart, Ctl, Group, Look, Model } from "./types"
import { PATCHES } from "./models/parts"

// ── helpers ────────────────────────────────────────────────────────────────────────────────
const c = (key: string, label: string, min: number, max: number, step: number, unit: string, def: number): Ctl => ({ key, label, min, max, step, unit, def })
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))
/** volts proportional to x between lo and hi (as a fraction of VCC between flo and fhi) */
const lin = (lo: number, hi: number, flo = 0, fhi = 1) => (x: number, vcc: number) => vcc * clamp(flo + ((fhi - flo) * (x - lo)) / (hi - lo), 0, 1)
/** MQ-series gas sensor on a 10 kΩ load: Rs/R0 = (ppm/100)^-0.47 */
const mq = (x: number, vcc: number) => vcc / (1 + Math.pow(Math.max(1, x) / 100, -0.47))
/** Grove temperature sensor: 100 kΩ NTC (β 4275) above a 100 kΩ resistor */
const ntc100k = (t: number, vcc: number) => { const r = 100e3 * Math.exp(4275 * (1 / (t + 273.15) - 1 / 298.15)); return (vcc * 100e3) / (100e3 + r) }

const slug = (s: string) => s.toLowerCase().replace(/µ/g, "u").replace(/Ω/g, "ohm").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")

const G3 = ["GND", "VCC", "SIG"]
const GI2C = ["GND", "VCC", "SDA", "SCL"]
const GUART = ["GND", "VCC", "RX", "TX"]

type Opt = Partial<Omit<CatalogPart, "title" | "group" | "model" | "look">> & { slug?: string }
const parts: CatalogPart[] = []
function add(group: Group, sub: string | undefined, title: string, look: Look, pins: string[], model: Model, o: Opt = {}) {
  const type = o.type ?? `sb-${o.slug ?? slug(title)}`
  parts.push({ title, group, sub, pins, look, model, hint: o.hint ?? describe(model, pins), ...o, type } as CatalogPart)
}
/** a Grove twig: 3 pins for analog/digital, 4 for I²C / UART */
const grove = (group: Group, sub: string, title: string, model: Model, look: Partial<Extract<Look, { k: "grove" }>> = {}, o: Opt = {}) =>
  add(group, sub, title, { k: "grove", ...look }, o.pins ?? (model.m === "i2c" ? GI2C : G3), model, o)
const groveI2C = (group: Group, sub: string, title: string, chip: string, addr: number, ctls: Ctl[], look: Partial<Extract<Look, { k: "grove" }>> = {}, o: Opt = {}) =>
  grove(group, sub, title, { m: "i2c", chip, addr, ctls }, { chip: chip.toUpperCase(), ...look }, o)
const none = (why?: string): Model => ({ m: "none", why })

/** What the simulation does with the part, in a sentence. */
export function describe(m: Model, pins: string[]): string {
  const hex = (a: number) => `0x${a.toString(16).toUpperCase().padStart(2, "0")}`
  switch (m.m) {
    case "analog": return `Analog output on ${m.pin}: ${m.ctl.label.toLowerCase()} ${m.ctl.min}–${m.ctl.max} ${m.ctl.unit}${m.dout ? `, threshold on ${m.dout}` : ""}. Set it with the slider while the sketch runs.`
    case "digital": return `Digital output on ${m.pin} (${m.low ? "LOW" : "HIGH"} when triggered). Click the part while running to trigger it.`
    case "button": return `${m.latch ? "Toggle switch" : "Button"} on ${m.pin}: ${m.low ? "LOW" : "HIGH"} while ${m.latch ? "on" : "pressed"}.${m.led ? ` On-board LED on ${m.led}.` : ""}`
    case "led": return `LED driven from ${m.pin} (on-board resistor) — HIGH lights it, PWM dims it.`
    case "relay": return m.ssr ? `Solid-state relay: driving ${m.coil.join("/")} closes ${m.com[0]}–${m.no[0]}.` : `Relay: driving ${m.coil.join("/")} switches ${m.com[0]} from ${m.nc?.[0] ?? "open"} to ${m.no[0]}.`
    case "buzzer": return m.active ? `Active buzzer: sounds while ${m.pin} is HIGH.` : `Passive buzzer / speaker: plays the tone() on ${m.pin} through your speakers.`
    case "motor": return `DC motor: spins with the voltage on ${m.a}${m.b ? `–${m.b}` : ""} (PWM sets the speed).`
    case "load": return `Load (${m.r} Ω) on ${m.a}: on while driven.`
    case "i2c": return `I²C at ${hex(m.addr)} — modelled at register level, so the usual library works.${m.ctls?.length ? ` Live sliders: ${m.ctls.map((x) => x.label.toLowerCase()).join(", ")}.` : ""}`
    case "proto": return PROTO_HINT[m.kind] ?? "Simulated."
    case "passive": return m.kind === "C" ? "Capacitor — open at DC in the canvas solver (use Check with ngspice for transients)." : m.kind === "L" ? "Inductor — a short at DC (0.1 Ω)." : "Resistor."
    case "diode": return m.vz ? `Zener diode: ${m.vz} V reverse breakdown, ${m.vf} V forward.` : `Diode: ${m.vf} V forward drop.`
    case "battery": return `${m.v} V source with ${m.r} Ω internal resistance.`
    case "supply": return "Adjustable bench supply between + and − (set its voltage in Settings)."
    case "regulator": return m.adj ? "Adjustable regulator: keeps 1.25 V between OUT and ADJ — set the output with two resistors." : `${m.v > 0 ? "+" : ""}${m.v} V linear regulator (about 2 V dropout).`
    case "bjt": return `${m.pnp ? "PNP" : "NPN"} transistor (β ≈ ${m.beta}): base current switches collector–emitter.`
    case "fet": return `${m.p ? "P" : "N"}-channel MOSFET: on above ${m.vth} V gate drive (${m.ron} Ω).`
    case "opamp": return "Op-amp: high-gain amplifier between the rails (0 V to VCC) — works as a comparator or with feedback."
    case "opto": return "Optocoupler: LED current on A–K turns on the transistor C–E."
    case "gate": return `${m.inputs}-input ${m.fn.toUpperCase()} gate (5 V logic).`
    case "ic74": return `Four ${m.fn.toUpperCase()} gates (one for NOT/Schmitt: six) — VCC pin 14, GND pin 7, standard 74HC pinout.`
    case "ff": return `${m.kind} flip-flop: changes on the rising CLK edge.`
    case "probe": return m.kind === "V" ? "Voltmeter: shows the voltage between V+ and V−." : "Ammeter: shows the current from A+ to A− (wire it in series)."
    case "siggen": return "Signal generator: sine/square/triangle on SIG (frequency, amplitude and offset in the sliders)."
    case "analogin": return `Analog inputs ${m.pins.join(", ")}.`
    case "lres": return `Light-dependent resistance between ${m.a} and ${m.b} (${m.ctl.label.toLowerCase()} slider).`
    case "none": return m.why ?? `Placed and wired; not simulated yet (${pins.length} pins).`
  }
}
const PROTO_HINT: Record<string, string> = {
  dht11: "DHT11 one-wire protocol on SIG (DHT library): temperature and humidity from the sliders.",
  dht22: "DHT22/AM2302 one-wire protocol on SIG (DHT library): temperature and humidity from the sliders.",
  ds18b20: "1-Wire DS18B20 on DQ (OneWire + DallasTemperature): search, convert and read scratchpad all work.",
  max31850: "1-Wire thermocouple amplifier (MAX31850K) — reads like a DS18B20 (DallasTemperature).",
  max6675: "MAX6675 thermocouple reader: 16-bit word on SO clocked by SCK while CS is LOW.",
  hx711: "HX711 24-bit load-cell ADC (HX711 library): the weight slider sets the reading.",
  tm1637: "TM1637 4-digit display (TM1637Display library): two-wire CLK/DIO protocol, decoded and drawn.",
  my9221: "MY9221 LED driver (Grove LED Bar): 208-bit frames on DI/DCKI, drawn on the bar.",
  p9813: "P9813 chainable RGB LED driver (ChainableLED library): 32-bit frames on CI/DI.",
  gps: "GPS: NMEA sentences ($GPRMC, $GPGGA) at 9600 baud on TX — latitude/longitude from the sliders (TinyGPS++).",
  mhz16: "MH-Z16 CO₂ sensor on UART (9600 baud): answers the 0x86 read command.",
  rfid125: "125 kHz RFID reader: click the part to present a tag — its 14-byte frame arrives on TX at 9600 baud.",
  irrecv: "IR receiver (38 kHz demodulator): the IR remote's buttons send NEC codes on its output (IRremote).",
  irremote: "IR remote: press its buttons while running — every IR receiver in the circuit gets the NEC code.",
  encoder: "Quadrature encoder: turn it while running — A/B (CLK/DT) pulses with the right phase.",
  keypad: "Membrane keypad: pressing a key joins its row and column (Keypad library).",
  joystick2: "Two-axis joystick: X/Y voltages from the sliders.",
  adxl335: "ADXL335 analog accelerometer: X/Y/Z volts (VCC/2 at 0 g, 0.3 V/g).",
  stepper: "Stepper motor: turns one step per coil-sequence step (drive it through a driver).",
  a4988: "A4988 stepper driver: STEP pulses turn the motor one step in the DIR direction.",
  servo: "Servo: angle from the pulse width on SIG (Servo library).",
  pulse: "Heart-rate sensor: a pulse on its output at the beats per minute you set.",
  ecg: "ECG front end: a synthetic heartbeat waveform on OUTPUT at the rate you set.",
  lowpulse: "Dust sensor: LOW pulses whose share of time follows the concentration (pulseIn).",
  ultrasonic1: "Grove ultrasonic ranger: one SIG pin for trigger and echo (Ultrasonic library).",
  dialer: "Rotary dialer: dial a number while running — PULSE pulses once per count.",
  hbridge: "Dual H-bridge (L293D): each output follows its input while its enable pin is HIGH, at the motor supply voltage.",
  divider: "Voltage divider: SIG = input ÷ 3 (switch to ÷10 in Settings).",
  gearmotor: "Gear motor with a hall encoder: spins with the voltage on M+/M−; A/B pulse as it turns.",
}

// ── Boards ─────────────────────────────────────────────────────────────────────────────────
// Emulated boards keep their own `type` (boards.ts); the rest are drawn but can't run a sketch.
const brd = (title: string, look: Look, pins: string[], o: Opt & { noEmu?: string }) =>
  add("Boards", o.sub, title, look, pins, none(o.noEmu), o)
const hdr = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`)
const piPins = ["3V3", "5V", "GPIO2", "GPIO3", "GPIO4", "GND", "GPIO17", "GPIO27", "GPIO22", "GPIO10", "GPIO9", "GPIO11", "GPIO14", "GPIO15", "GPIO18", "GPIO23", "GPIO24", "GPIO25", "GPIO8", "GPIO7"]
const LINUX = "Older Raspberry Pi — drawn for wiring; the Pi 5, 4B, 3B+ and Zero 2 W run Linux (set them up in Settings → Microcontrollers)."

// emulated variants (boards.ts gives them pins and a chip)
add("Boards", "Arduino", "Raspberry Pi Pico W", { k: "board", color: "#1a6b3a", chip: "RP2040", usb: true }, boardByType("sb-pi-pico-w")?.header ?? [], none(), { type: "sb-pi-pico-w", base: "wokwi-pi-pico", board: true, hint: "RP2040 + CYW43 radio: runs on the same RP2040 emulator as the Pico (the radio isn't emulated; LED_BUILTIN is GP25 here)." })
add("Boards", "ESP32", "ESP32 DevKit C V4", { k: "board", color: "#1c1c1c", chip: "ESP32-WROOM-32E", usb: true }, boardByType("sb-esp32-devkit-c-v4")?.header ?? [], none(), { type: "sb-esp32-devkit-c-v4", board: true, hint: "Espressif's official 38-pin DevKitC — ESP32 on QEMU like the DevKit V1." })
add("Boards", "ESP32", "ESP32-CAM", { k: "board", color: "#1c1c1c", chip: "ESP32-S", w: 120, h: 100 }, boardByType("sb-esp32-cam")?.header ?? [], none(), { type: "sb-esp32-cam", board: true, hint: "AI-Thinker ESP32-CAM: ESP32 on QEMU; GPIO4 drives the flash LED (camera and microSD aren't emulated)." })
add("Boards", "ESP32", "Wemos Lolin32 Lite", { k: "board", color: "#202020", chip: "ESP32-D0WDQ6", usb: true }, boardByType("sb-lolin32-lite")?.header ?? [], none(), { type: "sb-lolin32-lite", board: true, hint: "Compact ESP32 with a LiPo charger — ESP32 on QEMU; LED on GPIO22." })
add("Boards", "Arduino", "DFRduino UNO R3", { k: "board", color: "#1b5fa8", chip: "ATmega328P" }, boardByType("sb-dfrduino-uno")?.header ?? [], none(), { type: "sb-dfrduino-uno", base: "wokwi-arduino-uno", board: true, hint: "DFRobot's Uno R3 — ATmega328P, same pins and emulator as the Uno." })
add("Boards", "Arduino", "DFRduino Nano", { k: "board", color: "#1b5fa8", chip: "ATmega328P" }, boardByType("sb-dfrduino-nano")?.header ?? [], none(), { type: "sb-dfrduino-nano", base: "wokwi-arduino-nano", board: true, hint: "DFRobot Nano — ATmega328P, same as the Arduino Nano." })
add("Boards", "Arduino", "DFRduino Mega2560", { k: "board", color: "#1b5fa8", chip: "ATmega2560" }, boardByType("sb-dfrduino-mega")?.header ?? [], none(), { type: "sb-dfrduino-mega", base: "wokwi-arduino-mega", board: true, hint: "DFRobot Mega 2560 — same pins and emulator as the Arduino Mega." })
add("Boards", "Arduino", "Romeo BLE", { k: "board", color: "#1b5fa8", chip: "ATmega328P" }, boardByType("sb-romeo-ble")?.header ?? [], none(), { type: "sb-romeo-ble", base: "wokwi-arduino-uno", board: true, hint: "DFRobot Romeo BLE robot controller — an Uno-compatible ATmega328P (motor driver and BLE aren't emulated)." })
add("Boards", "Arduino", "Beetle BLE", { k: "board", color: "#1b5fa8", chip: "ATmega328P" }, boardByType("sb-beetle-ble")?.header ?? [], none(), { type: "sb-beetle-ble", base: "wokwi-arduino-nano", board: true, hint: "DFRobot Beetle BLE — ATmega328P (Uno-compatible); BLE isn't emulated." })
add("Boards", "Arduino", "Romeo BLE mini", { k: "board", color: "#1b5fa8", chip: "ATmega328P" }, boardByType("sb-romeo-ble-mini")?.header ?? [], none(), { type: "sb-romeo-ble-mini", base: "wokwi-arduino-nano", board: true, hint: "DFRobot Romeo BLE mini — ATmega328P with a motor driver (the driver and BLE aren't emulated)." })
add("Boards", "Seeed XIAO", "XIAO RP2040", { k: "board", color: "#2b2b2b", chip: "RP2040", usb: true, w: 86, h: 106 }, boardByType("sb-xiao-rp2040")?.header ?? [], none(), { type: "sb-xiao-rp2040", board: true, hint: "Seeed XIAO RP2040 — runs on the RP2040 emulator; D0–D10 on GPIO 26–29, 6, 7, 0, 1, 2, 4, 3." })

// boards drawn for diagrams; no emulator yet
const pi = (t: string, chip: string) => brd(t, { k: "board", color: "#2b8a3e", chip, w: 230, h: 150 }, piPins, { sub: "Raspberry Pi", noEmu: LINUX })
pi("Raspberry Pi Zero", "BCM2835"); pi("Raspberry Pi 1B+", "BCM2835"); pi("Raspberry Pi 2B", "BCM2836")
// Linux boards: Debian + Raspberry Pi's packages in a VM, GPIO through the circuit (src/linux/)
const piLinux = (title: string, type: string, chip: string) => add("Boards", "Raspberry Pi", title, { k: "board", color: "#2b8a3e", chip, w: 230, h: 150 }, boardByType(type)?.header ?? [], none(), {
  type, board: true, hint: `${title} running Linux (Python 3, gpiozero, lgpio, RPi.GPIO) in a VM: main.py drives GPIO0–27 on the 40-pin header, and the Terminal is its console. Set it up once in Settings → Microcontrollers.`,
})
piLinux("Raspberry Pi 5", "sb-raspberry-pi-5", "BCM2712"); piLinux("Raspberry Pi 4B", "sb-raspberry-pi-4", "BCM2711"); piLinux("Raspberry Pi 3B+", "sb-raspberry-pi-3", "BCM2837"); piLinux("Raspberry Pi Zero 2 W", "sb-raspberry-pi-zero-2w", "RP3A0")
const espNo = "ESP32-C6/C5/P4 (and these S3/C3 boards' own pinouts) aren't emulated yet — Espressif's QEMU runs the ESP32, ESP32-S3 and ESP32-C3; use the S3 / C3 DevKit to run a sketch."
const esp = (t: string, chip: string, n = 14) => brd(t, { k: "board", color: "#1c1c1c", chip, usb: true }, [...hdr("IO", n), "3V3", "5V", "GND"], { sub: "ESP32", noEmu: espNo })
add("Boards", "ESP32", "ESP32-S3 DevKitC-1", { k: "board", color: "#1c1c1c", chip: "ESP32-S3", usb: true }, boardByType("sb-esp32-s3-devkitc-1")?.header ?? [], none(), { type: "sb-esp32-s3-devkitc-1", board: true, hint: "ESP32-S3 on Espressif's QEMU (qemu-system-xtensa -M esp32s3): GPIO, analogRead, PWM; Serial on UART0." })
add("Boards", "ESP32", "ESP32-C3 DevKitM-1", { k: "board", color: "#1c1c1c", chip: "ESP32-C3", usb: true }, boardByType("sb-esp32-c3-devkitm-1")?.header ?? [], none(), { type: "sb-esp32-c3-devkitm-1", board: true, hint: "ESP32-C3 (RISC-V) on Espressif's QEMU (qemu-system-riscv32 -M esp32c3): GPIO, analogRead, PWM; Serial on UART0." })
esp("XIAO ESP32-S3", "ESP32-S3", 11); esp("Arduino Nano ESP32", "ESP32-S3"); esp("XIAO ESP32-C3", "ESP32-C3", 11)
esp("ESP32-C3 SuperMini", "ESP32-C3", 11); esp("ESP32-C6", "ESP32-C6"); esp("XIAO ESP32S3 Sense", "ESP32-S3", 11); esp("XIAO ESP32C6", "ESP32-C6", 11); esp("ESP32-C3-LCDkit", "ESP32-C3")
esp("ESP32-S3-EYE", "ESP32-S3"); esp("ESP-VoCat", "ESP32-S3"); esp("ESP-SensAirShuttle", "ESP32-C6"); esp("ESP32-P4-Function-EV", "ESP32-P4"); esp("ESP32-P4 Preview", "ESP32-P4")
esp("Beetle ESP32-C3", "ESP32-C3", 8); esp("FireBeetle 2 ESP32-E", "ESP32-E"); esp("FireBeetle 2 ESP32-C6", "ESP32-C6"); esp("Beetle ESP32-C6", "ESP32-C6", 8); esp("FireBeetle 2 ESP32-S3", "ESP32-S3")
esp("Romeo ESP32-S3", "ESP32-S3"); esp("FireBeetle 2 ESP32-C5", "ESP32-C5"); esp("FireBeetle 2 ESP32-P4", "ESP32-P4"); esp("M5Stack Core", "ESP32"); esp("M5 Cardputer ADV", "ESP32-S3"); esp("UNIHIKER K10", "ESP32-S3")
const stm = "ARM Cortex-M boards need an ARM system emulator (planned) — drawn for wiring; not emulated yet."
const arm = (t: string, chip: string, sub: string, n = 16, color = "#1d4ed8") => brd(t, { k: "board", color, chip }, [...hdr("P", n), "3V3", "5V", "GND"], { sub, noEmu: stm })
// Renode boards: the real firmware (ELF) on Antmicro's Renode (src/renode/)
const renodeBrd = (title: string, type: string, chip: string, sub: string, color: string, hint: string) => add("Boards", sub, title, { k: "board", color, chip }, boardByType(type)?.header ?? [], none(), { type, board: true, hint })
renodeBrd("STM32 Blue Pill", "sb-stm32-blue-pill", "STM32F103C8", "STM32", "#1d4ed8", "STM32F103C8 on Renode (stm32duino — install STMicroelectronics:stm32 from the Microcontrollers page): GPIO, Serial on USART1 (PA9/PA10). Runs on the 8 MHz internal clock in the emulator.")
renodeBrd("STM32F4 Discovery", "sb-stm32f4-discovery", "STM32F407", "STM32", "#e5e7eb", "STM32F407VG on Renode (stm32duino): GPIO PA–PE, the user LED on PD12, the button on PA0, Serial on USART2.")
renodeBrd("Arduino Nano 33 BLE", "sb-arduino-nano-33-ble", "nRF52840", "Arduino", "#0f766e", "nRF52840 on Renode (arduino:mbed_nano): GPIO by Arduino pin name; use Serial1 (the USB Serial isn't emulated).")
arm("STM32 Black Pill", "STM32F411", "STM32", 16, "#111"); arm("STM32 Blue Pill (F103CB)", "STM32F103CB", "STM32"); arm("STM32 Black Pill (F401)", "STM32F401", "STM32", 16, "#111")
arm("Olimex STM32-H405", "STM32F405", "STM32", 16, "#166534"); arm("Netduino Plus 2", "STM32F405", "STM32", 14, "#111"); arm("Netduino 2", "STM32F405", "STM32", 14, "#111")
arm("Seeeduino XIAO (SAMD21)", "SAMD21", "Seeed XIAO", 11, "#2b2b2b"); arm("XIAO nRF52840 Sense", "nRF52840", "Seeed XIAO", 11, "#2b2b2b"); arm("XIAO RA4M1", "RA4M1", "Seeed XIAO", 11, "#2b2b2b")
arm("XIAO MG24 Sense", "EFR32MG24", "Seeed XIAO", 11, "#2b2b2b"); arm("XIAO nRF54L15 Sense", "nRF54L15", "Seeed XIAO", 11, "#2b2b2b"); arm("XIAO RP2350", "RP2350", "Seeed XIAO", 11, "#2b2b2b")
arm("Pimoroni Pico Plus 2 W", "RP2350", "Raspberry Pi", 20, "#111"); arm("Pimoroni Badger 2350", "RP2350", "Raspberry Pi", 10, "#111"); arm("Pimoroni Stellar Unicorn", "RP2350", "Raspberry Pi", 6, "#111")
arm("XIAO 0.96\" IPS Display", "display carrier", "Seeed XIAO", 11, "#2b2b2b"); arm("XIAO 1.14\" IPS Display", "display carrier", "Seeed XIAO", 11, "#2b2b2b"); arm("XIAO 1.47\" IPS Touch Display", "display carrier", "Seeed XIAO", 11, "#2b2b2b")
arm("Beetle RP2040", "RP2040", "Raspberry Pi", 10, "#111"); arm("UNIHIKER M10", "RK3308", "Raspberry Pi", 10, "#111")
add("Boards", "Arduino", "ATtiny85", { k: "dip", label: "ATtiny85" }, ["PB5", "PB3", "PB4", "GND", "PB0", "PB1", "PB2", "VCC"], none(), { type: "sb-attiny85", board: true, hint: "ATtiny85 at 8 MHz (ATTinyCore — installed from the Microcontrollers page): port B, Timer0/1 PWM, the ADC (A0–A3 = PB5, PB2, PB4, PB3); Serial is software TX on PB0." })

// ── Sensors ────────────────────────────────────────────────────────────────────────────────
const S = "Sensors"
const AQ = "Air quality & gas"
const T = c("t", "Temperature", -40, 85, 0.5, "°C", 24)
const H = c("h", "Humidity", 0, 100, 0.5, "%RH", 45)
const P = c("p", "Pressure", 300, 1100, 0.5, "hPa", 1013.25)
const CO2 = c("co2", "CO₂", 400, 5000, 10, "ppm", 600)
const gasCtl = (g: string, max = 1000, def = 100) => c("value", g, 0, max, 1, "ppm", def)
const analogGas = (title: string, gas: string, max = 1000) => grove(S, AQ, title, { m: "analog", pin: "SIG", ctl: gasCtl(gas, max), f: mq }, { icon: "drop", color: "#1f6fb2" })

add(S, AQ, "SCD41 CO2 Sensor", { k: "module", color: "#1e3a8a", chip: "SCD41" }, GI2C, { m: "i2c", chip: "scd4x", addr: 0x62, ctls: [CO2, T, H] })
add(S, AQ, "BME688 Gas Sensor", { k: "module", color: "#6b21a8", chip: "BME688" }, GI2C, { m: "i2c", chip: "bme680", addr: 0x76, ctls: [T, H, P, c("gas", "Gas resistance", 1, 500, 1, "kΩ", 120)] })
add(S, AQ, "Gravity: Analog CO Sensor (MQ7)", { k: "module", color: "#b91c1c", icon: "drop" }, ["GND", "VCC", "AOUT"], { m: "analog", pin: "AOUT", ctl: gasCtl("CO"), f: mq })
add(S, AQ, "Gravity: Industrial Analog pH Sensor", { k: "module", color: "#b91c1c", icon: "probe" }, ["GND", "VCC", "AOUT"], { m: "analog", pin: "AOUT", ctl: c("value", "pH", 0, 14, 0.1, "pH", 7), f: (x) => 0.5 + x * 0.15 })
groveI2C(S, AQ, "Grove - Temperature & Humidity Sensor (SHT31)", "sht3x", 0x44, [T, H])
grove(S, AQ, "Grove - Air Quality Sensor v1.3", { m: "analog", pin: "SIG", ctl: c("value", "Pollution", 0, 100, 1, "%", 10), f: lin(0, 100, 0.05, 0.9) }, { icon: "drop" })
analogGas("Grove - Gas Sensor (MQ2)", "Smoke/LPG"); analogGas("Grove - Gas Sensor (MQ3)", "Alcohol", 500); analogGas("Grove - Gas Sensor (MQ5)", "LPG/natural gas"); analogGas("Grove - Gas Sensor (MQ9)", "CO/flammable gas")
groveI2C(S, AQ, "Grove - High Accuracy Temp & Humi Sensor (SHT35)", "sht3x", 0x45, [T, H])
groveI2C(S, AQ, "Grove - Temperature & Humidity Sensor (SHT40)", "sht4x", 0x44, [T, H])
groveI2C(S, AQ, "Grove - Temperature & Humidity Sensor (SHT41)", "sht4x", 0x44, [T, H])
groveI2C(S, AQ, "Grove - AHT20 Temperature & Humidity Sensor", "aht20", 0x38, [T, H])
groveI2C(S, AQ, "Grove - VOC and eCO2 Gas Sensor (SGP30)", "sgp30", 0x58, [c("eco2", "eCO₂", 400, 60000, 10, "ppm", 400), c("tvoc", "TVOC", 0, 60000, 1, "ppb", 0)])
groveI2C(S, AQ, "Grove - Smart Air Quality Sensor (SGP41)", "sgp41", 0x59, [c("voc", "VOC raw", 0, 65535, 1, "", 27000), c("nox", "NOx raw", 0, 65535, 1, "", 16000)])
groveI2C(S, AQ, "Grove - CO2 & Temperature & Humidity Sensor (SCD30)", "scd30", 0x61, [CO2, T, H])
groveI2C(S, AQ, "Grove - Formaldehyde Sensor (SFA30)", "sfa30", 0x5d, [c("hcho", "HCHO", 0, 1000, 1, "ppb", 20), T, H])
groveI2C(S, AQ, "Grove - SEN54 Environmental Sensor", "sen5x", 0x69, [c("pm25", "PM2.5", 0, 1000, 1, "µg/m³", 12), T, H, c("voc", "VOC index", 1, 500, 1, "", 100)])
groveI2C(S, AQ, "Grove - SEN55 Environmental Sensor", "sen5x", 0x69, [c("pm25", "PM2.5", 0, 1000, 1, "µg/m³", 12), T, H, c("voc", "VOC index", 1, 500, 1, "", 100), c("nox", "NOx index", 1, 500, 1, "", 1)])
groveI2C(S, AQ, "Grove - Temperature, Humidity, Pressure and Gas Sensor (BME680)", "bme680", 0x76, [T, H, P, c("gas", "Gas resistance", 1, 500, 1, "kΩ", 120)])
groveI2C(S, AQ, "Grove - Air Quality Sensor (BME688)", "bme680", 0x76, [T, H, P, c("gas", "Gas resistance", 1, 500, 1, "kΩ", 120)])
groveI2C(S, AQ, "Grove - CO2 & Temperature & Humidity Sensor (SCD41)", "scd4x", 0x62, [CO2, T, H])
groveI2C(S, AQ, "Grove - Laser PM2.5 Dust Sensor (HM3301)", "hm3301", 0x40, [c("pm1", "PM1.0", 0, 500, 1, "µg/m³", 8), c("pm25", "PM2.5", 0, 500, 1, "µg/m³", 12), c("pm10", "PM10", 0, 500, 1, "µg/m³", 20)])
groveI2C(S, AQ, "Grove - Multichannel Gas Sensor v2", "gmxxx", 0x08, [c("no2", "NO₂", 0, 1023, 1, "", 120), c("eth", "Ethanol", 0, 1023, 1, "", 80), c("voc", "VOC", 0, 1023, 1, "", 150), c("co", "CO", 0, 1023, 1, "", 60)])
grove(S, AQ, "Grove - CO2 Sensor (MH-Z16)", { m: "proto", kind: "mhz16", ctls: [CO2] }, { chip: "MH-Z16" }, { pins: GUART })
groveI2C(S, AQ, "Grove - D7S Vibration Sensor", "d7s", 0x55, [c("si", "SI value", 0, 2, 0.01, "m/s", 0), c("pga", "PGA", 0, 10, 0.01, "m/s²", 0)])

const BIO = "Biometric"
add(S, BIO, "Heart Beat Sensor", { k: "module", color: "#111" }, ["GND", "VCC", "OUT"], { m: "proto", kind: "pulse", ctls: [c("bpm", "Heart rate", 30, 200, 1, "bpm", 72)], pins: { out: "OUT" } }, { type: "wokwi-heart-beat-sensor" })
add(S, BIO, "Gravity: Heart Rate Monitor (ECG, AD8232)", { k: "module", color: "#b91c1c", icon: "heart" }, ["GND", "VCC", "OUTPUT"], { m: "proto", kind: "ecg", ctls: [c("bpm", "Heart rate", 30, 200, 1, "bpm", 72)], pins: { out: "OUTPUT" } })
grove(S, BIO, "Grove - EMG Detector", { m: "analog", pin: "SIG", ctl: c("value", "Muscle activity", 0, 100, 1, "%", 0), f: lin(0, 100, 0.45, 0.95) }, { icon: "heart" })
grove(S, BIO, "Grove - GSR Sensor", { m: "analog", pin: "SIG", ctl: c("value", "Skin conductance", 0, 20, 0.1, "µS", 4), f: lin(0, 20, 0.9, 0.1) }, { icon: "heart" })
grove(S, BIO, "Grove - Collision Sensor", { m: "digital", pin: "SIG", low: true, pulse: 0.15 }, { icon: "switch" })
grove(S, BIO, "Grove - Ear-clip Heart Rate Sensor", { m: "proto", kind: "pulse", ctls: [c("bpm", "Heart rate", 30, 200, 1, "bpm", 72)], pins: { out: "SIG" } }, { icon: "heart" })
groveI2C(S, BIO, "Grove - Finger-clip Heart Rate Sensor", "hr50", 0x50, [c("bpm", "Heart rate", 30, 200, 1, "bpm", 72)], { icon: "heart" })
groveI2C(S, BIO, "Grove - Finger-clip Heart Rate Sensor with shell", "hr50", 0x50, [c("bpm", "Heart rate", 30, 200, 1, "bpm", 72)], { icon: "heart" })
grove(S, BIO, "Grove - Dust Sensor (PPD42NS)", { m: "proto", kind: "lowpulse", ctls: [c("pcs", "Concentration", 0, 28000, 10, "pcs/0.01cf", 1000)], pins: { out: "SIG" } }, { icon: "drop" })

const CV = "Current & voltage"
grove(S, CV, "Grove - 2.5A DC Current Sensor (ACS70331)", { m: "analog", pin: "SIG", ctl: c("value", "Current", 0, 2.5, 0.01, "A", 0), f: (a) => 1.5 + 0.8 * a }, { chip: "ACS70331" })
grove(S, CV, "Grove - AC Voltage Sensor (MCP6002)", { m: "analog", pin: "SIG", ctl: c("value", "AC voltage", 0, 250, 1, "V rms", 0), f: (v, vcc) => clamp(vcc / 2 + (v / 250) * vcc * 0.45, 0, vcc) }, { chip: "MCP6002" })
grove(S, CV, "Grove - Voltage Divider", { m: "proto", kind: "divider" }, { chip: "LMV358" }, { pins: ["GND", "VCC", "SIG", "IN+", "IN-"], settings: { ratio: ["3", "10"] }, attrs: { ratio: "3" } })
grove(S, CV, "Grove - Current Transformer", { m: "analog", pin: "SIG", ctl: c("value", "Current", 0, 5, 0.05, "A rms", 0), f: lin(0, 5, 0, 0.9) }, { icon: "coil" })
add(S, CV, "Grove - 4 Channel 16-bit ADC (ADS1115)", { k: "grove", chip: "ADS1115" }, [...GI2C, "A0", "A1", "A2", "A3"], { m: "i2c", chip: "ads1115", addr: 0x48 })

const DP = "Distance & proximity"
add(S, DP, "Gravity: C4001 24GHz mmWave Radar", { k: "module", color: "#b91c1c", icon: "antenna" }, ["GND", "VCC", "OUT", "RX"], { m: "digital", pin: "OUT" })
grove(S, DP, "Grove - 80cm Infrared Proximity Sensor (GP2Y0A21YK)", { m: "analog", pin: "SIG", ctl: c("value", "Distance", 10, 80, 1, "cm", 30), f: (d) => clamp(27.86 * Math.pow(d, -1.15) + 0.0, 0.3, 3.1) }, { icon: "eye" })
grove(S, DP, "Grove - mini PIR motion sensor", { m: "digital", pin: "SIG", pulse: 2 }, { icon: "eye" })
grove(S, DP, "Grove - Infrared Reflective Sensor v1.2", { m: "digital", pin: "SIG", low: true }, { icon: "eye" })
grove(S, DP, "Grove - IR Distance Interrupter v1.2", { m: "digital", pin: "SIG", low: true }, { icon: "eye" })
groveI2C(S, DP, "Grove - 2-Channel Inductive Sensor (LDC1612)", "ldc1612", 0x2b, [c("f", "Coil frequency", 1, 10, 0.01, "MHz", 3)], { icon: "coil" })
grove(S, DP, "Grove - Doppler Radar (BGT24LTR11)", { m: "digital", pin: "SIG" }, { icon: "antenna" }, { pins: GUART.slice(0, 3).concat("SIG") })
grove(S, DP, "Grove - Ultrasonic Distance Sensor", { m: "proto", kind: "ultrasonic1", ctls: [c("cm", "Distance", 3, 350, 1, "cm", 100)], pins: { sig: "SIG" } }, { icon: "eye" })
groveI2C(S, DP, "Grove - Time of Flight Distance Sensor (VL53L0X)", "vl53l0x", 0x29, [c("mm", "Distance", 30, 2000, 1, "mm", 300)], { icon: "eye" })
grove(S, DP, "Grove - Ultrasonic Sensor (US5)", none("UART ultrasonic module — not simulated yet."), { icon: "eye" }, { pins: GUART })

const FA = "Force, angle & encoders"
grove(S, FA, "Grove - Rotary Angle Sensor", { m: "analog", pin: "SIG", ctl: c("value", "Angle", 0, 300, 1, "°", 150), f: lin(0, 300) }, { icon: "knob" })
grove(S, FA, "Grove - Rotary Angle Sensor (panel mount)", { m: "analog", pin: "SIG", ctl: c("value", "Angle", 0, 300, 1, "°", 150), f: lin(0, 300) }, { icon: "knob" })
grove(S, FA, "Grove - Slide Potentiometer", { m: "analog", pin: "SIG", ctl: c("value", "Position", 0, 100, 1, "%", 50), f: lin(0, 100) }, { icon: "slider" }, { pins: [...G3, "LED"] })
add(S, FA, "Grove - ADC for Load Cell (HX711)", { k: "grove", chip: "HX711" }, ["GND", "VCC", "DT", "SCK"], { m: "proto", kind: "hx711", ctls: [c("w", "Weight", -5000, 5000, 1, "g", 0)] })

const IM = "Imaging & thermal cameras"
add(S, IM, "Raspberry Pi Camera Module (CSI)", { k: "module", color: "#166534", icon: "camera" }, ["CSI"], none("Camera over CSI — not simulated."))
grove(S, IM, "Grove - Thermal Imaging Camera (MLX90640, 110°)", none("32×24 IR array — its EEPROM calibration isn't modelled yet."), { icon: "camera" }, { pins: GI2C })
grove(S, IM, "Grove - Thermal Imaging Camera (MLX90641 BCA, 110°)", none("Thermal camera array — its EEPROM calibration isn't modelled yet."), { icon: "camera" }, { pins: GI2C })
grove(S, IM, "Grove - Thermal Imaging Camera (MLX90641 BCB, 55°)", none("Thermal camera array — its EEPROM calibration isn't modelled yet."), { icon: "camera" }, { pins: GI2C })
grove(S, IM, "Grove - Thermal Imaging Camera (MLX90621 BAB, 60°)", none("Thermal camera array — its EEPROM calibration isn't modelled yet."), { icon: "camera" }, { pins: GI2C })

const LC = "Light & colour"
add(S, LC, "Photodiode", { k: "diode", label: "PD" }, ["A", "K"], { m: "lres", a: "K", b: "A", ctl: c("value", "Light", 0, 10000, 10, "lux", 300), r: (lux) => 5e8 / Math.max(0.01, lux) }, { hint: "Photodiode (reverse biased): its current grows with light — put a resistor from the anode to GND, the cathode to VCC, and read the anode." })
grove(S, LC, "Grove - Light Sensor v1.2", { m: "analog", pin: "SIG", ctl: c("value", "Light", 0, 1000, 1, "lux", 300), f: lin(0, 1000, 0.02, 0.95) }, { icon: "eye" })
grove(S, LC, "Grove - UV Sensor (GUVA-S12D)", { m: "analog", pin: "SIG", ctl: c("value", "UV index", 0, 11, 0.1, "", 2), f: (u) => u * 0.1 }, { icon: "eye" })
grove(S, LC, "Grove - Light Sensor", { m: "analog", pin: "SIG", ctl: c("value", "Light", 0, 1000, 1, "lux", 300), f: lin(0, 1000, 0.02, 0.95) }, { icon: "eye" })
grove(S, LC, "Grove - Light Sensor (P) v1.1", { m: "analog", pin: "SIG", ctl: c("value", "Light", 0, 1000, 1, "lux", 300), f: lin(0, 1000, 0.02, 0.95) }, { icon: "eye" })
groveI2C(S, LC, "Grove - Digital Light Sensor (TSL2561)", "tsl2561", 0x29, [c("lux", "Light", 0, 40000, 1, "lux", 300)], { icon: "eye" })
groveI2C(S, LC, "Grove - Color Sensor V3.0 (VEML6040)", "veml6040", 0x10, [c("r", "Red", 0, 65535, 1, "", 12000), c("g", "Green", 0, 65535, 1, "", 15000), c("b", "Blue", 0, 65535, 1, "", 9000), c("w", "White", 0, 65535, 1, "", 30000)], { icon: "eye" })

const MO = "Motion & orientation"
const ACC = [c("ax", "Accel X", -2, 2, 0.01, "g", 0), c("ay", "Accel Y", -2, 2, 0.01, "g", 0), c("az", "Accel Z", -2, 2, 0.01, "g", 1)]
const GYR = [c("gx", "Gyro X", -250, 250, 1, "°/s", 0), c("gy", "Gyro Y", -250, 250, 1, "°/s", 0), c("gz", "Gyro Z", -250, 250, 1, "°/s", 0)]
add(S, MO, "MPU6050", { k: "module", color: "#1e40af" }, ["INT", "AD0", "XCL", "XDA", "SDA", "SCL", "GND", "VCC"], { m: "i2c", chip: "mpu6050", addr: 0x68, ctls: [...ACC, ...GYR, T] }, { type: "wokwi-mpu6050" })
add(S, MO, "Grove - 3-Axis Analog Accelerometer (ADXL335)", { k: "grove", chip: "ADXL335" }, ["GND", "VCC", "X", "Y", "Z"], { m: "proto", kind: "adxl335", ctls: ACC })
add(S, MO, "Grove - 12-bit Magnetic Rotary Position Sensor (AS5600)", { k: "grove", chip: "AS5600", icon: "magnet" }, [...GI2C, "DIR", "OUT"], { m: "i2c", chip: "as5600", addr: 0x36, ctls: [c("deg", "Angle", 0, 359.9, 0.1, "°", 90)] })
groveI2C(S, MO, "Grove - 3-Axis Digital Accelerometer (ADXL345)", "adxl345", 0x53, ACC)
groveI2C(S, MO, "Grove - 3-Axis Digital Accelerometer (LIS3DHTR)", "lis3dh", 0x19, ACC)
groveI2C(S, MO, "Grove - 3-Axis Digital Accelerometer ±1.5g (MMA7660)", "mma7660", 0x4c, ACC)
groveI2C(S, MO, "Grove - 3-Axis Digital Accelerometer ±16g (BMA400)", "bma400", 0x14, ACC)
grove(S, MO, "Grove - Step Counter (BMA456)", none("BMA456 needs its 6 kB config blob uploaded — not modelled yet."), {}, { pins: GI2C })
groveI2C(S, MO, "Grove - IMU 9DOF v2.0 (MPU-9250)", "mpu9250", 0x68, [...ACC, ...GYR, T])
groveI2C(S, MO, "Grove - 6-Axis Accelerometer & Gyroscope (LSM6DS3)", "lsm6ds3", 0x6a, [...ACC, ...GYR, T])
groveI2C(S, MO, "Grove - IMU 9DOF (ICM20600 + AK09918)", "icm20600", 0x69, [...ACC, ...GYR, T])
grove(S, MO, "Grove - 3-Axis Digital Compass V2 (BMM150)", none("BMM150 trim-register compensation isn't modelled yet."), {}, { pins: GI2C })
grove(S, MO, "Grove - 3-Axis Digital Accelerometer ±200g (ADXL372)", none("ADXL372 — not modelled yet."), {}, { pins: GI2C })
grove(S, MO, "Grove - 6-Axis Accelerometer & Gyroscope (BMI088)", none("BMI088 — not modelled yet."), {}, { pins: GI2C })

add(S, "Position & GPS", "GPS NEO-6M", { k: "module", color: "#1e3a8a", chip: "NEO-6M", icon: "gps" }, ["VCC", "RX", "TX", "GND"], { m: "proto", kind: "gps", ctls: [c("lat", "Latitude", -90, 90, 0.0001, "°", 6.9271), c("lon", "Longitude", -180, 180, 0.0001, "°", 79.8612), c("sats", "Satellites", 0, 12, 1, "", 8)] })

const PV = "Presence & vibration"
grove(S, PV, "Grove - Piezo Vibration Sensor", { m: "digital", pin: "SIG", pulse: 0.2 }, { icon: "bars" })
grove(S, PV, "Grove - Vibration Sensor (SW-420)", { m: "digital", pin: "SIG", pulse: 0.2 }, { icon: "bars" })
grove(S, PV, "Grove - PIR Motion Sensor", { m: "digital", pin: "SIG", pulse: 3 }, { icon: "eye" })
grove(S, PV, "Grove - Adjustable PIR Motion Sensor", { m: "digital", pin: "SIG", pulse: 3 }, { icon: "eye" })
grove(S, PV, "Grove - Digital PIR Motion Sensor (12m)", { m: "digital", pin: "SIG", pulse: 3 }, { icon: "eye" })
grove(S, PV, "Grove - Line Finder v1.1", { m: "digital", pin: "SIG" }, { icon: "eye" })
groveI2C(S, PV, "Grove - Human Presence Sensor (AK9753)", "ak9753", 0x64, [c("ir", "IR level", 0, 32767, 1, "", 0)], { icon: "eye" })
grove(S, PV, "Grove - Lightning Sensor (AS3935)", none("AS3935 — not modelled yet."), { icon: "antenna" }, { pins: [...GI2C, "IRQ"] })

const PA = "Pressure & altitude"
add(S, PA, "BMP280 (Pressure + Temp)", { k: "module", color: "#6b21a8", chip: "BMP280" }, ["VCC", "GND", "SCL", "SDA"], { m: "i2c", chip: "bmp280", addr: 0x76, ctls: [T, P] })
grove(S, PA, "Grove - Integrated Pressure Sensor Kit (MPX5700AP)", { m: "analog", pin: "SIG", ctl: c("value", "Pressure", 15, 700, 1, "kPa", 101), f: (p, vcc) => clamp(vcc * (0.0012858 * p + 0.04), 0, vcc) }, { chip: "MPX5700" })
grove(S, PA, "Grove - Round Force Sensor (FSR402)", { m: "analog", pin: "SIG", ctl: c("value", "Force", 0, 100, 0.1, "N", 0), f: (n, vcc) => (vcc * n) / (n + 5) }, { icon: "touch" })
groveI2C(S, PA, "Grove - IMU 10DOF (MPU9250 + BMP280)", "mpu9250+bmp280", 0x68, [...ACC, ...GYR, T, P])
groveI2C(S, PA, "Grove - IMU 10DOF v2.0 (MPU9250 + BMP280)", "mpu9250+bmp280", 0x68, [...ACC, ...GYR, T, P])
grove(S, PA, "Grove - High Precision Barometric Pressure Sensor (DPS310)", none("DPS310 coefficient compensation isn't modelled yet."), {}, { pins: GI2C })
grove(S, PA, "Grove - Temperature and Barometer Sensor (SPA06-003)", none("SPA06 — not modelled yet."), {}, { pins: GI2C })
grove(S, PA, "Grove - Barometer Sensor (High-Accuracy, HP206C)", none("HP206C — not modelled yet."), {}, { pins: GI2C })

const SM = "Sound & microphones"
add(S, SM, "ReSpeaker Lite (XMOS XU316)", { k: "module", color: "#111", chip: "XU316", icon: "mic", w: 140, h: 100 }, [...hdr("P", 19), "GND", "5V"], none("USB/I²S voice board — not simulated."))
grove(S, SM, "Grove - Analog Microphone (MEMS)", { m: "analog", pin: "SIG", ctl: c("value", "Sound level", 30, 110, 1, "dB", 45), f: lin(30, 110, 0.5, 0.95) }, { icon: "mic" }, { pins: [...G3, "NC"] })
grove(S, SM, "Grove - Sound Sensor (LM358)", { m: "analog", pin: "SIG", ctl: c("value", "Sound level", 30, 110, 1, "dB", 45), f: lin(30, 110, 0, 0.9) }, { icon: "mic" })

const TH = "Temperature & humidity"
add(S, TH, "BME280 Sensor", { k: "module", color: "#6b21a8", chip: "BME280" }, ["VCC", "GND", "SCL", "SDA"], { m: "i2c", chip: "bme280", addr: 0x76, ctls: [T, H, P] })
add(S, TH, "DS18B20 Temperature Sensor", { k: "to92", label: "DS18B20" }, ["GND", "DQ", "VDD"], { m: "proto", kind: "ds18b20", ctls: [c("t", "Temperature", -55, 125, 0.0625, "°C", 24)] })
add(S, TH, "MAX6675 K-Type Thermocouple", { k: "module", color: "#b91c1c", chip: "MAX6675", icon: "probe" }, ["GND", "VCC", "SCK", "CS", "SO"], { m: "proto", kind: "max6675", ctls: [c("t", "Temperature", 0, 1023, 0.25, "°C", 25)] })
add(S, TH, "MAX31856 Universal Thermocouple", { k: "module", color: "#1e3a8a", chip: "MAX31856", icon: "probe" }, ["VIN", "GND", "SCK", "SDO", "SDI", "CS"], none("SPI register model not written yet — use the MAX6675."))
add(S, TH, "MAX31865 PT100 RTD", { k: "module", color: "#1e3a8a", chip: "MAX31865", icon: "probe" }, ["VIN", "GND", "CLK", "SDO", "SDI", "CS"], none("SPI register model not written yet."))
grove(S, TH, "Grove - High Temperature Sensor", { m: "analog", pin: "SIG", ctl: c("value", "Temperature", -50, 600, 1, "°C", 25), f: (t) => clamp(0.6 + t * 0.0041 * 5.6, 0, 3.3) }, { icon: "probe" }, { pins: [...G3, "SIG2"] })
grove(S, TH, "Grove - Infrared Temperature Sensor", { m: "analog", pin: "SIG", ctl: c("value", "Object temperature", -10, 100, 0.5, "°C", 30), f: (t) => clamp(1.5 + (t - 25) * 0.01, 0, 5) }, { icon: "eye" }, { pins: [...G3, "SIG2"] })
grove(S, TH, "Grove - Temperature Sensor", { m: "analog", pin: "SIG", ctl: c("value", "Temperature", -40, 125, 0.5, "°C", 25), f: ntc100k }, { icon: "probe" })
groveI2C(S, TH, "Grove - Temperature & Humidity Sensor V2.0 (DHT20)", "aht20", 0x38, [T, H])
groveI2C(S, TH, "Grove - High Accuracy Temperature Sensor (MCP9808)", "mcp9808", 0x18, [T])
groveI2C(S, TH, "Grove - Temperature & Humidity Sensor (High-Accuracy & Mini, TH02)", "th02", 0x40, [T, H])
groveI2C(S, TH, "Grove - Temp & Humi & Barometer Sensor (BME280)", "bme280", 0x76, [T, H, P])
groveI2C(S, TH, "Grove - Temperature and Barometer Sensor (BMP280)", "bmp280", 0x77, [T, P])
grove(S, TH, "Grove - Temperature & Humidity Sensor (DHT11)", { m: "proto", kind: "dht11", ctls: [c("t", "Temperature", 0, 50, 1, "°C", 24), c("h", "Humidity", 20, 90, 1, "%RH", 45)], pins: { sig: "SIG" } }, { color: "#1f6fb2" })
grove(S, TH, "Grove - Temperature & Humidity Sensor Pro (DHT22/AM2302)", { m: "proto", kind: "dht22", ctls: [c("t", "Temperature", -40, 80, 0.1, "°C", 24), H], pins: { sig: "SIG" } })
add(S, TH, "Grove - I2C Thermocouple Amplifier (MCP9600)", { k: "grove", chip: "MCP9600", icon: "probe" }, [...GI2C, "TC+", "TC-"], { m: "i2c", chip: "mcp9600", addr: 0x60, ctls: [c("t", "Hot junction", -200, 1300, 0.5, "°C", 100), c("cold", "Cold junction", -40, 125, 0.5, "°C", 25)] })
groveI2C(S, TH, "Grove - Infrared Thermometer (MLX90614 DCI, 5°)", "mlx90614", 0x5a, [c("obj", "Object", -70, 380, 0.1, "°C", 36.6), c("amb", "Ambient", -40, 125, 0.1, "°C", 24)], { icon: "eye" })
groveI2C(S, TH, "Grove - Infrared Thermometer (MLX90614 DCC, 35°)", "mlx90614", 0x5a, [c("obj", "Object", -70, 380, 0.1, "°C", 36.6), c("amb", "Ambient", -40, 125, 0.1, "°C", 24)], { icon: "eye" })
groveI2C(S, TH, "Grove - Digital Infrared Temperature Sensor (MLX90615)", "mlx90615", 0x5b, [c("obj", "Object", -40, 115, 0.1, "°C", 36.6), c("amb", "Ambient", -40, 85, 0.1, "°C", 24)], { icon: "eye" })
add(S, TH, "Grove - 1-Wire Thermocouple Amplifier (MAX31850K)", { k: "grove", chip: "MAX31850", icon: "probe" }, ["GND", "VCC", "DQ"], { m: "proto", kind: "max31850", ctls: [c("t", "Temperature", -200, 1300, 0.25, "°C", 100)] })

const WS = "Water & soil"
const soil = (x: number, vcc: number) => vcc * clamp(0.85 - x * 0.006, 0.2, 0.9)
add(S, WS, "Gravity: Capacitive Soil Moisture Sensor (IP65)", { k: "module", color: "#b91c1c", icon: "drop", h: 130, w: 50 }, ["GND", "VCC", "AOUT"], { m: "analog", pin: "AOUT", ctl: c("value", "Moisture", 0, 100, 1, "%", 40), f: soil })
grove(S, WS, "Grove - Capacitive Soil Moisture Sensor", { m: "analog", pin: "SIG", ctl: c("value", "Moisture", 0, 100, 1, "%", 40), f: soil }, { icon: "drop" })
grove(S, WS, "Grove - ORP Sensor Kit Pro", { m: "analog", pin: "SIG", ctl: c("value", "ORP", -2000, 2000, 1, "mV", 200), f: (mv) => clamp(2.0 - mv / 1000, 0, 4) }, { icon: "probe" })
grove(S, WS, "Grove - PH Sensor", { m: "analog", pin: "SIG", ctl: c("value", "pH", 0, 14, 0.1, "pH", 7), f: (x) => 0.5 + x * 0.15 }, { icon: "probe" })
grove(S, WS, "Grove - Soil Moisture Sensor", { m: "analog", pin: "SIG", ctl: c("value", "Moisture", 0, 100, 1, "%", 40), f: lin(0, 100, 0, 0.78) }, { icon: "drop" })
grove(S, WS, "Grove - TDS Sensor (Water Quality)", { m: "analog", pin: "SIG", ctl: c("value", "TDS", 0, 1000, 1, "ppm", 150), f: (p) => p * 0.0023 }, { icon: "drop" })
add(S, WS, "Grove - Turbidity Sensor V1.0", { k: "grove", icon: "drop" }, ["GND", "VCC", "SIG", "D", "NC1", "NC2", "NC3"], { m: "analog", pin: "SIG", ctl: c("value", "Turbidity", 0, 3000, 10, "NTU", 0), f: (n) => clamp(4.2 - n / 1000, 2.5, 4.2), dout: "D", thr: 0.7 })
grove(S, WS, "Grove - Water Sensor", { m: "digital", pin: "SIG", low: true }, { icon: "drop" })
add(S, WS, "Grove - Water Level Sensor (10cm)", { k: "grove", icon: "drop" }, GI2C, { m: "i2c", chip: "waterlevel", addr: 0x77, ctls: [c("level", "Water level", 0, 100, 1, "mm", 30)] })

const OS = "Other sensors"
groveI2C(S, OS, "Grove - DS1307 RTC (Real Time Clock)", "ds1307", 0x68, [], { icon: "clock" })
add(S, OS, "Grove - High Precision RTC (PCF85063)", { k: "grove", chip: "PCF85063", icon: "clock" }, [...GI2C, "INT", "CLKOUT"], { m: "i2c", chip: "pcf85063", addr: 0x51 })

// ── Output ─────────────────────────────────────────────────────────────────────────────────
const O = "Output"
const BZ = "Buzzers & speakers"
grove(O, BZ, "Grove - Active Buzzer", { m: "buzzer", pin: "SIG", active: true }, { icon: "buzzer" })
grove(O, BZ, "Grove - Passive Buzzer", { m: "buzzer", pin: "SIG" }, { icon: "buzzer" })
grove(O, BZ, "Grove - Speaker", { m: "buzzer", pin: "SIG" }, { icon: "speaker" })
grove(O, BZ, "Grove - Speaker Plus", { m: "buzzer", pin: "SIG" }, { icon: "speaker" })
grove(O, BZ, "Grove - Recorder v3.0", none("ISD1820 voice recorder — not simulated."), { icon: "mic" }, { pins: [...G3, "SIG2"] })

const LD = "LEDs & addressable pixels"
const groveLed = (title: string, color: string) => grove(O, LD, title, { m: "led", pin: "SIG", color }, { icon: "led" }, { attrs: { color } })
groveLed("Grove - Red LED", "red"); groveLed("Grove - Blue LED", "blue"); groveLed("Grove - Green LED", "green"); groveLed("Grove - White LED", "white"); groveLed("Grove - Purple LED (3mm)", "purple")
groveLed("Grove - Multi Color Flash LED (5mm)", "rainbow"); groveLed("Grove - LED String Light", "white"); groveLed("Grove - Variable Color LED", "red"); groveLed("Grove - Infrared Emitter", "infrared")
groveLed("Grove - LED Pack (red, green, blue, white)", "white")
add(O, LD, "M5Stack Chain Mono Matrix (8×8, White)", { k: "screen", color: "#111", sw: 64, sh: 64, tint: "#fff" }, ["GND", "VCC", "RX", "TX", "GND.2", "VCC.2", "RX.2", "TX.2"], none("M5Stack Chain bus — not simulated yet."))
add(O, LD, "M5Stack Chain RGB Matrix (8×8)", { k: "screen", color: "#111", sw: 64, sh: 64 }, ["GND", "VCC", "RX", "TX", "GND.2", "VCC.2", "RX.2", "TX.2"], none("M5Stack Chain bus — not simulated yet."))
const ws = (title: string, count: number, ring = false) => add(O, LD, title, { k: "strip", count, ring }, ["GND", "VCC", "SIG"], { m: "proto", kind: "ws2812", pins: { din: "SIG" } }, { attrs: { pixels: String(count) }, hint: `${count} WS2813 RGB LEDs on SIG (Adafruit_NeoPixel / FastLED) — the bit stream is decoded and drawn.` })
ws("Grove - RGB LED (WS2813 Mini)", 1); ws("Grove - RGB LED Stick (10 × WS2813 Mini)", 10); ws("Grove - RGB LED Stick (15 × WS2813 Mini)", 15); ws("Grove - RGB LED Stick (20 × WS2813 Mini)", 20)
ws("Grove - RGB LED Ring (16 × WS2813 Mini)", 16, true); ws("Grove - RGB LED Ring (20 × WS2813 Mini)", 20, true); ws("Grove - RGB LED Ring (24 × WS2813 Mini)", 24, true); ws("Grove - Ultimate RGB LED Ring (42)", 42, true)
ws("Grove - WS2813 RGB LED Strip (30 LED/m, 1 m)", 30); ws("Grove - WS2813 RGB LED Strip (60 LED/m, 1 m)", 60)
add(O, LD, "COB LED Driver Board for XIAO", { k: "module", color: "#111", icon: "led" }, [...hdr("D", 8), "5V", "GND"], none("LED-strip MOSFET carrier — not simulated yet."))

const RS = "Relays & switching"
add(O, RS, "Heater Block", { k: "module", color: "#57534e", icon: "flame" }, ["+", "-"], { m: "load", a: "+", b: "-", r: 12 })
add(O, RS, "Grove - Relay (5V/10A)", { k: "relay", label: "10A 250VAC" }, ["GND", "VCC", "SIG", "COM", "NO"], { m: "relay", coil: ["SIG"], com: ["COM"], no: ["NO"] })
add(O, RS, "Grove - SPDT Relay (30A)", { k: "relay", label: "30A" }, ["GND", "VCC", "SIG", "COM", "NO", "NC"], { m: "relay", coil: ["SIG"], com: ["COM"], no: ["NO"], nc: ["NC"] })
add(O, RS, "Grove - Dry-Reed Relay", { k: "relay", label: "reed" }, ["GND", "VCC", "SIG", "COM", "NO"], { m: "relay", coil: ["SIG"], com: ["COM"], no: ["NO"] })
add(O, RS, "Grove - Optocoupler Relay (M281)", { k: "relay", label: "SSR", color: "#111" }, ["GND", "VCC", "SIG", "COM", "NO"], { m: "relay", coil: ["SIG"], com: ["COM"], no: ["NO"], ssr: true })
add(O, RS, "Grove - 2-Coil Latching Relay", { k: "relay", label: "latch" }, ["GND", "VCC", "SET", "RESET", "COM", "NO", "NC", "NC2", "NC3"], { m: "relay", coil: ["SET"], com: ["COM"], no: ["NO"], nc: ["NC"] })
add(O, RS, "Grove - MOSFET (CJQ4435)", { k: "grove", icon: "chip", chip: "CJQ4435" }, ["GND", "VCC", "SIG", "VIN", "GND.2", "OUT+", "OUT-"], { m: "relay", coil: ["SIG"], com: ["VIN"], no: ["OUT+"], ssr: true })

const OO = "Other output"
grove(O, OO, "Grove - Electromagnet", { m: "load", a: "SIG", r: 40 }, { icon: "magnet" })
grove(O, OO, "Grove - Water Atomization", { m: "load", a: "SIG", r: 50 }, { icon: "drop" })

// ── Displays ───────────────────────────────────────────────────────────────────────────────
const D = "Displays"
const CL = "Character LCD"
const groveLcd = (title: string, rgb: boolean) => add(D, CL, title, { k: "grove" }, GI2C, { m: "i2c", chip: rgb ? "grovelcd-rgb" : "grovelcd", addr: 0x3e }, { base: "wokwi-lcd1602", attrs: { pins: "i2c" }, hint: `16×2 LCD on I²C 0x3E${rgb ? " with an RGB backlight at 0x62" : ""} (rgb_lcd / Grove_LCD_RGB_Backlight library).` })
groveLcd("Grove - 16x2 LCD RGB Backlight", true); groveLcd("Grove - 16x2 LCD (White on Blue)", false); groveLcd("Grove - 16x2 LCD (Black on Yellow)", false); groveLcd("Grove - 16x2 LCD (Black on Red)", false)
add(D, CL, "Round Display for XIAO (1.28\", GC9A01)", { k: "screen", color: "#111", sw: 120, sh: 120, w: 150, h: 150 }, hdr("D", 14), none("SPI GC9A01 TFT — not simulated yet."))
add(D, CL, "Grove - 1.22\" IPS Display 240x240", { k: "screen", color: "#111", sw: 80, sh: 80 }, GI2C, none("SPI/I²C IPS display — not simulated yet."))
add(D, "LED matrix & segment", "Grove - Chainable RGB LED V2.0 (P9813)", { k: "grove", icon: "led" }, ["CI", "DI", "VCC", "GND", "CO", "DO", "VCC.2", "GND.2"], { m: "proto", kind: "p9813", pins: { clk: "CI", data: "DI" } })

const EP = "e-Paper & e-ink"
const epd = (title: string, w: number, h: number) => add(D, EP, title, { k: "screen", color: "#e5e5e5", sw: Math.round(w / 3), sh: Math.round(h / 3), tint: "#ddd" }, ["VCC", "GND", "DIN", "CLK", "CS", "DC", "RST", "BUSY"], none("SPI e-paper controller — not simulated yet."))
epd("ePaper 1.54\" (200×200, B/W)", 200, 200); epd("ePaper 2.13\" (250×122, B/W)", 250, 122); epd("ePaper 2.13\" (250×122, B/W/Red)", 250, 122); epd("ePaper 2.9\" (296×128, B/W)", 296, 128)
epd("ePaper 2.9\" (296×128, B/W/Red)", 296, 128); epd("ePaper 4.2\" (400×300, B/W)", 400, 300); epd("ePaper 5.65\" (600×448, 7-colour)", 600, 448); epd("ePaper 7.5\" (800×480, B/W)", 800, 480)
add(D, EP, "Grove - Triple Color E-Ink Display 2.13\"", { k: "screen", color: "#e5e5e5", sw: 83, sh: 41, tint: "#ddd" }, GUART, none("UART e-ink — not simulated yet."))

const LM = "LED matrix & segment"
add(D, LM, "Grove - 4-Digit Display (TM1637)", { k: "grove", icon: "digits", label: "TM1637" }, ["GND", "VCC", "DIO", "CLK"], { m: "proto", kind: "tm1637" })
add(D, LM, "Grove - LED Bar v2.0 (MY9221)", { k: "grove", icon: "bars", label: "MY9221" }, ["GND", "VCC", "DI", "DCKI"], { m: "proto", kind: "my9221", ctls: [] }, { attrs: { pixels: "10" } })
grove(D, LM, "Grove - Red LED Matrix w/Driver", none("Seeed's own matrix MCU protocol — not modelled yet."), { icon: "matrix" }, { pins: GI2C })
add(D, LM, "Grove - LED Matrix Driver (HT16K33)", { k: "grove", icon: "matrix", chip: "HT16K33" }, GI2C, { m: "i2c", chip: "ht16k33", addr: 0x70 }, { attrs: { layout: "matrix" } })
add(D, LM, "Grove - LED Strip Driver (P9813)", { k: "grove", chip: "P9813" }, ["CI", "DI", "VCC", "GND", "CO", "DO", "VCC.2", "GND.2", "LED+", "R-", "G-", "B-", "VIN", "GND.3"], { m: "proto", kind: "p9813", pins: { clk: "CI", data: "DI" } })
add(D, LM, "Grove - Circular LED (24 LEDs)", { k: "strip", count: 24, ring: true, color: "#22c55e" }, ["GND", "VCC", "DI", "DCKI"], { m: "proto", kind: "my9221" }, { attrs: { pixels: "24" } })
add(D, LM, "Grove - 0.54\" Red Dual Alphanumeric Display", { k: "grove", icon: "digits", chip: "HT16K33" }, GI2C, { m: "i2c", chip: "ht16k33", addr: 0x70 }, { attrs: { layout: "alnum2" } })
add(D, LM, "Grove - 0.54\" Red Quad Alphanumeric Display", { k: "grove", icon: "digits", chip: "HT16K33" }, GI2C, { m: "i2c", chip: "ht16k33", addr: 0x70 }, { attrs: { layout: "alnum4" } })
grove(D, LM, "Grove - 8x8 RGB LED Matrix w/Driver", none("Seeed's own matrix MCU protocol — not modelled yet."), { icon: "matrix" }, { pins: GI2C })
add(D, LM, "Grove - Chainable RGB LED", { k: "grove", icon: "led" }, ["CI", "DI", "VCC", "GND", "CO", "DO", "VCC.2", "GND.2"], { m: "proto", kind: "p9813", pins: { clk: "CI", data: "DI" } })

const OL = "OLED"
const oled = (title: string, o: Opt = {}) => add(D, OL, title, { k: "grove" }, GI2C, { m: "i2c", chip: "ssd1306", addr: 0x3c }, { base: "wokwi-ssd1306", hint: "128×64 OLED on I²C 0x3C — SSD1306-compatible commands (Adafruit_SSD1306 / U8g2).", ...o })
oled("Grove - OLED Display 0.96\" (SSD1315)"); oled("Grove - OLED Yellow & Blue Display 0.96\" (SSD1315)"); oled("Grove - OLED Display 0.66\" (SSD1306)"); oled("Grove - OLED Display 0.96\" (SSD1308)")
add(D, OL, "SSD1306 OLED (SPI, 7-pin)", { k: "screen", color: "#1e3a8a", sw: 64, sh: 32, tint: "#0b1020" }, ["GND", "VCC", "D0", "D1", "RES", "DC", "CS"], none("SPI wiring of the SSD1306 isn't simulated yet — use the I²C module."))
add(D, OL, "Grove - OLED Display 1.12\" (SH1107) V3.0", { k: "screen", color: "#111", sw: 64, sh: 64, tint: "#0b1020" }, GI2C, { m: "i2c", chip: "sh1107", addr: 0x3c })
add(D, OL, "Grove - OLED Display 1.12\" V2 (SH1107)", { k: "screen", color: "#111", sw: 64, sh: 64, tint: "#0b1020" }, GI2C, { m: "i2c", chip: "sh1107", addr: 0x3c })
add(D, OL, "Grove - OLED Display 1.12\" (SSD1327, 96×96 grey)", { k: "screen", color: "#111", sw: 48, sh: 48, tint: "#0b1020" }, GI2C, none("SSD1327 greyscale — not modelled yet."))

const TF = "TFT & colour screens"
add(D, TF, "ILI9341", { k: "screen", color: "#b91c1c", sw: 120, sh: 160 }, ["VCC", "GND", "CS", "RST", "D/C", "MOSI", "SCK", "LED", "MISO"], none("SPI TFT — the drawing is placed but the ILI9341 controller isn't simulated yet."), { type: "wokwi-ili9341" })
add(D, TF, "2.8\" TFT + Touch (ILI9341 + XPT2046)", { k: "screen", color: "#b91c1c", sw: 120, sh: 160, w: 150, h: 200 }, ["VCC", "GND", "CS", "RESET", "DC", "SDI", "SCK", "LED", "SDO", "T_CLK", "T_CS", "T_DIN", "T_DO", "T_IRQ"], none("SPI TFT — not simulated yet."))
add(D, TF, "3.5\" TFT 480x320 + Touch (ILI9488 + XPT2046)", { k: "screen", color: "#b91c1c", sw: 160, sh: 107, w: 200, h: 150 }, ["VCC", "GND", "CS", "RESET", "DC", "SDI", "SCK", "LED", "SDO", "T_CLK", "T_CS", "T_DIN", "T_DO", "T_IRQ"], none("SPI TFT — not simulated yet."))

// ── Input ──────────────────────────────────────────────────────────────────────────────────
const I = "Input"
const BS = "Buttons & switches"
grove(I, BS, "Grove - Button", { m: "button", pin: "SIG" }, { icon: "button" })
grove(I, BS, "Grove - Button (P)", { m: "button", pin: "SIG" }, { icon: "button" })
add(I, BS, "Grove - Red LED Button", { k: "grove", icon: "button", color: "#1f6fb2" }, ["GND", "VCC", "SIG", "LED"], { m: "button", pin: "SIG", low: true, led: "LED" }, { attrs: { color: "red" } })
add(I, BS, "Grove - Yellow LED Button", { k: "grove", icon: "button", color: "#1f6fb2" }, ["GND", "VCC", "SIG", "LED"], { m: "button", pin: "SIG", low: true, led: "LED" }, { attrs: { color: "yellow" } })
add(I, BS, "Grove - Dual Button", { k: "grove", icon: "button" }, ["GND", "VCC", "SIG1", "SIG2"], { m: "proto", kind: "dualbutton" }, { hint: "Two buttons: SIG1 and SIG2 go LOW while pressed (click the left/right half)." })
grove(I, BS, "Grove - Micro Switch", { m: "button", pin: "SIG" }, { icon: "switch" })
grove(I, BS, "Grove - Digital Switch (P)", { m: "button", pin: "SIG", latch: true }, { icon: "switch" })
grove(I, BS, "Grove - Magnetic Switch", { m: "digital", pin: "SIG" }, { icon: "magnet" })
groveI2C(I, BS, "Grove - 6-Position DIP Switch", "dip6", 0x03, [c("bits", "Switches (bits)", 0, 63, 1, "", 0)], { icon: "switch" })
add(I, BS, "Pushbutton (6mm)", { k: "module", color: "#111" }, ["1.l", "2.l", "1.r", "2.r"], none(), { legacy: true, type: "wokwi-pushbutton-6mm", hint: "Tactile 6 mm button: 1 and 2 connect while pressed." })

const GV = "Gesture & vision"
add(I, GV, "Grove Smart IR Gesture Sensor (PAG7660)", { k: "grove", icon: "eye" }, [...GI2C, ...hdr("P", 14)], none("PAG7660 — not modelled yet."))
add(I, GV, "HuskyLens AI Vision Sensor", { k: "module", color: "#111", icon: "camera" }, ["T/SDA", "R/SCL", "GND", "VCC"], none("AI camera — not simulated."))
add(I, GV, "Gravity: DF2301Q Voice Recognition", { k: "module", color: "#b91c1c", icon: "mic" }, GI2C, none("Voice recognition module — not simulated."))
groveI2C(I, GV, "Grove - Gesture Sensor (PAJ7620U2)", "paj7620", 0x73, [c("g", "Gesture (0 none, 1 up, 2 down, 3 left, 4 right, 5 fwd, 6 back, 7 cw, 8 ccw, 9 wave)", 0, 9, 1, "", 0)], { icon: "eye" })

const KN = "Knobs, encoders & joysticks"
add(I, KN, "KY-040 Rotary Encoder", { k: "module", color: "#111" }, ["CLK", "DT", "SW", "VCC", "GND"], { m: "proto", kind: "encoder", pins: { a: "CLK", b: "DT", sw: "SW" }, ctls: [c("pos", "Position", -100, 100, 1, "steps", 0)] }, { type: "wokwi-ky-040" })
add(I, KN, "RGB Encoder Wheel", { k: "module", color: "#111", icon: "knob" }, GI2C.concat("INT"), none("I²C encoder wheel — not modelled yet."))
add(I, KN, "Grove - Thumb Joystick", { k: "grove", icon: "joystick" }, ["GND", "VCC", "X", "Y"], { m: "proto", kind: "joystick2", ctls: [c("x", "X", -1, 1, 0.01, "", 0), c("y", "Y", -1, 1, 0.01, "", 0)] })
add(I, KN, "Grove - Encoder", { k: "grove", icon: "knob" }, ["GND", "VCC", "A", "B"], { m: "proto", kind: "encoder", pins: { a: "A", b: "B" }, ctls: [c("pos", "Position", -100, 100, 1, "steps", 0)] })
add(I, KN, "Grove - Mouse Encoder", { k: "grove", icon: "knob" }, ["GND", "VCC", "A", "B"], { m: "proto", kind: "encoder", pins: { a: "A", b: "B" }, ctls: [c("pos", "Position", -100, 100, 1, "steps", 0)] })
add(I, KN, "Grove - Optical Rotary Encoder (TCUT1600X01)", { k: "grove", icon: "knob" }, ["GND", "VCC", "A", "B"], { m: "proto", kind: "encoder", pins: { a: "A", b: "B" }, ctls: [c("pos", "Position", -100, 100, 1, "steps", 0)] })

const TK = "Touch & keypads"
add(I, TK, "Membrane Keypad", { k: "module", color: "#111" }, ["R1", "R2", "R3", "R4", "C1", "C2", "C3", "C4"], { m: "proto", kind: "keypad" }, { type: "wokwi-membrane-keypad" })
grove(I, TK, "Grove - Touch Sensor", { m: "button", pin: "SIG" }, { icon: "touch" })
grove(I, TK, "Grove - Mech Keycap", { m: "button", pin: "SIG" }, { icon: "button" }, { pins: [...G3, "LED"] })
groveI2C(I, TK, "Grove - 12 Key Capacitive Touch Sensor V2 (MPR121)", "mpr121", 0x5b, [c("keys", "Touched keys (bits)", 0, 4095, 1, "", 0)], { icon: "touch" })
groveI2C(I, TK, "Grove - 12 Key Capacitive Touch Sensor V3 (MPR121)", "mpr121", 0x5b, [c("keys", "Touched keys (bits)", 0, 4095, 1, "", 0)], { icon: "touch" })
grove(I, TK, "Grove - Capacitive Fingerprint Scanner", none("UART fingerprint module — not simulated."), { icon: "touch" }, { pins: GUART })
grove(I, TK, "Grove - 12-Channel Capacitive Touch Keypad (ATtiny1616)", none("UART touch keypad — not simulated yet."), { icon: "touch" }, { pins: GUART })

// ── Motors ─────────────────────────────────────────────────────────────────────────────────
const M = "Motors"
const MD = "Motor drivers"
add(M, MD, "A4988 Stepper Driver", { k: "module", color: "#166534", chip: "A4988" }, ["EN", "MS1", "MS2", "MS3", "RST", "SLP", "STEP", "DIR", "VMOT", "GND", "2B", "2A", "1A", "1B", "VDD", "GND.2"], { m: "proto", kind: "a4988" })
add(M, MD, "DC Motor / Fan", { k: "module", color: "#57534e", icon: "fan", w: 70, h: 70 }, ["+", "-"], { m: "motor", a: "+", b: "-", r: 20 })
add(M, MD, "Gear Motor with Encoder", { k: "module", color: "#57534e", icon: "motor", w: 90, h: 60 }, ["M+", "M-", "VCC", "GND", "A", "B"], { m: "proto", kind: "gearmotor" })
grove(M, MD, "Grove - Vibration Motor", { m: "motor", a: "SIG", r: 30 }, { icon: "motor" })
grove(M, MD, "Grove - Mini Fan v1.1", { m: "motor", a: "SIG", r: 20 }, { icon: "fan" })
grove(M, MD, "Grove - Servo", { m: "proto", kind: "servo", pins: { pwm: "SIG" } }, { icon: "motor" })
add(M, MD, "Grove - 16-Channel PWM Driver (PCA9685)", { k: "grove", chip: "PCA9685" }, [...GI2C, "OE", "V+", ...hdr("PWM", 16)], { m: "i2c", chip: "pca9685", addr: 0x40 })
add(M, MD, "Grove - I2C Motor Driver (L298P)", { k: "grove", chip: "L298P" }, [...GI2C, "M1+", "M1-", "M2+", "M2-", "VS", "GND.2"], { m: "i2c", chip: "sink", addr: 0x0f })
add(M, MD, "Grove - I2C Motor Driver with L298", { k: "grove", chip: "L298" }, [...GI2C, "M1+", "M1-", "M2+", "M2-", "VS", "GND.2"], { m: "i2c", chip: "sink", addr: 0x0f })
add(M, MD, "Grove - I2C Mini Motor Driver (DRV8830)", { k: "grove", chip: "DRV8830" }, [...GI2C, "M1+", "M1-", "M2+", "M2-"], { m: "i2c", chip: "sink", addr: 0x60 })
add(M, MD, "Grove - I2C Motor Driver (TB6612FNG)", { k: "grove", chip: "TB6612" }, [...GI2C, "A1", "A2", "B1", "B2", "VM", "GND.2", "STBY", "M1+", "M1-", "M2+"], { m: "i2c", chip: "sink", addr: 0x14 })

const MS = "Motors, servos & fans"
add(M, MS, "Biaxial Stepper", { k: "module", color: "#111" }, ["A1-", "A1+", "B1+", "B1-", "A2-", "A2+", "B2+", "B2-"], { m: "proto", kind: "stepper" }, { type: "wokwi-biaxial-stepper" })
add(M, MS, "Stepper Motor", { k: "module", color: "#111" }, ["A-", "A+", "B+", "B-"], { m: "proto", kind: "stepper" }, { type: "wokwi-stepper-motor" })
groveI2C(M, MS, "Grove - Haptic Motor (DRV2605L)", "sink", 0x5a, [], { icon: "motor" })

// ── Communication ──────────────────────────────────────────────────────────────────────────
const C = "Communication"
grove(C, "RFID & NFC", "Grove - 125KHz RFID Reader", { m: "proto", kind: "rfid125", ctls: [c("tag", "Tag id", 0, 0xffffff, 1, "", 0x13a2f)] }, { icon: "antenna" }, { pins: GUART })
grove(C, "RFID & NFC", "Grove - NFC (PN532)", none("PN532 — not modelled yet."), { icon: "antenna" }, { pins: GI2C })
groveI2C(C, "RFID & NFC", "Grove - NFC (ST25DV64)", "eeprom", 0x53, [], { icon: "antenna" })
const SB = "Serial, bus & IR"
grove(C, SB, "Grove - RS232", none("RS232 level shifter — passes UART through; not simulated."), { chip: "MAX3232" }, { pins: GUART })
grove(C, SB, "Grove - RS485", none("RS485 transceiver — not simulated."), { chip: "MAX485" }, { pins: GUART })
grove(C, SB, "Grove - GPS (Air530Z)", { m: "proto", kind: "gps", ctls: [c("lat", "Latitude", -90, 90, 0.0001, "°", 6.9271), c("lon", "Longitude", -180, 180, 0.0001, "°", 79.8612), c("sats", "Satellites", 0, 12, 1, "", 8)] }, { icon: "gps" }, { pins: GUART })
grove(C, SB, "Grove - IR Receiver", { m: "proto", kind: "irrecv", pins: { out: "SIG" } }, { icon: "eye" })
grove(C, SB, "Grove - GPS Module", { m: "proto", kind: "gps", ctls: [c("lat", "Latitude", -90, 90, 0.0001, "°", 6.9271), c("lon", "Longitude", -180, 180, 0.0001, "°", 79.8612), c("sats", "Satellites", 0, 12, 1, "", 8)] }, { icon: "gps" }, { pins: GUART })
grove(C, SB, "Grove - CAN BUS Module (GD32E103)", none("CAN bus — not simulated."), { chip: "GD32" }, { pins: GUART })
const VA = "Voice & AI modules"
grove(C, VA, "Grove - Speech Recognizer", none("Voice module — not simulated."), { icon: "mic" }, { pins: GUART })
grove(C, VA, "Grove - Offline Voice Recognition Module", none("Voice module — not simulated."), { icon: "mic" }, { pins: GUART })
grove(C, VA, "Grove - Vision AI Module V2", none("AI camera — not simulated."), { icon: "camera" }, { pins: GI2C })
grove(C, VA, "Grove Vision AI V2 Kit (OV5647 camera)", none("AI camera — not simulated."), { icon: "camera" }, { pins: GI2C })
const WL = "WiFi, Bluetooth & LoRa"
const radio = (title: string, chip: string) => grove(C, WL, title, none("Radio module — not simulated."), { chip, icon: "antenna" }, { pins: GUART })
radio("Grove - UART WiFi V2 (ESP8285)", "ESP8285"); radio("Grove - UART WizFi360", "WizFi360"); radio("Grove - BLE (HM-11)", "HM-11"); radio("Grove - Serial Bluetooth (CSR BC417)", "BC417")
radio("Grove - Wio-E5 Wireless Module (STM32WLE5JC)", "WLE5"); radio("Grove - LoRa Radio 433MHz", "RFM98"); radio("Grove - LoRa Radio 868MHz", "RFM95")
add("Connectivity", undefined, "WiFi Access Point", { k: "module", color: "#1e3a8a", icon: "antenna", w: 70, h: 60 }, [], none("Marks the network your ESP32 joins — Wi-Fi isn't emulated yet."))

// ── Electromechanical ──────────────────────────────────────────────────────────────────────
const E = "Electromechanical"
add(E, undefined, "L293D (Dual H-Bridge Motor Driver)", { k: "dip", label: "L293D" }, ["EN1", "IN1", "OUT1", "GND", "GND.2", "OUT2", "IN2", "VS", "EN2", "IN3", "OUT3", "GND.3", "GND.4", "OUT4", "IN4", "VSS"], { m: "proto", kind: "hbridge" })
add(E, undefined, "Relay (SPDT)", { k: "relay", label: "5V SPDT", color: "#1d4ed8" }, ["COIL1", "COIL2", "COM", "NO", "NC"], { m: "relay", coil: ["COIL1", "COIL2"], com: ["COM"], no: ["NO"], nc: ["NC"] })
add(E, undefined, "Solid State Relay (SSR-25DA)", { k: "relay", label: "SSR-25DA", color: "#111" }, ["3+", "4-", "1", "2"], { m: "relay", coil: ["3+", "4-"], com: ["1"], no: ["2"], ssr: true, vOn: 3 })
add(E, undefined, "Grove - 4-Channel SPDT Relay", { k: "relay", label: "4ch", channels: 4 }, [...GI2C, ...["1", "2", "3", "4"].flatMap((n) => [`COM${n}`, `NO${n}`, `NC${n}`])], { m: "i2c", chip: "relay4", addr: 0x11 })
add(E, undefined, "Grove - 8-Channel Solid State Relay", { k: "relay", label: "8ch SSR", channels: 8, color: "#111" }, [...GI2C, ...["1", "2", "3", "4", "5", "6", "7", "8"].flatMap((n) => [`A${n}`, `B${n}`])], { m: "i2c", chip: "relay4", addr: 0x11 })
add(E, undefined, "KS2E-M-DC5 (DPDT relay)", { k: "relay", label: "KS2E" }, ["NO2", "NC2", "P2", "COIL2", "NO1", "NC1", "P1", "COIL1"], { m: "relay", coil: ["COIL1", "COIL2"], com: ["P1", "P2"], no: ["NO1", "NO2"], nc: ["NC1", "NC2"] }, { type: "wokwi-ks2e-m-dc5" })

// ── Other (the remaining wokwi-elements) ───────────────────────────────────────────────────
const OT = "Other"
add(OT, undefined, "Big Sound Sensor", { k: "module", color: "#111" }, ["AOUT", "GND", "VCC", "DOUT"], { m: "analog", pin: "AOUT", ctl: c("value", "Sound level", 30, 110, 1, "dB", 45), f: lin(30, 110, 0, 0.9), dout: "DOUT", thr: 0.5 }, { type: "wokwi-big-sound-sensor" })
add(OT, undefined, "Small Sound Sensor", { k: "module", color: "#111" }, ["AOUT", "GND", "VCC", "DOUT"], { m: "analog", pin: "AOUT", ctl: c("value", "Sound level", 30, 110, 1, "dB", 45), f: lin(30, 110, 0, 0.9), dout: "DOUT", thr: 0.5 }, { type: "wokwi-small-sound-sensor" })
add(OT, undefined, "DS1307 RTC", { k: "module", color: "#111" }, ["GND", "5V", "SDA", "SCL", "SQW"], { m: "i2c", chip: "ds1307", addr: 0x68 }, { type: "wokwi-ds1307" })
add(OT, undefined, "DS3231 RTC", { k: "module", color: "#1e3a8a", chip: "DS3231", icon: "clock" }, ["GND", "VCC", "SDA", "SCL", "SQW", "32K"], { m: "i2c", chip: "ds3231", addr: 0x68, ctls: [T] })
add(OT, undefined, "Flame Sensor", { k: "module", color: "#111" }, ["VCC", "GND", "DOUT", "AOUT"], { m: "analog", pin: "AOUT", ctl: c("value", "Flame (IR)", 0, 100, 1, "%", 0), f: lin(0, 100, 0.95, 0.05), dout: "DOUT", thr: 0.5 }, { type: "wokwi-flame-sensor" })
add(OT, undefined, "Gas Sensor (MQ-2 module)", { k: "module", color: "#111" }, ["AOUT", "DOUT", "GND", "VCC"], { m: "analog", pin: "AOUT", ctl: gasCtl("Gas"), f: mq, dout: "DOUT", thr: 0.5 }, { type: "wokwi-gas-sensor" })
add(OT, undefined, "HX711 Load Cell Amplifier", { k: "module", color: "#111" }, ["VCC", "DT", "SCK", "GND"], { m: "proto", kind: "hx711", ctls: [c("w", "Weight", -5000, 5000, 1, "g", 0)] }, { type: "wokwi-hx711" })
add(OT, undefined, "LED Ring (16)", { k: "strip", count: 16, ring: true }, ["GND", "VCC", "DIN", "DOUT"], none(), { legacy: true, type: "wokwi-led-ring", attrs: { pixels: "16" }, hint: "16 WS2812 LEDs on DIN (Adafruit_NeoPixel)." })
add(OT, undefined, "NeoPixel Matrix (8×8)", { k: "strip", count: 64 }, ["GND", "VCC", "DIN", "DOUT"], none(), { legacy: true, type: "wokwi-neopixel-matrix", attrs: { rows: "8", cols: "8", pixels: "64" }, hint: "8×8 WS2812 matrix on DIN (Adafruit_NeoPixel / FastLED)." })
add(OT, undefined, "microSD Card", { k: "module", color: "#111", icon: "sd" }, ["CD", "DO", "GND", "SCK", "VCC", "DI", "CS"], none("SD card over SPI — not simulated yet."), { type: "wokwi-microsd-card" })
add(OT, undefined, "Rotary Dialer", { k: "module", color: "#111" }, ["GND", "DIAL", "PULSE"], { m: "proto", kind: "dialer" }, { type: "wokwi-rotary-dialer" })
add(OT, undefined, "Grove - 8 Channel I2C Hub (TCA9548A)", { k: "grove", chip: "TCA9548A" }, [...GI2C, ...[0, 1, 2, 3, 4, 5, 6, 7].flatMap((n) => [`SD${n}`, `SC${n}`]), ...hdr("NC", 16)], { m: "i2c", chip: "tca9548a", addr: 0x70 }, { hint: "I²C multiplexer at 0x70: channel selects are accepted and every device behind it answers (the canvas has one shared bus)." })

// ── Passive ────────────────────────────────────────────────────────────────────────────────
const PS = "Passive"
const capPreset = (label: string, f: number, polar = false) => add(PS, "Capacitors", polar ? `Electrolytic ${label}` : label, { k: "cap", label, polar }, polar ? ["+", "-"] : ["1", "2"], { m: "passive", kind: "C", value: f }, { type: polar ? "sb-capacitor-electrolytic" : "sb-capacitor", attrs: { value: label }, settings: { value: "text" } })
capPreset("10 pF", 10e-12); capPreset("22 pF", 22e-12); capPreset("100 pF", 100e-12); capPreset("1 nF", 1e-9); capPreset("10 nF", 10e-9); capPreset("100 nF", 100e-9); capPreset("1 µF", 1e-6)
capPreset("1 µF", 1e-6, true); capPreset("10 µF", 10e-6, true); capPreset("47 µF", 47e-6, true); capPreset("100 µF", 100e-6, true); capPreset("470 µF", 470e-6, true); capPreset("1000 µF", 1e-3, true)
for (const [l, v] of [["100 µH", 100e-6], ["1 mH", 1e-3], ["10 mH", 10e-3]] as const) add(PS, "Inductors", l, { k: "inductor", label: l }, ["1", "2"], { m: "passive", kind: "L", value: v }, { type: "sb-inductor", attrs: { value: l }, settings: { value: "text" } })
for (const v of ["220", "330", "470", "1k", "2.2k", "4.7k", "10k", "22k", "47k", "100k", "1M"]) add(PS, "Resistors", `${v.replace("k", " k").replace("M", " M")}Ω`, { k: "module", color: "#d6c08f" }, ["1", "2"], none(), { legacy: true, type: "wokwi-resistor", attrs: { value: v }, hint: `${v} Ω resistor (change the value in Settings).` })
add(PS, "Other passives", "IR Receiver", { k: "module", color: "#111" }, ["GND", "VCC", "DAT"], { m: "proto", kind: "irrecv", pins: { out: "DAT" } }, { type: "wokwi-ir-receiver" })
add(PS, "Other passives", "IR Remote", { k: "module", color: "#111" }, [], { m: "proto", kind: "irremote" }, { type: "wokwi-ir-remote" })

// ── Analog ─────────────────────────────────────────────────────────────────────────────────
const A = "Analog"
const dio = (title: string, label: string, vf: number, o: { vz?: number; schottky?: boolean } = {}) => add(A, "Diodes", title, { k: "diode", label, zener: !!o.vz, schottky: o.schottky }, ["A", "K"], { m: "diode", vf, vz: o.vz })
dio("1N4007 (1 kV Rectifier)", "1N4007", 0.75); dio("1N4148 (Small-Signal Diode)", "1N4148", 0.65); dio("1N4733 (5.1 V Zener)", "1N4733", 0.7, { vz: 5.1 })
dio("1N5817 (Schottky 20V)", "1N5817", 0.32, { schottky: true }); dio("1N5819 (Schottky 40V)", "1N5819", 0.36, { schottky: true }); dio("Diode (generic)", "D", 0.7)
const IC = "Instruments & converters"
add(A, IC, "Signal Generator", { k: "probe", label: "~ GEN" }, ["SIG", "GND"], { m: "siggen" }, { attrs: { wave: "sine", freq: "1", amp: "1", offset: "2.5" }, settings: { wave: ["sine", "square", "triangle"], freq: "number", amp: "number", offset: "number" } })
add(A, IC, "DC Voltmeter", { k: "probe", label: "V" }, ["V+", "V-"], { m: "probe", kind: "V" })
add(A, IC, "DC Ammeter", { k: "probe", label: "A" }, ["A+", "A-"], { m: "probe", kind: "A" })
add(A, IC, "MCP3008 8-Channel 10-bit ADC (SPI)", { k: "dip", label: "MCP3008" }, ["CH0", "CH1", "CH2", "CH3", "CH4", "CH5", "CH6", "CH7", "DGND", "CS", "DIN", "DOUT", "CLK", "AGND", "VREF", "VDD"], { m: "proto", kind: "mcp3008" })
const OA = "Op-amps & comparators"
const opamp = (title: string, label: string) => add(A, OA, title, { k: "to92", label }, ["IN+", "IN-", "OUT"], { m: "opamp", count: 1 })
opamp("Ideal Op-Amp", "OPAMP"); opamp("LM324 (Quad Op-Amp)", "LM324"); opamp("LM358 (Dual Op-Amp)", "LM358"); opamp("LM741 (Op-Amp)", "LM741"); opamp("TL072 (JFET Op-Amp)", "TL072")
add(A, OA, "LM317 (Adjustable Regulator)", { k: "to220", label: "LM317" }, ["ADJ", "OUT", "IN"], { m: "regulator", v: 1.25, adj: true })
const PR = "Power & regulators"
add(A, PR, "7805 (+5V Regulator)", { k: "to220", label: "7805" }, ["IN", "GND", "OUT"], { m: "regulator", v: 5 })
add(A, PR, "7812 (+12V Regulator)", { k: "to220", label: "7812" }, ["IN", "GND", "OUT"], { m: "regulator", v: 12 })
add(A, PR, "7905 (−5V Regulator)", { k: "to220", label: "7905" }, ["GND", "IN", "OUT"], { m: "regulator", v: -5 })
add(A, PR, "9V Battery", { k: "battery", label: "9V", v: 9 }, ["+", "-"], { m: "battery", v: 9, r: 1.5 })
add(A, PR, "AA Battery (1.5V)", { k: "battery", label: "AA", v: 1.5 }, ["+", "-"], { m: "battery", v: 1.5, r: 0.15 })
add(A, PR, "Coin Cell (CR2032, 3V)", { k: "battery", label: "CR2032", v: 3 }, ["+", "-"], { m: "battery", v: 3, r: 15 })
add(A, PR, "Regulated Power Supply", { k: "probe", label: "PSU" }, ["+", "-"], { m: "supply" }, { attrs: { voltage: "12" }, settings: { voltage: "number" } })
const TR = "Transistors & MOSFETs"
const bjt = (title: string, label: string, beta: number, pnp = false, big = false) => add(A, TR, title, big ? { k: "to220", label } : { k: "to92", label }, ["E", "B", "C"], { m: "bjt", beta, pnp })
const fet = (title: string, label: string, vth: number, ron: number, p = false, big = true) => add(A, TR, title, big ? { k: "to220", label } : { k: "to92", label }, big ? ["G", "D", "S"] : ["S", "G", "D"], { m: "fet", vth, ron, p })
bjt("2N2222 (NPN)", "2N2222", 150); bjt("2N3055 (NPN Power)", "2N3055", 40, false, true); bjt("2N3906 (PNP)", "2N3906", 150, true); bjt("BC547 (NPN)", "BC547", 200); bjt("BC557 (PNP)", "BC557", 200, true)
fet("2N7000 (N-MOSFET)", "2N7000", 2.1, 2, false, false); fet("IRF540 (N-MOSFET Power)", "IRF540", 4, 0.077); fet("IRF9540 (P-MOSFET)", "IRF9540", 4, 0.2, true); fet("FQP27P06 (P-MOSFET)", "FQP27P06", 4, 0.07, true)
add(A, TR, "4N25 (Optocoupler)", { k: "dip", label: "4N25" }, ["A", "K", "E", "C"], { m: "opto", ctr: 0.2 })
add(A, "Other analog", "PC817 (Optocoupler)", { k: "dip", label: "PC817" }, ["A", "K", "E", "C"], { m: "opto", ctr: 1 })

// ── Logic ──────────────────────────────────────────────────────────────────────────────────
const L = "Logic Gates"
const ic74 = (n: string, fn: "nand" | "nor" | "not" | "and" | "or" | "xor", what: string, schmitt = false) =>
  add(L, "74xx logic ICs", `74HC${n} (${what})`, { k: "dip", label: `74HC${n}` }, ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14"], { m: "ic74", fn }, { tags: schmitt ? "schmitt" : undefined })
ic74("00", "nand", "Quad 2-input NAND"); ic74("02", "nor", "Quad 2-input NOR"); ic74("04", "not", "Hex Inverter"); ic74("08", "and", "Quad 2-input AND")
ic74("14", "not", "Hex Schmitt Inverter", true); ic74("32", "or", "Quad 2-input OR"); ic74("86", "xor", "Quad 2-input XOR")
add(L, "Flip-flops", "D Flip-Flop", { k: "ff", label: "D" }, ["D", "CLK", "Q", "QN"], { m: "ff", kind: "D" })
add(L, "Flip-flops", "JK Flip-Flop", { k: "ff", label: "JK" }, ["J", "K", "CLK", "Q", "QN"], { m: "ff", kind: "JK" })
add(L, "Flip-flops", "T Flip-Flop", { k: "ff", label: "T" }, ["T", "CLK", "Q", "QN"], { m: "ff", kind: "T" })
const gate = (fn: "and" | "or" | "nand" | "nor" | "xor" | "xnor" | "not", n: number) => {
  const ins = fn === "not" ? ["A"] : ["A", "B", "C", "D"].slice(0, n)
  const name = fn === "not" ? "NOT Gate (Inverter)" : `${fn.toUpperCase()} Gate${n > 2 ? ` (${n}-input)` : ""}`
  add(L, "Logic gates", name, { k: "gate", fn, inputs: ins.length }, [...ins, "Y"], { m: "gate", fn, inputs: ins.length })
}
for (const fn of ["and", "nand", "or", "nor"] as const) for (const n of [2, 3, 4]) gate(fn, n)
gate("xor", 2); gate("xnor", 2); gate("not", 1)

// the families' models (catalog/models/*.parts.ts) bring parts that were drawn only to life
for (const p of parts) {
  const x = PATCHES[p.type]
  if (!x) continue
  Object.assign(p, {
    model: x.model, ...(x.look ? { look: x.look } : {}), ...(x.pins ? { pins: x.pins } : {}),
    ...(x.attrs ? { attrs: { ...p.attrs, ...x.attrs } } : {}), ...(x.settings ? { settings: { ...p.settings, ...x.settings } } : {}),
  })
  if (x.attrs) p.attrs = { ...p.attrs, ...x.attrs }
  if (x.settings) p.settings = { ...p.settings, ...x.settings }
  p.hint = x.hint ?? describe(x.model, p.pins)
}

export const CATALOG: CatalogPart[] = parts
