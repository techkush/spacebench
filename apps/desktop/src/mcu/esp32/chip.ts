// An ESP32 (ESP32 / S3 / C3 on Espressif's QEMU) as a co-simulation chip. QEMU runs in real time
// and is paused between frames (QMP), so it advances with the circuit; the bridge's pin reports
// carry no times, so each is placed at the moment it arrives within the frame (a few ms).
import type { BoardDef } from "../boards"
import type { ChipLink, FrameOut, PinEvent, PinState } from "@/cosim/chip"
import { espPoll, espQmp, espSend, espStart, espStop } from "./host"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function esp32Chip(board: BoardDef, image: string, qemuPath?: string): Promise<ChipLink> {
  await espStart(image, qemuPath, board.esp ?? "esp32")
  // nothing runs until the first frame
  await espQmp("stop")
  const names = new Map<number, string[]>()
  for (const [pin, bp] of Object.entries(board.pins)) names.set(bp.bit, [...(names.get(bp.bit) ?? []), pin])
  const state = new Map<number, PinState>()
  const level = new Map<number, 0 | 1>()
  const pwm = new Map<number, number>()
  const sentIn = new Map<number, boolean>()
  const sentMv = new Map<number, number>()
  let rx: number[] = []
  let serial = ""

  /** bridge bytes → pin changes at `t` (seconds into the frame) */
  const decode = (bytes: number[], t: number, events: PinEvent[]) => {
    rx.push(...bytes)
    while (rx.length >= 5) {
      if (rx[0] !== 0xa5) { rx.shift(); continue }
      const [, cmd, g, lo, hi] = rx.splice(0, 5)
      const v = lo | (hi << 8)
      let s = state.get(g) ?? { out: -1 as const, pu: false, pd: false }
      if (cmd === 0x4d) { // 'M' pinMode: 0x02 output, 0x04 pull-up, 0x08 pull-down
        s = v & 0x02 ? { out: level.get(g) ?? 0, pu: false, pd: false } : { out: -1, pu: !!(v & 0x04), pd: !!(v & 0x08) }
        pwm.delete(g)
      } else if (cmd === 0x57) { // 'W' digitalWrite
        level.set(g, v ? 1 : 0)
        s = { out: v ? 1 : 0, pu: false, pd: false }
        pwm.delete(g)
      } else if (cmd === 0x50) { // 'P' PWM duty (0–255): edges made below
        if (v > 0 && v < 255) pwm.set(g, v)
        else { pwm.delete(g); level.set(g, v ? 1 : 0) }
        s = { out: v >= 128 ? 1 : 0, pu: false, pd: false }
      } else continue
      state.set(g, s)
      for (const pin of names.get(g) ?? []) events.push({ pin, t, ...s })
    }
  }

  return {
    async frame(f): Promise<FrameOut> {
      const bytes: number[] = []
      for (const [pin, high] of f.digital) {
        const g = board.pins[pin]?.bit
        if (g === undefined || sentIn.get(g) === high) continue
        sentIn.set(g, high)
        bytes.push(0xa5, 0x49, g, high ? 1 : 0, 0)
      }
      for (const [ch, volts] of f.analog) {
        const mv = Math.round(Math.max(0, Math.min(3.3, volts)) * 1000)
        if (Math.abs((sentMv.get(ch) ?? -100) - mv) < 3) continue
        sentMv.set(ch, mv)
        bytes.push(0xa5, 0x41, ch, mv & 0xff, mv >> 8)
      }
      if (bytes.length) await espSend(undefined, bytes)
      const start: [string, PinState][] = []
      for (const [g, pins] of names) for (const pin of pins) start.push([pin, state.get(g) ?? { out: -1, pu: false, pd: false }])
      const events: PinEvent[] = []
      const pwmAtStart = new Map(pwm)
      if (f.seconds > 0) {
        await espQmp("cont")
        const t0 = performance.now()
        while (performance.now() - t0 < f.seconds * 1000) {
          const p = await espPoll()
          serial += p.serial
          decode(p.bridge, Math.min(f.seconds, (performance.now() - t0) / 1000), events)
          if (!p.running) throw new Error(`The ESP32 emulator stopped${p.log ? `: ${p.log.trim().split("\n").pop()}` : ""}`)
          await sleep(2)
        }
        await espQmp("stop")
      }
      const p = await espPoll()
      serial += p.serial
      decode(p.bridge, f.seconds, events)
      // PWM: the bridge reports a duty, the circuit sees 1 kHz edges with it
      for (const [g, d] of pwmAtStart) {
        if (!pwm.has(g)) continue
        for (let k = 0; k * 0.001 < f.seconds; k++) {
          for (const pin of names.get(g) ?? []) {
            events.push({ pin, t: k * 0.001, out: 1, pu: false, pd: false })
            events.push({ pin, t: Math.min(f.seconds, k * 0.001 + (d / 255) * 0.001), out: 0, pu: false, pd: false })
          }
        }
      }
      events.sort((a, b) => a.t - b.t)
      const out: FrameOut = { start, events, serial, seconds: 0 }
      serial = ""
      return out
    },
    serialWrite: (text) => { void espSend(text) },
    dispose: () => { void espStop() },
  }
}
