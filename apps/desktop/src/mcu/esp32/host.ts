// The ESP32 runs in a QEMU process (desktop: Tauri commands; browser preview: the dev server).
import { invoke, isTauri } from "@tauri-apps/api/core"

export interface EspPoll { serial: string; bridge: number[]; running: boolean; log: string }
const devServer = !isTauri() && import.meta.env.DEV
const post = async (url: string, body?: unknown) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) })
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText)
}
const need = () => { if (!isTauri() && !devServer) throw new Error("The ESP32 runs in the desktop app (Espressif's QEMU)") }

export async function qemuStatus(bin?: string): Promise<string> {
  need()
  if (isTauri()) return invoke<string>("esp32_status", { bin: bin || null })
  const r = await fetch("/api/esp32"); const j = await r.json()
  if (!r.ok) throw new Error(j.error); return j.version
}
export async function installQemu(): Promise<string> { if (!isTauri()) throw new Error("Installing QEMU needs the desktop app"); return invoke<string>("esp32_install") }
/** machine: "esp32" (default), "esp32s3" or "esp32c3" */
export async function espStart(image: string, bin?: string, machine = "esp32") { need(); if (isTauri()) await invoke("esp32_start", { image, bin: bin || null, machine }); else await post("/api/esp32/start", { image, machine }) }
export async function espPoll(): Promise<EspPoll> {
  if (isTauri()) return invoke<EspPoll>("esp32_poll")
  return (await fetch("/api/esp32/poll")).json()
}
export async function espSend(serial?: string, bridge?: number[]) { if (isTauri()) await invoke("esp32_send", { serial: serial ?? null, bridge: bridge ?? null }); else await post("/api/esp32/send", { serial, bridge }) }
/** "stop" pauses the chip (and its clock), "cont" resumes it — schematics run it in lockstep */
export async function espQmp(cmd: "stop" | "cont") { if (isTauri()) await invoke("esp32_qmp", { cmd }); else await post("/api/esp32/qmp", { cmd }) }
export async function espStop() { if (isTauri()) await invoke("esp32_stop").catch(() => {}); else if (devServer) await post("/api/esp32/stop").catch(() => {}) }
