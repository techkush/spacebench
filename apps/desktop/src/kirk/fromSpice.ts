// Import a SPICE netlist (.cir / .sp / .net) as Kirk source. The Kirk compiler
// then places the parts, so an imported netlist opens as an editable schematic.
//   R C L · V I (DC / AC / SIN / PULSE / PWL) · D · Q · M · J
// Subcircuits, controlled sources and .model parameters are listed as comments.
import { qty, siText } from "./kinds"
import { circuitName, netRef } from "./generate"

const SPICE_SCALE: [RegExp, number][] = [
  [/^meg/i, 1e6], [/^mil/i, 25.4e-6], [/^t/i, 1e12], [/^g/i, 1e9], [/^k/i, 1e3], [/^m/i, 1e-3],
  [/^u|^µ/i, 1e-6], [/^n/i, 1e-9], [/^p/i, 1e-12], [/^f/i, 1e-15],
]

/** SPICE number: "1k", "4.7u", "2meg", "10mA" (m = milli, meg = mega; trailing units ignored). */
export function spiceValue(text: string | undefined): number | null {
  if (!text) return null
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(.*)$/i.exec(text.trim())
  if (!m) return null
  const base = parseFloat(m[1])
  for (const [re, s] of SPICE_SCALE) if (re.test(m[2])) return Number((base * s).toPrecision(12))
  return base
}

/** SPICE libraries name models Q2N3904 / D1N4148 / MIRF540; the part is 2N3904 / 1N4148 / IRF540. */
const partName = (model: string) => model.replace(/^[QDM](?=\d|IRF|BS|BC|BD|TIP|2N)/i, "")

export interface SpiceImport { kirk: string; title: string; skipped: string[]; parts: number }

/** Join "+" continuation lines, drop comments; the first line is the title. */
function logicalLines(text: string): { title: string; lines: string[] } {
  const raw = text.replace(/\r\n?/g, "\n").split("\n")
  const title = (raw[0] ?? "").replace(/^\*\s*/, "").trim()
  const lines: string[] = []
  for (const l0 of raw.slice(1)) {
    const l = l0.replace(/[;$].*$/, "").trimEnd()
    if (!l.trim() || l.trim().startsWith("*")) continue
    if (l.trim().startsWith("+") && lines.length) lines[lines.length - 1] += " " + l.trim().slice(1)
    else lines.push(l.trim())
  }
  return { title, lines }
}

/** "SIN(0 1 1k)" and "SIN 0 1 1k" → ["0","1","1k"] */
function fnArgs(tokens: string[], i: number): { args: string[]; next: number } {
  const rest = tokens.slice(i).join(" ")
  const m = /^\w+\s*\(([^)]*)\)/.exec(rest)
  if (m) {
    const used = m[0].split(/\s+/).length
    return { args: m[1].trim().split(/[\s,]+/).filter(Boolean), next: i + used }
  }
  const args: string[] = []
  let j = i + 1
  while (j < tokens.length && spiceValue(tokens[j]) !== null) args.push(tokens[j++])
  return { args, next: j }
}

