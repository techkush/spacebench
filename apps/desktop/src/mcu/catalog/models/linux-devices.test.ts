// linux-devices: the Raspberry Pi Camera Module (and the ReSpeaker's Pi side) as Linux devices in
// the Pi's VM. The VM tests need QEMU and the set-up Raspberry Pi system (Settings → Linux
// boards) and are skipped otherwise; they install the add-ons through the assistant's
// check_setup / install path (checkSetup / installSetup), as the app does after the user agreed.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { acquireVm, releaseVm } from "@/linux/vm-lock.testutil"
import { linuxBackend } from "../../../../vite-linux"

vi.mock("@/linux/host", () => ({
  linuxStatus: async () => linuxBackend.status(),
  linuxStart: async (o: Parameters<typeof linuxBackend.start>[0]) => linuxBackend.start(o),
  linuxStop: async () => linuxBackend.stop(),
  linuxQmp: async (cmd: string) => linuxBackend.qmp(cmd),
  linuxPoll: async () => linuxBackend.poll(),
  linuxSend: async (o: { console?: string; agent?: string }) => linuxBackend.send(o),
}))

import { linuxVm } from "@/linux/agent"
import { linuxChip } from "@/linux/chip"
import { piExec } from "@/linux/exec"
import { CAMERA_PART, MIC_PART, guestMedia, mediaNote } from "@/linux/media"
import { boardByType } from "@/mcu/boards"
import { checkSetup, installSetup } from "@/mcu/setup"
import { catalogPart } from ".."
import group from "./linux-devices"
import { PARTS } from "./linux-devices.parts"

const st = linuxBackend.status()
const ready = !!st.qemu && !!st.boot
const pi = boardByType("sb-raspberry-pi-5")!

// runs in the guest (as pi): one captured YUYV 640×480 frame → what it shows
const CHECK = String.raw`import sys, wave, array
what = sys.argv[1]
if what == "frame":
    f = open(sys.argv[2], "rb").read()
    n = 640 * 480 * 2
    print("bytes", len(f))
    f = f[-n:]
    def px(x, y):
        o = (y * 640 + (x & ~1)) * 2
        return f[o], f[o + 1], f[o + 3]  # Y, U, V
    # colour bars: white (75 %) on the left, red sixth, blue last; the ball: red pixels on a pale wall
    print("white", *px(40, 100)); print("red", *px(500, 100)); print("blue", *px(620, 100)); print("floor", *px(40, 440))
    red = sum(1 for y in range(0, 480, 4) for x in range(0, 640, 4) if px(x, y)[2] > 180 and px(x, y)[0] < 130)
    print("redpix", red)
    print("mean", sum(f[0::2]) / (n // 2))
else:
    w = wave.open(sys.argv[2])
    a = array.array("h", w.readframes(w.getnframes()))
    print("rate", w.getframerate()); print("ch", w.getnchannels()); print("n", len(a))
    print("peak", max(abs(x) for x in a)); print("rms", (sum(x * x for x in a) / max(1, len(a))) ** 0.5)
`
const num = (out: string, key: string) => Number(new RegExp(`^${key} (\\S+)`, "m").exec(out)?.[1] ?? NaN)

describe("linux-devices catalogue", () => {
  it("the Camera Module is simulated, with Scene and Brightness controls and a hint", () => {
    const p = PARTS[CAMERA_PART]
    expect(p.model.m).toBe("proto")
    expect(p.hint).toMatch(/On a Raspberry Pi board: \/dev\/video0 shows/)
    expect(p.hint).toMatch(/OpenCV/)
    expect(p.hint).toMatch(/Needs the camera add-on \(installed once, asks first\)/)
    const cat = catalogPart(CAMERA_PART)
    expect(cat?.model.m).toBe("proto")
    expect(group.proto?.["pi-camera"]).toBeTypeOf("function")
  })

  it("the guest's devices follow the parts on the canvas and their controls", () => {
    const parts = [{ id: "pi", type: pi.type }, { id: "cam", type: CAMERA_PART }]
    expect(guestMedia(parts)).toMatchObject({ camera: { scene: 0, brightness: 50 }, mic: null })
    expect(guestMedia(parts, { cam: { v: { scene: 1 } } }).camera).toEqual({ scene: 1, brightness: 50 })
    expect(guestMedia([...parts, { id: "rs", type: MIC_PART }], { rs: { v: { level: 20 } } }).mic).toEqual({ sound: 0, level: 20 })
    expect(guestMedia([{ id: "pi", type: pi.type }])).toMatchObject({ camera: null, mic: null })
    expect(mediaNote({ camera: "missing", mic: "off" })).toMatch(/install pi-camera/)
    expect(mediaNote({ camera: "on", mic: "on" })).toBe("")
  })
})

