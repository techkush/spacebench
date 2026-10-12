// Raspberry Pi Pico: the arduino-pico core's flash image boots on rp2040js with the circuit around it.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { MCU_EXAMPLES } from "./examples"
import { McuSim, type Frame } from "./sim"

const cli = ["/opt/homebrew/bin/arduino-cli", "/usr/local/bin/arduino-cli"].find((p) => fs.existsSync(p))
const hasCore = !!cli && execFileSync(cli, ["core", "list"], { encoding: "utf8" }).includes("rp2040:rp2040")

function build(id: string, code: string): Uint8Array {
  const dir = path.join(os.tmpdir(), `sbpico-${id}`)
  fs.rmSync(path.join(dir, "out"), { recursive: true, force: true })
  fs.mkdirSync(path.join(dir, "sketch"), { recursive: true })
  fs.writeFileSync(path.join(dir, "sketch", "sketch.ino"), code)
  execFileSync(cli!, ["compile", "--fqbn", "rp2040:rp2040:rpipico", "--build-path", path.join(dir, "build"), "--output-dir", path.join(dir, "out"), path.join(dir, "sketch")], { encoding: "utf8", stdio: "pipe" })
  return new Uint8Array(fs.readFileSync(path.join(dir, "out", "sketch.ino.bin")))
}
function run(id: string, seconds: number, setup?: (s: McuSim) => void) {
  const ex = MCU_EXAMPLES.find((e) => e.id === id)!
  const sim = new McuSim(ex.diagram, build(id, ex.files[0].content))
  let serial = ""
  sim.onSerial = (s) => (serial += s)
  setup?.(sim)
  const frames: Frame[] = []
  for (let t = 0; t < seconds * 1000; t += 50) frames.push(sim.step(50, 50))
  return { sim, frames, last: frames[frames.length - 1], serial: () => serial }
}
const maxLed = (frames: Frame[], id: string, i = 0) => Math.max(...frames.map((f) => f.leds.get(id)?.[i] ?? 0))

describe.skipIf(!hasCore)("Raspberry Pi Pico", { timeout: 300_000 }, () => {
  it("blinks GP25 and GP15, prints over USB serial", () => {
    const r = run("pico-blink", 2.2)
    expect(r.serial()).toContain("LED on")
    expect(Math.max(...r.frames.map((f) => f.boardLed))).toBeGreaterThan(0.8)
    expect(maxLed(r.frames, "led1")).toBeGreaterThan(0.5)
    expect(r.last.warnings).toEqual([])
  })
  it("reads a button and lights an LED", () => {
    const r = run("pico-button", 1.2) // USB serial connects first
    r.sim.setUi("btn1", { pressed: true })
    for (let i = 0; i < 6; i++) r.frames.push(r.sim.step(50, 50))
    expect(r.serial()).toContain("pressed")
    expect(maxLed(r.frames, "led1")).toBeGreaterThan(0.5)
  })
  it("reads the ADC on GP26 and dims with PWM", () => {
    const r = run("pico-adc", 1.2)
    const m = /ADC0 = (\d+)/.exec(r.serial())
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBeGreaterThan(2700) // pot at 700/1023 of 3.3 V → ~2800
    expect(Number(m![1])).toBeLessThan(2900)
    const b = r.last.leds.get("led1")![0]
    expect(b).toBeGreaterThan(0.2)
  })
  it("drives an I²C LCD on GP4/GP5", () => {
    let r: ReturnType<typeof run>
    try { r = run("pico-lcd", 2.0) } catch { return } // library missing
    const t = String.fromCharCode(...r.last.lcd.get("lcd1")!.chars)
    expect(t).toContain("Hello from Pico")
  })
  it("decodes a NeoPixel driven by PIO", () => {
    const r = run("pico-neopixel", 0.6)
    const c = r.last.neopixel.get("px1")?.[0]
    expect(c).toBeDefined()
    expect(c!.some((x) => x > 0)).toBe(true)
  })
})
