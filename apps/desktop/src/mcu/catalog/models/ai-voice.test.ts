// AI vision and voice modules against their real libraries, compiled by arduino-cli and run on the
// emulated Uno (AVR) or Pico (RP2040). Libraries live in a scratch sketchbook (SB_ARDUINO_USER,
// default ~/.cache/spacebench-test-libs): HUSKYLENS (from github.com/HuskyLens/HUSKYLENSArduino —
// not in the library index), "Seeed Arduino SSCMA", "DFRobot_DF2301Q", "Seeed-GroveOfflineVoiceRecognition".
// The Grove Speech Recognizer and the ReSpeaker Lite have no library: their sketches are Seeed's
// own examples (SoftwareSerial byte read; Wire register reads at 0x42).
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import type { PartUi } from "../../circuit"
import type { Connection, Diagram } from "../../diagram"
import { McuSim } from "../../sim"
import { catalogPart } from "../index"
import { simulated } from "../types"
import { PARTS } from "./ai-voice.parts"

const cli = ["/opt/homebrew/bin/arduino-cli", "/usr/local/bin/arduino-cli"].find((p) => fs.existsSync(p))
const user = process.env.SB_ARDUINO_USER ?? path.join(os.homedir(), ".cache", "spacebench-test-libs")
const env = { ...process.env, ARDUINO_DIRECTORIES_USER: user }
const libs = cli ? execFileSync(cli, ["lib", "list"], { encoding: "utf8", env }) : ""
const has = (l: string) => libs.includes(l) || fs.existsSync(path.join(user, "libraries", l))
const hasPico = !!cli && execFileSync(cli, ["core", "list"], { encoding: "utf8" }).includes("rp2040:rp2040")

function build(code: string, fqbn = "arduino:avr:uno"): string | Uint8Array {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbai-"))
  const sk = path.join(dir, "sketch"); fs.mkdirSync(sk)
  fs.writeFileSync(path.join(sk, "sketch.ino"), code)
  execFileSync(cli!, ["compile", "--fqbn", fqbn, "--output-dir", path.join(dir, "out"), sk], { encoding: "utf8", env, stdio: "pipe" })
  return fqbn.startsWith("rp2040") ? new Uint8Array(fs.readFileSync(path.join(dir, "out", "sketch.ino.bin"))) : fs.readFileSync(path.join(dir, "out", "sketch.ino.hex"), "utf8")
}
type Opt = { board?: "uno" | "pico"; ms?: number; attrs?: Record<string, string>; then?: (s: McuSim) => void; thenMs?: number; ui?: PartUi }
function run(code: string, type: string, wires: [string, string][], o: Opt = {}) {
  const pico = o.board === "pico"
  const board = pico ? { type: "wokwi-pi-pico", id: "pico" } : { type: "wokwi-arduino-uno", id: "uno" }
  const d: Diagram = { version: 1, author: "", editor: "t", parts: [{ ...board, top: 0, left: 0, attrs: {} }, { type, id: "d", top: 0, left: 0, attrs: o.attrs ?? {} }], connections: wires.map(([a, b]) => [a, b, "", []] as Connection) }
  const sim = new McuSim(d, build(code, pico ? "rp2040:rp2040:rpipico" : "arduino:avr:uno") as never)
  let serial = ""
  sim.onSerial = (s) => (serial += s)
  if (o.ui) sim.setUi("d", o.ui)
  let f = sim.step(1, 1)
  for (let t = 0; t < (o.ms ?? 1500); t += 50) f = sim.step(50, 50)
  let after = ""
  if (o.then) { o.then(sim); const mark = serial.length; for (let t = 0; t < (o.thenMs ?? 1000); t += 50) f = sim.step(50, 50); after = serial.slice(mark) }
  return { serial, after, frame: f }
}
const UNO_I2C: [string, string][] = [["d:GND", "uno:GND.1"], ["d:VCC", "uno:5V"], ["d:SDA", "uno:A4"], ["d:SCL", "uno:A5"]]
const PICO_I2C: [string, string][] = [["d:GND", "pico:GND.1"], ["d:VCC", "pico:3V3"], ["d:SDA", "pico:GP4"], ["d:SCL", "pico:GP5"]]

