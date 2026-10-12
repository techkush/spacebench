// A Raspberry Pi (Linux in a VM) in a schematic: real Python + gpiozero on the board, the circuit
// on ngspice, in lockstep. Needs QEMU and the set-up system (Settings → Linux boards); skipped
// otherwise. Boots a VM, so it takes ~10 s.
import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { acquireVm, releaseVm } from "./vm-lock.testutil"
import { linuxBackend } from "../../vite-linux"
import { run } from "../../vite-ngspice"

vi.mock("./host", () => ({
  linuxStatus: async () => linuxBackend.status(),
  linuxStart: async (o: Parameters<typeof linuxBackend.start>[0]) => linuxBackend.start(o),
  linuxStop: async () => linuxBackend.stop(),
  linuxQmp: async (cmd: string) => linuxBackend.qmp(cmd),
  linuxPoll: async () => linuxBackend.poll(),
  linuxSend: async (o: { console?: string; agent?: string }) => linuxBackend.send(o),
}))

import { compileKirk } from "@/kirk/compile"
import { boardParts } from "@/cosim/boards"
import { CoSim } from "@/cosim/cosim"
import { remap, type JobResult } from "@/lib/engine"
import { setLoader } from "@/lib/kicad"
import type { SpiceNetlist } from "@/lib/spice"
import { linuxChip } from "./chip"
import { linuxVm } from "./agent"
import { piExec } from "./exec"
import { blankSketch } from "@/mcu/examples"
import { loadExample } from "@/editor/examples"
import { boardByType } from "@/mcu/boards"
import type { Diagram } from "@/mcu/diagram"
import { FedMachine } from "@/mcu/fed"
import { McuSim } from "@/mcu/sim"

const KICAD = path.resolve(import.meta.dirname, "../../public/kicad")
setLoader(async (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(KICAD, `${f}.gz`))).toString()))
const ngspice = ["/opt/homebrew/bin/ngspice", "/usr/local/bin/ngspice"].find((p) => fs.existsSync(p))
const st = linuxBackend.status()
const ready = !!st.qemu && !!st.boot && !!ngspice

const simulate = async (net: SpiceNetlist): Promise<JobResult> => {
  const r = await run(net.text)
  if (r.status !== 200) throw new Error(r.body)
  return remap(JSON.parse(r.body) as JobResult, net)
}

