// Dev-only: the browser build's stand-in for the Tauri arduino_* commands (src-tauri/src/arduino.rs).
//   GET  /api/arduino         → { path, version, cores }
//   POST /api/arduino/compile { files, fqbn, libraries } → { ok, hex, stdout, stderr }
//   POST /api/arduino/core    { core } → installs a board core
import { execFile, execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Plugin } from "vite"

function findCli(): string | null {
  const dirs = [...(process.env.PATH ?? "").split(path.delimiter), "/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), "bin")]
  for (const d of dirs) { const p = path.join(d, "arduino-cli"); try { fs.accessSync(p, fs.constants.X_OK); return p } catch { /* next */ } }
  return null
}
const run = (bin: string, args: string[]) => new Promise<{ ok: boolean; stdout: string; stderr: string }>((resolve) =>
  execFile(bin, args, { maxBuffer: 64 << 20 }, (err, stdout, stderr) => resolve({ ok: !err, stdout, stderr })))

export function arduinoDev(): Plugin {
  return {
    name: "spicebench-arduino-dev",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/api/arduino", (req, res) => {
        const bin = findCli()
        const send = (code: number, body: unknown) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)) }
        if (!bin) { send(404, { error: "arduino-cli was not found. Install it (macOS: brew install arduino-cli)." }); return }
        if (req.method === "GET") {
          const version = execFileSync(bin, ["version"], { encoding: "utf8" }).trim()
          const cores = execFileSync(bin, ["core", "list"], { encoding: "utf8" }).split("\n").slice(1).map((l) => l.split(/\s+/)[0]).filter(Boolean)
          send(200, { path: bin, version, cores }); return
        }
        let body = ""
        req.on("data", (c) => (body += c))
        req.on("end", async () => {
          try {
            const j = JSON.parse(body || "{}")
            if (req.url?.startsWith("/core")) {
              const extra = j.url ? ["--additional-urls", j.url] : []
              await run(bin, ["core", "update-index", ...extra])
              const r = await run(bin, ["core", "install", j.core, ...extra])
              send(r.ok ? 200 : 500, r.ok ? { log: r.stdout } : { error: r.stderr || r.stdout }); return
            }
            const libs: string[] = j.libraries ?? []
            if (libs.length) {
              const listed = (await run(bin, ["lib", "list", "--format", "json"])).stdout
              for (const name of libs) {
                const bare = name.split("@")[0].trim()
                if (!bare || new RegExp(`"name":\\s*"${bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(listed)) continue
                const r = await run(bin, ["lib", "install", name.trim()])
                if (!r.ok) { send(500, { error: `Could not install library ${name}: ${r.stderr || r.stdout}` }); return }
              }
            }
            const root = path.join(os.tmpdir(), "spacebench-arduino", String(j.fqbn).replace(/[^a-z0-9]/gi, "_"))
            const sketch = path.join(root, "sketch"), build = path.join(root, "build"), out = path.join(root, "out")
            fs.rmSync(sketch, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true })
            fs.mkdirSync(sketch, { recursive: true })
            let main = false
            for (const f of j.files as { name: string; content: string }[]) {
              const name = path.basename(f.name)
              const target = !main && name.endsWith(".ino") ? ((main = true), "sketch.ino") : name
              fs.writeFileSync(path.join(sketch, target), f.content)
            }
            const props = ((j.props ?? []) as string[]).flatMap((p) => ["--build-property", p])
            const r = await run(bin, ["compile", "--fqbn", j.fqbn, "--build-path", build, "--output-dir", out, "--warnings", "default", ...props, sketch])
            const hexFile = path.join(out, "sketch.ino.hex")
            const hex = r.ok && fs.existsSync(hexFile) ? fs.readFileSync(hexFile, "utf8") : null
            const merged = path.join(out, "sketch.ino.merged.bin")
            const image = r.ok && fs.existsSync(merged) ? merged : null
            const binFile = path.join(out, "sketch.ino.bin")
            const binData = r.ok && !image && fs.existsSync(binFile) ? fs.readFileSync(binFile).toString("base64") : null
            const elfFile = path.join(out, "sketch.ino.elf")
            const elf = r.ok && fs.existsSync(elfFile) ? elfFile : null
            send(200, { ok: !!(hex || binData || image || elf), hex, bin: binData, image, elf, stdout: r.stdout, stderr: r.stderr, sketch_dir: sketch })
          } catch (e) { send(500, { error: String(e) }) }
        })
      })
    },
  }
}
