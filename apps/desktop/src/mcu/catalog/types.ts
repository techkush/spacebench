// The parts catalogue: every part the microcontroller canvas offers beyond the hand-wired
// wokwi-elements ones. A part is data — what it is called, where it sits in the Add Component
// tree, how it is drawn (`look`), its pins, and how it behaves (`model`) — so one generic path
// draws, wires and simulates all of them.

export type Group =
  | "Boards" | "Sensors" | "Output" | "Displays" | "Input" | "Motors" | "Communication"
  | "Connectivity" | "Electromechanical" | "Other" | "Passive" | "Analog" | "Logic Gates" | "Imported"

export const GROUPS: Group[] = ["Boards", "Sensors", "Output", "Displays", "Input", "Motors", "Communication", "Connectivity", "Electromechanical", "Other", "Passive", "Analog", "Logic Gates", "Imported"]

/** A live control shown while the simulation runs (a sensor's temperature, a gas level …). */
export interface Ctl { key: string; label: string; min: number; max: number; step: number; unit: string; def: number }

/** How the part is drawn. Each kind is a function in look.ts. */
export type Look =
  | { k: "grove"; color?: string; chip?: string; icon?: Icon; label?: string }
  | { k: "module"; color: string; chip?: string; icon?: Icon; label?: string; w?: number; h?: number }
  | { k: "board"; color: string; chip: string; label?: string; usb?: boolean; w?: number; h?: number }
  | { k: "dip"; label: string }
  | { k: "to92"; label: string }
  | { k: "to220"; label: string }
  | { k: "cap"; label: string; polar?: boolean }
  | { k: "inductor"; label: string }
  | { k: "diode"; label: string; zener?: boolean; schottky?: boolean }
  | { k: "battery"; label: string; v: number }
  | { k: "gate"; fn: GateFn; inputs: number }
  | { k: "ff"; label: string }
  | { k: "probe"; label: string }
  | { k: "screen"; color: string; label?: string; sw: number; sh: number; tint?: string; w?: number; h?: number }
  | { k: "strip"; count: number; color?: string; ring?: boolean }
  | { k: "relay"; label: string; color?: string; channels?: number }

export type Icon =
  | "led" | "button" | "knob" | "slider" | "buzzer" | "speaker" | "relay" | "probe" | "lens" | "fan" | "motor" | "mic"
  | "matrix" | "digits" | "drop" | "flame" | "eye" | "heart" | "antenna" | "chip" | "coil" | "touch" | "joystick" | "gps"
  | "camera" | "clock" | "magnet" | "switch" | "plug" | "sd" | "bars"

export type GateFn = "and" | "or" | "nand" | "nor" | "xor" | "xnor" | "not" | "buf"

/** How the part behaves. sim.ts / circuit.ts dispatch on `m` (models.ts holds the code). */
export type Model =
  /** an output voltage set by a control: volts = f(value, vcc) */
  | { m: "analog"; pin: string; ctl: Ctl; f: (x: number, vcc: number) => number; dout?: string; thr?: number }
  /** a digital output the user toggles by clicking the part (motion, vibration, water …) */
  | { m: "digital"; pin: string; low?: boolean; pulse?: number }
  /** a momentary button (or a latching switch) driving `pin` high while pressed */
  | { m: "button"; pin: string; latch?: boolean; low?: boolean; led?: string }
  /** an on-board LED lit from `pin` */
  | { m: "led"; pin: string; color: string }
  /** a relay: coil between `coil` and GND, contacts com–no (and com–nc) */
  | { m: "relay"; coil: string[]; com: string[]; no: string[]; nc?: string[]; vOn?: number; ssr?: boolean }
  /** a buzzer or speaker: tone from `pin`; `active` buzzers sound at their own pitch on DC */
  | { m: "buzzer"; pin: string; active?: boolean }
  /** a motor, fan or vibration motor: speed from the voltage across a–b (b = GND by default) */
  | { m: "motor"; a: string; b?: string; r?: number }
  /** a heater / electromagnet / atomiser: a load that is on when driven */
  | { m: "load"; a: string; b?: string; r: number }
  /** an I²C chip: a register model in i2c.ts */
  | { m: "i2c"; chip: string; addr: number; ctls?: Ctl[] }
  /** a protocol device with its own model in protocols.ts */
  | { m: "proto"; kind: string; ctls?: Ctl[]; pins?: Record<string, string> }
  /** two-terminal passives and sources */
  | { m: "passive"; kind: "R" | "C" | "L"; value: number }
  | { m: "diode"; vf: number; vz?: number }
  | { m: "battery"; v: number; r: number }
  | { m: "supply" }
  | { m: "regulator"; v: number; adj?: boolean }
  | { m: "bjt"; pnp?: boolean; beta: number }
  | { m: "fet"; p?: boolean; vth: number; ron: number }
  | { m: "opamp"; count: number }
  | { m: "opto"; ctr: number }
  | { m: "gate"; fn: GateFn; inputs: number }
  | { m: "ic74"; fn: GateFn }
  | { m: "ff"; kind: "D" | "JK" | "T" }
  | { m: "probe"; kind: "V" | "A" }
  | { m: "siggen" }
  | { m: "analogin"; pins: string[] }
  /** a resistor between a and b set by a control (photodiode, LDR) */
  | { m: "lres"; a: string; b: string; ctl: Ctl; r: (x: number) => number }
  /** placed and wired, but not simulated */
  | { m: "none"; why?: string }

export interface CatalogPart {
  type: string
  title: string
  group: Group
  sub?: string
  hint: string
  pins: string[]
  look: Look
  model: Model
  attrs?: Record<string, string>
  settings?: Record<string, string[] | "number" | "text" | "color">
  /** another element draws it (a wokwi element with the same pins) */
  base?: string
  /** a board that runs a sketch (boards.ts has it) */
  board?: boolean
  /** a board we can't emulate yet */
  noEmu?: string
  tags?: string
  /** simulated by the hand-written wokwi code in sim.ts / circuit.ts */
  legacy?: boolean
}

/** Live controls a model shows while running. */
export function controlsOf(model: Model): Ctl[] {
  if (model.m === "analog" || model.m === "lres") return [model.ctl]
  if (model.m === "i2c" || model.m === "proto") return model.ctls ?? []
  return []
}

/** Is the part simulated (beyond connecting its pins)? */
export const simulated = (p: CatalogPart) => !p.noEmu && (!!p.board || !!p.legacy || p.model.m !== "none")
