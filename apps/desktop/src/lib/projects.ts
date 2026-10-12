// Recent projects for the Start screen. Each entry keeps a snapshot of the
// circuit (for the thumbnail, and to reopen drafts that were never saved).
import { useSyncExternalStore } from "react"

import { isVirtual, type Doc } from "@/editor/model"

export interface RecentProject {
  id: string
  title: string
  /** file on disk (desktop app); null for an unsaved draft */
  path: string | null
  time: number
  parts: number
  analysis: Doc["defaultAnalysis"]
  simulated: boolean
  doc: Doc
  /** a circuit of a project: the project folder and the circuit file in it */
  folder?: string
  circuit?: string
}

const KEY = "sb-recent-projects"
let list: RecentProject[] = (() => { try { return JSON.parse(localStorage.getItem(KEY) ?? "[]") } catch { return [] } })()
const listeners = new Set<() => void>()

function save(next: RecentProject[]) {
  list = next
  try { localStorage.setItem(KEY, JSON.stringify(list)) } catch {
    // quota: drop the oldest snapshots and try again
    try { list = list.slice(0, Math.max(1, Math.floor(list.length / 2))); localStorage.setItem(KEY, JSON.stringify(list)) } catch { /* storage unavailable */ }
  }
  listeners.forEach((l) => l())
}

/** Same project = same file, or (for drafts) the same session id. */
export function rememberProject(p: Omit<RecentProject, "time" | "parts"> & { time?: number }, limit = 12) {
  const entry: RecentProject = { ...p, time: p.time ?? Date.now(), parts: p.doc.parts.filter((x) => !isVirtual(x)).length }
  if (!entry.parts && !entry.path) return // nothing worth remembering
  const rest = list.filter((x) => x.id !== entry.id && !(entry.path && x.path === entry.path))
  save([entry, ...rest].slice(0, Math.max(1, limit)))
}

export function forgetProject(id: string) { save(list.filter((x) => x.id !== id)) }
export function clearProjects() { save([]) }
export function getProjects() { return list }

export function useProjects(): RecentProject[] {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l) } }, () => list)
}

/** "2 min ago", "Yesterday", "3 days ago", "Last week", or a date. */
export function timeAgo(t: number, now = Date.now()): string {
  const s = Math.max(0, (now - t) / 1000)
  if (s < 60) return "Just now"
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  const d = Math.floor(s / 86400)
  if (d === 1) return "Yesterday"
  if (d < 7) return `${d} days ago`
  if (d < 14) return "Last week"
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: new Date(t).getFullYear() === new Date(now).getFullYear() ? undefined : "numeric" })
}
