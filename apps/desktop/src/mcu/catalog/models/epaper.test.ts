// E-paper panels with the real GxEPD2 library (and Seeed's Grove e-ink protocol): sketches are
// compiled by arduino-cli and run on the emulated board; the panel's RGBA picture is checked at
// known pixels, it must only change on a refresh, and BUSY must be asserted while it refreshes.
//   ARDUINO_DIRECTORIES_USER=~/.cache/spacebench-test-libs arduino-cli lib install GxEPD2
//   SB_ARDUINO_USER=~/.cache/spacebench-test-libs npx vitest run src/mcu/catalog/models/epaper.test.ts
import { execFileSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import type { Connection, Diagram } from "../../diagram"
import { McuSim } from "../../sim"
import { INK } from "./epaper"

const cli = ["/opt/homebrew/bin/arduino-cli", "/usr/local/bin/arduino-cli"].find((p) => fs.existsSync(p))
const user = process.env.SB_ARDUINO_USER ?? path.join(os.homedir(), ".cache", "spacebench-test-libs")
const env = { ...process.env, ARDUINO_DIRECTORIES_USER: user }
const libs = cli ? execFileSync(cli, ["lib", "list"], { encoding: "utf8", env }) : ""
const has = (l: string) => libs.includes(l)
const cores = cli ? execFileSync(cli, ["core", "list"], { encoding: "utf8" }) : ""

type Board = "uno" | "mega"
const BOARD = { uno: { type: "wokwi-arduino-uno", fqbn: "arduino:avr:uno" }, mega: { type: "wokwi-arduino-mega", fqbn: "arduino:avr:mega" } }

function build(code: string, fqbn: string): string {
  const id = crypto.createHash("sha1").update(fqbn + code).digest("hex").slice(0, 12)
  const dir = path.join(os.tmpdir(), `sbepd-${id}`)
  const hex = path.join(dir, "out", "sketch.ino.hex")
  if (fs.existsSync(hex)) return fs.readFileSync(hex, "utf8")
  fs.mkdirSync(path.join(dir, "sketch"), { recursive: true })
  fs.writeFileSync(path.join(dir, "sketch", "sketch.ino"), code)
  execFileSync(cli!, ["compile", "--fqbn", fqbn, "--build-path", path.join(dir, "build"), "--output-dir", path.join(dir, "out"), path.join(dir, "sketch")], { encoding: "utf8", env, stdio: "pipe" })
  return fs.readFileSync(hex, "utf8")
}

type Img = { w: number; h: number; ver: number; data: Uint8ClampedArray }
interface Run { sim: McuSim; serial: () => string; img: () => Img; busy: () => number }
/** run the sketch with the panel `type` wired as "d"; `watch` is called after every 20 ms step */
function run(board: Board, code: string, type: string, wires: [string, string][], seconds: number, watch?: (r: Run) => boolean | void): Run {
  const b = BOARD[board]
  const d: Diagram = { version: 1, author: "", editor: "t", parts: [{ type: b.type, id: "mcu", top: 0, left: 0, attrs: {} }, { type, id: "d", top: 0, left: 0, attrs: {} }], connections: wires.map(([x, y]) => [x, y, "", []] as Connection) }
  const sim = new McuSim(d, build(code, b.fqbn))
  let serial = ""
  sim.onSerial = (s) => (serial += s)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const S = sim as any
  let volts: number[] = []
  const r: Run = {
    sim, serial: () => serial,
    img: () => { const im = S.cat.get("d").view().image; return { ...im, data: im.data.slice() } },
    busy: () => volts[S.circuit.net("d", "BUSY")] ?? 0,
  }
  for (let t = 0; t < seconds * 1000; t += 20) { volts = sim.step(20, 20).volts; if (watch?.(r)) break }
  return r
}
const px = (im: Img, u: number, v: number) => { const i = (v * im.w + u) * 4; return [im.data[i], im.data[i + 1], im.data[i + 2]] }
const isInk = (im: Img, u: number, v: number, ink: number[]) => px(im, u, v).every((x, i) => x === ink[i])
/** how many pixels of a colour are in a rectangle */
const count = (im: Img, x: number, y: number, w: number, h: number, ink: number[]) => { let n = 0; for (let v = y; v < y + h; v++) for (let u = x; u < x + w; u++) if (isInk(im, u, v, ink)) n++; return n }
/** GxEPD2's diagnostic busy times ("_Update_Full : 600123") in ms */
const busyMs = (s: string, what: string) => [...s.matchAll(new RegExp(`${what} : (\\d+)`, "g"))].map((m) => Number(m[1]) / 1000)

/** debugging: the serial text and an ASCII picture in the tmp dir */
function dump(name: string, r: Run, im: Img) {
  if (!process.env.EPD_DUMP) return
  const rows: string[] = []
  const sx = Math.max(1, Math.ceil(im.w / 160)), sy = sx * 2
  for (let v = 0; v < im.h; v += sy) { let l = ""; for (let u = 0; u < im.w; u += sx) { const c = px(im, u, v); l += c[0] < 100 && c[2] < 100 ? "#" : c[0] > 150 && c[1] < 100 ? "R" : c[0] > 200 && c[2] > 200 ? "." : "o" } rows.push(l) }
  fs.writeFileSync(path.join(process.env.EPD_DUMP, `${name}.txt`), r.serial() + "\n" + rows.join("\n"))
}
const SPI_UNO: [string, string][] = [["d:VCC", "mcu:5V"], ["d:GND", "mcu:GND.1"], ["d:DIN", "mcu:11"], ["d:CLK", "mcu:13"], ["d:CS", "mcu:10"], ["d:DC", "mcu:8"], ["d:RST", "mcu:9"], ["d:BUSY", "mcu:7"]]
const SPI_MEGA: [string, string][] = [["d:VCC", "mcu:5V"], ["d:GND", "mcu:GND.1"], ["d:DIN", "mcu:51"], ["d:CLK", "mcu:52"], ["d:CS", "mcu:10"], ["d:DC", "mcu:8"], ["d:RST", "mcu:9"], ["d:BUSY", "mcu:7"]]

/**
 * The common sketch: a full-window paged drawing (rectangle + text), then RAM written without a
 * refresh ("written"), a pause, and a refresh ("refreshed").
 */
const sketch = (head: string, rot: number, draw: string, late: string, refresh = "display.epd2.refresh(true);") => `${head}
void setup() {
  display.init(115200);
  display.setRotation(${rot});
  display.setFullWindow();
  display.firstPage();
  do {
    display.fillScreen(GxEPD_WHITE);
    ${draw}
  } while (display.nextPage());
  Serial.println("drawn");
  ${late}
  Serial.println("written");
  delay(1500);
  Serial.println("refresh");
  ${refresh}
  Serial.println("refreshed");
}
void loop() {}`
/** a solid black 64×16 block for epd2.writeImage (1 = white, so all zeroes) */
const BLOCK = "static const uint8_t blk[8 * 16] = {0};";

/** run the common sketch: the picture just before the late refresh, BUSY's range during it, and the end */
function panel(board: Board, code: string, type: string, seconds = 20) {
  let before: Img | undefined, hi = 0, lo = 99
  const r = run(board, code, type, board === "uno" ? SPI_UNO : SPI_MEGA, seconds, (r) => {
    const s = r.serial()
    if (s.includes("written") && !s.includes("\nrefresh\r") && !before) before = r.img()
    if (s.includes("\nrefresh\r") && !s.includes("refreshed")) { hi = Math.max(hi, r.busy()); lo = Math.min(lo, r.busy()) }
    return s.includes("refreshed")
  })
  const s = r.serial(), im = r.img()
  dump(type, r, im)
  expect(s).toContain("refreshed")
  expect(s).not.toContain("Busy Timeout")
  expect(before).toBeDefined()
  return { r, s, im, before: before!, hi, lo, idle: r.busy() }
}
const head = (lib: string, cls: string, drv: string) => `#include <${lib}.h>
${cls} display(${drv}(10, 8, 9, 7));
${BLOCK}`

describe.skipIf(!cli || !has("GxEPD2"))("e-paper panels with GxEPD2", { timeout: 600_000 }, () => {
  it("1.54\" SSD1681 (GxEPD2_154_D67, paged on the Uno): draws, changes only on refresh, BUSY high while refreshing", () => {
    const code = sketch(`#include <GxEPD2_BW.h>
GxEPD2_BW<GxEPD2_154_D67, 32> display(GxEPD2_154_D67(10, 8, 9, 7));
${BLOCK}`, 0, `display.fillRect(10, 10, 60, 30, GxEPD_BLACK);
    display.setTextColor(GxEPD_BLACK); display.setTextSize(4); display.setCursor(20, 120); display.print("Hi");`,
      "display.epd2.writeImage(blk, 120, 160, 64, 16);")
    let before: Img | undefined, busyDuring = 0
    const r = run("uno", code, "sb-epaper-1-54-200-200-b-w", SPI_UNO, 12, (r) => {
      const s = r.serial()
      if (s.includes("written") && !s.includes("\nrefresh\r") && !before) before = r.img()
      if (s.includes("\nrefresh\r") && !s.includes("refreshed")) busyDuring = Math.max(busyDuring, r.busy())
      return s.includes("refreshed")
    })
    const s = r.serial()
    expect(s).toContain("refreshed")
    expect(s).not.toContain("Busy Timeout")
    const im = r.img()
    dump("154", r, im)
    expect([im.w, im.h]).toEqual([200, 200])
    // the rectangle at the top left, white around it
    expect(isInk(im, 12, 12, INK.black)).toBe(true)
    expect(isInk(im, 68, 38, INK.black)).toBe(true)
    expect(isInk(im, 72, 12, INK.white)).toBe(true)
    expect(isInk(im, 190, 190, INK.white)).toBe(true)
    // "Hi" at size 4 (24×32 px a glyph) from (20,120): some ink, not a block
    const t = count(im, 20, 120, 48, 32, INK.black)
    expect(t).toBeGreaterThan(150); expect(t).toBeLessThan(1200)
    // the block written to RAM appeared only on the refresh
    expect(before).toBeDefined()
    expect(count(before!, 120, 160, 64, 16, INK.black)).toBe(0)
    expect(isInk(before!, 12, 12, INK.black)).toBe(true)
    expect(count(im, 120, 160, 64, 16, INK.black)).toBe(64 * 16)
    // BUSY: high during the refresh, low after; GxEPD2 timed the waits
    expect(busyDuring).toBeGreaterThan(2.5)
    expect(r.busy()).toBeLessThan(0.5)
    const full = busyMs(s, "_Update_Full"), part = busyMs(s, "_Update_Part")
    expect(full.length).toBeGreaterThan(0); expect(part.length).toBeGreaterThan(0)
    expect(full[0]).toBeGreaterThan(550); expect(full[0]).toBeLessThan(700)
    expect(part[0]).toBeGreaterThan(250); expect(part[0]).toBeLessThan(400)
  })

  it("2.13\" SSD1680 3-colour (GxEPD2_213_Z98c): black and red, landscape with setRotation(1)", () => {
    const { im, before, hi, idle } = panel("uno", sketch(head("GxEPD2_3C", "GxEPD2_3C<GxEPD2_213_Z98c, 25>", "GxEPD2_213_Z98c"), 1,
      `display.fillRect(0, 0, 40, 20, GxEPD_BLACK);
    display.fillRect(200, 90, 40, 20, GxEPD_RED);
    display.setTextColor(GxEPD_RED); display.setTextSize(2); display.setCursor(60, 50); display.print("RED");`,
      "display.epd2.writeImage(blk, 40, 100, 64, 16);", "display.epd2.refresh(false);"), "sb-epaper-2-13-250-122-b-w-red")
    expect([im.w, im.h]).toEqual([250, 122])
    expect(isInk(im, 2, 2, INK.black)).toBe(true)
    expect(isInk(im, 38, 18, INK.black)).toBe(true)
    expect(isInk(im, 45, 5, INK.white)).toBe(true)
    expect(isInk(im, 205, 95, INK.red)).toBe(true)
    expect(isInk(im, 238, 108, INK.red)).toBe(true)
    expect(isInk(im, 245, 118, INK.white)).toBe(true)
    expect(count(im, 60, 50, 36, 16, INK.red)).toBeGreaterThan(60)
    expect(count(im, 60, 50, 36, 16, INK.black)).toBe(0)
    // the RAM block at native x 40..103, y 100..115 → view u 100..115, v 121−103..121−40
    expect(count(before, 100, 18, 16, 64, INK.black)).toBe(0)
    expect(count(im, 100, 18, 16, 64, INK.black)).toBe(16 * 64)
    expect(hi).toBeGreaterThan(2.5); expect(idle).toBeLessThan(0.5)
  })

  it("2.13\" SSD1680 B/W (GxEPD2_213_BN)", () => {
    const { im, before } = panel("uno", sketch(head("GxEPD2_BW", "GxEPD2_BW<GxEPD2_213_BN, 50>", "GxEPD2_213_BN"), 1,
      "display.fillRect(0, 0, 40, 20, GxEPD_BLACK); display.fillRect(210, 102, 40, 20, GxEPD_BLACK);",
      "display.epd2.writeImage(blk, 40, 100, 64, 16);"), "sb-epaper-2-13-250-122-b-w")
    expect([im.w, im.h]).toEqual([250, 122])
    expect(isInk(im, 2, 2, INK.black)).toBe(true)
    expect(isInk(im, 248, 120, INK.black)).toBe(true)
    expect(isInk(im, 125, 60, INK.white)).toBe(true)
    expect(count(before, 100, 18, 16, 64, INK.black)).toBe(0)
    expect(count(im, 100, 18, 16, 64, INK.black)).toBe(16 * 64)
  })

  it("2.9\" SSD1680 B/W (GxEPD2_290_GDEY029T94): text the right way round in landscape", () => {
    const { s, im, before, hi, idle } = panel("uno", sketch(head("GxEPD2_BW", "GxEPD2_BW<GxEPD2_290_GDEY029T94, 50>", "GxEPD2_290_GDEY029T94"), 1,
      `display.fillRect(0, 0, 40, 20, GxEPD_BLACK);
    display.fillRect(250, 100, 40, 20, GxEPD_BLACK);
    display.setTextColor(GxEPD_BLACK); display.setTextSize(3); display.setCursor(80, 50); display.print("L");`,
      "display.epd2.writeImage(blk, 0, 200, 64, 16);"), "sb-epaper-2-9-296-128-b-w")
    expect([im.w, im.h]).toEqual([296, 128])
    expect(isInk(im, 2, 2, INK.black)).toBe(true)
    expect(isInk(im, 39, 19, INK.black)).toBe(true)
    expect(isInk(im, 260, 110, INK.black)).toBe(true)
    expect(isInk(im, 150, 10, INK.white)).toBe(true)
    // an "L" (the 5×7 font × 3 from (80,50)): the stem on the left, the foot along the bottom
    expect(isInk(im, 81, 51, INK.black)).toBe(true)
    expect(isInk(im, 92, 51, INK.white)).toBe(true)
    expect(isInk(im, 92, 69, INK.black)).toBe(true)
    // the RAM block at native x 0..63, y 200..215 → view u 200..215, v 64..127
    expect(count(before, 200, 64, 16, 64, INK.black)).toBe(0)
    expect(count(im, 200, 64, 16, 64, INK.black)).toBe(16 * 64)
    expect(hi).toBeGreaterThan(2.5); expect(idle).toBeLessThan(0.5)
    expect(busyMs(s, "_Update_Part")[0]).toBeGreaterThan(250)
  })

  it("2.9\" SSD1680 3-colour (GxEPD2_290_C90c)", () => {
    const { im, before } = panel("uno", sketch(head("GxEPD2_3C", "GxEPD2_3C<GxEPD2_290_C90c, 25>", "GxEPD2_290_C90c"), 1,
      "display.fillRect(0, 0, 40, 20, GxEPD_BLACK); display.fillRect(250, 100, 40, 20, GxEPD_RED);",
      "display.epd2.writeImage(blk, 0, 200, 64, 16);", "display.epd2.refresh(false);"), "sb-epaper-2-9-296-128-b-w-red")
    expect([im.w, im.h]).toEqual([296, 128])
    expect(isInk(im, 2, 2, INK.black)).toBe(true)
    expect(isInk(im, 260, 110, INK.red)).toBe(true)
    expect(isInk(im, 150, 40, INK.white)).toBe(true)
    expect(count(before, 200, 64, 16, 64, INK.black)).toBe(0)
    expect(count(im, 200, 64, 16, 64, INK.black)).toBe(16 * 64)
  })

  it("4.2\" UC8176 (GxEPD2_420): partial window writes, BUSY_N low while refreshing", () => {
    const { s, im, before, lo, idle } = panel("uno", sketch(head("GxEPD2_BW", "GxEPD2_BW<GxEPD2_420, 16>", "GxEPD2_420"), 0,
      `display.fillRect(10, 10, 60, 30, GxEPD_BLACK);
    display.fillRect(330, 260, 60, 30, GxEPD_BLACK);
    display.setTextColor(GxEPD_BLACK); display.setTextSize(4); display.setCursor(150, 130); display.print("4.2");`,
      "display.epd2.writeImage(blk, 200, 40, 64, 16);"), "sb-epaper-4-2-400-300-b-w")
    expect([im.w, im.h]).toEqual([400, 300])
    expect(isInk(im, 12, 12, INK.black)).toBe(true)
    expect(isInk(im, 389, 289, INK.black)).toBe(true)
    expect(isInk(im, 72, 12, INK.white)).toBe(true)
    expect(isInk(im, 390, 10, INK.white)).toBe(true)
    expect(count(im, 150, 130, 72, 32, INK.black)).toBeGreaterThan(200)
    expect(count(before, 200, 40, 64, 16, INK.black)).toBe(0)
    expect(count(im, 200, 40, 64, 16, INK.black)).toBe(64 * 16)
    expect(lo).toBeLessThan(0.5); expect(idle).toBeGreaterThan(2.5)
    const full = busyMs(s, "_Update_Full"), part = busyMs(s, "_Update_Part")
    expect(full[0]).toBeGreaterThan(550); expect(part[0]).toBeGreaterThan(250); expect(part[0]).toBeLessThan(400)
  })

  it("5.65\" ACeP 7-colour (GxEPD2_565c, paged on the Mega): all seven inks", () => {
    const inks = ["BLACK", "WHITE", "GREEN", "BLUE", "RED", "YELLOW", "ORANGE"]
    const { im, before, lo, idle } = panel("mega", sketch(head("GxEPD2_7C", "GxEPD2_7C<GxEPD2_565c, 16>", "GxEPD2_565c"), 0,
      inks.map((k, i) => `display.fillRect(${i * 80 + 10}, 100, 60, 60, GxEPD_${k});`).join("\n    "),
      "display.epd2.writeImage(blk, 0, 0, 64, 16);", "display.epd2.refresh(false);"), "sb-epaper-5-65-600-448-7-colour", 40)
    expect([im.w, im.h]).toEqual([600, 448])
    const want = [INK.black, INK.white, INK.green, INK.blue, INK.red, INK.yellow, INK.orange]
    // before the late refresh: the seven squares (writeImage has resent the whole screen meanwhile)
    want.forEach((ink, i) => expect(count(before, i * 80 + 15, 105, 50, 50, ink)).toBe(2500))
    expect(isInk(before, 300, 300, INK.white)).toBe(true)
    // after: white with the block
    expect(count(im, 0, 0, 64, 16, INK.black)).toBe(64 * 16)
    expect(isInk(im, 30, 120, INK.white)).toBe(true)
    expect(isInk(im, 350, 120, INK.white)).toBe(true)
    expect(lo).toBeLessThan(0.5); expect(idle).toBeGreaterThan(2.5)
  })

  it("7.5\" UC8179 (GxEPD2_750_T7, paged on the Mega)", () => {
    const { s, im, before, lo, idle } = panel("mega", sketch(head("GxEPD2_BW", "GxEPD2_BW<GxEPD2_750_T7, 50>", "GxEPD2_750_T7"), 0,
      `display.fillRect(10, 10, 60, 30, GxEPD_BLACK);
    display.fillRect(730, 440, 60, 30, GxEPD_BLACK);
    display.setTextColor(GxEPD_BLACK); display.setTextSize(4); display.setCursor(350, 220); display.print("7.5");`,
      "display.epd2.writeImage(blk, 600, 400, 64, 16);"), "sb-epaper-7-5-800-480-b-w", 30)
    expect([im.w, im.h]).toEqual([800, 480])
    expect(isInk(im, 12, 12, INK.black)).toBe(true)
    expect(isInk(im, 789, 469, INK.black)).toBe(true)
    expect(isInk(im, 790, 10, INK.white)).toBe(true)
    expect(count(im, 350, 220, 72, 32, INK.black)).toBeGreaterThan(200)
    expect(count(before, 600, 400, 64, 16, INK.black)).toBe(0)
    expect(count(im, 600, 400, 64, 16, INK.black)).toBe(64 * 16)
    expect(lo).toBeLessThan(0.5); expect(idle).toBeGreaterThan(2.5)
    expect(busyMs(s, "_Update_Full")[0]).toBeGreaterThan(700)
  })
})

describe.skipIf(!cli)("Grove Triple Color E-Ink 2.13\" (Seeed UART protocol)", { timeout: 300_000 }, () => {
  it("takes the 'c' / 'a' / 'b' handshake and two 2756-byte planes, then shows them a refresh later", () => {
    // Seeed's Eink_factory_code_213 with the picture computed instead of two PROGMEM arrays:
    // black rows 0..19, red rows 100..119 (0 = ink), 13 chunks of 212 bytes with 80 ms gaps
    const code = `#include <Arduino.h>
uint8_t px(bool red, int i) { int row = i / 13; if (red) return row >= 100 && row < 120 ? 0x00 : 0xFF; return row < 20 ? 0x00 : 0xFF; }
void plane(bool red) { for (int c = 0; c < 13; c++) { for (int i = 0; i < 212; i++) Serial.write(px(red, c * 212 + i)); delay(80); } }
void send_begin() {
  while (1) { if (Serial.available() > 0) { char s = Serial.read(); if (s == 'c') break; } }
  Serial.write('a');
  while (1) { if (Serial.available() > 0) { char s = Serial.read(); if (s == 'b') break; } }
}
void setup() { Serial.begin(230400); delay(10); send_begin(); delay(2000); plane(false); delay(90); plane(true); }
void loop() {}`
    let t = 0, lastSent = 0, shown = 0, len = 0
    const r = run("uno", code, "sb-grove-triple-color-e-ink-display-2-13", [["d:GND", "mcu:GND.1"], ["d:VCC", "mcu:5V"], ["d:RX", "mcu:1"], ["d:TX", "mcu:0"]], 8, (r) => {
      t += 0.02
      if (r.serial().length > len) { len = r.serial().length; lastSent = t }
      if (!shown && !isInk(r.img(), 5, 50, INK.white)) shown = t
    })
    const im = r.img()
    dump("grove", r, im)
    expect([im.w, im.h]).toEqual([212, 104])
    // landscape: native row y → view column u
    expect(isInk(im, 5, 50, INK.black)).toBe(true)
    expect(isInk(im, 19, 0, INK.black)).toBe(true)
    expect(isInk(im, 21, 50, INK.white)).toBe(true)
    expect(isInk(im, 110, 50, INK.red)).toBe(true)
    expect(isInk(im, 110, 103, INK.red)).toBe(true)
    expect(isInk(im, 150, 50, INK.white)).toBe(true)
    // the sketch sent 'a' + both planes; the picture came a refresh (1 s) after the last byte
    expect(lastSent).toBeGreaterThan(4)
    expect(shown - lastSent).toBeGreaterThan(0.9)
    expect(shown - lastSent).toBeLessThan(1.3)
  })
})
