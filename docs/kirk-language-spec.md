# Kirk — a circuit programming language for Space Bench

**Status:** v0.1 — implemented in `apps/desktop/src/kirk/`; §17 lists what is done and what isn't yet
**Name:** Kirk (after Gustav Kirchhoff, whose current and voltage laws every circuit obeys) · file extension **`.kirk`** · command-line tool **`kirk`**
**Audience:** Space Bench users who write circuits as code, and contributors to the compiler and editor

---

## 1. What this feature is

Kirk is a text language for describing electronic circuits **and** everything you do with them: parts, connections, simulations, measurements, instruments, sweeps, data logging and custom components.

The desktop app keeps **code and schematic in sync both ways**:

| You do this | The app does this |
|---|---|
| Type Kirk code | Compiles it on every keystroke (debounced) and **draws / updates the schematic** automatically |
| Draw or edit in the schematic | **Generates / patches the Kirk code** with minimal text edits, keeping your comments and formatting |
| Write `measure`, `probe`, `scope`, `meter`… | Wires those instruments to the nets on the schematic and shows live readings |
| Write `component …` | Creates a reusable part with its own symbol, pins, simulation model and parameters |
| Press Run | Compiles to the circuit IR, runs it on the built-in **Space Bench Engine**, streams results to the plots and instruments |

### Goals
1. **Readable by electronics people** — looks like a netlist written by a human, not like a general-purpose program.
2. **Units are types** — `10k` on a capacitor is a compile error; `10 uF` is not.
3. **Lossless round-trip** — code → schematic → code never loses comments, ordering or formatting of untouched lines.
4. **Everything is code** — parts, measurements, instruments, sweeps, Monte Carlo, exports.
5. **One engine, no external tools** — Kirk compiles to the circuit IR executed by our own Space Bench Engine; JSON IR and SPICE-format netlist export exist only for interoperability.
6. **Buildable in small parts** — each phase in §15 ships something usable.

### Non-goals (v1)
- A general-purpose programming language (no arbitrary loops / I/O; `for` exists only for generating repeated parts, see §5.9).
- PCB layout description (PCB comes later as a separate `board {}` block).
- Digital HDL (Verilog/VHDL). Logic gates can be used as parts with behavioural models.

---

## 2. A first example

The 555 LED blinker, written in Kirk:

```kirk
// 555 astable blinker — f = 1.44 / ((R1 + 2·R2)·C1) ≈ 6.86 Hz
circuit Blinker555 {
    supply VCC = 5 V            // net VCC + a DC source to ground
    ground GND

    U1 = NE555                  // from the Space Bench library (Timers), behavioural model included
    R1 = R(1 kΩ)
    R2 = R(10k)                 // "k" without unit: unit inferred from R()
    C1 = C(10 uF, polarized)
    R3 = R(330)
    D1 = LED(color: red)

    // chains: two-terminal parts connect pin 1 → left, pin 2 → right
    VCC -- R1 -- DISCH -- R2 -- TRIG -- C1 -- GND
    U1.OUT -- OUT -- R3 -- LED_A -- D1 -- GND

    // pin-to-net connections
    U1.VCC, U1.RST   -- VCC
    U1.DISCH         -- DISCH
    U1.THRES, U1.TRIG -- TRIG
    U1.GND           -- GND
    U1.CONT          -- nc            // explicit no-connect (silences ERC)
}

simulate tran(stop: 500 ms, step: 20 us)

measure freq = frequency(V(OUT), at: 2.5 V)
measure duty = duty(V(OUT), at: 2.5 V)
assert  freq in 6.5 Hz .. 7.2 Hz

scope Scope1 {
    ch1 = V(OUT)   scale 2 V/div
    ch2 = V(TRIG)  scale 1 V/div
    timebase 50 ms/div
    trigger ch1 rising 2.5 V
}
```

What the app does with this file:
- **Schematic:** draws the circuit (auto-layout on first open, then positions are remembered).
- **Probes:** puts CH1/CH2 probe pins on nets `OUT` and `TRIG`, connected to the scope in the instrument dock.
- **Simulation:** runs the transient and computes `freq`/`duty` (6.86 Hz, 52.4 %); the `assert` turns green.

---

## 3. Lexical structure

| Element | Rules | Examples |
|---|---|---|
| Comments | `//` to end of line, `/* … */` block. Comments are **kept** in the syntax tree (needed for round-trip). | `// note` |
| Identifiers | `[A-Za-z_][A-Za-z0-9_]*`. Case-sensitive. Part refs conventionally upper case. | `R1`, `vout`, `LED_A` |
| Quoted names | Back-ticks allow any net name. | `` `+5V` ``, `` `V-` `` |
| Numbers | Decimal, scientific; `_` digit separator. | `4.7`, `1e-6`, `100_000` |
| SI prefixes | `f p n u µ m k M Meg G T`. **`M` = mega**, **`m` = milli** (unlike SPICE, where M is milli); `Meg` also accepted. The formatter normalises `µ` → `u`. | `10k`, `4.7u`, `2.2M`, `100m` |
| Units | `V A Ω ohm F H Hz s W °C % ppm dB deg rad`. Optional when the context implies it. Space between number and unit is optional. | `10 uF`, `5V`, `1 kΩ`, `-3 dB` |
| Ranges | `a .. b` | `6.5 Hz .. 7.2 Hz` |
| Strings | `"…"` with `\"` escapes. | `"Timers/NE555"` |
| Annotations | `@name(args)` before a statement; used for layout and tooling. | `@at(120, 40) @rot(90)` |

