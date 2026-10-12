// Projects: one folder that holds everything about a design.
//
//   MyProject/
//     MyProject.sbproj          manifest (name, main circuit, dates)
//     README.md                 what's where
//     circuits/main.kirk        a circuit: code + schematic layout + feeds — the source of truth
//     lib/*.kirk                component libraries of this project
//     pcb/main.board.json       board layout of circuits/main.kirk
//     firmware/<name>/          a microcontroller sketch: sketch.ino, diagram.json (wiring, Wokwi format), libraries.txt
//     models/                   SPICE model files
//     results/                  exported runs (Lab, Analysis)
//     .spacebench/main.json     cache: the exact document, for fast lossless opening
import type { Doc } from "@/editor/model"
import { deriveNetlist } from "@/editor/netlist"
import { compileKirk, type CompileOptions } from "@/kirk/compile"
import { generateKirk } from "@/kirk/generate"
import { libraryFile } from "./libraries"
import { baseName, join, stem, type Entry, type ProjectFS } from "./projectfs"

export interface Manifest {
  format: "spacebench.project"
  version: 1
  name: string
  description?: string
  /** the circuit that opens with the project (relative to the project folder) */
  main: string
  created: string
  modified: string
}
export interface Project { fs: ProjectFS; root: string; manifest: Manifest }

export const FOLDERS = ["circuits", "firmware", "lib", "pcb", "models", "results", ".spacebench"] as const
const README = (name: string) => `# ${name}

A Space Bench project.

| Folder | What's in it |
|---|---|
| \`circuits/\` | circuits as Kirk code (\`.kirk\`): parts, connections, schematic layout, feeds |
| \`firmware/\` | microcontroller sketches, one folder each: \`sketch.ino\`, \`diagram.json\` (wiring, Wokwi format), \`libraries.txt\` |
| \`lib/\` | this project's component libraries (\`component …\` definitions) |
| \`pcb/\` | board layouts, one per circuit |
| \`models/\` | SPICE model files (\`.lib\`, \`.mod\`) |
| \`results/\` | exported runs — Lab and Analysis exports |
| \`.spacebench/\` | caches; safe to delete |
`

export const safeName = (s: string) => s.trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").slice(0, 80) || "Untitled"
const now = () => new Date().toISOString()
const hash = (s: string) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0).toString(36) }

const STARTER = (title: string) => `@title(${JSON.stringify(title)})
circuit Main {
    ground GND
    V1 = Vdc(5 V)
    R1 = R(1k)
    R2 = R(1k)
    IN -- V1 -- GND
    IN -- R1 -- OUT -- R2 -- GND
}

simulate op
`

/** Create the folder structure; the main circuit is `kirk` (or a starter). */
export async function createProject(fs: ProjectFS, parent: string, name: string, kirk?: string, description?: string): Promise<Project> {
  const clean = safeName(name)
  const root = join(parent, clean)
  if (await fs.exists(join(root, `${clean}.sbproj`))) throw new Error(`A project called “${clean}” already exists there`)
  for (const f of FOLDERS) await fs.mkdir(join(root, f))
  const manifest: Manifest = { format: "spacebench.project", version: 1, name: clean, ...(description ? { description } : {}), main: "circuits/main.kirk", created: now(), modified: now() }
  await fs.write(join(root, `${clean}.sbproj`), JSON.stringify(manifest, null, 2) + "\n")
  await fs.write(join(root, "README.md"), README(clean))
  await fs.write(join(root, manifest.main), kirk ?? STARTER(clean))
  return { fs, root, manifest }
}

/** Open the project in `root` (a folder, or the path of its .sbproj file). */
export async function openProject(fs: ProjectFS, path: string): Promise<Project> {
  let root = path, file = ""
  if (path.endsWith(".sbproj")) { file = path; root = path.slice(0, path.length - baseName(path).length).replace(/\/$/, "") }
  else file = (await fs.list(root)).find((e) => !e.dir && e.name.endsWith(".sbproj"))?.path ?? ""
  if (!file) throw new Error("No Space Bench project here (no .sbproj file)")
  const manifest = JSON.parse(await fs.read(file)) as Manifest
  if (manifest.format !== "spacebench.project") throw new Error("Not a Space Bench project file")
  return { fs, root, manifest }
}

export async function saveManifest(p: Project): Promise<void> {
  p.manifest.modified = now()
  const file = (await p.fs.list(p.root)).find((e) => !e.dir && e.name.endsWith(".sbproj"))?.path ?? join(p.root, `${p.manifest.name}.sbproj`)
  await p.fs.write(file, JSON.stringify(p.manifest, null, 2) + "\n")
}

