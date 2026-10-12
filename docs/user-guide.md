# Space Bench — User guide

Circuit design and simulation desktop app: a shadcn/ui interface on Tauri 2, with the **KiCad symbol libraries** (22,905 parts) and **ngspice** as the simulator. Our own engine (`engine/`) and symbols can replace them later.

For an overview, installation and the repository layout see the [README](../README.md).


## Prerequisites
- Node 22+, pnpm
- Rust (rustup). In a new terminal run `source ~/.cargo/env` first (or add it to `~/.zshrc`).
- arduino-cli (for the Microcontrollers workspace): `brew install arduino-cli`.
- ngspice: `brew install ngspice` (macOS). The app looks in PATH, /opt/homebrew/bin and /usr/local/bin, or set `SPICEBENCH_NGSPICE`.

## Run
```sh
pnpm install            # from spicebench-app/ (or apps/desktop/)
pnpm dev                # builds the Rust side and opens the app (hot reload for UI and Rust)
```

## Test
```sh
pnpm test                 # editor + netlister + every example run end-to-end on ngspice (Vitest)
cargo test -p spicebench  # ngspice bridge (raw-file parser, RC transient/AC/OP)
cargo test -p sb-engine   # our own engine, validated against analytic solutions
```

## KiCad symbols
`public/kicad` is generated; to refresh it from the latest KiCad libraries run `pnpm kicad:symbols`.
The KiCad libraries are CC-BY-SA 4.0 with an exception for designs made with them (`public/kicad/LICENSE.md`).

## Simulation models
A part simulates if its symbol has KiCad `Sim.*` fields (the Simulation_SPICE library: VDC, VSIN, VPULSE, NPN, OPAMP …)
or if Space Bench can infer one: R/C/L/potentiometer, batteries, lamps/speakers/fuses (resistive), diodes, LEDs (colour from the value),
zeners (voltage from the name), BJTs/MOSFETs/JFETs (named models for 2N3904, 2N3906, 2N2222, BC547/557, BD139/140, TIP31/32,
2N7000, BS170, BSS138, IRF540N, IRFZ44N, IRLZ44N, IRF9540, 2N3819 …; otherwise a generic model, noted in the Inspector),
op-amps (any `Amplifier_Operational` part, per unit, GBW by family), 555 timers, 78xx/79xx/LDO/LM317 regulators and switches.
Other parts can be placed and wired; they're flagged "not simulated" and left out of the netlist.

## What works (milestone 1 — vertical slice)
- **Engine (phases E0–E3):**
  - nodal analysis with dense LU;
  - Newton–Raphson with junction limiting, gmin stepping and source stepping;
  - transient analysis (Backward Euler / trapezoidal, source breakpoints, step halving);
  - AC small-signal analysis;
  - devices: R, C, L, V/I sources (DC / SIN / PULSE / PWL), diode, VCCS, VCVS.
- **App:**
  - four example circuits drawn with Space Bench symbols;
  - one-click Simulate (F5) and live re-simulation when values change;
  - wires coloured by node voltage, with voltage tags and hover readouts;
  - oscilloscope and Bode plotter (uPlot) with automatic measurements, an operating-point view and a console;
  - inspector with SI-unit fields and a live-tune slider;
  - light and dark themes.