describe("ai-voice catalogue entries", () => {
  it("every part in the family is simulated", () => {
    for (const type of Object.keys(PARTS)) {
      const c = catalogPart(type)
      expect(c, type).toBeTruthy()
      expect(simulated(c!), type).toBe(true)
      expect(c!.model.m, type).toBe("proto")
    }
  })
  it("an unwired part doesn't crash the simulator", () => {
    for (const type of Object.keys(PARTS)) {
      const d: Diagram = { version: 1, author: "", editor: "t", parts: [{ type: "wokwi-arduino-uno", id: "uno", top: 0, left: 0, attrs: {} }, { type, id: "d", top: 0, left: 0, attrs: {} }], connections: [] }
      const sim = new McuSim(d, ":00000001FF\n")
      sim.setUi("d", { active: true, v: { cmd: 3, n: 2, mute: 1 } })
      for (let i = 0; i < 4; i++) sim.step(50, 50)
    }
  })
})

describe.skipIf(!cli)("ai-voice modules with their libraries", { timeout: 300_000 }, () => {
  const HUSKY = `#include "HUSKYLENS.h"
HUSKYLENS h;
void show(){
  if (!h.request()) { Serial.println("req fail"); return; }
  Serial.print("n="); Serial.print(h.count()); Serial.print(" learned="); Serial.println(h.countLearnedIDs());
  while (h.available()) { HUSKYLENSResult r = h.read();
    Serial.print(r.command == COMMAND_RETURN_BLOCK ? "B" : "A"); Serial.print(" id="); Serial.print(r.ID);
    Serial.print(" "); Serial.print(r.xCenter); Serial.print(","); Serial.print(r.yCenter); Serial.print(","); Serial.print(r.width); Serial.print(","); Serial.println(r.height); }
}`
  it.skipIf(!has("HUSKYLENS"))("HuskyLens over I²C: knock, blocks with the chosen IDs and boxes, line-tracking arrows", () => {
    const r = run(`${HUSKY}
void setup(){ Serial.begin(115200); Wire.begin(); Serial.println(h.begin(Wire) ? "ok" : "no"); show();
  Serial.println(h.writeAlgorithm(ALGORITHM_LINE_TRACKING) ? "algo ok" : "algo no"); show(); }
void loop(){}`, "sb-huskylens-ai-vision-sensor", [["d:GND", "uno:GND.1"], ["d:VCC", "uno:5V"], ["d:T/SDA", "uno:A4"], ["d:R/SCL", "uno:A5"]],
      { attrs: { n: "2", id1: "1", x1: "100", y1: "120", w1: "40", h1: "50", id2: "0", x2: "250", y2: "60", w2: "30", h2: "20" }, ms: 1500 })
    expect(r.serial).toContain("ok")
    expect(r.serial).toContain("n=2 learned=1")
    expect(r.serial).toContain("B id=1 100,120,40,50")
    expect(r.serial).toContain("B id=0 250,60,30,20")
    expect(r.serial).toContain("algo ok")
    expect(r.serial).toContain("A id=1 100,120,40,50") // arrows: origin (100,120) → target (40,50)
  })
  it.skipIf(!has("HUSKYLENS"))("HuskyLens over UART (SoftwareSerial 9600): learn / forget and blocks by ID", () => {
    const r = run(`${HUSKY}
#include <SoftwareSerial.h>
SoftwareSerial s(10, 11);
void setup(){ Serial.begin(115200); s.begin(9600); Serial.println(h.begin(s) ? "ok" : "no");
  show(); Serial.println(h.writeForget() ? "forgot" : "x"); show();
  Serial.println(h.writeLearn(3) ? "learnt" : "x"); Serial.print("byid="); Serial.println(h.requestBlocks(3) ? h.count() : -1); }
void loop(){}`, "sb-huskylens-ai-vision-sensor", [["d:GND", "uno:GND.1"], ["d:VCC", "uno:5V"], ["d:T/SDA", "uno:10"], ["d:R/SCL", "uno:11"]],
      { attrs: { n: "1", id1: "3", x1: "160", y1: "100", w1: "64", h1: "48" }, ms: 3000 })
    expect(r.serial).toContain("ok")
    expect(r.serial).toContain("B id=3 160,100,64,48")
    expect(r.serial).toContain("forgot")
    expect(r.serial).toContain("B id=0 160,100,64,48")
    expect(r.serial).toContain("learnt")
    expect(r.serial).toContain("byid=1") // learning ID 3 again: the object in view is learned again
  })

  it.skipIf(!hasPico || !has("Seeed_Arduino_SSCMA"))("Grove Vision AI V2 (Pico): ID, name, INVOKE returns the configured boxes, then classes", () => {
    const sk = `#include <Seeed_Arduino_SSCMA.h>
SSCMA ai;
void setup(){ Serial.begin(115200); delay(800); Wire.begin(); Serial.println(ai.begin(&Wire) ? "begin ok" : "begin no");
  Serial.print("id="); Serial.println(ai.ID()); Serial.print("name="); Serial.println(ai.name()); }
void loop(){ if (!ai.invoke()) { for (auto &b : ai.boxes()) { Serial.printf("box t=%d s=%d %d,%d,%d,%d\\n", b.target, b.score, b.x, b.y, b.w, b.h); }
    for (auto &c : ai.classes()) { Serial.printf("class t=%d s=%d\\n", c.target, c.score); } Serial.printf("perf %d\\n", ai.perf().inference); } else Serial.println("invoke fail");
  delay(200); }`
    const r = run(sk, "sb-grove-vision-ai-module-v2", PICO_I2C, { board: "pico", ms: 2500, attrs: { n: "2", t1: "0", s1: "91", x1: "120", y1: "110", w1: "60", h1: "100", t2: "5", s2: "77", x2: "40", y2: "40", w2: "20", h2: "30" },
      then: (s) => s.setUi("d", { v: { model: 1 } }), thenMs: 1200 })
    expect(r.serial).toContain("begin ok")
    expect(r.serial).toContain("id=3a8f5d21")
    expect(r.serial).toContain("name=Grove Vision AI V2")
    expect(r.serial).toContain("box t=0 s=91 120,110,60,100")
    expect(r.serial).toContain("box t=5 s=77 40,40,20,30")
    expect(r.serial).toContain("perf 48")
    expect(r.after).toContain("class t=0 s=91")
    expect(r.after).toContain("class t=5 s=77")
  })
  it.skipIf(!hasPico || !has("Seeed_Arduino_SSCMA"))("Grove Vision AI V2 kit (OV5647): same module, its own device ID", () => {
    const r = run(`#include <Seeed_Arduino_SSCMA.h>
SSCMA ai;
void setup(){ Serial.begin(115200); delay(800); Wire.begin(); Serial.println(ai.begin(&Wire) ? "begin ok" : "begin no"); Serial.print("id="); Serial.println(ai.ID());
  if (!ai.invoke()) Serial.printf("boxes=%d\\n", (int)ai.boxes().size()); }
void loop(){}`, "sb-grove-vision-ai-v2-kit-ov5647-camera", PICO_I2C, { board: "pico", ms: 2000, attrs: { n: "3" } })
    expect(r.serial).toContain("begin ok")
    expect(r.serial).toContain("id=6c1e0a4f")
    expect(r.serial).toContain("boxes=3")
  })

  it("Grove Speech Recognizer: the chosen command's number arrives on SoftwareSerial (Seeed's example)", () => {
    const r = run(`#include <SoftwareSerial.h>
SoftwareSerial soft(2, 3);
void setup(){ Serial.begin(9600); soft.begin(9600); soft.listen(); Serial.println("ready"); }
void loop(){ if (soft.available()) { int cmd = soft.read(); Serial.print("cmd="); Serial.println(cmd); } }`,
      "sb-grove-speech-recognizer", [["d:GND", "uno:GND.1"], ["d:VCC", "uno:5V"], ["d:TX", "uno:2"], ["d:RX", "uno:3"]],
      { ms: 300, then: (s) => { s.setUi("d", { v: { cmd: 9 } }) }, thenMs: 600 })
    expect(r.after).toContain("cmd=9")
    // a click says the selected command again
    const r2 = run(`#include <SoftwareSerial.h>
SoftwareSerial soft(2, 3);
void setup(){ Serial.begin(9600); soft.begin(9600); }
void loop(){ if (soft.available()) { Serial.print("cmd="); Serial.println(soft.read()); } }`,
      "sb-grove-speech-recognizer", [["d:GND", "uno:GND.1"], ["d:VCC", "uno:5V"], ["d:TX", "uno:2"], ["d:RX", "uno:3"]],
      { ms: 300, attrs: { cmd: "22" }, then: (s) => { s.setUi("d", { active: true }); s.setUi("d", { active: false }) }, thenMs: 300 })
    expect(r2.after).toContain("cmd=22")
  })

  it.skipIf(!has("Seeed-GroveOfflineVoiceRecognition"))("Grove Offline Voice Recognition: library decodes the phrase said (115200 SoftwareSerial)", () => {
    const r = run(`#include "GroveOfflineSensor.h"
#include <SoftwareSerial.h>
SoftwareSerial groveSerial(3, 2);
void setup(){ Serial.begin(115200); groveSerial.begin(115200); Serial.println("ready"); }
void loop(){ uint8_t *v = detectVoiceFromGroveSensor(&groveSerial); if (v) { Serial.println(getCommandInString(v)); delete[] v; } delay(50); }`,
      "sb-grove-offline-voice-recognition-module", [["d:GND", "uno:GND.1"], ["d:VCC", "uno:5V"], ["d:TX", "uno:3"], ["d:RX", "uno:2"]],
      { ms: 300, then: (s) => s.setUi("d", { v: { cmd: 0x27 } }), thenMs: 700 })
    expect(r.after).toContain("ok, turn on the light")
  })

  it.skipIf(!has("DFRobot_DF2301Q"))("DF2301Q over I²C: settings registers, play, and the said command ID (latched until read)", () => {
    const r = run(`#include "DFRobot_DF2301Q.h"
DFRobot_DF2301Q_I2C asr;
void setup(){ Serial.begin(115200); Serial.println(asr.begin() ? "ok" : "no"); asr.setVolume(4); asr.setMuteMode(0); asr.setWakeTime(15);
  Serial.print("wake="); Serial.println(asr.getWakeTime()); asr.playByCMDID(23); Serial.println("played"); }
void loop(){ uint8_t id = asr.getCMDID(); if (id) { Serial.print("CMDID="); Serial.println(id); } delay(300); }`,
      "sb-gravity-df2301q-voice-recognition", UNO_I2C, { ms: 1500, then: (s) => s.setUi("d", { v: { cmd: 103 } }), thenMs: 1200 })
    expect(r.serial).toContain("ok")
    expect(r.serial).toContain("wake=15")
    expect(r.serial).toContain("played")
    expect(r.after.match(/CMDID=103/g)?.length).toBe(1) // reported once, then cleared
    expect(r.frame.mods.get("d")?.text).toBeTruthy()
  })
  it.skipIf(!has("DFRobot_DF2301Q"))("DF2301Q over UART (SoftwareSerial 9600): the ASR result frame gives the command ID", () => {
    const r = run(`#include "DFRobot_DF2301Q.h"
SoftwareSerial ss(4, 5);
DFRobot_DF2301Q_UART asr(&ss);
void setup(){ Serial.begin(115200); asr.begin(); Serial.println("ready"); }
void loop(){ uint8_t id = asr.getCMDID(); if (id) { Serial.print("CMDID="); Serial.println(id); } delay(100); }`,
      "sb-gravity-df2301q-voice-recognition", [["d:GND", "uno:GND.1"], ["d:VCC", "uno:5V"], ["d:SDA", "uno:4"], ["d:SCL", "uno:5"]],
      { ms: 400, then: (s) => s.setUi("d", { v: { cmd: 2 } }), thenMs: 800 })
    expect(r.after).toContain("CMDID=2")
  })

  it("ReSpeaker Lite: XMOS control at 0x42 (VNR, mic mute, version), buttons and the mute line", () => {
    const r = run(`#include <Wire.h>
#define XMOS_ADDR 0x42
uint8_t rd(uint8_t resid, uint8_t cmd, uint8_t *v, uint8_t n){ n++; Wire.beginTransmission(XMOS_ADDR); Wire.write(resid); Wire.write(cmd); Wire.write(n); Wire.endTransmission();
  Wire.requestFrom(XMOS_ADDR, n); uint8_t st = Wire.read(); for (uint8_t i = 0; i < n - 1; i++) v[i] = Wire.read(); return st; }
void setup(){ Serial.begin(115200); Wire.begin(); pinMode(2, INPUT_PULLUP); pinMode(3, INPUT_PULLUP);
  uint8_t fw[3]; rd(0xF0, 0xD8, fw, 3); Serial.print("fw="); Serial.print(fw[0]); Serial.print("."); Serial.print(fw[1]); Serial.print("."); Serial.println(fw[2]);
  Wire.beginTransmission(XMOS_ADDR); Wire.write(0xF1); Wire.write(0x10); Wire.write(1); Wire.write(0); Wire.endTransmission(); // speaker off
  Wire.beginTransmission(0x18); Wire.write(0); Wire.write(1); Wire.endTransmission(); Wire.beginTransmission(0x18); Wire.write(0x12); Wire.write(0x3A); Wire.endTransmission();
  Wire.beginTransmission(0x18); Wire.write(0x12); Wire.endTransmission(false); Wire.requestFrom(0x18, 1); Serial.print("codec="); Serial.println(Wire.read(), HEX); }
void loop(){ uint8_t v = 0, m = 0; uint8_t st = rd(0xF1, 0x80, &v, 1); rd(0xF1, 0x81, &m, 1);
  Serial.print("st="); Serial.print(st); Serial.print(" vnr="); Serial.print(v); Serial.print(" mute="); Serial.print(m); Serial.print(" usr="); Serial.println(digitalRead(2)); delay(200); }`,
      "sb-respeaker-lite-xmos-xu316", [["d:GND", "uno:GND.1"], ["d:5V", "uno:5V"], ["d:SDA", "uno:A4"], ["d:SCL", "uno:A5"], ["d:USR", "uno:2"], ["d:MUTE", "uno:3"]],
      { ms: 800, attrs: { vnr: "73" }, then: (s) => s.setUi("d", { v: { mute: 1, usr: 1 } }), thenMs: 600 })
    expect(r.serial).toContain("fw=1.1.0")
    expect(r.serial).toContain("codec=3A")
    expect(r.serial).toContain("st=0 vnr=73 mute=0 usr=1")
    expect(r.after).toContain("st=0 vnr=73 mute=1 usr=0")
    expect(r.frame.mods.get("d")?.text).toContain("spk off")
    // a host pulse on MUTE (ESPHome's mute toggle) toggles the mic mute
    const r2 = run(`#include <Wire.h>
uint8_t mute(){ Wire.beginTransmission(0x42); Wire.write(0xF1); Wire.write(0x81); Wire.write(2); Wire.endTransmission(); Wire.requestFrom(0x42, 2); Wire.read(); return Wire.read(); }
void setup(){ Serial.begin(115200); Wire.begin(); Serial.print("before="); Serial.println(mute());
  pinMode(3, OUTPUT); digitalWrite(3, LOW); delay(300); pinMode(3, INPUT); delay(10); Serial.print("after="); Serial.println(mute()); }
void loop(){}`, "sb-respeaker-lite-xmos-xu316", [["d:GND", "uno:GND.1"], ["d:5V", "uno:5V"], ["d:SDA", "uno:A4"], ["d:SCL", "uno:A5"], ["d:MUTE", "uno:3"]], { ms: 800 })
    expect(r2.serial).toContain("before=0")
    expect(r2.serial).toContain("after=1")
  })
})
