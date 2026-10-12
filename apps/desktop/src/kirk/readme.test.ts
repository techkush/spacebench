// The Kirk example in the README compiles, its checks hold and its selection sets the footprints.
import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
import { expect, it } from "vitest"
import { setLoader } from "@/lib/kicad"
import { compileKirk } from "./compile"

const KICAD = path.resolve(import.meta.dirname, "../../public/kicad")
setLoader(async (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(KICAD, `${f}.gz`))).toString()))

it("the README's Kirk example compiles", async () => {
  const readme = fs.readFileSync(path.resolve(import.meta.dirname, "../../../../README.md"), "utf8")
  const code = /```kirk\n([\s\S]*?)```/.exec(readme)?.[1]
  expect(code).toBeTruthy()
  const r = await compileKirk(code!)
  expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  expect(r.doc!.parts.filter((p) => p.ref.startsWith("R")).every((p) => p.footprint === "Resistor_SMD:R_0603_1608Metric")).toBe(true)
})
