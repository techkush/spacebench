// Dev-only: the browser build's stand-in for the Tauri linux_* commands (src-tauri/src/linux.rs).
// Linux boards (Raspberry Pi 5 / 4 / 3 / Zero 2 W) are a QEMU "virt" VM on the host's hypervisor;
// the console, QMP and the Space Bench agent's virtio-serial port are unix sockets.
//   GET  /api/linux                → { qemu, dir, files }
//   POST /api/linux/fetch          { url, name }            download into the Linux folder
//   POST /api/linux/disk           { base, name, size }     a copy-on-write disk over `base`
//   POST /api/linux/start          StartOptions             POST /api/linux/stop
//   GET  /api/linux/poll           → { console, agent, running, log }
//   POST /api/linux/send           { console?, agent? }     POST /api/linux/qmp { cmd }
//   POST /api/linux/save           { name, data (base64), append }
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import type { Plugin } from "vite"

export interface StartOptions {
  disk: string
  /** direct kernel boot (the provisioned image); without it the VM boots through UEFI */
  kernel?: string
  initrd?: string
  append?: string
  /** systemd credentials: "spacebench.board=pi5" … (SMBIOS type 11) */
  credentials?: string[]
  memory?: number
  cpus?: number
}

export const LINUX_DIR = path.join(os.homedir(), "Library/Application Support/Space Bench/linux")

export function findQemu(): string | null {
  const dirs = [...(process.env.PATH ?? "").split(path.delimiter), "/opt/homebrew/bin", "/usr/local/bin"]
  for (const d of dirs) { const p = path.join(d, "qemu-system-aarch64"); try { fs.accessSync(p, fs.constants.X_OK); return p } catch { /* next */ } }
  return null
}
const firmware = (bin: string) => [path.join(path.dirname(bin), "../share/qemu/edk2-aarch64-code.fd")].find((p) => fs.existsSync(p)) ?? null

const safe = (name: string) => { if (!/^[\w.-]+$/.test(name)) throw new Error(`bad file name ${name}`); return path.join(LINUX_DIR, name) }

export function linuxArgs(bin: string, o: StartOptions, sock: (k: string) => string): string[] {
  const args = ["-M", "virt", "-accel", process.platform === "darwin" ? "hvf" : "kvm", "-cpu", "host", "-smp", String(o.cpus ?? 4), "-m", String(o.memory ?? 2048)]
  if (o.kernel) {
    args.push("-kernel", safe(o.kernel), "-append", o.append ?? "console=ttyAMA0")
    if (o.initrd) args.push("-initrd", safe(o.initrd))
  } else {
    const fw = firmware(bin)
    if (!fw) throw new Error("QEMU's UEFI firmware (edk2-aarch64-code.fd) was not found")
    // no saved boot entries: the firmware boots the disk's default loader every time
    args.push("-M", "virt,acpi=off", "-drive", `if=pflash,format=raw,readonly=on,file=${fw}`)
  }
  args.push("-drive", `if=virtio,file=${safe(o.disk)}`, "-nic", "user,model=virtio-net-pci", "-display", "none", "-monitor", "none",
    "-serial", `unix:${sock("console")},server=on,wait=off`, "-qmp", `unix:${sock("qmp")},server=on,wait=off`,
    "-device", "virtio-serial-pci", "-chardev", `socket,id=sb,path=${sock("agent")},server=on,wait=off`, "-device", "virtserialport,chardev=sb,name=spacebench")
  for (const c of o.credentials ?? []) args.push("-smbios", `type=11,value=io.systemd.credential:${c}`)
  return args
}

interface Session { child: ChildProcess; console: net.Socket | null; agent: net.Socket | null; qmp: net.Socket | null; out: string; lines: string; log: string; running: boolean; qmpBuf: string; qmpWait: ((m: unknown) => void)[] }
let session: Session | null = null
const stop = () => { if (session) { session.child.kill("SIGKILL"); session.console?.destroy(); session.agent?.destroy(); session.qmp?.destroy(); session = null } }

const connect = (p: string) => new Promise<net.Socket>((ok, fail) => {
  let tries = 0
  const go = () => {
    const s = net.createConnection(p)
    s.once("connect", () => ok(s))
    s.once("error", () => { if (++tries > 100) fail(new Error(`QEMU's socket ${path.basename(p)} did not open`)); else setTimeout(go, 50) })
  }
  go()
})

