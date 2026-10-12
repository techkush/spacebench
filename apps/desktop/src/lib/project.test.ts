import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
import { describe, expect, it } from "vitest"

import { deriveNetlist } from "@/editor/netlist"
import { remap, type JobResult } from "@/lib/engine"
import { setLoader } from "@/lib/kicad"
import { buildNetlist } from "@/lib/spice"
import { run } from "../../vite-ngspice"
import { bumpVersion, copyIntoProject, createLibrary, listLibraries } from "./libraries"
import { createProject, loadCircuit, newCircuit, newLibraryFile, openProject, projectResolver, projectTree, saveCircuit } from "./project"
import { join, memoryFS } from "./projectfs"

const KICAD = path.resolve(import.meta.dirname, "../../public/kicad")
setLoader(async (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(KICAD, `${f}.gz`))).toString()))
const ngspice = ["/opt/homebrew/bin/ngspice", "/usr/local/bin/ngspice", "/usr/bin/ngspice"].find((p) => fs.existsSync(p))

describe("projects", () => {
  it("a new project is a folder with everything in its place", async () => {
    const vfs = memoryFS()
    const p = await createProject(vfs, "/Projects", "Night Light", undefined, "LDR night light")
    expect(p.root).toBe("/Projects/Night Light")
    const tree = await projectTree(p)
    expect(tree.map((e) => e.name)).toEqual(["circuits", "firmware", "lib", "models", "pcb", "results", "Night Light.sbproj", "README.md"])
    expect(tree.find((e) => e.name === "circuits")!.children!.map((e) => e.name)).toEqual(["main.kirk"])
    // open it again, by folder or by its .sbproj
    expect((await openProject(vfs, "/Projects/Night Light")).manifest).toMatchObject({ name: "Night Light", main: "circuits/main.kirk", description: "LDR night light" })
    expect((await openProject(vfs, "/Projects/Night Light/Night Light.sbproj")).root).toBe("/Projects/Night Light")
    await expect(createProject(vfs, "/Projects", "Night Light")).rejects.toThrow(/already exists/)
    await expect(openProject(vfs, "/Projects")).rejects.toThrow(/No Space Bench project/)
  })

  it("save writes the code, the board and a cache; open uses the cache until the code changes", async () => {
    const vfs = memoryFS()
    const p = await createProject(vfs, "/P", "Demo")
    const resolve = projectResolver(p, null)
    const first = await loadCircuit(p, "circuits/main.kirk", resolve)
    expect(first.doc.parts.some((x) => x.ref === "R2")).toBe(true)
    const withBoard = { ...first.doc, pcb: { width: 50, height: 30 } as never }
    await saveCircuit(p, "circuits/main.kirk", withBoard)
    expect(await vfs.exists("/P/Demo/pcb/main.board.json")).toBe(true)
    expect(await vfs.exists("/P/Demo/.spacebench/main.json")).toBe(true)
    const again = await loadCircuit(p, "circuits/main.kirk", resolve)
    expect(again.doc.parts.map((x) => [x.ref, x.x, x.y])).toEqual(first.doc.parts.map((x) => [x.ref, x.x, x.y])) // from the cache
    expect(again.doc.pcb).toEqual({ width: 50, height: 30 })
    // edit the code outside the app: the cache is ignored and the code compiled
    await vfs.write("/P/Demo/circuits/main.kirk", (await vfs.read("/P/Demo/circuits/main.kirk")).replace("R2 = R(1k)", "R2 = R(3k)"))
    const edited = await loadCircuit(p, "circuits/main.kirk", resolve)
    expect(edited.doc.parts.find((x) => x.ref === "R2")!.value).toBe("3k")
    // more circuits and libraries
    expect(await newCircuit(p, "Power Supply")).toBe("circuits/power-supply.kirk")
    expect(await newLibraryFile(p, "My Parts")).toBe("lib/myparts.kirk")
    await expect(newCircuit(p, "Power Supply")).rejects.toThrow(/already exists/)
  })

  it.skipIf(!ngspice)("a project library imported by a circuit simulates", async () => {
    const vfs = memoryFS()
    const p = await createProject(vfs, "/P", "Lib Demo")
    await newLibraryFile(p, "My Parts")
    await vfs.write(join(p.root, "circuits/main.kirk"), `import "lib/myparts.kirk"
circuit Main {
    ground GND
    V1 = Vdc(5 V)
    F1 = Divider(ratio: 0.25)
    IN -- V1 -- GND
    F1.in -- IN
    F1.out -- OUT
    F1.gnd -- GND
}
simulate op
`)
    const { doc } = await loadCircuit(p, "circuits/main.kirk", projectResolver(p, null))
    const net = buildNetlist(doc, deriveNetlist(doc), "op")
    const r = remap(JSON.parse((await run(net.text)).body) as JobResult, net)
    expect(r.type === "op" && r.values[r.names.indexOf("V(OUT)")]).toBeCloseTo(1.25, 6)
  })
})

