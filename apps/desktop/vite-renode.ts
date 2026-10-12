// Dev-only: the browser build's stand-in for the Tauri renode_* commands (src-tauri/src/renode.rs).
// Renode (Antmicro, MIT) emulates STM32 / nRF52 boards; Space Bench drives it through its monitor
// socket and a helper (renode/sb_renode.py) loaded into it.
//   GET  /api/renode              → { renode: "version · path" | null }
//   POST /api/renode/start        { helper }   start Renode, load the helper     POST /api/renode/stop
//   POST /api/renode/cmd          { line }     → { out } — the __SB__ JSON line of sb_* calls, or the monitor's text
//   POST /api/renode/stage        { elf }      → { path } — a copy the next compile won't delete
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import type { Plugin } from "vite"

export function findRenode(): string | null {
  const home = os.homedir()
  const cands = [
    path.join(home, "Library/Application Support/Space Bench/renode/Renode.app/Contents/MacOS/renode"),
    "/Applications/Renode.app/Contents/MacOS/renode",
    ...(process.env.PATH ?? "").split(path.delimiter).map((d) => path.join(d, "renode")),
  ]
  for (const p of cands) { try { fs.accessSync(p, fs.constants.X_OK); return p } catch { /* next */ } }
  return null
}

interface Session { child: ChildProcess; sock: net.Socket; buf: string; dir: string; busy: Promise<unknown> }
let session: Session | null = null
const freePort = () => new Promise<number>((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => ok(p)) }) })

function stop() {
  if (!session) return
  session.child.kill("SIGKILL")
  session.sock.destroy()
  try { fs.rmSync(session.dir, { recursive: true, force: true }) } catch { /* gone */ }
  session = null
}

/** Send one monitor command and wait for its answer: an __SB__ line (sb_* calls) or the next prompt. */
function cmd(line: string, timeoutMs = 120_000): Promise<string> {
  const s = session
  if (!s) return Promise.reject(new Error("Renode is not running"))
  const run = () => new Promise<string>((ok, fail) => {
    s.buf = ""
    const sb = line.startsWith("python") && line.includes("sb_")
    const timer = setTimeout(() => { s.sock.off("data", on); fail(new Error(`Renode didn't answer: ${line.slice(0, 60)}`)) }, timeoutMs)
    const on = () => {
      if (sb) {
        const i = s.buf.indexOf("__SB__")
        if (i >= 0) { const j = s.buf.indexOf("\n", i); if (j > 0) { clearTimeout(timer); s.sock.off("data", on); ok(s.buf.slice(i + 6, j).trim()) } }
        else if (/There was an error|Traceback|Error:/.test(s.buf) && /\)\s*$/.test(s.buf)) { clearTimeout(timer); s.sock.off("data", on); fail(new Error(s.buf.trim().slice(-600))) }
      } else if (/\([\w-]+\)\s*$/.test(s.buf)) { clearTimeout(timer); s.sock.off("data", on); ok(s.buf) }
    }
    s.sock.on("data", on)
    s.sock.write(line + "\n")
  })
  // one command at a time
  const p = s.busy.then(run, run)
  s.busy = p.catch(() => {})
  return p
}

async function start(helper: string) {
  stop()
  const bin = findRenode()
  if (!bin) throw new Error("Renode was not found — install it from Settings → Microcontrollers")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-renode-"))
  fs.writeFileSync(path.join(dir, "sb_renode.py"), helper)
  const port = await freePort()
  const child = spawn(bin, ["--disable-gui", "--plain", "-P", String(port)], { cwd: path.dirname(bin), stdio: "ignore" })
  let sock: net.Socket | null = null
  for (let i = 0; i < 150 && !sock; i++) {
    sock = await new Promise<net.Socket | null>((ok) => { const c = net.createConnection(port, "127.0.0.1"); c.once("connect", () => ok(c)); c.once("error", () => ok(null)) })
    if (!sock) await new Promise((r) => setTimeout(r, 100))
  }
  if (!sock) { child.kill("SIGKILL"); throw new Error("Renode's monitor didn't open") }
  sock.setEncoding("utf8")
  session = { child, sock, buf: "", dir, busy: Promise.resolve() }
  sock.on("data", (d: string) => { if (session) session.buf += d })
  child.on("exit", () => { if (session?.child === child) session = null })
  await cmd("help")  // wait for the first prompt
  return dir
}

function stage(elf: string): string {
  const dir = path.join(os.tmpdir(), "sb-renode-elf")
  fs.mkdirSync(dir, { recursive: true })
  const dest = path.join(dir, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.elf`)
  fs.copyFileSync(elf, dest)
  return dest
}

export const renodeBackend = {
  status() {
    const bin = findRenode()
    if (!bin) return { renode: null }
    try { return { renode: `${execFileSync(bin, ["--version"], { encoding: "utf8" }).split("\n")[0].trim()} · ${bin}` } } catch { return { renode: null } }
  },
  start, stop, cmd, stage,
  /** the helper's own folder (sb_renode.py is included from there) */
  helperPath: () => (session ? path.join(session.dir, "sb_renode.py") : null),
}

export function renodeDev(): Plugin {
  return {
    name: "spicebench-renode-dev",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/api/renode", (req, res) => {
        const send = (code: number, body: unknown) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)) }
        const url = req.url ?? "/"
        if (req.method === "GET" && (url === "/" || url === "")) { send(200, renodeBackend.status()); return }
        let body = ""
        req.on("data", (c) => (body += c))
        req.on("end", async () => {
          try {
            const j = body ? JSON.parse(body) : {}
            if (url.startsWith("/stop")) { stop(); send(200, {}); return }
            if (url.startsWith("/start")) { const dir = await start(j.helper); send(200, { helper: path.join(dir, "sb_renode.py") }); return }
            if (url.startsWith("/cmd")) { send(200, { out: await cmd(j.line) }); return }
            if (url.startsWith("/stage")) { send(200, { path: stage(j.elf) }); return }
            send(404, { error: "unknown" })
          } catch (e) { send(500, { error: e instanceof Error ? e.message : String(e) }) }
        })
      })
    },
  }
}
