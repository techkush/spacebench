// Example circuits drawn with KiCad library symbols, on the integer grid.
// Wires are routed between pins with one orthogonal bend; symbols load first
// (pin positions come from the library), so examples build asynchronously.
import { ensureSymbols } from "@/lib/kicad"
import { pinPositions, uid, type Doc, type Part, type Pt, type Rot, type Wire } from "./model"
import { route } from "./ops"

type Anchor = string | Pt
type PartSpec = Omit<Part, "id" | "unit" | "rot"> & { unit?: number; rot?: Rot }
interface Spec extends Omit<Doc, "parts" | "wires"> {
  parts: PartSpec[]
  wires: { from: Anchor; to: Anchor; vfirst?: boolean }[]
}

function build(spec: Spec): Doc {
  const parts: Part[] = spec.parts.map((p) => ({ unit: 1, rot: 0, ...p, id: uid("p") }))
  const at = (a: Anchor): Pt => {
    if (Array.isArray(a)) return a
    const [ref, pin] = a.split(".")
    const [r, u] = ref.split("/")
    const part = parts.find((q) => q.ref === r && (!u || q.unit === Number(u)))
    const pos = part && pinPositions(part)[pin]
    if (!pos) throw new Error(`example: no pin ${a}`)
    return pos
  }
  const wires: Wire[] = []
  for (const w of spec.wires) {
    const path = route(at(w.from), at(w.to), w.vfirst)
    for (let i = 1; i < path.length; i++) wires.push({ id: uid("w"), a: path[i - 1], b: path[i] })
  }
  return { ...spec, parts, wires }
}

const pwrRef = (n: number) => `#PWR${String(n).padStart(2, "0")}`
const gnd = (n: number, x: number, y: number): PartSpec => ({ ref: pwrRef(n), lib: "power:GND", value: "GND", x, y })
const supply = (n: number, name: string, x: number, y: number): PartSpec => ({ ref: pwrRef(n), lib: `power:${name}`, value: name, x, y })
const label = (net: string, x: number, y: number): PartSpec => ({ ref: `#LBL_${net}_${x}`, lib: "@:label", value: "net", net, x, y })
const R = (ref: string, value: string, x: number, y: number, rot: Rot = 0): PartSpec => ({ ref, lib: "Device:R", value, x, y, rot })
const C = (ref: string, value: string, x: number, y: number, rot: Rot = 0): PartSpec => ({ ref, lib: "Device:C", value, x, y, rot })
const src = (ref: string, kind: "VSIN" | "VPULSE" | "VDC", params: string, x: number, y: number, rot: Rot = 0): PartSpec =>
  ({ ref, lib: `Simulation_SPICE:${kind}`, value: kind === "VDC" ? /dc=(\S+)/.exec(params)?.[1] ?? "5" : kind, x, y, rot, sim: kind === "VDC" ? undefined : { Params: params } })

const tran = (stop: number, step: number) => ({ stop, step })

interface Example { id: string; title: string; description: string; symbols: string[]; spec: () => Spec }
/** An example written in Kirk (laid out by the compiler); `firmware`: each board's sketch.ino, by reference. */
interface KirkExample { id: string; title: string; description: string; kirk: string; firmware?: Record<string, string>; firmwareName?: string }