## Editor
| Action | How |
|---|---|
| Place a part | Click a tile in **Parts**, search the library, or press **R C L D Q V G N**; **A** / **⌘K** opens the part browser. Click to drop, keep clicking to place more, **Esc** to stop. Multi-unit ICs (LM358 …) continue with the next unit |
| Rotate / mirror | **⌘R** (or **R** while placing) · **X** |
| Duplicate | **⌘D** |
| Wire | **W**, click to start, click for corners (**/** flips the bend); ending on a pin or another wire finishes it; **Esc** / right-click stops |
| Select / move | Click, **Shift**-click to add, drag empty space to box-select; drag to move — attached wires stretch |
| Delete | **⌫** |
| Undo / redo | **⌘Z** / **⌘⇧Z** |
| Probe | **P**, click a wire (voltage) or a part (current) to add it to the scope |
| Pan / zoom | **Alt**-drag or middle mouse · scroll wheel · fit button |
| File | **⌘N** new · **⌘O** open · **⌘S** save (`.sbc` v2, JSON — interim format until Kirk files; v1 files convert on open) |

Nets come from the drawing: wire ends join whatever they touch (pins, wire ends, the middle of a wire), wires that only cross stay separate, net labels and power symbols with the same name join, GND/GNDA/Earth are node 0. The **ERC** badge lists problems (no ground, unconnected pins, duplicate references); simulation waits until they are fixed.

```sh
pnpm --filter desktop test   # connectivity + editing tests (Vitest)
```

## Kirk (our circuit language)
Press **⌘E** (or the **Kirk** tab in the title bar) for the code view: **Code / Split / Schematic**.
Typing compiles on the fly (≈ 5 ms) and redraws the schematic; drawing regenerates the code. Measurements and asserts
(`measure f = frequency(V(out), at: 2.5 V)`, `assert f in 6.5 Hz .. 7.2 Hz`) show their results inline after each run.
Spec: [`kirk-language-spec.md`](kirk-language-spec.md) (§17 = what is implemented).

## Simulation setup
⚙ next to the analysis picker: transient / AC / DC sweep / operating point, **parameter sweep** (list, linear, decade, octave),
**Monte Carlo** (tolerances from the Inspector, ±tol = 3σ, seeded), **temperature**, measurements and asserts.
Runs go to ngspice in parallel; the scope / Bode plotter overlay the trace family and the **Results** tab shows every run,
statistics (μ, σ, min … max) and the assert yield.

## Analysis & data
The **Analysis** tab in the title bar: every Simulate press and every sweep / Monte Carlo becomes a result set.
- **Results panel:** step family (runs), signals, and **math** traces written in Kirk (`V(out)*I(R1)`, `V(out)/V(in)`).
- **Plots:** Time, Bode, **FFT** (window, range, f₀, harmonics, THD), **X–Y**, **Histogram** of a measurement with spec limits taken from its asserts.
- **Measurements panel:** per-run `.meas` table, A/B cursors with Δ readouts, statistics (μ, σ, yield).
- **Report:** one HTML file with the circuit, plots, measurements, statistics, Kirk source and netlist.
- **Data export** (⤓ / CSV): source, signals, runs, from/to, resample Δt; **CSV, JSON, MAT** (MATLAB v4, readable by scipy);
  header with units, wide/long format, `.meas` summary, embedded netlist + settings; live preview; "Copy as Python (pandas)".

`pnpm dev` also lets the plain browser (http://localhost:5173) simulate: the Vite dev server runs ngspice (`vite-ngspice.ts`).

## Start screen & Settings
- **Start screen** (opens on launch; ⌘⇧H or the logo from the workspace): New schematic ⌘N, **New from code** ⌘⇧N,
  **Import** ⌘I (`.kirk`, or a SPICE netlist `.cir/.sp/.net` — R C L V I D Q M J, DC/AC/SIN/PULSE/PWL, `.tran/.ac/.op/.dc`;
  lines it cannot import are listed as comments), Open ⌘O; recent projects with previews (drafts included), examples by category,
  **Learn Kirk** (cheat sheet + starter programs), **Part library**, **Model database**, ⌘K search over projects, examples and parts.
- **Settings** (⌘,): start-up, theme (light/dark/system), schematic overlays, ngspice executable, run mode, parallel workers,
  RELTOL/ABSTOL/VNTOL/GMIN, integration method, auto-recovery from convergence errors, saving device currents, Kirk view and sync delay,
  probe behaviour, playback speed, keyboard shortcuts, licenses. Stored in localStorage (`sb-settings`).

## Simulation process (Runs)
The **Runs** tab (or click the status bar, or **Details** on a run toast) shows how each run turned the schematic into data:
seven stage cards with real timings (Schematic & ERC → Circuit IR → Models → Solver → Vectors & probes → Measure → Export),
a timeline with one bar per sweep / Monte Carlo run, the solver console, and run states — progress with **Pause / Stop**,
complete, recovered (auto-recovery retried with Gear + gmin stepping) and failed with **Show on schematic**, which selects the
parts the ngspice error points at (element and node names are mapped back to references). Run history keeps the last 30 runs.

## Instruments
Dock tabs: **Bench** (function generator, multimeter with V⎓ V~ A⎓ A~ true-RMS modes, oscilloscope and Bode plotter side by side —
the Bode **Sweep** runs an AC analysis in the background so the scope keeps its transient), Oscilloscope, Multimeter, Function gen,
Bode plotter (−3 dB edges from the peak, unwrapped phase, roll-off and order), **Spectrum** (FFT, window, harmonics, THD),
**Logic analyzer** (threshold with hysteresis, edges, frequency, duty), **Power meter** (V·I of every part, supplied vs dissipated,
resistor load vs rating) and **Curve tracer** (the part is swept on a test fixture with its own model: I_C–V_CE family for BJTs,
I_D–V_DS for FETs, forward I–V for diodes, with the circuit's operating point marked).
The right panel's **Instruments & data** tab lists every connection (FG, scope channels, DMM, Bode), records transients
(signals, trigger channel/edge/level, buffer) and exports the recording as CSV, and adds instruments.

## PCB
The **PCB** tab lays out the schematic on a two-layer board. Footprints are generated from KiCad footprint names
(DIP, SOIC, 0402–2512 chips, axial, radial, LED, TO-92, TO-220, SOT-23, pin headers) with KiCad pad numbering;
each part uses its own footprint field, its symbol's, or a default for its kind, and can be switched in the inspector.
New parts are auto-placed; drag to move, **R** rotate. Route by hand (**X**, click pad → points → pad, **V** via / layer)
or with the **auto-router** (A* on a 0.25 mm grid, both layers, clearance per net class, no vias in pads).
**DRC** runs live: unrouted connections (ratsnest), clearance and shorts, board edge, courtyard overlap, silk over pad.
**Auto-place** spreads parts over the board and pulls connected parts together (springs along nets). **Auto-router options**
(⚙): layers (both / top only / bottom only), grid, via and bend cost, order, rip-up and retry, one net or all, replace existing
tracks, auto label afterwards. **Auto label** (**L**) places every reference next to its part without overlapping pads, vias,
other references or the edge (drag a label to place it by hand, **R** while dragging turns it).
**Board size**: width × height, presets (Eurocard, Arduino shield, 10 cm fab limit…), **Fit to parts** with a margin, drag the
edge or corner (left / top edges keep the parts in place), corner radius, thickness and solder-mask colour; dimensions are drawn on the canvas.
**3D** (**3**): the board with its mask, copper, pads, holes and silkscreen, and a body for every part; orbit, top / front /
bottom views, hide parts, save an image.
**Export Gerbers** writes a zip: F/B copper, F/B mask, F paste, silkscreen, outline (Gerber X2) and an Excellon drill file —
checked with gerbonara, which reads every layer. The board is saved in the .sbc file (`doc.pcb`).

## Projects, components and libraries
**New project** makes one folder with everything: `circuits/*.kirk` (code + schematic layout + feeds —
the source of truth), `lib/*.kirk` (component libraries), `pcb/` (boards), `models/`, `results/`, a
`.sbproj` manifest and a cache. The workspace's **Project** tab shows the tree; ⌘S saves into the folder.

Kirk **components** are reusable parts with parameters and pins — they simulate as subcircuits and draw
as boxes:

```
library Filters version "0.2.0"
component RCLowPass(fc: Frequency = 1 kHz, c: Capacitance = 100n) {
    pins in, out, gnd
    R1 = R(1 / (2 * pi * fc * c))
    C1 = C(c)
    in -- R1 -- out -- C1 -- gnd
}
```

Use them with `import "lib/filters.kirk"` (a project library) or `import library "Filters"` (your own
libraries, ~/Documents/Space Bench/Libraries — managed on the **My Libraries** page: create, edit with live
checking, version, use in or copy into a project).

## Lab: feed data to the inputs, measure every part
**Lab** (title bar, opens its own window; needs a circuit without ERC errors) lists every input
of the open circuit — supplies and sources, sensors (LDR, photodiode, phototransistor, NTC/PTC,
microphone, LM35/TMP36), controls (pots, switches, buttons) and the room — and feeds them data
written in Kirk, saved with the circuit:

```
stimulus {
    seed: 7
    V1 = ramp(from: 12 V, to: 9 V, over: 40 ms)        // brown-out
    TH1 = walk(start: 24°C, sd: 0.6°C, every: 0.5 ms) // drifting temperature
    LDR1 = random(min: 1 lux, max: 10k lux, every: 2 ms)
    SW1 = square(low: 0, high: 1, period: 5 ms)
}
```

Signals: constants, `ramp step sine square random normal noise walk samples pwl`, combined with
`+ − * /`; CSV import. **Run** simulates with the feeds and reports, for every part, voltage,
current, power and a stress check against its ratings with derating (green < 90 %, yellow
90–100 %, red > 100 %, like PSpice Smoke); plots of each feed and of chosen signals; CSV export.
The AI can feed inputs too (`set_stimulus`).

## Circuit + firmware in one workspace

Put an Arduino in the schematic and simulate it with its sketch:

1. Place **Arduino_UNO_R3**, **Arduino_Nano_v3.x** or **RaspberryPi_Pico** from the part browser
   (library `MCU_Module`) and wire its pins like any other part — `D9`, `A0`, `+5V`, `GND` …
   (Kirk: `A1 = lib("MCU_Module:Arduino_UNO_R3")`, then `A1.D9 -- R1 -- OUT`).
2. The **Firmware** panel opens beside the drawing with a starter sketch. Edit `sketch.ino`; list
   libraries in `libraries.txt`. Select a board in the schematic to show its sketch.
3. Press **Run** (or **Simulate** with a Transient analysis). The sketches compile with
   arduino-cli, then the firmware and the circuit run together: the scope, meters, wire colours
   and LEDs update live and the **Serial Monitor** shows what the sketch prints (type a line to
   send it). **Stop** keeps the last two seconds on screen.

How it works: the chips run 20 ms at a time; every pin edge becomes a source on that pin (25 Ω
output, internal pull-ups), ngspice simulates the circuit over the same 20 ms starting from where
the last frame ended, and the voltages at the input and ADC pins are what the sketch reads next.
Outputs are exact to the edge; inputs see the circuit one frame late. Without a running sketch
(AC, DC sweep, OP) the board is just its 5 V / 3.3 V supplies.

Try **Examples → Microcontrollers → Arduino PWM DAC**: the Uno sweeps PWM through an RC filter
and reads the voltage back on A0.

## More boards: Raspberry Pi (Linux), STM32, nRF52, ATtiny85, ESP32-S3 / C3

**Raspberry Pi 5, 4B, 3B+, Zero 2 W** run real Linux and Python.
1. Install QEMU (`brew install qemu`), then **Settings → Microcontrollers → Linux Boards → Set up**:
   it downloads Debian 13 for arm64 and prepares it as a Raspberry Pi (Raspberry Pi's gpiozero,
   lgpio and RPi.GPIO, a simulated GPIO controller). About 1 GB and a few minutes, once.
2. Place a Pi: in a schematic, KiCad's **Connector → Raspberry_Pi_4** (a Pi 4B; put "Pi 5" in its
   Value for a Pi 5) or **Raspberry_Pi_2_3** (a Pi 3B+; "Zero 2" for a Zero 2 W); in the
   Microcontrollers canvas, the boards under **Raspberry Pi**.
3. Write `main.py` (gpiozero, RPi.GPIO, lgpio … as on a real Pi) and press **Run**. The Pi boots in
   about 3 s; GPIO0–27 on the 40-pin header are the circuit's. `print` goes to the **Program**
   tab; the **Terminal** is the Pi's console (logged in as `pi`) — `pip install …`, files, anything
   Linux. Packages you install stay installed.

The Pi isn't cycle-exact: Linux schedules its programs, so timing is real-time-ish (a `sleep(0.1)`
toggles every ~100 ms). Not yet: I²C / SPI / UART devices on the header, hardware PWM, the desktop.

**STM32F4 Discovery, STM32 Blue Pill, Arduino Nano 33 BLE** run their real firmware on Renode
(Settings → Microcontrollers → Install). Install the board's Arduino core from the
Microcontrollers page (STMicroelectronics:stm32, arduino:mbed_nano). In schematics, the bare
**STM32F407V…** and **STM32F103C8** symbols run as these boards. On the Nano 33 BLE use `Serial1`.

**ATtiny85** runs on avr8js (install ATTinyCore from the Microcontrollers page); its `Serial` is
software TX on PB0. **ESP32-S3 / ESP32-C3** DevKits run on Espressif's QEMU like the ESP32.

## Microcontrollers (Arduino)

Start screen → **Microcontrollers** (or ⌘⇧A): an Arduino workspace in the style of
Wokwi / Velxio, fully local.
- **Write and wire:** the sketch in Monaco; a board (Uno, Nano, Mega 2560) and parts on the
  canvas. Wire by clicking a pin, then another.
- **Compile:** with your `arduino-cli` (⌘B); libraries listed in `libraries.txt` install
  themselves.
- **Run (⌘↵):** the real firmware runs on an emulated chip (avr8js) in a Web Worker, in
  real time. The circuit around it is solved electrically, so LEDs dim with PWM and
  missing resistors are flagged.
- **Parts:** LEDs, RGB, 7-segment, bar graph, buzzer (you hear it), servo, LCD 16×2 / 20×4
  (I²C or parallel), SSD1306 OLED, NeoPixel, buttons, switches, pots, joystick, NTC,
  LDR, PIR, HC-SR04, DHT22.
- **Serial Monitor** with input. **AI assistant** that writes the sketch and the wiring,
  compiles, runs and reads the Serial output.
- **Files:** a sketch is a folder with `sketch.ino`, `diagram.json` (Wokwi format, so it
  copies to and from Wokwi) and `libraries.txt`. It lives in a project's `firmware/` or in
  `~/Documents/Space Bench/Sketches/`.

- **Boards:** Arduino Uno / Nano / Mega (avr8js), **Raspberry Pi Pico** (rp2040js, with USB serial and PIO), **ESP32 DevKit** (Espressif's QEMU, with a pin bridge over UART2).
- **Breadboards:** parts seat into the holes and connect.
- **Check with ngspice:** every part's current, voltage and power at that instant.
- **Logic Analyser:** pin traces, frequency and duty, VCD export.
- **Imported Fritzing parts** (.fzpz).

### Every catalogue part is simulated
No part is "Drawing only" any more: each one is modelled at the register / command / protocol level so its
usual Arduino library works unchanged. The models live in `src/mcu/catalog/models/`, one family per file, each
with tests that compile real sketches against the real libraries.
- **How parts connect:** hardware SPI (`SPI.transfer`, UNO D10–13, Mega 50–53, Pico SPI0/SPI1) reaches the
  part whose CS is low, and bit-banged SPI works too. A part on the board's hardware TX hears `Serial`
  (`Serial1` on the Pico), with SoftwareSerial anywhere else. On the Pico, I²C address probes
  (`begin()`, bus scans) are answered.
- **SPI sensors / storage:** MAX31856 thermocouple, MAX31865 PT100/PT1000, and a microSD card with a real
  FAT16 volume (`SD` library; CD pin).
- **Colour screens:** ILI9341, 2.8" ILI9341 + XPT2046 and 3.5" ILI9488 + XPT2046 (press or drag on the screen
  to touch), the round GC9A01 for XIAO, Grove 1.22" ST7789, SSD1306 over SPI, and the SSD1327 greyscale OLED.
- **E-paper (GxEPD2):** 1.54", 2.13" (B/W and 3-colour), 2.9" (B/W and 3-colour), 4.2", 5.65" 7-colour,
  7.5", plus the Grove 2.13" over UART. The picture changes only on a refresh, while BUSY is active.
- **Sensors:** BMA456 step counter, BMM150 compass, ADXL372, BMI088, AS3935 lightning (click for a strike),
  DPS310, SPA06-003, HP206C, and the MLX90640 / MLX90641 / MLX90621 thermal cameras (a scene with a
  hot spot, shown as a thermal picture).
- **Modules:** PAG7660 gesture, the RGB Encoder Wheel, PN532 NFC (MIFARE 1K / NTAG213 tags that keep
  their data), the Grove LED matrices, the M5Stack Chain matrices, the COB LED driver, the recorder, the
  12-key touch keypad, the fingerprint scanner, and the UART ultrasonic (SMS812).
- **Communication:** RS-232 and RS-485 pairs, the CAN module (Longan protocol), Wi-Fi AT modules
  (ESP8285, WizFi360) joining a **WiFi Access Point** part with a small simulated internet (HTTP, echo,
  NTP), HM-11 BLE and Serial Bluetooth (with each other or a virtual phone), the Wio-E5 (LoRaWAN join and
  messages, TEST-mode pairs), and Grove LoRa 433 / 868 (RadioHead, range from a distance slider).
- **AI / voice:** HuskyLens (I²C / UART), Grove Vision AI V2 (SSCMA), the speech and voice recognisers and the
  DF2301Q (choose what they "hear" and "see"), and ReSpeaker Lite (its I²C control).
- **On a Raspberry Pi board:** the Camera Module is `/dev/video0` showing a test scene (OpenCV / V4L2;
  picamera2 can't see it), and the ReSpeaker is a sound card (`arecord`, PyAudio). The assistant installs
  these add-ons once, asking first.

Limits: modules talk to each other only on the same board. ESP32 boards have no Wi-Fi (QEMU has no radio).
I²S audio isn't simulated.

Needs `arduino-cli` (`brew install arduino-cli`). The page installs the board cores for you (AVR, RP2040, ESP32). The ESP32 also needs Espressif's QEMU (Settings → Microcontrollers → Install, or ESP-IDF's).

## AI assistant
**AI** (title bar, the Kirk panel, or ⌘J in the desktop app) opens a chat beside the Kirk editor. Describe a circuit, ask for a
change, or attach / paste / drop a picture of a schematic: Claude writes the Kirk program (the schematic draws itself), simulates
it on ngspice, reads the numbers, fixes what is off, and connects probes or the multimeter when you ask ("probe the output").
Tools it uses: read the circuit, write Kirk, simulate (tran / AC / OP / DC), measure, add / remove probes, set the meter,
search the KiCad library. Nothing is sent until you press Send.

Two ways to connect (Settings → AI Assistant, or the chip in the panel header):
- **Claude Code CLI** (default) — runs `claude -p` with your Claude Code login; no API key. Claude Code's own tools are
  switched off (`--tools ""`, no MCP, no settings) and it runs in an empty temp folder; Space Bench's tools travel as
  `<tool …>` tags (`src/lib/ai/claudecode.ts`), and each chat is one resumed CLI session. The **terminal** pane in the
  panel shows every command, session, reply and cost line live. The desktop app runs it via Rust
  (`src-tauri/src/claude_code.rs`); `pnpm dev` in a browser uses the dev endpoint `/api/claude` (`vite-claude.ts`).
  Install: `npm install -g @anthropic-ai/claude-code`, then run `claude` once to log in.
- **Anthropic API key** — calls the Messages API directly (`src/lib/ai/claude.ts`).

### In the Microcontrollers workspace: it fixes what doesn't run
The workspace's assistant (`src/mcu/agent.ts`) writes the sketch — or a Raspberry Pi's `main.py` — wires the canvas,
compiles, runs and reads the Serial output. When something fails it finds the cause and fixes it:
- **Fix with assistant** — on a failed run (the error toast), a compile error (Output / Problems) and a Raspberry Pi
  program that crashed (a Python traceback). The assistant gets the error and starts on it.
- **Missing tools** — `check_setup` lists what the project's boards need on this computer (arduino-cli and the board's
  core, QEMU and the Raspberry Pi system, Renode, Espressif's QEMU; `src/mcu/setup.ts`); `install` installs one.
- **On the Pi** — `pi_shell` runs a command on the board (diagnostics, `pip install`, `apt-get install`).
- **It asks first.** Every install — and every Pi command that installs, removes or uses sudo — opens a dialog showing
  exactly what will run: *Allow* or *Don't allow*. Read-only checks (`pip list`, `ls`) don't ask. Homebrew packages are
  limited to `qemu` and `arduino-cli`.

Packages installed on the Pi stay installed: the guest writes to its disk within half a second and is synced before
the VM stops; a VM left behind by an earlier Space Bench (it held the disk's lock) is cleared on the next run.

## Next milestones
1. **PCB next:** footprints from the KiCad footprint library, copper pours / ground planes, push-and-shove routing, 3D view.
2. **Kirk next:** comment-preserving code patches, `component` definitions with drawn symbols, `for` generators, instruments as code.
3. **Engine E4–E5:** BJT/MOSFET models, sparse LU, adaptive timestep from truncation error, real-time mode with current-flow animation.
