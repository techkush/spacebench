import { describe, expect, it } from "vitest"

import { TOOLS } from "./agent"
import type { Msg, Request } from "./claude"
import { claudeCodeTransport, parseReply, protocolPrompt, type CliLine } from "./claudecode"

let n = 0
const id = () => `t${++n}`

describe("tag protocol", () => {
  it("lists every tool with a usage line", () => {
    const p = protocolPrompt(TOOLS)
    for (const t of TOOLS) expect(p).toContain(`<tool name="${t.name}"`)
    expect(p).toMatch(/write_kirk" summary=.*>\n…the complete Kirk program…\n<\/tool>/)
  })
  it("parses text, self-closing tags, bodies and escapes", () => {
    const code = "circuit Rc {\n  ground GND\n  R1 = R(1k)\n}\nsimulate ac(from: 10 Hz, to: 100 kHz)"
    const b = parseReply(`I'll build it.\n<tool name="write_kirk" summary="RC &quot;low&quot;-pass">\n${code}\n</tool>\n<tool name="simulate" analysis="ac"/>\n<tool name="measure">fc(V(OUT))</tool> <tool name="add_probe" signal="V(OUT)" />`, id)
    expect(b.map((x) => x.type)).toEqual(["text", "tool_use", "tool_use", "tool_use", "tool_use"])
    expect(b[1]).toMatchObject({ name: "write_kirk", input: { summary: 'RC "low"-pass', code } })
    expect(b[2]).toMatchObject({ name: "simulate", input: { analysis: "ac" } })
    expect(b[3]).toMatchObject({ name: "measure", input: { expr: "fc(V(OUT))" } })
    expect(b[4]).toMatchObject({ name: "add_probe", input: { signal: "V(OUT)" } })
  })
  it("ignores tags inside code fences and strips a fenced Kirk body", () => {
    const b = parseReply('Example:\n```\n<tool name="simulate" analysis="tran"/>\n```\n<tool name="write_kirk" summary="x">\n```kirk\ncircuit A {}\n```\n</tool>', id)
    expect(b.filter((x) => x.type === "tool_use")).toHaveLength(1)
    expect(b.find((x) => x.type === "tool_use")).toMatchObject({ name: "write_kirk", input: { code: "circuit A {}\n" } })
  })
  it("plain answers have no tool calls", () => {
    expect(parseReply("fc is 995 Hz.", id)).toEqual([{ type: "text", text: "fc is 995 Hz." }])
  })
})

/** A fake `claude`: records each call and answers with a scripted reply as stream-json. */
function fakeCli(replies: (string | { error: string } | { crash: string })[]) {
  const calls: { args: string[]; content: { type: string; text?: string }[] }[] = []
  const runner = async (args: string[], stdin: string, onLine: (l: string) => void) => {
    calls.push({ args, content: JSON.parse(stdin).message.content })
    const r = replies[calls.length - 1]
    if (typeof r === "object" && "crash" in r) return { code: 1, stderr: r.crash }
    onLine(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-123456789", model: "claude-sonnet", tools: [] }))
    if (typeof r === "string") onLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: r }] } }))
    onLine("not json")
    onLine(JSON.stringify(typeof r === "string" ? { type: "result", subtype: "success", is_error: false, result: r, session_id: "sess-123456789", total_cost_usd: 0.01, duration_ms: 1200 } : { type: "result", subtype: "success", is_error: true, result: r.error, session_id: "sess-123456789" }))
    return { code: 0, stderr: "" }
  }
  return { runner, calls }
}

const req = (messages: Msg[]): Request => ({ model: "sonnet", max_tokens: 1000, system: [{ type: "text", text: "You are Space Bench's assistant." }], tools: TOOLS, messages })

describe("Claude Code transport", () => {
  it("turns tags into tool calls, resumes the session and sends only new messages", async () => {
    const lines: CliLine[] = []
    const { runner, calls } = fakeCli(['Building.\n<tool name="simulate" analysis="ac"/>', "Done: fc ≈ 995 Hz."])
    const t = claudeCodeTransport({ model: "sonnet", runner, onLine: (l) => lines.push(l) })
    const history: Msg[] = [{ role: "user", content: [{ type: "text", text: "Make an RC filter" }] }]
    const r1 = await t(req(history))
    expect(r1.stop_reason).toBe("tool_use")
    const use = r1.content.find((b) => b.type === "tool_use")!
    expect(use).toMatchObject({ name: "simulate", input: { analysis: "ac" } })
    // first call: no --resume, tools off, system prompt carries the protocol
    expect(calls[0].args).not.toContain("--resume")
    expect(calls[0].args.slice(calls[0].args.indexOf("--tools"), calls[0].args.indexOf("--tools") + 2)).toEqual(["--tools", ""])
    expect(calls[0].args[calls[0].args.indexOf("--system-prompt") + 1]).toMatch(/You are Space Bench's assistant[\s\S]*<tool name="write_kirk"/)
    expect(calls[0].content).toEqual([{ type: "text", text: "Make an RC filter" }])

    history.push({ role: "assistant", content: r1.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: use.type === "tool_use" ? use.id : "", content: "AC sweep 10 Hz → 100 kHz" }] })
    const r2 = await t(req(history))
    expect(r2).toEqual({ stop_reason: "end_turn", content: [{ type: "text", text: "Done: fc ≈ 995 Hz." }] })
    // second call resumes and carries only the tool result, as a tag
    expect(calls[1].args.slice(-2)).toEqual(["--resume", "sess-123456789"])
    expect(calls[1].content).toHaveLength(1)
    expect(calls[1].content[0].text).toBe('<tool_result name="simulate" ok="true">\nAC sweep 10 Hz → 100 kHz\n</tool_result>')
    // terminal lines: command, session, reply, raw line, result
    expect(lines.map((l) => l.kind)).toEqual(["cmd", "system", "assistant", "raw", "result", "cmd", "system", "assistant", "raw", "result"])
    expect(lines[4].text).toMatch(/done · 1\.2 s · \$0\.0100/)
  })
  it("after reset, starts a new session with a transcript of earlier turns", async () => {
    const { runner, calls } = fakeCli(["Hi.", "Sure."])
    const t = claudeCodeTransport({ model: "haiku", runner })
    const h: Msg[] = [{ role: "user", content: [{ type: "text", text: "hello" }] }]
    const r = await t(req(h))
    t.reset()
    h.push({ role: "assistant", content: r.content }, { role: "user", content: [{ type: "text", text: "add a probe" }] })
    await t(req(h))
    expect(calls[1].args).not.toContain("--resume")
    expect(calls[1].content[0].text).toMatch(/^Earlier in this conversation:\n\nUser: hello\n\nAssistant: Hi\./)
    expect(calls[1].content[1]).toEqual({ type: "text", text: "add a probe" })
  })
  it("reports login problems and crashes with a hint", async () => {
    const lines: CliLine[] = []
    const { runner } = fakeCli([{ error: "Invalid API key · Please run /login" }, { crash: "Error: not logged in\nmore" }])
    const t = claudeCodeTransport({ model: "sonnet", runner, onLine: (l) => lines.push(l) })
    const m: Msg[] = [{ role: "user", content: [{ type: "text", text: "x" }] }]
    await expect(t(req(m))).rejects.toThrow(/log in \(\/login\)/)
    await expect(t(req(m))).rejects.toThrow(/Claude Code failed \(exit 1\): Error: not logged in — run `claude` once/)
    expect(lines.filter((l) => l.kind === "error")).toHaveLength(2)
  })
})
