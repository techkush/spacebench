// The running Linux board: one VM, its console, and the Space Bench agent inside it
// (linux-guest/spacebench-agent) — GPIO frames, files, the user's program.
import agentSrc from "../../linux-guest/spacebench-agent?raw"
import identitySrc from "../../linux-guest/spacebench-identity?raw"
import gpioSetupSrc from "../../linux-guest/spacebench-gpio-setup?raw"
import cameraSrc from "../../linux-guest/spacebench-camera?raw"
import micSrc from "../../linux-guest/spacebench-mic?raw"
import mediaSetupSrc from "../../linux-guest/spacebench-media-setup?raw"
import { linuxPoll, linuxQmp, linuxSend, linuxStart, linuxStatus, linuxStop, type LinuxStatus } from "./host"

/** the bundled agent's version (spacebench-agent: VERSION = "n") */
export const AGENT_VERSION = /VERSION = "([^"]+)"/.exec(agentSrc)?.[1] ?? "0"

export type LinuxBoardId = "pi5" | "pi4" | "pi3" | "zero2w"
/** a pin's state: out 1/0 when driven, -1 when an input; pu/pd = the bias the program asked for */
export type GuestPin = [line: number, out: number, pu: boolean, pd: boolean]
export interface GuestFrame { t: number; start: GuestPin[]; events: [line: number, t: number, out: number, pu: boolean, pd: boolean][] }
type Msg = { ev: string; [k: string]: unknown }

/** what the setup leaves behind: base64 of a guest file is fetched with `get` */
export const toB64 = (bytes: Uint8Array) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s) }
const enc = new TextEncoder()