/** A VM left running by an earlier Space Bench (it quit without stopping it) holds the disk's lock: kill any QEMU booted from the Linux folder. */
function killStrays() {
  const strays = () => { try { return execFileSync("pgrep", ["-f", `qemu-system-aarch64.*${LINUX_DIR}`], { encoding: "utf8" }).split(/\s+/).filter(Boolean) } catch { return [] } }
  const pids = strays()
  if (!pids.length) return
  try { execFileSync("kill", ["-9", ...pids]) } catch { /* gone */ }
  for (let i = 0; i < 30 && strays().length; i++) execFileSync("sleep", ["0.1"])
}

async function start(o: StartOptions) {
  stop()
  killStrays()
  const bin = findQemu()
  if (!bin) throw new Error("QEMU (qemu-system-aarch64) was not found — install it with `brew install qemu`")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-linux-"))
  const sock = (k: string) => path.join(dir, `${k}.sock`)
  const child = spawn(bin, linuxArgs(bin, o, sock), { stdio: ["ignore", "ignore", "pipe"] })
  const s: Session = { child, console: null, agent: null, qmp: null, out: "", lines: "", log: "", running: true, qmpBuf: "", qmpWait: [] }
  session = s
  child.stderr?.on("data", (d) => { s.log += d })
  child.on("exit", (code) => { s.running = false; s.log += `\nQEMU exited (${code})` })
  try { s.console = await connect(sock("console")) } catch (e) {
    // QEMU exited at once (a disk another VM holds, no hypervisor …): say why
    stop()
    throw new Error(s.log.trim().split("\n").filter(Boolean).slice(-2).join(" · ") || (e instanceof Error ? e.message : String(e)))
  }
  s.console.on("data", (d) => { s.out += d.toString("utf8") })
  s.agent = await connect(sock("agent"))
  s.agent.on("data", (d) => { s.lines += d.toString("utf8") })
  s.qmp = await connect(sock("qmp"))
  s.qmp.on("data", (d) => {
    s.qmpBuf += d
    let i
    while ((i = s.qmpBuf.indexOf("\n")) >= 0) {
      const line = s.qmpBuf.slice(0, i); s.qmpBuf = s.qmpBuf.slice(i + 1)
      const m = JSON.parse(line)
      if ("return" in m || "error" in m) s.qmpWait.shift()?.(m)
    }
  })
  s.qmp.write(JSON.stringify({ execute: "qmp_capabilities" }) + "\n")
  await new Promise((ok) => s.qmpWait.push(ok))
}

function qmp(cmd: string): Promise<unknown> {
  const s = session
  if (!s?.qmp) return Promise.reject(new Error("The Linux board is not running"))
  return new Promise((ok) => { s.qmpWait.push(ok); s.qmp!.write(JSON.stringify({ execute: cmd }) + "\n") })
}

const files = () => Object.fromEntries(["debian.qcow2", "pi.qcow2", "vmlinuz", "initrd.img", "boot.json"].map((f) => [f, fs.existsSync(path.join(LINUX_DIR, f))]))

/** The same operations without HTTP (tests run src/linux against these). */
export const linuxBackend = {
  status() {
    const bin = findQemu()
    let qemu: string | null = null
    if (bin) try { qemu = `${execFileSync(bin, ["--version"], { encoding: "utf8" }).split("\n")[0]} · ${bin}` } catch { /* broken */ }
    let boot = null
    try { boot = JSON.parse(fs.readFileSync(path.join(LINUX_DIR, "boot.json"), "utf8")) } catch { /* not set up */ }
    return { qemu, dir: LINUX_DIR, files: files(), boot }
  },
  start,
  stop,
  qmp,
  poll() {
    const s = session
    if (!s) return { console: "", agent: "", running: false, log: "" }
    const cut = s.lines.lastIndexOf("\n") + 1
    const out = { console: s.out, agent: s.lines.slice(0, cut), running: s.running, log: s.running ? "" : s.log }
    s.out = ""; s.lines = s.lines.slice(cut)
    return out
  },
  send(o: { console?: string; agent?: string }) {
    if (!session) throw new Error("The Linux board is not running")
    if (o.console) session.console?.write(o.console)
    if (o.agent) session.agent?.write(o.agent)
  },
}

