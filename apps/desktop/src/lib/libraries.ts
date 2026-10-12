// The user's component libraries, shared by all projects: one folder each in
// ~/Documents/Space Bench/Libraries/<Name>/<Name>.kirk. A library file starts with
//   library <Name> version "1.0.0"
// and holds component definitions. Projects use one with  import library "<Name>".
import { componentsOf, type ComponentDef } from "@/kirk/components"
import { parse } from "@/kirk/parser"
import { join, type ProjectFS } from "./projectfs"

export interface LibraryInfo {
  name: string
  version?: string
  description?: string
  components: Pick<ComponentDef, "name" | "params" | "pins" | "description">[]
  /** problems reading it (shown in the manager) */
  errors: string[]
  file: string
}

export const libraryFile = (root: string, name: string) => join(root, name, `${name}.kirk`)

/** Every library in the user's libraries folder. */
export async function listLibraries(fs: ProjectFS, root: string): Promise<LibraryInfo[]> {
  if (!(await fs.exists(root))) return []
  const out: LibraryInfo[] = []
  for (const e of await fs.list(root)) {
    if (!e.dir) continue
    const file = libraryFile(root, e.name)
    if (!(await fs.exists(file))) continue
    out.push(describeLibrary(e.name, await fs.read(file), file))
  }
  return out
}

/** What a library file contains. */
export function describeLibrary(folderName: string, text: string, file: string): LibraryInfo {
  const r = parse(text)
  const head = r.file.items.find((i) => i.k === "library") as { name: string; version?: string } | undefined
  const desc = /^\s*\/\/\s*(.+)$/m.exec(text.split("\n").slice(0, 6).join("\n"))?.[1]
  return {
    name: head?.name ?? folderName, version: head?.version, description: desc,
    components: componentsOf(r.file, text).map(({ name, params, pins, description }) => ({ name, params, pins, description })),
    errors: r.diagnostics.map((d) => d.message),
    file,
  }
}

const STARTER = (name: string, description?: string) => `library ${name} version "0.1.0"
// ${description ?? `${name} — my components`}

component Divider(total: Resistance = 10k, ratio: Number = 0.5) {
    description "resistive divider: out = ratio × in"
    pins in, out, gnd
    RT = R(total * (1 - ratio))
    RB = R(total * ratio)
    in -- RT -- out -- RB -- gnd
}
`

export async function createLibrary(fs: ProjectFS, root: string, name: string, description?: string): Promise<string> {
  const id = name.trim()
  if (!/^[A-Za-z_]\w*$/.test(id)) throw new Error("A library name is one word: letters, digits and _ (e.g. MyFilters)")
  const file = libraryFile(root, id)
  if (await fs.exists(file)) throw new Error(`There is already a library called ${id}`)
  await fs.write(file, STARTER(id, description))
  return file
}

/** Raise the version in the library line: 1.2.3 → 1.2.4 (patch), 1.3.0 (minor) or 2.0.0 (major). */
export function bumpVersion(text: string, part: "major" | "minor" | "patch"): string {
  return text.replace(/^(\s*library\s+\w+\s+version\s+")(\d+)\.(\d+)\.(\d+)(")/m, (_m, a, ma, mi, pa, z) => {
    const [M, m, p] = [Number(ma), Number(mi), Number(pa)]
    const v = part === "major" ? `${M + 1}.0.0` : part === "minor" ? `${M}.${m + 1}.0` : `${M}.${m}.${p + 1}`
    return `${a}${v}${z}`
  })
}

/** Copy a user library into a project's lib/ folder (so the project carries it). */
export async function copyIntoProject(fs: ProjectFS, librariesRoot: string, name: string, projectRoot: string, projectFs: ProjectFS = fs): Promise<string> {
  const text = await fs.read(libraryFile(librariesRoot, name))
  const rel = `lib/${name.toLowerCase()}.kirk`
  await projectFs.write(join(projectRoot, rel), text)
  return rel
}
