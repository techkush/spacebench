// What the open project's boards need on this computer — arduino-cli and the board's core, QEMU
// and the Raspberry Pi system, Renode, Espressif's QEMU — and how to install each one. The
// assistant reads this to fix a project that won't build or run; every install is something the
// user agrees to first (the workspace asks).
import type { BoardDef } from "./boards"
import { cliStatus, coreOf, installCore } from "./compile"
import type { LinuxBoardId } from "@/linux/agent"

export interface SetupItem {
  /** what install() takes: "arduino-cli", "core:arduino:avr", "qemu", "pi-system", "renode", "esp32-qemu" */
  id: string
  label: string
  ok: boolean
  /** version / path when present, the problem when not */
  detail: string
  /** what installing it does (download size, time) — for the permission prompt */
  install?: string
}

const err = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * A Raspberry Pi shell command that installs, removes or changes the system — the user is asked
 * first. Read-only checks (pip list / show, apt list, ls, python3 -c …) are not.
 */
export const CHANGES_SYSTEM = /\b(sudo|curl|wget|dpkg\s+-[iPr]|snap\s+(install|remove)|npm\s+(i|install|uninstall)\b|apt(-get)?\s+(install|reinstall|remove|purge|upgrade|dist-upgrade|full-upgrade|autoremove)|pip3?\s+(install|uninstall|download)|-m\s+pip\s+(install|uninstall|download))/

/** `partTypes`: the project's parts — a Camera Module / ReSpeaker on a Pi adds its add-on. */
export async function checkSetup(boards: BoardDef[], cliPath?: string, partTypes: string[] = []): Promise<SetupItem[]> {
  const out: SetupItem[] = []
  const chips = new Set(boards.map((b) => b.chip))
  const sketches = boards.filter((b) => b.chip !== "linux")
  if (sketches.length) {
    let cores: string[] | null = null
    try {
      const st = await cliStatus(cliPath)
      cores = st.cores
      out.push({ id: "arduino-cli", label: "arduino-cli (compiles sketches)", ok: true, detail: `${st.version} · ${st.path}` })
    } catch (e) {
      out.push({ id: "arduino-cli", label: "arduino-cli (compiles sketches)", ok: false, detail: err(e), install: "brew install arduino-cli (Homebrew, about 40 MB)" })
    }
    for (const core of new Set(sketches.map((b) => coreOf(b.fqbn)))) {
      const big = core === "esp32:esp32" || core === "rp2040:rp2040" || core.startsWith("STMicroelectronics")
      out.push(cores?.includes(core)
        ? { id: `core:${core}`, label: `${core} board core`, ok: true, detail: "installed" }
        : { id: `core:${core}`, label: `${core} board core`, ok: false, detail: cores ? "not installed" : "needs arduino-cli first", install: `arduino-cli core install ${core} (${big ? "300–600 MB, several minutes" : "about 50 MB"})` })
    }
  }
  if (chips.has("linux")) {
    try {
      const { linuxStatus } = await import("@/linux/host")
      const { GUEST_VERSION } = await import("@/linux/provision")
      const st = await linuxStatus()
      out.push(st.qemu
        ? { id: "qemu", label: "QEMU (runs the Raspberry Pi)", ok: true, detail: st.qemu }
        : { id: "qemu", label: "QEMU (runs the Raspberry Pi)", ok: false, detail: "qemu-system-aarch64 not found", install: "brew install qemu (Homebrew, about 600 MB)" })
      const old = st.boot && (st.boot.version ?? 0) < GUEST_VERSION
      out.push(st.boot && !old
        ? { id: "pi-system", label: "Raspberry Pi system (Debian 13 + gpiozero)", ok: true, detail: `set up in ${st.dir}` }
        : { id: "pi-system", label: "Raspberry Pi system (Debian 13 + gpiozero)", ok: false, detail: old ? "set up by an older Space Bench — needs setting up again" : "not set up yet", install: "download Debian 13 for arm64 and prepare it as a Raspberry Pi (about 1 GB, 5–10 minutes)" })
      // the camera / microphone parts on a Pi need an add-on in its system (src/linux/media.ts)
      const { CAMERA_PART, MIC_PART } = await import("@/linux/media")
      const cam = partTypes.includes(CAMERA_PART), mic = partTypes.includes(MIC_PART)
      if (cam || mic) {
        const camItem = { id: "pi-camera", label: "Raspberry Pi camera add-on (Camera Module → /dev/video0)", install: "install v4l2loopback (built for the Pi's kernel) and v4l-utils in the Raspberry Pi system (about 5 MB, under a minute)" }
        const micItem = { id: "pi-audio", label: "Raspberry Pi audio add-on (ReSpeaker → a sound card)", install: "install alsa-utils (aplay / arecord) in the Raspberry Pi system (about 2 MB)" }
        if (!st.boot || old) {
          if (cam) out.push({ ...camItem, ok: false, detail: "needs the Raspberry Pi system first" })
          if (mic) out.push({ ...micItem, ok: false, detail: "needs the Raspberry Pi system first" })
        } else {
          try {
            const { mediaStatus } = await import("@/linux/media")
            const pi = boards.find((b) => b.chip === "linux")
            const has = await mediaStatus((pi?.linux ?? "pi5") as LinuxBoardId)
            if (cam) out.push(has.camera ? { ...camItem, ok: true, detail: "installed" } : { ...camItem, ok: false, detail: "not installed" })
            if (mic) out.push(has.audio ? { ...micItem, ok: true, detail: "installed" } : { ...micItem, ok: false, detail: "not installed" })
          } catch (e) {
            if (cam) out.push({ ...camItem, ok: false, detail: `couldn't ask the Raspberry Pi: ${err(e)}` })
            if (mic) out.push({ ...micItem, ok: false, detail: `couldn't ask the Raspberry Pi: ${err(e)}` })
          }
        }
      }
    } catch (e) { out.push({ id: "qemu", label: "QEMU (runs the Raspberry Pi)", ok: false, detail: err(e) }) }
  }
  if (chips.has("renode")) {
    try {
      const { renodeStatus } = await import("@/renode/host")
      const v = await renodeStatus()
      out.push(v ? { id: "renode", label: "Renode (runs STM32 / nRF52 firmware)", ok: true, detail: v } : { id: "renode", label: "Renode (runs STM32 / nRF52 firmware)", ok: false, detail: "not installed", install: "download Renode 1.17 (MIT, about 75 MB)" })
    } catch (e) { out.push({ id: "renode", label: "Renode (runs STM32 / nRF52 firmware)", ok: false, detail: err(e), install: "download Renode 1.17 (MIT, about 75 MB)" }) }
  }
  if (chips.has("esp32")) {
    try {
      const { qemuStatus } = await import("./esp32/host")
      out.push({ id: "esp32-qemu", label: "Espressif QEMU (runs the ESP32)", ok: true, detail: await qemuStatus() })
    } catch (e) { out.push({ id: "esp32-qemu", label: "Espressif QEMU (runs the ESP32)", ok: false, detail: err(e), install: "download Espressif's QEMU for ESP32 / S3 / C3 (about 60 MB)" }) }
  }
  return out
}

