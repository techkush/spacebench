// The circuit assistant's firmware tools reach the app's FirmwareHost: a scripted model reads the
// sketch, rewrites it, compiles, runs, checks the setup and asks to install — each answered by the host.
import { describe, expect, it, vi } from "vitest"
import { runAgent, type AgentEvent, type AgentHost, type FirmwareHost } from "./agent"
import type { Block, Msg, Transport } from "./claude"

const calls: [string, Record<string, unknown>][] = [
  ["get_firmware", {}],
  ["write_firmware", { ref: "A1", name: "sketch.ino", content: "void setup(){} void loop(){}" }],
  ["compile_firmware", { ref: "A1" }],
  ["run_with_firmware", { seconds: 2 }],
  ["check_setup", {}],
  ["install", { item: "core:arduino:avr", reason: "the Uno needs its core" }],
]

describe("circuit assistant: firmware tools", () => {
  it("routes each firmware tool to the host and reports failures as errors", async () => {
    const fw: FirmwareHost = {
      read: vi.fn(() => "## A1: Arduino Uno\n--- sketch.ino\nvoid setup(){"),
      write: vi.fn(() => "Wrote A1/sketch.ino (1 lines)"),
      compile: vi.fn(async () => ({ ok: true, text: "Compiled — 444 of 32256 bytes of flash" })),
      run: vi.fn(async () => ({ ok: true, text: "Ran 2.00 s\nSerial output:\nhello" })),
      checkSetup: vi.fn(async () => "MISSING core:arduino:avr — arduino:avr board core: not installed"),
      install: vi.fn(async () => ({ ok: false, text: "The user didn't allow the install." })),
    }
    const host = { firmware: fw } as unknown as AgentHost
    let turn = 0
    // the "model": one tool per turn, then a final answer
    const transport: Transport = async () => {
      const c = calls[turn++]
      if (!c) return { content: [{ type: "text", text: "Fixed." }], stop_reason: "end_turn" } as never
      return { content: [{ type: "tool_use", id: `t${turn}`, name: c[0], input: c[1] }], stop_reason: "tool_use" } as never
    }
    const events: AgentEvent[] = []
    const history: Msg[] = await runAgent({ transport, model: "m", history: [{ role: "user", content: [{ type: "text", text: "fix it" }] as Block[] }], host, onEvent: (e) => events.push(e) })
    expect(fw.read).toHaveBeenCalled()
    expect(fw.write).toHaveBeenCalledWith("A1", "sketch.ino", "void setup(){} void loop(){}")
    expect(fw.compile).toHaveBeenCalledWith("A1")
    expect(fw.run).toHaveBeenCalledWith(2)
    expect(fw.install).toHaveBeenCalledWith("core:arduino:avr", "the Uno needs its core")
    // the declined install comes back to the model as an error result
    const done = events.filter((e) => e.kind === "tool" && e.status !== "running") as Extract<AgentEvent, { kind: "tool" }>[]
    expect(done.find((e) => e.name === "install")?.status).toBe("error")
    expect(done.find((e) => e.name === "compile_firmware")?.status).toBe("ok")
    expect(history.length).toBeGreaterThan(calls.length)
  })

  it("without boards the tools say so instead of failing", async () => {
    let turn = 0
    const transport: Transport = async () => (turn++ === 0
      ? { content: [{ type: "tool_use", id: "t", name: "get_firmware", input: {} }], stop_reason: "tool_use" }
      : { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }) as never
    const events: AgentEvent[] = []
    await runAgent({ transport, model: "m", history: [{ role: "user", content: [{ type: "text", text: "x" }] as Block[] }], host: {} as AgentHost, onEvent: (e) => events.push(e) })
    const t = events.find((e) => e.kind === "tool" && e.status === "error") as Extract<AgentEvent, { kind: "tool" }>
    expect(t?.summary).toMatch(/aren't available/)
  })
})
