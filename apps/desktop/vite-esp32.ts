// Dev-only: the browser build's stand-in for the Tauri esp32_* commands (src-tauri/src/esp32.rs).
//   GET  /api/esp32            → "version · path" (404 when QEMU is missing)
//   POST /api/esp32/start      { image, machine }   POST /api/esp32/stop
//   GET  /api/esp32/poll       → { serial, bridge: number[], running, log }
//   POST /api/esp32/send       { serial?, bridge?: number[] }
//   POST /api/esp32/qmp        { cmd }   "stop" / "cont" (schematics pause the chip while the circuit simulates)
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import type { Plugin } from "vite"

/** Espressif's QEMU: qemu-system-xtensa (ESP32, ESP32-S3) or qemu-system-riscv32 (ESP32-C3) */
export function findQemu(arch: "xtensa" | "riscv32" = "xtensa"): string | null {
  // Espressif's builds first: Homebrew's qemu-system-xtensa (installed with QEMU for the Pi boards)
  // has no ESP32 machines
  const dirs: string[] = []
  for (const root of [path.join(os.homedir(), `Library/Application Support/Space Bench/qemu-${arch}`), path.join(os.homedir(), `.espressif/tools/qemu-${arch}`)]) {
    try { for (const v of fs.readdirSync(root).sort().reverse()) dirs.push(path.join(root, v, "qemu/bin")) } catch { /* none */ }
  }
  dirs.push(...(process.env.PATH ?? "").split(path.delimiter), "/opt/homebrew/bin", "/usr/local/bin")
  for (const d of dirs) { const p = path.join(d, `qemu-system-${arch}`); try { fs.accessSync(p, fs.constants.X_OK); return p } catch { /* next */ } }
  return null
}
/** the machine's arguments: ESP32 has the bridge on UART2, the S3 / C3 on UART1; the C3 needs -icount */
const machineArgs = (machine: string, bridge: string) => machine === "esp32"
  ? ["-machine", "esp32", "-m", "4M", "-serial", "stdio", "-serial", "null", "-serial", bridge]
  : ["-machine", machine, ...(machine === "esp32c3" ? ["-icount", "3"] : []), "-serial", "stdio", "-serial", bridge]

interface Session { child: ChildProcess; sock: net.Socket | null; qmp: net.Socket | null; qmpBuf: string; qmpWait: ((m: unknown) => void)[]; serial: string; bridge: number[]; log: string; running: boolean }
let session: Session | null = null
const stop = () => { if (session) { session.child.kill("SIGKILL"); session.sock?.destroy(); session.qmp?.destroy(); session = null } } // QEMU ignores SIGTERM while its stdio is blocked
const freePort = () => new Promise<number>((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => ok(p)) }) })
const connect = async (port: number, onData: (d: Buffer) => void) => {
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 40))
    const c = await new Promise<net.Socket | null>((ok) => { const c = net.connect(port, "127.0.0.1", () => ok(c)); c.on("error", () => ok(null)) })
    if (c) { c.on("data", onData); return c }
  }
  return null
}

async function start(image: string, machine = "esp32") {
  stop()
  const qemu = findQemu(machine === "esp32c3" ? "riscv32" : "xtensa")
  if (!qemu) throw new Error(machine === "esp32c3" ? "Espressif's QEMU for RISC-V (qemu-system-riscv32) was not found — install it from Settings → Microcontrollers" : "Espressif's QEMU (qemu-system-xtensa) was not found")
  const dir = path.join(os.tmpdir(), "spacebench-esp32"); fs.mkdirSync(dir, { recursive: true })
  const flash = path.join(dir, "flash-dev.bin"); fs.copyFileSync(image, flash)
  const port = await freePort(), qport = await freePort()
  const child = spawn(qemu, ["-nographic", "-monitor", "none", "-nic", "none", "-qmp", `tcp:127.0.0.1:${qport},server=on,wait=off`, "-drive", `file=${flash},if=mtd,format=raw`, ...machineArgs(machine, `tcp:127.0.0.1:${port},server=on,wait=off`)])
  const s: Session = { child, sock: null, qmp: null, qmpBuf: "", qmpWait: [], serial: "", bridge: [], log: "", running: true }
  session = s
  child.stdout?.on("data", (d) => (s.serial += d.toString("latin1")))
  child.stderr?.on("data", (d) => (s.log += d))
  child.on("exit", () => (s.running = false))
  s.sock = await connect(port, (d) => s.bridge.push(...d))
  if (!s.sock) { stop(); throw new Error(`QEMU did not start: ${s.log.trim().split("\n").slice(-3).join(" · ") || "its bridge port did not open"}`) }
  s.qmp = await connect(qport, (d) => {
    s.qmpBuf += d
    let i
    while ((i = s.qmpBuf.indexOf("\n")) >= 0) {
      const line = s.qmpBuf.slice(0, i); s.qmpBuf = s.qmpBuf.slice(i + 1)
      try { const m = JSON.parse(line); if ("return" in m || "error" in m) s.qmpWait.shift()?.(m) } catch { /* partial */ }
    }
  })
  if (s.qmp) await qmp("qmp_capabilities")
}

function qmp(cmd: string): Promise<unknown> {
  const s = session
  if (!s?.qmp) return Promise.reject(new Error("The ESP32 is not running"))
  return new Promise((ok) => { s.qmpWait.push(ok); s.qmp!.write(JSON.stringify({ execute: cmd }) + "\n") })
}

/** The same operations without HTTP (tests). */
export const esp32Backend = {
  start, stop, qmp,
  poll() {
    const s = session
    if (!s) return { serial: "", bridge: [] as number[], running: false, log: "" }
    const out = { serial: s.serial, bridge: s.bridge, running: s.running, log: s.running ? "" : s.log }
    s.serial = ""; s.bridge = []
    return out
  },
  send(serial?: string, bridge?: number[]) {
    if (!session) throw new Error("The ESP32 is not running")
    if (serial) session.child.stdin?.write(serial)
    if (bridge) session.sock?.write(Buffer.from(bridge))
  },
}

export function esp32Dev(): Plugin {
  return {
    name: "spicebench-esp32-dev",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/api/esp32", (req, res) => {
        const send = (code: number, body: unknown) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)) }
        const bin = findQemu()
        const url = req.url ?? "/"
        if (req.method === "GET" && (url === "/" || url === "")) {
          if (!bin) { send(404, { error: "Espressif's QEMU (qemu-system-xtensa) was not found" }); return }
          send(200, { version: `${execFileSync(bin, ["--version"], { encoding: "utf8" }).split("\n")[0]} · ${bin}` }); return
        }
        if (url.startsWith("/poll")) { send(200, esp32Backend.poll()); return }
        let body = ""
        req.on("data", (c) => (body += c))
        req.on("end", async () => {
          try {
            const j = body ? JSON.parse(body) : {}
            if (url.startsWith("/stop")) { stop(); send(200, {}); return }
            if (url.startsWith("/send")) { esp32Backend.send(j.serial, j.bridge); send(200, {}); return }
            if (url.startsWith("/qmp")) { send(200, await qmp(String(j.cmd))); return }
            if (url.startsWith("/start")) { await start(j.image, String(j.machine ?? "esp32")); send(200, {}); return }
            send(404, { error: "unknown" })
          } catch (e) { send(500, { error: e instanceof Error ? e.message : String(e) }) }
        })
      })
    },
  }
}
