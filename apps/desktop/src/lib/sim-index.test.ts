// Which KiCad symbols simulate today. `pnpm kicad:sim-index` regenerates
// public/kicad/sim-index.json.gz from the real resolver (lib/spice.ts); the normal
// test run fails if that file is out of date, so the two can't drift apart.
import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
import { expect, it } from "vitest"

import { defaultPart, type Part } from "@/editor/model"
import { ensureSymbols, getSymbol, loadIndex, setLoader } from "@/lib/kicad"
import { resolveSim } from "@/lib/spice"

const KICAD = path.resolve(import.meta.dirname, "../../public/kicad")
const FILE = path.join(KICAD, "sim-index.json.gz")
setLoader(async (f) => {
  if (f === "sim-index.json") throw new Error("not used here")
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(KICAD, `${f}.gz`))).toString())
})

/** A symbol simulates if no unit reports a missing model (connection-only units are fine). */
export function simulates(id: string): boolean {
  const s = getSymbol(id)
  if (!s) return false
  if (s.power) return true
  for (let u = 1; u <= Math.max(1, s.units.length); u++) {
    const r = resolveSim({ ...defaultPart(s, u), id: "x", ref: `${s.refPrefix}1`, x: 0, y: 0 } as Part)
    if (r && "error" in r) return false
  }
  return true
}

it("sim-index.json matches the simulation resolver", async () => {
  const rows = await loadIndex()
  const libs = [...new Set(rows.map((r) => r.lib))]
  await ensureSymbols(libs.map((l) => `${l}:${rows.find((r) => r.lib === l)!.name}`))
  const out: Record<string, string[]> = {}
  for (const r of rows) if (simulates(`${r.lib}:${r.name}`)) (out[r.lib] ??= []).push(r.name)
  const count = Object.values(out).reduce((n, a) => n + a.length, 0)

  if (process.env.UPDATE_SIM_INDEX) {
    fs.writeFileSync(FILE, zlib.gzipSync(JSON.stringify(out), { level: 9 }))
    console.log(`sim-index: ${count} of ${rows.length} symbols simulate`)
    return
  }
  expect(fs.existsSync(FILE), "missing sim-index.json.gz — run `pnpm kicad:sim-index`").toBe(true)
  const saved = JSON.parse(zlib.gunzipSync(fs.readFileSync(FILE)).toString())
  expect(saved, "sim-index.json.gz is out of date — run `pnpm kicad:sim-index`").toEqual(out)
}, 120_000)