Keywords (reserved): `circuit component supply ground net nc import library lib use simulate measure assert probe scope meter funcgen bode logger sweep montecarlo temp for in param pins symbol footprint model behavior draw export layout true false`.

---

## 4. Types and units

Every value has a **dimension**. The compiler checks dimensions and reports mismatches with the source span.

| Type | Dimension | Typical literals |
|---|---|---|
| `Voltage` | V | `5 V`, `3.3V`, `-12 V` |
| `Current` | A | `20 mA`, `1.5 A` |
| `Resistance` | Ω | `10k`, `4.7 kΩ`, `1 Meg` |
| `Capacitance` | F | `100n`, `10 uF` |
| `Inductance` | H | `1 mH` |
| `Frequency` | Hz | `1 kHz` |
| `Time` | s | `20 us`, `500 ms` |
| `Power` | W | `0.25 W` |
| `Ratio` | dimensionless | `1 %`, `0.01`, `100 ppm` |
| `Temperature` | °C | `27 °C` |
| `Net`, `Pin`, `Part`, `Signal` | — | `VCC`, `U1.OUT`, `V(OUT)`, `I(R3)` |

Rules:
- A bare number takes the unit of the parameter it is passed to (`R(10k)` → 10 kΩ).
- Arithmetic follows dimensions: `V / Ω → A`, `1 / (R·C) → Hz` (2π is **not** inserted automatically).
- Wrong units are errors: `C(10k)` → *"C1 expects Capacitance (F); got 10 k (no unit → inferred Ω from context? no). Did you mean 10 nF?"*

---

## 5. Language reference

### 5.1 File structure
A `.kirk` file contains, in any order:
- `import` / `use` statements
- one or more `circuit` blocks (the first, or the one marked `@main`, is the design under test)
- `component` definitions
- `param` declarations
- analysis, measurement, instrument, sweep and export statements
- one machine-managed `layout` block (§9)

```kirk
import library "timers"               // a family from the Space Bench part library
import "lib/my_parts.kirk"            // your own components and models
use std.instruments                   // scope, meter, funcgen, bode, logger
```

### 5.2 Nets
- Nets are created implicitly by being named in a connection (`-- OUT --`), or explicitly: `net OUT, LED_A`.
- `ground GND` declares node 0. Several names may alias ground.
- `supply VCC = 5 V` creates net `VCC` and an ideal DC source `V_VCC` from `VCC` to ground. `supply VEE = -12 V` likewise.
- `nc` is the built-in no-connect target.
- Unnamed nets created by drawing get stable generated names `_n1`, `_n2`… (rename them in code or in the schematic).

### 5.3 Parts
```kirk
R1 = R(10k)                         // positional = the component's primary param
R2 = R(value: 10k, tol: 1 %, power: 0.25 W)
Q1 = NPN("2N3904")                  // parameter set by name from the Space Bench model library
U2 = lib("Analog/LM358", unit: A)   // any part from the Space Bench library
```
- The left-hand side is the **reference designator**; it is unique within a circuit.
- `lib("Family/Part")` instantiates any part from the Space Bench library. Every library part carries its symbol, pins, footprint and simulation model. Parts you define with `component` (§6) are added to the same library.

### 5.4 Connections
Three forms, all compiled to the same net graph:

```kirk
// 1) chain: alternating nets and two-terminal parts
VCC -- R1 -- DISCH -- R2 -- TRIG

// 2) pin list to net
U1.THRES, U1.TRIG -- TRIG

// 3) pin to pin (net is created and named _nK, or named inline)
U1.OUT -- R3.1
U1.OUT -- OUT -- R3.1                // same, with net named OUT
```
Rules:
- In a chain, a two-terminal part `X` between `A` and `B` means `X.1 -- A` and `X.2 -- B`. Write `X'` to reverse it (`X.2 -- A`). Polarized parts warn if reversed relative to the DC operating point.
- Multi-pin parts may appear in a chain only with an explicit pin pair: `A -- U1(IN→OUT) -- B`.
- Connecting two named nets merges them. The compiler warns: *"nets OUT and VO merged; keeping OUT"*.

### 5.5 Sources
```kirk
V1 = Vdc(5 V)
VIN = Vsin(amp: 0.5 V, freq: 1 kHz, offset: 0 V, ac: 1)
VCLK = Vpulse(low: 0, high: 3.3 V, period: 1 us, width: 500 ns, rise: 2 ns)
VPWL = Vpwl([0 s: 0 V, 1 ms: 5 V, 2 ms: 5 V, 2.1 ms: 0 V])
I1 = Idc(1 mA)
```
Instruments may *be* sources: `funcgen FG1 -> VIN { wave sine; freq 1 kHz; amp 1 Vpp }` (see §7).

