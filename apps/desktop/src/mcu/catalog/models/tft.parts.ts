// Catalogue entries for the tft parts: their model (and look / pins / hint when they change).
import type { PartPatch } from "./types"

export const PARTS: Record<string, PartPatch> = {
  // Wokwi's own ILI9341 element: the picture goes into its canvas (240×320)
  "wokwi-ili9341": {
    model: { m: "proto", kind: "ili9341" },
    hint: "ILI9341 240×320 SPI TFT (Adafruit_ILI9341 + Adafruit_GFX): CASET/PASET/RAMWR, MADCTL rotation and BGR, 16/18-bit colour, sleep/display on, inversion, RST and the ID reads are modelled. Wire SCK/MOSI/MISO to the SPI pins, CS and D/C to any pins; LED high (or unwired) lights it.",
  },
  "sb-2-8-tft-touch-ili9341-xpt2046": {
    model: { m: "proto", kind: "ili9341-touch" },
    hint: "ILI9341 240×320 TFT (Adafruit_ILI9341) plus an XPT2046 touch controller on T_CLK/T_CS/T_DIN/T_DO (XPT2046_Touchscreen; it may share the SPI pins). Press or drag on the screen while running to touch it — raw 200…3900, T_IRQ low while touched.",
  },
  "sb-3-5-tft-480x320-touch-ili9488-xpt2046": {
    model: { m: "proto", kind: "ili9488-touch" },
    look: { k: "screen", color: "#b91c1c", sw: 120, sh: 180, w: 150, h: 220 },
    hint: "ILI9488 320×480 TFT over SPI, 18-bit colour (COLMOD 0x66 — GFX Library for Arduino's Arduino_ILI9488_18bit; best on the Pico or Mega) plus an XPT2046 touch controller (XPT2046_Touchscreen). Press or drag on the screen while running to touch it.",
  },
  "sb-round-display-for-xiao-1-28-gc9a01": {
    model: { m: "proto", kind: "gc9a01-touch" },
    hint: "GC9A01 240×240 round TFT (Adafruit_GC9A01A or Arduino_GFX) with CHSC6X touch at I²C 0x2E. Header pins as on the XIAO: D8 SCK, D10 MOSI, D9 MISO, D1 CS, D3 DC, D6 backlight, D4 SDA / D5 SCL (touch), D7 touch INT (low while touched), D2 SD CS (not modelled). Wire them to an UNO/Mega/Pico's SPI and I²C pins. Press on the screen to touch it.",
  },
  "sb-grove-1-22-ips-display-240x240": {
    model: { m: "proto", kind: "st7789-grove" },
    hint: "ST7789 240×240 IPS on a 2-wire Grove link: 9-bit 3-line serial (D/C bit + 8 bits on SDA, clocked by SCL; CS is tied low on the board) — Seeed's Arduino_ST7789_Fast fork (Arduino_ST7789 lcd(SCK, SDA)). Wire SCL/SDA to any two digital pins.",
  },
  "sb-ssd1306-oled-spi-7-pin": {
    model: { m: "proto", kind: "ssd1306-spi" },
    hint: "SSD1306 128×64 OLED over 4-wire SPI (Adafruit_SSD1306 SPI constructor or U8g2 4W SPI): D0 = SCK, D1 = MOSI, DC low = commands / high = data, RES resets, CS selects.",
  },
  "sb-grove-oled-display-1-12-ssd1327-96-96-grey": {
    model: { m: "i2c", chip: "ssd1327", addr: 0x3c },
    hint: "SSD1327 4-bit greyscale OLED, 96×96 visible, on I²C 0x3C (U8g2 U8G2_SSD1327_SEEED_96X96_…_HW_I2C): GDDRAM, column/row windows, remap, display on/off and inverse are modelled.",
  },
}
