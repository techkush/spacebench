// The parts that can go on a microcontroller canvas. Each is a wokwi-elements web component
// (drawn by its tag, with pin positions from its `pinInfo`); `attrs` are diagram.json defaults.

import { CATALOG, GROUPS, controlsOf, simulated, type CatalogPart, type Ctl, type Group } from "./catalog"

export type PartCategory = Group

export interface PartInfo {
  type: string
  title: string
  category: PartCategory
  attrs?: Record<string, string>
  /** what it does, for the parts list */
  hint: string
  /** settings the Inspector shows: attr → options (or "number"/"text") */
  settings?: Record<string, string[] | "number" | "text" | "color">
  /** sub-category in the Add Component tree */
  sub?: string
  /** unique per entry (presets share a type) */
  key?: string
  /** false: placed and wired only; a string: why a board can't run */
  sim?: boolean
  noEmu?: string
  /** the catalogue entry behind it */
  cat?: CatalogPart
}

const LED_COLORS = ["red", "green", "blue", "yellow", "orange", "white", "purple"]

export const PARTS: PartInfo[] = [
  { type: "wokwi-arduino-uno", title: "Arduino Uno", category: "Boards", sub: "Arduino", hint: "ATmega328P, 16 MHz, 14 digital + 6 analog pins" },
  { type: "wokwi-arduino-nano", title: "Arduino Nano", category: "Boards", sub: "Arduino", hint: "ATmega328P in a breadboard-friendly package, 8 analog pins" },
  { type: "wokwi-arduino-mega", title: "Arduino Mega 2560", category: "Boards", sub: "Arduino", hint: "ATmega2560, 54 digital + 16 analog pins, 6 timers" },
  { type: "wokwi-esp32-devkit-v1", title: "ESP32 DevKit V1", category: "Boards", sub: "ESP32", hint: "ESP32 (Xtensa, 240 MHz), 3.3 V — runs on Espressif's QEMU; GPIO, ADC and Serial" },
  { type: "wokwi-pi-pico", title: "Raspberry Pi Pico", category: "Boards", sub: "Raspberry Pi", hint: "RP2040, 133 MHz dual Cortex-M0+, 3.3 V, 26 GPIO, 3 ADC, PIO" },

  { type: "wokwi-led", title: "LED", category: "Output", sub: "LEDs & addressable pixels", attrs: { color: "red" }, hint: "lights with current from A (anode) to C (cathode); add a resistor", settings: { color: LED_COLORS } },
  { type: "wokwi-rgb-led", title: "RGB LED", category: "Output", sub: "LEDs & addressable pixels", attrs: { common: "cathode" }, hint: "three LEDs with a common pin", settings: { common: ["cathode", "anode"] } },
  { type: "wokwi-buzzer", title: "Buzzer", category: "Output", sub: "Buzzers & speakers", hint: "plays tone() through the computer's speakers" },
  { type: "wokwi-servo", title: "Servo motor", category: "Motors", sub: "Motors, servos & fans", hint: "angle from the PWM pulse width (Servo library)" },
  { type: "wokwi-led-bar-graph", title: "LED bar graph", category: "Output", sub: "LEDs & addressable pixels", attrs: { color: "lime" }, hint: "ten LEDs, A1–A10 to C1–C10" },
  { type: "wokwi-neopixel", title: "NeoPixel (WS2812)", category: "Output", sub: "LEDs & addressable pixels", hint: "addressable RGB LED on DIN (Adafruit_NeoPixel)" },

  { type: "wokwi-pushbutton", title: "Pushbutton", category: "Input", sub: "Buttons & switches", attrs: { color: "green" }, hint: "connects 1 and 2 while pressed (click or hold)", settings: { color: ["red", "green", "blue", "yellow", "black", "white"] } },
  { type: "wokwi-slide-switch", title: "Slide switch", category: "Input", sub: "Buttons & switches", hint: "connects 2 to 1 or to 3" },
  { type: "wokwi-potentiometer", title: "Potentiometer", category: "Input", sub: "Knobs, encoders & joysticks", attrs: { value: "512" }, hint: "10 kΩ; drag the knob — SIG between GND and VCC" },
  { type: "wokwi-slide-potentiometer", title: "Slide potentiometer", category: "Input", sub: "Knobs, encoders & joysticks", attrs: { travelLength: "30", value: "50" }, hint: "10 kΩ slider" },
  { type: "wokwi-analog-joystick", title: "Analog joystick", category: "Input", sub: "Knobs, encoders & joysticks", hint: "HORZ/VERT voltages, SEL to GND when pressed" },
  { type: "wokwi-dip-switch-8", title: "DIP switch (8)", category: "Input", sub: "Buttons & switches", hint: "eight switches, Na to Nb" },

  { type: "wokwi-ntc-temperature-sensor", title: "NTC temperature sensor", category: "Sensors", sub: "Temperature & humidity", attrs: { temperature: "24" }, hint: "10 kΩ NTC divider (β 3950) on OUT", settings: { temperature: "number" } },
  { type: "wokwi-photoresistor-sensor", title: "Photoresistor (LDR)", category: "Sensors", sub: "Light & colour", attrs: { lux: "500" }, hint: "light level on AO, threshold on DO", settings: { lux: "number" } },
  { type: "wokwi-pir-motion-sensor", title: "PIR motion sensor", category: "Sensors", sub: "Presence & vibration", hint: "OUT high for 5 s after motion (click it)" },
  { type: "wokwi-tilt-switch", title: "Tilt switch", category: "Sensors", sub: "Presence & vibration", hint: "OUT high when tilted (click it)" },
  { type: "wokwi-hc-sr04", title: "Ultrasonic distance (HC-SR04)", category: "Sensors", sub: "Distance & proximity", attrs: { distance: "100" }, hint: "TRIG pulse → ECHO pulse of 58 µs per cm", settings: { distance: "number" } },
  { type: "wokwi-dht22", title: "Temperature & humidity (DHT22)", category: "Sensors", sub: "Temperature & humidity", attrs: { temperature: "24", humidity: "40" }, hint: "one-wire on SDA (DHT library)", settings: { temperature: "number", humidity: "number" } },

  { type: "wokwi-lcd1602", title: "LCD 16×2", category: "Displays", sub: "Character LCD", attrs: { pins: "i2c" }, hint: "HD44780 — I²C backpack at 0x27, or the full parallel pins", settings: { pins: ["i2c", "full"] } },
  { type: "wokwi-lcd2004", title: "LCD 20×4", category: "Displays", sub: "Character LCD", attrs: { pins: "i2c" }, hint: "HD44780 20×4 — I²C at 0x27 or parallel", settings: { pins: ["i2c", "full"] } },
  { type: "wokwi-ssd1306", title: "OLED 128×64 (SSD1306)", category: "Displays", sub: "OLED", hint: "I²C at 0x3C (Adafruit_SSD1306)" },
  { type: "wokwi-7segment", title: "7-segment display", category: "Displays", sub: "LED matrix & segment", attrs: { common: "cathode", digits: "1" }, hint: "segments A–G, DP; common cathode or anode", settings: { common: ["cathode", "anode"], digits: ["1", "2", "3", "4"], color: "color" } },

  { type: "wokwi-breadboard-half", title: "Breadboard (half)", category: "Passive", sub: "Breadboards", hint: "30 columns + power rails; parts placed on its holes connect" },
  { type: "wokwi-breadboard", title: "Breadboard (full)", category: "Passive", sub: "Breadboards", hint: "63 columns + power rails" },
  { type: "wokwi-breadboard-mini", title: "Breadboard (mini)", category: "Passive", sub: "Breadboards", hint: "17 columns, no rails" },
  { type: "wokwi-resistor", title: "Resistor", category: "Passive", sub: "Resistors", attrs: { value: "220" }, hint: "value in ohms", settings: { value: "text" } },
]

