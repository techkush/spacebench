// AI through the Claude Code CLI: `claude -p` in print mode with stream-json in and
// out, the user's own Claude Code login, and Claude Code's built-in tools switched off.
// Space Bench's tools are offered as a small tag protocol in the system prompt; the
// reply's tags become tool calls, and their results go back in the next (resumed) turn.
import { invoke, isTauri } from "@tauri-apps/api/core"

import { AiError, type Block, type Msg, type Request, type Response, type ToolDef, type Transport } from "./claude"

export const CLI_MODELS: { id: string; label: string }[] = [
  { id: "sonnet", label: "Sonnet (recommended)" },
  { id: "opus", label: "Opus (most capable)" },
  { id: "haiku", label: "Haiku (fastest)" },
]

export interface CliLine { kind: "cmd" | "system" | "assistant" | "thinking" | "result" | "error" | "raw"; text: string }

/** The parameter a tag body fills, per tool. */
const BODY_PARAM: Record<string, string> = { write_kirk: "code", measure: "expr", find_parts: "query", add_probe: "signal", remove_probe: "signal", set_meter: "signal" }

export function protocolPrompt(tools: ToolDef[]): string {
  const list = tools.map((t) => {
    const props = (t.input_schema.properties ?? {}) as Record<string, { description?: string; enum?: string[] }>
    const body = BODY_PARAM[t.name]
    const attrs = Object.entries(props).filter(([k]) => k !== body || t.name !== "write_kirk").map(([k, v]) => `${k}="${v.enum ? v.enum.join("|") : v.description ?? "…"}"`).join(" ")
    const usage = t.name === "write_kirk" ? `<tool name="write_kirk" summary="one line: what changed">\n…the complete Kirk program…\n</tool>` : `<tool name="${t.name}"${attrs ? ` ${attrs}` : ""}/>`
    return `${usage}\n  ${t.description}`
  }).join("\n")
  return `
TOOLS
Claude Code's own tools are switched off here. You act on Space Bench only through these tools, by writing tags in your reply:

${list}

Rules for tools:
- Write the tags you need (several are fine), then STOP your reply and wait. The results arrive in the next message as <tool_result name="…" ok="true|false">…</tool_result>. Never guess or invent results.
- Attribute values go in double quotes (write &quot; for a quote). Never put tool tags inside \`\`\` code fences.
- Text outside the tags is shown to the user; keep it short while working.
- When you are finished (no more tools needed), reply with the final answer and no tags.`
}

const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")

