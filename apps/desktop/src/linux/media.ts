// Media parts on a Raspberry Pi: the Camera Module becomes /dev/video0 (v4l2loopback fed with a
// test scene) and a microphone (the ReSpeaker Lite) the "ReSpeaker" ALSA card (snd-aloop fed
// with a voice-like sound). The guest side is linux-guest/spacebench-camera / spacebench-mic,
// started by the agent; the add-ons they need are installed once by spacebench-media-setup —
// only after the user agreed (the assistant's check_setup / install: "pi-camera", "pi-audio").
//
// How the canvas enables them: linuxChip gets the board's diagram parts; a camera / microphone
// part among them starts its feeder with the part's control values (op "devices"), and moving a
// slider while running sends the new values (op "controls"). Without the part, the feeder stops
// and the device goes away, like unplugging it.
import type { PartUi } from "@/mcu/circuit"
import mediaSetupSrc from "../../linux-guest/spacebench-media-setup?raw"
import cameraSrc from "../../linux-guest/spacebench-camera?raw"
import micSrc from "../../linux-guest/spacebench-mic?raw"
import { linuxVm, type LinuxBoardId, type LinuxVm } from "./agent"
import { piExec } from "./exec"

export const CAMERA_PART = "sb-raspberry-pi-camera-module-csi"
export const MIC_PART = "sb-respeaker-lite-xmos-xu316"

export interface CameraCfg { scene: number; brightness: number }
export interface MicCfg { sound: number; level: number }
export interface GuestMedia { camera: CameraCfg | null; mic: MicCfg | null }
/** a part on the board's canvas */
export interface MediaPart { id: string; type: string }

export const CAMERA_DEFAULTS: CameraCfg = { scene: 0, brightness: 50 }
export const MIC_DEFAULTS: MicCfg = { sound: 0, level: 60 }

const pick = <T extends object>(def: T, v: Record<string, number> | undefined): T =>
  Object.fromEntries(Object.entries(def).map(([k, d]) => [k, typeof v?.[k] === "number" && Number.isFinite(v[k]) ? v[k] : d])) as T

/** What the guest should feed, from the parts on the board's canvas and their controls. */
export function guestMedia(parts: MediaPart[], ui: Record<string, PartUi> = {}): GuestMedia & { ids: { camera?: string; mic?: string } } {
  const cam = parts.find((p) => p.type === CAMERA_PART)
  const mic = parts.find((p) => p.type === MIC_PART)
  return {
    camera: cam ? pick(CAMERA_DEFAULTS, ui[cam.id]?.v) : null,
    mic: mic ? pick(MIC_DEFAULTS, ui[mic.id]?.v) : null,
    ids: { camera: cam?.id, mic: mic?.id },
  }
}

export type FeederState = "on" | "off" | "missing" | string
/** Start / stop the feeders on the running VM. */
export async function applyMedia(vm: LinuxVm, m: GuestMedia): Promise<{ camera: FeederState; mic: FeederState }> {
  // this app's feeders (small): always current, whatever the guest has
  if (m.camera) await vm.put("/usr/local/sbin/spacebench-camera", cameraSrc, "755")
  if (m.mic) await vm.put("/usr/local/sbin/spacebench-mic", micSrc, "755")
  const r =await vm.request({ op: "devices", camera: m.camera, mic: m.mic }, "devices", 20_000)
  return { camera: String(r.camera), mic: String(r.mic) }
}
/** New control values for the running feeders (no answer). */
export function mediaControls(vm: LinuxVm, m: Partial<GuestMedia>) { return vm.send({ op: "controls", ...m }) }

/** A line for the program's output when a part can't work yet; "" when all is well. */
export function mediaNote(st: { camera: FeederState; mic: FeederState }): string {
  const say: string[] = []
  if (st.camera === "missing") say.push("(Camera Module: the camera add-on isn't installed on the Raspberry Pi yet — ask the assistant to install pi-camera; it asks you first)")
  else if (st.camera.startsWith("failed")) say.push(`(Camera Module: ${st.camera})`)
  if (st.mic === "missing") say.push("(ReSpeaker microphone: the audio add-on isn't installed on the Raspberry Pi yet — ask the assistant to install pi-audio; it asks you first)")
  else if (st.mic.startsWith("failed")) say.push(`(ReSpeaker microphone: ${st.mic})`)
  return say.length ? say.join("\n") + "\n" : ""
}

/** The VM to ask: the running one (whatever board it is — the disk is the same), else boot one. */
async function vmFor(board: LinuxBoardId, say?: (t: string) => void) {
  const vm = linuxVm()
  if (!vm.running) await vm.ensure(board, () => say?.("Starting the board (Linux)…"))
  return vm
}

/** Which add-ons the guest has. */
export async function mediaStatus(board: LinuxBoardId): Promise<{ camera: boolean; audio: boolean }> {
  const r = await (await vmFor(board)).request({ op: "media" }, "media", 30_000)
  return { camera: !!r.camera, audio: !!r.audio }
}

/**
 * Install an add-on in the guest (the user agreed): v4l2loopback (DKMS, built for the guest's
 * kernel) + v4l-utils for the camera, alsa-utils for the microphone. Returns what it said.
 */
export async function installMedia(board: LinuxBoardId, what: "camera" | "audio", say?: (t: string) => void): Promise<string> {
  const vm = await vmFor(board, say)
  // the installer travels with the app too (a guest set up before it existed)
  await vm.put("/usr/local/sbin/spacebench-media-setup", mediaSetupSrc, "755")
  say?.(what === "camera" ? "Installing the camera add-on (v4l2loopback, v4l-utils)…" : "Installing the audio add-on (alsa-utils)…")
  const r = await piExec(board, `sudo /usr/local/sbin/spacebench-media-setup ${what}`, 900, say)
  const tail = r.output.trim().split("\n").filter(Boolean).slice(-6).join("\n")
  if (r.code !== 0) throw new Error(`The ${what} add-on didn't install (exit ${r.code ?? "timeout"}):\n${tail}`)
  return tail
}
