// The AI assistant in the microcontroller workspace: it writes the sketch (or the Raspberry Pi's
// Python program) and the wiring diagram, compiles with arduino-cli, runs the emulator, reads the
// Serial Monitor and presses buttons / turns knobs — then fixes what it sees, including a
// computer that is missing a tool (it installs it once the user agrees).
import type { AgentProfile } from "@/lib/ai/agent"
import type { ToolDef } from "@/lib/ai/claude"
import { BOARDS } from "./boards"
import { parseDiagram } from "./diagram"
import { PARTS } from "./parts"

export interface McuAgentHost {
  project(): { name: string; board: string; files: { name: string; content: string }[]; diagram: string; lastCompile: string; serial: string; lastError: string }
  writeFile(name: string, content: string): string
  setDiagram(text: string): string
  compile(): Promise<{ ok: boolean; text: string }>
  run(seconds: number): Promise<string>
  stop(): string
  setInput(part: string, value: string): string
  /** what the project's boards need on this computer, and what is missing */
  checkSetup(): Promise<string>
  /** install a check_setup item — the user is asked first; ok false when they say no or it fails */
  install(item: string, reason: string): Promise<{ ok: boolean; text: string }>
  /** a shell command on the Linux board (Raspberry Pi); installs and sudo ask the user first */
  piShell(cmd: string, reason: string): Promise<{ ok: boolean; text: string }>
}

const PINS: Record<string, string> = {
  "wokwi-led": "A (anode, +), C (cathode, −)",
  "wokwi-rgb-led": "R, G, B, COM",
  "wokwi-resistor": "1, 2",
  "wokwi-pushbutton": "1.l, 1.r (same contact), 2.l, 2.r (same contact) — pressing joins 1 and 2",
  "wokwi-slide-switch": "1, 2 (common), 3",
  "wokwi-potentiometer": "GND, SIG, VCC",
  "wokwi-slide-potentiometer": "VCC, SIG, GND",
  "wokwi-buzzer": "1 (−), 2 (+)",
  "wokwi-servo": "GND, V+, PWM",
  "wokwi-led-bar-graph": "A1…A10 (anodes), C1…C10 (cathodes)",
  "wokwi-neopixel": "VDD, VSS, DIN, DOUT",
  "wokwi-analog-joystick": "VCC, VERT, HORZ, SEL, GND",
  "wokwi-dip-switch-8": "1a…8a, 1b…8b",
  "wokwi-ntc-temperature-sensor": "GND, VCC, OUT (analog)",
  "wokwi-photoresistor-sensor": "VCC, GND, DO (digital), AO (analog)",
  "wokwi-pir-motion-sensor": "VCC, OUT, GND",
  "wokwi-tilt-switch": "GND, VCC, OUT",
  "wokwi-hc-sr04": "VCC, TRIG, ECHO, GND",
  "wokwi-dht22": "VCC, SDA (data), NC, GND",
  "wokwi-lcd1602": "attrs.pins \"i2c\": GND, VCC, SDA, SCL (address 0x27) · attrs.pins \"full\": VSS, VDD, V0, RS, RW, E, D0…D7, A, K",
  "wokwi-lcd2004": "same as lcd1602",
  "wokwi-ssd1306": "GND, VIN, DATA (SDA), CLK (SCL), DC, RST, CS, 3V3 — I²C at 0x3C",
  "wokwi-7segment": "A…G, DP, COM.1/COM.2 (1 digit) or DIG1…DIG4 (attrs.digits); attrs.common cathode|anode",
}

