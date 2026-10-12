// Renode (Antmicro, MIT): STM32 / nRF52 boards run their real firmware (ELF) on it. Desktop:
// Tauri renode_* commands (src-tauri/src/renode.rs); browser preview: the dev server (vite-renode.ts).
import { invoke, isTauri } from "@tauri-apps/api/core"

const devServer = !isTauri() && import.meta.env.DEV
const need = () => { if (!isTauri() && !devServer) throw new Error("Renode boards run in the desktop app") }
const post = async <T = unknown>(url: string, body?: unknown): Promise<T> => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error ?? r.statusText)
  return j as T
}

export async function renodeStatus(): Promise<string | null> {
  need()
  if (isTauri()) return invoke<string | null>("renode_status")
  return ((await (await fetch("/api/renode")).json()) as { renode: string | null }).renode
}
export async function installRenode(): Promise<string | null> { if (!isTauri()) throw new Error("Installing Renode needs the desktop app"); return invoke<string | null>("renode_install") }
/** start Renode with the helper loaded; returns the helper's path (to include) */
export async function renodeStart(helper: string): Promise<string> {
  need()
  if (isTauri()) return invoke<string>("renode_start", { helper })
  return (await post<{ helper: string }>("/api/renode/start", { helper })).helper
}
export async function renodeCmd(line: string): Promise<string> {
  if (isTauri()) return invoke<string>("renode_cmd", { line })
  return (await post<{ out: string }>("/api/renode/cmd", { line })).out
}
export async function renodeStage(elf: string): Promise<string> {
  if (isTauri()) return invoke<string>("renode_stage", { elf })
  return (await post<{ path: string }>("/api/renode/stage", { elf })).path
}
export async function renodeStop() { if (isTauri()) await invoke("renode_stop").catch(() => {}); else if (devServer) await post("/api/renode/stop").catch(() => {}) }
