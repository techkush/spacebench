// Open a web link (datasheets …) in the system browser — the desktop app doesn't follow target="_blank".
import { isTauri } from "@tauri-apps/api/core"

export async function openExternal(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener")
    await openUrl(url)
  } else window.open(url, "_blank", "noopener,noreferrer")
}
