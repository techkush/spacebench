// Buzzers play the tone the sketch makes, through the computer's speakers (Web Audio).
let ctx: AudioContext | null = null
const voices = new Map<string, { osc: OscillatorNode; gain: GainNode }>()

export function setBuzzers(tones: Map<string, number> | null, enabled: boolean) {
  const want = enabled && tones ? tones : new Map<string, number>()
  for (const [id, v] of voices) if (!(want.get(id)! > 0)) { v.gain.gain.setTargetAtTime(0, v.osc.context.currentTime, 0.01) }
  for (const [id, hz] of want) {
    if (!(hz > 20 && hz < 20000)) continue
    ctx ??= new AudioContext()
    if (ctx.state === "suspended") ctx.resume().catch(() => {})
    let v = voices.get(id)
    if (!v) {
      const osc = ctx.createOscillator(), gain = ctx.createGain()
      osc.type = "square"; gain.gain.value = 0
      osc.connect(gain).connect(ctx.destination); osc.start()
      v = { osc, gain }; voices.set(id, v)
    }
    v.osc.frequency.setTargetAtTime(hz, ctx.currentTime, 0.003)
    v.gain.gain.setTargetAtTime(0.06, ctx.currentTime, 0.005)
  }
}

export function stopBuzzers() {
  for (const v of voices.values()) { try { v.osc.stop() } catch { /* stopped */ } v.osc.disconnect() }
  voices.clear()
}
