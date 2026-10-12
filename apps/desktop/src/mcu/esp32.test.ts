// ESP32 on Espressif's QEMU: the bridge reports pin activity; the circuit lights the LED;
// inputs (button, ADC) go back to the firmware.
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { boardById } from "./boards"
import { ESP32_BRIDGE, ESP32_BRIDGE_FILE } from "./esp32/bridge"
import { Esp32Machine } from "./esp32/machine"
import { MCU_EXAMPLES } from "./examples"
import { McuSim } from "./sim"

const cli = ["/opt/homebrew/bin/arduino-cli", "/usr/local/bin/arduino-cli"].find((p) => fs.existsSync(p))
const qemu = (() => { try { const r = path.join(os.homedir(), ".espressif/tools/qemu-xtensa"); for (const v of fs.readdirSync(r).sort().reverse()) { const p = path.join(r, v, "qemu/bin/qemu-system-xtensa"); if (fs.existsSync(p)) return p } } catch { /* none */ } return null })()
const hasCore = !!cli && execFileSync(cli, ["core", "list"], { encoding: "utf8" }).includes("esp32:esp32")
const board = boardById("esp32")!

function build(id: string): string {
  const ex = MCU_EXAMPLES.find((e) => e.id === id)!
  const dir = path.join(os.tmpdir(), `sbesp-${id}`)
  fs.mkdirSync(path.join(dir, "sketch"), { recursive: true })
  fs.writeFileSync(path.join(dir, "sketch", "sketch.ino"), ex.files[0].content)
  fs.writeFileSync(path.join(dir, "sketch", ESP32_BRIDGE_FILE), ESP32_BRIDGE)
  execFileSync(cli!, ["compile", "--fqbn", board.fqbn, ...board.buildProps!.flatMap((p) => ["--build-property", p]), "--build-path", path.join(dir, "build"), "--output-dir", path.join(dir, "out"), path.join(dir, "sketch")], { stdio: "pipe" })
  const img = path.join(dir, "flash.bin")
  fs.copyFileSync(path.join(dir, "out", "sketch.ino.merged.bin"), img)
  return img
}

async function boot(image: string) {
  const port = await new Promise<number>((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => ok(p)) }) })
  const child = spawn(qemu!, ["-nographic", "-machine", "esp32", "-m", "4M", "-monitor", "none", "-nic", "none", "-drive", `file=${image},if=mtd,format=raw`, "-serial", "stdio", "-serial", "null", "-serial", `tcp:127.0.0.1:${port},server=on,wait=off`])
  let serial = ""
  child.stdout.on("data", (d) => (serial += d))
  let sock: net.Socket | null = null
  for (let i = 0; i < 60 && !sock; i++) {
    await new Promise((r) => setTimeout(r, 50))
    await new Promise<void>((ok) => { const c = net.connect(port, "127.0.0.1", () => { sock = c; ok() }); c.on("error", () => ok()) })
  }
  return { child, sock: sock!, serial: () => serial }
}

describe.skipIf(!cli || !qemu || !hasCore)("ESP32 on QEMU", { timeout: 300_000 }, () => {
  it("blinks through the bridge; a button press reaches digitalRead", async () => {
    const q = await boot(build("esp32-blink"))
    try {
      const ex = MCU_EXAMPLES.find((e) => e.id === "esp32-blink")!
      const sim = new McuSim(ex.diagram, "esp32")
      const m = sim.machine as Esp32Machine
      q.sock.on("data", (d) => m.feed([...d]))
      const seen: number[] = [], board: number[] = []
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 50))
        const f = sim.step(50, 50)
        seen.push(f.leds.get("led1")?.[0] ?? 0); board.push(f.boardLed)
      }
      expect(q.serial()).toContain("ESP32 ready")
      expect(Math.max(...seen)).toBeGreaterThan(0.5) // 3.3 V, green LED, 220 Ω: ~4.7 mA
      expect(Math.min(...seen.slice(30))).toBeLessThan(0.05)
      expect(Math.max(...board)).toBeGreaterThan(0.8)
    } finally { q.child.kill("SIGKILL") }

    // ADC from the circuit (pot at 600/1023 of 3.3 V) and PWM back from LEDC
    const q3 = await boot(build("esp32-pot"))
    try {
      const ex = MCU_EXAMPLES.find((e) => e.id === "esp32-pot")!
      const sim = new McuSim(ex.diagram, "esp32")
      const m = sim.machine as Esp32Machine
      q3.sock.on("data", (d) => m.feed([...d]))
      m.onOutput = (b) => q3.sock.write(Buffer.from(b))
      const b: number[] = []
      for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 50)); b.push(sim.step(50, 50).leds.get("led1")?.[0] ?? 0) }
      const raw = [...q3.serial().matchAll(/GPIO34 = (\d+)/g)].map((x) => Number(x[1]))
      expect(Math.max(...raw)).toBeGreaterThan(2300) // 600/1023 × 4095 ≈ 2402
      expect(Math.max(...raw)).toBeLessThan(2500)
      expect(q3.serial()).not.toContain("Guru")
      const lit = b.slice(-10)
      expect(Math.max(...lit)).toBeGreaterThan(0.1) // PWM at ~59 % duty
      expect(Math.max(...lit)).toBeLessThan(0.75)
    } finally { q3.child.kill("SIGKILL") }

    const q2 = await boot(build("esp32-button"))
    try {
      const ex = MCU_EXAMPLES.find((e) => e.id === "esp32-button")!
      const sim = new McuSim(ex.diagram, "esp32")
      const m = sim.machine as Esp32Machine
      q2.sock.on("data", (d) => m.feed([...d]))
      m.onOutput = (b) => q2.sock.write(Buffer.from(b))
      for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 50)); sim.step(50, 50) }
      sim.setUi("btn1", { pressed: true })
      for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 50)); sim.step(50, 50) }
      expect(q2.serial()).toContain("pressed")
      const f = sim.step(10, 10)
      expect(f.boardLed).toBeGreaterThan(0.5)
    } finally { q2.child.kill("SIGKILL") }
  })
})