export function linuxDev(): Plugin {
  return {
    name: "spicebench-linux-dev",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/api/linux", (req, res) => {
        const send = (code: number, body: unknown) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)) }
        const url = req.url ?? "/"
        if (req.method === "GET" && (url === "/" || url === "")) {
          const bin = findQemu()
          let qemu: string | null = null
          if (bin) try { qemu = `${execFileSync(bin, ["--version"], { encoding: "utf8" }).split("\n")[0]} · ${bin}` } catch { /* broken */ }
          let boot = null
          try { boot = JSON.parse(fs.readFileSync(path.join(LINUX_DIR, "boot.json"), "utf8")) } catch { /* not set up */ }
          send(200, { qemu, dir: LINUX_DIR, files: files(), boot }); return
        }
        if (url.startsWith("/poll")) {
          const s = session
          if (!s) { send(200, { console: "", agent: "", running: false, log: "" }); return }
          // whole agent lines only
          const cut = s.lines.lastIndexOf("\n") + 1
          const out = { console: s.out, agent: s.lines.slice(0, cut), running: s.running, log: s.running ? "" : s.log }
          s.out = ""; s.lines = s.lines.slice(cut)
          send(200, out); return
        }
        let body = ""
        req.on("data", (c) => (body += c))
        req.on("end", async () => {
          try {
            const j = body ? JSON.parse(body) : {}
            if (url.startsWith("/stop")) { stop(); send(200, {}); return }
            if (url.startsWith("/start")) { await start(j as StartOptions); send(200, {}); return }
            if (url.startsWith("/send")) {
              if (!session) { send(400, { error: "The Linux board is not running" }); return }
              if (j.console) session.console?.write(j.console)
              if (j.agent) session.agent?.write(j.agent)
              send(200, {}); return
            }
            if (url.startsWith("/qmp")) { send(200, await qmp(j.cmd)); return }
            // Homebrew packages Space Bench installs when the user agrees (the assistant asks first)
            if (url.startsWith("/brew")) {
              if (!["qemu", "arduino-cli"].includes(j.pkg)) throw new Error(`${j.pkg} isn't a package Space Bench installs`)
              const brew = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].find((p) => fs.existsSync(p))
              if (!brew) throw new Error("Homebrew isn't installed: get it from https://brew.sh (it asks for your password), then try again")
              const text = await new Promise<string>((ok, fail) => {
                let out = ""
                const p = spawn(brew, ["install", j.pkg], { env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ENV_HINTS: "1" } })
                p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d))
                p.on("exit", (c) => { const tail = out.split("\n").filter((l) => l.trim()).slice(-6).join("\n"); if (c === 0) ok(tail); else fail(new Error(`brew install ${j.pkg} failed:\n${tail}`)) })
              })
              send(200, { text }); return
            }
            if (url.startsWith("/fetch")) {
              fs.mkdirSync(LINUX_DIR, { recursive: true })
              const dest = safe(j.name)
              await new Promise<void>((ok, fail) => {
                const p = spawn("curl", ["-fsSL", "--retry", "3", "-o", `${dest}.part`, j.url])
                p.on("exit", (c) => (c === 0 ? ok() : fail(new Error(`download failed: ${j.url}`))))
              })
              fs.renameSync(`${dest}.part`, dest)
              send(200, {}); return
            }
            if (url.startsWith("/disk")) {
              const bin = findQemu()
              if (!bin) throw new Error("QEMU was not found")
              execFileSync(path.join(path.dirname(bin), "qemu-img"), ["create", "-q", "-f", "qcow2", "-b", safe(j.base), "-F", "qcow2", safe(j.name), j.size ?? "16G"])
              send(200, {}); return
            }
            if (url.startsWith("/save")) {
              fs.mkdirSync(LINUX_DIR, { recursive: true })
              const data = Buffer.from(j.data, "base64")
              if (j.append) fs.appendFileSync(safe(j.name), data); else fs.writeFileSync(safe(j.name), data)
              send(200, {}); return
            }
            send(404, { error: "unknown" })
          } catch (e) { send(500, { error: e instanceof Error ? e.message : String(e) }) }
        })
      })
    },
  }
}