export function spiceToKirk(text: string, fileName = "netlist.cir"): SpiceImport {
  const { title: rawTitle, lines } = logicalLines(text)
  const title = rawTitle || fileName.replace(/\.\w+$/, "")
  const skipped: string[] = []
  const models = new Map<string, string>() // model name → type (NPN, PNP, NMOS, D…)
  for (const l of lines) {
    const m = /^\.model\s+(\S+)\s+(\w+)/i.exec(l)
    if (m) models.set(m[1].toLowerCase(), m[2].toUpperCase())
  }
  const used = new Set<string>()
  let gnd = false
  const net = (n: string) => {
    if (/^(0|gnd|gnd!)$/i.test(n)) { gnd = true; return "GND" }
    let s = n.replace(/[^A-Za-z0-9_]/g, "_")
    if (/^\d/.test(s)) s = `N${s}`
    used.add(s)
    return netRef(s)
  }
  const body: string[] = []
  const analyses: string[] = []
  let parts = 0
  const q = (s: string) => `"${s.replace(/"/g, '\\"')}"`
  const add = (ref: string, ctor: string, pins: [string, string][]) => {
    body.push(`  ${ref} = ${ctor}`)
    for (const [pin, n] of pins) body.push(`  ${ref}.${pin} -- ${net(n)}`)
    parts++
  }

  for (const l of lines) {
    const t = l.split(/\s+/)
    const head = t[0]
    const kind = head[0].toUpperCase()
    if (kind === ".") {
      const d = head.toLowerCase()
      if (d === ".tran") {
        const step = spiceValue(t[1]), stop = spiceValue(t[2])
        if (stop) analyses.push(`simulate tran(stop: ${qty(stop, "s")}, step: ${qty(step ?? stop / 1000, "s")})`)
      } else if (d === ".ac") {
        const pts = spiceValue(t[2]) ?? 60, f1 = spiceValue(t[3]), f2 = spiceValue(t[4])
        if (f1 && f2) analyses.push(`simulate ac(from: ${qty(f1, "Hz")}, to: ${qty(f2, "Hz")}, points: ${/^dec/i.test(t[1] ?? "dec") ? pts : 60}/dec)`)
      } else if (d === ".op") analyses.push("simulate op")
      else if (d === ".dc" && t.length >= 5) analyses.push(`simulate dc(${t[1].toUpperCase()}, from: ${qty(spiceValue(t[2]) ?? 0, "V")}, to: ${qty(spiceValue(t[3]) ?? 5, "V")}, step: ${qty(spiceValue(t[4]) ?? 0.1, "V")})`)
      else if (!/^\.(model|end|ends|options?|control|endc|print|plot|probe|save|temp|ic|nodeset|title|width)$/.test(d)) skipped.push(l)
      continue
    }
    const ref = head.toUpperCase()
    try {
      switch (kind) {
        case "R": case "C": case "L": {
          const v = spiceValue(t[3])
          if (v === null || t.length < 4) { skipped.push(l); break }
          add(ref, `${kind}(${siText(v)})`, [["1", t[1]], ["2", t[2]]])
          break
        }
        case "V": case "I": {
          const [np, nn] = [t[1], t[2]]
          let i = 3, dc = 0, ac: number | null = null, ctor = ""
          while (i < t.length) {
            const w = t[i].toUpperCase()
            if (w === "DC") { dc = spiceValue(t[i + 1]) ?? 0; i += 2 }
            else if (w === "AC") { ac = spiceValue(t[i + 1]) ?? 1; i += spiceValue(t[i + 1]) !== null ? 2 : 1 }
            else if (/^SIN/.test(w)) {
              const { args, next } = fnArgs(t, i); i = next
              const [off, amp, f, td, , ph] = args.map(spiceValue)
              const u = kind === "V" ? "V" : "A"
              ctor = `${kind}sin(amp: ${qty(amp ?? 1, u)}, freq: ${qty(f ?? 1e3, "Hz")}${off ? `, offset: ${qty(off, u)}` : ""}${td ? `, delay: ${qty(td, "s")}` : ""}${ph ? `, phase: ${ph}` : ""}`
            } else if (/^PULSE/.test(w)) {
              const { args, next } = fnArgs(t, i); i = next
              const [v1, v2, td, tr, tf, pw, per] = args.map(spiceValue)
              const u = kind === "V" ? "V" : "A"
              ctor = `${kind}pulse(low: ${qty(v1 ?? 0, u)}, high: ${qty(v2 ?? 1, u)}${td ? `, delay: ${qty(td, "s")}` : ""}${tr ? `, rise: ${qty(tr, "s")}` : ""}${tf ? `, fall: ${qty(tf, "s")}` : ""}${pw ? `, width: ${qty(pw, "s")}` : ""}${per ? `, period: ${qty(per, "s")}` : ""}`
            } else if (/^PWL/.test(w) && kind === "V") {
              const { args, next } = fnArgs(t, i); i = next
              ctor = `Vpwl(${q(args.map((a) => String(spiceValue(a) ?? a)).join(" "))}`
            } else if (spiceValue(t[i]) !== null) { dc = spiceValue(t[i])!; i++ }
            else { i++ }
          }
          const u = kind === "V" ? "V" : "A"
          if (ctor) add(ref, `${ctor}${ac !== null && !ctor.startsWith("Vpwl") ? `, ac: ${qty(ac, u)}` : ""})`, [["1", np], ["2", nn]])
          else if (ac !== null) add(ref, `lib("Simulation_SPICE:${kind}DC", value: ${q(siText(dc))}, params: ${q(`dc=${siText(dc)} ac=${siText(ac)}`)})`, [["1", np], ["2", nn]])
          else add(ref, `${kind}dc(${qty(dc, u)})`, [["1", np], ["2", nn]])
          break
        }
        case "D": {
          const model = t[3] ?? ""
          const isLed = /led/i.test(model)
          add(ref, isLed ? "LED(red)" : model ? `D(${q(partName(model))})` : "D()", [["2", t[1]], ["1", t[2]]])
          break
        }
        case "Q": {
          const model = t[t.length >= 6 && models.has(t[5]?.toLowerCase()) ? 5 : 4] ?? ""
          const type = models.get(model.toLowerCase()) ?? (/^(2N3906|2N2907|BC55|BC85|BC32|BD140|TIP32|2N4403)/i.test(model) ? "PNP" : "NPN")
          add(ref, `${type === "PNP" ? "PNP" : "NPN"}(${q(partName(model))})`, [["C", t[1]], ["B", t[2]], ["E", t[3]]])
          if (t.length >= 6 && models.has(t[5]?.toLowerCase())) skipped.push(`${ref}: substrate node ${t[4]} not connected`)
          break
        }
        case "M": {
          const model = t[5] ?? ""
          const type = models.get(model.toLowerCase()) ?? (/^p/i.test(model) ? "PMOS" : "NMOS")
          add(ref, `${type.startsWith("P") ? "PMOS" : "NMOS"}(${q(partName(model))})`, [["D", t[1]], ["G", t[2]], ["S", t[3]]])
          if (t[4] && t[4] !== t[3]) skipped.push(`${ref}: bulk node ${t[4]} joined to source`)
          break
        }
        case "J": {
          const model = t[4] ?? ""
          const type = models.get(model.toLowerCase()) ?? "NJF"
          add(ref, type === "PJF" ? "PJFET()" : "NJFET()", [["1", t[1]], ["3", t[2]], ["2", t[3]]])
          break
        }
        default: skipped.push(l)
      }
    } catch { skipped.push(l) }
  }

  const out: string[] = []
  out.push(`// Imported from ${fileName}${skipped.length ? ` — ${skipped.length} line${skipped.length > 1 ? "s" : ""} not imported (see below)` : ""}`)
  out.push(`@title(${q(title)})`)
  out.push(`circuit ${circuitName(title)} {`)
  if (gnd) out.push("  ground GND")
  out.push(...body)
  out.push("}")
  out.push(...(analyses.length ? analyses : ["simulate op"]))
  if (models.size) out.push("", `// .model cards are matched by name to built-in models (${[...models.keys()].join(", ")})`)
  for (const s of skipped) out.push(`// not imported: ${s}`)
  return { kirk: out.join("\n") + "\n", title, skipped, parts }
}