/** Sensors and live controls: try them in the Room tab. */
export const KIRK_EXAMPLES: KirkExample[] = [
  {
    id: "pi-button-led", title: "Raspberry Pi LED + button",
    description: "A Raspberry Pi running Linux in the schematic: Python (gpiozero) lights the LED on GPIO17 while SW1 on GPIO27 is held. Press Run, then press SW1. Needs the Linux boards set up (Settings → Microcontrollers).",
    kirk: `@title("Raspberry Pi LED + button")
circuit PiButton {
    ground GND
    P1 = lib("Connector:Raspberry_Pi_4")
    R1 = R(330)
    D1 = LED("Green")
    SW1 = Button()
    P1.11 -- R1 -- A -- D1' -- GND
    P1.13 -- SW1 -- GND
    P1.6 -- GND
}

scope Scope1 {
    ch1 = V(A)
}

simulate tran(stop: 2 s, step: 1 ms)
`,
    firmware: {
      P1: `# Raspberry Pi in the schematic: GPIO17 (pin 11) lights the LED, GPIO27 (pin 13) reads SW1.
from gpiozero import LED, Button
from signal import pause

led = LED(17)
button = Button(27)  # internal pull-up: pressing SW1 connects GPIO27 to ground

def pressed():
    print("SW1 pressed - LED on")
    led.on()

def released():
    print("SW1 released - LED off")
    led.off()

button.when_pressed = pressed
button.when_released = released
print("Running on Raspberry Pi", led.pin_factory.board_info.model, "- press SW1 in the schematic")
pause()
`,
    },
  },
  {
    id: "arduino-pwm-dac", title: "Arduino PWM DAC",
    description: "Circuit and firmware together: the Uno sweeps PWM on D9, an RC low-pass turns it into a voltage, and the sketch reads it back on A0 and lights the LED above 2.5 V. Press Simulate (needs arduino-cli).",
    kirk: `@title("Arduino PWM DAC")
circuit PwmDac {
    ground GND
    A1 = lib("MCU_Module:Arduino_UNO_R3")
    R1 = R(10k)
    C1 = C(1u)
    R2 = R(220)
    D1 = LED("Red")
    A1.D9 -- R1 -- OUT -- C1 -- GND
    A1.A0 -- OUT
    A1.D13 -- R2 -- LED_A -- D1' -- GND
    A1.6 -- GND
}

scope Scope1 {
    ch1 = V(OUT)
}

simulate tran(stop: 2 s, step: 1 ms)
`,
    firmwareName: "sketch.ino",
    firmware: {
      A1: `// PWM DAC: pin 9's PWM through the RC low-pass (R1, C1) becomes a voltage,
// which the sketch reads back on A0. Edit the schematic or this code and press Run.
const int pwmPin = 9;
const int ledPin = 13;
int duty = 0;
int step = 5;

void setup() {
  Serial.begin(115200);
  pinMode(ledPin, OUTPUT);
}

void loop() {
  analogWrite(pwmPin, duty);
  delay(50);
  int raw = analogRead(A0);
  Serial.print("duty ");
  Serial.print(duty);
  Serial.print("  A0 = ");
  Serial.print(raw * 5.0 / 1023, 2);
  Serial.println(" V");
  digitalWrite(ledPin, raw > 512 ? HIGH : LOW);
  duty += step;
  if (duty >= 255 || duty <= 0) step = -step;
}
`,
    },
  },
  {
    id: "night-light", title: "Night light (LDR)",
    description: "An LDR and a 2N3904 switch the LED on as it gets dark: the feed dims the light from daylight to night over 20 ms. Open the Lab to feed other light.",
    kirk: `@title("Night light")
circuit NightLight {
    ground GND
    V1 = Vdc(5 V)
    R1 = R(10k)
    LDR1 = LDR()
    R2 = R(4.7k)
    Q1 = NPN("2N3904")
    R3 = R(220)
    D1 = LED("Green")
    VCC -- V1 -- GND
    VCC -- R1 -- S -- LDR1 -- GND
    S -- R2 -- B
    VCC -- R3 -- A -- D1' -- C
    Q1.C -- C
    Q1.B -- B
    Q1.E -- GND
}

stimulus {
    LDR1 = ramp(from: 10k lux, to: 0.1 lux, over: 20 ms)
}

simulate tran(stop: 20 ms, step: 20 us)
`,
  },
  {
    id: "thermostat", title: "Thermostat fan (NTC)",
    description: "A thermistor and a set-point knob on a comparator switch a fan on above about 25 °C. The feed lets the temperature drift at random; open the Lab to try others.",
    kirk: `@title("Thermostat fan")
circuit Thermostat {
    ground GND
    V1 = Vdc(12 V)
    R1 = R(10k)
    TH1 = Thermistor(10k)
    RV1 = Knob(10k, pos: 0.5)
    U1 = OpAmp()
    Q1 = NMOS("IRF540N")
    M1 = Motor()
    D1 = D("1N4001")
    VCC -- V1 -- GND
    VCC -- R1 -- S -- TH1 -- GND
    RV1.1 -- VCC
    RV1.3 -- GND
    RV1.2 -- SET
    U1.1 -- SET
    U1.2 -- S
    U1.3 -- VCC
    U1.4 -- GND
    U1.5 -- G
    Q1.G -- G
    Q1.S -- GND
    Q1.D -- FAN
    VCC -- M1 -- FAN
    FAN -- D1' -- VCC
}

stimulus {
    seed: 3
    TH1 = walk(start: 24°C, sd: 0.6°C, every: 0.5 ms, min: 15°C, max: 35°C)
}

simulate tran(stop: 40 ms, step: 40 us)
`,
  },
  {
    id: "dimmer", title: "LED dimmer (slider)",
    description: "A slider sets the base current of a 2N3904: the feed sweeps it from 0 to 1, so the LED brightens over 20 ms. Use − / + on RV1 or the Lab.",
    kirk: `@title("LED dimmer")
circuit Dimmer {
    ground GND
    V1 = Vdc(9 V)
    RV1 = Slider(10k, pos: 0.5)
    R1 = R(100k)
    Q1 = NPN("2N3904")
    R2 = R(330)
    D1 = LED("Red")
    VCC -- V1 -- GND
    RV1.1 -- GND
    RV1.3 -- VCC
    RV1.2 -- W
    W -- R1 -- B
    VCC -- R2 -- A -- D1' -- C
    Q1.C -- C
    Q1.B -- B
    Q1.E -- GND
}

stimulus {
    RV1 = ramp(from: 0, to: 1, over: 20 ms)
}

simulate tran(stop: 20 ms, step: 20 us)
`,
  },
]

