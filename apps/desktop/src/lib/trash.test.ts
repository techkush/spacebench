import { describe, expect, it } from "vitest"
import { memoryFS } from "./projectfs"
import { deleteForever, emptyTrash, listTrash, moveToTrash, restoreFromTrash } from "./trash"

describe("trash", () => {
  it("delete → Trash → restore or delete forever", async () => {
    const fs = memoryFS()
    await fs.write("/SB/Sketches/Blink/sketch.ino", "void setup(){}")
    await fs.write("/SB/Sketches/Blink/diagram.json", "{}")
    const t = await moveToTrash(fs, "/SB/Trash", "/SB/Sketches/Blink", "sketch")
    expect(await fs.exists("/SB/Sketches/Blink")).toBe(false)
    expect((await listTrash(fs, "/SB/Trash")).map((x) => [x.name, x.kind, x.original])).toEqual([["Blink", "sketch", "/SB/Sketches/Blink"]])
    // a new Blink took the place: restoring goes beside it
    await fs.write("/SB/Sketches/Blink/sketch.ino", "new")
    expect(await restoreFromTrash(fs, t)).toBe("/SB/Sketches/Blink (restored)")
    expect(await fs.read("/SB/Sketches/Blink (restored)/sketch.ino")).toBe("void setup(){}")
    expect(await listTrash(fs, "/SB/Trash")).toEqual([])
    // forever
    const t2 = await moveToTrash(fs, "/SB/Trash", "/SB/Sketches/Blink", "sketch")
    await deleteForever(fs, t2)
    expect(await listTrash(fs, "/SB/Trash")).toEqual([])
    expect(await fs.exists("/SB/Sketches/Blink")).toBe(false)
    await moveToTrash(fs, "/SB/Trash", "/SB/Sketches/Blink (restored)", "sketch")
    expect(await emptyTrash(fs, "/SB/Trash")).toBe(1)
  })
})
