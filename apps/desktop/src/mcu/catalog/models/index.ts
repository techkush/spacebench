// Part models, one file per family (SPI sensors, TFTs, e-paper, …). Each family's `<name>.ts`
// exports its behaviour (protocol devices by kind, I²C chips by name) and `<name>.parts.ts` the
// catalogue entries that use it. devices.ts / i2c.ts fall back to these registries.
//
// Building blocks (see ../devices.ts and ../i2c.ts):
//  - ctx.spi(dev)       an SPI peripheral (hardware SPI and bit-banged clocks), dev = { out(), in(b), select?(), deselect?() }
//  - ctx.uart({ rx, tx, baud, onByte })   bytes from the board (hardware Serial/Serial1 or SoftwareSerial) and .send()
//  - ctx.i2c(addr, dev) an I²C device; Regs / Reg16 / Cmd8 / Cmd16 in ../i2c.ts model register files and commands
//  - ctx.level(pin), ctx.hook(ctx.pin(pin), fn), ctx.drive / ctx.set, ctx.after, ctx.ctl(slider), ctx.ui()
//  - view(): ModView — glow, pix, rows, text, bitmap (1 bpp), image (RGBA with a version from nextImageVer())
import type { ChipMaker, ModelGroup, ProtoMaker } from "./types"
import aiVoice from "./ai-voice"
import comm from "./comm"
import epaper from "./epaper"
import i2cSensors from "./i2c-sensors"
import ioModules from "./io-modules"
import linuxDevices from "./linux-devices"
import spiSensors from "./spi-sensors"
import tft from "./tft"
import thermal from "./thermal"

export type { ChipMaker, ModelGroup, PartPatch, ProtoMaker } from "./types"

const GROUPS: ModelGroup[] = [spiSensors, tft, epaper, i2cSensors, thermal, ioModules, comm, aiVoice, linuxDevices]
export const PROTO: Record<string, ProtoMaker> = Object.assign({}, ...GROUPS.map((g) => g.proto ?? {}))
export const CHIPS: Record<string, ChipMaker> = Object.assign({}, ...GROUPS.map((g) => g.chips ?? {}))