/** Install one item from checkSetup (the user has agreed). Returns what happened. */
export async function installSetup(id: string, boards: BoardDef[], cliPath?: string, progress?: (text: string) => void): Promise<string> {
  if (id === "arduino-cli" || id === "qemu") {
    const { brewInstall } = await import("@/linux/host")
    progress?.(`brew install ${id}…`)
    return `Installed ${id}.\n${await brewInstall(id)}`
  }
  if (id.startsWith("core:")) {
    const core = id.slice(5)
    const b = boards.find((x) => x.chip !== "linux" && coreOf(x.fqbn) === core)
    progress?.(`arduino-cli core install ${core}…`)
    await installCore(core, cliPath, b?.coreUrl)
    return `Installed the ${core} core.`
  }
  if (id === "pi-system") {
    const { setupLinux } = await import("@/linux/provision")
    await setupLinux((p) => progress?.(`${p.step}/${p.of} · ${p.text}`))
    return "The Raspberry Pi system is set up."
  }
  if (id === "pi-camera" || id === "pi-audio") {
    const { installMedia } = await import("@/linux/media")
    const pi = boards.find((b) => b.chip === "linux")
    if (!pi) throw new Error("This project has no Raspberry Pi board")
    return installMedia((pi.linux ?? "pi5") as LinuxBoardId, id === "pi-camera" ? "camera" : "audio", progress)
  }
  if (id === "renode") {
    const { installRenode } = await import("@/renode/host")
    progress?.("Downloading Renode…")
    return `Installed Renode: ${(await installRenode()) ?? ""}`
  }
  if (id === "esp32-qemu") {
    const { installQemu } = await import("./esp32/host")
    progress?.("Downloading Espressif's QEMU…")
    return `Installed Espressif's QEMU: ${await installQemu()}`
  }
  throw new Error(`Unknown setup item ${id} — use one of the ids check_setup lists`)
}
