// Microcontroller boards: how each board pin maps to a port bit of the chip, its ADC channel,
// the arduino-cli board name (FQBN) and the wokwi-elements tag that draws it.
//
// Pin names follow wokwi-elements (and Wokwi's diagram.json): "13", "A0", "GND.1", "5V" …
// Names with the same prefix before a dot are the same pin (GND.1 = GND.2, A4.2 = A4).

export type PortName = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "J" | "K" | "L"
/** AVR: a port bit; RP2040: `bit` is the GPIO number (no port). bit −1 = analog-only. */
export interface BoardPin { port?: PortName; bit: number; adc?: number }

export interface BoardDef {
  id: string
  /** wokwi diagram part type */
  type: string
  name: string
  chip: "atmega328p" | "atmega2560" | "attiny85" | "rp2040" | "esp32" | "linux" | "renode"
  fqbn: string
  /** logic supply: output high, pull-ups, ADC reference */
  vcc: number
  /** power pins and their volts (GND is 0 V) */
  power: Record<string, number>
  /** what the compiler hands the emulator */
  /** "python": a Linux board — the files are copied into the VM and main.py runs (no compiler) */
  firmware: "hex" | "bin" | "image" | "python" | "elf"
  /** extra arduino-cli build properties (the ESP32 bridge links with --wrap=ledcWrite) */
  buildProps?: string[]
  /** board-manager URL for its core, when it isn't in Arduino's own index */
  coreUrl?: string
  flash: number
  sram: number
  hz: number
  /** board pin name → port bit */
  pins: Record<string, BoardPin>
  /** board pin aliases (the I²C header on the Uno, SDA/SCL on the Mega) */
  alias: Record<string, string>
  /** the on-board "L" LED */
  led: string
  /** canvas size in px (for placing parts next to it) */
  size: { w: number; h: number }
  /** header pins in drawing order (boards drawn by the catalogue) */
  header?: string[]
  /** another maker's board on the same chip (the id of the board it's built like) */
  variantOf?: string
  /** ESP32 family member QEMU runs (-M …); absent = the classic ESP32 */
  esp?: "esp32s3" | "esp32c3"
  /** Linux boards: the Raspberry Pi model the VM identifies as (linux-guest/spacebench-identity) */
  linux?: "pi5" | "pi4" | "pi3" | "zero2w"
  /** Renode boards (src/renode/): the platform, its GPIO ports (register family + base) and the Serial UART */
  renode?: RenodeSpec
}

const p = (port: PortName, bit: number, adc?: number): BoardPin => (adc === undefined ? { port, bit } : { port, bit, adc })

function atmega328Pins(analog: number): Record<string, BoardPin> {
  const pins: Record<string, BoardPin> = {}
  for (let i = 0; i < 8; i++) pins[String(i)] = p("D", i)
  for (let i = 8; i < 14; i++) pins[String(i)] = p("B", i - 8)
  for (let i = 0; i < 6; i++) pins[`A${i}`] = p("C", i, i)
  // A6/A7 on the Nano are analog-only inputs (no port bit); bit -1 marks that
  for (let i = 6; i < analog; i++) pins[`A${i}`] = { port: "C", bit: -1, adc: i }
  return pins
}

