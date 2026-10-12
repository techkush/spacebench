// Catalogue entries for the i2c-sensors parts: their model (and look / pins / hint when they change).
import type { Ctl } from "../types"
import type { PartPatch } from "./types"

const c = (key: string, label: string, min: number, max: number, step: number, unit: string, def: number): Ctl => ({ key, label, min, max, step, unit, def })
const accel = (lim: number, step: number): Ctl[] => [c("ax", "Accel X", -lim, lim, step, "g", 0), c("ay", "Accel Y", -lim, lim, step, "g", 0), c("az", "Accel Z", -lim, lim, step, "g", 1)]
const gyro = (lim: number): Ctl[] => [c("gx", "Gyro X", -lim, lim, 1, "°/s", 0), c("gy", "Gyro Y", -lim, lim, 1, "°/s", 0), c("gz", "Gyro Z", -lim, lim, 1, "°/s", 0)]
const temp = c("t", "Temperature", -40, 85, 0.1, "°C", 24)
const baro = [c("p", "Pressure", 300, 1100, 0.1, "hPa", 1013.25), temp]

export const PARTS: Record<string, PartPatch> = {
  "sb-grove-step-counter-bma456": {
    model: { m: "i2c", chip: "bma456", addr: 0x19, ctls: [...accel(16, 0.01), temp, c("walk", "Walking pace", 0, 200, 1, "steps/min", 0)] },
    hint: "BMA456 at 0x19 (Seeed Grove Step Counter / Bosch BMA456 API): chip ID 0x16, the 6 kB config upload and INTERNAL_STATUS, accel and temperature from the sliders; with the step counter enabled it counts at the walking-pace slider.",
  },
  "sb-grove-3-axis-digital-compass-v2-bmm150": {
    model: { m: "i2c", chip: "bmm150", addr: 0x13, ctls: [c("mx", "Field X", -400, 400, 1, "µT", 22), c("my", "Field Y", -400, 400, 1, "µT", -5), c("mz", "Field Z", -400, 400, 1, "µT", -42)] },
    hint: "BMM150 at 0x13 (Seeed Grove Compass V2 / DFRobot_BMM150): power and op modes, chip ID 0x32, trim registers and raw X/Y/Z/RHALL chosen so Bosch's compensation gives the field sliders (µT).",
  },
  "sb-grove-3-axis-digital-accelerometer-200g-adxl372": {
    model: { m: "i2c", chip: "adxl372", addr: 0x53, ctls: accel(200, 0.1) },
    hint: "ADXL372 at 0x53 (Seeed Grove ADXL372 library): IDs AD/1D/FA, 12-bit data at 100 mg/LSB, status, peak registers, POWER_CTL modes (instant-on captures only above its 10/30 g threshold) and the 512-sample FIFO at the set ODR.",
  },
  "sb-grove-6-axis-accelerometer-gyroscope-bmi088": {
    model: { m: "i2c", chip: "bmi088", addr: 0x19, ctls: [...accel(24, 0.01), ...gyro(2000), temp] },
    hint: "BMI088: accelerometer at 0x19 (chip ID 0x1E) and gyroscope at 0x69 (0x0F) — power conf/ctrl, ranges, self-test and temperature; works with the Seeed Grove BMI088 and Bolder Flight BMI088 libraries.",
  },
  "sb-grove-lightning-sensor-as3935": {
    model: {
      m: "proto", kind: "as3935",
      ctls: [c("dist", "Storm distance", 1, 45, 1, "km", 12), c("energy", "Strike energy", 0, 2000000, 1000, "", 250000), c("rate", "Strikes", 0, 60, 1, "/min", 0), c("drate", "Disturbers", 0, 60, 1, "/min", 0), c("noise", "Noise", 0, 2500, 1, "µVrms", 10)],
    },
    hint: "AS3935 at 0x03 (SparkFun AS3935 / Grove library): click the part for a lightning strike — IRQ goes high, INT_L, distance and energy are set until the interrupt register is read. Sliders: distance, energy, strike / disturber rates, noise (INT_NH).",
  },
  "sb-grove-high-precision-barometric-pressure-sensor-dps310": {
    model: { m: "i2c", chip: "dps310", addr: 0x77, ctls: baro },
    hint: "DPS310 at 0x77 (Adafruit DPS310): product ID 0x10, calibration coefficients, oversampling scale factors and MEAS_CFG ready bits; raw values invert Infineon's compensation to the pressure and temperature sliders.",
  },
  "sb-grove-temperature-and-barometer-sensor-spa06-003": {
    model: { m: "i2c", chip: "spa06", addr: 0x77, ctls: baro },
    hint: "SPA06-003 at 0x77 (Seeed Arduino SPA06 / Adafruit SPA06_003): ID 0x11, 21 coefficient bytes with c31/c40, ready bits and measurement timing; raw values invert the compensation to the sliders.",
  },
  "sb-grove-barometer-sensor-high-accuracy-hp206c": {
    model: { m: "i2c", chip: "hp206c", addr: 0x76, ctls: baro },
    hint: "HP206C at 0x76 (Grove barometer HP20x): SOFT_RST, ADC_CVT, READ_PT/AT/P/A/T and register commands; 20-bit pressure (Pa), temperature (0.01 °C) and altitude (cm) from the sliders.",
  },
}
