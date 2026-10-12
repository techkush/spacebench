// Several boards in one workspace. The first board on the canvas owns the sketch's top-level
// files (sketch.ino, libraries.txt …), so a one-board sketch is laid out exactly as before and
// stays Wokwi-compatible; every other board keeps its own files in a folder named after its
// id: "esp/sketch.ino", "esp/libraries.txt".
//
// Each board runs in its own simulator on the part of the diagram that is its own: itself,
// the parts and the wires to it. Other boards' GND pins are the common ground; wires from
// one board's signal pin to another's are not simulated yet.
import { isBoardType } from "./boards"
import { splitEnd, type Connection, type Diagram, type DiagramPart } from "./diagram"
import type { SketchFileData } from "./examples"
import type { Frame } from "./sim"

export const boardsOf = (d: Diagram): DiagramPart[] => d.parts.filter((p) => isBoardType(p.type))

/** The folder prefix of a board's files: "" for the main (first) board, else "id/". */
export const prefixOf = (boardId: string, mainId: string | undefined) => (boardId === mainId ? "" : `${boardId}/`)

/** The board a file belongs to (by its name), given the boards on the canvas. */
export function ownerOf(file: string, boards: DiagramPart[]): string | undefined {
  const slash = file.indexOf("/")
  if (slash < 0) return boards[0]?.id
  const id = file.slice(0, slash)
  return boards.some((b) => b.id === id) ? id : undefined
}

/** A board's own files, with the folder prefix taken off (what the compiler gets). */
export function filesOf(files: SketchFileData[], prefix: string): SketchFileData[] {
  return files.filter((f) => (prefix ? f.name.startsWith(prefix) : !f.name.includes("/"))).map((f) => (prefix ? { ...f, name: f.name.slice(prefix.length) } : f))
}

/** Rename a board's files from one prefix to another ("" = the main board). */
export function moveFiles(files: SketchFileData[], from: string, to: string): SketchFileData[] {
  return files.map((f) => {
    const mine = from ? f.name.startsWith(from) : !f.name.includes("/")
    return mine ? { ...f, name: to + f.name.slice(from.length) } : f
  })
}

/**
 * The main board changed (it was deleted, or the boards were reordered): the old main
 * board's top-level files move into its folder, and the new main board's folder moves up.
 */
export function rehome(files: SketchFileData[], oldMain: string | undefined, newMain: string | undefined): SketchFileData[] {
  if (oldMain === newMain) return files
  // park the top-level files first so the two renames can't collide
  let out = oldMain ? moveFiles(files, "", `${oldMain}/`) : files.filter((f) => f.name.includes("/"))
  if (newMain) out = moveFiles(out, `${newMain}/`, "")
  return out
}

/** A blank sketch for a newly added board (a Linux board gets a Python program). */
export const blankFiles = (prefix: string, linux = false): SketchFileData[] => linux ? [
  { name: `${prefix}main.py`, content: "# Runs on the Raspberry Pi (Linux, Python 3). gpiozero drives the GPIO pins.\nfrom gpiozero import LED\nfrom time import sleep\n\nprint(\"Hello, world from the Raspberry Pi!\")\nled = LED(17)\nwhile True:\n    led.toggle()\n    print(\"LED on\" if led.is_lit else \"LED off\")\n    sleep(0.5)\n" },
  { name: `${prefix}requirements.txt`, content: "# Python packages (install them from the Terminal: pip install …)\n" },
] : [
  { name: `${prefix}sketch.ino`, content: "void setup() {\n  // put your setup code here, to run once:\n  Serial.begin(9600);\n}\n\nvoid loop() {\n  // put your main code here, to run repeatedly:\n}\n" },
  { name: `${prefix}libraries.txt`, content: "" },
]

/**
 * Which boards each part belongs to: the boards it reaches through wires and other parts
 * (not through another board). Parts wired to no board go with the first one.
 */
