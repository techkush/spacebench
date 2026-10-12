// i2c-sensors with their real Arduino libraries: each sketch is compiled by arduino-cli and run on
// the AVR emulator with the Grove twig on the Uno's I²C pins. A test is skipped when its library
// isn't installed in the scratch sketchbook (SB_ARDUINO_USER, default ~/.cache/spacebench-test-libs):
//   ARDUINO_DIRECTORIES_USER=~/.cache/spacebench-test-libs arduino-cli lib install \
//     "Grove 3Axis Compass V2.0 BMM150" "Bolder Flight Systems BMI088" \
//     "SparkFun AS3935 Lightning Detector Arduino Library" "Adafruit DPS310" "Seeed Arduino SPA06" \
//     "Adafruit SPA06_003" "Grove barometer HP20x"
// and, from GitHub (not in the library index), into its libraries/ folder:
//   Seeed-Studio/Seeed_BMA456, Seeed-Studio/Grove_6Axis_Accelerometer_And_Gyroscope_BMI088,
//   Seeed-Studio/Accelerometer_ADXL372
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import type { PartUi } from "../../circuit"
import type { Connection, Diagram } from "../../diagram"
import { McuSim, type Frame } from "../../sim"
import { BMM_RHALL, BMM_TRIM, DPS310_COEF, OS_SCALE, SPA06_COEF, as3935Distance, bmmX, bmmZ, invertPressure, pressureOf } from "./i2c-sensors"

const cli = ["/opt/homebrew/bin/arduino-cli", "/usr/local/bin/arduino-cli"].find((p) => fs.existsSync(p))
const user = process.env.SB_ARDUINO_USER ?? path.join(os.homedir(), ".cache", "spacebench-test-libs")
const env = { ...process.env, ARDUINO_DIRECTORIES_USER: user }
const libs = cli ? execFileSync(cli, ["lib", "list"], { encoding: "utf8", env }) : ""
const has = (l: string) => libs.split("\n").some((x) => x.startsWith(l + " ") || x.startsWith(l + "\t"))

function build(code: string, lib?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbi2c-"))
  const sk = path.join(dir, "sketch"); fs.mkdirSync(sk)
  fs.writeFileSync(path.join(sk, "sketch.ino"), code)
  execFileSync(cli!, ["compile", "--fqbn", "arduino:avr:uno", "--output-dir", path.join(dir, "out"), ...(lib ? ["--library", path.join(user, "libraries", lib)] : []), sk], { encoding: "utf8", env })
  return fs.readFileSync(path.join(dir, "out", "sketch.ino.hex"), "utf8")
}
const GROVE: [string, string][] = [["d:GND", "b:GND.1"], ["d:VCC", "b:5V"], ["d:SDA", "b:A4"], ["d:SCL", "b:A5"]]
function run(code: string, type: string, opt: { wires?: [string, string][]; lib?: string; ms?: number; then?: PartUi[]; thenMs?: number } = {}) {
  const d: Diagram = { version: 1, author: "", editor: "t", parts: [{ type: "wokwi-arduino-uno", id: "b", top: 0, left: 0, attrs: {} }, { type, id: "d", top: 0, left: 0, attrs: {} }], connections: [...GROVE, ...(opt.wires ?? [])].map(([a, b]) => [a, b, "", []] as Connection) }
  const sim = new McuSim(d, build(code, opt.lib))
  let serial = ""
  sim.onSerial = (s) => (serial += s)
  let f: Frame = sim.step(1, 1)
  for (let t = 0; t < (opt.ms ?? 1500); t += 50) f = sim.step(50, 50)
  const before = serial
  if (opt.then) { for (const u of opt.then) sim.setUi("d", u); for (let t = 0; t < (opt.thenMs ?? 1500); t += 50) f = sim.step(50, 50) }
  return { serial: before, after: serial.slice(before.length), frame: f, sim }
}
const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean)
const last = (s: string, tag: string) => lines(s).filter((l) => l.startsWith(tag)).pop() ?? ""
const nums = (l: string) => l.split(/\s+/).slice(1).map(Number)

