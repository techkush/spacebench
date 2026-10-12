// Catalogue devices against the real Arduino libraries: each sketch is compiled by arduino-cli
// and run on the AVR emulator with the part wired to the Uno. A test is skipped when its
// library isn't installed — in a default shell that's most of them (19 of 21).
//
// To run them all, install the libraries into a scratch sketchbook (not ~/Documents/Arduino)
// and point SB_ARDUINO_USER at it:
//   export SB_ARDUINO_USER=~/.cache/spacebench-test-libs   # any folder
//   for l in "Adafruit BME280 Library" "Adafruit SHT31 Library" OneWire DallasTemperature TM1637 \
//     "Adafruit MPU6050" RTClib "Grove - LCD RGB Backlight" "Adafruit ADS1X15" HX711 TinyGPSPlus \
//     "DHT sensor library" "Adafruit AHTX0" "Adafruit MCP9808 Library" "Adafruit MLX90614 Library" \
//     "Adafruit SHT4x Library" "Adafruit BME680 Library" "Adafruit ADXL345" "Adafruit LIS3DH" \
//     "Adafruit LED Backpack Library" "Adafruit MCP3008"; do
//     ARDUINO_DIRECTORIES_USER=$SB_ARDUINO_USER arduino-cli lib install "$l"; done
//   pnpm vitest run src/mcu/catalog/devices.test.ts
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import type { PartUi } from "../circuit"
import type { Connection, Diagram } from "../diagram"
import { McuSim, type Frame } from "../sim"

const cli = ["/opt/homebrew/bin/arduino-cli", "/usr/local/bin/arduino-cli"].find((p) => fs.existsSync(p))
const user = process.env.SB_ARDUINO_USER
const env = user ? { ...process.env, ARDUINO_DIRECTORIES_USER: user } : process.env
const libs = cli ? execFileSync(cli, ["lib", "list"], { encoding: "utf8", env }) : ""
const has = (l: string) => libs.includes(l)

function build(code: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbcat-"))
  const sk = path.join(dir, "sketch"); fs.mkdirSync(sk)
  fs.writeFileSync(path.join(sk, "sketch.ino"), code)
  execFileSync(cli!, ["compile", "--fqbn", "arduino:avr:uno", "--build-path", path.join(os.tmpdir(), `sbcat-build-${code.length}-${code.charCodeAt(30)}`), "--output-dir", path.join(dir, "out"), sk], { encoding: "utf8", env })
  return fs.readFileSync(path.join(dir, "out", "sketch.ino.hex"), "utf8")
}
type P = [string, string, Record<string, string>?]
function run(code: string, parts: P[], wires: [string, string][], opt: { ms?: number; ui?: Record<string, PartUi>; then?: (s: McuSim) => void; thenMs?: number } = {}) {
  const d: Diagram = { version: 1, author: "", editor: "t", parts: [{ type: "wokwi-arduino-uno", id: "uno", top: 0, left: 0, attrs: {} }, ...parts.map(([type, id, attrs]) => ({ type, id, top: 0, left: 0, attrs: attrs ?? {} }))], connections: wires.map(([a, b]) => [a, b, "", []] as Connection) }
  const sim = new McuSim(d, build(code))
  let serial = ""
  sim.onSerial = (s) => (serial += s)
  for (const [id, u] of Object.entries(opt.ui ?? {})) sim.setUi(id, u)
  let f: Frame = sim.step(1, 1)
  for (let t = 0; t < (opt.ms ?? 1500); t += 50) f = sim.step(50, 50)
  let after = ""
  if (opt.then) { opt.then(sim); const mark = serial.length; for (let t = 0; t < (opt.thenMs ?? 1000); t += 50) f = sim.step(50, 50); after = serial.slice(mark) }
  return { serial, after, frame: f, last: (s: string) => s.trim().split("\n").filter(Boolean).pop() ?? "" }
}
const I2C: [string, string][] = [["d:GND", "uno:GND.1"], ["d:VCC", "uno:5V"], ["d:SDA", "uno:A4"], ["d:SCL", "uno:A5"]]
const num = (s: string) => s.trim().split(/[\s,]+/).map(Number)