### 5.6 Parameters and expressions
```kirk
param RT = 10k                      // global; sweepable
param fc = 1 / (2 * pi * R1.value * C1.value)
R2 = R(RT)
```
Expressions support `+ - * / ^`, the functions `sqrt log log10 exp sin cos min max abs clamp`, the constants `pi e k_B q`, part parameter access (`R1.value`) and conditionals (`if a then b else c`).

### 5.7 Simulation
```kirk
simulate op
simulate tran(stop: 500 ms, step: 20 us, start: 0, uic: false)
simulate ac(from: 10 Hz, to: 100 kHz, points: 50/dec)
simulate dc(V1, from: 0 V, to: 5 V, step: 10 mV)
simulate noise(out: V(OUT), in: VIN, from: 10 Hz, to: 100 kHz)
simulate fft(V(OUT), window: hann, from: 200 ms)
simulate realtime(speed: 1x)          // interactive stepping (Falstad-style animation)
```
Several `simulate` statements are allowed. Each produces a named result set (`tran1`, `ac1`, …) or the name you give: `simulate main = tran(...)`.

### 5.8 Measurements and assertions
```kirk
measure vpp   = pp(V(OUT), from: 200 ms)
measure f0    = frequency(V(OUT), at: 2.5 V)
measure gain  = gain_db(V(OUT) / V(VIN), at: 1 kHz)        // AC result
measure bw    = bandwidth(V(OUT) / V(VIN), drop: 3 dB)
measure tr    = rise_time(V(OUT), 10 %, 90 %)
measure p_led = avg(V(LED_A) * I(D1))
assert  bw > 900 Hz
assert  p_led < 20 mW   severity: warning
```
Built-in measurement functions:

| Group | Functions |
|---|---|
| Levels | `avg`, `rms`, `pp`, `max`, `min`, `at(signal, t or f)` |
| Timing | `frequency`, `period`, `duty`, `rise_time`, `fall_time`, `delay(a, b)`, `crossing`, `settle(signal, band)`, `overshoot` |
| Frequency domain | `gain_db`, `phase`, `bandwidth`, `fc`, `phase_margin`, `gain_margin`, `thd`, `snr`, `fft` |
| Statistics (sweeps / Monte Carlo) | `mean`, `stddev`, `yield(spec)`, `histogram` |

`V(net)`, `V(a, b)` (differential), `I(part)` and `I(part.pin)` are **signals**. Arithmetic on signals creates math traces.

### 5.9 Sweeps, Monte Carlo, temperature, generators
```kirk
sweep R2.value in [4.7k, 10k, 22k, 47k]            // list
sweep RT in 1k .. 100k log 10 points               // log spacing
montecarlo 500 runs seed 42 {
    tolerance R* 1 %                               // glob on reference designators
    tolerance C* 10 %
}
temp in [-40 °C, 27 °C, 85 °C]

// structural generator: 8 LEDs with resistors
for i in 1 .. 8 {
    R{i} = R(330)
    D{i} = LED()
    BUS[i] -- R{i} -- _ -- D{i} -- GND           // "_" = anonymous net
}
```

### 5.10 Data export / logging
```kirk
logger Log1 {
    signals V(OUT), V(TRIG), I(R3)
    every 100 us  from 0 to 500 ms
    to "exports/555_sweep.csv" format csv  header units
}
export plot(V(OUT), V(TRIG)) to "out.svg"
export report to "report.pdf"
```

---

## 6. Components (user-defined parts)

Any part can be defined in Kirk and then used exactly like a built-in one.

### 6.1 Wrapping a built-in engine device
```kirk
component Resistor(value: Resistance, tol: Ratio = 1 %, power: Power = 0.25 W) {
    pins 1, 2
    symbol    std.resistor                   // Space Bench symbol (or draw your own, §6.5)
    footprint "R-0603"
    model     engine.resistor(value)        // maps to a built-in engine device
}
```

### 6.2 Subcircuit built from other parts
```kirk
component RCLowPass(r: Resistance = 1.6k, c: Capacitance = 100n) {
    pins in, out, gnd
    symbol box(left: [in], right: [out], bottom: [gnd], label: "RC LP")
    in -- R1 = R(r) -- out -- C1 = C(c) -- gnd    // inline part creation inside a chain
    derived fc = 1 / (2 * pi * r * c)               // shown in the inspector
}
```

### 6.3 Behavioural part
```kirk
component OpAmpIdeal(gain: Ratio = 100k, gbw: Frequency = 1 MHz, vsat: Voltage = 13 V) {
    pins inp, inn, out
    symbol std.opamp map { plus: inp, minus: inn, out: out }
    behavior {
        node n1
        current(0 -> n1) = 1 S * (V(inp) - V(inn))    // VCCS
        R(gain) between n1, 0
        C(1 / (2 * pi * gbw)) between n1, 0           // single pole at gbw/gain
        voltage(out) = vsat * tanh(V(n1) / vsat)       // soft saturation
    }
}
```
`behavior` compiles to engine behavioural sources (their Jacobian comes from automatic differentiation), controlled sources and passives, wrapped as a subcircuit.

### 6.4 Measurement as a component
Instruments are components too (§7), so users can define their own:
```kirk
component PowerMeter() : instrument {
    pins p, n, i_through
    reading power = avg((V(p) - V(n)) * I(i_through)) unit W
    display "{power:.3} W"
}
```

