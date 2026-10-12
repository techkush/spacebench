// "Check with ngspice": the running circuit at this instant — pin levels, sensor outputs,
// buttons and knobs — written as a SPICE deck and solved by ngspice (DC operating point) with
// real diode models, for exact currents, voltages and power per part.
import type { SpiceNetlist } from "@/lib/spice"
import type { BoardDef } from "./boards"
import { Circuit } from "./circuit"
import type { Diagram } from "./diagram"
import type { Snapshot } from "./sim"

// LED diode models: Vf ≈ the colour's forward voltage at 10 mA (Shockley with series resistance)
const LED_MODEL: Record<string, string> = {
  red: "IS=1e-20 N=1.7 RS=4", orange: "IS=4e-21 N=1.7 RS=4", yellow: "IS=2e-21 N=1.7 RS=4",
  green: "IS=1e-22 N=1.7 RS=4", lime: "IS=1e-22 N=1.7 RS=4", blue: "IS=1e-28 N=1.9 RS=6",
  white: "IS=1e-28 N=1.9 RS=6", purple: "IS=1e-28 N=1.9 RS=6", violet: "IS=1e-28 N=1.9 RS=6",
}
const modelOf = (c?: string) => (c && LED_MODEL[c] ? c : "red")

export interface CheckRow {
  /** SPICE element (upper case) */
  element: string
  part: string
  what: string
  kind: "resistor" | "led" | "pin" | "supply" | "module"
  /** its two SPICE nodes, for the voltage across it */
  a: string
  b: string
}

export interface McuDeck { net: SpiceNetlist; rows: CheckRow[] }

export function mcuDeck(diagram: Diagram, board: BoardDef, snap: Snapshot): McuDeck {
  const c = new Circuit(diagram, board)
  const gnd = c.boardNet.get("GND")
  const node = (n: number) => (n < 0 ? null : n === gnd ? "0" : `n${n}`)
  const lines: string[] = [`* Space Bench microcontroller check — ${board.name}`]
  const nodes = new Map<string, string>()
  const elements = new Map<string, string>()
  const rows: CheckRow[] = []
  let nc = 0
  const nn = (n: number) => { const s = node(n); if (s) { if (s !== "0") nodes.set(s, c.members[n].slice(0, 3).join(" · ")); return s } return `nc_${nc++}` }
  const add = (el: string, row: Omit<CheckRow, "element" | "a" | "b">) => {
    elements.set(el, el)
    const parts = lines[lines.length - 1].split(/\s+/)
    rows.push({ element: el, a: parts[1], b: parts[2], ...row })
  }
  // supplies
  let k = 0
  for (const [pin, v] of Object.entries(board.power)) {
    const n = c.boardNet.get(pin)
    if (n === undefined || c.members[n].length < 2 || n === gnd) continue
    lines.push(`VP${k} sp${k} 0 DC ${v}`, `RP${k} sp${k} ${nn(n)} ${v < 4 ? 0.5 : 0.05}`)
    add(`RP${k}`, { part: board.name, what: `${pin} supply`, kind: "supply" }); k++
  }
  // pins
  for (const [pin, lv] of snap.pins) {
    const n = c.boardNet.get(pin)
    if (n === undefined || c.members[n].length < 2) continue
    const id = pin.replace(/\W/g, "_")
    if (lv.out !== null) { lines.push(`VO_${id} so_${id} 0 DC ${lv.out ? board.vcc : 0}`, `RO_${id} so_${id} ${nn(n)} 25`); add(`RO_${id}`, { part: board.name, what: `pin ${pin} (${lv.out ? "HIGH" : "LOW"})`, kind: "pin" }) }
    else if (lv.pullup) { lines.push(`VU_${id} su_${id} 0 DC ${board.vcc}`, `RU_${id} su_${id} ${nn(n)} 37k`) }
    else if (lv.pulldown) lines.push(`RD_${id} ${nn(n)} 0 55k`)
  }
  // sensor modules and devices driving a pin
  k = 0
  for (const [end, d] of snap.drives) {
    const [id, pin] = end.split(":")
    const n = c.net(id, pin)
    if (n < 0) continue
    lines.push(`VM${k} sm${k} 0 DC ${d.v.toPrecision(6)}`, `RM${k} sm${k} ${nn(n)} ${d.r}`)
    add(`RM${k}`, { part: id, what: `${pin} output`, kind: "module" }); k++
  }
  // passives
  const { res, diodes } = c.elements(snap.ui)
  res.forEach((r, i) => {
    if (r.a === r.b) return
    const el = `R${i}_${(r.part ?? "x").replace(/\W/g, "_")}`.toUpperCase()
    lines.push(`${el} ${nn(r.a)} ${nn(r.b)} ${r.r}`)
    add(el, { part: r.part ?? "?", what: r.r <= 0.05 ? `${r.what} (closed)` : `${r.what} ${fmtOhms(r.r)}`, kind: "resistor" })
  })
  const models = new Set<string>()
  diodes.forEach((d) => {
    const m = modelOf(d.color)
    models.add(m)
    const el = `D_${d.part.replace(/\W/g, "_")}_${d.index}`.toUpperCase()
    lines.push(`${el} ${nn(d.a)} ${nn(d.c)} LED_${m}`)
    add(el, { part: d.part, what: diodes.filter((x) => x.part === d.part).length > 1 ? `LED ${d.index + 1}` : "LED", kind: "led" })
  })
  for (const m of models) lines.push(`.model LED_${m} D(${LED_MODEL[m]} BV=5 IBV=10u)`)
  // every node has a path to ground (floating pins, open switches)
  for (const s of [...nodes.keys(), ...Array.from({ length: nc }, (_, i) => `nc_${i}`)]) lines.push(`RL_${s} ${s} 0 1G`)
  lines.push(".options savecurrents", ".op")
  return { net: { text: lines.join("\n"), nodes, elements, issues: [], simulated: rows.length }, rows }
}

function fmtOhms(r: number) { return r >= 1e6 ? `${+(r / 1e6).toPrecision(3)} MΩ` : r >= 1e3 ? `${+(r / 1e3).toPrecision(3)} kΩ` : `${+r.toPrecision(3)} Ω` }
