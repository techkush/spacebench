// spi-sensors with their real Arduino libraries: each sketch is compiled by arduino-cli and run
// on the AVR emulator with the part wired to hardware SPI. A test is skipped when its library
// isn't installed in the scratch sketchbook (SB_ARDUINO_USER, default ~/.cache/spacebench-test-libs):
//   ARDUINO_DIRECTORIES_USER=~/.cache/spacebench-test-libs arduino-cli lib install \
//     "Adafruit MAX31856 library" "Adafruit MAX31865 library" SD
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import type { PartUi } from "../../circuit"
import type { Connection, Diagram } from "../../diagram"
import { McuSim, type Frame } from "../../sim"
import { SdImage, rtdOhms } from "./spi-sensors"

const cli = ["/opt/homebrew/bin/arduino-cli", "/usr/local/bin/arduino-cli"].find((p) => fs.existsSync(p))
const user = process.env.SB_ARDUINO_USER ?? path.join(os.homedir(), ".cache", "spacebench-test-libs")
const env = { ...process.env, ARDUINO_DIRECTORIES_USER: user }
const libs = cli ? execFileSync(cli, ["lib", "list"], { encoding: "utf8", env }) : ""
const has = (l: string) => libs.split("\n").some((x) => x.startsWith(l + " ") || x.startsWith(l + "\t"))

const BOARDS = { uno: ["arduino:avr:uno", "wokwi-arduino-uno"], mega: ["arduino:avr:mega", "wokwi-arduino-mega"] } as const
function build(code: string, fqbn: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbspi-"))
  const sk = path.join(dir, "sketch"); fs.mkdirSync(sk)
  fs.writeFileSync(path.join(sk, "sketch.ino"), code)
  execFileSync(cli!, ["compile", "--fqbn", fqbn, "--output-dir", path.join(dir, "out"), sk], { encoding: "utf8", env })
  return fs.readFileSync(path.join(dir, "out", "sketch.ino.hex"), "utf8")
}
function run(code: string, type: string, wires: [string, string][], opt: { board?: keyof typeof BOARDS; ms?: number; ui?: PartUi; then?: PartUi; thenMs?: number } = {}) {
  const [fqbn, boardType] = BOARDS[opt.board ?? "uno"]
  const d: Diagram = { version: 1, author: "", editor: "t", parts: [{ type: boardType, id: "b", top: 0, left: 0, attrs: {} }, { type, id: "d", top: 0, left: 0, attrs: {} }], connections: wires.map(([a, b]) => [a, b, "", []] as Connection) }
  const sim = new McuSim(d, build(code, fqbn))
  let serial = ""
  sim.onSerial = (s) => (serial += s)
  if (opt.ui) sim.setUi("d", opt.ui)
  let f: Frame = sim.step(1, 1)
  for (let t = 0; t < (opt.ms ?? 1500); t += 50) f = sim.step(50, 50)
  const before = serial
  let after = ""
  if (opt.then) { sim.setUi("d", opt.then); for (let t = 0; t < (opt.thenMs ?? 1500); t += 50) f = sim.step(50, 50); after = serial.slice(before.length) }
  return { serial: before, after, frame: f, sim }
}
const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean)
const last = (s: string, tag: string) => lines(s).filter((l) => l.startsWith(tag)).pop() ?? ""
const nums = (l: string) => l.split(/\s+/).slice(1).map(Number)

const UNO_SPI = (sck: string, sdo: string, sdi: string): [string, string][] => [["d:GND", "b:GND.1"], ["d:VIN", "b:5V"], [`d:${sck}`, "b:13"], [`d:${sdo}`, "b:12"], [`d:${sdi}`, "b:11"], ["d:CS", "b:10"]]