const TOOLS: ToolDef[] = [
  { name: "get_project", description: "The program files, the wiring diagram (diagram.json), the board, the last compile result, the last error from running and the Serial Monitor's last output.", input_schema: { type: "object", properties: {} } },
  { name: "write_file", description: "Create or replace a program file: sketch.ino, extra .h / .cpp / .ino files and libraries.txt (one Arduino library per line, e.g. \"Servo\", \"LiquidCrystal I2C\", \"Adafruit NeoPixel\"); on a Raspberry Pi: main.py, other .py modules and requirements.txt.", input_schema: { type: "object", properties: { name: { type: "string" }, content: { type: "string" } }, required: ["name", "content"] } },
  { name: "set_diagram", description: "Replace the wiring diagram with a complete diagram.json (Wokwi format). The canvas redraws. Returns problems (unknown parts or pins) to fix.", input_schema: { type: "object", properties: { diagram: { type: "string", description: "diagram.json text" } }, required: ["diagram"] } },
  { name: "compile", description: "Compile the sketch with arduino-cli. Returns the errors (fix them and compile again) or the flash / RAM used.", input_schema: { type: "object", properties: {} } },
  { name: "run", description: "Compile if needed and run the emulator for a few seconds of real time; returns the Serial output, electrical warnings (missing resistors, overloaded pins) and what the outputs did (LEDs, servo angles, buzzer tones, LCD text).", input_schema: { type: "object", properties: { seconds: { type: "number", description: "1–10, default 3" } } } },
  { name: "stop", description: "Stop the emulator.", input_schema: { type: "object", properties: {} } },
  { name: "check_setup", description: "What this project's boards need on the computer (arduino-cli and the board core, QEMU and the Raspberry Pi system, Renode, Espressif's QEMU) and which of them are missing, with the id to install each one.", input_schema: { type: "object", properties: {} } },
  { name: "install", description: "Install a missing item from check_setup by its id (\"arduino-cli\", \"core:esp32:esp32\", \"qemu\", \"pi-system\", \"renode\", \"esp32-qemu\"). The user is asked to allow it first; if they decline, stop and tell them how to install it themselves.", input_schema: { type: "object", properties: { item: { type: "string" }, reason: { type: "string", description: "one short sentence for the user: why it is needed" } }, required: ["item", "reason"] } },
  { name: "pi_shell", description: "Raspberry Pi boards only: run a shell command on the Pi (Debian 13, user pi, sudo without a password) and get its output and exit code, e.g. \"pip list\", \"python3 -c 'import gpiozero'\" or \"pip install --break-system-packages requests\". Stops the running program first. Installing packages (pip, apt) or sudo asks the user first.", input_schema: { type: "object", properties: { cmd: { type: "string" }, reason: { type: "string", description: "one short sentence for the user: why" } }, required: ["cmd", "reason"] } },
  { name: "set_input", description: "While running: press / release a button (\"press\" / \"release\"), turn a potentiometer (0–1023 or \"50%\"), flip a slide switch (0/1), set a sensor (NTC °C, LDR lux, HC-SR04 cm, DHT22 °C), trigger a PIR (\"on\"/\"off\"). Catalogue sensors take their slider values as \"t=30, h=60\" (or a bare number for the first slider); Grove buttons \"press\"/\"release\".", input_schema: { type: "object", properties: { part: { type: "string", description: "part id, e.g. btn1, pot1" }, value: { type: "string" } }, required: ["part", "value"] } },
]

const LABELS: Record<string, string> = { get_project: "Read the project", write_file: "Wrote a file", set_diagram: "Wired the diagram", compile: "Compiled", run: "Ran the sketch", stop: "Stopped", set_input: "Input", check_setup: "Checked the setup", install: "Install", pi_shell: "Pi shell" }

