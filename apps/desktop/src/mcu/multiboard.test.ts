// Several boards in one workspace: file ownership, the per-board diagram, the sketch folder
// on disk, and two boards running different sketches side by side.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { createProject } from "@/lib/project"
import { memoryFS } from "@/lib/projectfs"
import type { Diagram } from "./diagram"
import { boardDiagram, boardLinks, filesOf, mergeFrames, ownerOf, rehome } from "./multiboard"
import { McuSim } from "./sim"

const two = (): Diagram => ({
  version: 1, author: "", editor: "t",
  parts: [
    { type: "wokwi-arduino-uno", id: "uno", top: 0, left: 0, attrs: {} },
    { type: "wokwi-arduino-nano", id: "nano", top: 0, left: 400, attrs: {} },
    { type: "wokwi-led", id: "led1", top: 0, left: 0, attrs: {} },
    { type: "wokwi-led", id: "led2", top: 0, left: 0, attrs: {} },
  ],
  connections: [
    ["uno:13", "led1:A", "green", []], ["led1:C", "uno:GND.1", "black", []],
    ["nano:12", "led2:A", "green", []], ["led2:C", "nano:GND.2", "black", []],
    ["uno:2", "nano:3", "blue", []], ["uno:GND.2", "nano:GND.1", "black", []],
  ],
})
const files = [
  { name: "sketch.ino", content: "a" }, { name: "libraries.txt", content: "" },
  { name: "nano/sketch.ino", content: "b" }, { name: "nano/util.h", content: "c" },
]

describe("several boards", () => {
  it("each board owns its files", () => {
    const boards = two().parts.slice(0, 2)
    expect(ownerOf("sketch.ino", boards)).toBe("uno")
    expect(ownerOf("nano/util.h", boards)).toBe("nano")
    expect(ownerOf("gone/sketch.ino", boards)).toBeUndefined()
    expect(filesOf(files, "").map((f) => f.name)).toEqual(["sketch.ino", "libraries.txt"])
    expect(filesOf(files, "nano/").map((f) => f.name)).toEqual(["sketch.ino", "util.h"])
  })

  it("the first board's files move when another board becomes the first", () => {
    const r = rehome(files, "uno", "nano")
    expect(r.map((f) => [f.name, f.content])).toEqual([["uno/sketch.ino", "a"], ["uno/libraries.txt", ""], ["sketch.ino", "b"], ["util.h", "c"]])
    expect(rehome(r, "nano", "uno")).toEqual(files)
  })

  it("each board's simulator sees its own parts and a shared ground", () => {
    const d = boardDiagram(two(), "nano")
    expect(d.parts.map((p) => p.id)).toEqual(["nano", "led2"])
    // uno's ground pins become nano's; the uno:2 – nano:3 signal wire is dropped
    // led1 is the uno's (wired to it only); unwired parts go with the first board
    expect(boardDiagram(two(), "uno").parts.map((p) => p.id)).toEqual(["uno", "led1"])
    expect(d.connections).toContainEqual(["nano:GND", "nano:GND.1", "black", []])
    expect(d.connections.some((c) => c.join().includes("uno:"))).toBe(false)
    expect(boardLinks(two()).map((c) => c.slice(0, 2))).toEqual([["uno:2", "nano:3"]])
    // one board: unchanged
    const one = { ...two(), parts: two().parts.filter((p) => p.id !== "nano") }
    expect(boardDiagram(one, "uno")).toBe(one)
  })

  it("saves other boards' sketches in a folder named after the board", async () => {
    const { loadSketch, newSketch, saveSketch } = await import("./sketchfs")
    const p = await createProject(memoryFS(), "/P", "Two")
    const folder = await newSketch(p, "Pair")
    await saveSketch(p, folder, { name: "pair", files, diagram: two() })
    expect(await p.fs.exists("/P/Two/firmware/pair/nano/util.h")).toBe(true)
    const back = await loadSketch(p, folder)
    expect(back.files.map((f) => f.name)).toEqual(["sketch.ino", "libraries.txt", "nano/sketch.ino", "nano/util.h"])
    // removing a file from a board's folder removes it from disk
    await saveSketch(p, folder, { ...back, files: back.files.filter((f) => f.name !== "nano/util.h") })
    expect(await p.fs.exists("/P/Two/firmware/pair/nano/util.h")).toBe(false)
  })
})

const cli = ["/opt/homebrew/bin/arduino-cli", "/usr/local/bin/arduino-cli"].find((p) => fs.existsSync(p))
const hasAvr = !!cli && execFileSync(cli, ["core", "list"], { encoding: "utf8" }).includes("arduino:avr")
function build(code: string, fqbn: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbtest-"))
  const sk = path.join(dir, "sketch"); fs.mkdirSync(sk)
  fs.writeFileSync(path.join(sk, "sketch.ino"), code)
  execFileSync(cli!, ["compile", "--fqbn", fqbn, "--build-path", path.join(dir, "build"), "--output-dir", path.join(dir, "out"), sk], { encoding: "utf8" })
  return fs.readFileSync(path.join(dir, "out", "sketch.ino.hex"), "utf8")
}

describe.skipIf(!hasAvr)("two boards running", { timeout: 120_000 }, () => {
  it("each runs its own sketch on its own LED", () => {
    const d = two()
    const a = new McuSim(boardDiagram(d, "uno"), build(`void setup(){ pinMode(13, OUTPUT); digitalWrite(13, HIGH); Serial.begin(9600); Serial.print("uno"); } void loop(){}`, "arduino:avr:uno"))
    const b = new McuSim(boardDiagram(d, "nano"), build(`void setup(){ pinMode(12, OUTPUT); Serial.begin(9600); Serial.print("nano"); } void loop(){ digitalWrite(12, millis() / 10 % 2); }`, "arduino:avr:nano:cpu=atmega328"))
    let sa = "", sb = ""
    a.onSerial = (t) => (sa += t); b.onSerial = (t) => (sb += t)
    const fa = a.step(30, 30), fb = b.step(30, 30)
    expect(sa).toBe("uno"); expect(sb).toBe("nano")
    expect(fa.leds.get("led1")?.[0]).toBeGreaterThan(0.8)
    expect(fb.leds.get("led2")?.[0]).toBeGreaterThan(0.2)
    const m = mergeFrames({ uno: fa, nano: fb }, "nano")!
    expect(m.leds.get("led1")?.[0]).toBeGreaterThan(0.8)
    expect(m.leds.get("led2")?.[0]).toBeGreaterThan(0.2)
    expect(Object.keys(m.boards ?? {})).toEqual(["uno", "nano"])
  })
})
