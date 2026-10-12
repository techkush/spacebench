// Board variants run on the emulators of the boards they're built on.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { BOARDS, boardByType } from "../boards"
import type { Connection, Diagram } from "../diagram"
import { McuSim } from "../sim"
import { CATALOG } from "."

const cli = ["/opt/homebrew/bin/arduino-cli", "/usr/local/bin/arduino-cli"].find((p) => fs.existsSync(p))
const cores = cli ? execFileSync(cli, ["core", "list"], { encoding: "utf8" }) : ""
function build(fqbn: string, code: string, ext: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbbrd-")), sk = path.join(dir, "sketch")
  fs.mkdirSync(sk); fs.writeFileSync(path.join(sk, "sketch.ino"), code)
  execFileSync(cli!, ["compile", "--fqbn", fqbn, "--build-path", path.join(os.tmpdir(), `sbbrd-${fqbn.replace(/\W/g, "_")}`), "--output-dir", path.join(dir, "out"), sk], { stdio: "pipe" })
  const f = path.join(dir, "out", `sketch.ino.${ext}`)
  return ext === "hex" ? fs.readFileSync(f, "utf8") : new Uint8Array(fs.readFileSync(f))
}
const diagram = (type: string, pin: string, gnd: string): Diagram => ({ version: 1, author: "", editor: "t", parts: [{ type, id: "b", top: 0, left: 0, attrs: {} }, { type: "wokwi-led", id: "led", top: 0, left: 0, attrs: {} }, { type: "wokwi-resistor", id: "r", top: 0, left: 0, attrs: { value: "220" } }],
  connections: ([[`b:${pin}`, "r:1"], ["r:2", "led:A"], ["led:C", `b:${gnd}`]] as [string, string][]).map(([a, c]) => [a, c, "", []] as Connection) })
function blink(type: string, pin: string, gnd: string, fw: string | Uint8Array) {
  const sim = new McuSim(diagram(type, pin, gnd), fw)
  const seen: number[] = []
  for (let i = 0; i < 40; i++) seen.push(sim.step(50, 50).leds.get("led")?.[0] ?? 0)
  return seen
}

describe("board variants", { timeout: 300_000 }, () => {
  it("every emulated catalogue board is a board, drawn with its header pins", () => {
    for (const c of CATALOG.filter((x) => x.board)) {
      const b = boardByType(c.type)
      expect(b, c.title).toBeTruthy()
      // a board, or an 8-pin chip like the ATtiny85
      if (!c.base) expect(c.pins.length, c.title).toBeGreaterThanOrEqual(8)
      for (const pin of c.pins) if (b!.pins[pin]) expect(b!.header ?? [], c.title).toContain(pin)
    }
    expect(new Set(BOARDS.map((b) => b.id)).size).toBe(BOARDS.length)
  })
  it.skipIf(!cores.includes("arduino:avr"))("DFRduino UNO R3 runs an Uno sketch", () => {
    const seen = blink("sb-dfrduino-uno", "9", "GND.1", build("arduino:avr:uno", "void setup(){pinMode(9,OUTPUT);} void loop(){digitalWrite(9,HIGH);delay(200);digitalWrite(9,LOW);delay(200);}", "hex"))
    expect(Math.max(...seen)).toBeGreaterThan(0.8); expect(Math.min(...seen)).toBeLessThan(0.05)
  })
  it.skipIf(!cores.includes("rp2040:rp2040"))("XIAO RP2040 blinks D0 (GPIO26)", () => {
    const seen = blink("sb-xiao-rp2040", "D0", "GND", build("rp2040:rp2040:seeed_xiao_rp2040", "void setup(){pinMode(D0,OUTPUT);} void loop(){digitalWrite(D0,HIGH);delay(200);digitalWrite(D0,LOW);delay(200);}", "bin"))
    expect(Math.max(...seen)).toBeGreaterThan(0.5) // 3.3 V through 220 Ω: ~6.5 mA; expect(Math.min(...seen)).toBeLessThan(0.05)
  })
})
