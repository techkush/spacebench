// The circuit + firmware run from the workspace: compile each board's sketch, start one chip
// worker per board, and step the co-simulation in real time (or as fast as ngspice allows).
import { useCallback, useEffect, useRef, useState } from "react"
import type { Doc, Firmware } from "@/editor/model"
import { simulate } from "@/lib/engine"
import type { BoardDef } from "@/mcu/boards"
import { compileSketch, parseLibraries, type Diagnostic } from "@/mcu/compile"
import { boardParts, starterSketch } from "./boards"
import { localChip, type ChipLink } from "./chip"
import { CoSim, type CoSimFrame } from "./cosim"
import { workerChip } from "./workerChip"
import { linuxChip } from "@/linux/chip"
import { renodeChip } from "@/renode/chip"
import { renodeStage } from "@/renode/host"
import { esp32Chip } from "@/mcu/esp32/chip"
import { ESP32_BRIDGE, ESP32_BRIDGE_FILE } from "@/mcu/esp32/bridge"
import { getSettings } from "@/lib/settings"

export type CoSimStatus = "idle" | "compiling" | "starting" | "running" | "error"

export interface BoardBuild {
  ok: boolean
  log: string
  diagnostics: Diagnostic[]
  firmware: string | Uint8Array | null
  /** what was compiled (files + board), to skip compiling an unchanged sketch */
  key: string
  flash?: { used: number; max: number }
}

/** A board's sketch: the one saved in the circuit, or the starter sketch. */
export function firmwareOf(doc: Pick<Doc, "firmware">, ref: string, board: BoardDef): Firmware {
  return doc.firmware?.[ref] ?? { files: [{ name: board.chip === "linux" ? "main.py" : "sketch.ino", content: starterSketch(board) }] }
}

