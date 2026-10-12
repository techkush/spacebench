// Catalogue entries for the thermal parts: their model (and look / pins / hint when they change).
import type { Ctl } from "../types"
import type { PartPatch } from "./types"

const c = (key: string, label: string, min: number, max: number, step: number, unit: string, def: number): Ctl => ({ key, label, min, max, step, unit, def })
const scene = (hotMax: number): Ctl[] => [
  c("amb", "Ambient (sensor) temperature", -20, 60, 0.1, "°C", 24),
  c("bg", "Background", -20, 100, 0.1, "°C", 22),
  c("hot", "Hot spot", -20, hotMax, 0.5, "°C", 36.5),
  c("hx", "Hot spot X", 0, 100, 0.5, "%", 50),
  c("hy", "Hot spot Y", 0, 100, 0.5, "%", 50),
  c("hs", "Hot spot size", 2, 100, 1, "%", 25),
  c("spd", "Hot spot motion", 0, 1, 0.05, "Hz", 0),
]
const look = (chip: string, sw: number, sh: number) => ({ k: "screen" as const, color: "#2f6db5", label: chip, sw, sh })
const SCENE = "The scene is a background and a round hot spot (temperature, X/Y across the picture, size, optional motion) in front of a sensor at the ambient temperature; the part shows what it sees in false colour."
const x64 = (chip: string, res: string) =>
  `${chip} (${res}) at register level: calibration EEPROM at 0x2400 and RAM frames at 0x0400 with status 0x8000 (subpage, data ready) and control 0x800D (refresh rate, resolution, chess/interleaved), measured subpage by subpage — Seeed_Arduino_MLX9064x${chip === "MLX90640" ? " / Adafruit MLX90640" : ""} (Melexis' driver) computes the temperatures. ${SCENE}`

export const PARTS: Record<string, PartPatch> = {
  "sb-grove-thermal-imaging-camera-mlx90640-110": { model: { m: "i2c", chip: "mlx90640", addr: 0x33, ctls: scene(300) }, look: look("MLX90640", 64, 48), hint: x64("MLX90640", "32×24, 110°×75°") },
  "sb-grove-thermal-imaging-camera-mlx90641-bca-110": { model: { m: "i2c", chip: "mlx90641-110", addr: 0x33, ctls: scene(300) }, look: look("MLX90641", 64, 48), hint: x64("MLX90641", "16×12, 110°×75°") },
  "sb-grove-thermal-imaging-camera-mlx90641-bcb-55": { model: { m: "i2c", chip: "mlx90641-55", addr: 0x33, ctls: scene(300) }, look: look("MLX90641", 64, 48), hint: x64("MLX90641", "16×12, 55°×35°") },
  "sb-grove-thermal-imaging-camera-mlx90621-bab-60": {
    model: { m: "i2c", chip: "mlx90621", addr: 0x60, ctls: scene(300) },
    look: look("MLX90621", 80, 20),
    hint: `MLX90621 (16×4, 60°×16°) at command level: calibration EEPROM at 0x50, IR/PTAT/CP RAM read with command 0x02, configuration (0x03, POR flag) and trim (0x04) writes with their check bytes — DFRobot_MLX90621 and Melexis' MLX90621 driver compute the temperatures. ${SCENE}`,
  },
}
