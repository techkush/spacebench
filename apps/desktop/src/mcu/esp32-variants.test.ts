// ESP32-S3 and ESP32-C3 on Espressif's QEMU: the bridge reports pins over UART1 (the second serial
// port); Serial is UART0; analog voltages come back from the host.
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { boardById } from "./boards"
import { ESP32_BRIDGE, ESP32_BRIDGE_FILE } from "./esp32/bridge"

const cli = ["/opt/homebrew/bin/arduino-cli", "/usr/local/bin/arduino-cli"].find((p) => fs.existsSync(p))
const hasCore = !!cli && execFileSync(cli, ["core", "list"], { encoding: "utf8" }).includes("esp32:esp32")
const findQemu = (arch: string) => {
  for (const root of [path.join(os.homedir(), `.espressif/tools/qemu-${arch}`), path.join(os.homedir(), `Library/Application Support/Space Bench/qemu-${arch}`)]) {
    try { for (const v of fs.readdirSync(root).sort().reverse()) { const p = path.join(root, v, `qemu/bin/qemu-system-${arch}`); if (fs.existsSync(p)) return p } } catch { /* none */ }
  }
  return null
}

const SKETCH = `void setup() { Serial.begin(115200); pinMode(4, OUTPUT); Serial.println("hello"); }
void loop() { digitalWrite(4, HIGH); delay(100); digitalWrite(4, LOW); delay(100); Serial.printf("adc=%d\\n", analogRead(1)); }`

function build(id: string): string {
  const board = boardById(id)!
  const dir = path.join(os.tmpdir(), `sbespv-${id}`)
  fs.mkdirSync(path.join(dir, "sketch"), { recursive: true })
  fs.writeFileSync(path.join(dir, "sketch", "sketch.ino"), SKETCH)
  fs.writeFileSync(path.join(dir, "sketch", ESP32_BRIDGE_FILE), ESP32_BRIDGE)
  execFileSync(cli!, ["compile", "--fqbn", board.fqbn, ...board.buildProps!.flatMap((p) => ["--build-property", p]), "--build-path", path.join(dir, "build"), "--output-dir", path.join(dir, "out"), path.join(dir, "sketch")], { stdio: "pipe" })
  const img = path.join(dir, "flash.bin")
  fs.copyFileSync(path.join(dir, "out", "sketch.ino.merged.bin"), img)
  return img
}

async function run(machine: string, image: string, ms: number) {
  const qemu = findQemu(machine === "esp32c3" ? "riscv32" : "xtensa")!
  const port = await new Promise<number>((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => ok(p)) }) })
  const args = ["-nographic", "-monitor", "none", "-nic", "none", "-drive", `file=${image},if=mtd,format=raw`, "-machine", machine, ...(machine === "esp32c3" ? ["-icount", "3"] : []), "-serial", "stdio", "-serial", `tcp:127.0.0.1:${port},server=on,wait=off`]
  const child = spawn(qemu, args)
  let serial = "", log = ""
  child.stdout.on("data", (d) => (serial += d))
  child.stderr.on("data", (d) => (log += d))
  let sock: net.Socket | null = null
  for (let i = 0; i < 60 && !sock; i++) {
    await new Promise((r) => setTimeout(r, 50))
    await new Promise<void>((ok) => { const c = net.connect(port, "127.0.0.1", () => { sock = c; ok() }); c.on("error", () => ok()) })
  }
  const bytes: number[] = []
  sock!.on("data", (d: Buffer) => bytes.push(...d))
  // the host says GPIO1 is at 1.65 V
  sock!.write(Buffer.from([0xa5, 0x41, 1, 1650 & 0xff, 1650 >> 8]))
  await new Promise((r) => setTimeout(r, ms))
  child.kill("SIGKILL")
  const frames: [string, number, number][] = []
  for (let i = 0; i + 4 < bytes.length; i++) if (bytes[i] === 0xa5) { frames.push([String.fromCharCode(bytes[i + 1]), bytes[i + 2], bytes[i + 3] | (bytes[i + 4] << 8)]); i += 4 }
  return { serial, frames, log }
}

describe.skipIf(!hasCore)("ESP32-S3 / ESP32-C3 on QEMU", { timeout: 600_000 }, () => {
  for (const [id, machine] of [["esp32s3", "esp32s3"], ["esp32c3", "esp32c3"]] as const) {
    it.skipIf(!findQemu(machine === "esp32c3" ? "riscv32" : "xtensa"))(`${id}: Serial, the bridge's pin writes and an analog input`, async () => {
      const r = await run(machine, build(id), 6000)
      const writes = r.frames.filter(([c, pin]) => c === "W" && pin === 4)
      expect(r.serial, r.log.slice(-300)).toContain("hello")
      expect(writes.length).toBeGreaterThanOrEqual(4)
      expect(new Set(writes.map(([, , v]) => v))).toEqual(new Set([0, 1]))
      // 1.65 V of a 3.3 V 12-bit ADC ≈ 2047
      const adc = [...r.serial.matchAll(/adc=(\d+)/g)].map((m) => Number(m[1]))
      expect(adc.length).toBeGreaterThan(0)
      expect(adc[adc.length - 1]).toBeGreaterThan(2000)
      expect(adc[adc.length - 1]).toBeLessThan(2100)
    })
  }
})
