// Tests that boot the Raspberry Pi VM take turns: only one QEMU can hold the disk. Vitest runs test
// files in parallel, so each file holds this lock (a file created exclusively) while it uses the VM.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const LOCK = path.join(os.tmpdir(), "spacebench-pi-vm.lock")

/** Wait for the VM, then hold it until release(). A lock left by a dead process is taken over. */
export async function acquireVm(timeoutS = 600): Promise<void> {
  const end = Date.now() + timeoutS * 1000
  for (;;) {
    try { fs.writeFileSync(LOCK, String(process.pid), { flag: "wx" }); return } catch { /* held */ }
    const pid = Number(fs.readFileSync(LOCK, "utf8").trim() || 0)
    let alive = false
    try { if (pid) { process.kill(pid, 0); alive = true } } catch { /* gone */ }
    if (!alive) { fs.rmSync(LOCK, { force: true }); continue }
    if (Date.now() > end) throw new Error("Another test kept the Raspberry Pi VM too long")
    await new Promise((r) => setTimeout(r, 500))
  }
}

export function releaseVm() {
  try { if (fs.readFileSync(LOCK, "utf8").trim() === String(process.pid)) fs.rmSync(LOCK) } catch { /* not ours */ }
}