const EXAMPLE_SPECS: Example[] = [
  {
    id: "rc-lowpass", title: "RC low-pass filter",
    description: "fc = 1/(2πRC) ≈ 995 Hz. Run AC for the Bode plot, or change R1 and watch fc move.",
    symbols: ["Simulation_SPICE:VPULSE", "Device:R", "Device:C", "power:GND"],
    spec: () => ({
      title: "RC low-pass filter", description: "",
      parts: [
        src("V1", "VPULSE", "y1=0 y2=1 td=0.1m tr=1u tf=1u tw=1m per=2m ac=1", 12, 20),
        R("R1", "1.6k", 20, 14, 90), C("C1", "100n", 30, 20),
        gnd(1, 12, 27), gnd(2, 30, 27), label("in", 14, 14), label("out", 27, 14),
      ],
      wires: [{ from: "V1.1", to: "R1.2", vfirst: true }, { from: "R1.1", to: "C1.1" }, { from: "V1.2", to: "#PWR01.1" }, { from: "C1.2", to: "#PWR02.1" }],
      analyses: { tran: tran(6e-3, 2e-6), ac: { start: 10, stop: 100e3 } }, defaultAnalysis: "ac", probes: ["V(in)", "V(out)"],
    }),
  },
  {
    id: "rlc-ringing", title: "RLC step response",
    description: "Underdamped series RLC: rings at ≈ 5 kHz and decays with α = R/2L.",
    symbols: ["Simulation_SPICE:VPULSE", "Device:R", "Device:L", "Device:C", "power:GND"],
    spec: () => ({
      title: "RLC step response", description: "",
      parts: [
        src("V1", "VPULSE", "y1=0 y2=1 td=50u tr=0.1u tf=0.1u tw=1 per=2 ac=1", 12, 20),
        R("R1", "10", 19, 14, 90), { ref: "L1", lib: "Device:L", value: "1m", x: 28, y: 14, rot: 90 }, C("C1", "1u", 38, 20),
        gnd(3, 12, 27), gnd(4, 38, 27), label("in", 14, 14), label("out", 35, 14),
      ],
      wires: [{ from: "V1.1", to: "R1.2", vfirst: true }, { from: "R1.1", to: "L1.2" }, { from: "L1.1", to: "C1.1" }, { from: "V1.2", to: "#PWR03.1" }, { from: "C1.2", to: "#PWR04.1" }],
      analyses: { tran: tran(1.2e-3, 0.5e-6), ac: { start: 100, stop: 100e3 } }, defaultAnalysis: "tran", probes: ["V(in)", "V(out)"],
    }),
  },
  {
    id: "half-wave", title: "Half-wave rectifier",
    description: "10 V 50 Hz sine → 1N4007 → 100 µF reservoir → 1 kΩ load. Watch the ripple.",
    symbols: ["Simulation_SPICE:VSIN", "Diode:1N4007", "Device:C", "Device:R", "power:GND"],
    spec: () => ({
      title: "Half-wave rectifier", description: "",
      parts: [
        src("V1", "VSIN", "dc=0 ampl=10 f=50", 12, 20),
        { ref: "D1", lib: "Diode:1N4007", value: "1N4007", x: 20, y: 14, rot: 180 }, C("C1", "100u", 30, 20), R("RL", "1k", 38, 20),
        gnd(5, 12, 27), gnd(6, 30, 27), gnd(7, 38, 27), label("in", 14, 14), label("out", 27, 14),
      ],
      wires: [{ from: "V1.1", to: "D1.2", vfirst: true }, { from: "D1.1", to: "C1.1" }, { from: [30, 14], to: "RL.1" }, { from: "V1.2", to: "#PWR05.1" }, { from: "C1.2", to: "#PWR06.1" }, { from: "RL.2", to: "#PWR07.1" }],
      analyses: { tran: tran(80e-3, 20e-6), ac: { start: 10, stop: 10e3 } }, defaultAnalysis: "tran", probes: ["V(in)", "V(out)"],
    }),
  },
  {
    id: "led", title: "LED with series resistor",
    description: "5 V → 220 Ω → red LED. The operating point shows the LED current (≈ 14 mA).",
    symbols: ["Simulation_SPICE:VDC", "Device:R", "Device:LED", "power:GND"],
    spec: () => ({
      title: "LED with series resistor", description: "",
      parts: [
        src("V1", "VDC", "dc=5", 12, 20), R("R1", "220", 20, 14, 90), { ref: "D1", lib: "Device:LED", value: "Red", x: 30, y: 20, rot: 270 },
        gnd(8, 12, 27), gnd(9, 30, 27), label("vcc", 14, 14), label("a", 27, 14),
      ],
      wires: [{ from: "V1.1", to: "R1.2", vfirst: true }, { from: "R1.1", to: "D1.2" }, { from: "V1.2", to: "#PWR08.1" }, { from: "D1.1", to: "#PWR09.1" }],
      analyses: { tran: tran(1e-3, 1e-6), ac: { start: 10, stop: 100e3 } }, defaultAnalysis: "op", probes: ["V(vcc)", "V(a)"],
    }),
  },
  {
    id: "ce-amp", title: "2N3904 common-emitter amplifier",
    description: "Voltage-divider bias, RC = 4.7 kΩ, RE = 1 kΩ: an inverting gain of about −3 at 1 kHz.",
    symbols: ["Simulation_SPICE:VSIN", "Simulation_SPICE:VDC", "Transistor_BJT:2N3904", "Device:R", "Device:C", "power:GND", "power:+12V"],
    spec: () => ({
      title: "2N3904 common-emitter amplifier", description: "",
      parts: [
        src("V2", "VDC", "dc=12", 6, 20), supply(10, "+12V", 6, 14), gnd(11, 6, 27),
        src("V1", "VSIN", "dc=0 ampl=0.2 f=1k ac=1", 16, 28), gnd(12, 16, 35),
        C("C1", "10u", 24, 22, 90), R("R1", "47k", 32, 14), R("R2", "10k", 32, 30), gnd(13, 32, 36),
        { ref: "Q1", lib: "Transistor_BJT:2N3904", value: "2N3904", x: 40, y: 22 },
        R("RC", "4.7k", 42, 12), R("RE", "1k", 42, 30), gnd(14, 42, 36), supply(15, "+12V", 32, 7),
        C("C2", "10u", 48, 18, 90), R("RL", "10k", 56, 24), gnd(16, 56, 30),
        label("in", 18, 22), label("out", 54, 18),
      ],
      wires: [
        { from: "#PWR10.1", to: "V2.1" }, { from: "V2.2", to: "#PWR11.1" }, { from: "V1.2", to: "#PWR12.1" },
        { from: "V1.1", to: "C1.2", vfirst: true }, { from: "C1.1", to: [32, 22] },
        { from: "R1.2", to: "R2.1" }, { from: "Q1.2", to: [32, 22] }, { from: "R2.2", to: "#PWR13.1" },
        { from: "#PWR15.1", to: "R1.1" }, { from: [32, 9], to: "RC.1" },
        { from: "RC.2", to: "Q1.3" }, { from: "Q1.1", to: "RE.1" }, { from: "RE.2", to: "#PWR14.1" },
        { from: "Q1.3", to: "C2.2" }, { from: "C2.1", to: "RL.1" }, { from: "RL.2", to: "#PWR16.1" },
      ],
      analyses: { tran: tran(4e-3, 4e-6), ac: { start: 10, stop: 10e6 } }, defaultAnalysis: "tran", probes: ["V(in)", "V(out)"],
    }),
  },
  {
    id: "opamp-inv", title: "LM358 inverting amplifier",
    description: "Gain = −Rf/Rin = −10 on ±12 V rails. Raise the input past ±1.2 V to see the output clip.",
    symbols: ["Simulation_SPICE:VSIN", "Simulation_SPICE:VDC", "Amplifier_Operational:LM358", "Device:R", "power:GND", "power:+12V", "power:-12V"],
    spec: () => ({
      title: "LM358 inverting amplifier", description: "",
      parts: [
        src("V1", "VSIN", "dc=0 ampl=0.5 f=1k ac=1", 14, 26), gnd(17, 14, 33),
        R("RIN", "10k", 24, 22, 90),
        { ref: "U1", lib: "Amplifier_Operational:LM358", value: "LM358", x: 40, y: 20, unit: 1 },
        { ref: "U1", lib: "Amplifier_Operational:LM358", value: "LM358", x: 40, y: 40, unit: 3 },
        gnd(18, 30, 21), R("RF", "100k", 40, 27, 90), R("RL", "10k", 52, 24), gnd(19, 52, 30),
        supply(20, "+12V", 38, 31), supply(21, "-12V", 38, 49),
        src("V2", "VDC", "dc=12", 66, 20), supply(22, "+12V", 66, 14), gnd(23, 66, 27),
        src("V3", "VDC", "dc=12", 76, 20, 180), supply(24, "-12V", 76, 14), gnd(25, 76, 27),
        label("in", 17, 22), label("out", 49, 20),
      ],
      wires: [
        { from: "V1.1", to: "RIN.2", vfirst: true }, { from: "V1.2", to: "#PWR17.1" },
        { from: "RIN.1", to: "U1/1.2" }, { from: "U1/1.3", to: "#PWR18.1" },
        { from: "RF.2", to: "U1/1.2" }, { from: "RF.1", to: "U1/1.1" },
        { from: "U1/1.1", to: "RL.1" }, { from: "RL.2", to: "#PWR19.1" },
        { from: "#PWR20.1", to: "U1/3.8" }, { from: "U1/3.4", to: "#PWR21.1" },
        { from: "#PWR22.1", to: "V2.1" }, { from: "V2.2", to: "#PWR23.1" },
        { from: "#PWR24.1", to: "V3.2" }, { from: "V3.1", to: "#PWR25.1" },
      ],
      analyses: { tran: tran(3e-3, 2e-6), ac: { start: 10, stop: 1e6 } }, defaultAnalysis: "tran", probes: ["V(in)", "V(out)"],
    }),
  },
  {
    id: "555-astable", title: "NE555 LED blinker",
    description: "Astable 555: f = 1.44/((Ra + 2Rb)·C) ≈ 69 Hz with Ra = 1 kΩ, Rb = 10 kΩ, C = 1 µF.",
    symbols: ["Simulation_SPICE:VDC", "Timer:NE555P", "Device:R", "Device:C", "Device:LED", "power:GND", "power:+5V"],
    spec: () => ({
      title: "NE555 LED blinker", description: "",
      parts: [
        src("V1", "VDC", "dc=5", 12, 24), supply(26, "+5V", 12, 18), gnd(27, 12, 31),
        supply(28, "+5V", 26, 9), R("RA", "1k", 26, 16), R("RB", "10k", 26, 25), C("C1", "1u", 26, 34), gnd(29, 26, 40),
        { ref: "U1", lib: "Timer:NE555P", value: "NE555P", x: 40, y: 24 }, gnd(30, 40, 35),
        R("R3", "330", 52, 28), { ref: "D1", lib: "Device:LED", value: "Red", x: 52, y: 36, rot: 270 }, gnd(31, 52, 42),
        label("trig", 29, 28), label("out", 50, 24),
      ],
      wires: [
        { from: "#PWR26.1", to: "V1.1" }, { from: "V1.2", to: "#PWR27.1" },
        { from: "#PWR28.1", to: "RA.1" }, { from: [26, 11], to: "U1.8" },
        { from: "RA.2", to: "RB.1" }, { from: "U1.7", to: "RB.1" },
        { from: "RB.2", to: "C1.1" }, { from: "U1.2", to: "RB.2" }, { from: "U1.6", to: [30, 28] },
        { from: "U1.4", to: [30, 11], vfirst: false }, { from: "C1.2", to: "#PWR29.1" },
        { from: "U1.1", to: "#PWR30.1" },
        { from: "U1.3", to: "R3.1" }, { from: "R3.2", to: "D1.2" }, { from: "D1.1", to: "#PWR31.1" },
      ],
      analyses: { tran: tran(60e-3, 10e-6), ac: { start: 10, stop: 100e3 } }, defaultAnalysis: "tran", probes: ["V(trig)", "V(out)"],
    }),
  },
  {
    id: "7805", title: "L7805 regulator",
    description: "12 V ± 3 V ripple in → 5 V out into 100 Ω. The regulator rejects the ripple.",
    symbols: ["Simulation_SPICE:VSIN", "Regulator_Linear:L7805", "Device:R", "power:GND"],
    spec: () => ({
      title: "L7805 regulator", description: "",
      parts: [
        src("V1", "VSIN", "dc=12 ampl=3 f=100", 12, 24), gnd(32, 12, 31),
        { ref: "U1", lib: "Regulator_Linear:L7805", value: "L7805", x: 30, y: 20 }, gnd(33, 30, 29),
        R("RL", "100", 42, 24), gnd(34, 42, 30), label("vin", 18, 20), label("vout", 39, 20),
      ],
      wires: [
        { from: "V1.1", to: "U1.1", vfirst: true }, { from: "V1.2", to: "#PWR32.1" }, { from: "U1.2", to: "#PWR33.1" },
        { from: "U1.3", to: "RL.1" }, { from: "RL.2", to: "#PWR34.1" },
      ],
      analyses: { tran: tran(40e-3, 20e-6), ac: { start: 10, stop: 100e3 } }, defaultAnalysis: "tran", probes: ["V(vin)", "V(vout)"],
    }),
  },
]

