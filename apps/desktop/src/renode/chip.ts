// A Renode board as a co-simulation chip: its firmware (ELF) runs on Renode exactly `seconds` of
// virtual time per frame (emulation RunFor), with the circuit's input levels set first and every
// GPIO edge reported with its virtual time — the same lockstep as the other emulators.
import helperSrc from "../../renode/sb_renode.py?raw"
import type { BoardDef } from "@/mcu/boards"
import type { ChipLink, FrameOut, PinState } from "@/cosim/chip"
import { renodeCmd, renodeStart, renodeStop } from "./host"

export interface StepOut { start: [string, number, boolean, boolean][]; events: [string, number, number, boolean, boolean][]; uart: Record<string, string>; t: number }
const state = (out: number, pu: boolean, pd: boolean): PinState => ({ out: out === 1 ? 1 : out === 0 ? 0 : -1, pu, pd })
/** a JSON argument inside the monitor's python "…" string */
const arg = (v: unknown) => `'${JSON.stringify(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}'`

/** One Renode session running a board's firmware. */
export class RenodeBoard {
  readonly board: BoardDef
  private serialBuf = ""
  constructor(board: BoardDef) { this.board = board }

  async start(elf: string) {
    const spec = this.board.renode
    if (!spec) throw new Error(`${this.board.name} isn't a Renode board`)
    const helper = await renodeStart(helperSrc)
    await renodeCmd(`mach create "${this.board.id}"`)
    await renodeCmd(`machine LoadPlatformDescription @${spec.repl}`)
    await renodeCmd(`sysbus LoadELF @${elf}`)
    await renodeCmd(`include @${helper}`)
    const r = JSON.parse(await renodeCmd(`python "sb_setup(${arg({ ports: spec.ports.map((p) => ({ ...p, family: spec.family })), uarts: spec.uarts })})"`))
    if (!r.ok) throw new Error("Renode didn't set up the board")
  }

  /** inputs: board pin → level; runs `seconds` of virtual time */
  async step(inputs: Record<string, boolean>, seconds: number): Promise<StepOut> {
    const r = JSON.parse(await renodeCmd(`python "sb_step(${arg(inputs)}, ${seconds.toFixed(6)})"`)) as StepOut
    this.serialBuf += r.uart[this.board.renode!.serial] ?? ""
    return r
  }

  takeSerial() { const s = this.serialBuf; this.serialBuf = ""; return s }
  async serialWrite(text: string) { await renodeCmd(`python "sb_uart(${arg(this.board.renode!.serial)}, ${arg(text)})"`) }
  stop() { return renodeStop() }
}

/** Board pin names as the board knows them ("PA0", "P0.13"); the schematic's names map onto these. */
export async function renodeChip(board: BoardDef, elf: string): Promise<ChipLink> {
  const rb = new RenodeBoard(board)
  await rb.start(elf)
  return {
    async frame(f): Promise<FrameOut> {
      const inputs: Record<string, boolean> = {}
      for (const [pin, high] of f.digital) inputs[pin] = high
      // the operating-point frame (0 s) only reports the pins' states
      const r = await rb.step(inputs, f.seconds)
      return {
        start: r.start.filter(([pin]) => board.pins[pin]).map(([pin, o, pu, pd]) => [pin, state(o, pu, pd)]),
        events: r.events.filter(([pin]) => board.pins[pin]).map(([pin, t, o, pu, pd]) => ({ pin, t: Math.min(f.seconds, t), ...state(o, pu, pd) })),
        serial: rb.takeSerial(),
        seconds: 0,
      }
    },
    serialWrite: (text) => { void rb.serialWrite(text) },
    dispose: () => { void rb.stop() },
  }
}
