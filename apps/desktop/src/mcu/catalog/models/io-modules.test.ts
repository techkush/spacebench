// io-modules against their real Arduino libraries (or the documented raw protocol where the
// library doesn't run on an emulated board): each sketch is compiled with arduino-cli and run on
// the AVR emulator with the part wired to the Uno. Libraries live in the scratch sketchbook:
//   ARDUINO_DIRECTORIES_USER=~/.cache/spacebench-test-libs arduino-cli lib install "Adafruit PN532" \
//     "Adafruit IS31FL3731 Library" M5Chain
// plus Seeed's GitHub libraries copied into its libraries/ folder: Grove_Gesture,
// Grove_LED_Matrix_Driver_HT16K33, Seeed_RGB_LED_Matrix, PN532 (Seeed), Seeed_Arduino_KCT202,
// SeeedStudio_SMS812_Sensor.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import type { Connection, Diagram } from "../../diagram"
import { McuSim, type Frame } from "../../sim"

const cli = ["/opt/homebrew/bin/arduino-cli", "/usr/local/bin/arduino-cli"].find((p) => fs.existsSync(p))
const user = process.env.SB_ARDUINO_USER ?? path.join(os.homedir(), ".cache", "spacebench-test-libs")
const env = { ...process.env, ARDUINO_DIRECTORIES_USER: user }
const libs = cli ? execFileSync(cli, ["lib", "list"], { encoding: "utf8", env }) : ""
const has = (l: string) => libs.includes(l)

function build(code: string, fqbn = "arduino:avr:uno"): string | Uint8Array {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbio-"))
  const sk = path.join(dir, "sketch"); fs.mkdirSync(sk)
  fs.writeFileSync(path.join(sk, "sketch.ino"), code)
  let h = 0; for (const ch of fqbn + code) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  execFileSync(cli!, ["compile", "--fqbn", fqbn, "--build-path", path.join(os.tmpdir(), `sbio-build-${h.toString(16)}`), "--output-dir", path.join(dir, "out"), sk], { encoding: "utf8", env, stdio: "pipe" })
  return fqbn.startsWith("rp2040") ? new Uint8Array(fs.readFileSync(path.join(dir, "out", "sketch.ino.bin"))) : fs.readFileSync(path.join(dir, "out", "sketch.ino.hex"), "utf8")
}
const BOARDS = { uno: ["wokwi-arduino-uno", "arduino:avr:uno"], mega: ["wokwi-arduino-mega", "arduino:avr:mega"], pico: ["wokwi-pi-pico", "rp2040:rp2040:rpipico"] } as const
type P = [string, string, Record<string, string>?]
type Step = [number, (s: McuSim) => void]
function run(code: string, parts: P[], wires: [string, string][], opt: { ms?: number; steps?: Step[]; board?: keyof typeof BOARDS } = {}) {
  const [btype, fqbn] = BOARDS[opt.board ?? "uno"]
  const d: Diagram = { version: 1, author: "", editor: "t", parts: [{ type: btype, id: "uno", top: 0, left: 0, attrs: {} }, ...parts.map(([type, id, attrs]) => ({ type, id, top: 0, left: 0, attrs: attrs ?? {} }))], connections: wires.map(([a, b]) => [a, b, "", []] as Connection) }
  const sim = new McuSim(d, build(code, fqbn))
  let serial = ""
  const marks: number[] = []
  sim.onSerial = (s) => (serial += s)
  const steps = [...(opt.steps ?? [])].sort((a, b) => a[0] - b[0])
  const frames: Frame[] = []
  const images = new Map<string, Uint8ClampedArray>()
  for (let t = 0; t < (opt.ms ?? 1500); t += 50) {
    while (steps.length && steps[0][0] <= t) { marks.push(serial.length); steps.shift()![1](sim) }
    const f = sim.step(50, 50)
    frames.push(f)
    for (const [id, v] of f.mods) if (v.image?.data) images.set(id, v.image.data.slice())
  }
  const last = frames[frames.length - 1]
  /** serial printed after step k */
  const after = (k: number) => serial.slice(marks[k] ?? 0)
  /** serial printed before step k */
  const before = (k: number) => serial.slice(0, marks[k] ?? serial.length)
  return { serial, frames, last, images, after, before }
}
const px = (img: Uint8ClampedArray | undefined, x: number, y: number) => (img ? Array.from(img.slice((y * 8 + x) * 4, (y * 8 + x) * 4 + 3)) : [])
const I2C: [string, string][] = [["d:GND", "uno:GND.1"], ["d:VCC", "uno:5V"], ["d:SDA", "uno:A4"], ["d:SCL", "uno:A5"]]
const glyphRows = (hex: string) => Array.from({ length: 8 }, (_, r) => parseInt(hex.slice(14 - 2 * r, 16 - 2 * r), 16))