export interface TreeNode extends Entry { children?: TreeNode[] }
/** The project's files (caches hidden). */
export async function projectTree(p: Project, dir = p.root): Promise<TreeNode[]> {
  const out: TreeNode[] = []
  for (const e of await p.fs.list(dir)) {
    if (e.name === ".spacebench" || e.name.startsWith(".")) continue
    out.push(e.dir ? { ...e, children: await projectTree(p, e.path) } : e)
  }
  return out
}

export const rel = (p: Project, abs: string) => (abs.startsWith(p.root) ? abs.slice(p.root.length).replace(/^\//, "") : abs)

/** Imports inside a project: "lib/filters.kirk" from the project folder, library "Filters" from the user's libraries. */
export function projectResolver(p: Project | null, libraries: { fs: ProjectFS; root: string } | null): NonNullable<CompileOptions["resolve"]> {
  return async (path, library) => {
    if (library) {
      if (!libraries) return null
      const file = libraryFile(libraries.root, path)
      return (await libraries.fs.exists(file)) ? { text: await libraries.fs.read(file), path: `library:${path}` } : null
    }
    if (!p) return null
    const file = join(p.root, path.replace(/^\.\//, ""))
    return (await p.fs.exists(file)) ? { text: await p.fs.read(file), path } : null
  }
}

const cachePath = (p: Project, circuit: string) => join(p.root, ".spacebench", `${stem(circuit)}.json`)
const pcbPath = (p: Project, circuit: string) => join(p.root, "pcb", `${stem(circuit)}.board.json`)

/** Open a circuit of the project: the cached document when the code hasn't changed, else compile it. */
export async function loadCircuit(p: Project, circuit: string, resolve: CompileOptions["resolve"]): Promise<{ doc: Doc; text: string; diagnostics: { severity: string; message: string }[] }> {
  const text = await p.fs.read(join(p.root, circuit))
  let doc: Doc | null = null
  try {
    const cache = JSON.parse(await p.fs.read(cachePath(p, circuit))) as { hash: string; doc: Doc }
    if (cache.hash === hash(text)) doc = cache.doc
  } catch { /* no cache yet */ }
  let diagnostics: { severity: string; message: string }[] = []
  if (!doc) {
    const r = await compileKirk(text, null, { resolve })
    diagnostics = r.diagnostics
    if (!r.doc) throw new Error(`${circuit}: ${r.diagnostics.find((d) => d.severity === "error")?.message ?? "can't read it"}`)
    doc = r.doc
  }
  try { doc = { ...doc, pcb: JSON.parse(await p.fs.read(pcbPath(p, circuit))) } } catch { /* no board yet */ }
  return { doc, text, diagnostics }
}

/** Save a circuit: its Kirk code (as typed, or generated from the drawing), its board and the cache. */
export async function saveCircuit(p: Project, circuit: string, doc: Doc, code?: string): Promise<void> {
  const text = code ?? generateKirk(doc, deriveNetlist(doc))
  await p.fs.write(join(p.root, circuit), text)
  if (doc.pcb) await p.fs.write(pcbPath(p, circuit), JSON.stringify(doc.pcb))
  const { pcb: _pcb, ...rest } = doc
  await p.fs.write(cachePath(p, circuit), JSON.stringify({ hash: hash(text), doc: rest }))
  await saveManifest(p)
}

/** A new circuit file in circuits/. */
export async function newCircuit(p: Project, name: string): Promise<string> {
  const file = `circuits/${safeName(name).replace(/\s+/g, "-").toLowerCase()}.kirk`
  if (await p.fs.exists(join(p.root, file))) throw new Error(`${file} already exists`)
  await p.fs.write(join(p.root, file), STARTER(name))
  return file
}

/** A new component library file in lib/. */
export async function newLibraryFile(p: Project, name: string): Promise<string> {
  const id = safeName(name).replace(/[^\w]/g, "")
  const file = `lib/${id.toLowerCase()}.kirk`
  if (await p.fs.exists(join(p.root, file))) throw new Error(`${file} already exists`)
  await p.fs.write(join(p.root, file), LIBRARY_STARTER(id || "MyParts"))
  return file
}

export const LIBRARY_STARTER = (name: string) => `library ${name} version "0.1.0"

// Components are reusable parts. Use one in a circuit with
//   import "lib/${name.toLowerCase()}.kirk"      (in this project)
//   F1 = Divider(ratio: 0.25)

component Divider(total: Resistance = 10k, ratio: Number = 0.5) {
    description "resistive divider: out = ratio × in"
    pins in, out, gnd
    RT = R(total * (1 - ratio))
    RB = R(total * ratio)
    in -- RT -- out -- RB -- gnd
}
`
