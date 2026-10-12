// The live code view: while a sketch runs, the lines that touch a pin show what that pin is doing
// (a coloured badge after the line). This file finds those lines and words the badges; the editor
// draws them.
import type { LivePin } from "./sim"

export type SpotKind = "dwrite" | "dread" | "awrite" | "aread" | "mode" | "tone" | "serial" | "loop"
export interface Spot {
  /** 1-based line */
  line: number
  kind: SpotKind
  /** the pin argument as written ("13", "ledPin", "A0") */
  arg?: string
  /** what a digitalWrite writes, when it is a plain HIGH / LOW */
  value?: 0 | 1
  /** the text a println prints, when it is a string literal */
  text?: string
}

/** Comments blanked out (same length, newlines kept) so line numbers stay put. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "))
}

const CALLS: [RegExp, SpotKind][] = [
  [/\bdigitalWrite\s*\(\s*([^,()]+?)\s*,(?:\s*(HIGH|LOW|1|0|true|false)\s*\))?/, "dwrite"],
  [/\bdigitalRead\s*\(\s*([^,()]+?)\s*\)/, "dread"],
  [/\banalogWrite\s*\(\s*([^,()]+?)\s*,/, "awrite"],
  [/\banalogRead\s*\(\s*([^,()]+?)\s*\)/, "aread"],
  [/\bpinMode\s*\(\s*([^,()]+?)\s*,/, "mode"],
  [/\b(?:tone|noTone)\s*\(\s*([^,()]+?)\s*[,)]/, "tone"],
]

/** The lines of a sketch that do something with a pin (one spot per line, the first call wins). */
export function findSpots(src: string): Spot[] {
  const lines = stripComments(src).split("\n")
  const spots: Spot[] = []
  lines.forEach((l, i) => {
    if (/^\s*void\s+loop\s*\(\s*\)/.test(l)) { spots.push({ line: i + 1, kind: "loop" }); return }
    // the first call on the line
    let best: { at: number; spot: Spot } | null = null
    for (const [re, kind] of CALLS) {
      const m = re.exec(l)
      if (m && (!best || m.index < best.at)) {
        const spot: Spot = { line: i + 1, kind, arg: m[1].trim() }
        if (m[2]) spot.value = /^(HIGH|1|true)$/.test(m[2]) ? 1 : 0
        best = { at: m.index, spot }
      }
    }
    if (best) { spots.push(best.spot); return }
    // the line that finishes a line of output shows it (print() alone only adds to it)
    if (/\bSerial\d?\s*\.\s*(?:println\s*\(|printf\s*\(.*\\n)/.test(l)) {
      const lit = /\.\s*print(?:ln|f)\s*\(\s*"((?:[^"\\]|\\.)*)"/.exec(l)
      let text: string | undefined
      try { text = lit ? (JSON.parse(`"${lit[1]}"`) as string).replace(/%\S+|\n/g, "").trim() || undefined : undefined } catch { text = undefined }
      spots.push({ line: i + 1, kind: "serial", text })
    }
  })
  return spots
}

