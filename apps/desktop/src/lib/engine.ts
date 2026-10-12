// Simulation bridge: the netlist runs on ngspice inside the Tauri process
// (src-tauri/src/ngspice.rs). Result signal names are mapped back from SPICE
// node / element names to schematic nets and references: V(out), I(R1), Ic(Q1).
import { invoke, isTauri } from "@tauri-apps/api/core"

import type { SpiceNetlist } from "@/lib/spice"

export interface OpResult { type: "op"; names: string[]; values: number[]; iterations: number; method: string }
export interface TranResult { type: "tran"; time: number[]; names: string[]; data: number[][]; steps_accepted: number; steps_rejected: number }
export interface AcResult { type: "ac"; freq: number[]; names: string[]; re: number[][]; im: number[][] }
export interface DcResult { type: "dc"; sweep: number[]; sweep_name: string; names: string[]; data: number[][] }
export type JobResult = (OpResult | TranResult | AcResult | DcResult) & { log?: string[]; elapsed_ms?: number }

export class EngineError extends Error {}

/** In `vite dev` without Tauri, the dev server runs ngspice (vite-ngspice.ts). */
const devServer = !isTauri() && import.meta.env.DEV

/** Settings → Simulation engine: a custom ngspice executable and convergence auto-recovery. */
/** "library": libngspice in the app (fast, live, can be stopped mid-run); "program": `ngspice -b`
 *  per run; "auto": the library when it loads, else the program — batches (sweeps, Monte Carlo)
 *  use the program in auto so they keep running in parallel. */
export type EngineKind = "auto" | "library" | "program"
let engineOpts: { bin?: string; autoRecover?: boolean; engine?: EngineKind } = {}
export function setEngineOptions(o: typeof engineOpts) { engineOpts = o }
const binArg = (bin = engineOpts.bin) => (bin?.trim() ? bin.trim() : null)

export async function ngspiceVersion(bin?: string): Promise<string | null> {
  if (devServer) { try { const t = await (await fetch("/api/ngspice")).text(); return t || null } catch { return null } }
  if (!isTauri()) return null
  try { return await invoke<string>("ngspice_version", { bin: binArg(bin) }) } catch { return null }
}

/** The ngspice executable in use (desktop app), or null when none is found. */
export async function ngspicePath(bin?: string): Promise<string | null> {
  if (devServer) return "dev server (vite-ngspice)"
  if (!isTauri()) return null
  try { return await invoke<string | null>("ngspice_path", { bin: binArg(bin) }) } catch { return null }
}

/** Map "V(node)" / "I(ELEM)" / "Ic(ELEM)" to schematic names; drop internals. */
function rename(names: string[], net: SpiceNetlist): (string | null)[] {
  return names.map((n) => {
    const m = /^(V|I[a-z]*)\((.*)\)$/.exec(n)
    if (!m) return null
    if (m[1] === "V") {
      const k = m[2].toLowerCase()
      if (k.startsWith("nc_")) return null
      const netName = net.nodes.get(k)
      return netName ? `V(${netName})` : null
    }
    const ref = net.elements.get(m[2].toUpperCase())
    return ref ? `${m[1]}(${ref})` : null
  })
}

/** Raw ngspice names → schematic names (exported for tests). */
export function remap<T extends JobResult>(r: T, net: SpiceNetlist): T {
  const mapped = rename(r.names, net)
  const keep = mapped.map((n, i) => (n ? i : -1)).filter((i) => i >= 0)
  const pick = <A,>(arr: A[]) => keep.map((i) => arr[i])
  const names = keep.map((i) => mapped[i]!)
  if (r.type === "op") return { ...r, names, values: pick(r.values) }
  if (r.type === "tran" || r.type === "dc") return { ...r, names, data: pick(r.data) }
  return { ...r, names, re: pick(r.re), im: pick(r.im) }
}

const CONVERGENCE = /singular|timestep too small|no convergence|iteration limit|gmin stepping failed|source stepping failed/i

/**
 * Run a netlist. With auto-recovery on, a convergence failure is retried once with
 * Gear integration, more iterations and gmin / source stepping.
 */
export interface SimOptions {
  /** a Live re-run: a newer Live run halts it */
  live?: boolean
  /** one of many runs (sweep, Monte Carlo) */
  batch?: boolean
  /** names the run for progress events and haltRun() */
  run?: string
  /** 0…1 (null when unknown) while the library simulates */
  onProgress?: (fraction: number | null, text: string) => void
}

export async function simulate(net: SpiceNetlist, o: SimOptions = {}): Promise<JobResult> {
  try {
    return await simulateOnce(net, o)
  } catch (e) {
    if (!engineOpts.autoRecover || !CONVERGENCE.test(String(e instanceof Error ? e.message : e))) throw e
    const lines = net.text.split("\n")
    lines.splice(lines.length - 1, 0, ".options method=gear itl1=500 itl4=100 gminsteps=20 srcsteps=20")
    const r = await simulateOnce({ ...net, text: lines.join("\n") }, o)
    return { ...r, log: [...(r.log ?? []), "auto-recovered: retried with Gear integration and gmin/source stepping"] }
  }
}

let seq = 0
async function simulateOnce(net: SpiceNetlist, o: SimOptions = {}): Promise<JobResult> {
  if (devServer) {
    const res = await fetch("/api/ngspice", { method: "POST", body: net.text })
    if (!res.ok) throw new EngineError(await res.text())
    return remap((await res.json()) as JobResult, net)
  }
  if (!isTauri()) {
    throw new EngineError("Simulation runs in the desktop app (ngspice). Start it with `pnpm dev` from the repository root.")
  }
  const run = o.run ?? `r${++seq}`
  const kind = engineOpts.engine ?? "auto"
  const engine = o.batch && kind === "auto" ? "program" : kind
  let unlisten: (() => void) | undefined
  if (o.onProgress) {
    const { listen } = await import("@tauri-apps/api/event")
    const cb = o.onProgress
    unlisten = await listen<{ run: string; fraction: number | null; text: string }>("ngspice://progress", (e) => { if (e.payload.run === run) cb(e.payload.fraction, e.payload.text) })
  }
  try {
    const out = await invoke<string>("ngspice_run", { netlist: net.text, bin: binArg(), engine, run, live: !!o.live })
    return remap(JSON.parse(out) as JobResult, net)
  } catch (e) {
    if (e instanceof EngineError) throw e
    throw new EngineError(String(e))
  } finally { unlisten?.() }
}

/** Stop a library run now (Stop button). Program runs just finish and are ignored. */
export async function haltRun(run: string): Promise<boolean> {
  if (!isTauri()) return false
  try { return await invoke<boolean>("ngspice_halt", { run, bin: binArg() }) } catch { return false }
}

/** The libngspice the app would load, or null (Settings). */
export async function ngspiceLibPath(bin?: string): Promise<string | null> {
  if (!isTauri()) return null
  try { return await invoke<string>("ngspice_lib_path", { bin: binArg(bin) }) } catch { return null }
}

/** Value of each signal at the end of a result (OP value or last transient point). */
export function finalValues(r: JobResult | null): Record<string, number> {
  if (!r) return {}
  if (r.type === "op") return Object.fromEntries(r.names.map((n, i) => [n, r.values[i]]))
  if (r.type === "tran" || r.type === "dc") return Object.fromEntries(r.names.map((n, i) => [n, r.data[i][r.data[i].length - 1]]))
  return {}
}