function megaPins(): Record<string, BoardPin> {
  // from the Arduino core's variants/mega/pins_arduino.h
  const map: [PortName, number][] = [
    ["E", 0], ["E", 1], ["E", 4], ["E", 5], ["G", 5], ["E", 3], ["H", 3], ["H", 4], ["H", 5], ["H", 6], // 0-9
    ["B", 4], ["B", 5], ["B", 6], ["B", 7], ["J", 1], ["J", 0], ["H", 1], ["H", 0], ["D", 3], ["D", 2], // 10-19
    ["D", 1], ["D", 0], ["A", 0], ["A", 1], ["A", 2], ["A", 3], ["A", 4], ["A", 5], ["A", 6], ["A", 7], // 20-29
    ["C", 7], ["C", 6], ["C", 5], ["C", 4], ["C", 3], ["C", 2], ["C", 1], ["C", 0], ["D", 7], ["G", 2], // 30-39
    ["G", 1], ["G", 0], ["L", 7], ["L", 6], ["L", 5], ["L", 4], ["L", 3], ["L", 2], ["L", 1], ["L", 0], // 40-49
    ["B", 3], ["B", 2], ["B", 1], ["B", 0], // 50-53
  ]
  const pins: Record<string, BoardPin> = {}
  map.forEach(([port, bit], i) => { pins[String(i)] = p(port, bit) })
  for (let i = 0; i < 8; i++) pins[`A${i}`] = p("F", i, i)
  for (let i = 0; i < 8; i++) pins[`A${i + 8}`] = p("K", i, i + 8)
  return pins
}

export const BOARDS: BoardDef[] = [
  {
    id: "uno", type: "wokwi-arduino-uno", name: "Arduino Uno", chip: "atmega328p", fqbn: "arduino:avr:uno",
    vcc: 5, power: { "5V": 5, IOREF: 5, VIN: 5, "3.3V": 3.3 }, firmware: "hex", flash: 0x8000, sram: 0x800, hz: 16e6, pins: atmega328Pins(6), alias: { "A4.2": "A4", "A5.2": "A5" }, led: "13", size: { w: 274, h: 202 },
  },
  {
    id: "nano", type: "wokwi-arduino-nano", name: "Arduino Nano", chip: "atmega328p", fqbn: "arduino:avr:nano:cpu=atmega328",
    vcc: 5, power: { "5V": 5, IOREF: 5, VIN: 5, "3.3V": 3.3 }, firmware: "hex", flash: 0x8000, sram: 0x800, hz: 16e6, pins: atmega328Pins(8), alias: {}, led: "13", size: { w: 172, h: 67 },
  },
  {
    id: "mega", type: "wokwi-arduino-mega", name: "Arduino Mega 2560", chip: "atmega2560", fqbn: "arduino:avr:mega",
    vcc: 5, power: { "5V": 5, IOREF: 5, VIN: 5, "3.3V": 3.3 }, firmware: "hex", flash: 0x40000, sram: 0x2000, hz: 16e6, pins: megaPins(), alias: { SDA: "20", SCL: "21" }, led: "13", size: { w: 390, h: 202 },
  },
  {
    id: "pico", type: "wokwi-pi-pico", name: "Raspberry Pi Pico", chip: "rp2040", fqbn: "rp2040:rp2040:rpipico",
    vcc: 3.3, power: { VBUS: 5, VSYS: 5, "3V3": 3.3 }, firmware: "bin",
    coreUrl: "https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json",
    flash: 0x200000, sram: 0x40000, hz: 125e6, pins: picoPins(), alias: { LED: "GP25", AGND: "GND" }, led: "GP25", size: { w: 80, h: 193 },
  },
  {
    id: "esp32", type: "wokwi-esp32-devkit-v1", name: "ESP32 DevKit V1", chip: "esp32", fqbn: "esp32:esp32:esp32:FlashMode=dio",
    vcc: 3.3, power: { "3V3": 3.3, VIN: 5 }, firmware: "image", coreUrl: "https://espressif.github.io/arduino-esp32/package_esp32_index.json", buildProps: ["compiler.c.elf.extra_flags=-Wl,--wrap=ledc_channel_config,--wrap=ledc_timer_config,--wrap=ledc_set_duty"],
    flash: 0x400000, sram: 0x50000, hz: 240e6, pins: esp32Pins(), alias: {}, led: "D2", size: { w: 107, h: 191 },
  },
]

