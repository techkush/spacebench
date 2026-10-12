// The circuit-design agent: Claude with tools that drive Space Bench — read the
// circuit, write Kirk (the schematic redraws), simulate, measure, find parts and
// connect probes. It loops until the model stops asking for tools.
import { CHEAT_SHEET, SNIPPETS } from "@/kirk/snippets"
import type { Block, Msg, ToolDef, Transport } from "./claude"

export interface CircuitInfo { kirk: string; issues: string[]; nets: string[]; probes: string[]; analysis: string; title: string }
export interface WriteResult { ok: boolean; errors: string[]; warnings: string[]; parts: number; nets: string[] }

/** What the app gives the agent. */
export interface AgentHost {
  getCircuit(): CircuitInfo
  writeKirk(code: string): Promise<WriteResult>
  simulate(analysis: "tran" | "ac" | "op" | "dc", opts: Record<string, number | string | undefined>): Promise<string>
  measure(expr: string): Promise<string>
  addProbe(signal: string): string
  removeProbe(signal: string): string
  setMeter(signal: string): string
  findParts(query: string): Promise<string>
  /** feed data to an input (Kirk stimulus line); empty expr removes the feed */
  setStimulus(target: string, expr: string): string
  /** move a live control: pot / slider / knob position, switch or button state */
  setInput(part: string, value: string): string
  /** the boards in the schematic that run a sketch (Arduino, Pico …): their firmware, and the tools it needs */
  firmware?: FirmwareHost
}

export interface FirmwareHost {
  /** the boards, their sketches, the last compile / run */
  read(ref?: string): string
  /** create or replace a file of a board's sketch (sketch.ino, .h / .cpp, libraries.txt) */
  write(ref: string, name: string, content: string): string
  compile(ref: string): Promise<{ ok: boolean; text: string }>
  /** run the circuit with the firmware for `seconds`: Serial output, errors */
  run(seconds: number): Promise<{ ok: boolean; text: string }>
  /** what the boards need on this computer, and what is missing */
  checkSetup(): Promise<string>
  /** install an item check_setup lists — the user is asked first */
  install(item: string, reason: string): Promise<{ ok: boolean; text: string }>
}

export type AgentEvent =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; input: Record<string, unknown>; status: "running" | "ok" | "error"; summary?: string }

const OPAMP = `circuit Inverting {
    ground GND
    supply VP = 12 V
    supply VN = -12 V
    V1 = Vsin(amp: 100 mV, freq: 1 kHz)
    R1 = R(10k)
    R2 = R(100k)
    U1 = OpAmp(gbw: 10 MHz)
    IN -- V1 -- GND
    IN -- R1 -- INV -- R2 -- OUT
    U1.1 -- GND      // + input
    U1.2 -- INV      // − input
    U1.3 -- VP       // V+
    U1.4 -- VN       // V−
    U1.5 -- OUT      // output
}
simulate tran(stop: 3 ms, step: 5 us)
measure gain = pp(V(OUT)) / pp(V(IN))`

const NPN = `circuit CommonEmitter {
    ground GND
    supply VCC = 12 V
    V1 = Vsin(amp: 10 mV, freq: 1 kHz)
    C1 = C(10u)
    R1 = R(47k)
    R2 = R(10k)
    RC = R(4.7k)
    RE = R(1k)
    Q1 = NPN("2N3904")
    IN -- V1 -- GND
    IN -- C1 -- B
    VCC -- R1 -- B -- R2 -- GND
    VCC -- RC -- C
    E -- RE -- GND
    Q1.C -- C
    Q1.B -- B
    Q1.E -- E
}
simulate tran(stop: 5 ms, step: 10 us)`

/** Example programs the system prompt teaches with (all verified to compile — see agent.test.ts). */
export const PROMPT_EXAMPLES: { title: string; code: string }[] = [
  ...SNIPPETS.filter((s) => ["divider", "rc", "blinker"].includes(s.id)).map((s) => ({ title: s.title, code: s.code.trim() })),
  { title: "Op-amp (generic OpAmp: pins are numbered)", code: OPAMP },
  { title: "BJT amplifier (pins by name C / B / E)", code: NPN },
]