/** Simple pin constants: `#define LED 13`, `const int led = 9;`, `byte pot = A0;`. */
export function findConstants(src: string): Map<string, string> {
  const m = new Map<string, string>()
  const s = stripComments(src)
  for (const d of s.matchAll(/^\s*#define\s+([A-Za-z_]\w*)\s+([A-Za-z_]?\w+)\s*$/gm)) m.set(d[1], d[2])
  const decl = /\b(?:static\s+)?(?:const(?:expr)?\s+)?(?:unsigned\s+)?(?:int|byte|uint8_t|int8_t|short|long|pin_size_t|auto|uint16_t|int16_t|gpio_num_t)\s+([A-Za-z_]\w*)\s*=\s*([A-Za-z_]?\w+)\s*[;,]/g
  for (const d of s.matchAll(decl)) if (!m.has(d[1])) m.set(d[1], d[2])
  return m
}

/** The board pin a sketch argument names, among the pins the board has (null if unknown). */
export function resolvePin(arg: string, consts: Map<string, string>, pins: string[], led: string): string | null {
  const has = new Set(pins)
  let a = arg.trim()
  for (let i = 0; i < 5 && consts.has(a); i++) a = consts.get(a)!
  if (a === "LED_BUILTIN") a = led
  if (has.has(a)) return a
  if (/^\d+$/.test(a)) for (const p of ["D", "GP", "GPIO", "IO"]) if (has.has(p + a)) return p + a
  const an = /^A(\d+)$/.exec(a)
  if (an && has.has(`GP${26 + Number(an[1])}`)) return `GP${26 + Number(an[1])}`
  return null
}

/** How a badge looks: its colour and whether it is "on". */
export type Tone = "high" | "low" | "pwm" | "analog" | "input" | "float" | "mode" | "serial" | "time" | "sound"
export interface Badge {
  text: string
  tone: Tone
  /** shown faded: the line's output is not the latest, or its write is not the pin's state now */
  dim?: boolean
  /** what counts as a change worth flashing (a PWM duty or a voltage jitters a little) */
  key?: string
}

const volts = (v: number) => `${v.toFixed(2)} V`

/** The badge for one spot from the live pins (null when there is nothing to say). */
export function badgeFor(spot: Spot, pin: string | null, live: Record<string, LivePin>, ctx: { vcc: number; seconds: number; serial: string }): Badge | null {
  if (spot.kind === "loop") return { text: `⟳ ${ctx.seconds.toFixed(1)} s`, tone: "time" }
  if (spot.kind === "serial") {
    const lines = ctx.serial.split(/\r?\n/).filter((l) => l.trim())
    if (!lines.length) return null
    const last = lines.length - 1
    const at = spot.text ? lines.findLastIndex((l) => l.includes(spot.text!)) : last
    if (at < 0) return null
    const hit = lines[at].trim()
    return { text: `» ${hit.length > 30 ? hit.slice(0, 29) + "…" : hit}`, tone: "serial", dim: at !== last }
  }
  const p = pin ? live[pin] : undefined
  if (!pin || !p) return null
  const name = /^\d+$/.test(pin) ? `D${pin}` : pin
  switch (spot.kind) {
    case "mode":
      return { text: `${name} ${p.mode === "out" ? "OUTPUT" : p.mode === "pullup" ? "INPUT_PULLUP" : p.mode === "pulldown" ? "INPUT_PULLDOWN" : "INPUT"}`, tone: "mode" }
    case "dwrite":
    case "awrite":
      if (p.mode !== "out") return { text: `${name} not an output`, tone: "float" }
      if (p.toggles > 1 || spot.kind === "awrite") {
        if (p.duty > 0.995) return { text: `● ${name} HIGH`, tone: "high" }
        if (p.duty < 0.005 && p.toggles < 2) return { text: `○ ${name} LOW`, tone: "low" }
        return { text: `∿ ${name} PWM ${Math.round(p.duty * 100)}% ≈${volts(p.duty * ctx.vcc)}`, tone: "pwm", key: `pwm${Math.round(p.duty * 20)}` }
      }
      {
        const b: Badge = p.level === 1 ? { text: `● ${name} HIGH`, tone: "high" } : { text: `○ ${name} LOW`, tone: "low" }
        // a write of the other level: this line is not the one that set the pin
        if (spot.value !== undefined && spot.value !== p.level) b.dim = true
        return b
      }
    case "dread":
      if (p.level === 2) return { text: `? ${name} floating`, tone: "float" }
      return { text: `→ ${name} ${p.level ? "HIGH" : "LOW"}`, tone: p.level ? "high" : "input" }
    case "aread": {
      const adc = Math.round(Math.max(0, Math.min(1, p.v / ctx.vcc)) * 1023)
      return { text: `→ ${name} ${volts(p.v)} · ${adc}`, tone: "analog", key: `a${Math.round(p.v * 10)}` }
    }
    case "tone":
      return p.toggles > 1 ? { text: `♪ ${name} sounding`, tone: "sound" } : { text: `${name} silent`, tone: "low" }
  }
  return null
}
