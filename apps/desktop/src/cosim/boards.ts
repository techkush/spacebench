// Programmable boards in a schematic: which KiCad symbols run firmware, and what each of
// their pins is to the emulator (an I/O pin), to the circuit (a supply) or to both (ground).
import { boardByType, type BoardDef } from "@/mcu/boards"
import type { Doc, Part } from "@/editor/model"

/** KiCad symbol name → the emulated board it runs as. */
const SYMBOLS: [RegExp, string][] = [
  [/^MCU_Module:Arduino_UNO_R[23]$/, "wokwi-arduino-uno"],
  [/^MCU_Module:Arduino_Nano_v[23]\.x$/, "wokwi-arduino-nano"],
  [/^MCU_Module:RaspberryPi_Pico(_W)?$/, "wokwi-pi-pico"],
  // bare STM32 chips run on Renode as the board built around them
  [/^MCU_ST_STM32F4:STM32F407V(E|G|_E-G_)Tx$/, "sb-stm32f4-discovery"],
  [/^MCU_ST_STM32F1:STM32F103C8Tx$/, "sb-stm32-blue-pill"],
  [/^MCU_Microchip_ATtiny:ATtiny85V?-\d+[MPS]$/, "sb-attiny85"],
  // ESP32 modules run on Espressif's QEMU as the DevKit built around them
  [/^RF_Module:ESP32-WROOM-32/, "wokwi-esp32-devkit-v1"],
  [/^RF_Module:ESP32-S3-WROOM-1/, "sb-esp32-s3-devkitc-1"],
  [/^RF_Module:ESP32-C3-WROOM-02/, "sb-esp32-c3-devkitm-1"],
]

/**
 * Raspberry Pi 40-pin header symbols run Linux (src/linux/): the Value picks the model —
 * Raspberry_Pi_4 is a Pi 4B ("Pi 5" in the Value makes it a Pi 5), Raspberry_Pi_2_3 a Pi 3B+
 * ("Zero 2" makes it a Pi Zero 2 W).
 */
function linuxBoard(part: Pick<Part, "lib"> & { value?: string }): BoardDef | null {
  const v = (part.value ?? "").toLowerCase()
  if (part.lib === "Connector:Raspberry_Pi_4") return boardByType(/\b(pi\s*)?5\b/.test(v) ? "sb-raspberry-pi-5" : "sb-raspberry-pi-4") ?? null
  if (part.lib === "Connector:Raspberry_Pi_2_3") return boardByType(/zero/.test(v) ? "sb-raspberry-pi-zero-2w" : "sb-raspberry-pi-3") ?? null
  return null
}

/** The emulated board a schematic part runs as, or null when the part isn't programmable. */
export function boardOf(part: Pick<Part, "lib"> & { value?: string }): BoardDef | null {
  for (const [re, type] of SYMBOLS) if (re.test(part.lib)) return boardByType(type) ?? null
  return linuxBoard(part)
}

export const isProgrammable = (part: Pick<Part, "lib"> & { value?: string }) => boardOf(part) !== null

/** The programmable parts of a circuit, one per reference. */
export function boardParts(doc: Pick<Doc, "parts">): { part: Part; board: BoardDef }[] {
  const seen = new Set<string>()
  const out: { part: Part; board: BoardDef }[] = []
  for (const part of doc.parts) {
    const board = boardOf(part)
    if (!board || seen.has(part.ref)) continue
    seen.add(part.ref)
    out.push({ part, board })
  }
  return out
}

export type PinRole =
  /** a chip pin: driven by the firmware, read by it, or both */
  | { k: "io"; pin: string }
  /** a supply the board puts out (its regulator) */
  | { k: "supply"; volts: number }
  | { k: "gnd" }

/**
 * What a symbol pin is, from its KiCad name: "D13" → I/O pin "13", "SDA/A4" → "A4",
 * "GPIO26_ADC0" → "GP26", "+5V" → a 5 V supply, "GND" → ground. Pins the emulator doesn't
 * model (RESET, AREF, VIN, RUN …) give null and are left unconnected.
 */
export function pinRole(board: BoardDef, name: string): PinRole | null {
  const n = name.replace(/~\{([^}]*)\}/g, "$1").trim()
  if (/^A?GND$/i.test(n) || /^VSSA?$/.test(n)) return { k: "gnd" }
  if (/^\+?5V$/i.test(n) || n === "VBUS") return { k: "supply", volts: 5 }
  if (n === "VSYS") return { k: "supply", volts: 5 }
  if (/^\+?3V3$/i.test(n)) return { k: "supply", volts: 3.3 }
  if (n === "IOREF") return { k: "supply", volts: board.vcc }
  for (const part of n.split("/")) {
    // STM32 port pins: "PA0", "PD12"
    let m = /^P([A-K])(\d+)$/.exec(part)
    if (m && board.pins[`P${m[1]}${m[2]}`]) return { k: "io", pin: `P${m[1]}${m[2]}` }
    m = /^D(\d+)$/.exec(part)
    if (m && board.pins[m[1]]) return { k: "io", pin: m[1] }
    m = /^A(\d+)$/.exec(part)
    if (m && board.pins[`A${m[1]}`]) return { k: "io", pin: `A${m[1]}` }
    m = /^GPIO(\d+)/.exec(part)
    if (m && board.pins[`GP${m[1]}`]) return { k: "io", pin: `GP${m[1]}` }
    // the Pi 4 symbol zero-pads ("SDA_I2C1/GPIO02")
    if (m && board.pins[`GPIO${Number(m[1])}`]) return { k: "io", pin: `GPIO${Number(m[1])}` }
    // ESP32 modules: "IO2", "TXD0/IO1" — the board pin on that GPIO
    m = /^(?:IO|GPIO)(\d+)$/.exec(part)
    if (m) { const g = Number(m[1]); const pin = Object.entries(board.pins).find(([, bp]) => bp.bit === g)?.[0]; if (pin) return { k: "io", pin } }
  }
  return null
}

// ── what the firmware does to its pins during one co-simulation frame ───────────────────

/** A level over a frame: a constant, or steps — [t, value] means `value` from t (seconds) on. */
export type Wave = number | [number, number][]
/** One chip pin: the level it drives (V), whether it drives (1) or is an input (0), its pull resistors (0/1). */
export interface PinDrive { v: Wave; en: Wave; pu: Wave; pd: Wave }
/** chip pin name ("13", "A0", "GP15") → what it does */
export type BoardDrive = Map<string, PinDrive>

/** Output resistance of a driven pin (ATmega328P: ~25 Ω at 5 V), internal pull resistors, and a supply's source resistance. */
export const PIN_R = 25
export const PULLUP_R = 35e3
export const PULLDOWN_R = 50e3
export const SUPPLY_R = 0.05

/** A program to start from when a Linux board is placed. */
export function starterPython(board: BoardDef): string {
  return `# ${board.name} — this program runs on the board in the schematic (Linux, Python 3).
# gpiozero drives the GPIO pins; the circuit's voltages are what the inputs read.
from gpiozero import LED
from time import sleep

led = LED(17)          # GPIO17 = header pin 11

while True:
    led.toggle()
    print("LED", "on" if led.is_lit else "off")
    sleep(0.5)
`
}

/** A sketch to start from when a board is placed. */
export function starterSketch(board: BoardDef): string {
  if (board.chip === "linux") return starterPython(board)
  return `// ${board.name} — this sketch runs on the board in the schematic.
// Its pins drive the circuit, and the circuit's voltages are what it reads.

void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(500);
  digitalWrite(LED_BUILTIN, LOW);
  delay(500);
}
`
}