const SERIAL_KEEP = 20_000
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function useCoSim(o: { doc: Doc; cliBin?: string; frame?: number; onFrame: (f: CoSimFrame) => void; onError: (message: string) => void }) {
  const [status, setStatus] = useState<CoSimStatus>("idle")
  const [builds, setBuilds] = useState<Record<string, BoardBuild>>({})
  const [serial, setSerial] = useState<Record<string, string>>({})
  const [clock, setClock] = useState<{ t: number; speed: number } | null>(null)
  /** each board's pins after the last frame (the live code view) */
  const [live, setLive] = useState<CoSimFrame["live"]>({})
  const [error, setError] = useState<string | null>(null)
  const docRef = useRef(o.doc)
  docRef.current = o.doc
  const cb = useRef(o)
  cb.current = o
  const sim = useRef<CoSim | null>(null)
  const token = useRef(0)
  const buildCache = useRef<Record<string, BoardBuild>>({})

  // values tuned and switches flipped while running take effect from the next frame
  useEffect(() => { sim.current?.setDoc(o.doc) }, [o.doc])

  const compile = useCallback(async (ref: string): Promise<BoardBuild> => {
    const b = boardParts(docRef.current).find((x) => x.part.ref === ref)
    if (!b) throw new Error(`${ref} isn't a programmable board`)
    const fw = firmwareOf(docRef.current, ref, b.board)
    const key = JSON.stringify([b.board.fqbn, fw])
    // Linux boards run Python: nothing to compile
    if (b.board.chip === "linux") {
      const build: BoardBuild = { ok: true, log: "Python runs as it is on the board — nothing to compile.", diagnostics: [], key, firmware: null }
      buildCache.current[ref] = build
      setBuilds((m) => ({ ...m, [ref]: build }))
      return build
    }
    const cached = buildCache.current[ref]
    if (cached?.ok && cached.key === key) return cached
    // Renode boards: the set-up the emulated chip needs goes in with the sketch
    const files = [...fw.files, ...(b.board.renode?.sources ?? []), ...(b.board.chip === "esp32" ? [{ name: ESP32_BRIDGE_FILE, content: ESP32_BRIDGE }] : [])]
    const out = await compileSketch(files, b.board.fqbn, parseLibraries(fw.libraries ?? ""), cb.current.cliBin || undefined, b.board.buildProps)
    const build: BoardBuild = {
      ok: out.ok, log: out.log, diagnostics: out.diagnostics, key, flash: out.flash,
      // Renode boots the ELF from disk: keep a copy the next compile won't delete
      // Renode boots the ELF and QEMU the flash image from disk: keep copies the next compile won't delete
      firmware: b.board.firmware === "hex" ? out.hex : b.board.firmware === "elf" ? (out.ok && out.elf ? await renodeStage(out.elf) : null)
        : b.board.firmware === "image" ? (out.ok && out.image ? await renodeStage(out.image) : null) : out.bin,
    }
    if (build.ok && !build.firmware) { build.ok = false; build.log += "\nThe compiler produced no firmware image." }
    buildCache.current[ref] = build
    setBuilds((m) => ({ ...m, [ref]: build }))
    return build
  }, [])

  const stop = useCallback(() => {
    token.current++
    sim.current?.dispose()
    sim.current = null
    setStatus((s) => (s === "error" ? s : "idle"))
  }, [])

  const fail = (message: string) => {
    token.current++
    sim.current?.dispose()
    sim.current = null
    setError(message)
    setStatus("error")
    cb.current.onError(message)
  }

  const start = useCallback(async () => {
    stop()
    const my = ++token.current
    const boards = boardParts(docRef.current)
    if (!boards.length) { fail("Place an Arduino Uno / Nano or a Raspberry Pi Pico in the schematic first."); return }
    setError(null)
    setStatus("compiling")
    const chips: ChipLink[] = []
    try {
      const built: BoardBuild[] = []
      for (const b of boards) {
        const r = await compile(b.part.ref)
        if (my !== token.current) return
        if (!r.ok) { fail(`${b.part.ref}: the sketch didn't compile — see the Firmware panel.`); return }
        built.push(r)
      }
      setStatus("starting")
      const linux = boards.filter((b) => b.board.chip === "linux")
      if (linux.length > 1) { fail(`Only one Linux board can run at a time (${linux.map((b) => b.part.ref).join(", ")}).`); return }
      const esp = boards.filter((b) => b.board.chip === "esp32")
      if (esp.length > 1) { fail(`Only one ESP32 can run at a time (${esp.map((b) => b.part.ref).join(", ")}).`); return }
      const renode = boards.filter((b) => b.board.chip === "renode")
      if (renode.length > 1) { fail(`Only one Renode board can run at a time (${renode.map((b) => b.part.ref).join(", ")}).`); return }
      for (const [i, b] of boards.entries()) {
        if (b.board.chip === "linux") chips.push(await linuxChip(b.board, firmwareOf(docRef.current, b.part.ref, b.board)))
        else if (b.board.chip === "renode") chips.push(await renodeChip(b.board, built[i].firmware as string))
        else if (b.board.chip === "esp32") chips.push(await esp32Chip(b.board, built[i].firmware as string, getSettings().esp32QemuPath))
        else chips.push(typeof Worker === "undefined" ? localChip(b.board, built[i].firmware!) : await workerChip(b.board, built[i].firmware!))
      }
      if (my !== token.current) { chips.forEach((c) => c.dispose()); return }
      let n = 0
      const s = new CoSim(docRef.current, boards.map((b, i) => ({ ref: b.part.ref, board: b.board, chip: chips[i] })),
        (net) => simulate(net, { run: `cosim${my}-${++n}` }), { frame: cb.current.frame ?? 0.02 })
      sim.current = s
      setSerial({})
      setLive({})
      setStatus("running")
      const wall0 = performance.now()
      let lastWall = wall0, lastT = 0, speed = 1
      while (my === token.current) {
        const f = await s.step()
        if (my !== token.current) break
        cb.current.onFrame(f)
        setLive(f.live)
        const printed = Object.entries(f.serial).filter(([, t]) => t)
        if (printed.length) setSerial((m) => { const next = { ...m }; for (const [ref, t] of printed) next[ref] = ((next[ref] ?? "") + t).slice(-SERIAL_KEEP); return next })
        // never run ahead of the wall clock; when ngspice is slower, run as fast as it goes
        const ahead = f.t1 * 1000 - (performance.now() - wall0)
        await sleep(Math.max(0, ahead))
        const now = performance.now()
        speed = 0.7 * speed + 0.3 * (((f.t1 - lastT) * 1000) / Math.max(1, now - lastWall))
        lastWall = now; lastT = f.t1
        setClock({ t: f.t1, speed })
      }
    } catch (e) {
      chips.forEach((c) => c.dispose())
      if (my === token.current) fail(e instanceof Error ? e.message : String(e))
    }
  }, [compile, stop]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { token.current++; sim.current?.dispose() }, [])

  const sendSerial = useCallback((ref: string, text: string) => sim.current?.serialWrite(ref, text), [])
  const clearSerial = useCallback((ref: string) => setSerial((m) => ({ ...m, [ref]: "" })), [])
  const active = status === "compiling" || status === "starting" || status === "running"

  return { status, active, builds, serial, clock, live, error, compile, start, stop, sendSerial, clearSerial }
}

export type CoSimControl = ReturnType<typeof useCoSim>