/** DevKit V1 header: Dn = GPIO n, RX0/TX0 = 3/1, RX2/TX2 = 16/17, VP/VN = 36/39. ADC: the GPIO number. */
function esp32Pins(): Record<string, BoardPin> {
  const adc = new Set([2, 4, 12, 13, 14, 15, 25, 26, 27, 32, 33, 34, 35, 36, 39])
  const pins: Record<string, BoardPin> = {}
  const add = (name: string, g: number) => { pins[name] = adc.has(g) ? { bit: g, adc: g } : { bit: g } }
  for (const g of [2, 4, 5, 12, 13, 14, 15, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33, 34, 35]) add(`D${g}`, g)
  add("RX0", 3); add("TX0", 1); add("RX2", 16); add("TX2", 17); add("VP", 36); add("VN", 39)
  return pins
}

function picoPins(): Record<string, BoardPin> {
  const pins: Record<string, BoardPin> = {}
  for (let i = 0; i <= 22; i++) pins[`GP${i}`] = { bit: i }
  pins.GP25 = { bit: 25 } // the on-board LED
  for (let i = 26; i <= 28; i++) pins[`GP${i}`] = { bit: i, adc: i - 26 }
  return pins
}

// ── variants: other makers' boards on the same chips ──────────────────────────────────────
const uno = BOARDS[0], nano = BOARDS[1], mega = BOARDS[2], pico = BOARDS[3], esp = BOARDS[4]
const variant = (base: BoardDef, o: Partial<BoardDef> & { id: string; type: string; name: string }): BoardDef => ({ ...base, ...o, variantOf: base.id })

/** ESP32 header pins named by their silkscreen, each a GPIO */
function espHeader(names: (string | [string, number])[]): { pins: Record<string, BoardPin>; header: string[] } {
  const adc = new Set([0, 2, 4, 12, 13, 14, 15, 25, 26, 27, 32, 33, 34, 35, 36, 39])
  const pins: Record<string, BoardPin> = {}
  const header: string[] = []
  for (const n of names) {
    const [name, g] = typeof n === "string" ? [n, Number.NaN] : n
    header.push(name)
    if (!Number.isNaN(g)) pins[name] = adc.has(g) ? { bit: g, adc: g } : { bit: g }
  }
  return { pins, header }
}
const devkitc = espHeader(["3V3", "EN", ["VP", 36], ["VN", 39], ["34", 34], ["35", 35], ["32", 32], ["33", 33], ["25", 25], ["26", 26], ["27", 27], ["14", 14], ["12", 12], "GND.1", ["13", 13], "D2", "D3", "CMD", "5V",
  "GND.2", ["23", 23], ["22", 22], ["TX", 1], ["RX", 3], ["21", 21], "GND.3", ["19", 19], ["18", 18], ["5", 5], ["17", 17], ["16", 16], ["4", 4], ["0", 0], ["2", 2], ["15", 15], "D1", "D0", "CLK"])
const espcam = espHeader(["5V", "GND", ["IO12", 12], ["IO13", 13], ["IO15", 15], ["IO14", 14], ["IO2", 2], ["IO4", 4], "3V3", ["IO16", 16], ["IO0", 0], "GND.2", "VCC", ["U0R", 3], ["U0T", 1], "GND.3"])
const lolin = espHeader(["3V3", "EN", ["36", 36], ["39", 39], ["32", 32], ["33", 33], ["34", 34], ["35", 35], ["25", 25], ["26", 26], ["27", 27], ["14", 14], ["12", 12], ["13", 13],
  ["15", 15], ["2", 2], ["0", 0], ["4", 4], ["16", 16], ["17", 17], ["5", 5], ["18", 18], ["23", 23], ["19", 19], ["22", 22], ["21", 21], "GND", "5V"])