export class LinuxVm {
  board: LinuxBoardId = "pi5"
  /** console text (the login shell on the serial port) */
  onConsole: ((text: string) => void) | null = null
  /** the user's program: output, and its exit */
  onOutput: ((text: string) => void) | null = null
  onExit: ((code: number) => void) | null = null
  onStopped: ((log: string) => void) | null = null
  /** the console so far (the Terminal shows it); listeners get the whole text on each change */
  consoleText = ""
  readonly consoleListeners = new Set<(text: string) => void>()
  private inbox: Msg[] = []
  private waiters: { ev: string; ok: (m: Msg) => void; fail: (e: Error) => void }[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private alive = false
  private fast = 0

  get running() { return this.alive }

  /** Boot the prepared image as `board` and wait for the agent. */
  async boot(board: LinuxBoardId, status?: LinuxStatus, timeoutS = 90) {
    const st = status ?? (await linuxStatus())
    if (!st.qemu) throw new Error("QEMU isn't installed (qemu-system-aarch64). Install it with `brew install qemu`, or from Settings → Microcontrollers.")
    if (!st.boot) throw new Error("The Raspberry Pi system isn't set up yet — Settings → Microcontrollers → Linux boards → Set up.")
    this.board = board
    // direct kernel boot has no firmware (no SMBIOS credentials): the board travels on the kernel command line
    await linuxStart({ disk: st.boot.disk, kernel: st.boot.kernel, initrd: st.boot.initrd, append: `${st.boot.append} systemd.set_credential=spacebench.board:${board}` })
    this.alive = true
    this.inbox = []
    this.pump()
    const hello = await this.request({ op: "hello" }, "hello", timeoutS * 1000)
    if (hello.version !== AGENT_VERSION) await this.update()
  }

  /** The guest's Space Bench files are older than this app's: install the bundled ones, restart the agent. */
  async update() {
    await this.put("/usr/local/sbin/spacebench-identity", identitySrc, "755")
    await this.put("/usr/local/sbin/spacebench-gpio-setup", gpioSetupSrc, "755")
    // the media parts' feeders and their add-ons' installer (see media.ts)
    await this.put("/usr/local/sbin/spacebench-camera", cameraSrc, "755")
    await this.put("/usr/local/sbin/spacebench-mic", micSrc, "755")
    await this.put("/usr/local/sbin/spacebench-media-setup", mediaSetupSrc, "755")
    await this.put("/usr/local/sbin/spacebench-agent", agentSrc, "755")
    // the new agent announces itself; anything sent before that would be lost in the exec
    const ready = this.next("ready", 20_000)
    await this.send({ op: "reexec" })
    await ready
    const hello = await this.request({ op: "hello" }, "hello", 20_000)
    if (hello.version !== AGENT_VERSION) throw new Error(`The Linux board's agent didn't update (it reports version ${String(hello.version)}, this app has ${AGENT_VERSION})`)
  }

  /**
   * Ready to run a program as `board`: the running VM (resumed, its program stopped), or a fresh
   * boot — also when the VM died without this side noticing yet. Returns true when it booted.
   */
  async ensure(board: LinuxBoardId, onBoot?: () => void): Promise<boolean> {
    if (this.alive && this.board === board) {
      try { await this.resume(); await this.kill(); return false } catch { this.alive = false }
    }
    if (this.alive) await this.shutdown()
    onBoot?.()
    await this.boot(board)
    return true
  }

  /** Follow a VM started elsewhere (the setup boots its own). */
  attach() { this.alive = true; this.inbox = []; this.pump() }

  /** Raw console access (setup, the Terminal). */
  console(text: string) { return linuxSend({ console: text }) }

  send(m: Record<string, unknown>) { return linuxSend({ agent: JSON.stringify(m) + "\n" }) }

  /** Send and wait for the reply event. */
  async request(m: Record<string, unknown>, ev: string, timeoutMs = 15000): Promise<Msg> {
    const p = this.next(ev, timeoutMs)
    this.fast = 20
    await this.send(m)
    return p
  }

  next(ev: string, timeoutMs = 15000): Promise<Msg> {
    const i = this.inbox.findIndex((m) => m.ev === ev)
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0])
    return new Promise((ok, fail) => {
      const w = { ev, ok, fail }
      this.waiters.push(w)
      setTimeout(() => { const k = this.waiters.indexOf(w); if (k >= 0) { this.waiters.splice(k, 1); fail(new Error(`The Linux board didn't answer (${ev})`)) } }, timeoutMs)
    })
  }

  private deliver(m: Msg) {
    if (m.ev === "out") { this.onOutput?.(String(m.text)); return }
    if (m.ev === "exit") { this.onExit?.(Number(m.code)); return }
    const k = this.waiters.findIndex((w) => w.ev === m.ev)
    if (m.ev === "ready" && k < 0) return
    if (k >= 0) { this.waiters.splice(k, 1)[0].ok(m); return }
    if (m.ev === "error") { const w = this.waiters.shift(); if (w) { w.fail(new Error(String(m.message))); return } }
    this.inbox.push(m)
  }

  private pump = async () => {
    this.timer = null
    if (!this.alive) return
    try {
      const p = await linuxPoll()
      if (p.console) {
        this.consoleText = (this.consoleText + p.console).slice(-60_000)
        this.onConsole?.(p.console)
        for (const l of this.consoleListeners) l(this.consoleText)
      }
      for (const line of p.agent.split("\n")) if (line.trim()) { try { this.deliver(JSON.parse(line)) } catch { /* partial / noise */ } }
      if (!p.running) {
        this.alive = false
        for (const w of this.waiters.splice(0)) w.fail(new Error(`The Linux board stopped${p.log ? `: ${p.log.trim().split("\n").pop()}` : ""}`))
        this.onStopped?.(p.log)
        return
      }
    } catch { /* transient */ }
    // poll quickly while a request waits, else ~30 times a second
    const quick = this.waiters.length > 0 || this.fast-- > 0
    this.timer = setTimeout(this.pump, quick ? 2 : 33)
  }

  async put(path: string, content: string | Uint8Array, mode?: string) {
    const bytes = typeof content === "string" ? enc.encode(content) : content
    await this.request({ op: "put", path, data: toB64(bytes), mode }, "put")
  }
  async run(cmd: string, cwd = "/home/pi") { await this.send({ op: "run", cmd, cwd }) }
  async stdin(text: string) { await this.send({ op: "stdin", text }) }
  async kill() { await this.send({ op: "kill" }) }

  /**
   * One lockstep frame: inputs in, the VM runs exactly `seconds` of its own time (the agent keeps
   * the time), then it is paused — its clock too — while the circuit catches up.
   */
  async frame(inputs: Record<number, boolean>, seconds: number, run?: { cmd: string; cwd?: string }): Promise<GuestFrame> {
    await linuxQmp("cont")
    const f = await this.request({
      op: "step", seconds, inputs: Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v ? 1 : 0])),
      ...(run ? { run: run.cmd, cwd: run.cwd ?? "/home/pi" } : {}),
    }, "step", 15000 + seconds * 1000)
    await linuxQmp("stop")
    return f as unknown as GuestFrame
  }
  /** Let the VM run freely (after a co-simulation). */
  resume() { return linuxQmp("cont").catch(() => {}) }

  /** Everything written in the guest goes to its disk (before QEMU is ended). */
  async sync(timeoutMs = 5000) { if (this.alive) await this.request({ op: "sync" }, "sync", timeoutMs).catch(() => {}) }

  async shutdown() {
    // QEMU is ended, not shut down: flush the guest's files first (a paused VM can't)
    if (this.alive) { await linuxQmp("cont").catch(() => {}); await this.sync() }
    this.alive = false
    if (this.timer) clearTimeout(this.timer)
    await linuxStop()
  }
}

/** One VM for the whole app (QEMU can't share the disk between two). */
let shared: LinuxVm | null = null
export const linuxVm = () => (shared ??= new LinuxVm())
