// Output devices that show what the circuit does: LEDs and lamps light up, speakers
// and buzzers make sound (played through the computer), motors and fans spin.
import type { Part } from "./model"

export type OutputKind = "led" | "lamp" | "speaker" | "buzzer" | "motor"

/** The kind of output a part is, from its KiCad symbol; null for everything else. */
export function outputKind(p: Pick<Part, "lib">): OutputKind | null {
  const [lib, name = ""] = p.lib.split(":")
  if (lib === "Device" && /^LED($|_45deg|_Filled|_Small)/.test(name)) return "led"
  if (lib === "Device" && /^Lamp/.test(name)) return "lamp"
  if (lib === "Device" && /^Speaker/.test(name)) return "speaker"
  if (lib === "Device" && /^Buzzer/.test(name)) return "buzzer"
  if (lib === "Motor" && /^(Motor_DC|Fan$|Fan_ALT|Fan_IEC|Fan_ISO)/.test(name)) return "motor"
  return null
}

/** Emitted colour of an LED from its value ("Red", "green 3mm" …). */
export function ledColor(value: string): string {
  const t = value.toLowerCase()
  return /blue/.test(t) ? "#3b82f6" : /white/.test(t) ? "#f8fafc" : /uv|violet|purple/.test(t) ? "#a855f7" : /pink/.test(t) ? "#ec4899"
    : /green/.test(t) ? "#22c55e" : /yellow/.test(t) ? "#facc15" : /amber|orange/.test(t) ? "#f97316" : /ir\b|infrared/.test(t) ? "#7f1d1d" : "#ef4444"
}

export interface OutputState {
  kind: OutputKind
  /** 0 (off) … 1 (full brightness / volume / speed) */
  level: number
  /** current through the device (A), signed */
  current: number
  color: string
  /** driven past its rating (LED over 30 mA) */
  overdriven: boolean
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

/** How lit / loud / fast an output is for the given simulated values (from I(ref)). */
export function outputState(p: Part, values: Record<string, number>): OutputState | null {
  const kind = outputKind(p)
  if (!kind) return null
  const i = values[`I(${p.ref})`]
  if (i === undefined || !Number.isFinite(i)) return null
  const a = Math.abs(i)
  switch (kind) {
    // LED: visible from ~0.1 mA, full at 20 mA, on a log scale like the eye; only forward current lights it
    case "led": return { kind, current: i, level: i > 0 ? clamp01(Math.log10(i / 1e-4) / Math.log10(0.02 / 1e-4)) : 0, color: ledColor(p.value), overdriven: i > 0.03 }
    // filament (100 Ω): glows from ~10 mA, full at 120 mA (12 V)
    case "lamp": return { kind, current: i, level: clamp01((a - 0.01) / 0.11), color: "#fbbf24", overdriven: false }
    // speaker (8 Ω) / buzzer (50 Ω): loudness by current
    case "speaker": return { kind, current: i, level: clamp01(a / 0.25), color: "#38bdf8", overdriven: false }
    case "buzzer": return { kind, current: i, level: clamp01(a / 0.05), color: "#38bdf8", overdriven: false }
    // DC motor (20 Ω winding): starts at ~20 mA, full speed at 500 mA; the sign is the direction
    case "motor": return { kind, current: i, level: clamp01((a - 0.02) / 0.48), color: "#a3e635", overdriven: false }
  }
}
