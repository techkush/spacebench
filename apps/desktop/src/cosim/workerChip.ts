// A ChipLink to a chip running in its own Web Worker (chip.worker.ts).
import type { BoardDef } from "@/mcu/boards"
import type { ChipLink, FrameOut } from "./chip"
import type { FromChip, ToChip } from "./chip.worker"

export function workerChip(board: BoardDef, firmware: string | Uint8Array): Promise<ChipLink> {
  const w = new Worker(new URL("./chip.worker.ts", import.meta.url), { type: "module" })
  const send = (m: ToChip) => w.postMessage(m)
  const pending = new Map<number, { ok: (o: FrameOut) => void; fail: (e: Error) => void }>()
  let seq = 0
  return new Promise((resolve, reject) => {
    let ready = false
    w.onerror = (e) => { const err = new Error(e.message || "the chip worker failed"); if (!ready) reject(err); for (const p of pending.values()) p.fail(err); pending.clear() }
    w.onmessage = (e: MessageEvent<FromChip>) => {
      const m = e.data
      if (m.type === "ready") {
        ready = true
        resolve({
          frame: (frame) => new Promise((ok, fail) => { const id = ++seq; pending.set(id, { ok, fail }); send({ type: "frame", id, frame }) }),
          serialWrite: (text) => send({ type: "serial", text }),
          dispose: () => { w.terminate(); for (const p of pending.values()) p.fail(new Error("stopped")); pending.clear() },
        })
      } else if (m.type === "frame") { pending.get(m.id)?.ok(m.out); pending.delete(m.id) }
      else if (m.type === "error") {
        const err = new Error(m.message)
        if (m.id === undefined) { if (!ready) { reject(err); w.terminate() } return }
        pending.get(m.id)?.fail(err); pending.delete(m.id)
      }
    }
    send({ type: "start", board: board.type, firmware })
  })
}
