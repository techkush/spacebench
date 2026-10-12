// The Lab window and the main window talk over a BroadcastChannel (same origin, both in the
// desktop app and in a browser): the main window sends the open circuit, the Lab sends back
// the stimulus it edits, so the feeds are saved with the circuit and show in its Kirk code.
import { isTauri } from "@tauri-apps/api/core"
import type { Doc } from "@/editor/model"
import type { Stimulus } from "./stimulus"

export type LabMessage =
  | { type: "hello" }
  | { type: "circuit"; doc: Doc; errors: string[]; path: string | null }
  | { type: "closed" }
  | { type: "stimulus"; stimulus: Stimulus | undefined }
  | { type: "focus-main" }

const NAME = "spacebench-lab"

export function labChannel(onMessage: (m: LabMessage) => void): { send: (m: LabMessage) => void; close: () => void } {
  if (typeof BroadcastChannel === "undefined") return { send: () => {}, close: () => {} }
  const ch = new BroadcastChannel(NAME)
  ch.onmessage = (e: MessageEvent<LabMessage>) => onMessage(e.data)
  return { send: (m) => ch.postMessage(m), close: () => ch.close() }
}

export const isLabWindow = () => new URLSearchParams(location.search).get("view") === "lab"

/** Open the Lab in its own window (or bring it to the front). */
export async function openLabWindow(): Promise<void> {
  const url = `${location.pathname}?view=lab`
  if (isTauri()) {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow")
    const open = await WebviewWindow.getByLabel("lab")
    if (open) { await open.unminimize().catch(() => {}); await open.show().catch(() => {}); await open.setFocus(); return }
    const w = new WebviewWindow("lab", { url, title: "Space Bench Lab", width: 1360, height: 860, minWidth: 900, minHeight: 600, center: true, titleBarStyle: "overlay", hiddenTitle: true })
    await new Promise<void>((resolve, reject) => { w.once("tauri://created", () => resolve()); w.once("tauri://error", (e) => reject(new Error(String(e.payload)))) })
    return
  }
  const w = window.open(url, "spacebench-lab", "width=1360,height=860")
  w?.focus()
}
