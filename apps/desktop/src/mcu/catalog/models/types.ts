// What a family of part models gives the simulator (behaviour) and the catalogue (entries).
import type { CatalogPart, Look, Model } from "../types"
import type { CatDevice, SimCtx } from "../devices"
import type { Chip } from "../i2c"

/** a protocol device (model { m: "proto", kind }) */
export type ProtoMaker = (c: CatalogPart, ctx: SimCtx) => CatDevice | null
/** an I²C chip (model { m: "i2c", chip, addr }) — it may also use ctx.spi / ctx.uart / pins */
export type ChipMaker = (ctx: SimCtx, addr: number) => Chip | null

export interface ModelGroup {
  proto?: Record<string, ProtoMaker>
  chips?: Record<string, ChipMaker>
}

/**
 * A catalogue entry's simulation, by part type ("sb-max31856-universal-thermocouple"): its model,
 * and — only when they need to change — its look, pins and hint (the hint defaults to the model's
 * description; proto models should give one: what the simulation does, in a sentence).
 */
export interface PartPatch {
  model: Model
  look?: Look
  pins?: string[]
  hint?: string
  /** default attributes (merged over the entry's) and the Settings fields that edit them */
  attrs?: Record<string, string>
  settings?: CatalogPart["settings"]
}
