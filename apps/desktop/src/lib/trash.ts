// Space Bench's Trash: ~/Documents/Space Bench/Trash. Deleting moves a folder here (with a
// note of where it came from); from the Trash it can be restored or deleted forever.
//   Trash/<id>/item/        the folder that was deleted
//   Trash/<id>/trash.json   { name, kind, original, time }
import { baseName, dirName, join, type ProjectFS } from "./projectfs"

export interface TrashItem { id: string; name: string; kind: "sketch" | "project" | "library" | "folder"; original: string; time: number; path: string }

/** Move `path` (a folder) to the Trash. Returns the trash entry. */
export async function moveToTrash(fs: ProjectFS, trashRoot: string, path: string, kind: TrashItem["kind"], name = baseName(path)): Promise<TrashItem> {
  if (!(await fs.exists(path))) throw new Error(`${path} does not exist`)
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const dir = join(trashRoot, id)
  await fs.mkdir(dir)
  await fs.rename(path, join(dir, "item"))
  const meta = { name, kind, original: path, time: Date.now() }
  await fs.write(join(dir, "trash.json"), JSON.stringify(meta, null, 2) + "\n")
  return { id, path: dir, ...meta }
}

/** What's in the Trash, newest first. */
export async function listTrash(fs: ProjectFS, trashRoot: string): Promise<TrashItem[]> {
  if (!(await fs.exists(trashRoot))) return []
  const out: TrashItem[] = []
  for (const e of await fs.list(trashRoot)) {
    if (!e.dir) continue
    try { out.push({ id: e.name, path: e.path, ...JSON.parse(await fs.read(join(e.path, "trash.json"))) }) } catch { /* not a trash entry */ }
  }
  return out.sort((a, b) => b.time - a.time)
}

/** Put it back where it was (beside it, "name (restored)", if that place is taken). Returns the path. */
export async function restoreFromTrash(fs: ProjectFS, item: TrashItem): Promise<string> {
  let to = item.original
  for (let i = 1; await fs.exists(to); i++) to = join(dirName(item.original), `${baseName(item.original)} (restored${i > 1 ? ` ${i}` : ""})`)
  await fs.mkdir(dirName(to))
  await fs.rename(join(item.path, "item"), to)
  await fs.remove(item.path)
  return to
}

export async function deleteForever(fs: ProjectFS, item: TrashItem): Promise<void> { await fs.remove(item.path) }

export async function emptyTrash(fs: ProjectFS, trashRoot: string): Promise<number> {
  const items = await listTrash(fs, trashRoot)
  for (const it of items) await fs.remove(it.path)
  return items.length
}
