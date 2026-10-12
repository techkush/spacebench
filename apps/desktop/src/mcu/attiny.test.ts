// ATtiny85 (ATTinyCore) on avr8js: Timer0's millis(), the ADC and the bit-banged Serial on PB0.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import zlib from "node:zlib"
import { AvrMachine } from "./avr"
import { boardByType } from "./boards"
import { run } from "../../vite-ngspice"
import { compileKirk } from "@/kirk/compile"
import { boardParts } from "@/cosim/boards"
import { localChip } from "@/cosim/chip"
import { CoSim } from "@/cosim/cosim"
import { remap, type JobResult } from "@/lib/engine"
import { setLoader } from "@/lib/kicad"
import type { SpiceNetlist } from "@/lib/spice"

const KICAD = path.resolve(import.meta.dirname, "../../public/kicad")
setLoader(async (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(KICAD, `${f}.gz`))).toString()))
const ngspice = ["/opt/homebrew/bin/ngspice", "/usr/local/bin/ngspice"].find((p) => fs.existsSync(p))
const simulate = async (net: SpiceNetlist): Promise<JobResult> => {
  const r = await run(net.text)
  if (r.status !== 200) throw new Error(r.body)
  return remap(JSON.parse(r.body) as JobResult, net)
}

const cli = ["/opt/homebrew/bin/arduino-cli", "/usr/local/bin/arduino-cli"].find((p) => fs.existsSync(p))
const hasCore = !!cli && execFileSync(cli, ["core", "list"], { encoding: "utf8" }).includes("ATTinyCore:avr")
const board = boardByType("sb-attiny85")!

function build(code: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbtiny-"))
  const sk = path.join(dir, "sketch"); fs.mkdirSync(sk)
  fs.writeFileSync(path.join(sk, "sketch.ino"), code)
  execFileSync(cli!, ["compile", "--fqbn", board.fqbn, "--build-path", path.join(os.tmpdir(), "sbtiny-build"), "--output-dir", path.join(dir, "out"), sk], { encoding: "utf8" })
  return fs.readFileSync(path.join(dir, "out", "sketch.ino.hex"), "utf8")
}

describe.skipIf(!hasCore)("ATtiny85", { timeout: 120_000 }, () => {
  it("blinks PB1 on millis() timing, reads the ADC and prints on the software Serial", () => {
    const hex = build(`void setup() { Serial.begin(9600); pinMode(1, OUTPUT); }
void loop() { digitalWrite(1, HIGH); delay(20); digitalWrite(1, LOW); delay(20); Serial.println(analogRead(A1)); }`)
    const m = new AvrMachine(board, hex)
    let serial = ""
    m.onSerial = (t) => (serial += t)
    const rises: number[] = []
    let last = false
    m.onPinChange = (pins) => {
      if (!pins.includes("PB1")) return
      const high = m.track.get("PB1")!.out === true
      if (high && !last) rises.push(m.seconds)
      last = high
    }
    m.setAnalog(1, 2.5) // ADC1 = PB2 = A1
    m.runFor(Math.round(0.6 * board.hz))
    // one blink every 40 ms (plus the time Serial takes at 9600 baud: ~4 ms for "512\\r\\n")
    const periods = rises.slice(1).map((t, i) => t - rises[i])
    expect(periods.length).toBeGreaterThan(5)
    for (const p of periods.slice(1)) { expect(p).toBeGreaterThan(0.040); expect(p).toBeLessThan(0.052) }
    const reads = serial.trim().split(/\s+/).map(Number)
    expect(reads.length).toBeGreaterThan(5)
    for (const r of reads) { expect(r).toBeGreaterThan(500); expect(r).toBeLessThan(524) }
  })

  it.skipIf(!ngspice)("a bare ATtiny85 in a schematic blinks an LED (co-simulated with ngspice)", async () => {
    const r = await compileKirk(`circuit TinyLed {
    ground GND
    U1 = lib("MCU_Microchip_ATtiny:ATtiny85-20P")
    R1 = R(330)
    D1 = LED("Red")
    U1.PB1 -- R1 -- A -- D1' -- GND
}
simulate tran(stop: 1 s, step: 1 ms)
`)
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    const doc = r.doc!
    const [b] = boardParts(doc)
    expect(b.board.name).toBe("ATtiny85")
    const hex = build(`void setup() { pinMode(1, OUTPUT); } void loop() { digitalWrite(1, !digitalRead(1)); delay(50); }`)
    const sim = new CoSim(doc, [{ ref: b.part.ref, board: b.board, chip: localChip(b.board, hex) }], simulate, { frame: 0.025 })
    const ma: number[] = []
    while (sim.t < 0.4) ma.push(((await sim.step()).avg["I(D1)"] ?? 0) * 1000)
    // 5 V − 1.8 V over 355 Ω ≈ 9 mA when lit, 0 when not
    expect(Math.max(...ma)).toBeGreaterThan(8)
    expect(Math.min(...ma)).toBeLessThan(0.5)
  })
})
