// A Linux board (Raspberry Pi) as a co-simulation chip: the VM runs the user's Python program;
// each frame it runs for the frame's length — timed by its own clock — and is then paused (its
// clock too) while ngspice simulates the circuit over the same time: the same lockstep as the
// emulated microcontrollers.
import type { Firmware } from "@/editor/model"
import type { BoardDef } from "@/mcu/boards"
import type { ChipLink, FrameOut, PinState } from "@/cosim/chip"
import { linuxVm, type GuestFrame, type LinuxBoardId, type LinuxVm } from "./agent"
import { piExec } from "./exec"
import type { PartUi } from "@/mcu/circuit"
import { applyMedia, guestMedia, mediaControls, mediaNote, type MediaPart } from "./media"

const state = (out: number, pu: boolean, pd: boolean): PinState => ({ out: out === 1 ? 1 : out === 0 ? 0 : -1, pu, pd })

/** The program a Linux board runs: main.py if there is one, else the first .py file. */
export const mainFile = (fw: Firmware) => (fw.files.find((f) => f.name === "main.py") ?? fw.files.find((f) => f.name.endsWith(".py")))?.name ?? "main.py"

/** The rest of the board's canvas: its parts and their control values (media parts, media.ts). */
export interface BoardCanvas { parts?: MediaPart[]; ui?: Record<string, PartUi> }

/**
 * Boot the board (if it isn't already this one) and copy the program's files to /home/pi.
 * With the canvas: a Camera Module / ReSpeaker part on it starts its device in the guest (and
 * none stops it) — see media.ts.
 */
export async function prepareBoard(board: BoardDef, fw: Firmware, say: (text: string) => void, canvas?: BoardCanvas): Promise<LinuxVm> {
  const vm = linuxVm()
  await vm.ensure((board.linux ?? "pi5") as LinuxBoardId, () => say(`Starting ${board.name} (Linux)…\n`))
  for (const f of fw.files) await vm.put(`/home/pi/${f.name}`, f.content)
  // requirements.txt: name the packages that aren't installed yet (installing is the user's call)
  const norm = (n: string) => n.toLowerCase().replace(/[-_.]+/g, "-")
  const wants = (fw.files.find((f) => f.name === "requirements.txt")?.content ?? "").split("\n").map((l) => l.replace(/#.*/, "").trim().split(/[<>=!~[;\s]/)[0]).filter(Boolean)
  if (wants.length) {
    const shown = await piExec(vm.board, `python3 -m pip show ${wants.map((w) => `'${w.replace(/'/g, "")}'`).join(" ")} 2>/dev/null | grep '^Name:'`, 30).catch(() => null)
    const have = new Set([...(shown?.output ?? "").matchAll(/^Name:\s*(\S+)/gm)].map((m) => norm(m[1])))
    const missing = wants.filter((w) => !have.has(norm(w)))
    if (missing.length) say(`(requirements.txt: ${missing.join(", ")} not installed — install with pip in the Terminal, or ask the assistant)\n`)
  }
  if (canvas?.parts) {
    try { say(mediaNote(await applyMedia(vm, guestMedia(canvas.parts, canvas.ui)))) } catch (e) { say(`(camera / microphone: ${e instanceof Error ? e.message : String(e)})\n`) }
  }
  return vm
}

export async function linuxChip(board: BoardDef, fw: Firmware, canvas?: BoardCanvas): Promise<ChipLink> {
  let printed = ""
  const vm = await prepareBoard(board, fw, (t) => { printed += t }, canvas)
  const ui: Record<string, PartUi> = { ...canvas?.ui }
  vm.onOutput = (t) => { printed += t }
  vm.onExit = (code) => { printed += `\n[program exited with code ${code}]\n` }
  let started = false
  const lineOf = (pin: string) => board.pins[pin]?.bit ?? -1
  return {
    async frame(f): Promise<FrameOut> {
      const inputs: Record<number, boolean> = {}
      for (const [pin, high] of f.digital) { const l = lineOf(pin); if (l >= 0) inputs[l] = high }
      // the program starts with the first frame that has time in it (its inputs set first)
      const run = !started && f.seconds > 0 ? { cmd: `python3 ${mainFile(fw)}` } : undefined
      if (run) started = true
      const g: GuestFrame = await vm.frame(inputs, f.seconds, run)
      const out: FrameOut = {
        start: g.start.map(([line, o, pu, pd]) => [`GPIO${line}`, state(o, pu, pd)]),
        events: g.events.map(([line, t, o, pu, pd]) => ({ pin: `GPIO${line}`, t: Math.min(f.seconds, Math.max(0, t)), ...state(o, pu, pd) })),
        serial: printed,
        seconds: 0,
      }
      printed = ""
      return out
    },
    serialWrite: (text) => { void vm.stdin(text) },
    // a media part's slider moved: its feeder follows
    ui: (id, u) => {
      if (!canvas?.parts) return
      ui[id] = { ...ui[id], ...u, v: { ...ui[id]?.v, ...u.v } }
      const m = guestMedia(canvas.parts, ui)
      if (id === m.ids.camera && m.camera) void mediaControls(vm, { camera: m.camera }).catch(() => {})
      if (id === m.ids.mic && m.mic) void mediaControls(vm, { mic: m.mic }).catch(() => {})
    },
    dispose: () => { void vm.kill().then(() => vm.resume()) },
  }
}