describe("user libraries", () => {
  it("create, list, version, import by name, copy into a project", async () => {
    const vfs = memoryFS()
    const root = "/Space Bench/Libraries"
    expect(await listLibraries(vfs, root)).toEqual([])
    await createLibrary(vfs, root, "Filters", "RC and RLC filters")
    await expect(createLibrary(vfs, root, "Filters")).rejects.toThrow(/already/)
    await expect(createLibrary(vfs, root, "two words!")).rejects.toThrow(/one word/)
    const libs = await listLibraries(vfs, root)
    expect(libs).toHaveLength(1)
    expect(libs[0]).toMatchObject({ name: "Filters", version: "0.1.0", description: "RC and RLC filters", errors: [] })
    expect(libs[0].components.map((c) => c.name)).toEqual(["Divider"])
    // versions
    const text = await vfs.read(libs[0].file)
    expect(bumpVersion(text, "patch")).toContain('version "0.1.1"')
    expect(bumpVersion(text, "minor")).toContain('version "0.2.0"')
    expect(bumpVersion(text, "major")).toContain('version "1.0.0"')
    // a project imports it by name …
    const p = await createProject(vfs, "/P", "Uses Filters")
    const resolve = projectResolver(p, { fs: vfs, root })
    expect(await resolve("Filters", true)).toMatchObject({ path: "library:Filters" })
    expect(await resolve("Nope", true)).toBeNull()
    // … or carries a copy
    expect(await copyIntoProject(vfs, root, "Filters", p.root)).toBe("lib/filters.kirk")
    expect(await vfs.exists(join(p.root, "lib/filters.kirk"))).toBe(true)
  })
})

describe("sketches in a project", () => {
  it("firmware/<name>/ holds the sketch, the wiring and the libraries", async () => {
    const { newSketch, loadSketch, saveSketch, sketchFolderOf } = await import("@/mcu/sketchfs")
    const vfs = memoryFS()
    const p = await createProject(vfs, "/P", "Bot")
    const folder = await newSketch(p, "Line Follower")
    expect(folder).toBe("firmware/line-follower")
    const s = await loadSketch(p, folder)
    expect(s.files.map((f) => f.name)).toEqual(["sketch.ino", "libraries.txt"])
    expect(s.diagram.parts[0].type).toBe("wokwi-arduino-uno")
    await saveSketch(p, folder, { ...s, files: [...s.files, { name: "motors.h", content: "#pragma once\n" }], diagram: { ...s.diagram, connections: [["uno:13", "uno:GND.1", "black", []]] } })
    const again = await loadSketch(p, folder)
    expect(again.files.map((f) => f.name)).toEqual(["sketch.ino", "motors.h", "libraries.txt"])
    expect(again.diagram.connections).toHaveLength(1)
    // removing a file from the sketch removes it from the folder
    await saveSketch(p, folder, again.files.length ? { ...again, files: again.files.filter((f) => f.name !== "motors.h") } : again)
    expect((await loadSketch(p, folder)).files.map((f) => f.name)).toEqual(["sketch.ino", "libraries.txt"])
    expect(sketchFolderOf("firmware/line-follower/diagram.json")).toBe("firmware/line-follower")
    expect(await newSketch(p, "Line Follower")).toBe("firmware/line-follower-2")
  })

  it("a Raspberry Pi project (main.py) saves and opens again", async () => {
    const { loadSketch, saveSketch } = await import("@/mcu/sketchfs")
    const { blankSketch } = await import("@/mcu/examples")
    const vfs = memoryFS()
    const p = await createProject(vfs, "/P", "Pi")
    const blank = blankSketch("sb-raspberry-pi-5")
    const files = [...blank.files, { name: "util.py", content: "X = 1\n" }]
    await saveSketch(p, "firmware/hello", { name: "hello", files, diagram: blank.diagram })
    const s = await loadSketch(p, "firmware/hello")
    expect(s.files.map((f) => f.name)).toEqual(["main.py", "util.py", "requirements.txt"])
    expect(s.files[0].content).toContain("Hello, world")
    expect(s.diagram.parts[0].type).toBe("sb-raspberry-pi-5")
  })
})
