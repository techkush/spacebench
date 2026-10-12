// The Linux VM's host side: QEMU on the computer's hypervisor (desktop: Tauri linux_* commands,
// src-tauri/src/linux.rs; browser preview: the dev server, vite-linux.ts). One VM at a time.
import { invoke, isTauri } from "@tauri-apps/api/core"

export interface StartOptions {
  disk: string
  kernel?: string
  initrd?: string
  append?: string
  credentials?: string[]
  memory?: number
  cpus?: number
}
export interface LinuxStatus {
  /** "QEMU emulator version … · path", or null when qemu-system-aarch64 isn't installed */
  qemu: string | null
  dir: string
  files: Record<string, boolean>
  /** written by the setup: how to boot the prepared image */
  boot: { kernel: string; initrd: string; append: string; disk: string; version?: number } | null
}
export interface LinuxPoll { console: string; agent: string; running: boolean; log: string }

const devServer = !isTauri() && import.meta.env.DEV
const need = () => { if (!isTauri() && !devServer) throw new Error("Linux boards run in the desktop app (QEMU)") }
const post = async <T = unknown>(url: string, body?: unknown): Promise<T> => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error ?? r.statusText)
  return j as T
}

export async function linuxStatus(): Promise<LinuxStatus> {
  need()
  if (isTauri()) return invoke<LinuxStatus>("linux_status")
  return (await fetch("/api/linux")).json()
}
export async function linuxFetch(url: string, name: string) { need(); if (isTauri()) await invoke("linux_fetch", { url, name }); else await post("/api/linux/fetch", { url, name }) }
export async function linuxDisk(base: string, name: string, size = "16G") { need(); if (isTauri()) await invoke("linux_disk", { base, name, size }); else await post("/api/linux/disk", { base, name, size }) }
export async function linuxSave(name: string, data: string, append: boolean) { if (isTauri()) await invoke("linux_save", { name, data, append }); else await post("/api/linux/save", { name, data, append }) }
export async function linuxStart(o: StartOptions) { need(); if (isTauri()) await invoke("linux_start", { opts: o }); else await post("/api/linux/start", o) }
export async function linuxPoll(): Promise<LinuxPoll> { if (isTauri()) return invoke<LinuxPoll>("linux_poll"); return (await fetch("/api/linux/poll")).json() }
export async function linuxSend(o: { console?: string; agent?: string }) { if (isTauri()) await invoke("linux_send", { console: o.console ?? null, agent: o.agent ?? null }); else await post("/api/linux/send", o) }
/** "stop" pauses the VM (its clock too), "cont" resumes it */
export async function linuxQmp(cmd: "stop" | "cont" | "system_powerdown") { if (isTauri()) await invoke("linux_qmp", { cmd }); else await post("/api/linux/qmp", { cmd }) }
/** Install a Homebrew package (qemu, arduino-cli) — only after the user agreed. Returns brew's last lines. */
export async function brewInstall(pkg: "qemu" | "arduino-cli"): Promise<string> {
  if (isTauri()) return invoke<string>("brew_install", { pkg })
  if (!devServer) throw new Error("Installing needs the desktop app")
  return (await post<{ text: string }>("/api/linux/brew", { pkg })).text
}
export async function linuxStop() { if (isTauri()) await invoke("linux_stop").catch(() => {}); else if (devServer) await post("/api/linux/stop").catch(() => {}) }
