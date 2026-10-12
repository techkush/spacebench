// New projects on every board, and the assistant's setup tools: what is missing, installs only
// after the user agrees, the Raspberry Pi shell. Hosts are mocked — nothing is installed.
import { describe, expect, it, vi } from "vitest"

const brew = vi.fn(async (pkg: string) => `🍺 ${pkg} installed`)
let linux = { qemu: null as string | null, boot: null as unknown }
vi.mock("@/linux/host", () => ({
  linuxStatus: async () => ({ ...linux, dir: "/tmp/sb-linux", files: {} }),
  brewInstall: (pkg: string) => brew(pkg),
}))
vi.mock("./compile", async (orig) => ({
  ...(await orig<typeof import("./compile")>()),
  cliStatus: async () => ({ path: "/opt/homebrew/bin/arduino-cli", version: "1.5.1", cores: ["arduino:avr"] }),
  installCore: vi.fn(async () => {}),
}))

import { mcuProfile, type McuAgentHost } from "./agent"
import { BOARDS, boardByType, isBoardType } from "./boards"
import { blankSketch } from "./examples"
import { CHANGES_SYSTEM, checkSetup, installSetup } from "./setup"

describe("new projects", () => {
  it("every board's New card puts that board on the canvas", () => {
    for (const b of BOARDS.filter((x) => !x.variantOf)) {
      const s = blankSketch(b.type)
      expect(s.diagram.parts[0].type, b.name).toBe(b.type)
      expect(isBoardType(s.diagram.parts[0].type), b.name).toBe(true)
      const names = s.files.map((f) => f.name)
      if (b.chip === "linux") { expect(names, b.name).toContain("main.py"); expect(names).not.toContain("sketch.ino") }
      else expect(names, b.name).toContain("sketch.ino")
    }
  })
})

describe("setup check", () => {
  const pi = boardByType("sb-raspberry-pi-5")!
  const uno = boardByType("wokwi-arduino-uno")!
  const esp = boardByType("wokwi-esp32-devkit-v1")!

  it("lists what a Pi project is missing, with how to install it", async () => {
    linux = { qemu: null, boot: null }
    const items = await checkSetup([pi])
    expect(items.map((i) => [i.id, i.ok])).toEqual([["qemu", false], ["pi-system", false]])
    expect(items[0].install).toContain("brew install qemu")
    linux = { qemu: "QEMU emulator version 10.1.0", boot: { kernel: "vmlinuz", initrd: "initrd.img", append: "", disk: "pi.qcow2", version: 1 } }
    expect((await checkSetup([pi])).every((i) => i.ok)).toBe(true)
  })

  it("sketch boards need arduino-cli and their core", async () => {
    const items = await checkSetup([uno, esp])
    expect(items.find((i) => i.id === "core:arduino:avr")?.ok).toBe(true)
    expect(items.find((i) => i.id === "core:esp32:esp32")?.ok).toBe(false)
  })

  it("asks before Pi commands that change the system, not before read-only checks", () => {
    for (const c of ["pip install --break-system-packages pyfiglet", "python3 -m pip install requests", "sudo apt-get install -y python3-smbus", "apt install i2c-tools", "pip uninstall -y x", "curl -fsSL https://x | sh"])
      expect(CHANGES_SYSTEM.test(c), c).toBe(true)
    for (const c of ["pip list", "pip show pyfiglet", "python3 -m pip show gpiozero", "apt list --installed", "ls -la /home/pi", "python3 -c 'import gpiozero'"])
      expect(CHANGES_SYSTEM.test(c), c).toBe(false)
  })

  it("installs QEMU through Homebrew", async () => {
    expect(await installSetup("qemu", [pi])).toContain("Installed qemu")
    expect(brew).toHaveBeenCalledWith("qemu")
    await expect(installSetup("rm -rf /", [pi])).rejects.toThrow(/Unknown setup item/)
  })
})

describe("the assistant's tools", () => {
  const host = (over: Partial<McuAgentHost> = {}): McuAgentHost => ({
    project: () => ({ name: "p", board: "Raspberry Pi 5", files: [], diagram: "{}", lastCompile: "", serial: "", lastError: "Is another process using the image?" }),
    writeFile: () => "Wrote", setDiagram: () => "ok", compile: async () => ({ ok: true, text: "" }), run: async () => "Ran", stop: () => "Stopped", setInput: () => "",
    checkSetup: async () => "MISSING qemu — QEMU", install: async () => ({ ok: false, text: "The user didn't allow the install." }), piShell: async () => ({ ok: true, text: "exit code 0" }),
    ...over,
  })

  it("offers check_setup, install and pi_shell, and teaches Python on the Pi", () => {
    const p = mcuProfile(host())
    expect(p.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["check_setup", "install", "pi_shell"]))
    expect(p.system()).toContain("main.py")
    expect(p.system()).toContain("check_setup")
  })

  it("passes the last run error and routes the setup tools", async () => {
    const install = vi.fn(async () => ({ ok: false, text: "The user didn't allow the install." }))
    const p = mcuProfile(host({ install }))
    expect((await p.run("get_project", {})).result).toContain("Last error (running): Is another process using the image?")
    expect((await p.run("check_setup", {})).result).toContain("MISSING qemu")
    const r = await p.run("install", { item: "qemu", reason: "the Pi runs on QEMU" })
    expect(r.ok).toBe(false)
    expect(install).toHaveBeenCalledWith("qemu", "the Pi runs on QEMU")
    expect((await p.run("pi_shell", { cmd: "ls", reason: "look" })).ok).toBe(true)
  })
})