export function systemPrompt(): string {
  return `You are the circuit-design assistant inside Space Bench, a schematic + simulation app (ngspice engine, KiCad parts).
You design, explain, fix and simulate electronic circuits by writing Kirk — Space Bench's circuit language — through tools.
The schematic is drawn automatically from the Kirk code, so writing Kirk IS drawing the circuit.

How to work:
- Use get_circuit to see the user's current circuit before changing it.
- Write a COMPLETE Kirk program with write_kirk (it replaces the current one). If it reports errors, fix them and write again.
- Keep part references (R1, C1, U1…) stable when editing an existing circuit, so its drawing is preserved.
- After writing, run simulate to check the design, then read the numbers. If they miss the user's target, adjust values and repeat (at most a few iterations).
- Connect probes when the user asks to see/measure something: add_probe("V(OUT)") for a node voltage, add_probe("I(R1)") for a part current (Ic(Q1) for a BJT collector, Id(M1) for a MOSFET). Probes show on the oscilloscope / Bode plotter.
- When the user sends an image of a schematic or a hand drawing: identify every part with its value and every connection, then transcribe it into Kirk with write_kirk. Name nets after labels in the image when there are any. Say what you could not read.
- Pick realistic standard values (E12/E24 resistors, standard capacitors). Explain the key equations briefly (e.g. fc = 1/(2πRC)).
- Answer concisely. Report simulation results with numbers and units. Don't repeat the whole program in the chat — it is in the editor.

Boards and firmware (circuit + sketch together):
- An Arduino UNO / Nano / Mega, a Raspberry Pi Pico, an ESP32 … placed in the schematic runs its sketch: its pins drive the circuit, and it reads the circuit's voltages.
- get_firmware shows each board's sketch and its last compile / run; write_firmware changes a file (sketch.ino, libraries.txt with one Arduino library per line, extra .h / .cpp); compile_firmware compiles; run_with_firmware runs the circuit and the sketch together and returns the Serial output.

Fixing problems — when the user reports an error or asks you to fix something, find the cause and fix it, don't only explain:
- A sketch that doesn't compile: read the errors (get_firmware), fix the code or libraries.txt, compile again until it compiles, then run_with_firmware and check the Serial output.
- A simulation that fails (singular matrix, timestep too small, a node with no DC path, a part without a model): get_circuit, fix the circuit (a resistor to ground for a floating node, a realistic value, a missing ground), simulate again.
- A missing tool ("not installed", "not found", "core is not installed"): check_setup, then install what it lists (the user is asked to allow it; say why), then compile / run again.
- "Failed to fetch", "Load failed", a refused connection: the simulator or the compiler service of Space Bench isn't reachable (the app's backend or the dev server stopped). Tools can't fix that — tell the user to restart Space Bench, and continue once it is back.
- Finish by showing it works: the numbers from simulate, or the Serial output from run_with_firmware.

Kirk essentials:
${CHEAT_SHEET.map(([c, w]) => `- ${c}  — ${w}`).join("\n")}
- Units: k, M (mega), m (milli), u, n, p; "1.6k", "100n", "5 V", "1 kHz", "10 ms" are all fine. Comments start with //.
- Two-pin parts in a chain: pin 1 on the left. Turn a part round with ' (D1' puts the anode on the left net).
- Named pins: U1.TRIG, Q1.C … ; numbered pins: U1.5. Leave an unused pin open with "U1.CONT -- nc".
- Constructors: R C L Pot D LED(red|green|blue|yellow) Zener Schottky NPN("2N3904") PNP("2N3906") NMOS("2N7000") PMOS NJFET PJFET
  Vdc(5 V) Vsin(amp:, freq:, offset:, ac:) Vpulse(low:, high:, period:, width:, rise:) Vpwl("0 0 1m 5") Idc Isin Ipulse
  OpAmp(gbw:, gain:) NE555 LM358 TL072 L7805 Switch(closed: true) Battery lib("Library:Symbol") for any KiCad symbol.
- Inputs. Sensors read the room: LDR() (R = 10k at 10 lux, falls with light), Photodiode(), Phototransistor() (pins C, E),
  Thermistor(10k, beta: 3950) (NTC), PTC(100), Mic() (pins + / −, plays the room's sound), TempSensor("LM35"|"TMP36")
  (LM35 pins 1 = +Vs, 2 = Vout, 3 = GND; 10 mV/°C). Live controls: Slider(10k, pos: 0.3) Knob(10k) Pot(10k) (pins 1, 2 = wiper, 3),
  Switch() Button() (closed: true).
  More sensors (pins: modules VCC / OUT / GND; resistive ones pins 1, 2): FSR() (force), LoadCell() (E+ E− S+ S−),
  GasSensor() (resistive) GasModule() (analog out), HumiditySensor(), PressureSensor("40PC015G"), HallSensor("A1301"),
  HallSwitch("A1101") (open drain, needs a pull-up), DistanceSensor() (IR, 10–80 cm), Accelerometer(), PIR(), TouchSensor(),
  MoistureProbe(), LevelSensor(), CurrentSensor() (measures the current from IP+ to IP−, ACS706).
  Room properties: light temp sound tone humidity pressure field distance force accel gas motion touch level moisture
  (units: lux °C dB Hz % Pa/kPa T/mT cm N g ppm; motion / touch 0 or 1).
- Feeds (test data over time, used by transient runs): a top-level block, one line each:
  stimulus {  seed: 7   V1 = ramp(from: 12 V, to: 9 V, over: 20 ms)   TH1 = walk(start: 25°C, sd: 0.5°C, every: 1 ms)
              LDR1 = random(min: 1 lux, max: 10k lux, every: 2 ms)   RV1 = ramp(from: 0, to: 1)   SW1 = square(low: 0, high: 1, period: 5 ms)
              room.temp = 25°C }   — targets: any source (V1, I1, BT1), sensor (its quantity), control, or room.light/temp/sound/tone.
  Signals: 12 V, ramp(from, to, start, over) step(from, to, at) sine(mean, amp, freq) square(low, high, period, duty)
  random(min, max, every, smooth) normal(mean, sd, every) noise(sd, every) walk(start, sd, every, min, max)
  samples([…], every) pwl("t v t v …"), combined with + − * /, e.g. 12 V + noise(sd: 0.2 V).
  Use set_stimulus / set_input to try conditions, then simulate tran again and check parts (currents, power).
- Known BJT models: 2N3904 2N3906 2N2222 2N2907 BC547 BC557 BD139 BD140 TIP31 TIP32. MOSFETs: 2N7000 BS170 BSS138 IRF540N IRFZ44N.
  Diodes: 1N4148 1N4001…1N4007 1N5817…1N5819 BAT54. Other values get a generic model.
- NE555 pins: VCC GND TRIG THRES DISCH OUT RST CONT. OpAmp pins: 1 = +in, 2 = −in, 3 = V+, 4 = V−, 5 = out.
- Exactly one ground per circuit ("ground GND"); every node needs a DC path to ground.
- Repeats: for i in 1..8 { R{i} = R(1k)  N{i} -- R{i} -- N{i+1} } (names take i, i+1, 2*i; loops nest; lists: for i in [1, 2, 5]).
- Properties (inside the circuit): R1.footprint = "Resistor_SMD:R_0603_1608Metric"  R1.MPN = "RC0603FR-0710KL"  R1.tol = 1 %
  Whole selections: parts(R*).footprint = "…"  parts(C*, value: 100n).MPN = "…"  parts(/U[0-9]+/, on: VCC) … (filters: value lib on footprint or any field).
- Design rules, checked on every compile: check connected(U1.OUT, R3.1)  check not connected(OUT, VCC)  check parts(C*).footprint
  check parts(R*).value == 10k  check parts(R*).count == 8 — use them to state what must hold, then fix what fails (V510).
- AC sweeps need a source with ac: (e.g. Vsin(amp: 1 V, freq: 1 kHz, ac: 1 V)).
- Measurements: max min avg rms pp final frequency period duty rise_time (transient), fc gain_db phase (AC). e.g. "measure f = frequency(V(OUT))".

Examples:
${PROMPT_EXAMPLES.map((e) => `// ${e.title}\n${e.code}`).join("\n\n")}
`
}

export const TOOLS: ToolDef[] = [
  { name: "get_circuit", description: "The current circuit as Kirk code, with its nets, ERC problems, connected probes and the selected analysis.", input_schema: { type: "object", properties: {} } },
  {
    name: "write_kirk",
    description: "Replace the circuit with a complete Kirk program. The schematic is redrawn from it. Returns compile errors (fix them and call again) or the parts and nets on success.",
    input_schema: { type: "object", properties: { code: { type: "string", description: "The complete Kirk program" }, summary: { type: "string", description: "One line: what changed" } }, required: ["code"] },
  },
  {
    name: "simulate",
    description: "Run the circuit on ngspice and return results: values per probed / important signal (min, max, average, peak-to-peak, frequency for transients; gain, −3 dB points and phase for AC; node voltages and currents for the operating point) plus the program's measurements and asserts.",
    input_schema: {
      type: "object",
      properties: {
        analysis: { type: "string", enum: ["tran", "ac", "op", "dc"] },
        stop: { type: "string", description: "tran: stop time, e.g. \"5 ms\"" },
        step: { type: "string", description: "tran: max step, e.g. \"10 us\"" },
        from: { type: "string", description: "ac: start frequency, e.g. \"10 Hz\"" },
        to: { type: "string", description: "ac: stop frequency, e.g. \"1 MHz\"" },
      },
      required: ["analysis"],
    },
  },
  { name: "measure", description: "Evaluate a Kirk measurement expression on the last simulation, e.g. \"frequency(V(OUT))\", \"pp(V(OUT)) / pp(V(IN))\", \"fc(V(OUT))\".", input_schema: { type: "object", properties: { expr: { type: "string" } }, required: ["expr"] } },
  { name: "add_probe", description: "Connect a scope / Bode channel: \"V(net)\" or \"I(R1)\" / \"Ic(Q1)\" / \"Id(M1)\".", input_schema: { type: "object", properties: { signal: { type: "string" } }, required: ["signal"] } },
  { name: "remove_probe", description: "Disconnect a probe.", input_schema: { type: "object", properties: { signal: { type: "string" } }, required: ["signal"] } },
  { name: "set_meter", description: "Point the multimeter at a signal (\"V(net)\" or \"I(R1)\").", input_schema: { type: "object", properties: { signal: { type: "string" } }, required: ["signal"] } },
  { name: "set_stimulus", description: "Feed data to an input over time, then simulate tran again to see what happens: a source (\"V1\": supply sag, ripple, noise), a sensor (\"TH1\": temperature, \"LDR1\": light, \"MK1\": sound), a control (\"RV1\" 0…1, \"SW1\" 0/1) or the room (\"room.temp\"). The signal is Kirk, e.g. \"ramp(from: 12 V, to: 9 V, over: 20 ms)\", \"walk(start: 25°C, sd: 0.5°C, every: 1 ms)\", \"5 V + noise(sd: 0.1 V)\". An empty signal removes the feed. Saved in the stimulus { } block.", input_schema: { type: "object", properties: { target: { type: "string" }, signal: { type: "string" } }, required: ["target", "signal"] } },
  { name: "set_input", description: "Move a live control, then simulate again: a Pot / Slider / Knob position (\"0.3\" or \"30%\"), a Switch or Button (\"on\" / \"off\").", input_schema: { type: "object", properties: { part: { type: "string", description: "reference, e.g. RV1 or SW1" }, value: { type: "string" } }, required: ["part", "value"] } },
  { name: "get_firmware", description: "The boards in the schematic that run a sketch: each one's files (sketch.ino, libraries.txt …) and its last compile errors / run output. Optional ref (A1).", input_schema: { type: "object", properties: { ref: { type: "string" } } } },
  { name: "write_firmware", description: "Create or replace a file of a board's sketch: sketch.ino, an extra .h / .cpp, or libraries.txt (one Arduino library per line, e.g. \"Adafruit SSD1306\").", input_schema: { type: "object", properties: { ref: { type: "string", description: "the board, e.g. A1" }, name: { type: "string" }, content: { type: "string" } }, required: ["ref", "name", "content"] } },
  { name: "compile_firmware", description: "Compile a board's sketch with arduino-cli: the errors (fix them and compile again) or the flash used.", input_schema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] } },
  { name: "run_with_firmware", description: "Run the circuit and every board's sketch together for a few seconds; returns the Serial output and any error.", input_schema: { type: "object", properties: { seconds: { type: "number", description: "1–10, default 3" } } } },
  { name: "check_setup", description: "What the schematic's boards need on this computer (arduino-cli and the board core, QEMU, Renode …) and what is missing, with the id to install each.", input_schema: { type: "object", properties: {} } },
  { name: "install", description: "Install a missing item from check_setup by its id. The user is asked to allow it first; if they decline, stop and tell them how to install it themselves.", input_schema: { type: "object", properties: { item: { type: "string" }, reason: { type: "string", description: "one short sentence for the user: why it is needed" } }, required: ["item", "reason"] } },
  { name: "find_parts", description: "Search the KiCad part library (simulation-ready parts) by name or description, e.g. \"LM317\", \"zener 5.1\", \"logic level mosfet\". Returns Library:Symbol ids to use with lib(\"…\").", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
]

/** One line for the chat card of a finished tool call. */
function summarize(name: string, input: Record<string, unknown>, result: string, ok: boolean): string {
  if (!ok) return result.split("\n")[0].slice(0, 160)
  switch (name) {
    case "write_kirk": return String(input.summary ?? "Circuit written")
    case "simulate": return result.split("\n")[0]
    case "add_probe": case "remove_probe": case "set_meter": case "set_stimulus": case "set_input": return result
    default: return result.split("\n")[0].slice(0, 120)
  }
}

async function runTool(host: AgentHost, name: string, input: Record<string, unknown>): Promise<{ ok: boolean; result: string }> {
  try {
    switch (name) {
      case "get_circuit": {
        const c = host.getCircuit()
        return { ok: true, result: `Title: ${c.title}\nAnalysis: ${c.analysis}\nProbes: ${c.probes.join(", ") || "none"}\nNets: ${c.nets.join(", ")}\nERC: ${c.issues.length ? c.issues.join("; ") : "ok"}\n\n${c.kirk}` }
      }
      case "write_kirk": {
        const r = await host.writeKirk(String(input.code ?? ""))
        if (!r.ok) return { ok: false, result: `Compile errors — fix and call write_kirk again:\n${r.errors.join("\n")}` }
        return { ok: true, result: `Compiled: ${r.parts} parts, nets ${r.nets.join(", ")}.${r.warnings.length ? `\nWarnings: ${r.warnings.join("; ")}` : ""}` }
      }
      case "simulate": {
        const a = String(input.analysis ?? "tran") as "tran" | "ac" | "op" | "dc"
        const r = await host.simulate(a, { stop: input.stop as string, step: input.step as string, from: input.from as string, to: input.to as string })
        return { ok: !/^Simulation failed|^Not simulated/.test(r), result: r }
      }
      case "measure": { const r = await host.measure(String(input.expr ?? "")); return { ok: !/^error/i.test(r), result: r } }
      case "add_probe": return { ok: true, result: host.addProbe(String(input.signal ?? "")) }
      case "remove_probe": return { ok: true, result: host.removeProbe(String(input.signal ?? "")) }
      case "set_meter": return { ok: true, result: host.setMeter(String(input.signal ?? "")) }
      case "find_parts": return { ok: true, result: await host.findParts(String(input.query ?? "")) }
      case "get_firmware": case "write_firmware": case "compile_firmware": case "run_with_firmware": case "check_setup": case "install": {
        const fw = host.firmware
        if (!fw) return { ok: false, result: "Boards and firmware aren't available here" }
        if (name === "get_firmware") return { ok: true, result: fw.read(input.ref ? String(input.ref) : undefined) }
        if (name === "write_firmware") { const r = fw.write(String(input.ref ?? ""), String(input.name ?? ""), String(input.content ?? "")); return { ok: !/^Not /.test(r), result: r } }
        if (name === "compile_firmware") { const r = await fw.compile(String(input.ref ?? "")); return { ok: r.ok, result: r.text } }
        if (name === "run_with_firmware") { const r = await fw.run(Math.max(1, Math.min(10, Number(input.seconds ?? 3)))); return { ok: r.ok, result: r.text } }
        if (name === "check_setup") return { ok: true, result: await fw.checkSetup() }
        const r = await fw.install(String(input.item ?? ""), String(input.reason ?? "")); return { ok: r.ok, result: r.text }
      }
      case "set_stimulus": { const r = host.setStimulus(String(input.target ?? ""), String(input.signal ?? "")); return { ok: !r.startsWith("Not set"), result: r } }
      case "set_input": { const r = host.setInput(String(input.part ?? ""), String(input.value ?? "")); return { ok: !/^(No |Can't|Unknown)/.test(r), result: r } }
      default: return { ok: false, result: `Unknown tool ${name}` }
    }
  } catch (e) {
    return { ok: false, result: `Error: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** A different assistant on the same chat: its own instructions and tools (e.g. the Arduino workspace). */
export interface AgentProfile {
  system(): string
  tools: ToolDef[]
  run(name: string, input: Record<string, unknown>): Promise<{ ok: boolean; result: string }>
  summarize?(name: string, input: Record<string, unknown>, result: string, ok: boolean): string
  /** chat chrome */
  intro: string
  suggestions: string[]
  placeholder: string
  labels?: Record<string, string>
}

export interface RunOptions {
  transport: Transport
  model: string
  history: Msg[]
  host?: AgentHost
  profile?: AgentProfile
  onEvent: (e: AgentEvent) => void
  signal?: AbortSignal
  maxSteps?: number
  maxTokens?: number
}

/** Send the conversation, run any tools the model asks for, repeat. Returns the new history. */
export async function runAgent(o: RunOptions): Promise<Msg[]> {
  const p = o.profile
  const system: Block[] = [{ type: "text", text: p ? p.system() : systemPrompt(), cache_control: { type: "ephemeral" } }]
  const defs = p ? p.tools : TOOLS
  const tools = defs.map((t, i) => (i === defs.length - 1 ? { ...t, cache_control: { type: "ephemeral" as const } } : t))
  let history = [...o.history]
  for (let step = 0; step < (o.maxSteps ?? 16); step++) {
    if (o.signal?.aborted) break
    const res = await o.transport({ model: o.model, max_tokens: o.maxTokens ?? 8000, system, tools, messages: history }, o.signal)
    history = [...history, { role: "assistant", content: res.content }]
    for (const b of res.content) if (b.type === "text" && b.text.trim()) o.onEvent({ kind: "text", text: b.text })
    const uses = res.content.filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use")
    if (res.stop_reason !== "tool_use" || !uses.length) break
    const results: Block[] = []
    for (const u of uses) {
      o.onEvent({ kind: "tool", id: u.id, name: u.name, input: u.input, status: "running" })
      const r = p ? await p.run(u.name, u.input).catch((e) => ({ ok: false, result: `Error: ${e instanceof Error ? e.message : String(e)}` })) : await runTool(o.host!, u.name, u.input)
      const sum = p?.summarize ? p.summarize(u.name, u.input, r.result, r.ok) : summarize(u.name, u.input, r.result, r.ok)
      o.onEvent({ kind: "tool", id: u.id, name: u.name, input: u.input, status: r.ok ? "ok" : "error", summary: sum })
      results.push({ type: "tool_result", tool_use_id: u.id, content: r.result, ...(r.ok ? {} : { is_error: true }) })
    }
    history = [...history, { role: "user", content: results }]
  }
  return history
}
