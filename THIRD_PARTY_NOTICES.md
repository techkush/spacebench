# Third-party notices

Space Bench's own code is released under the [MIT licence](LICENSE). It is built on, bundles or talks to the
third-party work listed here, each under its own licence. Thank you to everyone behind these projects.

If you redistribute Space Bench (source or binaries), keep this file and the licence files it points to.

> The KiCad symbol libraries in `apps/desktop/public/kicad/` are **not** covered by the MIT licence; they
> stay under CC-BY-SA 4.0 with the KiCad library exception (section 1 below).

---

## 1. Material bundled in this repository / in the app

### KiCad symbol libraries — CC-BY-SA 4.0 (with the KiCad library exception)
- **Where:** `apps/desktop/public/kicad/` (index + one JSON file per library).
- **What:** the official [KiCad symbol libraries](https://gitlab.com/kicad/libraries/kicad-symbols) by the KiCad
  library team and contributors, **converted** from `.kicad_sym` to JSON (pins in grid units, graphics as SVG)
  by [`scripts/build-kicad-symbols.mjs`](scripts/build-kicad-symbols.mjs). No symbol was otherwise changed.
- **Licence:** [Creative Commons Attribution-ShareAlike 4.0](https://creativecommons.org/licenses/by-sa/4.0/legalcode)
  with the KiCad library exception — full text in
  [`apps/desktop/public/kicad/LICENSE.md`](apps/desktop/public/kicad/LICENSE.md). This folder is **not** covered by
  Space Bench's MIT licence; if you redistribute it (changed or not) it must stay CC-BY-SA 4.0 with this
  attribution.
- **Your designs are yours:** under the KiCad library exception, circuits drawn with these symbols — and files
  exported from them, such as `.kicad_sch`, netlists or Gerbers — carry no licence obligation.
- "KiCad" is a trademark of the KiCad project; Space Bench is not affiliated with or endorsed by it.

### RP2040 B1 boot ROM — BSD-3-Clause
- **Where:** `apps/desktop/src/mcu/rp2040-bootrom.ts` (the binary as a `Uint32Array`, taken from rp2040js's demo).
- **Source:** [raspberrypi/pico-bootrom](https://github.com/raspberrypi/pico-bootrom), revision B1
  (00a4a19114195e20fb817bdfbca1165e157eef37).

```
Copyright 2020 (c) 2020 Raspberry Pi (Trading) Ltd.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the
following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following
   disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following
   disclaimer in the documentation and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote
   products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES,
INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### Generic op-amp model — public domain
- `kicad_builtin_opamp` in `apps/desktop/src/lib/models.ts`: the simple single-pole op-amp by **Holger Vogt**,
  published in public domain with KiCad's `Simulation_SPICE` library.

### SPICE device parameters
- The BJT, MOSFET, JFET and diode parameter sets in `apps/desktop/src/lib/models.ts` (2N3904, 2N2222, BC547,
  2N7000, 1N4148, 1N400x …) are the widely published manufacturer / textbook values for those parts (numbers
  only, re-typed; no vendor model file is included).

### Fritzing part — CC-BY-SA 3.0 (test fixture only)
- `apps/desktop/src/mcu/__fixtures__/US-100.fzp`: *US-100 Ultrasonic Distance Sensor* by **Moritz Kanemeier**,
  from the [Fritzing parts](https://github.com/fritzing/fritzing-parts) collection
  ([CC-BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/)). Used only by the Fritzing import test; it is
  not part of the app.

---

## 2. JavaScript / TypeScript libraries (npm)

Shipped with the app:

| Package | Version | Licence |
|---|---|---|
| [@codemirror/autocomplete](https://code.haverbeke.berlin/codemirror/autocomplete) | 6.20.3 | MIT |
| [@codemirror/commands](https://code.haverbeke.berlin/codemirror/commands) | 6.11.1 | MIT |
| [@codemirror/language](https://code.haverbeke.berlin/codemirror/language) | 6.13.1 | MIT |
| [@codemirror/lint](https://code.haverbeke.berlin/codemirror/lint) | 6.9.7 | MIT |
| [@codemirror/search](https://code.haverbeke.berlin/codemirror/search) | 6.7.2 | MIT |
| [@codemirror/state](https://code.haverbeke.berlin/codemirror/state) | 6.7.6 | MIT |
| [@codemirror/view](https://code.haverbeke.berlin/codemirror/view) | 6.43.14 | MIT |
| [@fontsource-variable/geist](https://github.com/fontsource/font-files) | 5.3.0 | OFL-1.1 |
| [@fontsource-variable/geist-mono](https://github.com/fontsource/font-files) | 5.3.0 | OFL-1.1 |
| [@lezer/highlight](https://code.haverbeke.berlin/lezer/highlight) | 1.2.5 | MIT |
| [@monaco-editor/react](https://github.com/suren-atoyan/monaco-react) | 4.7.0 | MIT |
| [@tailwindcss/vite](https://github.com/tailwindlabs/tailwindcss) | 4.3.3 | MIT |
| [@tauri-apps/api](https://github.com/tauri-apps/tauri) | 2.12.2 | Apache-2.0 OR MIT |
| [@tauri-apps/plugin-dialog](https://github.com/tauri-apps/plugins-workspace) | 2.8.1 | MIT OR Apache-2.0 |
| [@tauri-apps/plugin-fs](https://github.com/tauri-apps/plugins-workspace) | 2.6.0 | MIT OR Apache-2.0 |
| [@tauri-apps/plugin-opener](https://github.com/tauri-apps/plugins-workspace) | 2.7.0 | MIT OR Apache-2.0 |
| [@wokwi/elements](https://github.com/wokwi/wokwi-elements) | 1.9.2 | MIT |
| [avr8js](https://github.com/wokwi/avr8js) | 0.21.0 | MIT |
| [class-variance-authority](https://github.com/joe-bell/cva) | 0.7.1 | Apache-2.0 |
| [cn](https://github.com/shadcn-ui/cn) | 0.4.0 | MIT |
| [fflate](https://github.com/101arrowz/fflate) | 0.8.3 | MIT |
| [lucide-react](https://github.com/lucide-icons/lucide) | 1.54.0 | ISC |
| [monaco-editor](https://github.com/microsoft/monaco-editor) | 0.55.1 | MIT |
| [next-themes](https://github.com/pacocoursey/next-themes) | 0.4.6 | MIT |
| [radix-ui](https://github.com/radix-ui/primitives) | 1.7.0 | MIT |
| [react](https://github.com/react/react) | 19.3.0 | MIT |
| [react-dom](https://github.com/react/react) | 19.3.0 | MIT |
| [rp2040js](https://github.com/wokwi/rp2040js) | 1.3.2 | MIT |
| [shadcn](https://github.com/shadcn-ui/ui) | 4.21.4 | MIT |
| [sonner](https://github.com/emilkowalski/sonner) | 2.0.8 | MIT |
| [tailwindcss](https://github.com/tailwindlabs/tailwindcss) | 4.3.3 | MIT |
| [three](https://github.com/mrdoob/three.js) | 0.180.0 | MIT |
| [tw-animate-css](https://github.com/Wombosvideo/tw-animate-css) | 1.4.0 | MIT |
| [uplot](https://github.com/leeoniya/uPlot) | 1.6.32 | MIT |

Used to build and test it (not shipped):

| Package | Version | Licence |
|---|---|---|
| [@tauri-apps/cli](https://github.com/tauri-apps/tauri) | 2.12.1 | Apache-2.0 OR MIT |
| [@types/node](https://github.com/DefinitelyTyped/DefinitelyTyped) | 24.19.1 | MIT |
| [@types/react](https://github.com/DefinitelyTyped/DefinitelyTyped) | 19.3.0 | MIT |
| [@types/react-dom](https://github.com/DefinitelyTyped/DefinitelyTyped) | 19.3.0 | MIT |
| [@types/three](https://github.com/DefinitelyTyped/DefinitelyTyped) | 0.180.0 | MIT |
| [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react) | 6.1.2 | MIT |
| [@xmldom/xmldom](https://github.com/xmldom/xmldom) | 0.9.12 | MIT |
| [oxlint](https://github.com/oxc-project/oxc) | 1.87.0 | MIT |
| [typescript](https://github.com/microsoft/TypeScript) | 6.0.3 | Apache-2.0 |
| [vite](https://github.com/vitejs/vite) | 8.3.4 | MIT |
| [vitest](https://github.com/vitest-dev/vitest) | 5.0.3 | MIT |

Their own dependencies (installed by `pnpm install`) are listed in `pnpm-lock.yaml`; all are under permissive
licences (MIT, ISC, BSD, Apache-2.0 and similar). Highlights worth naming:
[avr8js](https://github.com/wokwi/avr8js) and [rp2040js](https://github.com/wokwi/rp2040js) by **Uri Shaked**,
and [@wokwi/elements](https://github.com/wokwi/wokwi-elements) by **Wokwi** — the AVR / RP2040 emulators and part
drawings behind the Microcontrollers workspace.

---

## 3. Rust crates

Direct dependencies of the desktop shell and the `sb-engine` simulator:

| Crate | Version | Licence |
|---|---|---|
| [libloading](https://github.com/nagisa/rust_libloading/) | 0.7.4 | ISC |
| [log](https://github.com/rust-lang/log) | 0.4.34 | MIT OR Apache-2.0 |
| [num-complex](https://github.com/rust-num/num-complex) | 0.4.6 | MIT OR Apache-2.0 |
| [serde](https://github.com/serde-rs/serde) | 1.0.229 | MIT OR Apache-2.0 |
| [serde_json](https://github.com/serde-rs/json) | 1.0.151 | MIT OR Apache-2.0 |
| [tauri](https://github.com/tauri-apps/tauri) | 2.12.2 | Apache-2.0 OR MIT |
| [tauri-build](https://github.com/tauri-apps/tauri) | 2.7.1 | Apache-2.0 OR MIT |
| [tauri-plugin-dialog](https://github.com/tauri-apps/plugins-workspace) | 2.8.1 | Apache-2.0 OR MIT |
| [tauri-plugin-fs](https://github.com/tauri-apps/plugins-workspace) | 2.6.0 | Apache-2.0 OR MIT |
| [tauri-plugin-log](https://github.com/tauri-apps/plugins-workspace) | 2.10.0 | Apache-2.0 OR MIT |
| [tauri-plugin-opener](https://github.com/tauri-apps/plugins-workspace) | 2.7.1 | Apache-2.0 OR MIT |

All of their dependencies (see `Cargo.lock`) are under permissive licences — mostly MIT / Apache-2.0, with a few
under ISC, BSD-3-Clause, Zlib, Unicode-3.0 and Unlicense, and five under **MPL-2.0** (pulled in by Tauri's
WebView stack; their source is available from crates.io as MPL-2.0 requires).

---

## 4. External programs (not bundled — installed by the user or downloaded on request)

Space Bench starts these as **separate programs** (or, for ngspice, loads its shared library). None of their
code is copied into Space Bench.

| Program | Licence | Used for |
|---|---|---|
| [ngspice](https://ngspice.sourceforge.io) | BSD-3-Clause (modified BSD) | circuit simulation (required) |
| [arduino-cli](https://github.com/arduino/arduino-cli) and Arduino cores / libraries | GPL-3.0 (cores / libraries: their own licences, mostly LGPL) | compiling sketches |
| [Espressif QEMU](https://github.com/espressif/qemu) | GPL-2.0 | ESP32 / ESP32-S3 / ESP32-C3 emulation |
| [QEMU](https://www.qemu.org) | GPL-2.0 | the Raspberry Pi Linux VM |
| [Renode](https://github.com/renode/renode) | MIT | STM32 and nRF52 emulation |
| [Debian](https://www.debian.org) cloud image, Raspberry Pi archive packages (gpiozero, lgpio, RPi.GPIO …) | their own (free) licences | the Raspberry Pi system, downloaded into the VM on request |
| Linux `gpio-sim` / `irq_sim` | GPL-2.0 | the simulated GPIO controller, built inside the VM from kernel.org sources |
| [Claude Code](https://www.anthropic.com/claude-code) / the [Anthropic API](https://docs.anthropic.com) | Anthropic's terms | the optional AI assistant — used only with your own login or API key, only when you press Send |

---

## 5. References used while developing Space Bench

Ideas, formats and documentation this project learnt from. **No code from them is included** unless listed above.

- **[kicad-skip](https://github.com/psychogenic/kicad-skip)** (Pat Deegan, LGPL-2.1) — the idea of scripting a
  schematic: select parts by reference / value pattern, set any property, follow connectivity, clone parts. Kirk's
  `for`, `parts(…)`, property assignments and `check` statements are an independent TypeScript implementation of
  those ideas.
- **KiCad** — the [schematic and symbol file formats](https://dev-docs.kicad.org/en/file-formats/) (S-expressions)
  for `.kicad_sch` import / export, the library licence, and the
  [KiCad demo projects](https://gitlab.com/kicad/code/kicad/-/tree/master/demos), used locally to test the importer
  (not included in this repository).
- **[ngspice manual](https://ngspice.sourceforge.io/docs.html)** — netlist syntax, device models, the shared-library
  interface.
- **[Wokwi](https://docs.wokwi.com)** — the `diagram.json` format and the workflow of the Microcontrollers workspace.
- **Arduino, Raspberry Pi, Espressif, STMicroelectronics, Nordic, Microchip** datasheets and reference manuals —
  pinouts, registers and peripheral behaviour of the emulated boards and parts; manufacturer datasheets for the
  catalogue part models.
- **Circuit-simulation theory** (modified nodal analysis, Newton–Raphson, companion models — e.g. Vlach & Singhal,
  *Computer Methods for Circuit Analysis and Design*; Nagel's SPICE2 thesis) — the basis of the `sb-engine` crate,
  written from the published theory.
- **[Fritzing](https://fritzing.org)** — the `.fzp` / `.fzpz` part format for part import.
- **[Gerber X2](https://www.ucamco.com/en/gerber) and Excellon** specifications — PCB export; checked with
  [gerbonara](https://gitlab.com/gerbolyze/gerbonara) during development.
- **[Tauri](https://tauri.app), [React](https://react.dev), [shadcn/ui](https://ui.shadcn.com)** documentation.
- **[Contributor Covenant](https://www.contributor-covenant.org)** — the code of conduct.

Trademarks (KiCad, Arduino, Raspberry Pi, ESP32, STM32, Wokwi, Fritzing, Claude …) belong to their owners and are
used here only to describe compatibility.