const xiaoMap: [string, number][] = [["D0", 26], ["D1", 27], ["D2", 28], ["D3", 29], ["D4", 6], ["D5", 7], ["D6", 0], ["D7", 1], ["D8", 2], ["D9", 4], ["D10", 3]]
const xiaoPins: Record<string, BoardPin> = Object.fromEntries(xiaoMap.map(([n, g]) => [n, g >= 26 ? { bit: g, adc: g - 26 } : { bit: g }]))
xiaoPins.LED_B = { bit: 25 }; xiaoPins.LED_G = { bit: 16 }; xiaoPins.LED_R = { bit: 17 }
const drawn = (n: number, h = 90) => ({ w: Math.max(110, Math.ceil(n / 2) * 9.6 + 20), h })

BOARDS.push(
  variant(pico, { id: "picow", type: "sb-pi-pico-w", name: "Raspberry Pi Pico W" }),
  variant(BOARDS[4], { id: "devkitc", type: "sb-esp32-devkit-c-v4", name: "ESP32 DevKit C V4", pins: devkitc.pins, header: devkitc.header, led: "2", power: { "3V3": 3.3, "5V": 5 }, size: drawn(devkitc.header.length) }),
  variant(esp, { id: "esp32cam", type: "sb-esp32-cam", name: "ESP32-CAM", pins: espcam.pins, header: espcam.header, led: "IO4", power: { "3V3": 3.3, "5V": 5, VCC: 3.3 }, size: drawn(espcam.header.length, 100) }),
  variant(esp, { id: "lolin32", type: "sb-lolin32-lite", name: "Wemos Lolin32 Lite", pins: lolin.pins, header: lolin.header, led: "22", power: { "3V3": 3.3, "5V": 5 }, size: drawn(lolin.header.length) }),
  variant(pico, { id: "xiaorp2040", type: "sb-xiao-rp2040", name: "XIAO RP2040", fqbn: "rp2040:rp2040:seeed_xiao_rp2040", pins: xiaoPins, header: [...xiaoMap.map(([n]) => n), "5V", "GND", "3V3"], alias: {}, led: "LED_B", power: { "5V": 5, "3V3": 3.3 }, size: { w: 86, h: 106 } }),
  variant(uno, { id: "dfuno", type: "sb-dfrduino-uno", name: "DFRduino UNO R3" }),
  variant(nano, { id: "dfnano", type: "sb-dfrduino-nano", name: "DFRduino Nano" }),
  variant(mega, { id: "dfmega", type: "sb-dfrduino-mega", name: "DFRduino Mega2560" }),
  variant(uno, { id: "romeoble", type: "sb-romeo-ble", name: "Romeo BLE" }),
  variant(nano, { id: "beetleble", type: "sb-beetle-ble", name: "Beetle BLE", fqbn: "arduino:avr:uno" }),
  variant(nano, { id: "romeoblemini", type: "sb-romeo-ble-mini", name: "Romeo BLE mini", fqbn: "arduino:avr:uno" }),
)

// ── Linux boards: Raspberry Pi OS-compatible Linux in a VM (src/linux/), GPIO0–27 on the 40-pin header ──
/** The 40-pin header in physical order (pin 1 = 3V3 … pin 40 = GPIO21); repeated power pins get .n */
export const PI_HEADER = ["3V3.1", "5V.1", "GPIO2", "5V.2", "GPIO3", "GND.1", "GPIO4", "GPIO14", "GND.2", "GPIO15", "GPIO17", "GPIO18", "GPIO27", "GND.3", "GPIO22", "GPIO23", "3V3.2", "GPIO24", "GPIO10", "GND.4",
  "GPIO9", "GPIO25", "GPIO11", "GPIO8", "GND.5", "GPIO7", "GPIO0", "GPIO1", "GPIO5", "GND.6", "GPIO6", "GPIO12", "GPIO13", "GND.7", "GPIO19", "GPIO16", "GPIO26", "GPIO20", "GND.8", "GPIO21"]