### 6.5 Drawing your own symbol
Symbols are part of the language. Draw them with primitives on the 2.54 mm grid; pins are declared where wires attach:

```kirk
symbol thermistor {
    pin 1 at (0, -3)      // grid units (1 = 2.54 mm); y grows downwards
    pin 2 at (0,  3)
    draw line (0, -3) -> (0, -1.5)
    draw rect (-0.6, -1.5) .. (0.6, 1.5) radius 0.1
    draw line (-1, 1.2) -> (1, -1.2) -> (1.4, -1.2)   // the "T" slash
    draw line (0, 1.5) -> (0, 3)
    text "{ref}"   at (1.4, -0.4)
    text "{value}" at (1.4,  0.6)
}
component NTC(r25: Resistance = 10k, beta = 3950) {
    pins 1, 2
    symbol thermistor
    behavior { R(r25 * exp(beta * (1/(temp + 273.15) - 1/298.15))) between 1, 2 }
}
```
The built-in `std.*` symbols are written the same way (one file per family), so the whole library is ours and editable.

---

## 7. Instruments in code

| Keyword | Connects to | Shown as | Compiles to |
|---|---|---|---|
| `scope` | up to 4 signals | scope panel + probe pins on the nets | saved vectors + view config |
| `meter` | `V(a[,b])`, `I(part)`, `R(a,b)` | DMM panel with big readout | measurement engine |
| `funcgen X -> net` | drives a net | function-generator panel + lead | a V source (sin/pulse/…) |
| `bode` | `in`, `out` nets | Bode plotter panel | `.ac` + post-processing |
| `logger` | list of signals | data-collection panel (REC) | vectors written to a file |
| `spectrum` | one signal | FFT panel | `fft` post-processing |

```kirk
funcgen FG1 -> VIN { wave sine; freq 1 kHz; amp 1 Vpp; offset 0 V }
meter   DMM1 = rms(V(OUT))                 // shows 0.2500 V at fc for the RC example
bode    Bode1 in VIN out OUT from 10 Hz to 100 kHz
```

Instrument statements carry no layout. The schematic draws their **leads** (dashed, colour-coded) from the instrument badge to the probed nets. Deleting a lead in the schematic deletes the matching line of code, and vice versa.

---

## 8. Compiler architecture

```
            ┌──────────── editor (CodeMirror 6) ────────────┐
 .kirk text ─► Lexer ─► Parser ─► CST (lossless, with trivia)  │
            └────────────────────────────┬───────────────────┘
                                         ▼
                              Semantic analysis
                 (scopes, imports, units, part resolution, ERC)
                                         ▼
                           Circuit IR  (single source of truth)
          ┌──────────────┬───────────────┼────────────────┬──────────────┐
          ▼              ▼               ▼                ▼              ▼
   Engine jobs       Schematic       Instrument      SPICE export     JSON IR
  (OP/TRAN/AC…)     (layout+route)    config         (optional)      (debug/API)
```

### 8.1 Stages
1. **Lexer:** tokens, including comments and whitespace ("trivia"), so nothing is lost.
2. **Parser:** produces a *lossless concrete syntax tree*. Error-tolerant: the parser recovers at statement boundaries so a typo on one line doesn't blank the whole schematic.
3. **Semantic analysis:**
   - resolve imports, library parts and models;
   - build the symbol table;
   - check dimensions and unit inference;
   - expand `for` generators and sub-components;
   - merge nets;
   - run ERC (floating nets, no ground path, shorted sources, unconnected pins without `nc`, reversed polarized parts).
4. **IR:** a typed graph of `Part`, `Pin`, `Net`, `Param`, `Analysis`, `Measure`, `Instrument`, `Sweep` and `Layout`, with **stable IDs** (by reference designator and net name), so edits can be diffed.
5. **Backends:** the netlist generator (§10), the schematic layout (§9), instrument wiring, exporters.

### 8.2 Incrementality and speed targets
- Re-parse only changed statements (incremental parser); re-run semantic analysis per circuit.
- Budget: **< 16 ms** from keystroke to updated schematic for circuits up to 300 parts; simulation is asynchronous and never blocks typing.
- Debounce: 150 ms for compile, 600 ms for auto-simulate (real-time mode).

### 8.3 Diagnostics
Each diagnostic carries a code, a severity, a source span **and** the affected schematic items, so a click jumps to and highlights either side.

```
error[V102]: unit mismatch
  --> blinker.kirk:9:12
   |
 9 |     C1 = C(10k)
   |            ^^^ expected Capacitance (F), found Resistance (Ω)
   = help: did you mean 10 nF?
```

| Code range | Area |
|---|---|
| V0xx | syntax |
| V1xx | types/units |
| V2xx | names/scopes |
| V3xx | ERC |
| V4xx | models |
| V5xx | simulation/measure |
| V6xx | sync/layout |

---

## 9. Two-way sync: code ⇄ schematic

**Principle:** the **IR is the single source of truth**. Code and schematic are two *views* of it.

