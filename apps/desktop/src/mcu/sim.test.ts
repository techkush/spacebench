// End-to-end: real sketches compiled by arduino-cli, run on the emulator with a circuit around them.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { parseDiagnostics } from "./compile"
import type { Diagram } from "./diagram"
import { McuSim } from "./sim"

const cli = ["/opt/homebrew/bin/arduino-cli", "/usr/local/bin/arduino-cli"].find((p) => fs.existsSync(p))
const hasAvr = !!cli && execFileSync(cli, ["core", "list"], { encoding: "utf8" }).includes("arduino:avr")

function build(code: string, fqbn = "arduino:avr:uno"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbtest-"))
  const sk = path.join(dir, "sketch"); fs.mkdirSync(sk)
  fs.writeFileSync(path.join(sk, "sketch.ino"), code)
  execFileSync(cli!, ["compile", "--fqbn", fqbn, "--build-path", path.join(os.tmpdir(), `sbtest-build-${fqbn.replace(/\W/g, "_")}`), "--output-dir", path.join(dir, "out"), sk], { encoding: "utf8" })
  return fs.readFileSync(path.join(dir, "out", "sketch.ino.hex"), "utf8")
}
const uno = (parts: Diagram["parts"], connections: Diagram["connections"]): Diagram => ({ version: 1, author: "", editor: "t", parts: [{ type: "wokwi-arduino-uno", id: "uno", top: 0, left: 0, attrs: {} }, ...parts], connections })

describe.skipIf(!hasAvr)("microcontroller simulation", { timeout: 120_000 }, () => {
  it("blinks an LED through a resistor and prints to Serial", () => {
    const hex = build(`void setup(){ pinMode(13, OUTPUT); Serial.begin(9600); Serial.println("ready"); }
void loop(){ digitalWrite(13, HIGH); delay(100); digitalWrite(13, LOW); delay(100); }`)
    const d = uno([{ type: "wokwi-led", id: "led1", top: 0, left: 0, attrs: { color: "red" } }, { type: "wokwi-resistor", id: "r1", top: 0, left: 0, attrs: { value: "220" } }],
      [["uno:13", "r1:1", "green", []], ["r1:2", "led1:A", "green", []], ["led1:C", "uno:GND.1", "black", []]])
    const sim = new McuSim(d, hex)
    let serial = ""
    sim.onSerial = (s) => (serial += s)
    const seen: number[] = []
    for (let i = 0; i < 12; i++) seen.push(sim.step(25, 25).leds.get("led1")?.[0] ?? 0)
    expect(serial).toContain("ready")
    expect(Math.max(...seen)).toBeGreaterThan(0.8)
    expect(Math.min(...seen)).toBeLessThan(0.05)
    const f = sim.step(1, 1)
    expect(f.warnings).toEqual([])
  })

  it("warns about an LED without a resistor", () => {
    const hex = build(`void setup(){ pinMode(7, OUTPUT); digitalWrite(7, HIGH); } void loop(){}`)
    const sim = new McuSim(uno([{ type: "wokwi-led", id: "led1", top: 0, left: 0, attrs: {} }], [["uno:7", "led1:A", "", []], ["led1:C", "uno:GND.2", "", []]]), hex)
    const f = sim.step(10, 10)
    expect(f.warnings.join()).toMatch(/led1 draws \d+ mA/)
  })

  it("reads a button with INPUT_PULLUP and a pot on A0; PWM dims an LED", () => {
    const hex = build(`void setup(){ pinMode(2, INPUT_PULLUP); pinMode(9, OUTPUT); Serial.begin(115200); }
void loop(){ analogWrite(9, analogRead(A0) / 4); Serial.println(digitalRead(2) ? "up" : "down"); delay(20); }`)
    const d = uno([
      { type: "wokwi-pushbutton", id: "btn1", top: 0, left: 0, attrs: {} },
      { type: "wokwi-potentiometer", id: "pot1", top: 0, left: 0, attrs: {} },
      { type: "wokwi-led", id: "led1", top: 0, left: 0, attrs: {} }, { type: "wokwi-resistor", id: "r1", top: 0, left: 0, attrs: { value: "220" } },
    ], [
      ["uno:2", "btn1:1.l", "", []], ["btn1:2.r", "uno:GND.1", "", []],
      ["pot1:VCC", "uno:5V", "", []], ["pot1:GND", "uno:GND.2", "", []], ["pot1:SIG", "uno:A0", "", []],
      ["uno:9", "r1:1", "", []], ["r1:2", "led1:A", "", []], ["led1:C", "uno:GND.3", "", []],
    ])
    const sim = new McuSim(d, hex)
    let serial = ""
    sim.onSerial = (s) => (serial += s)
    sim.setUi("pot1", { value: 1023 })
    sim.step(100, 100)
    const full = sim.step(50, 50).leds.get("led1")![0]
    expect(serial).toContain("up")
    sim.setUi("btn1", { pressed: true })
    serial = ""
    sim.step(60, 60)
    expect(serial).toContain("down")
    sim.setUi("pot1", { value: 200 })
    sim.step(60, 60)
    const dim = sim.step(50, 50).leds.get("led1")![0]
    expect(full).toBeGreaterThan(0.8)
    expect(dim).toBeGreaterThan(0.05)
    expect(dim).toBeLessThan(full * 0.75)
  })

  it("drives an I²C LCD (LiquidCrystal_I2C) and a servo", () => {
    let hex: string
    try {
      hex = build(`#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <Servo.h>
LiquidCrystal_I2C lcd(0x27, 16, 2); Servo s;
void setup(){ lcd.init(); lcd.backlight(); lcd.setCursor(0,0); lcd.print("Hello"); lcd.setCursor(0,1); lcd.print("Space Bench"); s.attach(9); s.write(90); }
void loop(){}`)
    } catch { return } // libraries not installed in this environment
    const sim = new McuSim(uno([{ type: "wokwi-lcd1602", id: "lcd1", top: 0, left: 0, attrs: { pins: "i2c" } }, { type: "wokwi-servo", id: "sv", top: 0, left: 0, attrs: {} }],
      [["lcd1:SDA", "uno:A4", "", []], ["lcd1:SCL", "uno:A5", "", []], ["lcd1:VCC", "uno:5V", "", []], ["lcd1:GND", "uno:GND.1", "", []], ["sv:PWM", "uno:9", "", []]]), hex)
    let f = sim.step(200, 200)
    for (let i = 0; i < 18; i++) f = sim.step(100, 100) // LiquidCrystal_I2C waits 1 s in init()
    const text = String.fromCharCode(...f.lcd.get("lcd1")!.chars)
    expect(text.slice(0, 16).trim()).toBe("Hello")
    expect(text.slice(16).trim()).toBe("Space Bench")
    expect(f.servo.get("sv")).toBeGreaterThan(85)
    expect(f.servo.get("sv")).toBeLessThan(95)
  })

  it("parses compiler errors", () => {
    expect(parseDiagnostics("sketch.ino:4:3: error: 'foo' was not declared in this scope\nsketch.ino:9:1: warning: unused")).toEqual([
      { file: "sketch.ino", line: 4, col: 3, severity: "error", message: "'foo' was not declared in this scope" },
      { file: "sketch.ino", line: 9, col: 1, severity: "warning", message: "unused" },
    ])
  })
})