describe.skipIf(!ready)("linux-devices on the Raspberry Pi (Linux VM)", { timeout: 900_000 }, () => {
  // a failed test must not leave its VM holding the disk
  afterEach(async () => { await linuxVm().shutdown() })
  // one VM at a time: the other Pi test file waits for this one
  beforeAll(() => acquireVm(), 1_200_000)
  afterAll(() => releaseVm())

  it("Camera Module: the add-on installs, /dev/video0 streams the scene, its controls change it", async () => {
    // check_setup lists the add-on for a project with the part; install it (the user agreed)
    let item = (await checkSetup([pi], undefined, [pi.type, CAMERA_PART])).find((i) => i.id === "pi-camera")
    expect(item).toBeDefined()
    if (!item!.ok) {
      console.log(await installSetup("pi-camera", [pi]))
      item = (await checkSetup([pi], undefined, [pi.type, CAMERA_PART])).find((i) => i.id === "pi-camera")
    }
    expect(item!.ok, item!.detail).toBe(true)

    // run a program with the part on the canvas: the feeder starts
    const parts = [{ id: "pi", type: pi.type }, { id: "cam1", type: CAMERA_PART }]
    const chip = await linuxChip(pi, { files: [{ name: "main.py", content: "print('ready', flush=True)\n" }] }, { parts, ui: { cam1: { v: { scene: 0 } } } })
    let serial = ""
    for (let i = 0; i < 20 && !serial.includes("ready"); i++) serial += (await chip.frame({ seconds: 0.05, digital: [], analog: [] })).serial
    expect(serial).not.toMatch(/Camera Module:/)
    expect(serial).toContain("ready")
    // (the co-simulation left the VM paused between frames)
    await linuxVm().resume()
    await linuxVm().put("/home/pi/.sbcheck.py", CHECK)

    const info = await piExec(pi.linux!, "v4l2-ctl --list-devices; v4l2-ctl -d /dev/video0 --get-fmt-video", 60)
    expect(info.output).toContain("Raspberry Pi Camera Module")
    expect(info.output).toMatch(/Width\/Height\s*:\s*640\/480/)
    expect(info.output).toContain("YUYV")

    const grab = async () => {
      const r = await piExec(pi.linux!, "rm -f /tmp/f.yuv; v4l2-ctl -d /dev/video0 --stream-mmap --stream-count=3 --stream-to=/tmp/f.yuv && python3 ~/.sbcheck.py frame /tmp/f.yuv", 60)
      expect(r.code, r.output).toBe(0)
      return r.output
    }
    const bars = await grab()
    console.log(bars)
    expect(num(bars, "bytes")).toBe(3 * 640 * 480 * 2)
    // 75 % white: Y ≈ 180, no colour; red: V high; blue: U high
    expect(num(bars, "white")).toBeGreaterThan(160)
    expect(bars).toMatch(/^red \d+ \d+ (2[01]\d)/m)
    expect(bars).toMatch(/^blue \d+ (2[01]\d)/m)

    // the Scene slider: the bouncing red ball
    chip.ui!("cam1", { v: { scene: 1 } })
    await piExec(pi.linux!, "sleep 1", 30) // the VM runs (resumed), the feeder follows
    const ball = await grab()
    console.log(ball)
    // a ball of radius 44 px ≈ 6000 red pixels (every 16th sampled), on a wooden table instead of the black band
    expect(num(ball, "redpix")).toBeGreaterThan(250)
    expect(num(ball, "redpix")).toBeLessThan(500)
    expect(num(bars, "floor")).toBeLessThan(50)
    expect(num(ball, "floor")).toBeGreaterThan(90)

    // Brightness: darker picture
    const before = num(ball, "mean")
    chip.ui!("cam1", { v: { brightness: 10 } })
    await piExec(pi.linux!, "sleep 1", 30) // the VM runs (resumed), the feeder follows
    const dim = await grab()
    expect(num(dim, "mean")).toBeLessThan(before - 40)
    chip.dispose()

    // without the part, the camera is unplugged
    const bare = await linuxChip(pi, { files: [{ name: "main.py", content: "print('x')\n" }] }, { parts: [{ id: "pi", type: pi.type }] })
    bare.dispose()
    const gone = await piExec(pi.linux!, "ls /dev/video0", 30)
    expect(gone.code).not.toBe(0)
  })

  it("ReSpeaker on a Pi: the audio add-on installs, arecord records the voice-like sound, its level follows the control", async () => {
    let item = (await checkSetup([pi], undefined, [pi.type, MIC_PART])).find((i) => i.id === "pi-audio")
    expect(item).toBeDefined()
    if (!item!.ok) {
      console.log(await installSetup("pi-audio", [pi]))
      item = (await checkSetup([pi], undefined, [pi.type, MIC_PART])).find((i) => i.id === "pi-audio")
    }
    expect(item!.ok, item!.detail).toBe(true)

    const parts = [{ id: "pi", type: pi.type }, { id: "rs1", type: MIC_PART }]
    const chip = await linuxChip(pi, { files: [{ name: "main.py", content: "print('ready', flush=True)\n" }] }, { parts })
    let serial = ""
    for (let i = 0; i < 20 && !serial.includes("ready"); i++) serial += (await chip.frame({ seconds: 0.05, digital: [], analog: [] })).serial
    expect(serial).not.toMatch(/ReSpeaker microphone:/)
    // (the co-simulation left the VM paused between frames)
    await linuxVm().resume()
    await linuxVm().put("/home/pi/.sbcheck.py", CHECK)

    const list = await piExec(pi.linux!, "arecord -l", 30)
    expect(list.output).toMatch(/card \d+: ReSpeaker/)
    // the default input (plain arecord, as the pi user) — 2 s of 16 kHz stereo
    const rec = await piExec(pi.linux!, "arecord -q -d 2 -f S16_LE -r 16000 -c 2 /tmp/a.wav && python3 ~/.sbcheck.py wav /tmp/a.wav", 60)
    console.log(rec.output)
    expect(rec.code, rec.output).toBe(0)
    expect(num(rec.output, "n")).toBe(2 * 16000 * 2)
    expect(num(rec.output, "rms")).toBeGreaterThan(1500)
    expect(num(rec.output, "peak")).toBeGreaterThan(10000)
    // by name, converted to CD quality by ALSA's plug layer
    const cd = await piExec(pi.linux!, "arecord -q -D plughw:ReSpeaker -d 1 -f cd /tmp/b.wav && python3 ~/.sbcheck.py wav /tmp/b.wav", 60)
    expect(cd.code, cd.output).toBe(0)
    expect(num(cd.output, "rate")).toBe(44100)
    expect(num(cd.output, "rms")).toBeGreaterThan(1500)

    // the level control: silence at 0
    chip.ui!("rs1", { v: { level: 0 } })
    await piExec(pi.linux!, "sleep 1", 30) // the VM runs (resumed), the feeder follows
    const quiet = await piExec(pi.linux!, "arecord -q -d 1 -f S16_LE -r 16000 -c 2 /tmp/c.wav && python3 ~/.sbcheck.py wav /tmp/c.wav", 60)
    expect(num(quiet.output, "rms")).toBeLessThan(50)
    chip.dispose()
  })
})
