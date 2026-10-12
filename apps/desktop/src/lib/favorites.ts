// Favourite parts, shared by the sidebar and the part browser (kept in localStorage).
import { useSyncExternalStore } from "react"

const KEY = "sb-favorite-parts"
let favs: string[] = (() => { try { return JSON.parse(localStorage.getItem(KEY) ?? "[]") } catch { return [] } })()
const listeners = new Set<() => void>()

export function toggleFavorite(id: string) {
  favs = favs.includes(id) ? favs.filter((f) => f !== id) : [...favs, id]
  try { localStorage.setItem(KEY, JSON.stringify(favs)) } catch { /* storage unavailable */ }
  listeners.forEach((l) => l())
}

export function useFavorites(): string[] {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l) }, () => favs)
}