describe.skipIf(!cli)("catalogue devices with real libraries", { timeout: 180_000 }, () => {
  it.skipIf(!has("Adafruit BME280"))("BME280: temperature, pressure, humidity from the sliders", () => {
    const r = run(`#include <Adafruit_BME280.h>
Adafruit_BME280 bme;
void setup(){ Serial.begin(115200); if(!bme.begin(0x76)) Serial.println("no"); }
void loop(){ Serial.print(bme.readTemperature()); Serial.print(" "); Serial.print(bme.readPressure()/100.0); Serial.print(" "); Serial.println(bme.readHumidity()); delay(200); }`,
      [["sb-bme280-sensor", "d"]], [["d:GND", "uno:GND.1"], ["d:VCC", "uno:5V"], ["d:SDA", "uno:A4"], ["d:SCL", "uno:A5"]], { then: (s) => s.setUi("d", { v: { t: 31.5, p: 990, h: 70 } }) })
    expect(r.serial).not.toContain("no")
    const [t, p, h] = num(r.last(r.serial.slice(0, r.serial.length - r.after.length)))
    expect(t).toBeCloseTo(24, 0); expect(p).toBeCloseTo(1013.25, 0); expect(h).toBeCloseTo(45, 0)
    const [t2, p2, h2] = num(r.last(r.after))
    expect(t2).toBeCloseTo(31.5, 0); expect(p2).toBeCloseTo(990, 0); expect(h2).toBeCloseTo(70, 0)
  })
  it.skipIf(!has("Adafruit SHT31"))("SHT31", () => {
    const r = run(`#include <Adafruit_SHT31.h>
Adafruit_SHT31 sht;
void setup(){ Serial.begin(115200); Serial.println(sht.begin(0x44) ? "ok" : "no"); }
void loop(){ Serial.print(sht.readTemperature()); Serial.print(" "); Serial.println(sht.readHumidity()); delay(200); }`,
      [["sb-grove-temperature-humidity-sensor-sht31", "d"]], I2C)
    expect(r.serial).toContain("ok")
    const [t, h] = num(r.last(r.serial))
    expect(t).toBeCloseTo(24, 0); expect(h).toBeCloseTo(45, 0)
  })
  it.skipIf(!has("DallasTemperature"))("DS18B20 on 1-Wire with a 4.7 kΩ pull-up", () => {
    const r = run(`#include <OneWire.h>
#include <DallasTemperature.h>
OneWire ow(2); DallasTemperature ds(&ow);
void setup(){ Serial.begin(115200); ds.begin(); Serial.print("n="); Serial.println(ds.getDeviceCount()); }
void loop(){ ds.requestTemperatures(); Serial.println(ds.getTempCByIndex(0)); delay(100); }`,
      [["sb-ds18b20-temperature-sensor", "d", { t: "36.5" }], ["wokwi-resistor", "r", { value: "4.7k" }]],
      [["d:GND", "uno:GND.1"], ["d:VDD", "uno:5V"], ["d:DQ", "uno:2"], ["r:1", "uno:5V"], ["r:2", "uno:2"]], { ms: 2500 })
    expect(r.serial).toContain("n=1")
    expect(Number(r.last(r.serial))).toBeCloseTo(36.5, 1)
  })
  it.skipIf(!has("DHT sensor library"))("Grove DHT11", () => {
    const r = run(`#include <DHT.h>
DHT dht(4, DHT11);
void setup(){ Serial.begin(115200); dht.begin(); }
void loop(){ delay(1100); Serial.print(dht.readTemperature()); Serial.print(" "); Serial.println(dht.readHumidity()); }`,
      [["sb-grove-temperature-humidity-sensor-dht11", "d"]], [["d:GND", "uno:GND.1"], ["d:VCC", "uno:5V"], ["d:SIG", "uno:4"]], { ms: 2600 })
    const [t, h] = num(r.last(r.serial))
    expect(t).toBe(24); expect(h).toBe(45)
  })
  it.skipIf(!has("Adafruit MPU6050"))("MPU6050: 1 g on Z", () => {
    const r = run(`#include <Adafruit_MPU6050.h>
Adafruit_MPU6050 mpu;
void setup(){ Serial.begin(115200); Serial.println(mpu.begin() ? "ok" : "no"); }
void loop(){ sensors_event_t a, g, t; mpu.getEvent(&a, &g, &t); Serial.print(a.acceleration.z); Serial.print(" "); Serial.println(t.temperature); delay(100); }`,
      [["wokwi-mpu6050", "d"]], I2C)
    expect(r.serial).toContain("ok")
    const [z, t] = num(r.last(r.serial))
    expect(z).toBeCloseTo(9.8, 0); expect(t).toBeCloseTo(24, 0)
  })
  it.skipIf(!has("TM1637"))("TM1637 4-digit display shows 1234", () => {
    const r = run(`#include <TM1637Display.h>
TM1637Display disp(3, 4);
void setup(){ disp.setBrightness(7); disp.showNumberDec(1234); }
void loop(){}`,
      [["sb-grove-4-digit-display-tm1637", "d"]], [["d:GND", "uno:GND.1"], ["d:VCC", "uno:5V"], ["d:CLK", "uno:3"], ["d:DIO", "uno:4"]], { ms: 400 })
    expect(r.frame.mods.get("d")?.segs).toEqual([0x06, 0x5b, 0x4f, 0x66])
  })
  it.skipIf(!has("RTClib"))("DS3231 keeps the host's date", () => {
    const r = run(`#include <RTClib.h>
RTC_DS3231 rtc;
void setup(){ Serial.begin(115200); Serial.println(rtc.begin() ? "ok" : "no"); Serial.println(rtc.now().year()); Serial.println(rtc.getTemperature()); }
void loop(){}`,
      [["sb-ds3231-rtc", "d"]], I2C, { ms: 600 })
    expect(r.serial).toContain("ok")
    expect(r.serial).toContain(String(new Date().getFullYear()))
  })
  it.skipIf(!has("Grove - LCD RGB Backlight"))("Grove LCD RGB backlight prints text", () => {
    const r = run(`#include <Wire.h>
#include "rgb_lcd.h"
rgb_lcd lcd;
void setup(){ lcd.begin(16, 2); lcd.setRGB(0, 0, 255); lcd.print("Space Bench"); }
void loop(){}`,
      [["sb-grove-16x2-lcd-rgb-backlight", "d"]], I2C, { ms: 800 })
    const l = r.frame.lcd.get("d")!
    expect(String.fromCharCode(...l.chars.slice(0, 11))).toBe("Space Bench")
    expect(r.frame.mods.get("d")?.backlight).toEqual([0, 0, 255])
  })
  it.skipIf(!has("Adafruit ADS1X15"))("ADS1115 reads a divider on A0", () => {
    const r = run(`#include <Adafruit_ADS1X15.h>
Adafruit_ADS1115 ads;
void setup(){ Serial.begin(115200); Serial.println(ads.begin() ? "ok" : "no"); }
void loop(){ Serial.println(ads.computeVolts(ads.readADC_SingleEnded(0)), 3); delay(100); }`,
      [["sb-grove-4-channel-16-bit-adc-ads1115", "d"], ["wokwi-resistor", "r1", { value: "10k" }], ["wokwi-resistor", "r2", { value: "10k" }]],
      [...I2C, ["r1:1", "uno:5V"], ["r1:2", "r2:1"], ["r2:2", "uno:GND.2"], ["r1:2", "d:A0"]])
    expect(r.serial).toContain("ok")
    expect(Number(r.last(r.serial))).toBeCloseTo(2.5, 1)
  })
  it.skipIf(!has("HX711"))("HX711 load cell", () => {
    const r = run(`#include <HX711.h>
HX711 s;
void setup(){ Serial.begin(115200); s.begin(3, 2); }
void loop(){ if (s.is_ready()) Serial.println(s.read()); delay(50); }`,
      [["sb-grove-adc-for-load-cell-hx711", "d", { w: "100" }]], [["d:GND", "uno:GND.1"], ["d:VCC", "uno:5V"], ["d:DT", "uno:3"], ["d:SCK", "uno:2"]], { ms: 800 })
    expect(Number(r.last(r.serial))).toBe(42000)
  })
  it.skipIf(!has("TinyGPSPlus"))("GPS NEMA through SoftwareSerial", () => {
    const r = run(`#include <SoftwareSerial.h>
#include <TinyGPSPlus.h>
SoftwareSerial ss(4, 5); TinyGPSPlus gps;
void setup(){ Serial.begin(115200); ss.begin(9600); }
void loop(){ while (ss.available()) gps.encode(ss.read()); if (gps.location.isUpdated()) { Serial.println(gps.location.lat(), 4); } }`,
      [["sb-gps-neo-6m", "d"]], [["d:GND", "uno:GND.1"], ["d:VCC", "uno:5V"], ["d:TX", "uno:4"], ["d:RX", "uno:5"]], { ms: 2500 })
    expect(Number(r.last(r.serial))).toBeCloseTo(6.9271, 3)
  })
  it("analog Grove temperature sensor, a Grove button, a Grove LED", () => {
    const r = run(`void setup(){ Serial.begin(115200); pinMode(4, INPUT); pinMode(5, OUTPUT); }
void loop(){ int a = analogRead(A0); float R = 1023.0/a - 1.0; float t = 1.0/(log(R)/4275+1/298.15) - 273.15; Serial.print(t); Serial.print(" "); Serial.println(digitalRead(4)); digitalWrite(5, digitalRead(4)); delay(50); }`,
      [["sb-grove-temperature-sensor", "t"], ["sb-grove-button", "b"], ["sb-grove-red-led", "l"]],
      [["t:GND", "uno:GND.1"], ["t:VCC", "uno:5V"], ["t:SIG", "uno:A0"], ["b:GND", "uno:GND.1"], ["b:VCC", "uno:5V"], ["b:SIG", "uno:4"], ["l:GND", "uno:GND.2"], ["l:VCC", "uno:5V"], ["l:SIG", "uno:5"]],
      { ms: 300, then: (s) => { s.setUi("t", { v: { value: 60 } }); s.setUi("b", { pressed: true }) }, thenMs: 300 })
    const [t0, b0] = num(r.last(r.serial.slice(0, r.serial.length - r.after.length)))
    expect(t0).toBeCloseTo(25, 0); expect(b0).toBe(0)
    const [t1, b1] = num(r.last(r.after))
    expect(t1).toBeCloseTo(60, 0); expect(b1).toBe(1)
    expect(r.frame.leds.get("l")?.[0] ?? 0).toBeGreaterThan(0.5)
  })
  it.skipIf(!has("Adafruit AHTX0"))("AHT20", () => {
    const r = run(`#include <Adafruit_AHTX0.h>
Adafruit_AHTX0 aht;
void setup(){ Serial.begin(115200); Serial.println(aht.begin() ? "ok" : "no"); }
void loop(){ sensors_event_t h, t; aht.getEvent(&h, &t); Serial.print(t.temperature); Serial.print(" "); Serial.println(h.relative_humidity); delay(200); }`,
      [["sb-grove-aht20-temperature-humidity-sensor", "d"]], I2C)
    expect(r.serial).toContain("ok")
    const [t, h] = num(r.last(r.serial))
    expect(t).toBeCloseTo(24, 0); expect(h).toBeCloseTo(45, 0)
  })
  it.skipIf(!has("Adafruit MCP9808"))("MCP9808", () => {
    const r = run(`#include <Adafruit_MCP9808.h>
Adafruit_MCP9808 m;
void setup(){ Serial.begin(115200); Serial.println(m.begin(0x18) ? "ok" : "no"); }
void loop(){ Serial.println(m.readTempC()); delay(300); }`,
      [["sb-grove-high-accuracy-temperature-sensor-mcp9808", "d"]], I2C)
    expect(r.serial).toContain("ok")
    expect(Number(r.last(r.serial))).toBeCloseTo(24, 1)
  })
  it.skipIf(!has("Adafruit MLX90614"))("MLX90614", () => {
    const r = run(`#include <Adafruit_MLX90614.h>
Adafruit_MLX90614 m;
void setup(){ Serial.begin(115200); Serial.println(m.begin() ? "ok" : "no"); }
void loop(){ Serial.println(m.readObjectTempC()); delay(200); }`,
      [["sb-grove-infrared-thermometer-mlx90614-dci-5", "d"]], I2C)
    expect(r.serial).toContain("ok")
    expect(Number(r.last(r.serial))).toBeCloseTo(36.6, 1)
  })
  it.skipIf(!has("Adafruit SHT4x"))("SHT40", () => {
    const r = run(`#include <Adafruit_SHT4x.h>
Adafruit_SHT4x s;
void setup(){ Serial.begin(115200); Serial.println(s.begin() ? "ok" : "no"); }
void loop(){ sensors_event_t h, t; s.getEvent(&h, &t); Serial.print(t.temperature); Serial.print(" "); Serial.println(h.relative_humidity); delay(200); }`,
      [["sb-grove-temperature-humidity-sensor-sht40", "d"]], I2C)
    expect(r.serial).toContain("ok")
    const [t, h] = num(r.last(r.serial))
    expect(t).toBeCloseTo(24, 0); expect(h).toBeCloseTo(45, 0)
  })
  it.skipIf(!has("Adafruit BME680"))("BME688", () => {
    const r = run(`#include <Adafruit_BME680.h>
Adafruit_BME680 b;
void setup(){ Serial.begin(115200); Serial.println(b.begin(0x76) ? "ok" : "no"); }
void loop(){ if (b.performReading()) { Serial.print(b.temperature); Serial.print(" "); Serial.print(b.pressure / 100.0); Serial.print(" "); Serial.print(b.humidity); Serial.print(" "); Serial.println(b.gas_resistance / 1000.0); } delay(200); }`,
      [["sb-bme688-gas-sensor", "d"]], [["d:GND", "uno:GND.1"], ["d:VCC", "uno:5V"], ["d:SDA", "uno:A4"], ["d:SCL", "uno:A5"]], { ms: 2500 })
    expect(r.serial).toContain("ok")
    const [t, p, h, g] = num(r.last(r.serial))
    expect(t).toBeCloseTo(24, 0); expect(p).toBeCloseTo(1013, 0); expect(h).toBeCloseTo(45, 0); expect(g).toBeGreaterThan(100); expect(g).toBeLessThan(140)
  })
  it.skipIf(!has("Adafruit ADXL345"))("ADXL345", () => {
    const r = run(`#include <Adafruit_ADXL345_U.h>
Adafruit_ADXL345_Unified a(1);
void setup(){ Serial.begin(115200); Serial.println(a.begin() ? "ok" : "no"); }
void loop(){ sensors_event_t e; a.getEvent(&e); Serial.println(e.acceleration.z); delay(100); }`,
      [["sb-grove-3-axis-digital-accelerometer-adxl345", "d"]], I2C)
    expect(r.serial).toContain("ok")
    expect(Number(r.last(r.serial))).toBeCloseTo(9.8, 0)
  })
  it.skipIf(!has("Adafruit LIS3DH"))("LIS3DH", () => {
    const r = run(`#include <Adafruit_LIS3DH.h>
Adafruit_LIS3DH l;
void setup(){ Serial.begin(115200); Serial.println(l.begin(0x19) ? "ok" : "no"); }
void loop(){ sensors_event_t e; l.getEvent(&e); Serial.println(e.acceleration.z); delay(100); }`,
      [["sb-grove-3-axis-digital-accelerometer-lis3dhtr", "d"]], I2C)
    expect(r.serial).toContain("ok")
    expect(Number(r.last(r.serial))).toBeCloseTo(9.8, 0)
  })
  it.skipIf(!has("Adafruit LED Backpack"))("HT16K33 8×8 matrix", () => {
    const r = run(`#include <Adafruit_LEDBackpack.h>
Adafruit_8x8matrix m;
void setup(){ m.begin(0x70); m.clear(); m.drawPixel(0, 0, LED_ON); m.drawPixel(3, 2, LED_ON); m.writeDisplay(); }
void loop(){}`,
      [["sb-grove-led-matrix-driver-ht16k33", "d"]], I2C, { ms: 500 })
    const rows = r.frame.mods.get("d")?.rows ?? []
    expect(rows.filter(Boolean).length).toBe(2)
  })
  it.skipIf(!has("Adafruit MCP3008"))("MCP3008 on software SPI", () => {
    const r = run(`#include <Adafruit_MCP3008.h>
Adafruit_MCP3008 adc;
void setup(){ Serial.begin(115200); adc.begin(13, 11, 12, 10); }
void loop(){ Serial.println(adc.readADC(2)); delay(100); }`,
      [["sb-mcp3008-8-channel-10-bit-adc-spi", "d"], ["wokwi-resistor", "r1", { value: "10k" }], ["wokwi-resistor", "r2", { value: "30k" }]],
      [["d:VDD", "uno:5V"], ["d:VREF", "uno:5V"], ["d:AGND", "uno:GND.1"], ["d:DGND", "uno:GND.1"], ["d:CLK", "uno:13"], ["d:DIN", "uno:11"], ["d:DOUT", "uno:12"], ["d:CS", "uno:10"],
        ["r1:1", "uno:5V"], ["r1:2", "r2:1"], ["r2:2", "uno:GND.2"], ["r1:2", "d:CH2"]])
    expect(Number(r.last(r.serial))).toBeGreaterThan(760)
    expect(Number(r.last(r.serial))).toBeLessThan(775)
  })
})
