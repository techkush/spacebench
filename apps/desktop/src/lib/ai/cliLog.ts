// What the `claude` command printed, for the dock's Terminal tab. The AI chat writes,
// the terminal reads; kept outside React so both can live in different parts of the UI.
import { useSyncExternalStore } from "react"

import type { CliLine } from "./claudecode"

const MAX = 400
let lines: CliLine[] = []
const subs = new Set<() => void>()
const emit = () => subs.forEach((f) => f())

export const cliLog = {
  push(l: CliLine) { lines = [...lines.slice(-(MAX - 1)), l]; emit() },
  clear() { if (lines.length) { lines = []; emit() } },
}

export function useCliLog(): CliLine[] {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f) }, () => lines)
}
