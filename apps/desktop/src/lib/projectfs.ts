// Files for projects and libraries: the real disk in the desktop app (Tauri fs), a virtual
// folder kept in the browser's storage for the web preview, and an in-memory one for tests.
import { isTauri } from "@tauri-apps/api/core"

export interface Entry { name: string; path: string; dir: boolean }

export interface ProjectFS {
  kind: "disk" | "browser" | "memory"
  read(path: string): Promise<string>
  write(path: string, text: string): Promise<void>
  list(dir: string): Promise<Entry[]>
  mkdir(path: string): Promise<void>
  exists(path: string): Promise<boolean>
  remove(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
}

/** Join path pieces with "/" (accepted by every platform Tauri runs on). */
export const join = (...parts: string[]) => parts.filter(Boolean).join("/").replace(/\\/g, "/").replace(/\/{2,}/g, "/")
export const baseName = (p: string) => p.replace(/\/+$/, "").split("/").pop() ?? p
export const dirName = (p: string) => p.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/"
export const stem = (p: string) => baseName(p).replace(/\.[^.]+$/, "")

// ---------------------------------------------------------------- the real disk (desktop)

export const diskFS: ProjectFS = {
  kind: "disk",
  async read(path) { const { readTextFile } = await import("@tauri-apps/plugin-fs"); return readTextFile(path) },
  async write(path, text) {
    const fs = await import("@tauri-apps/plugin-fs")
    const dir = dirName(path)
    if (!(await fs.exists(dir))) await fs.mkdir(dir, { recursive: true })
    await fs.writeTextFile(path, text)
  },
  async list(dir) {
    const { readDir } = await import("@tauri-apps/plugin-fs")
    return (await readDir(dir)).map((e) => ({ name: e.name, path: join(dir, e.name), dir: e.isDirectory })).sort(byName)
  },
  async mkdir(path) { const { mkdir, exists } = await import("@tauri-apps/plugin-fs"); if (!(await exists(path))) await mkdir(path, { recursive: true }) },
  async exists(path) { const { exists } = await import("@tauri-apps/plugin-fs"); return exists(path) },
  async remove(path) { const { remove } = await import("@tauri-apps/plugin-fs"); await remove(path, { recursive: true }) },
  async rename(from, to) { const { rename } = await import("@tauri-apps/plugin-fs"); await rename(from, to) },
}

const byName = (a: Entry, b: Entry) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)

// ---------------------------------------------------------------- virtual folders (web preview, tests)

/** A folder tree in a map; `persist` keeps it in localStorage under that key. */
export function memoryFS(persist?: string, kind: "browser" | "memory" = persist ? "browser" : "memory"): ProjectFS {
  let files: Record<string, string> = {}
  const dirs = new Set<string>(["/"])
  const load = () => {
    if (!persist) return
    try {
      const raw = JSON.parse(localStorage.getItem(persist) ?? "{}") as { files?: Record<string, string>; dirs?: string[] }
      files = raw.files ?? {}
      for (const d of raw.dirs ?? []) dirs.add(d)
    } catch { /* unavailable storage: start empty */ }
  }
  const save = () => { if (persist) try { localStorage.setItem(persist, JSON.stringify({ files, dirs: [...dirs] })) } catch { /* full / blocked */ } }
  const norm = (p: string) => join("/", p).replace(/\/$/, "") || "/"
  const addDirs = (p: string) => { let d = dirName(p); while (d && !dirs.has(d)) { dirs.add(d); d = dirName(d) } }
  load()
  return {
    kind,
    async read(path) { const p = norm(path); if (!(p in files)) throw new Error(`no file ${p}`); return files[p] },
    async write(path, text) { const p = norm(path); files[p] = text; addDirs(p); save() },
    async list(dir) {
      const d = norm(dir), pre = d === "/" ? "/" : `${d}/`
      const out = new Map<string, Entry>()
      for (const p of [...Object.keys(files), ...dirs]) {
        if (!p.startsWith(pre) || p === d) continue
        const rest = p.slice(pre.length), name = rest.split("/")[0]
        if (!name) continue
        const isDir = rest.includes("/") || dirs.has(pre + name)
        out.set(name, { name, path: pre + name, dir: isDir || (out.get(name)?.dir ?? false) })
      }
      return [...out.values()].sort(byName)
    },
    async mkdir(path) { const p = norm(path); addDirs(p); dirs.add(p); save() },
    async exists(path) { const p = norm(path); return p in files || dirs.has(p) },
    async remove(path) {
      const p = norm(path)
      delete files[p]; dirs.delete(p)
      for (const k of Object.keys(files)) if (k.startsWith(`${p}/`)) delete files[k]
      for (const k of [...dirs]) if (k.startsWith(`${p}/`)) dirs.delete(k)
      save()
    },
    async rename(from, to) {
      const a = norm(from), b = norm(to)
      for (const k of Object.keys(files)) if (k === a || k.startsWith(`${a}/`)) { files[b + k.slice(a.length)] = files[k]; delete files[k] }
      for (const k of [...dirs]) if (k === a || k.startsWith(`${a}/`)) { dirs.delete(k); dirs.add(b + k.slice(a.length)) }
      addDirs(b + "/x"); save()
    },
  }
}

/** The file system the app uses: the disk in the desktop app, a browser-kept one otherwise. */
let shared: ProjectFS | null = null
export function appFS(): ProjectFS { return (shared ??= isTauri() ? diskFS : memoryFS("sb-virtual-fs")) }

/** Where projects and libraries live by default: ~/Documents/Space Bench/{Projects,Libraries}. */
export async function homeFolders(): Promise<{ projects: string; libraries: string }> {
  if (isTauri()) {
    const { documentDir } = await import("@tauri-apps/api/path")
    const docs = await documentDir()
    return { projects: join(docs, "Space Bench", "Projects"), libraries: join(docs, "Space Bench", "Libraries") }
  }
  return { projects: "/Space Bench/Projects", libraries: "/Space Bench/Libraries" }
}