const piGpio: Record<string, BoardPin> = Object.fromEntries(Array.from({ length: 28 }, (_, i) => [`GPIO${i}`, { bit: i }]))
const piAlias: Record<string, string> = Object.fromEntries(PI_HEADER.filter((n) => n.includes(".")).map((n) => [n, n.split(".")[0]]))
const linuxBoard = (id: string, name: string, linux: NonNullable<BoardDef["linux"]>, sram: number): BoardDef => ({
  id, type: id === "zero2w" ? "sb-raspberry-pi-zero-2w" : `sb-raspberry-${id.replace(/^pi/, "pi-")}`, name, chip: "linux", fqbn: "", vcc: 3.3, power: { "5V": 5, "3V3": 3.3 }, firmware: "python",
  flash: 0, sram, hz: 1e9, pins: piGpio, alias: piAlias, led: "", size: { w: 230, h: 150 }, header: PI_HEADER, linux,
})
BOARDS.push(
  { ...linuxBoard("pi5", "Raspberry Pi 5", "pi5", 4 * 2 ** 30), hz: 2.4e9 },
  { ...linuxBoard("pi4", "Raspberry Pi 4B", "pi4", 4 * 2 ** 30), hz: 1.8e9 },
  { ...linuxBoard("pi3", "Raspberry Pi 3B+", "pi3", 2 ** 30), hz: 1.4e9 },
  { ...linuxBoard("zero2w", "Raspberry Pi Zero 2 W", "zero2w", 0.5 * 2 ** 30), hz: 1e9 },
)
export const isLinuxBoard = (b: Pick<BoardDef, "chip"> | undefined | null) => b?.chip === "linux"

// ── Renode boards: STM32 / nRF52 firmware on Antmicro's Renode (src/renode/), ELF builds ──
export interface RenodeSpec {
  /** platform description, relative to Renode's folder */
  repl: string
  /** GPIO register layout (renode/sb_renode.py reads pin modes and pulls from it) */
  family: "stm32f4" | "stm32f1" | "nrf52"
  ports: { name: string; prefix: string; base: number }[]
  /** the UART Serial prints on, and others to capture */
  serial: string
  uarts: string[]
  /** files added to every sketch built for Renode (clock set-up the model lacks) */
  sources?: { name: string; content: string }[]
}
const STM32_URL = "https://github.com/stm32duino/BoardManagerFiles/raw/main/package_stmicroelectronics_index.json"
const stmPins = (letters: string) => Object.fromEntries([...letters].flatMap((c, k) => Array.from({ length: 16 }, (_, i) => [`P${c}${i}`, { bit: k * 16 + i }]))) as Record<string, BoardPin>
const F1_CLOCK = `// Space Bench (Renode): the STM32F1 model has no clock tree, so the PLL never "locks" and the
// default clock set-up would wait forever. Run on the 8 MHz internal oscillator the chip starts
// on; Space Bench sets the emulated SysTick to SystemCoreClock, so delay() and millis() stay right.
#include "Arduino.h"
extern "C" void SystemClock_Config(void) { SystemCoreClock = 8000000; }
`
const nanoBlePins: Record<string, BoardPin> = Object.fromEntries([
  ...Array.from({ length: 32 }, (_, i) => [`P0.${i}`, { bit: i }]),
  ...Array.from({ length: 16 }, (_, i) => [`P1.${i}`, { bit: 32 + i }]),
]) as Record<string, BoardPin>
const NANO_BLE_ALIAS: Record<string, string> = {
  D0: "P1.3", D1: "P1.10", D2: "P1.11", D3: "P1.12", D4: "P1.15", D5: "P1.13", D6: "P1.14", D7: "P0.23", D8: "P0.21", D9: "P0.27",
  D10: "P1.2", D11: "P1.1", D12: "P1.8", D13: "P0.13", A0: "P0.4", A1: "P0.5", A2: "P0.30", A3: "P0.29", A4: "P0.31", A5: "P0.2", A6: "P0.28", A7: "P0.3",
}
const renodeBoard = (o: Omit<BoardDef, "chip" | "firmware" | "flash" | "sram" | "hz" | "vcc" | "alias" | "size"> & Partial<BoardDef>): BoardDef =>
  ({ chip: "renode", firmware: "elf", flash: 0x100000, sram: 0x20000, hz: 1e9, vcc: 3.3, alias: {}, size: { w: 230, h: 110 }, ...o })
