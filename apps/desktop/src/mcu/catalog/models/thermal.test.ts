// Thermal cameras (MLX90640, MLX90641, MLX90621) with Melexis' drivers as packaged for Arduino,
// compiled for the Raspberry Pi Pico and run on rp2040js: the library reads the calibration
// EEPROM, takes frames and must get the scene back — Ta ≈ ambient, the background ≈ its slider
// and the hot spot at its row/column ≈ its temperature.
//   export ARDUINO_DIRECTORIES_USER=~/.cache/spacebench-test-libs ARDUINO_LIBRARY_ENABLE_UNSAFE_INSTALL=true
//   arduino-cli lib install "Adafruit MLX90640"
//   arduino-cli lib install --git-url https://github.com/Seeed-Studio/Seeed_Arduino_MLX9064x.git
//   arduino-cli lib install --git-url https://github.com/DFRobot/DFRobot_MLX90621.git
//   npx vitest run src/mcu/catalog/models/thermal.test.ts
import { execFileSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import type { Connection, Diagram } from "../../diagram"
import { McuSim } from "../../sim"
import type { SimCtx } from "../devices"
import thermal, { eeprom640, eeprom641, eeprom621, frame621, frame640, frame641, hamming, params621, params640, params641, pixelTemps } from "./thermal"

const cli = ["/opt/homebrew/bin/arduino-cli", "/usr/local/bin/arduino-cli"].find((p) => fs.existsSync(p))
const user = process.env.SB_ARDUINO_USER ?? path.join(os.homedir(), ".cache", "spacebench-test-libs")
const env = { ...process.env, ARDUINO_DIRECTORIES_USER: user }
const libs = cli ? execFileSync(cli, ["lib", "list"], { encoding: "utf8", env }) : ""
const has = (l: string) => libs.includes(l)
const pico = !!cli && execFileSync(cli, ["core", "list"], { encoding: "utf8" }).includes("rp2040:rp2040")

function build(code: string): Uint8Array {
  const id = crypto.createHash("sha1").update(code).digest("hex").slice(0, 12)
  const dir = path.join(os.tmpdir(), `sbthermal-${id}`)
  const bin = path.join(dir, "out", "sketch.ino.bin")
  if (!fs.existsSync(bin)) {
    fs.mkdirSync(path.join(dir, "sketch"), { recursive: true })
    fs.writeFileSync(path.join(dir, "sketch", "sketch.ino"), code)
    execFileSync(cli!, ["compile", "--fqbn", "rp2040:rp2040:rpipico", "--build-path", path.join(dir, "build"), "--output-dir", path.join(dir, "out"), path.join(dir, "sketch")], { encoding: "utf8", env, stdio: "pipe" })
  }
  return new Uint8Array(fs.readFileSync(bin))
}
/** run on the Pico with the camera as "d" on GP4/GP5 until `done(serial)` or `seconds` */
const WIRES: [string, string][] = [["d:GND", "pico:GND.1"], ["d:VCC", "pico:3V3"], ["d:SDA", "pico:GP4"], ["d:SCL", "pico:GP5"]]
function run(code: string, type: string, v: Record<string, number>, seconds: number, done: (s: string) => boolean, wires = WIRES) {
  const d: Diagram = {
    version: 1, author: "", editor: "t",
    parts: [{ type: "wokwi-pi-pico", id: "pico", top: 0, left: 0, attrs: {} }, { type, id: "d", top: 0, left: 0, attrs: {} }],
    connections: wires.map(([a, b]) => [a, b, "", []] as Connection),
  }
  const sim = new McuSim(d, build(code))
  let serial = ""
  sim.onSerial = (s) => (serial += s)
  sim.setUi("d", { v })
  let frame = sim.step(1, 1)
  for (let t = 0; t < seconds * 1000 && !done(serial); t += 50) frame = sim.step(50, 50)
  return { serial, frame }
}
/** the last complete "R ..." line as numbers */
const result = (s: string) => { const l = s.split("\n").filter((x) => x.startsWith("R ") && x.endsWith("\r")).pop(); return l ? l.slice(2).trim().split(/\s+/).map(Number) : null }
const lines = (n: number) => (s: string) => s.split("\n").filter((x) => x.startsWith("R ") && x.endsWith("\r")).length >= n
/** slider value that centres the hot spot on a pixel */
const centre = (i: number, n: number) => ((i + 0.5) / n) * 100

// a scene: ambient 24.5 °C, background 21 °C, a 60 °C spot
const SCENE = { amb: 24.5, bg: 21, hot: 60, hs: 5 } // a spot that covers one pixel whole (its neighbours partly)

describe("thermal camera forward models (driver formulas in TypeScript)", () => {
  it("MLX90640: the driver's CalculateTo gets the scene back from the RAM words", () => {
    const P = params640(eeprom640(1)), ram = new Uint16Array(0x340)
    const temps = pixelTemps({ ...SCENE, x: 0.6, y: 0.3, d: 0.25 }, 32, 24, 75 / 110)
    for (const ctrl of [0x1901, 0x0901, 0x1d01]) for (const sub of [0, 1]) {
      frame640(ram, P, ctrl, sub, temps, SCENE.amb, 3.3)
      // GetVdd / GetTa / CalculateTo (emissivity 1)
      const s = (v: number) => (v > 32767 ? v - 65536 : v)
      const resCorr = 2 ** P.resolutionEE / 2 ** ((ctrl & 0xc00) >> 10)
      const vdd = (resCorr * s(ram[0x32a]) - P.vdd25) / P.kVdd + 3.3
      const ptat = s(ram[0x320]), art = (ptat / (ptat * P.alphaPTAT + s(ram[0x300]))) * 2 ** 18
      const ta = (art / (1 + P.KvPTAT * (vdd - 3.3)) - P.vPTAT25) / P.KtPTAT + 25
      expect(ta).toBeCloseTo(SCENE.amb, 1)
      const gain = P.gainEE / s(ram[0x30a]), mode = (ctrl & 0x1000) >> 5
      const cp = [s(ram[0x308]) * gain - P.cpOffset[0] * (1 + P.cpKta * (ta - 25)) * (1 + P.cpKv * (vdd - 3.3)),
        s(ram[0x328]) * gain - (P.cpOffset[1] + (mode === P.calibrationModeEE ? 0 : P.ilChessC[0])) * (1 + P.cpKta * (ta - 25)) * (1 + P.cpKv * (vdd - 3.3))]
      const ta4 = (ta + 273.15) ** 4
      for (let p = 0; p < 768; p++) {
        const il = Math.floor(p / 32) % 2, chess = il ^ (p % 2)
        if ((mode === 0 ? il : chess) !== sub) continue
        const conv = (Math.floor((p + 2) / 4) - Math.floor((p + 3) / 4) + Math.floor((p + 1) / 4) - Math.floor(p / 4)) * (1 - 2 * il)
        let ir = s(ram[p]) * gain - P.offset[p] * (1 + P.kta[p] * (ta - 25)) * (1 + P.kv[p] * (vdd - 3.3))
        if (mode !== P.calibrationModeEE) ir += P.ilChessC[2] * (2 * il - 1) - P.ilChessC[1] * conv
        ir -= P.tgc * cp[sub]
        const ac = (P.alpha[p] - P.tgc * P.cpAlpha[sub]) * (1 + P.KsTa * (ta - 25))
        const Sx = Math.sqrt(Math.sqrt(ac ** 3 * (ir + ac * ta4))) * P.ksTo[1]
        const to = Math.sqrt(Math.sqrt(ir / (ac * (1 - P.ksTo[1] * 273.15) + Sx) + ta4)) - 273.15
        expect(Math.abs(to - temps[p])).toBeLessThan(0.15)
      }
    }
  })
  it("the RAM words stay inside 16 bits from −20 °C to 300 °C at every ADC resolution", () => {
    const P0 = params640(eeprom640(1)), P1 = params641(eeprom641(2, 55)), ee = eeprom621(3)
    for (const hot of [-20, 300]) for (const res of [0, 1, 2, 3]) {
      const s = { amb: 60, bg: hot, hot, x: 0.5, y: 0.5, d: 0.2 }
      const r0 = new Uint16Array(0x340), r1 = new Uint16Array(0x1c0), r2 = new Uint16Array(0x94)
      frame640(r0, P0, 0x1801 | (res << 10), 0, pixelTemps(s, 32, 24, 0.7), -20, 3.3)
      frame641(r1, P1, 0x0801 | (res << 10), 1, pixelTemps(s, 16, 12, 0.7), -20, 3.3)
      frame621(r2, params621(ee, res), new Float64Array(64).fill(hot), -20)
      const sat = (a: Uint16Array) => a.some((w) => w === 0x7fff || w === 0x8000)
      expect([hot, res, sat(r0.slice(0, 768)), sat(r1.slice(0, 0x180)), sat(r2.slice(0, 64))]).toEqual([hot, res, false, false, false])
    }
  })
  it("the picture: iron palette, hottest where the spot is, redrawn (new version) only when the scene moves", () => {
    let now = 0
    const v: Record<string, number> = { amb: 24, bg: 20, hot: 80, hx: 25, hy: 50, hs: 20, spd: 0 }
    const ctx = { hz: 1e9, now: () => now, ctl: (k: string) => v[k] ?? 0, supply: () => 3.3, pin: () => null, hook: () => {}, level: () => null, drive: () => {} } as unknown as SimCtx
    const chip = thermal.chips!.mlx90640(ctx, 0x33)!
    const a = chip.view!()!.image!, b = chip.view!()!.image!
    expect(a.w).toBe(32); expect(a.h).toBe(24); expect(b.ver).toBe(a.ver)
    const px = (im: typeof a, x: number, y: number) => Array.from(im.data!.slice((y * im.w + x) * 4, (y * im.w + x) * 4 + 3))
    expect(px(a, 8, 12)[0]).toBeGreaterThan(240) // the spot: bright
    expect(px(a, 30, 2)).toEqual([0, 0, 0]) // the background: the cold end
    v.spd = 0.5; now = 0.4e9
    const c = chip.view!()!.image!
    expect(c.ver).not.toBe(a.ver)
  })
  it("MLX90641: Hamming-coded EEPROM and frames decode to the scene", () => {
    const ee = eeprom641(2, 110)
    for (let a = 16; a < 832; a++) {
      const w = ee[a], D = (i: number) => (w >> i) & 1
      expect(D(0) ^ D(1) ^ D(3) ^ D(4) ^ D(6) ^ D(8) ^ D(10) ^ D(11)).toBe(0)
      let all = 0; for (let i = 0; i < 16; i++) all ^= D(i)
      expect(all).toBe(0)
      expect(hamming(w & 0x7ff)).toBe(w)
    }
    const P = params641(ee), ram = new Uint16Array(0x1c0)
    const temps = pixelTemps({ ...SCENE, x: 0.3, y: 0.6, d: 0.3 }, 16, 12, 75 / 110)
    for (const sub of [0, 1]) {
      frame641(ram, P, 0x0901, sub, temps, SCENE.amb, 3.3)
      const s = (v: number) => (v > 32767 ? v - 65536 : v)
      const vdd = (s(ram[0x1aa]) - P.vdd25) / P.kVdd + 3.3
      const ptat = s(ram[0x1a0]), art = (ptat / (ptat * P.alphaPTAT + s(ram[0x180]))) * 2 ** 18
      const ta = (art / (1 + P.KvPTAT * (vdd - 3.3)) - P.vPTAT25) / P.KtPTAT + 25
      expect(ta).toBeCloseTo(SCENE.amb, 1)
      const gain = P.gainEE / s(ram[0x18a]), ta4 = (ta + 273.15) ** 4
      for (let p = 0; p < 192; p++) {
        const ir = s(ram[64 * (p >> 5) + 32 * sub + (p & 31)]) * gain - P.offset[sub][p] * (1 + P.kta[p] * (ta - 25)) * (1 + P.kv[p] * (vdd - 3.3))
        const ac = P.alpha[p] * (1 + P.KsTa * (ta - 25))
        const Sx = Math.sqrt(Math.sqrt(ac ** 3 * (ir + ac * ta4))) * P.ksTo[2]
        const to = Math.sqrt(Math.sqrt(ir / (ac * (1 - P.ksTo[2] * 273.15) + Sx) + ta4)) - 273.15
        expect(Math.abs(to - temps[p])).toBeLessThan(0.15)
      }
    }
  })
  it("MLX90621: PTAT and IR words decode to Ta and the scene at every ADC resolution", () => {
    const ee = eeprom621(3)
    const temps = new Float64Array(64).map((_, i) => 20 + i)
    for (const res of [0, 1, 2, 3]) {
      const P = params621(ee, res), ram = new Uint16Array(0x94)
      frame621(ram, P, temps, SCENE.amb)
      const s = (v: number) => (v > 32767 ? v - 65536 : v)
      const ta = (-P.kT1 + Math.sqrt(P.kT1 ** 2 - 4 * P.kT2 * (P.vTh25 - s(ram[0x40])))) / (2 * P.kT2) + 25
      expect(Math.abs(ta - SCENE.amb)).toBeLessThan(0.15 * 2 ** (3 - res))
      const vcp = s(ram[0x41]) - (P.cpA + P.cpB * (ta - 25)), ta4 = (ta + 273.15) ** 4
      for (let i = 0; i < 64; i++) {
        const ir = s(ram[i]) - (P.ai[i] + P.bi[i] * (ta - 25)) - P.tgc * vcp
        const ac = (P.alpha[i] - P.tgc * P.cpAlpha) * (1 + P.KsTa * (ta - 25))
        expect(Math.abs((ir / ac + ta4) ** 0.25 - 273.15 - temps[i])).toBeLessThan(0.3 * 2 ** (3 - res))
      }
    }
  })
})

const SEEED_640 = (hx: number, hy: number) => `#include <Wire.h>
#include "MLX90640_API.h"
#include "MLX9064X_I2C_Driver.h"
const byte A = 0x33;
paramsMLX90640 params;
static uint16_t ee[832]; static uint16_t fr[834]; static float to[768];
void setup() {
  Serial.begin(115200); for (int i = 0; i < 300 && !Serial; i++) delay(10);
  Wire.setSDA(4); Wire.setSCL(5); Wire.begin(); Wire.setClock(400000);
  int s = MLX90640_DumpEE(A, ee);
  int e = MLX90640_ExtractParameters(ee, &params);
  MLX90640_SetRefreshRate(A, 0x05); // 16 Hz
  Serial.print("init "); Serial.print(s); Serial.print(" "); Serial.print(e); Serial.print(" "); Serial.println(MLX90640_GetRefreshRate(A));
}
void loop() {
  float ta = 0;
  for (int i = 0; i < 2; i++) {
    int sp = MLX90640_GetFrameData(A, fr);
    if (sp < 0) { Serial.print("err "); Serial.println(sp); return; }
    ta = MLX90640_GetTa(fr, &params);
    MLX90640_CalculateTo(fr, &params, 1.0, ta, to);
  }
  int m = 0; for (int i = 1; i < 768; i++) if (to[i] > to[m]) m = i;
  Serial.print("R "); Serial.print(ta, 2); Serial.print(" "); Serial.print(MLX90640_GetVdd(fr, &params), 3); Serial.print(" ");
  Serial.print(m / 32); Serial.print(" "); Serial.print(m % 32); Serial.print(" "); Serial.print(to[m], 2); Serial.print(" ");
  Serial.print(to[${hy * 32 + hx}], 2); Serial.print(" "); Serial.print(to[0], 2); Serial.print(" "); Serial.println(to[767], 2);
}
`
const SEEED_641 = (hx: number, hy: number) => `#include <Wire.h>
#include "MLX90641_API.h"
#include "MLX9064X_I2C_Driver.h"
const byte A = 0x33;
struct { paramsMLX90641 p; uint16_t pad[4]; } P; // the driver writes one broken-pixel slot past the struct
static uint16_t ee[832]; static uint16_t fr[242]; static float to[192];
void setup() {
  Serial.begin(115200); for (int i = 0; i < 300 && !Serial; i++) delay(10);
  Wire.setSDA(4); Wire.setSCL(5); Wire.begin(); Wire.setClock(400000);
  int s = MLX90641_DumpEE(A, ee);
  int e = MLX90641_ExtractParameters(ee, &P.p);
  MLX90641_SetRefreshRate(A, 0x05);
  Serial.print("init "); Serial.print(s); Serial.print(" "); Serial.println(e);
}
void loop() {
  float ta = 0;
  for (int i = 0; i < 2; i++) {
    int sp = MLX90641_GetFrameData(A, fr);
    if (sp < 0) { Serial.print("err "); Serial.println(sp); return; }
    ta = MLX90641_GetTa(fr, &P.p);
    MLX90641_CalculateTo(fr, &P.p, 1.0, ta, to);
  }
  int m = 0; for (int i = 1; i < 192; i++) if (to[i] > to[m]) m = i;
  Serial.print("R "); Serial.print(ta, 2); Serial.print(" "); Serial.print(MLX90641_GetVdd(fr, &P.p), 3); Serial.print(" ");
  Serial.print(m / 16); Serial.print(" "); Serial.print(m % 16); Serial.print(" "); Serial.print(to[m], 2); Serial.print(" ");
  Serial.print(to[${hy * 16 + hx}], 2); Serial.print(" "); Serial.print(to[0], 2); Serial.print(" "); Serial.println(to[191], 2);
}
`

describe.skipIf(!pico)("thermal cameras with Melexis' drivers on the Pico", { timeout: 600_000 }, () => {
  it.skipIf(!has("Seeed_Arduino_MLX9064X"))("MLX90640 (Seeed_Arduino_MLX9064x): Ta, background and the hot pixel", () => {
    const [hx, hy] = [20, 6]
    const r = run(SEEED_640(hx, hy), "sb-grove-thermal-imaging-camera-mlx90640-110", { ...SCENE, hx: centre(hx, 32), hy: centre(hy, 24) }, 12, lines(2))
    expect(r.serial).toContain("init 0 0 5")
    const v = result(r.serial)!
    expect(v, r.serial).not.toBeNull()
    const [ta, vdd, row, col, max, at, c0, c1] = v
    expect(ta).toBeCloseTo(24.5, 0); expect(vdd).toBeCloseTo(3.3, 1)
    expect([row, col]).toEqual([hy, hx]); expect(Math.abs(max - 60)).toBeLessThan(1); expect(Math.abs(at - 60)).toBeLessThan(1)
    expect(Math.abs(c0 - 21)).toBeLessThan(1); expect(Math.abs(c1 - 21)).toBeLessThan(1)
    const im = r.frame.mods.get("d")?.image
    expect(im?.w).toBe(32); expect(im?.h).toBe(24)
  })
  it.skipIf(!has("Seeed_Arduino_MLX9064X"))("MLX90640: a 250 °C spot on a −10 °C background (ksTo ranges), 19-bit ADC, interleaved mode", () => {
    const [hx, hy] = [3, 20]
    const code = SEEED_640(hx, hy).replace("MLX90640_SetRefreshRate(A, 0x05); // 16 Hz", "MLX90640_SetRefreshRate(A, 0x05); MLX90640_SetResolution(A, 3); MLX90640_SetInterleavedMode(A);")
    const r = run(code, "sb-grove-thermal-imaging-camera-mlx90640-110", { amb: 30, bg: -10, hot: 250, hs: 5, hx: centre(hx, 32), hy: centre(hy, 24) }, 12, lines(2))
    const [ta, , row, col, max, , c0, c1] = result(r.serial)!
    expect(ta).toBeCloseTo(30, 0)
    expect([row, col]).toEqual([hy, hx]); expect(Math.abs(max - 250)).toBeLessThan(1)
    expect(Math.abs(c0 + 10)).toBeLessThan(1); expect(Math.abs(c1 + 10)).toBeLessThan(1)
  })
  it.skipIf(!has("Seeed_Arduino_MLX9064X"))("an unpowered or unwired camera doesn't crash anything", () => {
    const off = run(SEEED_640(0, 0), "sb-grove-thermal-imaging-camera-mlx90640-110", {}, 2.5, (s) => s.includes("err"), [["d:GND", "pico:GND.1"], ["d:VCC", "pico:GND.2"], ["d:SDA", "pico:GP4"], ["d:SCL", "pico:GP5"]])
    expect(off.serial).toContain("init 0 -7") // the EEPROM reads 0xFFFF
    expect(off.frame.mods.get("d")?.image).toBeUndefined()
    const loose = run(SEEED_641(0, 0), "sb-grove-thermal-imaging-camera-mlx90641-bca-110", {}, 2.5, () => false, [])
    expect(loose.frame.warnings ?? []).not.toContain(expect.stringMatching(/error|exception/i))
  })
  it.skipIf(!has("Adafruit MLX90640"))("MLX90640 (Adafruit MLX90640): getFrame with its emissivity 0.95 and Tr = Ta − 8", () => {
    const [hx, hy] = [5, 17]
    const r = run(`#include <Adafruit_MLX90640.h>
Adafruit_MLX90640 mlx;
float f[768];
void setup() {
  Serial.begin(115200); for (int i = 0; i < 300 && !Serial; i++) delay(10);
  Wire.setSDA(4); Wire.setSCL(5);
  Serial.print("init "); Serial.println(mlx.begin(MLX90640_I2CADDR_DEFAULT, &Wire) ? "ok" : "no");
  Wire.setClock(400000);
  mlx.setMode(MLX90640_CHESS); mlx.setResolution(MLX90640_ADC_18BIT); mlx.setRefreshRate(MLX90640_16_HZ);
}
void loop() {
  if (mlx.getFrame(f) != 0) { Serial.println("err"); return; }
  int m = 0; for (int i = 1; i < 768; i++) if (f[i] > f[m]) m = i;
  Serial.print("R "); Serial.print(m / 32); Serial.print(" "); Serial.print(m % 32); Serial.print(" "); Serial.print(f[m], 2); Serial.print(" "); Serial.println(f[767], 2);
}
`, "sb-grove-thermal-imaging-camera-mlx90640-110", { ...SCENE, hx: centre(hx, 32), hy: centre(hy, 24) }, 12, lines(2))
    expect(r.serial).toContain("init ok")
    const [row, col, max, bg] = result(r.serial)!
    // what the driver reports for a black body when told ε = 0.95 and Tr = Ta − 8
    const seen = (t: number) => { const K = 273.15, ta4 = (24.5 + K) ** 4, tr4 = (16.5 + K) ** 4, taTr = tr4 - (tr4 - ta4) / 0.95; return (((t + K) ** 4 - ta4) / 0.95 + taTr) ** 0.25 - K }
    expect([row, col]).toEqual([hy, hx])
    expect(Math.abs(max - seen(60))).toBeLessThan(1); expect(Math.abs(bg - seen(21))).toBeLessThan(1)
  })
  for (const [type, label] of [["sb-grove-thermal-imaging-camera-mlx90641-bca-110", "BCA 110°"], ["sb-grove-thermal-imaging-camera-mlx90641-bcb-55", "BCB 55°"]]) {
    it.skipIf(!has("Seeed_Arduino_MLX9064X"))(`MLX90641 ${label} (Seeed_Arduino_MLX9064x): Ta, background and the hot pixel`, () => {
      const [hx, hy] = [11, 3]
      const r = run(SEEED_641(hx, hy), type, { ...SCENE, hs: 10, hx: centre(hx, 16), hy: centre(hy, 12) }, 12, lines(2))
      expect(r.serial).toContain("init 0 0")
      const [ta, vdd, row, col, max, at, c0, c1] = result(r.serial)!
      expect(ta).toBeCloseTo(24.5, 0); expect(vdd).toBeCloseTo(3.3, 1)
      expect([row, col]).toEqual([hy, hx]); expect(Math.abs(max - 60)).toBeLessThan(1); expect(Math.abs(at - 60)).toBeLessThan(1)
      expect(Math.abs(c0 - 21)).toBeLessThan(1); expect(Math.abs(c1 - 21)).toBeLessThan(1)
      expect(r.frame.mods.get("d")?.image?.w).toBe(16)
    })
  }
  it.skipIf(!has("DFRobot_MLX90621"))("MLX90621 BAB (DFRobot_MLX90621): Ta, background and the hot pixel", () => {
    const [hx, hy] = [12, 1]
    const r = run(`#include <DFRobot_MLX90621.h>
DFRobot_MLX90621 mlx;
void setup() { Serial.begin(115200); for (int i = 0; i < 300 && !Serial; i++) delay(10); Wire.setSDA(4); Wire.setSCL(5); mlx.initMLX90621(); Serial.print("init "); Serial.println(mlx.checkConfig() ? "por" : "ok"); } // checkConfig() is true after a power-on reset
void loop() {
  mlx.measureTemperature();
  int mc = 0, mr = 0; float m = -999;
  for (int c = 0; c < 16; c++) for (int r = 0; r < 4; r++) { float t = mlx.getTemperature(c + 1, r + 1); if (t > m) { m = t; mc = c; mr = r; } }
  Serial.print("R "); Serial.print(mlx.getAmbientTemperature(), 2); Serial.print(" "); Serial.print(mr); Serial.print(" "); Serial.print(mc); Serial.print(" ");
  Serial.print(m, 2); Serial.print(" "); Serial.print(mlx.getTemperature(${hx + 1}, ${hy + 1}), 2); Serial.print(" "); Serial.print(mlx.getTemperature(1, 1), 2); Serial.print(" "); Serial.println(mlx.getTemperature(16, 4), 2);
  delay(100);
}
`, "sb-grove-thermal-imaging-camera-mlx90621-bab-60", { ...SCENE, hs: 10, hx: centre(hx, 16), hy: centre(hy, 4) }, 8, lines(2))
    expect(r.serial).toContain("init ok")
    const [ta, row, col, max, at, c0, c1] = result(r.serial)!
    expect(ta).toBeCloseTo(24.5, 0)
    expect([row, col]).toEqual([hy, hx]); expect(Math.abs(max - 60)).toBeLessThan(1); expect(Math.abs(at - 60)).toBeLessThan(1)
    expect(Math.abs(c0 - 21)).toBeLessThan(1); expect(Math.abs(c1 - 21)).toBeLessThan(1)
    const im = r.frame.mods.get("d")?.image
    expect(im?.w).toBe(16); expect(im?.h).toBe(4)
  })
})
