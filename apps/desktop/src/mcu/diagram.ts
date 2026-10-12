// The wiring diagram of a microcontroller project, in Wokwi's diagram.json format (so Wokwi
// projects open here and ours open there):
//   { version: 1, author, editor, parts: [{ type, id, top, left, rotate, attrs }],
//     connections: [["uno:13", "led1:A", "green", ["v0"]], …] }

export interface DiagramPart {
  type: string
  id: string
  top: number
  left: number
  rotate?: number
  hide?: boolean
  attrs: Record<string, string>
}
/** [from "part:pin", to "part:pin", color, route hints] */
export type Connection = [string, string, string, string[]]

export interface Diagram {
  version: 1
  author: string
  editor: string
  parts: DiagramPart[]
  connections: Connection[]
  dependencies?: Record<string, string>
}

/** The usual id of a board part: uno, nano, mega, pico. */
export const boardId = (type: string) => (type.includes("esp32") ? "esp" : type.includes("pico") ? "pico" : type.includes("mega") ? "mega" : type.includes("nano") ? "nano" : "uno")

export const emptyDiagram = (board = "wokwi-arduino-uno"): Diagram => ({
  version: 1, author: "", editor: "spacebench",
  parts: [{ type: board, id: boardId(board), top: 0, left: 0, attrs: {} }],
  connections: [],
})

export function parseDiagram(text: string): Diagram {
  const j = JSON.parse(text) as Partial<Diagram>
  if (!Array.isArray(j.parts)) throw new Error("diagram.json has no parts")
  return {
    version: 1, author: j.author ?? "", editor: j.editor ?? "wokwi",
    parts: j.parts.map((p) => ({ type: String(p.type), id: String(p.id), top: Number(p.top) || 0, left: Number(p.left) || 0, rotate: p.rotate ? Number(p.rotate) : undefined, hide: p.hide || undefined, attrs: Object.fromEntries(Object.entries(p.attrs ?? {}).map(([k, v]) => [k, String(v)])) })),
    connections: (j.connections ?? []).filter((c) => Array.isArray(c) && c.length >= 2).map((c) => [String(c[0]), String(c[1]), String(c[2] ?? "green"), Array.isArray(c[3]) ? c[3].map(String) : []] as Connection),
    dependencies: j.dependencies,
  }
}

export const diagramText = (d: Diagram) => JSON.stringify({ ...d, editor: "spacebench" }, null, 2) + "\n"

export const splitEnd = (end: string): [string, string] => {
  const i = end.indexOf(":")
  return i < 0 ? [end, ""] : [end.slice(0, i), end.slice(i + 1)]
}

/** A fresh id for a part of this type: led1, led2 … */
export function nextId(d: Diagram, type: string): string {
  const base = type.replace(/^wokwi-/, "").replace(/-(sensor|element|module)$/, "").replace(/[^a-z0-9]+/gi, "").slice(0, 10) || "part"
  for (let i = 1; ; i++) if (!d.parts.some((p) => p.id === `${base}${i}`)) return `${base}${i}`
}
