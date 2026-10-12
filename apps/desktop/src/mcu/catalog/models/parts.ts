// Every family's catalogue entries (data only — data.ts applies them; no behaviour imported here).
import type { PartPatch } from "./types"
import { PARTS as aiVoice } from "./ai-voice.parts"
import { PARTS as comm } from "./comm.parts"
import { PARTS as epaper } from "./epaper.parts"
import { PARTS as i2cSensors } from "./i2c-sensors.parts"
import { PARTS as ioModules } from "./io-modules.parts"
import { PARTS as linuxDevices } from "./linux-devices.parts"
import { PARTS as spiSensors } from "./spi-sensors.parts"
import { PARTS as tft } from "./tft.parts"
import { PARTS as thermal } from "./thermal.parts"

export const PATCHES: Record<string, PartPatch> = { ...spiSensors, ...tft, ...epaper, ...i2cSensors, ...thermal, ...ioModules, ...comm, ...aiVoice, ...linuxDevices }