for (const p of PARTS) { p.key = p.type; p.sim = true }
// the catalogue (catalog/data.ts): everything else, and presets of the parts above
const seen = new Set(PARTS.map((p) => p.type))
for (const c of CATALOG) {
  const key = seen.has(c.type) ? `${c.type}#${c.title}` : c.type
  seen.add(c.type)
  PARTS.push({ type: c.type, title: c.title, category: c.group, sub: c.sub, hint: c.hint, attrs: c.attrs, settings: c.settings, key, sim: simulated(c), noEmu: c.noEmu, cat: c })
}

export const partInfo = (type: string) => PARTS.find((p) => p.type === type)
export const CATEGORIES: PartCategory[] = GROUPS

/** Sliders shown while running (catalogue parts). */
export const catalogControls = (type: string): Ctl[] => { const c = partInfo(type)?.cat; return c ? controlsOf(c.model) : [] }

/** "220", "10k", "4.7k", "1M" → ohms */
export function ohms(text: string | undefined, fallback: number): number {
  if (!text) return fallback
  const m = /^\s*([\d.]+)\s*([kKmM]?)/.exec(text)
  if (!m) return fallback
  const n = parseFloat(m[1])
  return m[2] === "k" || m[2] === "K" ? n * 1e3 : m[2] === "M" ? n * 1e6 : m[2] === "m" ? n * 1e-3 : n
}
