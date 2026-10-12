// App preferences (Settings screen), kept in localStorage and shared through a
// tiny store. Simulation options are pushed into the netlister / engine on change.
import { useSyncExternalStore } from "react"

export type ThemePref = "light" | "dark" | "system"
export type IntegrationMethod = "trap" | "gear"

export interface Settings {
  // General
  openOnLaunch: "start" | "last" | "blank"
  confirmDiscard: boolean
  recentLimit: number
  newAnalysis: "tran" | "ac" | "op"
  // Appearance
  theme: ThemePref
  overlayFlow: boolean
  overlayVolt: boolean
  overlayTags: boolean
  minimap: boolean
  // Simulation engine
  ngspicePath: string
  runMode: "realtime" | "accurate"
  workers: number
  reltol: string
  abstol: string
  vntol: string
  gmin: string
  method: IntegrationMethod
  autoRecover: boolean
  saveCurrents: boolean
  // Kirk
  kirkView: "schematic" | "split" | "code"
  kirkDelay: number
  kirkInline: boolean
  // Instruments
  playbackSpeed: "fit" | "1" | "0.1" | "0.01" | "0.001"
  autoDmm: boolean
  scopeOnProbe: boolean
  // AI assistant (Anthropic Claude, the user's own API key)
  /** "claude-code": the user's `claude` CLI login (no key); "api": an Anthropic API key */
  aiProvider: "claude-code" | "api"
  aiCliModel: string
  aiCliPath: string
  /** speakers and buzzers play their simulated signal through the computer */
  outputSound: boolean
  /** which ngspice back end runs simulations (desktop app) */
  engineKind: "auto" | "library" | "program"
  aiKey: string
  aiModel: string
  aiAutoSimulate: boolean
  // Microcontrollers
  arduinoCliPath: string
  /** Espressif's qemu-system-xtensa (empty = find it) */
  esp32QemuPath: string
  /** simulation speed cap (1 = real time) */
  mcuSpeed: number
}

export const DEFAULTS: Settings = {
  openOnLaunch: "start", confirmDiscard: true, recentLimit: 12, newAnalysis: "tran",
  theme: "system", overlayFlow: true, overlayVolt: true, overlayTags: true, minimap: false,
  ngspicePath: "", runMode: "realtime", workers: Math.max(1, Math.min(8, (globalThis.navigator?.hardwareConcurrency ?? 8) - 2)),
  reltol: "1e-3", abstol: "1p", vntol: "1u", gmin: "1e-12", method: "trap", autoRecover: true, saveCurrents: true,
  kirkView: "split", kirkDelay: 250, kirkInline: true,
  playbackSpeed: "fit", autoDmm: true, scopeOnProbe: true,
  aiProvider: "claude-code", aiCliModel: "sonnet", aiCliPath: "", outputSound: true, engineKind: "auto",
  aiKey: "", aiModel: "claude-sonnet-5-5", aiAutoSimulate: true,
  arduinoCliPath: "", esp32QemuPath: "", mcuSpeed: 1,
}

const KEY = "sb-settings"
function load(): Settings {
  try {
    const s = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") }
    // the old theme toggle stored its own key
    const old = localStorage.getItem("sb-theme")
    if (!localStorage.getItem(KEY) && (old === "dark" || old === "light")) s.theme = old
    return s
  } catch { return { ...DEFAULTS } }
}

let current: Settings = load()
const listeners = new Set<() => void>()

export function getSettings(): Settings { return current }

export function setSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch }
  try { localStorage.setItem(KEY, JSON.stringify(current)) } catch { /* storage unavailable */ }
  listeners.forEach((l) => l())
}

export function resetSettings(keys?: (keyof Settings)[]) {
  const patch: Partial<Settings> = {}
  for (const k of keys ?? (Object.keys(DEFAULTS) as (keyof Settings)[])) (patch as Record<string, unknown>)[k] = DEFAULTS[k]
  setSettings(patch)
}

export function subscribeSettings(l: () => void) { listeners.add(l); return () => { listeners.delete(l) } }

export function useSettings(): Settings {
  return useSyncExternalStore(subscribeSettings, () => current)
}

/** Light or dark, after resolving "system". */
export function resolvedDark(pref: ThemePref): boolean {
  if (pref !== "system") return pref === "dark"
  try { return matchMedia("(prefers-color-scheme: dark)").matches } catch { return false }
}