describe("spi-sensors helpers", () => {
  it("PT100 Callendar–Van Dusen", () => {
    expect(rtdOhms(0, 100)).toBeCloseTo(100, 6)
    expect(rtdOhms(100, 100)).toBeCloseTo(138.5055, 3)
    expect(rtdOhms(-100, 100)).toBeCloseTo(60.2558, 3)
  })
  it("the SD image is a valid MBR + FAT16 volume with README.TXT", () => {
    const img = new SdImage({ "README.TXT": "hi" })
    const mbr = img.read(0)
    expect(mbr[510]).toBe(0x55); expect(mbr[511]).toBe(0xaa); expect(mbr[450]).toBe(0x06)
    const bs = img.read(2048)
    expect(bs[11] | (bs[12] << 8)).toBe(512)
    const clusters = Math.floor((img.total - img.dataStart) / bs[13])
    expect(clusters).toBeGreaterThan(4085); expect(clusters).toBeLessThan(65525)
    expect(img.files()).toEqual(["README.TXT"])
  })
})

describe.skipIf(!cli)("spi-sensors with real libraries", { timeout: 240_000 }, () => {
  it.skipIf(!has("Adafruit MAX31856 library"))("MAX31856 (Adafruit_MAX31856): hot and cold junction track the sliders; open fault", () => {
    const r = run(`#include <Adafruit_MAX31856.h>
Adafruit_MAX31856 tc(10);
void setup(){ Serial.begin(115200); Serial.println(tc.begin() ? "ok" : "no"); tc.setThermocoupleType(MAX31856_TCTYPE_K);
  Serial.print("type "); Serial.println((int)tc.getThermocoupleType()); }
void loop(){ float t = tc.readThermocoupleTemperature(); Serial.print("T "); Serial.print(t, 3); Serial.print(" "); Serial.print(tc.readCJTemperature(), 3);
  Serial.print(" "); Serial.println(tc.readFault()); delay(50); }`,
      "sb-max31856-universal-thermocouple", UNO_SPI("SCK", "SDO", "SDI"), { ms: 2000, then: { v: { t: 815.5, cj: 31.25 } } })
    expect(r.serial).toContain("ok")
    expect(last(r.serial, "type")).toBe("type 3")
    const [t, cj, f] = nums(last(r.serial, "T "))
    expect(t).toBeCloseTo(100, 1); expect(cj).toBeCloseTo(25, 1); expect(f).toBe(0)
    const [t2, cj2] = nums(last(r.after, "T "))
    expect(t2).toBeCloseTo(815.5, 1); expect(cj2).toBeCloseTo(31.25, 1)
    // negative temperatures and the open-thermocouple fault
    const r2 = run(`#include <Adafruit_MAX31856.h>
Adafruit_MAX31856 tc(10);
void setup(){ Serial.begin(115200); tc.begin(); tc.setConversionMode(MAX31856_CONTINUOUS); }
void loop(){ Serial.print("T "); Serial.print(tc.readThermocoupleTemperature(), 2); Serial.print(" "); uint8_t f = tc.readFault(); Serial.print(f);
  Serial.println(f & MAX31856_FAULT_OPEN ? " OPEN" : ""); delay(120); }`,
      "sb-max31856-universal-thermocouple", UNO_SPI("SCK", "SDO", "SDI"), { ms: 1000, ui: { v: { t: -45.75 } }, then: { v: { open: 1 } }, thenMs: 800 })
    const [tn, fn] = nums(last(r2.serial, "T "))
    expect(tn).toBeCloseTo(-45.75, 1); expect(fn).toBe(0)
    expect(last(r2.after, "T ")).toContain("OPEN")
  })

  it.skipIf(!has("Adafruit MAX31865 library"))("MAX31865 (Adafruit_MAX31865): PT100 temperature tracks the slider; faults", () => {
    const sketch = (r0: number, rref: number) => `#include <Adafruit_MAX31865.h>
Adafruit_MAX31865 rtd(10);
void setup(){ Serial.begin(115200); rtd.begin(MAX31865_3WIRE); }
void loop(){ uint16_t raw = rtd.readRTD(); Serial.print("T "); Serial.print(rtd.temperature(${r0}, ${rref}), 2); Serial.print(" "); Serial.print(raw);
  Serial.print(" "); Serial.println(rtd.readFault()); rtd.clearFault(); delay(20); }`
    const r = run(sketch(100, 430), "sb-max31865-pt100-rtd", UNO_SPI("CLK", "SDO", "SDI"), { ms: 1500, then: { v: { t: 312.4 } } })
    const [t, raw, f] = nums(last(r.serial, "T "))
    expect(t).toBeCloseTo(25, 0); expect(f).toBe(0)
    expect(raw).toBe(Math.round((rtdOhms(25, 100) / 430) * 32768))
    const [t2] = nums(last(r.after, "T "))
    expect(t2).toBeCloseTo(312.4, 0)
    // PT1000 with a 4300 Ω reference, below zero; then an open RTD (high-threshold fault)
    const r2 = run(sketch(1000, 4300), "sb-max31865-pt100-rtd", UNO_SPI("CLK", "SDO", "SDI"), { ms: 1200, ui: { v: { t: -80, r0: 1000, rref: 4300 } }, then: { v: { fault: 1 } }, thenMs: 800 })
    const [tn] = nums(last(r2.serial, "T "))
    expect(tn).toBeCloseTo(-80, 0)
    const [, rawOpen, fo] = nums(last(r2.after, "T "))
    expect(rawOpen).toBe(32767); expect(fo & 0x80).toBe(0x80)
  })

  it.skipIf(!has("SD"))("microSD (SD library): lists README.TXT, writes a file, reads it back, lists the root", () => {
    const r = run(`#include <SPI.h>
#include <SD.h>
void ls(){ File root = SD.open("/"); while (true) { File e = root.openNextFile(); if (!e) break; Serial.print("F "); Serial.print(e.name()); Serial.print(" "); Serial.println(e.size()); e.close(); } root.close(); Serial.println("END"); }
void setup(){ Serial.begin(115200); pinMode(2, INPUT_PULLUP);
  Serial.println(digitalRead(2) == LOW ? "card in" : "no card");
  if (!SD.begin(10)) { Serial.println("init failed"); return; }
  Serial.println("init ok"); ls();
  File r = SD.open("README.TXT"); Serial.print("R "); while (r.available() && r.position() < 9) Serial.write(r.read()); Serial.println(); r.close();
  File f = SD.open("data.txt", FILE_WRITE); if (!f) { Serial.println("open failed"); return; }
  for (int i = 0; i < 3; i++) { f.print("line "); f.println(i * 7); } f.close();
  f = SD.open("data.txt"); Serial.print("B "); while (f.available()) { char c = f.read(); Serial.write(c == '\\n' ? '|' : c == '\\r' ? ' ' : c); } Serial.println(); f.close();
  Serial.println(SD.exists("data.txt") ? "exists" : "missing");
  SD.mkdir("logs"); f = SD.open("logs/a.txt", FILE_WRITE); f.print("x"); f.close();
  ls(); }
void loop(){}`, "wokwi-microsd-card", [["d:GND", "b:GND.1"], ["d:VCC", "b:5V"], ["d:SCK", "b:13"], ["d:DO", "b:12"], ["d:DI", "b:11"], ["d:CS", "b:10"], ["d:CD", "b:2"]], { ms: 3000 })
    const out = r.serial
    expect(out, out).toContain("card in")
    expect(out, out).toContain("init ok")
    expect(out).toContain("F README.TXT")
    expect(out).toContain("R Space Ben")
    expect(out.replace(/\r/g, "")).toContain("B line 0 |line 7 |line 14 |")
    expect(out).toContain("exists")
    const second = out.slice(out.indexOf("exists"))
    expect(second).toContain("F README.TXT")
    expect(second).toContain("F DATA.TXT 25")
    expect(second).toContain("F LOGS")
    // the card taken out: CD goes high and SD.begin fails
    const gone = run(`#include <SD.h>
void setup(){ Serial.begin(115200); pinMode(2, INPUT_PULLUP); Serial.println(digitalRead(2) == LOW ? "card in" : "no card"); Serial.println(SD.begin(10) ? "init ok" : "init failed"); }
void loop(){}`, "wokwi-microsd-card", [["d:GND", "b:GND.1"], ["d:VCC", "b:5V"], ["d:SCK", "b:13"], ["d:DO", "b:12"], ["d:DI", "b:11"], ["d:CS", "b:10"], ["d:CD", "b:2"]], { ms: 3000, ui: { v: { card: 0 } } })
    expect(gone.serial).toContain("no card")
    expect(gone.serial).toContain("init failed")
  })
})
