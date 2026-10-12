// Circuit + firmware together: real sketches (arduino-cli) on the emulator, the schematic on ngspice.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import zlib from "node:zlib"
import { describe, expect, it } from "vitest"
import { run } from "../../vite-ngspice"
import { compileKirk } from "@/kirk/compile"
import { remap, type JobResult } from "@/lib/engine"
import { getSymbol, loadSymbol, setLoader } from "@/lib/kicad"
import { buildNetlist, type SpiceNetlist } from "@/lib/spice"
import { deriveNetlist } from "@/editor/netlist"
import { loadExample } from "@/editor/examples"
import { boardByType } from "@/mcu/boards"
import { boardOf, boardParts, pinRole } from "./boards"
import { localChip } from "./chip"
import { CoSim, pinDrive } from "./cosim"

const KICAD = path.resolve(import.meta.dirname, "../../public/kicad")
setLoader(async (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(KICAD, `${f}.gz`))).toString()))

const ngspice = ["/opt/homebrew/bin/ngspice", "/usr/local/bin/ngspice", "/usr/bin/ngspice"].find((p) => fs.existsSync(p))
const cli = ["/opt/homebrew/bin/arduino-cli", "/usr/local/bin/arduino-cli"].find((p) => fs.existsSync(p))
const hasAvr = !!cli && execFileSync(cli, ["core", "list"], { encoding: "utf8" }).includes("arduino:avr")

function build(code: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbcosim-"))
  const sk = path.join(dir, "sketch"); fs.mkdirSync(sk)
  fs.writeFileSync(path.join(sk, "sketch.ino"), code)
  execFileSync(cli!, ["compile", "--fqbn", "arduino:avr:uno", "--build-path", path.join(os.tmpdir(), "sbcosim-build-uno"), "--output-dir", path.join(dir, "out"), sk], { encoding: "utf8" })
  return fs.readFileSync(path.join(dir, "out", "sketch.ino.hex"), "utf8")
}

const simulate = async (net: SpiceNetlist): Promise<JobResult> => {
  const r = await run(net.text)
  if (r.status !== 200) throw new Error(`${r.body}\n${net.text}`)
  return remap(JSON.parse(r.body) as JobResult, net)
}

async function circuit(code: string) {
  const r = await compileKirk(code)
  expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return r.doc!
}

describe("boards in a schematic", () => {
  it("knows which symbols run firmware and what their pins are", async () => {
    await loadSymbol("MCU_Module:Arduino_UNO_R3")
    const uno = boardOf({ lib: "MCU_Module:Arduino_UNO_R3" })!
    expect(uno.id).toBe("uno")
    expect(boardOf({ lib: "MCU_Module:Arduino_Nano_v3.x" })?.id).toBe("nano")
    expect(boardOf({ lib: "MCU_Module:RaspberryPi_Pico" })?.id).toBe("pico")
    expect(boardOf({ lib: "Device:R" })).toBeNull()
    const roles = Object.fromEntries(getSymbol("MCU_Module:Arduino_UNO_R3")!.units[0].pins.map((p) => [p.name, pinRole(uno, p.name)]))
    expect(roles["D13"]).toEqual({ k: "io", pin: "13" })
    expect(roles["D0/RX"]).toEqual({ k: "io", pin: "0" })
    expect(roles["SDA/A4"]).toEqual({ k: "io", pin: "A4" })
    expect(roles["+5V"]).toEqual({ k: "supply", volts: 5 })
    expect(roles["GND"]).toEqual({ k: "gnd" })
    expect(roles["~{RESET}"]).toBeNull()
    const pico = boardByType("wokwi-pi-pico")!
    expect(pinRole(pico, "GPIO26_ADC0")).toEqual({ k: "io", pin: "GP26" })
  })

  it("a fast-toggling pin is averaged; a steady one stays constant", () => {
    const edges = Array.from({ length: 1000 }, (_, i) => ({ pin: "1", t: (i + 1) * 1e-5, out: (i % 2 ? 1 : 0) as 0 | 1, pu: false, pd: false }))
    const d = pinDrive({ out: 1, pu: false, pd: false }, edges, 5, 0.02, 400)
    expect(Array.isArray(d.v)).toBe(true)
    expect(d.en).toBe(1)
    const steady = pinDrive({ out: -1, pu: true, pd: false }, [], 5, 0.02, 400)
    expect(steady).toEqual({ v: 0, en: 0, pu: 1, pd: 0 })
  })

  it("a plain simulation sees the board as a 5 V supply", async () => {
    const doc = await circuit(`circuit Supply {
    ground GND
    A1 = lib("MCU_Module:Arduino_UNO_R3")
    R1 = R(1k)
    A1.5 -- VCC -- R1 -- GND
    A1.6 -- GND
}
simulate op
`)
    const net = buildNetlist(doc, deriveNetlist(doc), "op")
    expect(net.text).toMatch(/^VA1_5_SUP /m)
    expect(net.issues.filter((i) => i.severity === "error")).toEqual([])
    if (!ngspice) return
    const op = await simulate(net)
    expect(op.type === "op" && op.values[op.names.indexOf("V(VCC)")]).toBeCloseTo(5, 1)
  })
})

