// The building blocks the part models stand on, with real compiled sketches on the Uno: hardware
// SPI (SPI.transfer) and bit-banged SPI reach a device whose CS is low, and hardware Serial
// reaches a UART device that answers. Needs arduino-cli with arduino:avr.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import type { Connection, Diagram } from "../../diagram"
import { McuSim } from "../../sim"
import { catalogPart } from "../index"
import type { CatalogPart } from "../types"
import { PROTO } from "./index"

const cli = ["/opt/homebrew/bin/arduino-cli", "/usr/local/bin/arduino-cli"].find((p) => fs.existsSync(p))

function build(code: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbinfra-"))
  const sk = path.join(dir, "sketch"); fs.mkdirSync(sk)
  fs.writeFileSync(path.join(sk, "sketch.ino"), code)
  execFileSync(cli!, ["compile", "--fqbn", "arduino:avr:uno", "--output-dir", path.join(dir, "out"), sk], { encoding: "utf8" })
  return fs.readFileSync(path.join(dir, "out", "sketch.ino.hex"), "utf8")
}
/** a catalogue part borrowed for the test: its model is a test kind with the given pins */
function borrow(type: string, kind: string, pins: string[]): CatalogPart {
  const c = catalogPart(type)!
  Object.assign(c, { model: { m: "proto", kind }, pins })
  return c
}
function run(code: string, type: string, wires: [string, string][], ms = 600) {
  const d: Diagram = { version: 1, author: "", editor: "t", parts: [{ type: "wokwi-arduino-uno", id: "uno", top: 0, left: 0, attrs: {} }, { type, id: "d", top: 0, left: 0, attrs: {} }], connections: wires.map(([a, b]) => [a, b, "", []] as Connection) }
  const sim = new McuSim(d, build(code))
  let serial = ""
  sim.onSerial = (s) => (serial += s)
  for (let t = 0; t < ms; t += 50) sim.step(50, 50)
  return serial
}

describe.skipIf(!cli)("model building blocks", { timeout: 120_000 }, () => {
  it("SPI: hardware transfers and bit-banged clocks reach the device while CS is low", () => {
    // an echo device: answers each byte with the previous one + 1, counts selects
    const log: string[] = []
    PROTO["test-spi"] = (_c, ctx) => {
      let last = 0x40
      ctx.spi({ out: () => last + 1, in: (b) => { log.push(b.toString(16)); last = b }, select: () => log.push("sel"), deselect: () => log.push("desel") })
      return {}
    }
    const type = "sb-max31865-pt100-rtd"
    borrow(type, "test-spi", ["VIN", "GND", "CLK", "SDO", "SDI", "CS"])
    const wires: [string, string][] = [["d:GND", "uno:GND.1"], ["d:VIN", "uno:5V"], ["d:CLK", "uno:13"], ["d:SDO", "uno:12"], ["d:SDI", "uno:11"], ["d:CS", "uno:10"]]
    const hw = run(`#include <SPI.h>
void setup(){ Serial.begin(115200); SPI.begin(); pinMode(10, OUTPUT); digitalWrite(10, HIGH);
  digitalWrite(10, LOW); uint8_t a = SPI.transfer(0x10); uint8_t b = SPI.transfer(0x20); digitalWrite(10, HIGH);
  uint8_t c = SPI.transfer(0x99); // CS high: nobody answers
  Serial.print(a, HEX); Serial.print(" "); Serial.print(b, HEX); Serial.print(" "); Serial.println(c, HEX); }
void loop(){}`, type, wires)
    expect(hw.trim()).toBe("41 11 FF")
    expect(log).toEqual(["sel", "10", "20", "desel"])
    log.length = 0
    const bb = run(`void setup(){ Serial.begin(115200); digitalWrite(10, HIGH); pinMode(10, OUTPUT); pinMode(13, OUTPUT); pinMode(11, OUTPUT); pinMode(12, INPUT);
  digitalWrite(10, HIGH); digitalWrite(13, LOW); digitalWrite(10, LOW);
  uint8_t r = 0; uint8_t tx = 0x5A;
  for (int i = 7; i >= 0; i--) { digitalWrite(11, (tx >> i) & 1); digitalWrite(13, HIGH); if (digitalRead(12)) r |= 1 << i; digitalWrite(13, LOW); }
  digitalWrite(10, HIGH); Serial.println(r, HEX); }
void loop(){}`, type, wires)
    expect(bb.trim()).toBe("41")
    expect(log, log.join(" ")).toEqual(["sel", "5a", "desel"])
  })

  it("UART: hardware Serial reaches the part, and its answer reaches Serial.read()", () => {
    PROTO["test-uart"] = (_c, ctx) => {
      let line = ""
      const port = ctx.uart({ baud: 115200, onByte: (b) => { if (b === 10) { if (line === "AT") port.send("OK\r\n"); line = "" } else if (b !== 13) line += String.fromCharCode(b) } })
      return {}
    }
    const type = "sb-grove-ble-hm-11"
    borrow(type, "test-uart", ["GND", "VCC", "RX", "TX"])
    const out = run(`void setup(){ Serial.begin(115200); Serial.println("AT"); }
void loop(){ while (Serial.available()) { char c = Serial.read(); if (c == 'O') Serial.println("got O"); } }`, type,
      [["d:GND", "uno:GND.1"], ["d:VCC", "uno:5V"], ["d:RX", "uno:1"], ["d:TX", "uno:0"]])
    expect(out).toContain("AT")
    expect(out).toContain("got O")
  })
})
