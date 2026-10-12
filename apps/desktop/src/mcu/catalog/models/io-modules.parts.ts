// Catalogue entries for the io-modules parts: their model (and look / pins / hint when they change).
import type { Ctl } from "../types"
import type { PartPatch } from "./types"

const c = (key: string, label: string, min: number, max: number, step: number, unit: string, def: number): Ctl => ({ key, label, min, max, step, unit, def })
const sw = (key: string, label: string) => c(key, label, 0, 1, 1, "", 0)

export const PARTS: Record<string, PartPatch> = {
  "sb-grove-smart-ir-gesture-sensor-pag7660": {
    model: { m: "proto", kind: "pag7660", ctls: [c("gesture", "Gesture (0 none, 1–5 fingers, 6/7 rotate CW/CCW, 8/9 swipe L/R, 10–14 push 1–5, 15/16 thumb up/down, 17 tap, 18 grab, 19 pinch)", 0, 19, 1, "", 0), c("angle", "Rotation", 0, 360, 15, "°", 90)] },
    hint: "PAG7660 at I²C 0x68 (Seeed Grove Gesture library, pag7660): ID, frame-ready flag and the gesture output registers. Pick a gesture with the slider — fingers and thumbs are reported while held, swipes, rotations, pushes and taps once. The P0–P13 header (SPI/GPIO mode) is passive.",
  },
  "sb-rgb-encoder-wheel": {
    model: { m: "proto", kind: "rgb-encoder-wheel", ctls: [c("turn", "Wheel position", -240, 240, 1, "detents", 0), sw("up", "Up button"), sw("down", "Down button"), sw("left", "Left button"), sw("right", "Right button"), sw("centre", "Centre button")] },
    look: { k: "strip", count: 24, ring: true, color: "#111" },
    hint: "Pimoroni RGB Encoder Wheel at register level: the Nuvoton IO expander at 0x13 (chip ID, reset, bit-addressed ports, encoder count, interrupt flag and INT pin) and the IS31FL3731 LED driver at 0x77 lighting the 24-LED ring. Turn the wheel and press the five buttons with the sliders.",
  },
  "sb-grove-nfc-pn532": {
    model: { m: "proto", kind: "pn532", ctls: [sw("tag", "Tag on the reader"), c("type", "Tag type (0 MIFARE Classic 1K, 1 NTAG213)", 0, 1, 1, "", 0), c("uid", "Tag number (sets the UID)", 1, 9999, 1, "", 1234)] },
    hint: "PN532 at I²C 0x24 (Adafruit_PN532 or Seeed PN532_I2C): framed commands with ACK, ready byte and NACK resend — firmware version, SAMConfig, InListPassiveTarget, InDataExchange with MIFARE Classic auth/read/write and NTAG read/write. Put a tag on the reader with the slider; each tag keeps what you write while the sketch runs.",
  },
  "sb-grove-red-led-matrix-w-driver": {
    model: { m: "i2c", chip: "seeed-ht16k33-matrix", addr: 0x70 },
    hint: "HT16K33 at I²C 0x70 driving the red 8×8 matrix (Seeed's Grove_LED_Matrix_Driver_HT16K33, Matrix_8x8): oscillator, display/blink and RAM, drawn the way Seeed wires it — bars, icons, numbers, strings and pictures appear as on the real board.",
  },
  "sb-grove-8x8-rgb-led-matrix-w-driver": {
    model: { m: "i2c", chip: "seeed-rgb-matrix", addr: 0x65 },
    look: { k: "screen", color: "#1a1a1a", label: "RGB 8×8", sw: 64, sh: 64 },
    hint: "Seeed's matrix driver MCU at I²C 0x65 (grove_two_rgb_led_matrix library): device ID 0x2886, bars, emoji, numbers, scrolling strings, custom frames, colour block/bar/wave, clockwise and animations, rotation and offset. Built-in emoji and animations are close approximations of the firmware's.",
  },
  "sb-m5stack-chain-mono-matrix-8-8-white": {
    model: { m: "proto", kind: "m5chain-mono" },
    hint: "M5Stack Chain bus at 115200 baud (M5Chain library's packet format AA 55 … 55 AA): heartbeat, enumeration and device type, then the Chain Mono commands — pixels, buffer, characters, scrolling text, rotation, brightness, clear. Units after it in the circuit join the chain (IDs 2, 3 …).",
  },
  "sb-m5stack-chain-rgb-matrix-8-8": {
    model: { m: "proto", kind: "m5chain-rgb" },
    hint: "M5Stack Chain bus at 115200 baud (M5Chain library's packet format AA 55 … 55 AA): heartbeat, enumeration and device type, then the Chain RGB commands — RGB565 pixels, buffer, characters, scrolling text, rotation, brightness, clear. Units after it in the circuit join the chain (IDs 2, 3 …).",
  },
  "sb-cob-led-driver-board-for-xiao": {
    model: { m: "proto", kind: "xiao-cob" },
    pins: ["D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9", "D10", "5V", "3V3", "GND"],
    look: { k: "strip", count: 7, color: "#111" },
    hint: "Seeed COB LED driver for XIAO: seven COB strip ports — VCC always on, D0/D1 high-power switches (HIGH = on), D2/D3/D8/D9 dimmable (active LOW: analogWrite(pin, 255 − brightness)). Each port glows with its pin's PWM duty.",
  },
  "sb-grove-recorder-v3-0": {
    model: { m: "proto", kind: "recorder-v3", ctls: [sw("button", "On-board button (hold 2 s to record)")] },
    hint: "Grove Recorder v3.0 (ISD9160): SIG2 LOW records (up to 83 s), a LOW pulse on SIG plays the recording back as a voice-like sound for as long as it was recorded. The on-board button works too: a short press plays, holding it 2 s records.",
  },
  "sb-grove-12-channel-capacitive-touch-keypad-attiny1616": {
    model: { m: "proto", kind: "touch-keypad-12", ctls: [c("key", "Touch key (1–9, 10 = *, 11 = 0, 12 = #)", 0, 12, 1, "", 0)] },
    hint: "ATtiny1616 touch keypad on UART at 9600 baud (Seeed's 12_Channel_Keypad sketch): every touch sends one byte, 0xE1–0xE9 for 1–9, 0xEA *, 0xEB 0, 0xEC #. Touch a key with the slider.",
  },
  "sb-grove-capacitive-fingerprint-scanner": {
    model: { m: "proto", kind: "kct202", ctls: [c("finger", "Finger on the pad (0 none, 1–10 which finger)", 0, 10, 1, "", 0)] },
    hint: "KCT202 fingerprint module at 57600 baud (Seeed_Arduino_KCT202): EF 01 packets with checksums — auto-register (N captures), auto-verify, delete, clean, template count and index, password, LED ring control. Put a finger (1–10) on the pad with the slider; templates stay while the sketch runs.",
  },
  "sb-grove-ultrasonic-sensor-us5": {
    model: { m: "proto", kind: "sms812", ctls: [c("mm", "Distance", 20, 5000, 1, "mm", 500), c("soft", "Soft surface (0 hard, 1 soft)", 0, 1, 1, "", 0)] },
    hint: "Grove UART ultrasonic sensor (SMS812 protocol, SeeedStudio_SMS812_Sensor) at 115200 baud: reports AA AA FD 04 material, distance (mm), strength, checksum — 100 per second in UART mode, on request in REQ mode; IO mode puts the soft/hard flag on TX.",
  },
}
