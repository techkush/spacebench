// An ESP32 module in a schematic: the sketch on Espressif's QEMU (paused between frames), the
// circuit on ngspice. Needs arduino-cli with esp32:esp32, Espressif's QEMU and ngspice.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import zlib from "node:zlib"
import { afterEach, describe, expect, it, vi } from "vitest"
import { esp32Backend, findQemu } from "../../vite-esp32"
import { run } from "../../vite-ngspice"

vi.mock("./esp32/host", () => ({
  espStart: async (image: string, _bin: string | undefined, machine: string) => esp32Backend.start(image, machine),
  espPoll: async () => esp32Backend.poll(),
  espSend: async (serial?: string, bridge?: number[]) => esp32Backend.send(serial, bridge),
  espQmp: async (cmd: string) => esp32Backend.qmp(cmd),
  espStop: async () => esp32Backend.stop(),
}))

import { compileKirk } from "@/kirk/compile"
import { boardParts } from "@/cosim/boards"
import { CoSim } from "@/cosim/cosim"
import { remap, type JobResult } from "@/lib/engine"
import { setLoader } from "@/lib/kicad"
import type { SpiceNetlist } from "@/lib/spice"
import { ESP32_BRIDGE, ESP32_BRIDGE_FILE } from "./esp32/bridge"
import { esp32Chip } from "./esp32/chip"
import type { BoardDef } from "./boards"

const KICAD = path.resolve(import.meta.dirname, "../../public/kicad")
setLoader(async (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(KICAD, `${f}.gz`))).toString()))
const ngspice = ["/opt/homebrew/bin/ngspice", "/usr/local/bin/ngspice"].find((p) => fs.existsSync(p))
const cli = ["/opt/homebrew/bin/arduino-cli", "/usr/local/bin/arduino-cli"].find((p) => fs.existsSync(p))
const hasCore = !!cli && execFileSync(cli, ["core", "list"], { encoding: "utf8" }).includes("esp32:esp32")
const ready = !!ngspice && hasCore && !!findQemu()

function build(code: string, board: BoardDef): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbespsch-"))
  fs.mkdirSync(path.join(dir, "sketch"))
  fs.writeFileSync(path.join(dir, "sketch", "sketch.ino"), code)
  fs.writeFileSync(path.join(dir, "sketch", ESP32_BRIDGE_FILE), ESP32_BRIDGE)
  execFileSync(cli!, ["compile", "--fqbn", board.fqbn, ...board.buildProps!.flatMap((p) => ["--build-property", p]), "--build-path", path.join(os.tmpdir(), `sbespsch-build-${board.id}`), "--output-dir", path.join(dir, "out"), path.join(dir, "sketch")], { stdio: "pipe" })
  return path.join(dir, "out", "sketch.ino.merged.bin")
}
const simulate = async (net: SpiceNetlist): Promise<JobResult> => {
  const r = await run(net.text)
  if (r.status !== 200) throw new Error(r.body)
  return remap(JSON.parse(r.body) as JobResult, net)
}

describe.skipIf(!ready)("ESP32 module in a schematic", { timeout: 300_000 }, () => {
  afterEach(() => esp32Backend.stop())

  it("blinks an LED through the circuit and reads a pulled-up input", async () => {
    const r = await compileKirk(`circuit EspLed {
    ground GND
    U1 = lib("RF_Module:ESP32-WROOM-32")
    V1 = Vdc(3.3 V)
    R1 = R(330)
    D1 = LED("Red")
    R2 = R(10k)
    VDD -- V1 -- GND
    U1.IO4 -- R1 -- A -- D1' -- GND
    U1.IO15 -- IN -- R2 -- VDD
}
simulate tran(stop: 1 s, step: 1 ms)
`)
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    const doc = r.doc!
    const [b] = boardParts(doc)
    expect(b.board.id).toBe("esp32")
    const image = build(`void setup() { Serial.begin(115200); pinMode(4, OUTPUT); pinMode(15, INPUT); }
void loop() { digitalWrite(4, !digitalRead(4)); delay(100); Serial.printf("in=%d\\n", digitalRead(15)); }`, b.board)
    const chip = await esp32Chip(b.board, image)
    const sim = new CoSim(doc, [{ ref: b.part.ref, board: b.board, chip }], simulate, { frame: 0.05 })
    let serial = ""
    const ma: number[] = []
    // QEMU boots the ESP32 (ROM, bootloader, Arduino) for ~1 s first
    while (sim.t < 3) { const f = await sim.step(); serial += f.serial[b.part.ref]; ma.push((f.avg["I(D1)"] ?? 0) * 1000) }
    sim.dispose()
    const late = ma.slice(-30)
    // lit ≈ (3.3 − 1.8) / 355 ≈ 4 mA, dark ≈ 0
    expect(Math.max(...late)).toBeGreaterThan(3)
    expect(Math.min(...late)).toBeLessThan(0.5)
    expect(serial).toContain("in=1")
    expect(serial).not.toContain("in=0")
  })
})