BOARDS.push(
  renodeBoard({
    id: "stm32f4disco", type: "sb-stm32f4-discovery", name: "STM32F4 Discovery", fqbn: "STMicroelectronics:stm32:Disco:pnum=DISCO_F407VG", coreUrl: STM32_URL, hz: 168e6,
    power: { "5V": 5, "3V3": 3.3 }, pins: stmPins("ABCDE"), led: "PD12",
    header: [..."ABCDE"].flatMap((c) => Array.from({ length: 16 }, (_, i) => `P${c}${i}`)).concat(["5V", "3V3", "GND"]),
    renode: { repl: "platforms/boards/stm32f4_discovery.repl", family: "stm32f4", ports: [..."ABCDE"].map((c, i) => ({ name: `gpioPort${c}`, prefix: `P${c}`, base: 0x40020000 + 0x400 * i })), serial: "usart2", uarts: ["usart2"] },
  }),
  renodeBoard({
    id: "bluepill", type: "sb-stm32-blue-pill", name: "STM32 Blue Pill (F103C8)", fqbn: "STMicroelectronics:stm32:GenF1:pnum=BLUEPILL_F103C8", coreUrl: STM32_URL, hz: 72e6,
    flash: 0x10000, sram: 0x5000, power: { "5V": 5, "3V3": 3.3 }, pins: stmPins("ABC"), led: "PC13",
    header: ["PB12", "PB13", "PB14", "PB15", "PA8", "PA9", "PA10", "PA11", "PA12", "PA15", "PB3", "PB4", "PB5", "PB6", "PB7", "PB8", "PB9", "5V", "GND", "3V3",
      "PB11", "PB10", "PB1", "PB0", "PA7", "PA6", "PA5", "PA4", "PA3", "PA2", "PA1", "PA0", "PC15", "PC14", "PC13"],
    renode: { repl: "platforms/cpus/stm32f103.repl", family: "stm32f1", ports: [..."ABC"].map((c, i) => ({ name: `gpioPort${c}`, prefix: `P${c}`, base: 0x40010800 + 0x400 * i })), serial: "usart1", uarts: ["usart1"], sources: [{ name: "sb_renode_clock.cpp", content: F1_CLOCK }] },
  }),
  renodeBoard({
    id: "nano33ble", type: "sb-arduino-nano-33-ble", name: "Arduino Nano 33 BLE", fqbn: "arduino:mbed_nano:nano33ble", hz: 64e6,
    power: { "3V3": 3.3, VIN: 5 }, pins: nanoBlePins, alias: NANO_BLE_ALIAS, led: "P0.13",
    header: ["D13", "3V3", "A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "VIN", "GND", "D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9", "D10", "D11", "D12"],
    renode: { repl: "platforms/boards/arduino_nano_33_ble.repl", family: "nrf52", ports: [{ name: "gpio0", prefix: "P0.", base: 0x50000500 }, { name: "gpio1", prefix: "P1.", base: 0x50000800 }], serial: "uart0", uarts: ["uart0"] },
  }),
)
export const isRenodeBoard = (b: Pick<BoardDef, "chip"> | undefined | null) => b?.chip === "renode"

// ── ESP32-S3 / ESP32-C3 on Espressif's QEMU (the bridge reports pins over UART1) ──
const espGpio = (gpios: number[], adc: number[]) => { const a = new Set(adc); return Object.fromEntries(gpios.map((g) => [String(g), a.has(g) ? { bit: g, adc: g } : { bit: g }])) as Record<string, BoardPin> }
const S3_GPIO = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48]
const C3_GPIO = Array.from({ length: 22 }, (_, i) => i)
const ESP_WRAP = "compiler.c.elf.extra_flags=-Wl,--wrap=ledc_channel_config,--wrap=ledc_timer_config,--wrap=ledc_set_duty"
BOARDS.push(
  {
    id: "esp32s3", type: "sb-esp32-s3-devkitc-1", name: "ESP32-S3 DevKitC-1", chip: "esp32", esp: "esp32s3", fqbn: "esp32:esp32:esp32s3:CDCOnBoot=default,PSRAM=disabled,FlashMode=dio",
    vcc: 3.3, power: { "3V3": 3.3, "5V": 5 }, firmware: "image", coreUrl: "https://espressif.github.io/arduino-esp32/package_esp32_index.json", buildProps: [ESP_WRAP],
    flash: 0x800000, sram: 0x80000, hz: 240e6, pins: espGpio(S3_GPIO, Array.from({ length: 20 }, (_, i) => i + 1)), alias: {}, led: "48", size: { w: 230, h: 110 },
    header: ["3V3", ...S3_GPIO.filter((g) => g < 22 || g > 34).map(String), "5V", "GND"],
  },
  {
    id: "esp32c3", type: "sb-esp32-c3-devkitm-1", name: "ESP32-C3 DevKitM-1", chip: "esp32", esp: "esp32c3", fqbn: "esp32:esp32:esp32c3:CDCOnBoot=default,FlashMode=dio",
    vcc: 3.3, power: { "3V3": 3.3, "5V": 5 }, firmware: "image", coreUrl: "https://espressif.github.io/arduino-esp32/package_esp32_index.json", buildProps: [ESP_WRAP],
    flash: 0x400000, sram: 0x60000, hz: 160e6, pins: espGpio(C3_GPIO, [0, 1, 2, 3, 4]), alias: {}, led: "8", size: { w: 200, h: 100 },
    header: ["3V3", ...C3_GPIO.map(String), "5V", "GND"],
  },
)

