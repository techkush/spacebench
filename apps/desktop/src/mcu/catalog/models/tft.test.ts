// The TFT / OLED models against their usual Arduino libraries: each sketch is compiled by
// arduino-cli, run on the emulated board with the display wired to it, and the screen's RGBA
// picture (ModView.image) is checked at a few points — colours, rotation, text, touch.
//
// Libraries (installed into a scratch sketchbook — see devices.test.ts):
//   ARDUINO_DIRECTORIES_USER=~/.cache/spacebench-test-libs arduino-cli lib install "Adafruit ILI9341" \
//     XPT2046_Touchscreen "Adafruit SSD1306" "Adafruit GC9A01A" "GFX Library for Arduino" U8g2
//   plus Seeed's Arduino_ST7789_Fast fork (github.com/limengdu/Arduino_ST7789_Fast) copied into its libraries/.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import type { Connection, Diagram } from "../../diagram"
import { McuSim } from "../../sim"
import type { ModView } from "../look"

const cli = ["/opt/homebrew/bin/arduino-cli", "/usr/local/bin/arduino-cli"].find((p) => fs.existsSync(p))
const user = process.env.SB_ARDUINO_USER ?? path.join(os.homedir(), ".cache", "spacebench-test-libs")
const env = { ...process.env, ARDUINO_DIRECTORIES_USER: user }
const libs = cli ? execFileSync(cli, ["lib", "list"], { encoding: "utf8", env }) : ""
const has = (l: string) => libs.includes(l)
const cores = cli ? execFileSync(cli, ["core", "list"], { encoding: "utf8" }) : ""

type Board = "uno" | "mega" | "pico"
const FQBN: Record<Board, string> = { uno: "arduino:avr:uno", mega: "arduino:avr:mega", pico: "rp2040:rp2040:rpipico" }
const TYPE: Record<Board, string> = { uno: "wokwi-arduino-uno", mega: "wokwi-arduino-mega", pico: "wokwi-pi-pico" }

function build(board: Board, code: string): string | Uint8Array {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbtft-"))
  const sk = path.join(dir, "sketch"); fs.mkdirSync(sk)
  fs.writeFileSync(path.join(sk, "sketch.ino"), code)
  let h = 0; for (const ch of code) h = (h * 31 + ch.charCodeAt(0)) | 0
  execFileSync(cli!, ["compile", "--fqbn", FQBN[board], "--build-path", path.join(os.tmpdir(), `sbtft-build-${board}-${h >>> 0}`), "--output-dir", path.join(dir, "out"), sk], { encoding: "utf8", env, stdio: "pipe" })
  return board === "pico" ? new Uint8Array(fs.readFileSync(path.join(dir, "out", "sketch.ino.bin"))) : fs.readFileSync(path.join(dir, "out", "sketch.ino.hex"), "utf8")
}

type Img = NonNullable<ModView["image"]> & { data: Uint8ClampedArray }
class Run {
  readonly sim: McuSim
  serial = ""
  img: Img | undefined
  constructor(board: Board, code: string, type: string, wires: [string, string][]) {
    const d: Diagram = { version: 1, author: "", editor: "t", parts: [{ type: TYPE[board], id: "b", top: 0, left: 0, attrs: {} }, { type, id: "d", top: 0, left: 0, attrs: {} }], connections: wires.map(([a, b]) => [a.replace(/^/, ""), b, "", []] as Connection) }
    this.sim = new McuSim(d, build(board, code))
    this.sim.onSerial = (s) => (this.serial += s)
  }
  /** run until the sketch prints `until` (or `ms` of simulated time pass) */
  run(ms: number, until?: string) {
    for (let t = 0; t < ms; t += 50) {
      const f = this.sim.step(50, 50)
      const im = f.mods.get("d")?.image
      if (im?.data) this.img = im as Img
      if (until && this.serial.includes(until)) { for (let i = 0; i < 2; i++) { const g = this.sim.step(20, 20).mods.get("d")?.image; if (g?.data) this.img = g as Img } return this }
    }
    return this
  }
  px(x: number, y: number): [number, number, number] {
    const im = this.img!, i = (y * im.w + x) * 4
    return [im.data[i], im.data[i + 1], im.data[i + 2]]
  }
  /** pixels in a box whose colour matches */
  count(x0: number, y0: number, x1: number, y1: number, rgb: [number, number, number]) {
    let n = 0
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const p = this.px(x, y); if (p[0] === rgb[0] && p[1] === rgb[1] && p[2] === rgb[2]) n++ }
    return n
  }
}
const RED: [number, number, number] = [255, 0, 0], GREEN: [number, number, number] = [0, 255, 0], BLUE: [number, number, number] = [0, 0, 255]
const WHITE: [number, number, number] = [255, 255, 255], BLACK: [number, number, number] = [0, 0, 0]
const ok = (b: Board) => !!cli && (b !== "pico" || cores.includes("rp2040:rp2040"))

