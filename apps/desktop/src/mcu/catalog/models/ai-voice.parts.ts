// Catalogue entries for the ai-voice parts: their model (and look / pins / hint when they change).
import type { Ctl } from "../types"
import type { PartPatch } from "./types"

const c = (key: string, label: string, min: number, max: number, step: number, unit: string, def: number): Ctl => ({ key, label, min, max, step, unit, def })

// HuskyLens: the algorithm and up to three objects in view (320×240 frame; ID 0 = seen but not learned)
const HUSKY_CTLS: Ctl[] = [
  c("algo", "Algorithm (0 face, 1 track, 2 object, 3 line, 4 colour, 5 tag, 6 class)", 0, 6, 1, "", 0),
  c("n", "Objects in view", 0, 3, 1, "", 1),
  ...[1, 2, 3].flatMap((i) => [
    c(`id${i}`, `Object ${i} ID (0 = not learned)`, 0, 20, 1, "", i),
    c(`x${i}`, `Object ${i} X centre (arrow: from X)`, 0, 319, 1, "px", 60 + 100 * (i - 1)),
    c(`y${i}`, `Object ${i} Y centre (arrow: from Y)`, 0, 239, 1, "px", 120),
    c(`w${i}`, `Object ${i} width (arrow: to X)`, 0, 319, 1, "px", 60),
    c(`h${i}`, `Object ${i} height (arrow: to Y)`, 0, 239, 1, "px", 80),
  ]),
]

// Grove Vision AI V2 (SSCMA): the model and up to three detections (240×240 input, boxes by centre)
const SSCMA_CTLS: Ctl[] = [
  c("model", "Model (0 detection, 1 classification)", 0, 1, 1, "", 0),
  c("n", "Objects detected", 0, 3, 1, "", 1),
  ...[1, 2, 3].flatMap((i) => [
    c(`t${i}`, `Object ${i} target class`, 0, 79, 1, "", 0),
    c(`s${i}`, `Object ${i} score`, 0, 100, 1, "%", 85),
    c(`x${i}`, `Object ${i} X centre`, 0, 239, 1, "px", 60 * i),
    c(`y${i}`, `Object ${i} Y centre`, 0, 239, 1, "px", 120),
    c(`w${i}`, `Object ${i} width`, 0, 240, 1, "px", 50),
    c(`h${i}`, `Object ${i} height`, 0, 240, 1, "px", 90),
  ]),
]
const SSCMA_HINT = "Grove Vision AI V2 (SSCMA firmware) on I²C 0x62: AT+ID? / NAME? / INVOKE answer as JSON with the boxes or classes you set (Seeed_Arduino_SSCMA — needs a 32-bit board such as the Pico)."

export const PARTS: Record<string, PartPatch> = {
  "sb-huskylens-ai-vision-sensor": {
    model: { m: "proto", kind: "huskylens", ctls: HUSKY_CTLS },
    look: { k: "screen", color: "#151515", label: "HuskyLens", sw: 80, sh: 60, w: 100 },
    hint: "HuskyLens frame protocol (0x55 0xAA 0x11) over I²C 0x32 or UART 9600 (HUSKYLENS library): blocks or line-tracking arrows with the IDs and positions you set; learn/forget, algorithm and custom names are answered.",
  },
  "sb-grove-vision-ai-module-v2": { model: { m: "proto", kind: "sscma", ctls: SSCMA_CTLS }, look: { k: "screen", color: "#2f6db5", label: "Vision AI V2", sw: 60, sh: 60 }, hint: SSCMA_HINT },
  "sb-grove-vision-ai-v2-kit-ov5647-camera": { model: { m: "proto", kind: "sscma", ctls: SSCMA_CTLS }, look: { k: "screen", color: "#2f6db5", label: "Vision AI V2 kit", sw: 60, sh: 60 }, hint: SSCMA_HINT },
  "sb-grove-speech-recognizer": {
    model: { m: "proto", kind: "speech-recognizer", ctls: [c("cmd", "Say command (1 light on … 22 go)", 1, 22, 1, "", 1)] },
    hint: "Speech recognizer: pick a command (or click the part) to say it — its number (1–22, Seeed's list) arrives as one byte on TX at 9600 baud.",
  },
  "sb-grove-offline-voice-recognition-module": {
    model: { m: "proto", kind: "offline-voice", ctls: [c("cmd", "Say (0 wake 'hello pudding', 0x27 light on …)", 0, 44, 1, "", 0)] },
    hint: "VC-02 offline voice module: pick a phrase (or click the part) to say it — a 5-byte frame with its code in byte 1 arrives on TX at 115200 baud (Seeed-GroveOfflineVoiceRecognition).",
  },
  "sb-gravity-df2301q-voice-recognition": {
    model: { m: "proto", kind: "df2301q", ctls: [c("cmd", "Say command ID (2 'hello robot', 5–21 learned, 22–142 fixed)", 1, 208, 1, "", 2)] },
    hint: "DF2301Q on I²C 0x64 (CMDID, play, mute, volume, wake time) or UART 9600 frames (DFRobot_DF2301Q): pick a command ID (or click the part) to say it.",
  },
  "sb-respeaker-lite-xmos-xu316": {
    model: { m: "proto", kind: "respeaker-lite", ctls: [c("vnr", "Voice level (VNR)", 0, 100, 1, "", 0), c("mute", "Mic muted (mute button)", 0, 1, 1, "", 0), c("usr", "USR button pressed", 0, 1, 1, "", 0), c("level", "Sound level on a Raspberry Pi", 0, 100, 1, "%", 60), c("sound", "Sound on a Pi (0 voice, 1 tone, 2 silence)", 0, 2, 1, "", 0)] },
    pins: ["5V", "3V3", "GND", "SDA", "SCL", "USR", "MUTE", "RGB", "RST", "MCLK", "BCLK", "LRCLK", "I2S_DIN", "I2S_DOUT"],
    look: { k: "module", color: "#111", chip: "XU316", icon: "mic", w: 140, h: 100 },
    hint: "ReSpeaker Lite (I²S firmware): XMOS control on I²C 0x42 (VNR, mic mute, speaker enable, version) and the AIC3204 codec at 0x18; USR/MUTE lines and the WS2812 on RGB. I²S audio isn't simulated on the boards; on a Raspberry Pi it is a USB sound card (\"ReSpeaker\") recording the level / sound you set (arecord, PyAudio — the audio add-on installs once, asking first).",
  },
}
