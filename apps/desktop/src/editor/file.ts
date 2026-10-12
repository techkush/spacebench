// Save / open circuits. Interim format until Kirk (.kirk) becomes the project
// file: JSON with a format tag and version, extension .sbc.
import { isTauri } from "@tauri-apps/api/core"
import { open, save } from "@tauri-apps/plugin-dialog"
import { readTextFile, writeFile, writeTextFile } from "@tauri-apps/plugin-fs"

import type { Doc, Part } from "./model"

const FORMAT = "spicebench.circuit"
const FILTERS = [{ name: "Space Bench circuit", extensions: ["sbc"] }]

export async function saveDoc(doc: Doc, path: string | null): Promise<string | null> {
  if (!isTauri()) {
    // browser: download the file
    const name = `${doc.title.replace(/[^\w\- ]+/g, "") || "circuit"}.sbc`
    const a = document.createElement("a")
    a.href = URL.createObjectURL(new Blob([JSON.stringify({ format: FORMAT, version: 2, doc }, null, 1)], { type: "application/json" }))
    a.download = name
    a.click()
    return null
  }
  const target = path ?? (await save({ filters: FILTERS, defaultPath: `${doc.title.replace(/[^\w\- ]+/g, "")}.sbc` }))
  if (!target) return null
  await writeTextFile(target, JSON.stringify({ format: FORMAT, version: 2, doc }, null, 1))
  return target
}

/** Parse the text of a .sbc file. */
export function parseDoc(text: string): Doc {
  let data
  try { data = JSON.parse(text) } catch { throw new Error("Not a Space Bench circuit file.") }
  if (data?.format !== FORMAT || !data.doc?.parts) throw new Error("Not a Space Bench circuit file.")
  return data.version === 1 ? fromV1(data.doc) : (data.doc as Doc)
}

/** Browser fallback for file dialogs: a hidden <input type=file>. */
function pickFile(accept: string): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input")
    input.type = "file"
    input.accept = accept
    input.onchange = async () => {
      const f = input.files?.[0]
      resolve(f ? { name: f.name, text: await f.text() } : null)
    }
    input.oncancel = () => resolve(null)
    input.click()
  })
}

/** Open a circuit. `path` is null in the browser (no file system). */
export async function openDoc(): Promise<{ doc: Doc; path: string | null; name: string } | null> {
  if (!isTauri()) {
    const f = await pickFile(".sbc,application/json")
    return f ? { doc: parseDoc(f.text), path: null, name: f.name } : null
  }
  const path = await open({ filters: FILTERS, multiple: false, directory: false })
  if (!path || Array.isArray(path)) return null
  return { doc: await readDoc(path), path, name: path.split("/").pop() ?? path }
}

export async function readDoc(path: string): Promise<Doc> {
  return parseDoc(await readTextFile(path))
}

const IMPORT_EXT = ["kirk", "kicad_sch", "cir", "sp", "spice", "net", "ckt"]
/** Pick a Kirk file, a KiCad schematic or a SPICE netlist to import. */
export async function pickImport(): Promise<{ name: string; text: string; path: string | null } | null> {
  if (!isTauri()) {
    const f = await pickFile(IMPORT_EXT.map((e) => `.${e}`).join(","))
    return f ? { ...f, path: null } : null
  }
  const path = await open({ filters: [{ name: "Kirk, KiCad schematic or SPICE netlist", extensions: IMPORT_EXT }, { name: "Kirk", extensions: ["kirk"] }, { name: "KiCad schematic", extensions: ["kicad_sch"] }, { name: "SPICE netlist", extensions: IMPORT_EXT.slice(2) }], multiple: false, directory: false })
  if (!path || Array.isArray(path)) return null
  return { name: path.split("/").pop() ?? path, text: await readTextFile(path), path }
}

/** Version 1 used built-in symbols; they share pin offsets with these KiCad symbols. */
type V1Part = { id: string; ref: string; kind: string; x: number; y: number; rot: Part["rot"]; value: number; net?: string; ac?: number
  wave?: { type: "dc"; value: number } | { type: "sin"; offset: number; amplitude: number; freq: number } | { type: "pulse"; v1: number; v2: number; delay: number; rise: number; fall: number; width: number; period: number } }

export function fromV1(doc: Omit<Doc, "parts"> & { parts: V1Part[] }): Doc {
  let pwr = 0
  const parts: Part[] = doc.parts.map((p) => {
    const base = { id: p.id, ref: p.ref, x: p.x, y: p.y, rot: p.rot, unit: 1 }
    const ac = p.ac ? ` ac=${p.ac}` : ""
    switch (p.kind) {
      case "R": return { ...base, lib: "Device:R", value: String(p.value) }
      case "C": return { ...base, lib: "Device:C", value: String(p.value) }
      case "L": return { ...base, lib: "Device:L", value: String(p.value) }
      case "D": return { ...base, lib: "Device:D", value: "D" }
      case "LED": return { ...base, lib: "Device:LED", value: "Red" }
      case "GND": return { ...base, ref: `#PWR${String(++pwr).padStart(2, "0")}`, lib: "power:GND", value: "GND" }
      case "LABEL": return { ...base, lib: "@:label", value: "net", net: p.net }
      default: {
        const w = p.wave
        if (w?.type === "sin") return { ...base, lib: "Simulation_SPICE:VSIN", value: "VSIN", sim: { Params: `dc=${w.offset} ampl=${w.amplitude} f=${w.freq}${ac}` } }
        if (w?.type === "pulse") return { ...base, lib: "Simulation_SPICE:VPULSE", value: "VPULSE", sim: { Params: `y1=${w.v1} y2=${w.v2} td=${w.delay} tr=${w.rise} tf=${w.fall} tw=${w.width} per=${w.period}${ac}` } }
        return { ...base, lib: "Simulation_SPICE:VDC", value: String(w?.value ?? p.value), ...(ac ? { sim: { Params: ac.trim() } } : {}) }
      }
    }
  })
  return { ...doc, parts }
}

/** Save rows as CSV (desktop: save dialog; browser: download). */
export async function exportCsv(name: string, header: string[], rows: number[][]): Promise<string | null> {
  const text = [header.join(","), ...rows.map((r) => r.map((v) => (Number.isFinite(v) ? v.toPrecision(9) : "")).join(","))].join("\n")
  const file = `${name.replace(/[^\w\- ]+/g, "")}.csv`
  if (!isTauri()) {
    const a = document.createElement("a")
    a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }))
    a.download = file
    a.click()
    return file
  }
  const target = await save({ filters: [{ name: "CSV", extensions: ["csv"] }], defaultPath: file })
  if (!target) return null
  await writeTextFile(target, text)
  return target
}

/** Write an export (text or binary). `direct`: write to `name` as a path without asking. Returns the path. */
export async function saveExport(name: string, ext: string, data: string | Uint8Array, direct = false): Promise<string | null> {
  if (!isTauri()) {
    const a = document.createElement("a")
    a.href = URL.createObjectURL(new Blob([data as BlobPart], { type: typeof data === "string" ? "text/plain" : "application/octet-stream" }))
    a.download = name.split("/").pop() ?? name
    a.click()
    return a.download
  }
  const target = direct ? name : await save({ filters: [{ name: ext.toUpperCase(), extensions: [ext] }], defaultPath: name })
  if (!target) return null
  if (typeof data === "string") await writeTextFile(target, data)
  else await writeFile(target, data)
  return target
}