// ── ATtiny85 (ATTinyCore, 8 MHz internal) on avr8js: port B; ADC0–3 = PB5, PB2, PB4, PB3 ──
BOARDS.push({
  id: "attiny85", type: "sb-attiny85", name: "ATtiny85", chip: "attiny85", fqbn: "ATTinyCore:avr:attinyx5:chip=85,clock=8internal",
  coreUrl: "http://drazzy.com/package_drazzy.com_index.json", vcc: 5, power: { VCC: 5 }, firmware: "hex", flash: 0x2000, sram: 0x200, hz: 8e6,
  pins: { PB0: p("B", 0), PB1: p("B", 1), PB2: p("B", 2, 1), PB3: p("B", 3, 3), PB4: p("B", 4, 2), PB5: p("B", 5, 0) },
  alias: {}, led: "PB1", size: { w: 60, h: 60 }, header: ["PB5", "PB3", "PB4", "GND", "PB0", "PB1", "PB2", "VCC"],
})

export const boardById = (id: string) => BOARDS.find((b) => b.id === id)
export const boardByType = (type: string) => BOARDS.find((b) => b.type === type)
export const isBoardType = (type: string) => BOARDS.some((b) => b.type === type)

/** "GND.2" → "GND", "A4.2" → "A4" (through the board's aliases). */
export function canonicalPin(board: BoardDef | undefined, pin: string): string {
  if (board?.alias[pin]) return board.alias[pin]
  // a voltage ("3.3V", "1.8V") is a name, not a pin with a ".n" suffix
  if (/^\d+\.\d/.test(pin)) return pin
  const dot = pin.indexOf(".")
  return dot > 0 ? pin.slice(0, dot) : pin
}

export const POWER_PINS = new Set(["5V", "3.3V", "VIN", "IOREF", "VBUS", "VSYS", "3V3"])
export const GROUND_PINS = new Set(["GND"])