function system(): string {
  const boards = BOARDS.filter((b) => !b.variantOf).map((b) => `- ${b.type} (${b.name}, FQBN ${b.fqbn}): pins ${Object.keys(b.pins).slice(0, 8).join(", ")}… plus 5V, 3.3V, VIN, GND.1/GND.2/GND.3`).join("\n")
  const parts = PARTS.filter((p) => p.category !== "Boards" && !p.cat).map((p) => `- ${p.type} — ${p.title}: pins ${PINS[p.type] ?? "see pinInfo"}${p.attrs ? `; attrs ${JSON.stringify(p.attrs)}` : ""}`).join("\n")
    + "\n" + PARTS.filter((p) => p.cat && p.sim && !p.cat.board && !p.key?.includes("#")).map((p) => `- ${p.type} — ${p.title}: pins ${p.cat!.pins.join(", ")}${p.cat!.model.m === "i2c" ? ` (I²C 0x${p.cat!.model.addr.toString(16)})` : ""}`).join("\n")
  return `You are the microcontroller assistant in Space Bench, a free, open-source desktop app for electronics. The user's project is a program plus a wiring diagram on a canvas, emulated in real time with an electrical solver around the chip (LED currents, pull-ups, voltage dividers). The real compiled firmware runs: Arduino UNO / Nano / Mega and ATtiny85 on avr8js, the Raspberry Pi Pico on rp2040js, ESP32 / S3 / C3 on Espressif's QEMU, STM32 boards and the Nano 33 BLE on Renode. Raspberry Pi 5 / 4B / 3B+ / Zero 2 W boards run real Linux (Debian 13 with Raspberry Pi's gpiozero, lgpio, rpi-lgpio) in a QEMU virtual machine.

Work like an engineer: read the project (get_project), write the program (write_file), wire the diagram (set_diagram), compile, run it, read the Serial output and the warnings, and fix problems until it works. Keep explanations short.

## Fixing problems
When the user reports that something doesn't work, or get_project shows a last error: find the cause and fix it — don't just explain it.
- Compile errors: fix the code, compile again.
- A tool or board system missing ("not installed", "not found", "isn't set up", "core is not installed"): call check_setup, then install each missing item it lists (the user is asked to allow it; say why in reason), then run again. Installs can take minutes — that's expected.
- "Is another process using the image" or a board that stopped: run again (Space Bench clears a stale virtual machine when it starts one).
- A Python ModuleNotFoundError on a Raspberry Pi: install the package with pi_shell ("pip install --break-system-packages <name>", or "sudo apt-get install -y python3-<name>"), add it to requirements.txt, run again.
- Finish by running the project and confirming it works (quote the Serial output).

## Raspberry Pi boards (Linux, Python)
- The program is main.py (Python 3), run with "python3 main.py" in /home/pi; print() goes to the Serial Monitor, input() reads the Serial input box. There is no sketch.ino and no compile step.
- Pins are BCM GPIO numbers: gpiozero LED(17), Button(27) (pull-up by default: wire the button from the pin to GND), PWMLED, lgpio and RPi.GPIO (rpi-lgpio) work too. In diagram.json the pins are "pi:GPIO17", "pi:GND.1", "pi:3V3.1", "pi:5V.1" (the board part's id may differ — read it from get_project).
- Not emulated: I²C / SPI / UART devices, hardware PWM, the camera and the desktop. Use plain GPIO.
## diagram.json (Wokwi format)
{ "version": 1, "author": "", "editor": "spacebench",
  "parts": [ { "type": "wokwi-arduino-uno", "id": "uno", "top": 0, "left": 0, "attrs": {} },
             { "type": "wokwi-led", "id": "led1", "top": -120, "left": 120, "attrs": { "color": "red" } } ],
  "connections": [ [ "uno:13", "r1:2", "green", [] ], [ "r1:1", "led1:A", "green", [] ], [ "led1:C", "uno:GND.1", "black", [] ] ] }
- Each connection is [ "part:pin", "part:pin", colour, [] ]. Colours: green, red (supply), black (ground), blue, orange, yellow, purple.
- Coordinates are pixels; the Uno is about 274 × 202 with its digital header along the top (y ≈ 9) and power/analog along the bottom (y ≈ 192). Put parts above or below the header they connect to, 40–60 px apart, so wires stay short.
- Every LED needs a series resistor (220–330 Ω); buttons use INPUT_PULLUP and connect to GND; I²C on the Uno is A4 (SDA) / A5 (SCL), on the Mega 20/21.
- rotate: 90 / 180 / 270 turns a part.

## Boards
${boards}

## Parts
${parts}

## Libraries
List every library the sketch #includes (except Wire, SPI, EEPROM, SoftwareSerial — built in) in libraries.txt, one per line, with the Arduino Library Manager name: Servo, LiquidCrystal, LiquidCrystal I2C, Adafruit SSD1306, Adafruit GFX Library, Adafruit NeoPixel, DHT sensor library, Adafruit Unified Sensor.
`
}