### 9.1 Code → schematic
1. On a successful compile, diff the new IR against the previous one (by stable IDs).
2. Apply only the changes to the schematic: add, remove or update parts, nets, parameters and instruments.
3. **Placement** of a new part:
   - If the code has an `@at` annotation or the `layout` block has a position, use it.
   - Otherwise run **auto-layout** for the new part only. It is placed near its neighbours using signal-flow ordering: power rails at the top, ground at the bottom, inputs on the left, outputs on the right.
4. **Routing:** orthogonal wires with an A* router on the 2.54 mm grid, avoiding symbol bodies. Use net labels instead of long wires when a route would exceed N bends.
5. If the code has syntax errors, keep showing the **last good** schematic with a banner: "Code has 1 error. Schematic shows the last valid version".

### 9.2 Schematic → code
Every schematic gesture becomes an **edit operation** on the IR, and every operation has a **code patch** rule:

| Gesture | IR op | Code patch |
|---|---|---|
| Place part | `AddPart(ref, kind, params)` | Insert `R4 = R(1k)` after the last part statement of that circuit |
| Draw wire pin→pin | `Connect(pinA, pinB)` | Append to an existing chain if one ends at that net, else insert `U1.OUT -- R3.1` |
| Name a net / place label | `RenameNet(_n3 → OUT)` | Rename every occurrence (a scope-aware refactor, like an IDE rename) |
| Edit value in inspector / slider | `SetParam(R2.value, 22k)` | Replace only the literal token, keeping the user's style (`22k` vs `22 kΩ`) |
| Delete part | `RemovePart(R4)` | Remove its declaration and its occurrences in connections. If it sits in a chain, split the chain or re-join it to keep the remaining connections. |
| Move / rotate | `SetLayout(R2, x, y, rot)` | Update the `layout` block only (never the circuit body) |
| Add probe / instrument | `AddInstrument(...)` | Insert a `scope` / `meter` / `funcgen` statement |

Patch rules: change the smallest token range possible, re-format only the touched statement, and never move comments.

### 9.3 The `layout` block
Positions live in a machine-managed block at the end of the file. It is collapsed in the editor by default and its formatting is stable, so diffs stay small:

```kirk
layout {
    U1  at (440, 272)
    R1  at (250, 214) rot 0
    R2  at (250, 290)
    D1  at (640, 360) rot 90
    wire VCC  [(110, 90), (520, 90)]        // only stored for manually-routed wires
    label OUT at (560, 270)
}
```
- If you delete the `layout` block, the app re-runs auto-layout.
- Inline `@at(x, y)` annotations override the block (useful in hand-written examples).

### 9.4 Concurrency
- Edits in either view go through one **command queue**, so the text buffer and the canvas never race.
- Undo/redo is unified: one stack of IR operations, each holding the text patch and the canvas change.
- **Conflict rule:** when the user is typing in a statement, schematic edits that touch that statement are queued until the text compiles again.

---

## 10. Running on the Space Bench Engine

There is no external simulator and no netlist file in the normal flow. The compiler hands the **circuit IR** straight to the Space Bench Engine (the engine design notes) as one or more **jobs**:

```text
job #1  Blinker555 · tran(stop 500 ms, step 20 µs)
  unknowns : 6 nets + 1 source branch (+ internal nodes of U1's macro-model)
  devices  : V_VCC(dc 5 V) · U1(NE555 macro) · R1 1k · R2 10k · C1 10u · R3 330 · D1(LED red)
  measures : freq = frequency(V(OUT), 2.5 V) · duty = duty(V(OUT), 2.5 V)
  asserts  : freq in 6.5 Hz .. 7.2 Hz
  probes   : Scope1.ch1 = V(OUT), Scope1.ch2 = V(TRIG)
```

Rules:
- **Elaboration:** sub-components and `behavior` blocks are flattened into engine devices. `U1.CONT -- nc` leaves that node internal to the macro-model.
- **Sweeps, Monte Carlo, temperature:** these map to the engine's **driver** loops , which run in parallel threads and reuse the matrix ordering. No scripting language is involved.
- **Measurements and asserts:** run in the engine's measurement library on the accepted solution points .
- **Source mapping:** every engine device and unknown keeps its Kirk source span. So "singular matrix at node TRIG" highlights both the Kirk line and the schematic part ("Show on schematic").
- **Interoperability (optional, later):** `kirk export --format spice` writes a SPICE-format netlist for people who want to cross-check in other tools. It is never needed to run Space Bench.

## 11. Formatter (`kirk fmt`)

- 4-space indent; one statement per line; aligned `--` columns in consecutive pin-list connections.
- Units are printed as the user wrote them; only `µ` → `u` and `ohm` → `Ω` are normalised.
- The formatter is **idempotent** and is run on generated code, so the code produced by drawing looks hand-written.

---

## 12. Editor features (Language Server)

The language server (LSP) runs in the app and is also usable from VS Code. It provides:
- syntax highlighting (an incremental grammar for CodeMirror 6, plus tree-sitter for other editors);
- completion for library parts (fuzzy search), pin names after `U1.`, units after numbers, and nets;
- **hover** with the value, unit and *live operating-point readings* (`V(TRIG) = 2.41 V`);
- go to definition, find references, and **rename** (also renames schematic labels);
- quick fixes ("add `nc`", "insert ground", "did you mean 10 nF?");
- inlay hints, such as the computed value of `param fc` → `994.7 Hz`;
- **cross-highlighting:** the cursor on `R2` selects R2 on the canvas, and selecting a wire highlights its net in code.

