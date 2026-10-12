// The Arduino Mega 2560 runs: its SRAM starts at 0x200 (extended I/O below), so the stack at
// RAMEND 0x21FF must be inside the emulated memory. Needs arduino-cli with arduino:avr.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import type { Diagram } from "./diagram"
import { McuSim } from "./sim"

const cli = ["/opt/homebrew/bin/arduino-cli", "/usr/local/bin/arduino-cli"].find((p) => fs.existsSync(p))

describe.skipIf(!cli)("Arduino Mega 2560", { timeout: 120_000 }, () => {
  it("prints, uses nearly all of its 8 KB of RAM and drives a pin", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbmega-"))
    fs.mkdirSync(path.join(dir, "sketch"))
    fs.writeFileSync(path.join(dir, "sketch", "sketch.ino"), `
uint8_t big[7000];
void setup() {
  Serial.begin(115200);
  pinMode(13, OUTPUT);
  uint32_t sum = 0;
  for (int i = 0; i < 7000; i++) big[i] = i * 7;
  for (int i = 0; i < 7000; i++) sum += big[i];
  Serial.print("mega "); Serial.println(sum);
}
void loop() { digitalWrite(13, !digitalRead(13)); delay(50); }`)
    execFileSync(cli!, ["compile", "--fqbn", "arduino:avr:mega", "--output-dir", path.join(dir, "out"), path.join(dir, "sketch")], { encoding: "utf8" })
    const hex = fs.readFileSync(path.join(dir, "out", "sketch.ino.hex"), "utf8")
    const d: Diagram = { version: 1, author: "", editor: "t", parts: [{ type: "wokwi-arduino-mega", id: "mega", top: 0, left: 0, attrs: {} }], connections: [] }
    const sim = new McuSim(d, hex)
    let serial = ""
    sim.onSerial = (s) => (serial += s)
    let toggles = 0
    for (let t = 0; t < 600; t += 50) { const f = sim.step(50, 50); toggles += f.boardLed > 0.1 && f.boardLed < 0.9 ? 1 : 0 }
    // Σ (i·7 mod 256) over 7000 bytes
    let want = 0
    for (let i = 0; i < 7000; i++) want += (i * 7) & 0xff
    expect(serial).toContain(`mega ${want}`)
    expect(toggles).toBeGreaterThan(3)
  })
})

describe.skipIf(!cli)("AVR Serial", { timeout: 120_000 }, () => {
  it("keeps printing after a second Serial.begin() (libraries often begin it again)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbser-"))
    fs.mkdirSync(path.join(dir, "sketch"))
    fs.writeFileSync(path.join(dir, "sketch", "sketch.ino"), `void setup() { Serial.begin(115200); Serial.begin(57600); Serial.println("hi twice"); }
void loop() {}`)
    execFileSync(cli!, ["compile", "--fqbn", "arduino:avr:uno", "--output-dir", path.join(dir, "out"), path.join(dir, "sketch")], { encoding: "utf8" })
    const sim = new McuSim({ version: 1, author: "", editor: "t", parts: [{ type: "wokwi-arduino-uno", id: "uno", top: 0, left: 0, attrs: {} }], connections: [] }, fs.readFileSync(path.join(dir, "out", "sketch.ino.hex"), "utf8"))
    let serial = ""
    sim.onSerial = (s) => (serial += s)
    for (let t = 0; t < 300; t += 50) sim.step(50, 50)
    expect(serial).toContain("hi twice")
  })
})