/** Split a reply into text and tool calls. Tags inside ``` fences are ignored. */
export function parseReply(text: string, nextId: () => string): Block[] {
  const blocks: Block[] = []
  const re = /<tool\s+name="([\w-]+)"((?:\s+[\w-]+="[^"]*")*)\s*(?:\/>|>([\s\S]*?)<\/tool>)/g
  let last = 0, m: RegExpExecArray | null
  const fenceOpen = (pos: number) => ((text.slice(0, pos).match(/```/g) ?? []).length % 2) === 1
  while ((m = re.exec(text))) {
    if (fenceOpen(m.index)) continue
    const before = text.slice(last, m.index).trim()
    if (before) blocks.push({ type: "text", text: before })
    const input: Record<string, unknown> = {}
    for (const a of m[2].matchAll(/([\w-]+)="([^"]*)"/g)) input[a[1]] = unescape(a[2])
    if (m[3] !== undefined && m[3].trim()) {
      const body = m[3].replace(/^\n/, "").replace(/\n\s*$/, "")
      input[BODY_PARAM[m[1]] ?? "body"] = m[1] === "write_kirk" ? body.replace(/^```\w*\n?|```\s*$/g, "") : unescape(body.trim())
    }
    blocks.push({ type: "tool_use", id: nextId(), name: m[1], input })
    last = m.index + m[0].length
  }
  const rest = text.slice(last).trim()
  if (rest) blocks.push({ type: "text", text: rest })
  return blocks
}

/** A user turn for the CLI: text and images pass through, tool results become tags. */
function toCliContent(msgs: Msg[], names: Map<string, string>): { type: string; [k: string]: unknown }[] {
  const out: { type: string; [k: string]: unknown }[] = []
  for (const m of msgs) for (const b of m.content) {
    if (b.type === "text") out.push({ type: "text", text: b.text })
    else if (b.type === "image") out.push({ type: "image", source: b.source })
    else if (b.type === "tool_result") out.push({ type: "text", text: `<tool_result name="${names.get(b.tool_use_id) ?? "tool"}" ok="${b.is_error ? "false" : "true"}">\n${b.content}\n</tool_result>` })
  }
  return out
}

/** Earlier turns as plain text (when a new CLI session starts mid-conversation). */
function transcript(msgs: Msg[]): string {
  return msgs.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.map((b) => (b.type === "text" ? b.text : b.type === "tool_use" ? `<tool name="${b.name}" …/>` : b.type === "tool_result" ? `<tool_result>${b.content.slice(0, 400)}</tool_result>` : "[image]")).join("\n")}`).join("\n\n")
}

type Runner = (args: string[], stdin: string, onLine: (line: string) => void, signal?: AbortSignal) => Promise<{ code: number | null; stderr: string }>

/** Run `claude` in the desktop app (Tauri command, lines arrive as events). */
const tauriRunner = (bin?: string): Runner => async (args, stdin, onLine, signal) => {
  const { listen } = await import("@tauri-apps/api/event")
  const run = `cc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
  const un = await listen<{ run: string; line: string }>("claude-code://line", (e) => { if (e.payload.run === run) onLine(e.payload.line) })
  const stop = () => { invoke("claude_code_cancel", { run }).catch(() => {}) }
  signal?.addEventListener("abort", stop)
  try { return await invoke<{ code: number | null; stderr: string }>("claude_code_run", { run, args, stdin, bin: bin?.trim() || null }) }
  finally { un(); signal?.removeEventListener("abort", stop) }
}

/** Run `claude` through the Vite dev server (plain browser tab during development). */
const devRunner: Runner = async (args, stdin, onLine, signal) => {
  const res = await fetch("/api/claude", { method: "POST", body: JSON.stringify({ args, stdin }), signal })
  if (!res.ok || !res.body) throw new AiError(await res.text())
  const reader = res.body.getReader(), dec = new TextDecoder()
  let buf = "", exit = { code: null as number | null, stderr: "" }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i: number
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      if (line.startsWith('{"type":"__exit"')) { const j = JSON.parse(line); exit = { code: j.code, stderr: j.stderr } } else if (line.trim()) onLine(line)
    }
  }
  return exit
}

export async function claudeCodeVersion(bin?: string): Promise<string | null> {
  try {
    if (isTauri()) return await invoke<string>("claude_code_version", { bin: bin?.trim() || null })
    if (import.meta.env.DEV) { const r = await fetch("/api/claude"); return r.ok ? await r.text() : null }
  } catch { /* not installed */ }
  return null
}

export interface CliTransport extends Transport { reset(): void }

export function claudeCodeTransport(opts: { model: string; bin?: string; onLine?: (l: CliLine) => void; runner?: Runner }): CliTransport {
  let session: string | null = null
  let sent = 0
  let seq = 0
  const names = new Map<string, string>()
  const runner = opts.runner ?? (isTauri() ? tauriRunner(opts.bin) : devRunner)
  const say = (kind: CliLine["kind"], text: string) => opts.onLine?.({ kind, text })

  const call = (async (req: Request, signal?: AbortSignal): Promise<Response> => {
    const msgs = req.messages
    let content: { type: string; [k: string]: unknown }[]
    if (session && msgs.length > sent) content = toCliContent(msgs.slice(sent), names)
    else {
      // new CLI session: earlier turns (if any) go in as a transcript
      session = null
      const prior = msgs.slice(0, -1)
      content = [...(prior.length ? [{ type: "text", text: `Earlier in this conversation:\n\n${transcript(prior)}\n\n---` }] : []), ...toCliContent(msgs.slice(-1), names)]
    }
    const system = `${req.system.map((b) => (b.type === "text" ? b.text : "")).join("\n")}\n${protocolPrompt(req.tools)}`
    const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--model", opts.model, "--system-prompt", system, ...(session ? ["--resume", session] : [])]
    say("cmd", `claude -p --model ${opts.model} --tools "" --input-format stream-json --output-format stream-json${session ? ` --resume ${session.slice(0, 8)}…` : ""}`)
    let result: { text: string; isError: boolean; session?: string; cost?: number; ms?: number } | null = null
    const exit = await runner(args, `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`, (line) => {
      let j: Record<string, unknown>
      try { j = JSON.parse(line) } catch { say("raw", line); return }
      if (j.type === "system" && j.subtype === "init") say("system", `session ${String(j.session_id).slice(0, 8)} · model ${j.model} · tools: ${(j.tools as string[]).length ? (j.tools as string[]).join(", ") : "none"}`)
      else if (j.type === "assistant") {
        for (const b of ((j.message as { content: { type: string; text?: string; thinking?: string }[] }).content ?? [])) {
          if (b.type === "text" && b.text) say("assistant", b.text)
          else if (b.type === "thinking") say("thinking", "thinking…")
        }
      } else if (j.type === "result") {
        result = { text: String(j.result ?? ""), isError: !!j.is_error || j.subtype !== "success", session: j.session_id as string, cost: j.total_cost_usd as number, ms: j.duration_ms as number }
        say(result.isError ? "error" : "result", `${result.isError ? "error" : "done"} · ${result.ms ? `${(result.ms / 1000).toFixed(1)} s` : ""}${result.cost ? ` · $${result.cost.toFixed(4)} (plan usage)` : ""}`)
      }
    }, signal)
    if (signal?.aborted) throw new DOMException("aborted", "AbortError")
    const r = result as { text: string; isError: boolean; session?: string } | null
    if (!r) {
      const hint = /log(ged)?\s?in|auth|credential|api key/i.test(exit.stderr) ? " — run `claude` once in a terminal and log in." : ""
      say("error", exit.stderr.trim() || `claude exited with code ${exit.code}`)
      throw new AiError(`Claude Code failed${exit.code !== null ? ` (exit ${exit.code})` : ""}: ${exit.stderr.split("\n").find((l) => l.trim()) ?? "no output"}${hint}`)
    }
    if (r.isError) throw new AiError(/log(ged)?\s?in|invalid api key|auth/i.test(r.text) ? `${r.text} — run \`claude\` in a terminal and log in (/login).` : `Claude Code: ${r.text || "error"}`)
    session = r.session ?? session
    const blocks = parseReply(r.text, () => `cc_${++seq}`)
    for (const b of blocks) if (b.type === "tool_use") names.set(b.id, b.name)
    sent = msgs.length + 1 // the agent appends this reply to the history
    return { content: blocks.length ? blocks : [{ type: "text", text: r.text }], stop_reason: blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn" }
  }) as CliTransport
  call.reset = () => { session = null; sent = 0; names.clear() }
  return call
}
