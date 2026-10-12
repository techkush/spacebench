// One-time setup of the Linux boards' system: Debian 13 (trixie) arm64 — the base Raspberry Pi OS
// is built on — plus Raspberry Pi's own package archive (gpiozero 2, lgpio, rpi-lgpio), a
// simulated GPIO controller and the Space Bench agent (linux-guest/). About 1 GB, 5–10 minutes.
import agentSrc from "../../linux-guest/spacebench-agent?raw"
import identitySrc from "../../linux-guest/spacebench-identity?raw"
import gpioSetupSrc from "../../linux-guest/spacebench-gpio-setup?raw"
import cameraSrc from "../../linux-guest/spacebench-camera?raw"
import micSrc from "../../linux-guest/spacebench-mic?raw"
import mediaSetupSrc from "../../linux-guest/spacebench-media-setup?raw"
import identityUnit from "../../linux-guest/spacebench-identity.service?raw"
import gpioUnit from "../../linux-guest/spacebench-gpio.service?raw"
import agentUnit from "../../linux-guest/spacebench-agent.service?raw"
import provisionSrc from "../../linux-guest/provision.sh?raw"
import { linuxDisk, linuxFetch, linuxSave, linuxStart, linuxStatus } from "./host"
import { LinuxVm } from "./agent"

export const DEBIAN_URL = "https://cloud.debian.org/images/cloud/trixie/latest/debian-13-nocloud-arm64.qcow2"
/** bump when the guest files change: Settings offers to set up again */
export const GUEST_VERSION = 1
const ROOT_PASSWORD = "spacebench"

export interface SetupProgress { step: number; of: number; text: string }

/** The console as text we can wait on (ANSI codes stripped). */
class Console {
  private buf = ""
  private vm: LinuxVm
  constructor(vm: LinuxVm, onText?: (t: string) => void) {
    this.vm = vm
    vm.onConsole = (t) => { this.buf += t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""); onText?.(t); if (this.buf.length > 200_000) this.buf = this.buf.slice(-100_000) }
  }
  async expect(re: RegExp, timeoutS: number): Promise<RegExpMatchArray> {
    const end = Date.now() + timeoutS * 1000
    while (Date.now() < end) {
      const m = this.buf.match(re)
      if (m) { this.buf = this.buf.slice((m.index ?? 0) + m[0].length); return m }
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error(`The Linux setup timed out waiting for ${re}\n…${this.buf.slice(-600)}`)
  }
  send(text: string) { return this.vm.console(text) }
  /** a shell command; resolves when it has finished */
  async sh(cmd: string, timeoutS = 60) {
    const tag = `SBX${Math.random().toString(36).slice(2, 8)}`
    await this.send(`${cmd}; echo ${tag}=$?\n`)
    const m = await this.expect(new RegExp(`${tag}=(\\d+)`), timeoutS)
    if (m[1] !== "0") throw new Error(`setup command failed (${m[1]}): ${cmd.slice(0, 80)}`)
  }
  /** copy a file in through the console (base64, in pieces) */
  async put(path: string, text: string, mode = "644") {
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(text)))
    await this.sh(`: > ${path}.b64`)
    for (let i = 0; i < b64.length; i += 1500) await this.sh(`printf %s '${b64.slice(i, i + 1500)}' >> ${path}.b64`)
    await this.sh(`base64 -d ${path}.b64 > ${path} && rm ${path}.b64 && chmod ${mode} ${path}`)
  }
}

export async function setupLinux(report: (p: SetupProgress) => void, log?: (text: string) => void): Promise<void> {
  const N = 14
  const at = (step: number, text: string) => report({ step, of: N, text })
  const st = await linuxStatus()
  if (!st.qemu) throw new Error("QEMU isn't installed (qemu-system-aarch64). Install it with `brew install qemu`.")

  if (!st.files["debian.qcow2"]) { at(1, "Downloading Debian 13 for arm64 (≈ 400 MB)"); await linuxFetch(DEBIAN_URL, "debian.qcow2") }
  at(2, "Creating the Raspberry Pi disk")
  await linuxDisk("debian.qcow2", "pi.qcow2", "16G")

  at(3, "Starting the system for the first time")
  const vm = new LinuxVm()
  const con = new Console(vm, log)
  await linuxStart({ disk: "pi.qcow2", credentials: [`passwd.plaintext-password.root=${ROOT_PASSWORD}`, "firstboot.timezone=UTC", "firstboot.locale=C.UTF-8", "spacebench.board=pi5"] })
  vm.attach()
  try {
    await con.expect(/login: $|login:\s*$/m, 180)
    await con.send("root\n"); await con.expect(/Password:/, 30)
    await con.send(`${ROOT_PASSWORD}\n`); await con.expect(/# $|#\s*$/m, 30)
    await con.send("export PS1='# ' TERM=dumb; stty -echo cols 250\n")
    await new Promise((r) => setTimeout(r, 500))

    at(4, "Copying the Space Bench files")
    await con.sh("mkdir -p /root/spacebench")
    const files: [string, string, string][] = [
      ["spacebench-agent", agentSrc, "755"], ["spacebench-identity", identitySrc, "755"], ["spacebench-gpio-setup", gpioSetupSrc, "755"],
      ["spacebench-identity.service", identityUnit, "644"], ["spacebench-gpio.service", gpioUnit, "644"], ["spacebench-agent.service", agentUnit, "644"],
      ["spacebench-camera", cameraSrc, "755"], ["spacebench-mic", micSrc, "755"], ["spacebench-media-setup", mediaSetupSrc, "755"],
      ["provision.sh", provisionSrc, "755"],
    ]
    for (const [name, text, mode] of files) await con.put(`/root/spacebench/${name}`, text, mode)

    // provision.sh reports SB-STEP n/9 …: steps 5–13 here
    await con.send("sh /root/spacebench/provision.sh 2>&1\n")
    let done: RegExpMatchArray | null = null
    while (!done) {
      const m = await con.expect(/SB-(STEP (\d+)\/\d+ ([^\r\n]*)|DONE ([^\r\n]*)|FAIL ([^\r\n]*))/, 1800)
      if (m[5] !== undefined) throw new Error(`The Linux setup failed: ${m[5]}`)
      if (m[4] !== undefined) done = m
      else at(4 + Number(m[2]), m[3])
    }
    const kv = Object.fromEntries(done[4].trim().split(/\s+/).map((x) => [x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1)]))

    at(14, "Copying the kernel out of the system")
    await vm.request({ op: "hello" }, "hello", 60_000)
    for (const [src, name] of [[kv.kernel, "vmlinuz"], [kv.initrd, "initrd.img"]] as const) {
      let offset = 0, size = Infinity
      while (offset < size) {
        const r = await vm.request({ op: "get", path: src, offset, length: 2 << 20 }, "data", 60_000)
        size = Number(r.size)
        await linuxSave(name, String(r.data), offset > 0)
        offset += 2 << 20
      }
    }
    const boot = {
      version: GUEST_VERSION, disk: "pi.qcow2", kernel: "vmlinuz", initrd: "initrd.img",
      append: `root=${kv.root} ro console=ttyAMA0 quiet initcall_blacklist=pl061_gpio_driver_init`,
    }
    await linuxSave("boot.json", btoa(JSON.stringify(boot, null, 1)), false)
    await con.send("poweroff\n")
    await new Promise((r) => setTimeout(r, 4000))
  } finally {
    await vm.shutdown()
  }
}
