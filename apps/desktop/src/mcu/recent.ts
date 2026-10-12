// Recently used microcontroller sketches, for the Start screen (newest first).
import { useSyncExternalStore } from "react"
import type { Diagram } from "./diagram"

export interface RecentSketch {
  /** absolute folder path — the identity */
  path: string
  name: string
  /** where saving writes: root + folder (a project root and "firmware/x", or the Sketches folder and "x") */
  root: string
  folder: string
  /** the project it belongs to (its name), if any */
  project?: string
  board: string
  parts: number
  time: number
  diagram: Diagram
}

const KEY = "sb-recent-sketches"
const MAX = 24
const load = (): RecentSketch[] => { try { return JSON.parse(localStorage.getItem(KEY) ?? "[]") } catch { return [] } }
let list: RecentSketch[] = load()
const listeners = new Set<() => void>()
const emit = () => { try { localStorage.setItem(KEY, JSON.stringify(list)) } catch { /* full or blocked */ } for (const l of listeners) l() }

export function rememberSketch(s: Omit<RecentSketch, "time">) {
  list = [{ ...s, time: Date.now() }, ...list.filter((x) => x.path !== s.path)].slice(0, MAX)
  emit()
}
export function forgetSketch(path: string) { list = list.filter((x) => x.path !== path); emit() }
export const recentSketches = () => list
export function useRecentSketches(): RecentSketch[] {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l) } }, () => list)
}