/** the red SPI TFT modules on the UNO: hardware SPI, CS 10, DC 9, RST 8 */
const UNO_TFT = (dc: string, rst: string, mosi: string, miso: string): [string, string][] => [["d:VCC", "b:5V"], ["d:GND", "b:GND.1"], ["d:CS", "b:10"], [`d:${dc}`, "b:9"], [`d:${rst}`, "b:8"], [`d:${mosi}`, "b:11"], ["d:SCK", "b:13"], [`d:${miso}`, "b:12"], ["d:LED", "b:5V"]]

describe.skipIf(!cli)("TFT and OLED displays with their libraries", { timeout: 600_000 }, () => {
  it.skipIf(!ok("uno"))("every display placed unwired / unpowered runs without errors and stays dark", () => {
    const types = ["wokwi-ili9341", "sb-2-8-tft-touch-ili9341-xpt2046", "sb-3-5-tft-480x320-touch-ili9488-xpt2046", "sb-round-display-for-xiao-1-28-gc9a01", "sb-grove-1-22-ips-display-240x240", "sb-ssd1306-oled-spi-7-pin", "sb-grove-oled-display-1-12-ssd1327-96-96-grey"]
    const d: Diagram = { version: 1, author: "", editor: "t", parts: [{ type: TYPE.uno, id: "b", top: 0, left: 0, attrs: {} }, ...types.map((type, i) => ({ type, id: `d${i}`, top: 0, left: 0, attrs: {} }))], connections: [] }
    const sim = new McuSim(d, build("uno", "void setup(){ pinMode(13, OUTPUT); } void loop(){ digitalWrite(13, !digitalRead(13)); delay(5); }"))
    types.forEach((_, i) => sim.setUi(`d${i}`, { pressed: true, v: { tx: 0.5, ty: 0.5 } }))
    let f = sim.step(50, 50)
    for (let t = 0; t < 300; t += 50) f = sim.step(50, 50)
    types.forEach((_, i) => {
      const im = f.mods.get(`d${i}`)?.image
      expect(im, types[i]).toBeDefined()
      if (im?.data) expect(im.data.some((v, k) => k % 4 !== 3 && v > 20), types[i]).toBe(false)
    })
  })

  it.skipIf(!has("Adafruit ILI9341") || !ok("uno"))("ILI9341 (Wokwi element): fills, rectangles, rotation, text, ID reads", () => {
    const r = new Run("uno", `#include <Adafruit_GFX.h>
#include <Adafruit_ILI9341.h>
Adafruit_ILI9341 tft(10, 9, 8);
void setup(){ Serial.begin(115200); tft.begin();
  Serial.print("mode "); Serial.println(tft.readcommand8(ILI9341_RDMODE), HEX);
  Serial.print("madctl "); Serial.println(tft.readcommand8(ILI9341_RDMADCTL), HEX);
  Serial.print("id "); Serial.print(tft.readcommand8(0xD3, 2), HEX); Serial.println(tft.readcommand8(0xD3, 3), HEX);
  tft.fillScreen(ILI9341_BLUE); tft.fillRect(0, 0, 40, 30, ILI9341_RED);
  tft.setRotation(1); tft.fillRect(0, 0, 20, 10, ILI9341_GREEN);
  tft.setCursor(100, 100); tft.setTextColor(ILI9341_WHITE); tft.setTextSize(3); tft.print("Hi");
  Serial.println("done"); }
void loop(){}`, "wokwi-ili9341", UNO_TFT("D/C", "RST", "MOSI", "MISO")).run(8000, "done")
    expect(r.serial).toContain("done")
    expect(r.serial).toContain("mode 9C")
    expect(r.serial).toContain("madctl 48")
    expect(r.serial).toContain("id 9341")
    expect([r.img!.w, r.img!.h]).toEqual([240, 320])
    expect(r.px(5, 5)).toEqual(RED) // rotation 0: top-left
    expect(r.px(45, 5)).toEqual(BLUE)
    expect(r.px(200, 300)).toEqual(BLUE)
    // rotation 1 (landscape): its origin is the panel's top-right corner, x runs down the panel
    expect(r.px(235, 5)).toEqual(GREEN)
    expect(r.px(235, 25)).toEqual(BLUE)
    // "Hi" at landscape (100,100), 3× text: on the panel around x 115–139, y 100–136
    expect(r.count(110, 95, 145, 140, WHITE)).toBeGreaterThan(40)
    expect(r.count(0, 150, 100, 320, WHITE)).toBe(0)
  })

  it.skipIf(!has("Adafruit ILI9341") || !has("XPT2046_Touchscreen") || !ok("uno"))("2.8\" ILI9341 + XPT2046: drawing, and a touch on the screen reads back through XPT2046_Touchscreen", () => {
    const r = new Run("uno", `#include <Adafruit_GFX.h>
#include <Adafruit_ILI9341.h>
#include <XPT2046_Touchscreen.h>
Adafruit_ILI9341 tft(10, 9, 8);
XPT2046_Touchscreen ts(7, 2);
void setup(){ Serial.begin(115200); tft.begin(); ts.begin(); ts.setRotation(1); tft.setRotation(1);
  tft.fillScreen(ILI9341_BLACK); tft.fillCircle(160, 120, 30, ILI9341_YELLOW); Serial.println("ready"); }
void loop(){ if (ts.touched()) { TS_Point p = ts.getPoint(); Serial.print("T "); Serial.print(p.x); Serial.print(" "); Serial.print(p.y); Serial.print(" "); Serial.println(p.z);
    tft.fillRect(map(p.x, 200, 3900, 0, 320) - 2, map(p.y, 200, 3900, 0, 240) - 2, 5, 5, ILI9341_RED); }
  Serial.print("irq "); Serial.println(digitalRead(2)); delay(50); }`, "sb-2-8-tft-touch-ili9341-xpt2046",
      [...UNO_TFT("DC", "RESET", "SDI", "SDO"), ["d:T_CLK", "b:13"], ["d:T_CS", "b:7"], ["d:T_DIN", "b:11"], ["d:T_DO", "b:12"], ["d:T_IRQ", "b:2"]]).run(8000, "ready")
    expect(r.serial).toContain("ready")
    r.run(300)
    expect(r.serial).not.toContain("T ")
    expect(r.serial).toContain("irq 1")
    // the circle, centre landscape (160,120) → panel (119, 160)
    expect(r.px(119, 160)).toEqual([255, 255, 0])
    expect(r.px(10, 10)).toEqual(BLACK)
    // touch at 3/4 across, 1/4 down the (portrait) screen as drawn
    r.sim.setUi("d", { pressed: true, v: { tx: 0.75, ty: 0.25 } })
    const mark = r.serial.length
    r.run(600)
    const after = r.serial.slice(mark)
    const m = /T (\d+) (\d+) (\d+)/.exec(after)
    expect(m, after).not.toBeNull()
    const [x, y, z] = m!.slice(1).map(Number)
    // landscape (rotation 1): x along the long side = 1/4 down the portrait screen, y = 1 - 3/4
    expect(x).toBeGreaterThan(1000); expect(x).toBeLessThan(1250)
    expect(y).toBeGreaterThan(1000); expect(y).toBeLessThan(1250)
    expect(z).toBeGreaterThan(400)
    expect(after).toContain("irq 0")
    // the sketch marks the touch in landscape (≈80, 60) → panel (≈180, 80)
    expect(r.count(170, 70, 190, 90, RED)).toBeGreaterThan(5)
    r.sim.setUi("d", { pressed: false })
    const m2 = r.serial.length
    r.run(300)
    expect(r.serial.slice(m2)).not.toContain("T ")
  })

  it.skipIf(!has("GFX Library for Arduino") || !has("XPT2046_Touchscreen") || !ok("pico"))("3.5\" ILI9488 (18-bit, Arduino_GFX) + XPT2046 on the Pico", () => {
    const r = new Run("pico", `#include <Arduino_GFX_Library.h>
#include <XPT2046_Touchscreen.h>
#include <SPI.h>
Arduino_DataBus *bus = new Arduino_RPiPicoSPI(20 /*DC*/, 17 /*CS*/, 18 /*SCK*/, 19 /*MOSI*/, 16 /*MISO*/, spi0);
Arduino_GFX *gfx = new Arduino_ILI9488_18bit(bus, 21 /*RST*/, 0, false);
XPT2046_Touchscreen ts(15, 14);
void setup(){ Serial.begin(115200); gfx->begin(); gfx->fillScreen(RGB565_BLUE); gfx->fillRect(0, 0, 50, 40, RGB565_RED);
  gfx->setRotation(1); gfx->fillRect(0, 0, 30, 20, RGB565_GREEN);
  gfx->setTextColor(RGB565_WHITE); gfx->setTextSize(4); gfx->setCursor(200, 150); gfx->print("Pico");
  SPI.begin(); ts.begin(); ts.setRotation(1); Serial.println("ready"); }
void loop(){ if (ts.touched()) { TS_Point p = ts.getPoint(); Serial.print("T "); Serial.print(p.x); Serial.print(" "); Serial.println(p.y); } delay(30); }`,
      "sb-3-5-tft-480x320-touch-ili9488-xpt2046",
      [["d:VCC", "b:3V3"], ["d:GND", "b:GND.1"], ["d:CS", "b:GP17"], ["d:DC", "b:GP20"], ["d:RESET", "b:GP21"], ["d:SDI", "b:GP19"], ["d:SCK", "b:GP18"], ["d:SDO", "b:GP16"], ["d:LED", "b:3V3"],
        ["d:T_CLK", "b:GP18"], ["d:T_CS", "b:GP15"], ["d:T_DIN", "b:GP19"], ["d:T_DO", "b:GP16"], ["d:T_IRQ", "b:GP14"]]).run(15000, "ready")
    expect(r.serial).toContain("ready")
    expect([r.img!.w, r.img!.h]).toEqual([320, 480])
    // 18-bit colour: RGB565 red 0xF8 becomes the 6-bit level 62 → 251 on the glass
    const R6: [number, number, number] = [251, 0, 0], G6: [number, number, number] = [0, 130, 0] /* RGB565_GREEN is HTML green, 0x0400 */, B6: [number, number, number] = [0, 0, 251], W6: [number, number, number] = [251, 255, 251]
    expect(r.px(5, 5)).toEqual(R6)
    expect(r.px(60, 5)).toEqual(B6)
    expect(r.px(300, 470)).toEqual(B6)
    expect(r.px(315, 10)).toEqual(G6) // landscape origin at the panel's top-right
    // "Pico" at landscape (200,150), 4× text → panel x 320-150-32…320-150, y 200…296
    expect(r.count(320 - 150 - 32, 200, 320 - 150, 200 + 4 * 6 * 4, W6)).toBeGreaterThan(80)
    r.sim.setUi("d", { pressed: true, v: { tx: 0.25, ty: 0.5 } })
    const mark = r.serial.length
    r.run(400)
    const m = /T (\d+) (\d+)/.exec(r.serial.slice(mark))
    expect(m, r.serial.slice(mark)).not.toBeNull()
    expect(Number(m![1])).toBeGreaterThan(1900); expect(Number(m![1])).toBeLessThan(2200)
    expect(Number(m![2])).toBeGreaterThan(2800); expect(Number(m![2])).toBeLessThan(3100)
  })

  it.skipIf(!has("Adafruit GC9A01A") || !ok("uno"))("XIAO round display (GC9A01) on the UNO: colours, round mask, CHSC6X touch", () => {
    const r = new Run("uno", `#include <Adafruit_GFX.h>
#include <Adafruit_GC9A01A.h>
#include <Wire.h>
Adafruit_GC9A01A tft(10, 9);
void setup(){ Serial.begin(115200); Wire.begin(); pinMode(6, OUTPUT); digitalWrite(6, HIGH); pinMode(7, INPUT_PULLUP);
  tft.begin(); tft.fillScreen(GC9A01A_RED); tft.fillRect(100, 100, 40, 40, GC9A01A_GREEN); tft.setRotation(2); tft.fillRect(0, 100, 20, 40, GC9A01A_BLUE);
  Serial.println("ready"); }
void loop(){ if (digitalRead(7) == LOW) { uint8_t t[5]; Wire.requestFrom(0x2E, 5); for (int i = 0; i < 5; i++) t[i] = Wire.read();
    if (t[0] == 1) { Serial.print("T "); Serial.print(t[2]); Serial.print(" "); Serial.println(t[4]); } } delay(30); }`,
      "sb-round-display-for-xiao-1-28-gc9a01",
      [["d:D1", "b:10"], ["d:D3", "b:9"], ["d:D8", "b:13"], ["d:D10", "b:11"], ["d:D9", "b:12"], ["d:D6", "b:6"], ["d:D7", "b:7"], ["d:D4", "b:A4"], ["d:D5", "b:A5"]]).run(8000, "ready")
    expect(r.serial).toContain("ready")
    expect([r.img!.w, r.img!.h]).toEqual([240, 240])
    expect(r.px(60, 120)).toEqual(RED)
    expect(r.px(120, 120)).toEqual(GREEN)
    expect(r.px(2, 2)).toEqual([17, 17, 17]) // outside the round glass
    expect(r.px(230, 120)).toEqual(BLUE) // rotation 2: x mirrored
    r.sim.setUi("d", { pressed: true, v: { tx: 0.25, ty: 0.75 } })
    const mark = r.serial.length
    r.run(300)
    expect(r.serial.slice(mark)).toContain("T 60 180")
  })

  it.skipIf(!has("Fast ST7789 Library") || !ok("uno"))("Grove 1.22\" IPS (ST7789, 2-wire 9-bit serial) with Seeed's Arduino_ST7789_Fast", () => {
    const r = new Run("uno", `#include <Adafruit_GFX.h>
#include <Arduino_ST7789_Fast.h>
Arduino_ST7789 lcd(7, 8);
void setup(){ Serial.begin(115200); lcd.init(); lcd.fillRect(0, 0, 30, 20, RED); lcd.fillRect(200, 210, 20, 10, BLUE);
  lcd.setCursor(60, 100); lcd.setTextColor(WHITE, BLACK); lcd.setTextSize(2); lcd.print("Hi"); Serial.println("done"); }
void loop(){}`, "sb-grove-1-22-ips-display-240x240", [["d:GND", "b:GND.1"], ["d:VCC", "b:5V"], ["d:SCL", "b:7"], ["d:SDA", "b:8"]]).run(20000, "done")
    expect(r.serial).toContain("done")
    expect([r.img!.w, r.img!.h]).toEqual([240, 240])
    expect(r.px(5, 5)).toEqual(RED)
    expect(r.px(35, 5)).toEqual(BLACK) // INVON on the IPS glass: zero memory shows black
    expect(r.px(210, 215)).toEqual(BLUE)
    expect(r.count(60, 100, 84, 116, WHITE)).toBeGreaterThan(20)
  })

  it.skipIf(!has("Adafruit SSD1306") || !ok("uno"))("SSD1306 OLED over 4-wire SPI (Adafruit_SSD1306, hardware and software SPI)", () => {
    for (const hw of [true, false]) {
      const ctor = hw ? "Adafruit_SSD1306 oled(128, 64, &SPI, 9, 8, 10);" : "Adafruit_SSD1306 oled(128, 64, 11, 13, 9, 8, 10);"
      const r = new Run("uno", `#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
${ctor}
void setup(){ Serial.begin(115200); if (!oled.begin(SSD1306_SWITCHCAPVCC)) Serial.println("fail");
  oled.clearDisplay(); oled.fillRect(0, 0, 10, 8, SSD1306_WHITE); oled.drawPixel(127, 63, SSD1306_WHITE);
  oled.setTextSize(2); oled.setTextColor(SSD1306_WHITE); oled.setCursor(40, 30); oled.print("OK"); oled.display(); Serial.println("done"); }
void loop(){}`, "sb-ssd1306-oled-spi-7-pin", [["d:GND", "b:GND.1"], ["d:VCC", "b:5V"], ["d:D0", "b:13"], ["d:D1", "b:11"], ["d:RES", "b:8"], ["d:DC", "b:9"], ["d:CS", "b:10"]]).run(4000, "done")
      expect(r.serial).toContain("done")
      expect(r.serial).not.toContain("fail")
      const on: [number, number, number] = [0x9f, 0xe8, 0xff]
      expect(r.px(3, 3), hw ? "hw" : "sw").toEqual(on)
      expect(r.px(15, 3)).toEqual(BLACK)
      expect(r.px(127, 63)).toEqual(on)
      expect(r.count(40, 30, 64, 46, on)).toBeGreaterThan(30)
    }
  })

  it.skipIf(!has("U8g2") || !ok("uno"))("Grove OLED 1.12\" (SSD1327 96×96 grey) with U8g2, normal and flipped", () => {
    for (const flip of [0, 1]) {
      const r = new Run("uno", `#include <U8g2lib.h>
#include <Wire.h>
U8G2_SSD1327_SEEED_96X96_1_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE);
void setup(){ Serial.begin(115200); u8g2.begin(); u8g2.setFlipMode(${flip}); u8g2.firstPage();
  do { u8g2.drawBox(0, 0, 10, 6); u8g2.drawPixel(95, 95); u8g2.setFont(u8g2_font_6x10_tf); u8g2.drawStr(30, 50, "Grey"); } while (u8g2.nextPage());
  Serial.println("done"); }
void loop(){}`, "sb-grove-oled-display-1-12-ssd1327-96-96-grey", [["d:GND", "b:GND.1"], ["d:VCC", "b:5V"], ["d:SDA", "b:A4"], ["d:SCL", "b:A5"]]).run(8000, "done")
      expect(r.serial).toContain("done")
      expect([r.img!.w, r.img!.h]).toEqual([96, 96])
      const W: [number, number, number] = [255, 255, 255]
      const at = (x: number, y: number) => (flip ? r.px(95 - x, 95 - y) : r.px(x, y))
      expect(at(3, 3), `flip ${flip}`).toEqual(W)
      expect(at(12, 3)).toEqual(BLACK)
      expect(at(3, 8)).toEqual(BLACK)
      expect(at(95, 95)).toEqual(W)
      let n = 0
      for (let y = 40; y < 52; y++) for (let x = 30; x < 54; x++) if (at(x, y)[0] === 255) n++
      expect(n).toBeGreaterThan(20)
    }
  })
})
