// Every built-in microcontroller example compiles with arduino-cli and does what it says.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import type { Diagram } from "./diagram"
import { MCU_EXAMPLES } from "./examples"
import { McuSim, type Frame } from "./sim"
import { badgeFor, findConstants, findSpots, resolvePin } from "./live-code"

const cli = ["/opt/homebrew/bin/arduino-cli", "/usr/local/bin/arduino-cli"].find((p) => fs.existsSync(p))
const hasAvr = !!cli && execFileSync(cli, ["core", "list"], { encoding: "utf8" }).includes("arduino:avr")

function build(id: string, code: string) {
  const dir = path.join(os.tmpdir(), `sbex-${id}`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.join(dir, "sketch"), { recursive: true })
  fs.writeFileSync(path.join(dir, "sketch", "sketch.ino"), code)
  execFileSync(cli!, ["compile", "--fqbn", "arduino:avr:uno", "--build-path", path.join(dir, "build"), "--output-dir", path.join(dir, "out"), path.join(dir, "sketch")], { encoding: "utf8", stdio: "pipe" })
  return fs.readFileSync(path.join(dir, "out", "sketch.ino.hex"), "utf8")
}

function run(id: string, seconds: number, setup?: (s: McuSim) => void) {
  const ex = MCU_EXAMPLES.find((e) => e.id === id)!
  const sim = new McuSim(ex.diagram, build(id, ex.files[0].content))
  let serial = ""
  sim.onSerial = (s) => (serial += s)
  setup?.(sim)
  const frames: Frame[] = []
  for (let t = 0; t < seconds * 1000; t += 50) frames.push(sim.step(50, 50))
  return { sim, serial, frames, last: frames[frames.length - 1] }
}
const maxLed = (frames: Frame[], id: string, i = 0) => Math.max(...frames.map((f) => f.leds.get(id)?.[i] ?? 0))

describe.skipIf(!hasAvr)("examples", { timeout: 120_000 }, () => {
  it("blink", () => { const r = run("blink", 1.2); expect(r.serial).toContain("LED ON"); expect(maxLed(r.frames, "led1")).toBeGreaterThan(0.8); expect(r.last.warnings).toEqual([]) })
  it("button", () => { const r = run("button", 0.3, (s) => s.setUi("btn1", { pressed: true })); expect(r.serial).toContain("pressed"); expect(maxLed(r.frames, "led1")).toBeGreaterThan(0.5) })
  it("fade", () => { const r = run("fade", 2); const b = r.frames.map((f) => f.leds.get("led1")?.[0] ?? 0); expect(Math.max(...b)).toBeGreaterThan(0.7); expect(Math.min(...b.slice(4))).toBeLessThan(0.4) })
  it("pot", () => { const r = run("pot", 0.6); expect(r.serial).toMatch(/A0 = 51\d/) })
  it("traffic", () => { const r = run("traffic", 1); expect(r.serial).toContain("green"); expect(maxLed(r.frames, "led3")).toBeGreaterThan(0.5); expect(maxLed(r.frames, "led1")).toBeLessThan(0.05) })
  it("rgb", () => { const r = run("rgb", 0.4); expect(maxLed(r.frames, "rgb1", 0)).toBeGreaterThan(0.5) })
  it("melody", () => { const r = run("melody", 0.6); const f = r.frames.map((x) => x.buzzer.get("bz1") ?? 0).filter((x) => x > 0); expect(f.length).toBeGreaterThan(2); expect(Math.min(...f)).toBeGreaterThan(200); expect(Math.max(...f)).toBeLessThan(600) })
  it("servo", () => { const r = run("servo", 0.5); const a = r.last.servo.get("servo1")!; expect(a).toBeGreaterThan(45); expect(a).toBeLessThan(60) })
  it("lcd", () => { const r = run("lcd", 1.6); const t = String.fromCharCode(...r.last.lcd.get("lcd1")!.chars); expect(t).toContain("Hello, Space Ben"); expect(t).toContain("Uptime") })
  it("lcd-parallel", () => { const r = run("lcd-parallel", 0.5); const t = String.fromCharCode(...r.last.lcd.get("lcd1")!.chars); expect(t).toContain("Parallel LCD") })
  it("oled", () => { const r = run("oled", 0.8); const o = r.last.oled.get("oled1")!; expect(o.on).toBe(true); expect(o.ram.reduce((a, b) => a + (b ? 1 : 0), 0)).toBeGreaterThan(50) })
  it("7seg", () => { const r = run("7seg", 0.3); const segs = r.last.leds.get("seg1")!; expect(segs.slice(0, 6).every((b) => b > 0.3)).toBe(true); expect((segs[6] ?? 0) < 0.05).toBe(true) }) // "0": a–f on, g off
  it("thermometer", () => { const r = run("thermometer", 0.6); expect(r.serial).toMatch(/Temperature: 2[34]\.\d C/) })
  it("ultrasonic", () => { const r = run("ultrasonic", 0.7); expect(r.serial).toMatch(/Distance: (99|100|101) cm/) })
  it("dht22", () => { const r = run("dht22", 2.3); expect(r.serial).toMatch(/Humidity: 40\.0 %\s+Temperature: 24\.0 C/) })
  it("neopixel", () => { const r = run("neopixel", 0.3); const c = r.last.neopixel.get("px1")?.[0]; expect(c).toBeDefined(); expect(c!.some((x) => x > 0)).toBe(true) })
  it("serial-echo", () => { const r = run("serial-echo", 0.3, (s) => setTimeout(() => {}, 0)); r.sim.serialWrite("1\n"); let out = ""; r.sim.onSerial = (s) => (out += s); for (let i = 0; i < 30; i++) r.sim.step(50, 50); expect(out).toContain("You sent: 1"); expect(r.sim.step(50, 50).boardLed).toBeGreaterThan(0.9) })
})

