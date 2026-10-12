// Catalogue entries for the spi-sensors parts: their model (and look / pins / hint when they change).
import type { Ctl } from "../types"
import type { PartPatch } from "./types"

const c = (key: string, label: string, min: number, max: number, step: number, unit: string, def: number): Ctl => ({ key, label, min, max, step, unit, def })

export const PARTS: Record<string, PartPatch> = {
  "sb-max31856-universal-thermocouple": {
    model: { m: "proto", kind: "max31856", ctls: [c("t", "Hot junction", -210, 1820, 0.25, "°C", 100), c("cj", "Cold junction", -55, 125, 0.25, "°C", 25), c("open", "Open thermocouple (1 = open)", 0, 1, 1, "", 0)] },
    hint: "MAX31856 at register level (CR0/CR1, fault thresholds, CJTO, 19-bit linearized LTC, CJTH/CJTL, SR fault bits; one-shot and auto conversions with real conversion times) — works with Adafruit_MAX31856. Sliders: hot- and cold-junction °C (range per thermocouple type) and an open-thermocouple fault.",
  },
  "sb-max31865-pt100-rtd": {
    model: { m: "proto", kind: "max31865", ctls: [c("t", "RTD temperature", -200, 850, 0.1, "°C", 25), c("r0", "RTD nominal (PT100 / PT1000)", 100, 1000, 900, "Ω", 100), c("rref", "Reference resistor", 100, 5000, 10, "Ω", 430), c("fault", "Fault (0 none, 1 open, 2 short)", 0, 2, 1, "", 0)] },
    hint: "MAX31865 at register level (config bits: bias, auto / 1-shot, 3-wire, 50/60 Hz; RTD ratio from a Callendar–Van Dusen PT100/PT1000 with Rref 430/4300 Ω; fault thresholds and status) — works with Adafruit_MAX31865. Sliders: temperature, RTD type, Rref and an open/short fault.",
  },
  "wokwi-microsd-card": {
    model: { m: "proto", kind: "sdcard", ctls: [c("card", "Card inserted", 0, 1, 1, "", 1)] },
    hint: "A 128 MB SDHC card in SPI mode (CMD0/8/55+ACMD41/58/9/10/13/16/17/18/24/25/12, data tokens, CRC16) with a real FAT16 volume holding README.TXT — the Arduino SD library (and SdFat) can begin, ls, open, write and read; files last while the sketch runs. CD is LOW while the card is in; it glows on activity.",
  },
}
