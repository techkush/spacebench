// Models: linux-devices — parts that a Raspberry Pi (Linux VM) sees as Linux devices rather than
// through pins: the Camera Module is /dev/video0 in the guest, fed with a test scene. The work
// happens in the guest (linux-guest/spacebench-camera, started by src/linux/media.ts when the
// part is on the Pi's canvas); on the canvas the part only carries its controls (Scene,
// Brightness), which the Pi's chip link forwards to the guest while it runs.
import type { ModelGroup } from "./types"

const group: ModelGroup = {
  proto: {
    // nothing to do on the circuit side: no pins carry the picture (CSI isn't emulated)
    "pi-camera": () => ({ kind: "pi-camera" }),
  },
}
export default group