export const EXAMPLE_CATEGORIES = ["Basics", "Filters", "Amplifiers", "Oscillators", "Power", "Sensors", "Microcontrollers"] as const
export type ExampleCategory = (typeof EXAMPLE_CATEGORIES)[number]
const CATEGORY: Record<string, ExampleCategory> = {
  "rc-lowpass": "Filters", "rlc-ringing": "Basics", "half-wave": "Power", led: "Basics", "ce-amp": "Amplifiers",
  "opamp-inv": "Amplifiers", "555-astable": "Oscillators", "7805": "Power",
  "night-light": "Sensors", thermostat: "Sensors", dimmer: "Sensors", "arduino-pwm-dac": "Microcontrollers", "pi-button-led": "Microcontrollers",
}
/** Main symbol of each example (its card icon). */
const ICON: Record<string, string> = {
  "rc-lowpass": "Device:C", "rlc-ringing": "Device:L", "half-wave": "Device:D", led: "Device:LED", "ce-amp": "Transistor_BJT:2N3904",
  "opamp-inv": "Amplifier_Operational:LM358", "555-astable": "Timer:NE555P", "7805": "Regulator_Linear:L7805",
  "night-light": "Device:R_Photo", thermostat: "Device:Thermistor_NTC", dimmer: "Device:R_Potentiometer",
  "arduino-pwm-dac": "MCU_Module:Arduino_UNO_R3", "pi-button-led": "Connector:Raspberry_Pi_4",
}
export const EXAMPLES = [...EXAMPLE_SPECS, ...KIRK_EXAMPLES].map(({ id, title, description }) => ({ id, title, description, category: CATEGORY[id] ?? "Basics", icon: ICON[id] ?? "Device:R" }))

/** Load an example's symbols and build its document. */
export async function loadExample(id: string): Promise<Doc> {
  const k = KIRK_EXAMPLES.find((e) => e.id === id)
  if (k) {
    const { compileKirk } = await import("@/kirk/compile")
    const r = await compileKirk(k.kirk)
    if (!r.doc) throw new Error(`example ${id}: ${r.diagnostics.map((d) => d.message).join("; ")}`)
    // a sketch for an Arduino, main.py for a Raspberry Pi
    const firmware = k.firmware && Object.fromEntries(Object.entries(k.firmware).map(([ref, content]) => [ref, { files: [{ name: k.firmwareName ?? (content.trimStart().startsWith("#") ? "main.py" : "sketch.ino"), content }] }]))
    return { ...r.doc, description: k.description, ...(firmware ? { firmware } : {}) }
  }
  const ex = EXAMPLE_SPECS.find((e) => e.id === id) ?? EXAMPLE_SPECS[0]
  await ensureSymbols(ex.symbols)
  const doc = build(ex.spec())
  return { ...doc, description: ex.description }
}
