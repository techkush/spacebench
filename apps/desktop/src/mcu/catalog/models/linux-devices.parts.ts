// Catalogue entries for the linux-devices parts: their model (and look / pins / hint when they change).
// (The ReSpeaker Lite's entry belongs to ai-voice; on a Pi it is also the "ReSpeaker" sound card —
// src/linux/media.ts reads its `sound` / `level` controls when the part has them.)
import type { PartPatch } from "./types"

export const PARTS: Record<string, PartPatch> = {
  "sb-raspberry-pi-camera-module-csi": {
    model: {
      m: "proto",
      kind: "pi-camera",
      ctls: [
        { key: "scene", label: "Scene (0 bars + clock, 1 red ball, 2 clock)", min: 0, max: 2, step: 1, unit: "", def: 0 },
        { key: "brightness", label: "Brightness", min: 0, max: 100, step: 1, unit: "%", def: 50 },
      ],
    },
    hint:
      "On a Raspberry Pi board: /dev/video0 shows a 640×480 test scene — colour bars with the time, a bouncing red ball, or a big clock (Scene and Brightness sliders); " +
      "OpenCV (cv2.VideoCapture(0)) / V4L2 (v4l2-ctl, fswebcam) capture it; picamera2 / libcamera don't see it. Needs the camera add-on (installed once, asks first).",
  },
}
