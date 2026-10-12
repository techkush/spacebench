// The microcontroller runs here, off the UI thread: it simulates in real time (or slower
// when the computer can't keep up), and posts what to draw ~60 times a second.
import type { PartUi } from "./circuit"
import type { Diagram } from "./diagram"
import { McuSim } from "./sim"
import { Esp32Machine } from "./esp32/machine"
import { FedMachine } from "./fed"
import type { FrameOut } from "@/cosim/chip"

export type ToWorker =
  | { type: "start"; diagram: Diagram; hex: string | Uint8Array; speed: number; eeprom?: Uint8Array }
  | { type: "ui"; id: string; ui: PartUi }
  | { type: "serial"; text: string }
  | { type: "pause"; paused: boolean }
  | { type: "speed"; speed: number }
  | { type: "stop" }
  /** ESP32: bridge bytes from QEMU */
  | { type: "esp32-in"; bytes: number[] }
  /** Linux / Renode boards: a frame the chip ran (main thread) */
  | { type: "fed-frame"; frame: FrameOut; seconds: number }
export type FromWorker =
  | { type: "frame"; frame: import("./sim").Frame }
  | { type: "serial"; text: string }
  | { type: "error"; message: string }
  /** ESP32: bridge bytes for QEMU (input levels, ADC voltages) */
  | { type: "esp32-out"; bytes: number[] }
  /** Linux / Renode boards: the input levels for the next frame */
  | { type: "fed-in"; levels: [string, boolean][] }

let sim: McuSim | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let speed = 1
let paused = false
let last = 0
const post = (m: FromWorker) => (self as unknown as Worker).postMessage(m)

function tick() {
  timer = null
  if (!sim) return
  const now = performance.now()
  const real = Math.min(50, now - last)
  last = now
  if (!paused) {
    try {
      const frame = sim.step(real * speed, real)
      // the step itself took time: report the speed actually achieved
      const took = performance.now() - now
      frame.speed = (real * speed) / Math.max(real, took)
      post({ type: "frame", frame })
    } catch (e) {
      post({ type: "error", message: e instanceof Error ? e.message : String(e) })
      sim = null
      return
    }
  }
  timer = setTimeout(tick, Math.max(0, 16 - (performance.now() - now)))
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data
  if (m.type === "start") {
    if (timer) clearTimeout(timer)
    try {
      sim = new McuSim(m.diagram, m.hex, m.eeprom)
      sim.onSerial = (text) => post({ type: "serial", text })
      if (sim.machine instanceof Esp32Machine) sim.machine.onOutput = (bytes) => post({ type: "esp32-out", bytes })
      if (sim.machine instanceof FedMachine) sim.machine.onInputs = (levels) => post({ type: "fed-in", levels })
      speed = m.speed; paused = false; last = performance.now()
      tick()
    } catch (err) { post({ type: "error", message: err instanceof Error ? err.message : String(err) }) }
  } else if (m.type === "ui") sim?.setUi(m.id, m.ui)
  else if (m.type === "serial") sim?.serialWrite(m.text)
  else if (m.type === "pause") { paused = m.paused; last = performance.now() }
  else if (m.type === "speed") speed = m.speed
  else if (m.type === "esp32-in") { if (sim?.machine instanceof Esp32Machine) sim.machine.feed(m.bytes) }
  else if (m.type === "fed-frame") { if (sim?.machine instanceof FedMachine) sim.machine.feed(m.frame, m.seconds) }
  else if (m.type === "stop") { if (timer) clearTimeout(timer); timer = null; sim = null }
}
