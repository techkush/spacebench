// A shell command on the Linux board (the assistant's diagnostics, pip / apt installs): boot the
// board if it isn't running, run the command as the pi user (sudo needs no password, as on a
// real Pi) and collect its output until it exits.
import { linuxVm, type LinuxBoardId } from "./agent"

export interface ExecResult { code: number | null; output: string }

export async function piExec(board: LinuxBoardId, cmd: string, timeoutS = 120, say?: (text: string) => void): Promise<ExecResult> {
  const vm = linuxVm()
  // a co-simulation may have left it paused; its program goes (one program at a time)
  await vm.ensure(board, () => say?.("Starting the board (Linux)…"))
  const keep = { out: vm.onOutput, exit: vm.onExit }
  let output = ""
  try {
    let stopped = false
    const code = await new Promise<number | null>((ok) => {
      const t = setTimeout(() => { clearInterval(w); ok(null) }, timeoutS * 1000)
      // the VM went away (ended elsewhere): no exit will come
      const w = setInterval(() => { if (!vm.running) { stopped = true; clearTimeout(t); clearInterval(w); ok(null) } }, 500)
      vm.onOutput = (s) => { output += s }
      vm.onExit = (c) => { clearTimeout(t); clearInterval(w); ok(c) }
      void vm.run(cmd)
    })
    if (stopped) return { code: null, output: `${output}\n(the board stopped)` }
    if (code === null) await vm.kill()
    // an install must survive the VM being stopped
    await vm.sync()
    // the terminal's colours and carriage returns don't help a reader
    output = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r\n?/g, "\n")
    return { code, output: code === null ? `${output}\n(still running after ${timeoutS} s — stopped)` : output }
  } finally {
    vm.onOutput = keep.out
    vm.onExit = keep.exit
  }
}