/** linux: the project's board is a Raspberry Pi (Python) — the chat's suggestions follow it */
export function mcuProfile(host: McuAgentHost, linux = false): AgentProfile {
  return {
    system,
    tools: TOOLS,
    labels: LABELS,
    intro: linux
      ? "Describe what the Raspberry Pi should do — “blink an LED while a button is held”, “a reaction-time game” — or ask about the program. The assistant writes the Python, wires the parts, installs packages (it asks first), runs it and checks the output."
      : "Describe a project — “a thermometer that shows °C on an LCD”, “a servo controlled by a knob” — or ask about the sketch. The assistant writes the code, wires the parts, compiles, runs it and checks the Serial output.",
    suggestions: linux ? [
      "Light an LED on GPIO17 while a button on GPIO27 is pressed",
      "Make a traffic light with gpiozero and print each state",
      "A reaction-time game: an LED, a button and the time in ms",
      "Why doesn't my program run?",
    ] : [
      "Make a traffic light with a pedestrian button",
      "Show the temperature from an NTC sensor on a 16×2 I²C LCD",
      "Control a servo with a potentiometer and print the angle",
      "Why doesn't my sketch compile?",
    ],
    placeholder: "Ask for a sketch, wiring, or a fix…",
    summarize: (name, input, result, ok) => {
      if (!ok) return result.split("\n")[0].slice(0, 160)
      if (name === "write_file") return String(input.name)
      if (name === "install") return String(input.item)
      if (name === "pi_shell") return String(input.cmd).slice(0, 120)
      return result.split("\n")[0].slice(0, 140)
    },
    async run(name, input) {
      switch (name) {
        case "get_project": {
          const p = host.project()
          return { ok: true, result: `Project: ${p.name}\nBoard: ${p.board}\n\n${p.files.map((f) => `--- ${f.name}\n${f.content}`).join("\n\n")}\n\n--- diagram.json\n${p.diagram}\n\nLast compile: ${p.lastCompile || "not compiled yet"}\n${p.lastError ? `\nLast error (running): ${p.lastError}\n` : ""}\nSerial (last output):\n${p.serial.slice(-1500) || "(nothing)"}` }
        }
        case "write_file": { const r = host.writeFile(String(input.name ?? ""), String(input.content ?? "")); return { ok: !r.startsWith("Not"), result: r } }
        case "set_diagram": {
          try { parseDiagram(String(input.diagram ?? "")) } catch (e) { return { ok: false, result: `Not valid diagram.json: ${e instanceof Error ? e.message : e}` } }
          const r = host.setDiagram(String(input.diagram))
          return { ok: !/^(Not|Problems)/.test(r), result: r }
        }
        case "compile": { const r = await host.compile(); return { ok: r.ok, result: r.text } }
        case "run": { const r = await host.run(Math.max(1, Math.min(10, Number(input.seconds ?? 3)))); return { ok: !/^(Not|Compile failed)/.test(r), result: r } }
        case "stop": return { ok: true, result: host.stop() }
        case "set_input": { const r = host.setInput(String(input.part ?? ""), String(input.value ?? "")); return { ok: !/^(No |Not)/.test(r), result: r } }
        case "check_setup": return { ok: true, result: await host.checkSetup() }
        case "install": { const r = await host.install(String(input.item ?? ""), String(input.reason ?? "")); return { ok: r.ok, result: r.text } }
        case "pi_shell": { const r = await host.piShell(String(input.cmd ?? ""), String(input.reason ?? "")); return { ok: r.ok, result: r.text } }
        default: return { ok: false, result: `Unknown tool ${name}` }
      }
    },
  }
}
