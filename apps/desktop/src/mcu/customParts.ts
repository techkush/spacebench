// Imported parts (Fritzing .fzpz) live in ~/Documents/Space Bench/Parts/<type>.json; at start-up
// each becomes a web component and an entry in the parts list ("Imported").
import { join, type ProjectFS } from "@/lib/projectfs"
import { definePart, partFromFzpz, type FzPart, type ParseXml } from "./fritzing"
import { PARTS } from "./parts"

const browserParse: ParseXml = (t) => new DOMParser().parseFromString(t, "image/svg+xml") as never
const listeners = new Set<() => void>()
export const onPartsChanged = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }

function register(p: FzPart) {
  definePart(p)
  const i = PARTS.findIndex((x) => x.type === p.type)
  const info = { type: p.type, title: p.title, category: "Imported" as const, hint: `${p.pins.length} pins · imported from Fritzing${p.author ? ` (${p.author})` : ""}` }
  if (i >= 0) PARTS[i] = info; else PARTS.push(info)
  for (const l of listeners) l()
}

export async function loadImportedParts(fs: ProjectFS, root: string): Promise<FzPart[]> {
  if (!(await fs.exists(root))) return []
  const out: FzPart[] = []
  for (const e of await fs.list(root)) {
    if (e.dir || !e.name.endsWith(".json")) continue
    try { const p = JSON.parse(await fs.read(e.path)) as FzPart; register(p); out.push(p) } catch { /* not a part */ }
  }
  return out
}

/** Import a .fzpz the user picked; saved for every sketch. */
export async function importFritzing(file: File, fs: ProjectFS, root: string): Promise<FzPart> {
  const p = partFromFzpz(new Uint8Array(await file.arrayBuffer()), browserParse, file.name)
  if (!p.pins.length) throw new Error(`${p.title}: no connectors were found in its breadboard picture`)
  await fs.write(join(root, `${p.type}.json`), JSON.stringify(p))
  register(p)
  return p
}

export async function removeImportedPart(fs: ProjectFS, root: string, type: string) {
  await fs.remove(join(root, `${type}.json`))
  const i = PARTS.findIndex((x) => x.type === type)
  if (i >= 0) PARTS.splice(i, 1)
  for (const l of listeners) l()
}
