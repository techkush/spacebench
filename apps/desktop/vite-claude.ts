// Dev-only: POST /api/claude runs the Claude Code CLI (the user's own `claude` login) and
// streams its stdout lines back, like the Tauri `claude_code_run` command (src-tauri/src/claude_code.rs).
// GET /api/claude returns `claude --version`. Closing the request kills the process.
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Plugin } from "vite"

function findClaude(): string | null {
  const home = os.homedir()
  const dirs = [...(process.env.PATH ?? "").split(path.delimiter), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", path.join(home, ".claude/local"), path.join(home, ".local/bin"), path.join(home, ".npm-global/bin")]
  // executable files only: a stale npm install can leave a link to a non-executable stub
  const ok = (p: string) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile() } catch { return false } }
  for (const d of dirs) { const p = path.join(d, "claude"); if (d && ok(p)) return p }
  try { const p = execFileSync(process.env.SHELL ?? "/bin/zsh", ["-lc", "command -v claude"], { encoding: "utf8" }).trim(); return p && ok(p) ? p : null } catch { return null }
}

export function claudeDev(): Plugin {
  return {
    name: "spicebench-claude-dev",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/api/claude", (req, res) => {
        const bin = findClaude()
        if (req.method === "GET") {
          if (!bin) { res.statusCode = 404; res.end("Claude Code (the `claude` command) was not found"); return }
          try { res.end(`${execFileSync(bin, ["--version"], { encoding: "utf8" }).trim()} · ${bin}`) } catch (e) { res.statusCode = 500; res.end(String(e)) }
          return
        }
        let body = ""
        req.on("data", (c) => (body += c))
        req.on("end", () => {
          if (!bin) { res.statusCode = 404; res.end("Claude Code (the `claude` command) was not found"); return }
          const { args, stdin } = JSON.parse(body) as { args: string[]; stdin: string }
          const dir = path.join(os.tmpdir(), "spacebench-claude")
          fs.mkdirSync(dir, { recursive: true })
          const p = spawn(bin, args, { cwd: dir })
          res.setHeader("content-type", "application/x-ndjson")
          let stderr = ""
          p.stdout.on("data", (d) => res.write(d))
          p.stderr.on("data", (d) => (stderr += d))
          p.on("close", (code) => { res.end(`\n${JSON.stringify({ type: "__exit", code, stderr: stderr.slice(0, 4000) })}\n`) })
          res.on("close", () => { if (p.exitCode === null) p.kill() })
          p.stdin.end(stdin)
        })
      })
    },
  }
}