---

## 13. Standard library (v1)

| Module | Contents |
|---|---|
| `std.passive` | `R`, `C` (`polarized`), `L`, `Pot`, `Xfmr`, `Crystal`, `Fuse` |
| `std.sources` | `Vdc Vsin Vpulse Vpwl Vexp Idc Isin Ipulse`, controlled `E F G H`, behavioural `Bv Bi` |
| `std.semi` | `D LED Zener Schottky NPN PNP NMOS PMOS NJFET PJFET` |
| `std.ic` | `OpAmpIdeal`, `Comparator`, `NE555` (macro-model), `Regulator` (7805/317-style macro-models) |
| `std.switch` | `Switch` (voltage-controlled), `PushButton` (interactive during real-time sim) |
| `std.instruments` | `scope meter funcgen bode logger spectrum` |
| `std.measure` | the functions in §5.8 |

Models are resolved in this order:
1. an explicit `model:` argument;
2. the part's own `model` from its library entry;
3. the Space Bench model library, keyed by value (e.g. `2N3904`);
4. otherwise an error (every library part must be simulatable).

---

## 14. Data structures (for implementers)

### 14.1 IR (TypeScript sketch)
```ts
type Id = string;                       // stable: "part:R2", "net:TRIG", "inst:Scope1"
interface Quantity { value: number; dim: Dim; text: string }   // keep original text for round-trip

interface Part {
  id: Id; ref: string; kind: string;            // "R", "lib:Timers/NE555", "user:RCLowPass"
  params: Record<string, Quantity | string>;
  pins: Record<string, Id>;                     // pin name -> net id
  model?: ModelRef; symbol: SymbolRef; footprint?: string;
  span: SourceSpan;                              // where it is declared
}
interface Net { id: Id; name: string; isGround: boolean; aliases: string[]; generated: boolean }
interface Instrument { id: Id; kind: "scope"|"meter"|"funcgen"|"bode"|"logger"|"spectrum"; config: unknown; leads: { label: string; net: Id }[] }
interface Circuit { name: string; parts: Map<Id, Part>; nets: Map<Id, Net>; params: Map<string, Expr>;
                    analyses: Analysis[]; measures: Measure[]; instruments: Instrument[];
                    sweeps: Sweep[]; layout: Map<Id, Placement> }
```

### 14.2 Edit operations
```ts
type Op =
  | { op: "AddPart"; part: Part; after?: Id }
  | { op: "RemovePart"; id: Id }
  | { op: "Connect"; a: PinRef; b: PinRef | Id }
  | { op: "Disconnect"; pin: PinRef }
  | { op: "RenameNet"; id: Id; name: string }
  | { op: "SetParam"; part: Id; key: string; value: Quantity }
  | { op: "SetLayout"; id: Id; at: [number, number]; rot: 0|90|180|270; mirror?: boolean }
  | { op: "AddInstrument"; inst: Instrument };
// every Op implements: applyToIR(), applyToCanvas(), patchText(cst) -> TextEdit[], invert() (for undo)
```