describe.skipIf(!ngspice || !hasAvr)("circuit and firmware together", { timeout: 180_000 }, () => {
  it("PWM through an RC filter reads back on A0", async () => {
    const doc = await circuit(`circuit PwmDac {
    ground GND
    A1 = lib("MCU_Module:Arduino_UNO_R3")
    R1 = R(10k)
    C1 = C(10u)
    A1.D9 -- R1 -- OUT -- C1 -- GND
    A1.A0 -- OUT
    A1.6 -- GND
}
simulate tran(stop: 1 s, step: 1 ms)
`)
    const hex = build(`void setup() { Serial.begin(115200); pinMode(9, OUTPUT); analogWrite(9, 128); }
void loop() { delay(100); Serial.println(analogRead(A0)); }`)
    const [b] = boardParts(doc)
    const sim = new CoSim(doc, [{ ref: b.part.ref, board: b.board, chip: localChip(b.board, hex) }], simulate, { frame: 0.02 })
    let serial = ""
    let last = null as Awaited<ReturnType<CoSim["step"]>> | null
    while (sim.t < 0.8) { last = await sim.step(); serial += last.serial[b.part.ref] }
    // τ = 100 ms: after 8τ the filter sits at the PWM's mean, 128/255 × 5 V
    expect(last!.avg["V(OUT)"]).toBeGreaterThan(2.35)
    expect(last!.avg["V(OUT)"]).toBeLessThan(2.65)
    // the ripple of 490 Hz PWM through τ = 100 ms is a few mV, and the edges are in the waveform
    const pin = last!.window.data[last!.window.names.indexOf("V(OUT)")]
    expect(Math.max(...pin.slice(-200)) - Math.min(...pin.slice(-200))).toBeLessThan(0.05)
    const reads = serial.trim().split(/\s+/).map(Number)
    expect(reads.length).toBeGreaterThanOrEqual(6)
    expect(reads[0]).toBeLessThan(reads[reads.length - 1])
    expect(reads[reads.length - 1]).toBeGreaterThan(480)
    // the live code view: D9 is a ~50 % PWM output, A0 reads the filter's voltage
    const live = last!.live[b.part.ref]
    expect(live["9"].mode).toBe("out")
    expect(live["9"].duty).toBeGreaterThan(0.45)
    expect(live["9"].duty).toBeLessThan(0.55)
    expect(live["9"].toggles).toBeGreaterThan(2)
    expect(live.A0.v).toBeGreaterThan(2.3)
    expect(reads[reads.length - 1]).toBeLessThan(545)
  })

  it("the Arduino PWM DAC example runs its own sketch", async () => {
    const doc = await loadExample("arduino-pwm-dac")
    const [b] = boardParts(doc)
    const hex = build(doc.firmware![b.part.ref].files[0].content)
    const sim = new CoSim(doc, [{ ref: b.part.ref, board: b.board, chip: localChip(b.board, hex) }], simulate)
    let serial = ""
    while (sim.t < 0.6) serial += (await sim.step()).serial[b.part.ref]
    const volts = [...serial.matchAll(/A0 = ([\d.]+) V/g)].map((m) => Number(m[1]))
    expect(volts.length).toBeGreaterThan(5)
    // the duty ramps up 5 per 50 ms, so the filtered voltage climbs
    expect(volts[volts.length - 1]).toBeGreaterThan(volts[1])
  })

  it("the circuit decides what the sketch reads, the sketch lights the LED", async () => {
    const doc = await circuit(`circuit Pull {
    ground GND
    A1 = lib("MCU_Module:Arduino_UNO_R3")
    R1 = R(1k)
    R2 = R(220)
    D1 = LED("red")
    A1.D2 -- R1 -- GND
    A1.D13 -- R2 -- LED_A -- D1' -- GND
    A1.6 -- GND
}
simulate tran(stop: 100 ms, step: 100 us)
`)
    // the 1 kΩ to ground beats the 35 kΩ pull-up: D2 reads LOW, so D13 goes HIGH
    const hex = build(`void setup() { pinMode(2, INPUT_PULLUP); pinMode(13, OUTPUT); }
void loop() { digitalWrite(13, digitalRead(2) == LOW ? HIGH : LOW); }`)
    const [b] = boardParts(doc)
    const sim = new CoSim(doc, [{ ref: b.part.ref, board: b.board, chip: localChip(b.board, hex) }], simulate)
    let f = await sim.step()
    for (let i = 0; i < 3; i++) f = await sim.step()
    const d2 = Object.entries(f.avg).find(([k]) => k === "V(" + deriveNetlist(doc).pinNet.get("A1.17") + ")")?.[1]
    expect(d2).toBeLessThan(0.3)
    const i = f.avg["I(D1)"]
    expect(i).toBeGreaterThan(0.008)
    expect(i).toBeLessThan(0.016)
  })
})