describe.skipIf(!hasAvr)("breadboard", { timeout: 120_000 }, () => {
  it("seated parts conduct through the strips", async () => {
    // what the canvas computes from geometry: LED and resistor pins on their holes
    const ex = MCU_EXAMPLES.find((e) => e.id === "breadboard")!
    const seated: Diagram["connections"] = [["led1:C", "bb1:10t.e", "", []], ["led1:A", "bb1:11t.e", "", []], ["r1:1", "bb1:11t.b", "", []], ["r1:2", "bb1:17t.b", "", []]]
    const sim = new McuSim({ ...ex.diagram, connections: [...ex.diagram.connections, ...seated] }, build("breadboard", ex.files[0].content))
    const b: number[] = []
    for (let i = 0; i < 20; i++) b.push(sim.step(50, 50).leds.get("led1")?.[0] ?? 0)
    expect(Math.max(...b)).toBeGreaterThan(0.8)
    expect(Math.min(...b)).toBeLessThan(0.05)
  })
})

describe.skipIf(!hasAvr)("IoT projects", { timeout: 300_000 }, () => {
  it("night light turns on in the dark", () => { const r = run("iot-night-light", 1); expect(r.serial).toContain("lamp ON"); expect(maxLed(r.frames, "led1")).toBeGreaterThan(0.5) })
  it("parking sensor: 35 cm is yellow and beeps", () => { const r = run("iot-parking", 1.2); expect(r.serial).toMatch(/3[456] cm/); expect(maxLed(r.frames, "y1")).toBeGreaterThan(0.5); expect(maxLed(r.frames, "r1")).toBeLessThan(0.05); expect(r.frames.some((f) => (f.buzzer.get("bz1") ?? 0) > 1000)).toBe(true) })
  it("PIR alarm sounds on motion", () => { const r = run("iot-intruder", 0.3, (s) => s.setUi("pir1", { active: true })); expect(r.serial).toContain("MOTION"); expect(r.frames.some((f) => (f.buzzer.get("bz1") ?? 0) > 1000)).toBe(true) })
  it("thermostat heats at 18 °C", () => { const r = run("iot-thermostat", 1.8); expect(r.serial).toMatch(/1[78]\.\d C heating/); expect(maxLed(r.frames, "heat")).toBeGreaterThan(0.5); expect(String.fromCharCode(...r.last.lcd.get("lcd1")!.chars)).toContain("Heater: ON") })
  it("weather station shows the DHT22 on the OLED", () => { const r = run("iot-weather", 2.6); expect(r.serial).toMatch(/27\.5 C\s+61 %/); expect(r.last.oled.get("oled1")!.ram.some((b) => b)).toBe(true) })
  it("joystick centre → servo 90°", () => { const r = run("iot-joystick-servo", 0.4); const a = r.last.servo.get("servo1")!; expect(a).toBeGreaterThan(80); expect(a).toBeLessThan(100) })
  it("counter counts a press", () => { const r = run("iot-counter", 0.3); r.sim.setUi("btn1", { pressed: true }); let out = ""; r.sim.onSerial = (s) => (out += s); for (let i = 0; i < 4; i++) r.sim.step(50, 50); expect(out).toContain("presses: 1") })
  it("reaction timer waits, then reports", () => { const r = run("iot-reaction", 3.6, (s) => s.setUi("btn1", { pressed: true })); expect(r.serial).toMatch(/reaction \d+ ms/) })
  it("plant monitor: 20 % is red", () => { const r = run("iot-plant", 0.7); expect(r.serial).toContain("water me"); expect(maxLed(r.frames, "rgb1", 0)).toBeGreaterThan(0.5); expect(maxLed(r.frames, "rgb1", 1)).toBeLessThan(0.05) })
  it("Grove starter: knob dims the LED, the button runs the motor through the relay", () => {
    const r = run("grove-starter", 1.2, (s) => s.setUi("knob", { v: { value: 300 } }))
    expect(r.serial).toMatch(/Temperature: 2[45]\.\d C, motor OFF/)
    expect(maxLed(r.frames, "led")).toBeGreaterThan(0.5)
    expect(r.last.mods.get("relay")?.on).toBe(0)
    r.sim.setUi("btn", { pressed: true })
    let f = r.sim.step(100, 100)
    for (let i = 0; i < 5; i++) f = r.sim.step(50, 50)
    expect(f.mods.get("relay")?.on).toBe(1)
    expect(f.mods.get("motor")?.angle).toBeDefined()
    expect(f.mods.get("motor")!.angle!).not.toBe(0)
  })
  it("dice rolls 1–6", () => { const r = run("iot-dice", 0.2); r.sim.setUi("btn1", { pressed: true }); let out = ""; r.sim.onSerial = (s) => (out += s); for (let i = 0; i < 40; i++) r.sim.step(50, 50); expect(out).toMatch(/rolled [1-6]/) })
})

describe.skipIf(!hasAvr)("live code view", { timeout: 120_000 }, () => {
  it("shows the pot's voltage on its analogRead line and the fading LED's PWM", () => {
    const pot = run("pot", 0.6), code = MCU_EXAMPLES.find((e) => e.id === "pot")!.files[0].content
    const read = findSpots(code).find((s) => s.kind === "aread")!
    const pin = resolvePin(read.arg!, findConstants(code), Object.keys(pot.last.live!), "13")
    expect(pin).toBe("A0")
    const b = badgeFor(read, pin, pot.last.live!, { vcc: 5, seconds: 0.6, serial: pot.serial })!
    expect(b.tone).toBe("analog")
    expect(b.text).toMatch(/A0 2\.\d\d V/)
    const fade = run("fade", 1)
    const pwm = Object.values(fade.frames[10].live!).find((p) => p.mode === "out" && p.toggles > 1)
    expect(pwm?.duty).toBeGreaterThan(0)
  })
})