### 14.3 Suggested repository layout
```
packages/
  kirk-syntax/      grammar (Lezer for CodeMirror + tree-sitter), lossless CST, formatter
  kirk-compiler/    semantic analysis, units, ERC, IR, edit ops, code patcher
  kirk-engine-bridge/  IR → Space Bench Engine jobs, source maps, sweep/MC drivers
engine/             Space Bench Engine (experimental Rust core)
  kirk-layout/      auto-placement + orthogonal router
  kirk-lsp/         language server
  kirk-stdlib/      *.kirk standard library + model DB index
apps/desktop/       Space Bench (shadcn/ui), uses all of the above
examples/           blinker.kirk, rc_lowpass.kirk, ... (golden tests)
```
**Recommended implementation language: TypeScript.** It is the same language as the shadcn/ui desktop front-end, so the compiler runs in the UI process with no bridge. The grammar is written for Lezer (CodeMirror's native incremental parser), and a tree-sitter grammar is generated for other editors. A Rust/WASM compiler core can come later if profiling shows the need.

---

## Appendix A — Grammar (EBNF, v0.1)

```ebnf
file        = { item } ;
item        = import | use | circuit | component | param | analysis | measure | assert
            | instrument | sweep | montecarlo | tempstmt | logger | export | layout ;

import      = "import" [ "library" ] string [ "as" ident ] ;
use         = "use" path ;
circuit     = { annotation } "circuit" ident "{" { stmt } "}" ;
stmt        = supply | ground | netdecl | partdecl | connection | param | forstmt ;

supply      = "supply" ident "=" expr ;
ground      = "ground" ident { "," ident } ;
netdecl     = "net" netname { "," netname } ;
partdecl    = { annotation } ident "=" call ;
call        = ident [ "(" [ args ] ")" ] | "lib" "(" string [ "," args ] ")" ;
args        = arg { "," arg } ;
arg         = [ ident ":" ] ( expr | ident ) ;

connection  = endpoint { "--" endpoint } ;
endpoint    = pinlist | netname | partref | "nc" | "_" | ident "=" call ;
pinlist     = pinref { "," pinref } ;
pinref      = ident "." ( ident | int ) ;
partref     = ident [ "'" ] [ "(" ident "→" ident ")" ] ;
netname     = ident | "`" { char } "`" ;

param       = "param" ident "=" expr ;
forstmt     = "for" ident "in" range "{" { stmt } "}" ;

analysis    = "simulate" [ ident "=" ] ident [ "(" [ args ] ")" ] ;
measure     = "measure" ident "=" expr ;
assert      = "assert" expr [ "severity" ":" ident ] ;
instrument  = ( "scope" | "meter" | "funcgen" | "bode" | "spectrum" ) ident [ "->" netname ]
              ( "=" expr | "{" { instline } "}" | { ident expr } ) ;
sweep       = "sweep" lvalue "in" ( list | range [ ( "lin" | "log" ) expr "points" ] ) ;
montecarlo  = "montecarlo" int "runs" [ "seed" int ] "{" { "tolerance" glob expr } "}" ;
tempstmt    = "temp" "in" list ;
logger      = "logger" ident "{" { instline } "}" ;
export      = "export" expr "to" string [ "format" ident ] ;
layout      = "layout" "{" { layoutline } "}" ;

component   = "component" ident [ "(" [ params ] ")" ] [ ":" "instrument" ] "{" { compstmt } "}" ;
compstmt    = "pins" ident { "," ident } | "symbol" symspec | "footprint" string
            | "model" call | "behavior" "{" { bstmt } "}"
            | "derived" ident "=" expr | "reading" ident "=" expr [ "unit" ident ] | "display" string
            | stmt ;

expr        = term { ( "+" | "-" ) term } ;
term        = factor { ( "*" | "/" ) factor } ;
factor      = unary [ "^" factor ] ;
unary       = [ "-" ] primary ;
primary     = quantity | ident { "." ident } | call | "(" expr ")" | signal | list | range ;
signal      = ( "V" | "I" ) "(" endpoint [ "," endpoint ] ")" ;
quantity    = number [ prefix ] [ unit ] ;
range       = expr ".." expr ;
list        = "[" [ expr { "," expr } ] "]" ;
annotation  = "@" ident [ "(" [ args ] ")" ] ;
```

## Appendix B — Example files to use as golden tests
- `examples/blinker.kirk`: §2. Expected: freq 6.86 Hz, duty 52.4 %.
- `examples/rc_lowpass.kirk`: RC 1.6 kΩ / 100 nF + op-amp buffer + `funcgen`, `meter`, `bode`. Expected: fc 995 Hz, DMM 0.2500 V rms at fc for a 1 Vpp input.
- `examples/sweep_r2.kirk`: the 555 with `sweep R2.value in [4.7k, 10k, 22k, 47k]`. Expected frequencies: 13.85 / 6.86 / 3.20 / 1.52 Hz.
- `examples/mc_yield.kirk`: 500 runs, R ±1 %, C ±10 %. Expected yield for 6.5–7.2 Hz ≈ 90 %.

---

## 17. Implementation status (2026-10-10)

The app currently uses the **KiCad symbol libraries** for parts and **ngspice** as the simulator (user decision; the Space Bench Engine of §10 can replace it later). Kirk compiles to the same schematic document the editor uses, which is netlisted for ngspice.

| Area | Status | Code |
|---|---|---|
| Lexer (SI prefixes, units, comments kept) | done | `kirk/lexer.ts` |
| Parser (Appendix A subset, error recovery per line) | done — `component`, `for`, `behavior`, `logger`, `export` parse later | `kirk/parser.ts` |
| Part constructors ⇄ KiCad symbols (`R C L Pot D LED Zener Schottky NPN PNP NMOS PMOS Vdc Vsin Vpulse Vpwl Idc Isin Ipulse OpAmp NE555 Switch Battery lib("Lib:Name")`) | done | `kirk/kinds.ts` |
| Nets: chains, pin lists, `X'` reversal, `X(IN→OUT)`, `nc`, `_`, `supply`, `ground`, merging warnings | done | `kirk/compile.ts` |
| Units check (V102 …), unknown part/pin (V20x), ERC warnings (V30x) | done | `kirk/compile.ts` |
| Code → schematic: `layout` block positions & wires; drawn nets that no longer match the code are dropped and their pins get label stubs; nets that only gain pins keep their drawing; new parts are auto-placed | done | `kirk/compile.ts` |
| Schematic → code (`layout` block, polylines, pins by name) — round-trips every example exactly | done | `kirk/generate.ts` |
| `simulate`, `measure`, `assert`, `scope`, `meter`, `sweep`, `montecarlo`, `temp` | done (measurements: avg rms pp max min final at frequency period duty rise_time fall_time gain_db phase fc bandwidth) | `kirk/measure.ts`, `lib/runs.ts` |
| Editor: highlighting, diagnostics, completion (parts, pins after `U1.`, nets, constructors, functions), hover with live readings, inline measure/assert results, cursor ↔ canvas selection | done | `components/KirkEditor.tsx` |
| Comment-preserving patches for schematic edits (§9.2) | **not yet** — a schematic edit regenerates the code (comments are lost); code you type is kept until you edit the drawing | — |
| `component` with parameters (types, defaults, expressions, text), pins, nested components, `symbol box(…)`, `description` → ngspice `.subckt` per parameter set (§6.2) | done (2026-10-11) | `kirk/components.ts` |
| `library Name version "x.y.z"`, `import "file.kirk"`, `import library "Name"` | done (2026-10-11) | `kirk/compile.ts`, `lib/project.ts`, `lib/libraries.ts` |
| `stimulus { }` feeds, `environment { }` (→ room feeds) | done (2026-10-11) | `lib/stimulus.ts`, `lib/feeds.ts` |
| `for` generators, properties (`R1.MPN = …`), selections (`parts(R*, value:, on:)`), `check` design rules (§18) | done (2026-10-12) | `kirk/select.ts` |
| KiCad schematics: open `.kicad_sch` (KiCad 6–9) as a circuit + Kirk code; export a circuit as `.kicad_sch` (KiCad 8 format) (§18.5) | done (2026-10-12) | `kicad/schImport.ts`, `kicad/schExport.ts` |
| symbol drawing (§6.5), `behavior` (§6.3), `use … as`, `funcgen`/`bode`/`logger` statements | not yet | — |

---

## 18. Scripting a design (ideas from kicad-skip)

[kicad-skip](https://github.com/psychogenic/kicad-skip) scripts KiCad files from Python: select symbols by
reference or value, read and set any property, follow what is connected, clone parts. Kirk has the same
abilities as language, so they live in the circuit and run on every compile. (Written from scratch — no
kicad-skip code; kicad-skip is LGPL-2.1.)

### 18.1 `for` — repeat parts and wiring

```kirk
circuit Ladder {
    supply VCC = 5 V
    ground GND
    for i in 1..8 {
        R{i} = R(1k)
        N{i} -- R{i} -- N{i+1}
    }
    VCC -- N1
    N9 -- GND
}
```

- `for name in a..b` (whole numbers, both ends included, up or down) or `for name in [1, 2, 5]`; at most 1000 passes.
- In names, `{…}` takes the loop variables with `+ - *`: `R{i}`, `N{i+1}`, `LED{2*i-1}`, `R{row}{col}` (nested loops). No spaces inside the braces.
- The loop is unrolled before compiling; a name with a variable no loop defines is **V505**.

### 18.2 Properties — one part

```kirk
R1.footprint = "Resistor_SMD:R_0603_1608Metric"
R1.MPN = "RC0603FR-0710KL"
R1.`Manufacturer PN` = "…"        // names with spaces in backticks
R1.tol = 1 %                      // tol power voltage → the Tolerance / Power / Voltage fields
R1.value = 4.7k
R1.nosim = true                   // leave the part out of the simulation
```

Any other name is a field (KiCad property) of the part. The code made from the schematic writes footprints
and fields as these lines, so they survive editing the drawing.

### 18.3 Selections — many parts

```kirk
parts(R*).footprint = "Resistor_SMD:R_0603_1608Metric"
parts(C*, value: 100n).MPN = "CL10B104KB8NNNC"
parts(/U[0-9]+/, lib: "Amplifier_Operational:*").footprint = "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm"
parts(on: VCC)                     // every part with a pin on VCC
parts(R*, MPN: "")                 // resistors without an MPN
```

- The first argument is a glob over references (`R*`, `U?`, `C1*`) or a `/regex/`.
- Filters: `value:` (10k = 10000 = "10K"; text is a glob), `lib:` (symbol, glob), `on:` (a net), `footprint:` (glob; `""` = none), or any field name.
- A selection that picks nothing is a warning (**V504**).

### 18.4 `check` — design rules

```kirk
check connected(U1.OUT, R3.1)        // pins (U1.OUT), parts (R1: any of its pins) or nets (VCC)
check not connected(OUT, VCC)
check parts(C*).footprint            // every capacitor has a footprint
check parts(R*, value: 10k).value == 10k
check parts(R*).count >= 4
```

Checks run on every compile; a failure is **V510** and says what's wrong (which parts, which nets).

### 18.5 KiCad schematics

- **Import** (File → Import, `.kicad_sch` from KiCad 6–9): symbols, values, footprints, fields, `Sim.*`
  properties, wires, labels (local, global, hierarchical), power symbols, no-connects and the `.tran` / `.ac` /
  `.op` directives. A project-local symbol with the same pins as a bundled one (KiCad's rescue libraries) uses
  the bundled symbol; any other is taken from the file and saved with the circuit (`doc.symbols`). Only the
  root sheet is read; buses are skipped (labels on bus members still connect). The Kirk code is written from
  the imported drawing.
- **Export** (File → Export KiCad schematic…): a KiCad 8 `.kicad_sch` (opens in KiCad 8 and 9) — symbols with
  their pins and drawing, references, values, footprints, fields, `Sim.*` properties, wires, junctions,
  labels, no-connects and the analysis as a directive. KiCad's *Tools → Update Symbols from Library* swaps in
  its own symbol drawings.
- Tested: every built-in example and ten KiCad demo schematics export and import back with the same
  connections; every part pin of the demos lands on a wire, a pin or a no-connect.

