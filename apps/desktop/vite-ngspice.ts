// Dev-only: POST /api/ngspice runs a netlist on the local ngspice and returns
// the same JSON as the Tauri `ngspice_run` command (src-tauri/src/ngspice.rs),
// so the full UI — Simulate, scope, sweeps — works in a plain browser tab.
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Plugin } from "vite"

const BIN = [process.env.SPICEBENCH_NGSPICE, "/opt/homebrew/bin/ngspice", "/usr/local/bin/ngspice", "/usr/bin/ngspice"].find((p) => p && fs.existsSync(p))

function signalName(raw: string): string | null {
  const l = raw.toLowerCase()
  let m = /^v\((.*)\)$/.exec(l)
  if (m) return m[1].includes(".") || m[1].includes("#") ? null : `V(${raw.slice(2, -1)})`
  m = /^i\((.*)\)$/.exec(l)
  if (m) {
    const inner = m[1]
    if (inner.startsWith("@")) {
      const mm = /^@([^[]+)\[([^\]]+)\]$/.exec(inner)
      if (!mm || mm[1].includes(".")) return null
      const name = mm[1].toUpperCase(), p = mm[2]
      return p === "i" || (p === "id" && name.startsWith("D")) ? `I(${name})` : `I${p.replace(/^i/, "")}(${name})`
    }
    return inner.includes(".") ? null : `I(${inner.toUpperCase()})`
  }
  if (l.endsWith("#branch")) { const n = l.slice(0, -7); return n.includes(".") ? null : `I(${n.toUpperCase()})` }
  if (!/[(.#@]/.test(l)) return `V(${raw})`
  return null
}

function parseRaw(text: string) {
  const lines = text.split("\n")
  let i = 0, plot = "", complex = false, nv = 0
  const vars: string[] = []
  for (; i < lines.length; i++) {
    const L = lines[i]
    if (L.startsWith("Plotname:")) plot = L.slice(9).trim()
    else if (L.startsWith("Flags:")) complex = L.includes("complex")
    else if (L.startsWith("No. Variables:")) nv = Number(L.split(":")[1])
    else if (L.startsWith("Variables:")) { for (let k = 0; k < nv; k++) vars.push(lines[++i].trim().split(/\s+/)[1]) }
    else if (L.startsWith("Values:")) { i++; break }
  }
  const re: number[][] = vars.map(() => []), im: number[][] = vars.map(() => [])
  let k = 0
  for (; i < lines.length; i++) {
    const t = lines[i].trim()
    if (!t) continue
    const parts = t.split(/\s+/)
    const tok = k % nv === 0 ? parts[1] : parts[0]
    const v = k % nv
    if (complex) { const [a, b] = tok.split(","); re[v].push(parseFloat(a)); im[v].push(parseFloat(b)) } else re[v].push(parseFloat(tok))
    k++
  }
  const kept = vars.map((v, idx) => [idx, signalName(v)] as const).filter(([idx, n]) => idx > 0 && n) as [number, string][]
  const lp = plot.toLowerCase()
  if (lp.includes("transient")) return { type: "tran", time: re[0], names: kept.map((x) => x[1]), data: kept.map(([j]) => re[j]), steps_accepted: re[0].length, steps_rejected: 0 }
  if (lp.includes("ac analysis")) return { type: "ac", freq: re[0], names: kept.map((x) => x[1]), re: kept.map(([j]) => re[j]), im: kept.map(([j]) => im[j]) }
  if (lp.includes("operating point")) {
    const all = vars.map((v, idx) => [idx, signalName(v)] as const).filter(([, n]) => n) as [number, string][]
    return { type: "op", names: all.map((x) => x[1]), values: all.map(([j]) => re[j][0]), iterations: 0, method: "ngspice" }
  }
  if (lp.includes("dc transfer")) return { type: "dc", sweep: re[0], sweep_name: vars[0], names: kept.map((x) => x[1]), data: kept.map(([j]) => re[j]) }
  throw new Error(`unsupported plot “${plot}”`)
}

/** Run a netlist (also used by tests). */
export function run(netlist: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    if (!BIN) return resolve({ status: 500, body: "ngspice not found" })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbdev-"))
    const raw = path.join(dir, "out.raw")
    fs.writeFileSync(path.join(dir, "c.cir"), `${netlist.trimEnd()}\n.control\nset filetype=ascii\nset noaskquit\nrun\nwrite ${raw}\nquit\n.endc\n.end\n`)
    const t0 = Date.now()
    const p = spawn(BIN, ["-b", path.join(dir, "c.cir")], { cwd: dir })
    let log = ""
    p.stdout.on("data", (d) => (log += d)); p.stderr.on("data", (d) => (log += d))
    const timer = setTimeout(() => p.kill(), 120_000)
    p.on("close", () => {
      clearTimeout(timer)
      const messages = log.split("\n").map((l) => l.trim()).filter((l) => l && /error|warning|singular|Timestep too small/i.test(l)).slice(0, 30)
      try {
        const out = { ...parseRaw(fs.readFileSync(raw, "utf8")), log: messages, elapsed_ms: Date.now() - t0 }
        resolve({ status: 200, body: JSON.stringify(out) })
      } catch (e) {
        resolve({ status: 500, body: messages.join("\n") || String(e) })
      } finally { fs.rmSync(dir, { recursive: true, force: true }) }
    })
  })
}

export function ngspiceDev(): Plugin {
  return {
    name: "spicebench-ngspice-dev",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/api/ngspice", (req, res) => {
        if (req.method === "GET") { res.end(BIN ? "ngspice (dev server)" : ""); return }
        let body = ""
        req.on("data", (c) => (body += c))
        req.on("end", async () => {
          const r = await run(body)
          res.statusCode = r.status
          res.setHeader("content-type", r.status === 200 ? "application/json" : "text/plain")
          res.end(r.body)
        })
      })
    },
  }
}