describe("i2c-sensors maths", () => {
  it("BMM150: the compensation rises with the raw value and reaches the field", () => {
    const x = (v: number) => bmmX(BMM_TRIM, v, BMM_RHALL), z = (v: number) => bmmZ(BMM_TRIM, v, BMM_RHALL)
    expect(x(100)).toBeGreaterThan(x(-100)); expect(z(1000)).toBeGreaterThan(z(-1000))
    expect(Math.abs(x(4095))).toBeGreaterThan(1000)
  })
  it("DPS310 / SPA06: inverting the pressure polynomial", () => {
    for (const c of [DPS310_COEF, SPA06_COEF]) for (const pa of [30000, 101325, 110000]) {
      const t = (24 - c.c0 / 2) / c.c1
      const x = invertPressure(c, pa, t)
      expect(pressureOf(c, x, t)).toBeCloseTo(pa, 3)
      expect(Math.abs(x * OS_SCALE[3])).toBeLessThan(8388608)
    }
  })
  it("AS3935 distance table", () => {
    expect(as3935Distance(2)).toBe(1); expect(as3935Distance(13)).toBe(12); expect(as3935Distance(40)).toBe(40); expect(as3935Distance(41)).toBe(0x3f)
  })
})

describe.skipIf(!cli)("i2c-sensors with real libraries", { timeout: 300_000 }, () => {
  it.skipIf(!has("Grove - Step Counter(BMA456)"))("BMA456: config upload, accel, temperature, steps while walking", () => {
    const r = run(`#include "arduino_bma456.h"
void setup(){ Serial.begin(115200); bma456.initialize(RANGE_4G, ODR_100_HZ, NORMAL_AVG4, CONTINUOUS); bma456.stepCounterEnable();
  Wire.beginTransmission(0x19); Wire.write(0x2A); Wire.endTransmission(); Wire.requestFrom(0x19, 1); Serial.print("status "); Serial.println(Wire.read()); }
void loop(){ float x, y, z; bma456.getAcceleration(&x, &y, &z);
  Serial.print("a "); Serial.print(x); Serial.print(" "); Serial.print(y); Serial.print(" "); Serial.print(z); Serial.print(" "); Serial.print(bma456.getTemperature());
  Serial.print(" "); Serial.println(bma456.getStepCounterOutput()); delay(200); }`,
      "sb-grove-step-counter-bma456", { ms: 3500, then: [{ v: { ax: 0.5, ay: -0.25, t: 30, walk: 120 } }], thenMs: 3000 })
    expect(r.serial).toContain("status 1")
    const [x, y, z, t, s] = nums(last(r.serial, "a "))
    expect(x).toBeCloseTo(0, 0); expect(y).toBeCloseTo(0, 0); expect(z).toBeCloseTo(1000, -1); expect(t).toBe(24); expect(s).toBe(0)
    const [x2, y2, , t2, s2] = nums(last(r.after, "a "))
    expect(x2).toBeCloseTo(500, -1); expect(y2).toBeCloseTo(-250, -1); expect(t2).toBe(30)
    expect(s2).toBeGreaterThanOrEqual(4); expect(s2).toBeLessThanOrEqual(7) // 120 steps/min for ~3 s
  })

  it.skipIf(!has("Grove 3Axis Compass V2.0 BMM150"))("BMM150: Bosch compensation gives the field sliders", () => {
    const r = run(`#include <Wire.h>
#include "bmm150.h"
#include "bmm150_defs.h"
BMM150 bmm;
void setup(){ Serial.begin(115200); Serial.println(bmm.initialize() == BMM150_E_ID_NOT_CONFORM ? "no" : "ok"); }
void loop(){ bmm.read_mag_data(); Serial.print("m "); Serial.print(bmm.mag_data.x); Serial.print(" "); Serial.print(bmm.mag_data.y); Serial.print(" "); Serial.println(bmm.mag_data.z); delay(100); }`,
      "sb-grove-3-axis-digital-compass-v2-bmm150", { ms: 800, then: [{ v: { mx: -130, my: 77, mz: 250 } }], thenMs: 500 })
    expect(r.serial).toContain("ok")
    expect(nums(last(r.serial, "m "))).toEqual([22, -5, -42])
    expect(nums(last(r.after, "m "))).toEqual([-130, 77, 250])
  })

  it.skipIf(!has("Seeed Grove ADXL372"))("ADXL372: IDs, 100 mg data up to 200 g, FIFO", () => {
    const r = run(`#include <Wire.h>
#include "adxl372.h"
ADXL372 acc; xyz_t xyz; uint8_t buf[96];
void setup(){ Serial.begin(115200); acc.begin(); Serial.print("id "); Serial.println(acc.id(), HEX);
  acc.timing_ctrl(RATE_400); acc.measurement_ctrl(BW_200, true); acc.fifo_ctrl(STREAMED, FIFO_XYZ); acc.power_ctrl(MEASUREMENT_MODE); }
void loop(){ if (acc.status() & DATA_READY) { acc.read(&xyz); Serial.print("a "); Serial.print(xyz.x); Serial.print(" "); Serial.print(xyz.y); Serial.print(" "); Serial.println(xyz.z); }
  uint16_t n = acc.samples_in_fifo(); if (n > 12) { acc.fifo_read(buf, 12); xyz_t* f = acc.format(buf); Serial.print("f "); Serial.print(n); Serial.print(" "); Serial.print(f->x); Serial.print(" "); Serial.print(f->y); Serial.print(" "); Serial.println(f->z); }
  delay(50); }`,
      "sb-grove-3-axis-digital-accelerometer-200g-adxl372", { ms: 800, then: [{ v: { ax: 150, ay: -199.5, az: -3.2 } }], thenMs: 600 })
    expect(r.serial).toContain("id 2FA1DAD")
    expect(nums(last(r.serial, "a "))).toEqual([0, 0, 10])
    expect(nums(last(r.after, "a "))).toEqual([1500, -1995, -32])
    const f = nums(last(r.after, "f "))
    expect(f[0]).toBeGreaterThan(12)
    expect(f.slice(1)).toEqual([1500, -1995, -32])
  })

  it.skipIf(!has("Grove 6-Axis Accelerometer&Gyroscope(BMI088)"))("BMI088 (Seeed): both chip IDs, accel, gyro, temperature", () => {
    const r = run(`#include "BMI088.h"
BMI088 bmi(BMI088_ACC_ADDRESS, BMI088_GYRO_ADDRESS);
void setup(){ Wire.begin(); Serial.begin(115200); Serial.println(bmi.isConnection() ? "ok" : "no"); bmi.initialize(); }
void loop(){ Serial.print("a "); Serial.print(bmi.getAccelerationX()); Serial.print(" "); Serial.print(bmi.getAccelerationY()); Serial.print(" "); Serial.print(bmi.getAccelerationZ());
  Serial.print(" "); Serial.print(bmi.getGyroscopeX()); Serial.print(" "); Serial.print(bmi.getGyroscopeY()); Serial.print(" "); Serial.print(bmi.getGyroscopeZ()); Serial.print(" "); Serial.println(bmi.getTemperature()); delay(100); }`,
      "sb-grove-6-axis-accelerometer-gyroscope-bmi088", { ms: 600, then: [{ v: { ax: 2.5, ay: -1, gx: 150, gz: -900, t: 40 } }], thenMs: 500 })
    expect(r.serial).toContain("ok")
    const a = nums(last(r.serial, "a "))
    expect(a[0]).toBeCloseTo(0, 0); expect(a[2]).toBeCloseTo(1000, -1); expect(a[6]).toBe(24)
    const b = nums(last(r.after, "a "))
    expect(b[0]).toBeCloseTo(2500, -1); expect(b[1]).toBeCloseTo(-1000, -1); expect(b[3]).toBeCloseTo(150, 0); expect(b[4]).toBeCloseTo(0, 0); expect(b[5]).toBeCloseTo(-900, 0); expect(b[6]).toBe(40)
  })

  it.skipIf(!has("Bolder Flight Systems BMI088"))("BMI088 (Bolder Flight): begin with self-test, m/s² and rad/s", () => {
    const r = run(`#include "BMI088.h"
Bmi088Accel accel(Wire, 0x19); Bmi088Gyro gyro(Wire, 0x69);
void setup(){ Serial.begin(115200); int a = accel.begin(); int g = gyro.begin(); Serial.print("st "); Serial.print(a); Serial.print(" "); Serial.println(g); }
void loop(){ accel.readSensor(); gyro.readSensor(); Serial.print("a "); Serial.print(accel.getAccelX_mss()); Serial.print(" "); Serial.print(accel.getAccelZ_mss());
  Serial.print(" "); Serial.print(gyro.getGyroZ_rads()); Serial.print(" "); Serial.println(accel.getTemperature_C()); delay(100); }`,
      "sb-grove-6-axis-accelerometer-gyroscope-bmi088", { lib: "Bolder_Flight_Systems_BMI088", ms: 1200, then: [{ v: { ax: -2, gz: 180, t: 31.5 } }], thenMs: 400 })
    expect(last(r.serial, "st ")).toBe("st 1 1")
    const [ax, az, , t] = nums(last(r.serial, "a "))
    expect(ax).toBeCloseTo(0, 1); expect(az).toBeCloseTo(-9.81, 1); // the library's frame: Y and Z flipped (tY, tZ) expect(t).toBeCloseTo(24, 1)
    const [ax2, , gz2, t2] = nums(last(r.after, "a "))
    expect(ax2).toBeCloseTo(-19.6, 0); expect(gz2).toBeCloseTo(-Math.PI, 2); expect(t2).toBeCloseTo(31.5, 1)
  })

  it.skipIf(!has("SparkFun AS3935 Lightning Detector Arduino Library"))("AS3935: a click is a strike — IRQ, INT_L, distance, energy", () => {
    const r = run(`#include <Wire.h>
#include "SparkFun_AS3935.h"
SparkFun_AS3935 lightning(0x03);
void setup(){ Serial.begin(115200); Wire.begin(); pinMode(2, INPUT); Serial.println(lightning.begin() ? "ok" : "no");
  lightning.resetSettings(); lightning.setIndoorOutdoor(INDOOR); Serial.println(lightning.wakeUp() ? "cal" : "nocal"); Serial.print("nf "); Serial.println(lightning.readNoiseLevel()); }
void loop(){ if (digitalRead(2) == HIGH) { uint8_t i = lightning.readInterruptReg();
  if (i == LIGHTNING) { Serial.print("L "); Serial.print(lightning.distanceToStorm()); Serial.print(" "); Serial.println(lightning.lightningEnergy()); }
  else if (i == DISTURBER_DETECT) Serial.println("D"); else if (i == NOISE_TO_HIGH) Serial.println("N"); }
  delay(5); }`,
      "sb-grove-lightning-sensor-as3935", { wires: [["d:IRQ", "b:2"]], ms: 500, then: [{ v: { dist: 20, energy: 123456 } }, { active: true }, { active: false }], thenMs: 300 })
    expect(r.serial).toContain("ok"); expect(r.serial).toContain("cal"); expect(r.serial).toContain("nf 2")
    expect(lines(r.serial).some((l) => l.startsWith("L "))).toBe(false)
    expect(lines(r.after).filter((l) => l.startsWith("L "))).toEqual(["L 20 123456"]) // once: reading the register drops IRQ
  })

  it.skipIf(!has("Adafruit DPS310"))("DPS310: Infineon compensation gives the sliders", () => {
    const r = run(`#include <Adafruit_DPS310.h>
Adafruit_DPS310 dps;
void setup(){ Serial.begin(115200); Serial.println(dps.begin_I2C() ? "ok" : "no"); }
void loop(){ sensors_event_t t, p; dps.getEvents(&t, &p); Serial.print("v "); Serial.print(p.pressure); Serial.print(" "); Serial.println(t.temperature); delay(100); }`,
      "sb-grove-high-precision-barometric-pressure-sensor-dps310", { ms: 1200, then: [{ v: { p: 875.4, t: -12.3 } }], thenMs: 500 })
    expect(r.serial).toContain("ok")
    const [p, t] = nums(last(r.serial, "v "))
    expect(p).toBeCloseTo(1013.25, 1); expect(t).toBeCloseTo(24, 1)
    const [p2, t2] = nums(last(r.after, "v "))
    expect(p2).toBeCloseTo(875.4, 1); expect(t2).toBeCloseTo(-12.3, 1)
  })

  it.skipIf(!has("Seeed Arduino SPA06"))("SPA06-003 (Seeed): compensation with c31/c40 gives the sliders", () => {
    const r = run(`#include <Wire.h>
#include "SPL07-003.h"
SPL07_003 spl;
void setup(){ Serial.begin(115200); Wire.begin(); Serial.println(spl.begin(SPL07_ADDR_DEF, &Wire) ? "ok" : "no");
  spl.setPressureConfig(SPL07_4HZ, SPL07_32SAMPLES); spl.setTemperatureConfig(SPL07_4HZ, SPL07_1SAMPLE); spl.setMode(SPL07_CONT_PRES_TEMP); }
void loop(){ if (spl.pressureAvailable() || spl.temperatureAvailable()) { Serial.print("v "); Serial.print(spl.readPressure(), 2); Serial.print(" "); Serial.println(spl.readTemperature(), 2); } delay(20); }`,
      "sb-grove-temperature-and-barometer-sensor-spa06-003", { ms: 1500, then: [{ v: { p: 1050.6, t: 51.2 } }], thenMs: 800 })
    expect(r.serial).toContain("ok")
    const [p, t] = nums(last(r.serial, "v "))
    expect(p).toBeCloseTo(101325, -1); expect(t).toBeCloseTo(24, 1)
    const [p2, t2] = nums(last(r.after, "v "))
    expect(p2).toBeCloseTo(105060, -1); expect(t2).toBeCloseTo(51.2, 1)
  })

  it.skipIf(!has("Adafruit SPA06_003"))("SPA06-003 (Adafruit)", () => {
    const r = run(`#include <Adafruit_SPA06_003.h>
Adafruit_SPA06_003 spa;
void setup(){ Serial.begin(115200); Serial.println(spa.begin() ? "ok" : "no"); }
void loop(){ if (spa.isPresDataReady()) { Serial.print("v "); Serial.print(spa.readPressure()); Serial.print(" "); Serial.println(spa.readTemperature()); } delay(50); }`,
      "sb-grove-temperature-and-barometer-sensor-spa06-003", { ms: 1200, then: [{ v: { p: 640.2, t: 3.4 } }], thenMs: 600 })
    expect(r.serial).toContain("ok")
    const [p2, t2] = nums(last(r.after, "v "))
    expect(p2).toBeCloseTo(640.2, 1); expect(t2).toBeCloseTo(3.4, 1)
  })

  it.skipIf(!has("Grove barometer HP20x"))("HP206C: commands, 20-bit pressure / temperature / altitude", () => {
    const r = run(`#include <HP20x_dev.h>
#include <Wire.h>
void setup(){ Serial.begin(115200); delay(150); HP20x.begin(); delay(100); Serial.println(HP20x.isAvailable() == OK_HP20X_DEV ? "ok" : "no"); }
void loop(){ long t = HP20x.ReadTemperature(); long p = HP20x.ReadPressure(); long a = HP20x.ReadAltitude();
  Serial.print("v "); Serial.print(t / 100.0); Serial.print(" "); Serial.print(p / 100.0); Serial.print(" "); Serial.println(a / 100.0); delay(100); }`,
      "sb-grove-barometer-sensor-high-accuracy-hp206c", { ms: 900, then: [{ v: { p: 954.3, t: -5.5 } }], thenMs: 500 })
    expect(r.serial).toContain("ok")
    const [t, p, a] = nums(last(r.serial, "v "))
    expect(t).toBeCloseTo(24, 2); expect(p).toBeCloseTo(1013.25, 2); expect(a).toBeCloseTo(0, 1)
    const [t2, p2, a2] = nums(last(r.after, "v "))
    expect(t2).toBeCloseTo(-5.5, 2); expect(p2).toBeCloseTo(954.3, 2); expect(a2).toBeCloseTo(503.4, -1)
  })
})