describe.skipIf(!ready)("Raspberry Pi (Linux VM) in a schematic", { timeout: 180_000 }, () => {
  // a failed test must not leave its VM holding the disk
  afterEach(async () => { await linuxVm().shutdown() })
  // one VM at a time: the other Pi test file waits for this one
  beforeAll(() => acquireVm(), 1_200_000)
  afterAll(() => releaseVm())

  it("gpiozero blinks an LED through the circuit and reads a pulled-down input", async () => {
    const r = await compileKirk(`circuit PiLed {
    ground GND
    P1 = lib("Connector:Raspberry_Pi_4")
    R1 = R(330)
    D1 = LED("Red")
    R2 = R(1k)
    P1.11 -- R1 -- A -- D1' -- GND
    P1.13 -- IN -- R2 -- GND
    P1.6 -- GND
}
simulate tran(stop: 1 s, step: 1 ms)
`)
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    const doc = r.doc!
    const [b] = boardParts(doc)
    expect(b.board.name).toBe("Raspberry Pi 4B")
    // GPIO17 (header pin 11) toggles every 100 ms; GPIO27 (pin 13) has 1 kΩ to ground: a pressed button
    const program = `from gpiozero import LED, Button
from time import sleep
led = LED(17); btn = Button(27)
while True:
    led.toggle()
    print("lit" if led.is_lit else "off", "pressed" if btn.is_pressed else "released", flush=True)
    sleep(0.1)
`
    const chip = await linuxChip(b.board, { files: [{ name: "main.py", content: program }] })
    const sim = new CoSim(doc, [{ ref: b.part.ref, board: b.board, chip }], simulate, { frame: 0.05 })
    let serial = ""
    const ma: number[] = []
    const t0 = performance.now()
    while (sim.t < 1) { const f = await sim.step(); serial += f.serial[b.part.ref]; ma.push((f.avg["I(D1)"] ?? 0) * 1000) }
    const wall = (performance.now() - t0) / 1000
    sim.dispose()
    await linuxVm().shutdown()
    console.log(`1 s of Pi + circuit in ${wall.toFixed(1)} s; LED mA per 50 ms frame:`, ma.map((x) => x.toFixed(1)).join(" "))
    // 100 ms on / 100 ms off in 50 ms frames: frames fully lit (≈ (3.3 − 1.8) / 355 ≈ 4 mA), dark,
    // and the ones a toggle falls inside; on average half the lit current. Linux isn't cycle-exact:
    // with the computer busy (the whole test suite) the program's sleep() drifts a little, and Python
    // takes longer to start — the duty cycle counts from the first lit frame.
    expect(ma.filter((x) => x > 3.8).length).toBeGreaterThanOrEqual(3)
    expect(ma.filter((x) => x < 0.3).length).toBeGreaterThanOrEqual(3)
    const blinking = ma.slice(ma.findIndex((x) => x > 0.3))
    const mean = blinking.reduce((a, b) => a + b, 0) / blinking.length
    expect(mean).toBeGreaterThan(1.6)
    expect(mean).toBeLessThan(2.7)
    expect(serial).toContain("pressed")
    expect(serial).not.toContain("released")
  })

  it("in the canvas workspace: a Pi's frames feed the circuit solver (LED on GPIO17)", async () => {
    const board = boardByType("sb-raspberry-pi-4")!
    const diagram: Diagram = {
      version: 1, author: "", editor: "t", parts: [
        { type: board.type, id: "pi", top: 0, left: 0, attrs: {} },
        { type: "wokwi-resistor", id: "r", top: 0, left: 0, attrs: { value: "330" } },
        { type: "wokwi-led", id: "led", top: 0, left: 0, attrs: { color: "red" } },
      ],
      connections: [["pi:GPIO17", "r:1", "", []], ["r:2", "led:A", "", []], ["led:C", "pi:GND.1", "", []]],
    }
    const chip = await linuxChip(board, { files: [{ name: "main.py", content: "from gpiozero import LED\nfrom time import sleep\nled = LED(17)\nwhile True:\n    led.toggle(); sleep(0.1)\n" }] })
    const sim = new McuSim(diagram, "")
    expect(sim.machine).toBeInstanceOf(FedMachine)
    const fed = sim.machine as FedMachine
    const T = 0.05
    fed.feed(await chip.frame({ seconds: 0, digital: [], analog: [] }), 0)
    const lit: number[] = []
    for (let i = 0; i < 24; i++) {
      fed.feed(await chip.frame({ seconds: T, digital: [], analog: [] }), T)
      lit.push(sim.step(T * 1000, T * 1000).leds.get("led")?.[0] ?? 0)
    }
    chip.dispose()
    // 100 ms on / 100 ms off: frames bright and dark
    expect(Math.max(...lit.slice(8))).toBeGreaterThan(0.5)
    expect(Math.min(...lit.slice(8))).toBeLessThan(0.1)
  })

  it("the Raspberry Pi example: pressing SW1 in the schematic lights the LED (gpiozero callbacks)", async () => {
    const doc = await loadExample("pi-button-led")
    const [b] = boardParts(doc)
    const chip = await linuxChip(b.board, doc.firmware![b.part.ref])
    const sim = new CoSim(doc, [{ ref: b.part.ref, board: b.board, chip }], simulate, { frame: 0.05 })
    let serial = ""
    const led = async (seconds: number) => { const ma: number[] = []; const end = sim.t + seconds; while (sim.t < end) { const f = await sim.step(); serial += f.serial[b.part.ref]; ma.push((f.avg["I(D1)"] ?? 0) * 1000) } return ma }
    // the program takes a moment to import gpiozero and set up its callbacks
    const open = await led(1.5)
    expect(Math.max(...open.slice(-5))).toBeLessThan(0.3)
    // an open switch leaves GPIO27 floating: the pull-up decides, no phantom press at start-up
    expect(serial).not.toContain("SW1 pressed")
    sim.setDoc({ ...doc, parts: doc.parts.map((p) => (p.ref === "SW1" ? { ...p, sim: { ...p.sim, Params: "closed=1" } } : p)) })
    const closed = await led(0.5)
    sim.dispose()
    // green LED, Vf ≈ 2.1 V: (3.3 − 2.1) / 355 ≈ 3.4 mA
    expect(Math.min(...closed.slice(-4))).toBeGreaterThan(3)
    expect(serial).toContain("Raspberry Pi 4")
    expect(serial).toContain("SW1 pressed")
  })

  it("a new Raspberry Pi 5 project (Microcontrollers → New) runs its hello world", async () => {
    const pi5 = boardByType("sb-raspberry-pi-5")!
    const blank = blankSketch(pi5.type)
    expect(blank.diagram.parts[0].type).toBe(pi5.type)
    expect(blank.files.map((f) => f.name)).toEqual(["main.py", "requirements.txt"])
    const chip = await linuxChip(pi5, { files: blank.files })
    let serial = ""
    for (let i = 0; i < 40 && !serial.includes("LED off"); i++) serial += (await chip.frame({ seconds: 0.05, digital: [], analog: [] })).serial
    chip.dispose()
    expect(serial).toContain("Hello, world from the Raspberry Pi!")
    expect(serial).toContain("LED on")
    // the comment-only requirements.txt asks for nothing
    expect(serial).not.toContain("requirements.txt")
  })

  it("the assistant's Pi shell: output and exit code of a command", async () => {
    const ok = await piExec("pi5", "python3 -c 'from importlib.metadata import version; print(\"gpiozero\", version(\"gpiozero\"))'", 60)
    expect(ok.code, ok.output).toBe(0)
    expect(ok.output).toMatch(/gpiozero 2\./)
    const bad = await piExec("pi5", "python3 -c 'import nosuchmodule'", 60)
    expect(bad.code).not.toBe(0)
    expect(bad.output).toContain("ModuleNotFoundError")
  })

  it("what a command writes survives QEMU being ended (pip installs stay installed)", async () => {
    const mark = `kept-${Date.now()}`
    await piExec("pi5", `echo ${mark} > /home/pi/.sb-persist-test`, 30)
    // the agent writes back to the disk within half a second (stops end QEMU, they don't shut down)
    expect((await piExec("pi5", "cat /proc/sys/vm/dirty_expire_centisecs", 30)).output.trim()).toBe("50")
    linuxBackend.stop() // SIGKILL, like the app crashing
    const back = await piExec("pi5", "cat /home/pi/.sb-persist-test; rm -f /home/pi/.sb-persist-test", 60)
    expect(back.output.trim()).toBe(mark)
  })
})
