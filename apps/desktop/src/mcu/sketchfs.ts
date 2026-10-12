// Microcontroller sketches in a project folder: firmware/<name>/ holds the sketch files,
// diagram.json (the wiring, Wokwi format) and libraries.txt.
import type { Project } from "@/lib/project"
import { safeName } from "@/lib/project"
import { baseName, join } from "@/lib/projectfs"
import { diagramText, emptyDiagram, parseDiagram } from "./diagram"
import { blankSketch, type SketchFileData } from "./examples"
import { boardsOf } from "./multiboard"
import type { SketchDoc } from "./McuWorkspace"

// a Raspberry Pi's program is Python: main.py, its modules, requirements.txt
const SOURCE = /\.(ino|h|hpp|c|cpp|txt|py)$/
/** the board's own files in order: the main program first, the package lists last */
const order = (main: string) => (a: SketchFileData, b: SketchFileData) =>
  a.name === main ? -1 : b.name === main ? 1 : /^(libraries|requirements)\.txt$/.test(a.name) ? 1 : /^(libraries|requirements)\.txt$/.test(b.name) ? -1 : a.name.localeCompare(b.name)

/** The folder (relative) of the sketch a file belongs to: firmware/<name>/… → firmware/<name>. */
export const sketchFolderOf = (relPath: string) => { const m = /^(firmware\/[^/]+)(\/|$)/.exec(relPath); return m ? m[1] : null }

export async function loadSketch(p: Project, folder: string): Promise<SketchDoc> {
  const dir = join(p.root, folder)
  const entries = (await p.fs.list(dir)).filter((e) => !e.dir)
  const files: SketchFileData[] = []
  for (const e of entries) if (SOURCE.test(e.name)) files.push({ name: e.name, content: await p.fs.read(e.path) })
  // the main program first (sketch.ino, the .ino named after the folder, or a Pi's main.py), libraries.txt last
  const main = files.find((f) => f.name === "sketch.ino") ?? files.find((f) => f.name === `${baseName(folder)}.ino`) ?? files.find((f) => f.name.endsWith(".ino"))
    ?? files.find((f) => f.name === "main.py") ?? files.find((f) => f.name.endsWith(".py"))
  if (!main) throw new Error(`${folder} has no program (an .ino sketch or a Raspberry Pi's main.py)`)
  files.sort(order(main.name))
  if (main.name.endsWith(".ino") && !files.some((f) => f.name === "libraries.txt")) files.push({ name: "libraries.txt", content: "" })
  const dj = entries.find((e) => e.name === "diagram.json")
  const diagram = dj ? parseDiagram(await p.fs.read(dj.path)) : emptyDiagram()
  // the other boards' sketches: one folder per board, named after its id
  for (const b of boardsOf(diagram).slice(1)) {
    const sub = join(dir, b.id)
    if (!(await p.fs.exists(sub))) continue
    const own: SketchFileData[] = []
    for (const e of await p.fs.list(sub)) if (!e.dir && SOURCE.test(e.name)) own.push({ name: e.name, content: await p.fs.read(e.path) })
    own.sort(order(own.some((f) => f.name === "sketch.ino") ? "sketch.ino" : "main.py"))
    files.push(...own.map((f) => ({ ...f, name: `${b.id}/${f.name}` })))
  }
  return { name: baseName(folder), files, diagram }
}

export async function saveSketch(p: Project, folder: string, doc: SketchDoc): Promise<void> {
  const dir = join(p.root, folder)
  await p.fs.mkdir(dir)
  // top-level files are the first board's; "<id>/…" files go in that board's folder. Files of
  // boards no longer on the canvas aren't written (their folder on disk is left alone).
  const folders = ["", ...boardsOf(doc.diagram).slice(1).map((b) => `${b.id}/`)]
  for (const pre of folders) {
    const own = doc.files.filter((f) => (pre ? f.name.startsWith(pre) && !f.name.slice(pre.length).includes("/") : !f.name.includes("/")))
    const sub = pre ? join(dir, pre.slice(0, -1)) : dir
    if (pre) { if (!own.length) continue; await p.fs.mkdir(sub) }
    const keep = new Set(own.map((f) => f.name.slice(pre.length)))
    for (const e of await p.fs.list(sub)) if (!e.dir && SOURCE.test(e.name) && !keep.has(e.name)) await p.fs.remove(e.path)
    for (const f of own) await p.fs.write(join(sub, f.name.slice(pre.length)), f.content)
  }
  await p.fs.write(join(dir, "diagram.json"), diagramText(doc.diagram))
}

/** A new sketch folder in firmware/ (blank, or from an example's files and diagram). */
export async function newSketch(p: Project, name: string, from?: SketchDoc): Promise<string> {
  let base = safeName(name).replace(/\s+/g, "-").toLowerCase(), folder = `firmware/${base}`
  for (let i = 2; await p.fs.exists(join(p.root, folder)); i++) folder = `firmware/${base}-${i}`
  const blank = blankSketch()
  await saveSketch(p, folder, from ?? { name: base, files: blank.files, diagram: blank.diagram })
  return folder
}