export function partOwners(d: Diagram): Map<string, string[]> {
  const boards = boardsOf(d)
  const ids = new Set(boards.map((b) => b.id))
  const adj = new Map<string, Set<string>>()
  const link = (x: string, y: string) => { if (!adj.has(x)) adj.set(x, new Set()); adj.get(x)!.add(y) }
  for (const [a, b] of d.connections) { const x = splitEnd(a)[0], y = splitEnd(b)[0]; if (x !== y) { link(x, y); link(y, x) } }
  const owners = new Map<string, string[]>()
  for (const b of boards) {
    const seen = new Set([b.id]), todo = [b.id]
    while (todo.length) for (const n of adj.get(todo.pop()!) ?? []) if (!seen.has(n) && !ids.has(n)) { seen.add(n); todo.push(n) }
    for (const n of seen) if (n !== b.id) owners.set(n, [...(owners.get(n) ?? []), b.id])
  }
  for (const p of d.parts) if (!ids.has(p.id) && !owners.has(p.id) && boards[0]) owners.set(p.id, [boards[0].id])
  return owners
}

/** The diagram one board's simulator sees: that board first, its own parts, no other boards. */
export function boardDiagram(d: Diagram, boardId: string): Diagram {
  const boards = boardsOf(d)
  if (boards.length <= 1) return d
  const me = boards.find((b) => b.id === boardId)
  if (!me) return d
  const others = new Set(boards.filter((b) => b.id !== boardId).map((b) => b.id))
  const owners = partOwners(d)
  const mine = new Set([boardId, ...d.parts.filter((p) => owners.get(p.id)?.includes(boardId)).map((p) => p.id)])
  const end = (e: string): string | null => {
    const [id, pin] = splitEnd(e)
    // another board's ground is everyone's ground
    if (others.has(id)) return /^GND(\.|$)/.test(pin) ? `${boardId}:GND` : null
    return mine.has(id) ? e : null
  }
  const connections: Connection[] = []
  for (const [a, b, color, hints] of d.connections) {
    const ea = end(a), eb = end(b)
    if (ea && eb && ea !== eb) connections.push([ea, eb, color, hints])
  }
  return { ...d, parts: [me, ...d.parts.filter((p) => p.id !== boardId && mine.has(p.id))], connections }
}

/** Wires from one board's signal pin to another board's (not simulated yet). */
export function boardLinks(d: Diagram): Connection[] {
  const ids = new Set(boardsOf(d).map((b) => b.id))
  return d.connections.filter(([a, b]) => {
    const [ia, pa] = splitEnd(a), [ib, pb] = splitEnd(b)
    return ids.has(ia) && ids.has(ib) && ia !== ib && !(/^GND/.test(pa) && /^GND/.test(pb))
  })
}

/** One frame for the canvas from each running board's latest frame. */
export function mergeFrames(frames: Record<string, Frame>, focus: string | undefined): Frame | null {
  const ids = Object.keys(frames)
  if (!ids.length) return null
  if (ids.length === 1) return frames[ids[0]]
  const base = frames[focus && frames[focus] ? focus : ids[0]]
  // a part is drawn from the first frame that has it (its own board's); an LED on a net two
  // boards share shows the brighter reading
  const union = <K, V>(pick: (f: Frame) => Map<K, V>) => {
    const m = new Map<K, V>()
    for (const id of ids) for (const [k, v] of pick(frames[id])) if (!m.has(k)) m.set(k, v)
    return m
  }
  const leds = new Map<string, number[]>()
  for (const id of ids) for (const [k, v] of frames[id].leds) {
    const old = leds.get(k)
    leds.set(k, old ? Array.from({ length: Math.max(old.length, v.length) }, (_, i) => Math.max(old[i] ?? 0, v[i] ?? 0)) : v)
  }
  const buzzer = new Map<string, number>()
  for (const id of ids) for (const [k, v] of frames[id].buzzer) buzzer.set(k, Math.max(buzzer.get(k) ?? 0, v))
  return {
    ...base,
    leds, servo: union((f) => f.servo), buzzer,
    lcd: union((f) => f.lcd), oled: union((f) => f.oled), neopixel: union((f) => f.neopixel), mods: union((f) => f.mods ?? new Map()),
    warnings: [...new Set(ids.flatMap((id) => frames[id].warnings.map((w) => `${id}: ${w}`)))],
    i2cMissing: [...new Set(ids.flatMap((id) => frames[id].i2cMissing))],
    seconds: Math.min(...ids.map((id) => frames[id].seconds)),
    speed: Math.min(...ids.map((id) => frames[id].speed)),
    boards: Object.fromEntries(ids.map((id) => [id, { led: frames[id].boardLed, tx: frames[id].tx }])),
  }
}