describe.skipIf(!cli)("io-modules with their libraries", { timeout: 300_000 }, () => {
  it.skipIf(!has("Grove Gesture"))("PAG7660 gesture sensor: Seeed Grove Gesture library reports the chosen gestures", () => {
    const r = run(`#include "Gesture.h"
pag7660 Gesture;
void setup(){ Serial.begin(115200); Serial.println(Gesture.init() ? "init ok" : "init fail"); }
void loop(){ pag7660_gesture_t g; if (Gesture.getResult(g)) { if (g.type >= 1 && g.type <= 5) { Serial.print(g.type); Serial.println("-finger"); }
  else if (g.type == 8) Serial.println("Swipe Left"); else if (g.type == 9) Serial.println("Swipe Right");
  else if (g.type == 6) Serial.println("Rotate Right"); else if (g.type >= 19 && g.type <= 23) { Serial.print(g.type - 18); Serial.println("-finger push"); }
  else if (g.type == 0 && g.cursor.select) { Serial.print("cursor "); Serial.println(g.cursor.type); } }
  delay(100); }`,
      [["sb-grove-smart-ir-gesture-sensor-pag7660", "d"]], I2C,
      { ms: 3000, steps: [[800, (s) => s.setUi("d", { v: { gesture: 8 } })], [1300, (s) => s.setUi("d", { v: { gesture: 3 } })], [1900, (s) => s.setUi("d", { v: { gesture: 12 } })], [2400, (s) => s.setUi("d", { v: { gesture: 17 } })]] })
    expect(r.serial).toContain("init ok")
    expect(r.after(0)).toMatch(/^Swipe Left\r?\n/) // a swipe is reported once
    expect(r.after(0).split("Swipe Left").length).toBe(2)
    expect(r.after(1).split("3-finger").length).toBeGreaterThan(3) // fingers are reported while shown
    expect(r.after(2)).toContain("3-finger push")
    expect(r.after(3)).toContain("cursor 1") // tap
  })

  it.skipIf(!has("Adafruit IS31FL3731"))("RGB Encoder Wheel: IO expander over raw Wire (ioe-python's sequence) + IS31FL3731 ring with Adafruit's library", () => {
    const r = run(`#include <Wire.h>
#include <Adafruit_IS31FL3731.h>
Adafruit_IS31FL3731 leds;
const uint8_t IOE = 0x13;
uint8_t rd(uint8_t reg){ Wire.beginTransmission(IOE); Wire.write(reg); Wire.endTransmission(); Wire.requestFrom(IOE, (uint8_t)1); return Wire.read(); }
void wr(uint8_t reg, uint8_t v){ Wire.beginTransmission(IOE); Wire.write(reg); Wire.write(v); Wire.endTransmission(); }
void setup(){ Serial.begin(115200); Wire.begin();
  Wire.beginTransmission(IOE); Wire.write(0xFA); Wire.endTransmission(); Wire.requestFrom(IOE, (uint8_t)2);
  uint16_t id = Wire.read(); id |= Wire.read() << 8; Serial.print("id "); Serial.println(id, HEX);
  wr(0xFE, rd(0xFE) | 0x02); while (rd(0xD0) != 0x78) delay(1); Serial.println("reset");
  wr(0x05, 3 | (12 << 4)); wr(0x04, rd(0x04) | 0x02); wr(0x04, rd(0x04) | 0x01); wr(0x06, 0);   // encoder 1 with microsteps
  wr(0x40, (1 << 3) | 7); wr(0x00, rd(0x00) | 0x80);                                             // up = P0.7 pull-up, interrupt
  wr(0xF9, rd(0xF9) | 0x02);                                                                     // INT output
  pinMode(2, INPUT_PULLUP);
  if (!leds.begin(0x77)) Serial.println("no leds"); leds.setLEDPWM(128, 200); leds.setLEDPWM(49, 90); }
void loop(){ int8_t c = rd(0x06); Serial.print("count "); Serial.print(c / 2); Serial.print(" up "); Serial.print((rd(0x40) >> 7) & 1);
  Serial.print(" int "); Serial.println(digitalRead(2)); delay(50); }`,
      [["sb-rgb-encoder-wheel", "d"]], [...I2C, ["d:INT", "uno:2"]],
      { ms: 2000, steps: [[900, (s) => s.setUi("d", { v: { turn: 5 } })], [1400, (s) => s.setUi("d", { v: { up: 1 } })]] })
    expect(r.serial).toContain("id E26A")
    expect(r.serial).toContain("reset")
    expect(r.serial).not.toContain("no leds")
    expect(r.before(0)).toMatch(/count 0 up 1 int 1/)
    expect(r.after(0)).toMatch(/count 5 up 1 int 0/) // the turn raised the interrupt
    expect(r.after(1)).toMatch(/count 5 up 0/)
    const pix = r.last.mods.get("d")?.pix ?? []
    expect(pix.length).toBe(24)
    expect(pix[0]).toEqual([200, 0, 0])
    expect(pix[1]).toEqual([0, 0, 90])
  })

  it.skipIf(!has("Adafruit PN532"))("PN532: Adafruit_PN532 finds a MIFARE Classic tag, authenticates, writes and reads a block", () => {
    const r = run(`#include <Wire.h>
#include <Adafruit_PN532.h>
Adafruit_PN532 nfc(2, 3);
void setup(){ Serial.begin(115200); nfc.begin(); uint32_t v = nfc.getFirmwareVersion(); Serial.print("fw "); Serial.println(v, HEX);
  nfc.SAMConfig(); nfc.setPassiveActivationRetries(0xFF); }
void loop(){ uint8_t uid[7], n; if (nfc.readPassiveTargetID(PN532_MIFARE_ISO14443A, uid, &n)) {
    Serial.print("uid "); Serial.print(n); for (uint8_t i = 0; i < n; i++) { Serial.print(" "); Serial.print(uid[i], HEX); } Serial.println();
    uint8_t key[6] = {0xFF,0xFF,0xFF,0xFF,0xFF,0xFF}, bad[6] = {1,2,3,4,5,6};
    Serial.println(nfc.mifareclassic_AuthenticateBlock(uid, n, 5, 0, bad) ? "bad key ok?" : "bad key refused");
    nfc.readPassiveTargetID(PN532_MIFARE_ISO14443A, uid, &n);
    if (nfc.mifareclassic_AuthenticateBlock(uid, n, 5, 0, key)) { uint8_t d[16] = "Space Bench NFC"; Serial.println(nfc.mifareclassic_WriteDataBlock(5, d) ? "written" : "write failed");
      uint8_t b[16]; if (nfc.mifareclassic_ReadDataBlock(5, b)) { Serial.print("read "); Serial.println((char*)b); } }
    while (1); } }`,
      [["sb-grove-nfc-pn532", "d"]], I2C, { ms: 2500, steps: [[1000, (s) => s.setUi("d", { v: { tag: 1, type: 0, uid: 0x1234 } })]] })
    expect(r.serial).toContain("fw 32010607")
    expect(r.before(0)).not.toContain("uid ")
    expect(r.after(0)).toContain("uid 4 DE 0 12 34")
    expect(r.after(0)).toContain("bad key refused")
    expect(r.after(0)).toContain("written")
    expect(r.after(0)).toContain("read Space Bench NFC")
  })

  it.skipIf(!has("PN532-Arduino"))("PN532: Seeed's PN532_I2C reads an NTAG213 and its pages keep what was written", () => {
    const r = run(`#include <Wire.h>
#include <PN532_I2C.h>
#include <PN532.h>
PN532_I2C bus(Wire); PN532 nfc(bus);
void setup(){ Serial.begin(115200); nfc.begin(); uint32_t v = nfc.getFirmwareVersion(); Serial.print("fw "); Serial.println(v, HEX); nfc.SAMConfig(); }
void loop(){ uint8_t uid[7], n;
  if (nfc.readPassiveTargetID(PN532_MIFARE_ISO14443A, uid, &n)) { Serial.print("uid "); Serial.println(n);
    uint8_t p[4]; if (nfc.mifareultralight_ReadPage(3, p)) { Serial.print("cc "); Serial.println(p[0], HEX); }
    uint8_t w[4] = {'S','B','!',0}; Serial.println(nfc.mifareultralight_WritePage(6, w) ? "page written" : "page failed");
    uint8_t q[4]; if (nfc.mifareultralight_ReadPage(6, q)) { Serial.print("page6 "); Serial.println((char*)q); }
    while (1); } }`,
      [["sb-grove-nfc-pn532", "d"]], I2C, { ms: 3000, steps: [[0, (s) => s.setUi("d", { v: { tag: 1, type: 1, uid: 42 } })]] })
    expect(r.serial).toContain("fw 32010607")
    expect(r.serial).toContain("uid 7")
    expect(r.serial).toContain("cc E1")
    expect(r.serial).toContain("page written")
    expect(r.serial).toContain("page6 SB!")
  })

  it.skipIf(!has("Grove - LED Matrix Driver(HT16K33"))("Grove Red LED Matrix w/Driver: Seeed's Matrix_8x8 icon shows upright (on the Pico — the library needs the C++ standard library)", () => {
    const r = run(`#include <Wire.h>
#include "Grove_LED_Matrix_Driver_HT16K33.h"
#include "I2Cdev.h"
Default_IIC_Adapter iic;
Matrix_8x8 matrix;
void setup(){ Wire.setSDA(4); Wire.setSCL(5); iic.begin(); matrix.init(&iic, 0x70); matrix.setBrightness(0); matrix.setBlinkRate(BLINK_OFF); matrix.writeIcon(1); matrix.display(); }
void loop(){}`,
      [["sb-grove-red-led-matrix-w-driver", "d"]], [["d:GND", "uno:GND.1"], ["d:VCC", "uno:3V3"], ["d:SDA", "uno:GP4"], ["d:SCL", "uno:GP5"]], { board: "pico", ms: 1500 })
    expect(r.last.mods.get("d")?.rows).toEqual(glyphRows("383838fe7c381000")) // arrow up
  })

  it.skipIf(!has("Seeed_RGB_Led_Matrix"))("Grove RGB LED Matrix w/Driver: VID, colour block and a bar", () => {
    const r = run(`#include "grove_two_rgb_led_matrix.h"
GroveTwoRGBLedMatrixClass matrix;
void setup(){ Wire.begin(); Serial.begin(115200); delay(100); Serial.print("vid "); Serial.println(matrix.getDeviceVID(), HEX);
  matrix.displayColorBlock(0x00ff00, 0, true); delay(600); matrix.displayBar(8, 0, true, blue); }
void loop(){}`,
      [["sb-grove-8x8-rgb-led-matrix-w-driver", "d"]], I2C, { ms: 1500 })
    expect(r.serial).toContain("vid 2886")
    const block = r.frames.map((f) => f.mods.get("d")?.image?.data).filter(Boolean)
    expect(block.length).toBeGreaterThan(0)
    const img = r.images.get("d")
    // bar level 8: the bottom two rows lit blue, the rest dark
    expect(px(img, 0, 7)[2]).toBeGreaterThan(200)
    expect(px(img, 0, 6)[2]).toBeGreaterThan(200)
    expect(px(img, 0, 5)).toEqual([0, 0, 0])
  })

  // M5Chain itself only builds for ESP32 (it calls HardwareSerial::begin(baud, cfg, rx, tx, …)),
  // so the Uno speaks its documented packet format directly.
  const CHAIN = `uint8_t rx[160]; int rn;
void send(uint8_t id, uint8_t cmd, const uint8_t* d, uint8_t n){ uint8_t len = n + 3, crc = id + cmd; Serial.write(0xAA); Serial.write(0x55); Serial.write(len); Serial.write((uint8_t)0);
  Serial.write(id); Serial.write(cmd); for (uint8_t i = 0; i < n; i++) { Serial.write(d[i]); crc += d[i]; } Serial.write(crc); Serial.write(0x55); Serial.write(0xAA); Serial.flush(); }
bool reply(uint8_t id, uint8_t cmd){ unsigned long t = millis(); rn = 0; while (millis() - t < 100) { while (Serial.available() && rn < 160) rx[rn++] = Serial.read();
  for (int i = 0; i + 8 < rn; i++) if (rx[i] == 0xAA && rx[i+1] == 0x55) { int size = 6 + rx[i+2]; if (i + size <= rn && rx[i+4] == id && rx[i+5] == cmd && rx[i+size-1] == 0xAA) { memmove(rx, rx + i, size); return true; } } } return false; }
uint8_t ask(uint8_t id, uint8_t cmd, const uint8_t* d, uint8_t n){ send(id, cmd, d, n); return reply(id, cmd) ? rx[6] : 0xEE; }`

  it("M5Stack Chain Mono matrix: heartbeat, enumeration, type, pixels (raw M5Chain protocol)", () => {
    const r = run(`${CHAIN}
void setup(){ Serial.begin(115200); uint8_t z = 0;
  send(0xFF, 0xFD, 0, 0); bool hb = reply(0xFF, 0xFD);
  uint8_t n = ask(0xFF, 0xFE, &z, 1); send(1, 0xFB, 0, 0); reply(1, 0xFB); uint16_t type = rx[6] | (rx[7] << 8);
  uint8_t m = 0; uint8_t ok1 = ask(1, 0x10, &m, 1);
  uint8_t px[3] = {2, (1 << 6) | (0 << 3) | 0, (1 << 6) | (3 << 3) | 2}; uint8_t ok2 = ask(1, 0x30, px, 3);
  Serial.print("hb "); Serial.print(hb); Serial.print(" n "); Serial.print(n); Serial.print(" type "); Serial.print(type); Serial.print(" ok "); Serial.print(ok1); Serial.println(ok2); }
void loop(){}`,
      [["sb-m5stack-chain-mono-matrix-8-8-white", "d"]], [["d:GND", "uno:GND.1"], ["d:VCC", "uno:5V"], ["d:RX", "uno:1"], ["d:TX", "uno:0"]], { ms: 800 })
    expect(r.serial).toContain("hb 1 n 1 type 13 ok 11")
    const img = r.images.get("d")
    expect(px(img, 0, 0)[0]).toBeGreaterThan(200)
    expect(px(img, 3, 2)[0]).toBeGreaterThan(200)
    expect(px(img, 1, 1)).toEqual([0, 0, 0])
  })

  it("M5Stack Chain: a Mono and an RGB matrix chained — two units, the second one's RGB565 pixels", () => {
    const r = run(`${CHAIN}
void setup(){ Serial.begin(115200); uint8_t z = 0;
  uint8_t n = ask(0xFF, 0xFE, &z, 1); send(2, 0xFB, 0, 0); reply(2, 0xFB); uint16_t type = rx[6] | (rx[7] << 8);
  uint8_t p[4] = {1, (4 << 3) | 5, 0x00, 0xF8}; uint8_t ok = ask(2, 0x30, p, 4);   // (4,5) red in RGB565
  Serial.print("n "); Serial.print(n); Serial.print(" type "); Serial.print(type); Serial.print(" ok "); Serial.println(ok); }
void loop(){}`,
      [["sb-m5stack-chain-mono-matrix-8-8-white", "d"], ["sb-m5stack-chain-rgb-matrix-8-8", "e"]],
      [["d:GND", "uno:GND.1"], ["d:VCC", "uno:5V"], ["d:RX", "uno:1"], ["d:TX", "uno:0"], ["e:GND", "uno:GND.2"], ["e:VCC", "uno:5V"]], { ms: 800 })
    expect(r.serial).toContain("n 2 type 14 ok 1")
    const img = r.images.get("e")
    expect(px(img, 4, 5)[0]).toBeGreaterThan(100)
    expect(px(img, 4, 5)[1]).toBe(0)
  })

  it("COB LED driver for XIAO: VCC always on, D0 switch, D2 dimmed by active-low PWM, D3 full", () => {
    const r = run(`void setup(){ pinMode(4, OUTPUT); digitalWrite(4, HIGH); pinMode(7, OUTPUT); digitalWrite(7, LOW); analogWrite(3, 191); analogWrite(5, 0); }
void loop(){}`,
      [["sb-cob-led-driver-board-for-xiao", "d"]], [["d:GND", "uno:GND.1"], ["d:5V", "uno:5V"], ["d:D0", "uno:4"], ["d:D1", "uno:7"], ["d:D2", "uno:3"], ["d:D3", "uno:5"]], { ms: 400 })
    const pix = r.last.mods.get("d")?.pix ?? []
    expect(pix[0][0]).toBe(255) // VCC
    expect(pix[1][0]).toBe(255) // D0 HIGH
    expect(pix[2][0]).toBe(0) // D1 LOW
    expect(pix[3][0]).toBeGreaterThan(50); expect(pix[3][0]).toBeLessThan(80) // 255 − 191 → 25 %
    expect(pix[4][0]).toBe(255) // analogWrite 0 = full on
    expect(pix[5][0]).toBe(0) // D8 not driven
  })

  it("Grove Recorder v3.0: REC held 1 s records, a PLAY pulse plays it for that long (Seeed's test sketch)", () => {
    const r = run(`const int pinRec = 3, pinPlay = 2;
void setup(){ pinMode(pinRec, OUTPUT); pinMode(pinPlay, OUTPUT); digitalWrite(pinRec, HIGH); digitalWrite(pinPlay, HIGH); delay(100);
  digitalWrite(pinRec, LOW); delay(1000); digitalWrite(pinRec, HIGH); delay(200); digitalWrite(pinPlay, LOW); delay(100); digitalWrite(pinPlay, HIGH); }
void loop(){}`,
      [["sb-grove-recorder-v3-0", "d"]], [["d:GND", "uno:GND.1"], ["d:VCC", "uno:5V"], ["d:SIG", "uno:2"], ["d:SIG2", "uno:3"]], { ms: 3200 })
    const tone = (f: Frame) => f.buzzer.get("d") ?? 0
    const glow = (f: Frame) => f.mods.get("d")?.glow?.[0] ?? 0
    expect(glow(r.frames[10])).toBe(1) // recording at 0.5 s
    expect(r.frames.slice(0, 26).every((f) => tone(f) === 0)).toBe(true)
    const playing = r.frames.slice(27, 46).filter((f) => tone(f) > 0).length
    expect(playing).toBeGreaterThan(10)
    expect(r.frames.slice(50).every((f) => tone(f) === 0)).toBe(true) // ~1 s of playback, then quiet
  })

  it("Grove 12-channel touch keypad: Seeed's sketch prints the touched keys (SoftwareSerial 9600)", () => {
    const r = run(`#include "SoftwareSerial.h"
SoftwareSerial mySerial(2, 3);
void setup(){ mySerial.begin(9600); Serial.begin(9600); Serial.println("Version:v1.0"); }
void loop(){ while (mySerial.available()) { uint8_t d = mySerial.read(); if (d >= 0xE1 && d <= 0xE9) Serial.println(d - 0xE0); else if (d == 0xEA) Serial.println("*"); else if (d == 0xEB) Serial.println("0"); else if (d == 0xEC) Serial.println("#"); } delay(10); }`,
      [["sb-grove-12-channel-capacitive-touch-keypad-attiny1616", "d"]], [["d:GND", "uno:GND.1"], ["d:VCC", "uno:5V"], ["d:TX", "uno:2"], ["d:RX", "uno:3"]],
      { ms: 1500, steps: [[400, (s) => s.setUi("d", { v: { key: 5 } })], [700, (s) => s.setUi("d", { v: { key: 0 } })], [800, (s) => s.setUi("d", { v: { key: 12 } })], [1100, (s) => s.setUi("d", { v: { key: 11 } })]] })
    expect(r.after(0).trim().split(/\r?\n/).filter(Boolean)).toEqual(["5", "#", "0"])
  })

  it.skipIf(!has("Seeed Arduino KCT202"))("Capacitive fingerprint scanner: Seeed_Arduino_KCT202 registers finger 3, verifies it and rejects finger 5", () => {
    // (the first println comes before kct202.begin(): the AVR emulator prints nothing at all when
    // Serial.begin() runs twice before the first byte — a simulator quirk, not this part's)
    const r = run(`#include "KCT202.h"
SoftwareSerial uart(10, 11);
FingerPrint_KCT202<SoftwareSerial, HardwareSerial> kct202;
void setup(){ Serial.begin(115200); Serial.println("KCT202 test"); kct202.begin(uart, Serial);
  kct202.controlBLN(KCT202_LED_BREATH, KCT202_LED_B);
  kct202.autoRegisterFingerPrint(1, 2, LED_OFF_AFTER_GET_GRAGH | PRETREATMENT_GRAGH | NOT_RET_FOR_EVERY_STEP | OVERRIDE_CURR_FINGER_PRINT);
  if (0 == kct202.getRegisterResponAndparse()) Serial.println("Register ok!");
  uint16_t id = 0;
  kct202.autoVerifyFingerPrint(CHECK_ALL_FINGER_TEMP, LED_OFF_AFTER_GET_GRAGH | PRETREATMENT_GRAGH | NOT_RET_FOR_EVERY_STEP);
  if (0 == kct202.getVerifyResponAndparse(id)) { Serial.print("Verify ok id "); Serial.println(id); }
  Serial.println("swap");
  delay(600);
  id = 0;
  kct202.autoVerifyFingerPrint(CHECK_ALL_FINGER_TEMP, LED_OFF_AFTER_GET_GRAGH | PRETREATMENT_GRAGH | NOT_RET_FOR_EVERY_STEP);
  if (0 == kct202.getVerifyResponAndparse(id)) { Serial.print("Verify ok id "); Serial.println(id); } else Serial.println("no match");
}
void loop(){}`,
      [["sb-grove-capacitive-fingerprint-scanner", "d"]], [["d:GND", "uno:GND.1"], ["d:VCC", "uno:5V"], ["d:TX", "uno:10"], ["d:RX", "uno:11"]],
      { board: "mega", ms: 4500, steps: [[300, (s) => s.setUi("d", { v: { finger: 3 } })], [2200, (s) => s.setUi("d", { v: { finger: 5 } })]] })
    expect(r.serial).toContain("Register ok!")
    expect(r.serial).toContain("Verify ok id 1")
    expect(r.serial.split("swap")[1]).toContain("no match")
  })

  it.skipIf(!has("SeeedStudio_SMS812"))("Grove UART ultrasonic (SMS812): the library's REQ mode reads distance and material", () => {
    const r = run(`#include "sms812.h"
SMS812_Sensor radar(&Serial);
void setup(){ Serial.begin(115200); radar.setUARTREQMode(); }
void loop(){ radar.checkUARTREQ(200, false); Serial.print("dist "); Serial.print(radar.distance); Serial.print(" mat "); Serial.println(radar.material); }`,
      [["sb-grove-ultrasonic-sensor-us5", "d"]], [["d:GND", "uno:GND.1"], ["d:VCC", "uno:5V"], ["d:RX", "uno:1"], ["d:TX", "uno:0"]],
      { ms: 2500, steps: [[1200, (s) => s.setUi("d", { v: { mm: 1234, soft: 1 } })]] })
    expect(r.serial.slice(0, r.serial.length - r.after(0).length)).toContain("dist 500 mat 0")
    expect(r.after(0)).toContain("dist 1234 mat 1")
  })

  it("parts left unwired or unpowered don't crash", () => {
    const parts: P[] = ["sb-grove-smart-ir-gesture-sensor-pag7660", "sb-rgb-encoder-wheel", "sb-grove-nfc-pn532", "sb-grove-red-led-matrix-w-driver", "sb-grove-8x8-rgb-led-matrix-w-driver",
      "sb-m5stack-chain-mono-matrix-8-8-white", "sb-m5stack-chain-rgb-matrix-8-8", "sb-cob-led-driver-board-for-xiao", "sb-grove-recorder-v3-0", "sb-grove-12-channel-capacitive-touch-keypad-attiny1616",
      "sb-grove-capacitive-fingerprint-scanner", "sb-grove-ultrasonic-sensor-us5"].map((t, i) => [t, `p${i}`])
    const r = run(`void setup(){ Serial.begin(115200); Serial.println("alive"); }
void loop(){}`, parts, [], { ms: 600, steps: [[200, (s) => { for (let i = 0; i < parts.length; i++) s.setUi(`p${i}`, { v: { gesture: 8, turn: 3, tag: 1, key: 4, finger: 2, button: 1 } }) }]] })
    expect(r.serial).toContain("alive")
  })
})
