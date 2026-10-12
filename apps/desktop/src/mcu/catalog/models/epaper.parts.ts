// Catalogue entries for the epaper parts: their model (and look / pins / hint when they change).
import type { PartPatch } from "./types"

const ssd = (chip: string, cls: string, extra = "") =>
  `${chip} e-paper controller at command level (RAM window, data entry mode, 0x24/0x26 RAM, update control and master activation): GxEPD2 ${cls} works unchanged. The picture changes only on a refresh, with BUSY HIGH while it runs${extra}.`
const uc = (chip: string, cls: string, extra = "") =>
  `${chip} e-paper controller at command level (0x10/0x13 data, partial window, 0x50 data polarity, 0x12 refresh): GxEPD2 ${cls} works unchanged. The picture changes only on a refresh, with BUSY LOW (BUSY_N) while it runs${extra}.`

export const PARTS: Record<string, PartPatch> = {
  "sb-epaper-1-54-200-200-b-w": { model: { m: "proto", kind: "epd-154-ssd1681" }, hint: ssd("SSD1681 200×200", "GxEPD2_BW<GxEPD2_154_D67>", "; partial refresh is faster") },
  "sb-epaper-2-13-250-122-b-w": { model: { m: "proto", kind: "epd-213-ssd1680" }, hint: ssd("SSD1680 122×250 (DEPG0213BN)", "GxEPD2_BW<GxEPD2_213_BN>", "; drawn landscape as setRotation(1) shows it") },
  "sb-epaper-2-13-250-122-b-w-red": { model: { m: "proto", kind: "epd-213c-ssd1680" }, hint: ssd("SSD1680 3-colour 122×250 (B/W RAM 0x24 + red RAM 0x26)", "GxEPD2_3C<GxEPD2_213_Z98c>", "; drawn landscape") },
  "sb-epaper-2-9-296-128-b-w": { model: { m: "proto", kind: "epd-290-ssd1680" }, hint: ssd("SSD1680 128×296 (GDEY029T94)", "GxEPD2_BW<GxEPD2_290_GDEY029T94> / GxEPD2_290_T94", "; drawn landscape as setRotation(1) shows it") },
  "sb-epaper-2-9-296-128-b-w-red": { model: { m: "proto", kind: "epd-290c-ssd1680" }, hint: ssd("SSD1680 3-colour 128×296", "GxEPD2_3C<GxEPD2_290_C90c>", "; drawn landscape") },
  "sb-epaper-4-2-400-300-b-w": { model: { m: "proto", kind: "epd-420-uc8176" }, hint: uc("UC8176 400×300 (GDEW042T2)", "GxEPD2_BW<GxEPD2_420>") },
  "sb-epaper-5-65-600-448-7-colour": { model: { m: "proto", kind: "epd-565-acep" }, hint: uc("ACeP 7-colour 600×448 (Waveshare 5.65\" / GDEP0565D90, 4 bits a pixel)", "GxEPD2_7C<GxEPD2_565c>") },
  "sb-epaper-7-5-800-480-b-w": { model: { m: "proto", kind: "epd-750-uc8179" }, hint: uc("UC8179 800×480 (GDEY075T7)", "GxEPD2_BW<GxEPD2_750_T7>") },
  "sb-grove-triple-color-e-ink-display-2-13": {
    model: { m: "proto", kind: "grove-eink-213" },
    hint: "Seeed's on-board MCU protocol at 230400 baud: it sends 'c', the sketch answers 'a', the module acks 'b' and takes the 104×212 black and red planes (2 × 2756 bytes, 0 = ink), then refreshes — Seeed's Eink_factory_code_213 sketch works unchanged.",
  },
}
