import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import zlib from "node:zlib"
import { spawnSync } from "node:child_process"
import { beforeAll, describe, expect, it } from "vitest"

import { EXAMPLES, loadExample } from "@/editor/examples"
import type { Doc } from "@/editor/model"
import { deriveNetlist } from "@/editor/netlist"
import { setLoader } from "@/lib/kicad"
import { boardParts, connectivity, drc, ratsnest, syncBoard } from "./board"
import { footprintFor, footprintFromName } from "./footprints"
import { drill, fabricationFiles, zip } from "./gerber"
import { autoRoute } from "./route"

const KICAD = path.resolve(import.meta.dirname, "../../public/kicad")
setLoader(async (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(KICAD, `${f}.gz`))).toString()))
const docs: Record<string, Doc> = {}
beforeAll(async () => { for (const e of EXAMPLES) docs[e.id] = await loadExample(e.id) })

describe("footprints from KiCad names", () => {
  it("DIP-8: pin 1 square top-left, counter-clockwise numbering, 7.62 mm rows", () => {
    const f = footprintFromName("Package_DIP:DIP-8_W7.62mm")!
    expect(f.pads.map((p) => p.n)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"])
    expect(f.pads[0]).toMatchObject({ x: 0, y: 0, shape: "rect", drill: 0.8 })
    expect(f.pads[3]).toMatchObject({ x: 0, y: 7.62 })
    expect(f.pads[4]).toMatchObject({ x: 7.62, y: 7.62 }) // pin 5 opposite pin 4
    expect(f.pads[7]).toMatchObject({ x: 7.62, y: 0 })
  })
  it("chip, axial, radial, TO-92, header", () => {
    expect(footprintFromName("R_0603_1608Metric")!.pads.map((p) => [p.x, p.w])).toEqual([[-0.825, 0.8], [0.825, 0.8]])
    expect(footprintFromName("R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal")!.pads[1].x).toBe(10.16)
    expect(footprintFromName("CP_Radial_D5.0mm_P2.00mm")!.pads.map((p) => p.x)).toEqual([0, 2])
    expect(footprintFromName("TO-92_Inline")!.pads.map((p) => p.x)).toEqual([0, 1.27, 2.54])
    expect(footprintFromName("PinHeader_1x03_P2.54mm_Vertical")!.pads.map((p) => p.y)).toEqual([0, 2.54, 5.08])
    expect(footprintFromName("SOIC-8_3.9x4.9mm_P1.27mm")!.smd).toBe(true)
  })
  it("every example part gets a footprint whose pads cover its pins", () => {
    for (const d of Object.values(docs)) for (const p of d.parts) {
      if (p.lib.startsWith("power:") || p.lib.startsWith("@")) continue
      const f = footprintFor(p)
      expect(f.pads.length, `${d.title} ${p.ref}`).toBeGreaterThan(1)
    }
    const u1 = docs["555-astable"].parts.find((p) => p.ref === "U1")!
    expect(footprintFor(u1).label).toBe("DIP-8 · 7.62 mm")
    const q1 = docs["ce-amp"].parts.find((p) => p.ref === "Q1")!
    expect(footprintFor(q1).label).toBe("TO-92 inline")
  })
})

describe("board", () => {
  it("auto-placement puts every part on the board without overlaps", () => {
    for (const [id, d] of Object.entries(docs)) {
      const nl = deriveNetlist(d)
      const b = syncBoard(d, nl, undefined)
      const parts = boardParts(d, nl, b)
      const items = drc(parts, b)
      expect(items.filter((i) => i.kind === "edge" || i.kind === "overlap"), id).toEqual([])
    }
  })
  it("ratsnest: each net needs (pads − 1) connections before routing", () => {
    const d = docs["555-astable"], nl = deriveNetlist(d)
    const b = syncBoard(d, nl, undefined)
    const parts = boardParts(d, nl, b)
    const pads = parts.flatMap((p) => p.pads).filter((p) => p.net)
    const nets = new Map<string, number>()
    for (const p of pads) nets.set(p.net, (nets.get(p.net) ?? 0) + 1)
    const expected = [...nets.values()].reduce((s, n) => s + n - 1, 0)
    expect(ratsnest(parts, b)).toHaveLength(expected)
  })
  for (const id of ["555-astable", "rc-lowpass", "led", "ce-amp", "rlc-ringing", "half-wave", "opamp-inv", "7805"]) {
    it(`auto-router: ${id} fully routed, no shorts or clearance errors`, () => {
      const d = docs[id], nl = deriveNetlist(d)
      const b0 = syncBoard(d, nl, undefined)
      const r = autoRoute(d, nl, b0)
      const parts = boardParts(d, nl, r.board)
      expect(r.failed).toEqual([])
      const items = drc(parts, r.board)
      expect(items.filter((i) => i.severity === "error"), JSON.stringify(items.slice(0, 3))).toEqual([])
      // no via sits inside a pad (via-in-pad)
      const allPads = parts.flatMap((p) => p.pads)
      for (const v of r.board.vias) expect(allPads.some((p) => Math.abs(v.x - p.ax) < p.aw / 2 && Math.abs(v.y - p.ay) < p.ah / 2), `via ${v.x},${v.y}`).toBe(false)
      // every net is one copper island
      const pads = parts.flatMap((p) => p.pads).filter((p) => p.net)
      const { find, key } = connectivity({ pads, tracks: r.board.tracks, vias: r.board.vias })
      const roots = new Map<string, Set<string>>()
      for (const p of pads) roots.set(p.net, (roots.get(p.net) ?? new Set()).add(find(key.pad(p))))
      for (const [net, s] of roots) expect(s.size, net).toBe(1)
    })
  }
})

describe("fabrication output", () => {
  const d = () => docs["555-astable"]
  it("Gerber layers flash every pad and via; the drill file has one hit per hole", () => {
    const doc = d(), nl = deriveNetlist(doc)
    const { board } = autoRoute(doc, nl, syncBoard(doc, nl, undefined))
    const parts = boardParts(doc, nl, board)
    const files = fabricationFiles(board, parts, "blinker")
    expect(Object.keys(files).sort()).toEqual(["blinker-B_Cu.gbr", "blinker-B_Mask.gbr", "blinker-Edge_Cuts.gbr", "blinker-F_Cu.gbr", "blinker-F_Mask.gbr", "blinker-F_Paste.gbr", "blinker-F_Silkscreen.gbr", "blinker.drl"])
    const pads = parts.flatMap((p) => p.pads)
    // paste only on SMD pads
    expect((files["blinker-F_Paste.gbr"].match(/D03\*/g) ?? []).length).toBe(pads.filter((p) => !p.drill).length)
    const top = files["blinker-F_Cu.gbr"]
    expect(top).toMatch(/^%TF\.GenerationSoftware/)
    expect(top).toContain("%FSLAX46Y46*%")
    expect(top.trimEnd().endsWith("M02*")).toBe(true)
    expect((top.match(/D03\*/g) ?? []).length).toBe(pads.length + board.vias.length) // all pads are on the top layer
    const holes = pads.filter((p) => p.drill).length + board.vias.length
    const drl = drill(board, parts)
    expect((drl.match(/^X[\d.]+Y[\d.]+$/gm) ?? []).length).toBe(holes)
    // every track draws exactly one D01 stroke on its layer
    expect((top.match(/D01\*/g) ?? []).length).toBe(board.tracks.filter((t) => t.layer === "F").length)
  })
  it("zip opens with Python's zipfile and the CRCs check out", () => {
    const bytes = zip({ "a.txt": "hello", "b/c.gbr": "G04 x*\nM02*\n" })
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sbzip-")), "t.zip")
    fs.writeFileSync(file, bytes)
    const py = spawnSync("python3", ["-c", `import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);print(z.testzip() or "ok");print(",".join(z.namelist()));print(z.read("a.txt").decode())`, file], { encoding: "utf8" })
    if (py.error) return // no python: skip
    expect(py.stdout.trim().split("\n")).toEqual(["ok", "a.txt,b/c.gbr", "hello"])
  })
})

import { fitBoard, labelBox } from "./board"
import { autoLabel } from "./labels"
import { bodiesFor, heightOf } from "./model3d"

describe("auto label", () => {
  for (const id of ["555-astable", "ce-amp", "opamp-inv", "7805", "led", "rlc-ringing"]) {
    it(`${id}: references overlap no pad, via, other reference or the edge — before and after routing`, () => {
      const d = docs[id], nl = deriveNetlist(d)
      for (const routed of [false, true]) {
        let b = syncBoard(d, nl, undefined)
        if (routed) b = autoRoute(d, nl, b).board
        const r = autoLabel(boardParts(d, nl, b), b)
        expect(r.unplaced, `${id} routed=${routed}`).toEqual([])
        const nb = { ...b, labels: r.labels }
        const items = drc(boardParts(d, nl, nb), nb).filter((i) => i.kind === "silk")
        expect(items, `${id} routed=${routed}`).toEqual([])
        // and no label sits on a via
        for (const [ref, l] of Object.entries(r.labels)) {
          const bx = labelBox(ref, l)
          for (const v of nb.vias) expect(bx[0] < v.x + v.dia / 2 && bx[2] > v.x - v.dia / 2 && bx[1] < v.y + v.dia / 2 && bx[3] > v.y - v.dia / 2, `${ref} over via`).toBe(false)
        }
      }
    })
  }
})

describe("router options", () => {
  it("top-only routing puts no copper or vias on the bottom", () => {
    const d = docs["555-astable"], nl = deriveNetlist(d)
    const r = autoRoute(d, nl, syncBoard(d, nl, undefined), { layers: "top" })
    expect(r.board.tracks.every((t) => t.layer === "F")).toBe(true)
    expect(r.board.vias).toEqual([])
    expect(r.routed).toBeGreaterThan(0)
  })
  it("a net filter routes only that net; replace removes its old tracks first", () => {
    const d = docs["555-astable"], nl = deriveNetlist(d)
    const b0 = syncBoard(d, nl, undefined)
    const r = autoRoute(d, nl, b0, { nets: ["GND"] })
    expect(new Set(r.board.tracks.map((t) => t.net))).toEqual(new Set(["GND"]))
    const again = autoRoute(d, nl, r.board, { nets: ["GND"], clearFirst: true })
    expect(again.board.tracks.filter((t) => t.net === "GND").length).toBe(r.board.tracks.length) // replaced, not doubled
  })
  it("rip-up and retry never does worse than a single attempt", () => {
    const d = docs["opamp-inv"], nl = deriveNetlist(d)
    const tight = { ...syncBoard(d, nl, undefined) }
    const one = autoRoute(d, nl, tight, { attempts: 1, grid: 0.5 })
    const many = autoRoute(d, nl, tight, { attempts: 4, grid: 0.5 })
    expect(many.failed.length).toBeLessThanOrEqual(one.failed.length)
  })
})

describe("board size", () => {
  it("fit to parts shrinks the outline and keeps everything inside with the margin", () => {
    const d = docs["555-astable"], nl = deriveNetlist(d)
    const b = autoRoute(d, nl, syncBoard(d, nl, undefined)).board
    const f = fitBoard(boardParts(d, nl, b), b, 2)
    expect(f.width * f.height).toBeLessThan(b.width * b.height)
    const parts = boardParts(d, nl, f)
    const items = drc(parts, f)
    expect(items.filter((i) => i.kind === "edge" || i.severity === "error")).toEqual([]) // still routed, nothing off-board
    for (const p of parts) { expect(p.court[0]).toBeGreaterThanOrEqual(1.3); expect(p.court[2]).toBeLessThanOrEqual(f.width - 1.3) }
  })
})

describe("3D bodies", () => {
  it("every part gets a body, ICs and capacitors stand at realistic heights", () => {
    const d = docs["555-astable"], nl = deriveNetlist(d)
    const parts = boardParts(d, nl, syncBoard(d, nl, undefined))
    for (const p of parts) expect(bodiesFor(p).length, p.ref).toBeGreaterThan(0)
    const h = (ref: string) => heightOf(bodiesFor(parts.find((p) => p.ref === ref)!))
    expect(h("U1")).toBeGreaterThan(3); expect(h("U1")).toBeLessThan(5) // DIP-8 ≈ 3.8 mm
    expect(h("D1")).toBeGreaterThan(4) // 3 mm LED dome ≈ 5 mm
    const smd = parts.find((p) => p.fp.smd)!
    expect(heightOf(bodiesFor(smd))).toBeLessThan(1) // 0603 chip
  })
})

import { autoPlace, smartPlace } from "./board"

describe("smart placement", () => {
  it("shortens the ratsnest and routes single-sided boards at least as well as row packing", () => {
    let shorter = 0, betterOrEqual = 0
    const ids = ["555-astable", "ce-amp", "opamp-inv", "7805", "led", "rc-lowpass", "rlc-ringing", "half-wave"]
    for (const id of ids) {
      const d = docs[id], nl = deriveNetlist(d)
      const empty = { ...syncBoard(d, nl, undefined), place: {} }
      const rows = autoPlace(d, nl, empty, true), smart = smartPlace(d, nl, empty)
      const len = (b: typeof rows) => ratsnest(boardParts(d, nl, b), b).reduce((s, r) => s + r.len, 0)
      if (len(smart) < len(rows)) shorter++
      // no overlaps, all on the board
      expect(drc(boardParts(d, nl, smart), smart).filter((i) => i.kind === "edge" || i.kind === "overlap"), id).toEqual([])
      const f1 = autoRoute(d, nl, rows, { layers: "top" }).failed.length, f2 = autoRoute(d, nl, smart, { layers: "top" }).failed.length
      if (f2 <= f1) betterOrEqual++
    }
    expect(shorter).toBeGreaterThanOrEqual(6)
    expect(betterOrEqual).toBeGreaterThanOrEqual(7)
  }, 30_000) // routes several example boards: ~4.5 s alone, more when the whole suite runs
})

import { resizeBoard } from "./board"

describe("resize from any edge", () => {
  it("dragging the left and top edges in shrinks the board and keeps every part, track and via in place relative to the right / bottom", () => {
    const d = docs["ce-amp"], nl = deriveNetlist(d)
    const b = autoRoute(d, nl, syncBoard(d, nl, undefined)).board
    const r = resizeBoard(b, "lt", 5.2, 3.1) // snaps to 5.0 / 3.0 mm
    expect(r.shift).toEqual([5, 3])
    expect(r.width).toBe(b.width - 5); expect(r.height).toBe(b.height - 3)
    const ref = Object.keys(b.place)[0]
    expect(r.place[ref].x).toBeCloseTo(b.place[ref].x - 5); expect(r.place[ref].y).toBeCloseTo(b.place[ref].y - 3)
    expect(r.tracks[0].a[0]).toBeCloseTo(b.tracks[0].a[0] - 5)
    // distance to the right edge is unchanged
    expect(r.width - r.place[ref].x).toBeCloseTo(b.width - b.place[ref].x)
    // still a valid board (nothing cut off on this example) and routing intact
    const items = drc(boardParts(d, nl, r), r)
    expect(items.filter((i) => i.severity === "error")).toEqual([])
  })
  it("right / bottom edges don't move the content; the board never goes below 5 mm", () => {
    const d = docs["led"], nl = deriveNetlist(d)
    const b = syncBoard(d, nl, undefined)
    const r = resizeBoard(b, "rb", -100, -100)
    expect(r.width).toBe(5); expect(r.height).toBe(5); expect(r.shift).toEqual([0, 0])
    expect(r.place).toEqual(b.place)
  })
})
