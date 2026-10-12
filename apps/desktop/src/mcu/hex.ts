// Intel HEX (what arduino-cli / avr-gcc produce) → program bytes.
// Record types: 00 data, 01 end, 02 extended segment address, 04 extended linear address.

export function parseHex(text: string, size: number): Uint8Array {
  const out = new Uint8Array(size)
  let base = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (line[0] !== ":") throw new Error(`Not an Intel HEX line: ${line.slice(0, 20)}`)
    const bytes = new Uint8Array(line.length / 2 - 0.5 | 0)
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(line.substr(1 + i * 2, 2), 16)
    const len = bytes[0], addr = (bytes[1] << 8) | bytes[2], type = bytes[3]
    let sum = 0
    for (let i = 0; i < len + 5; i++) sum = (sum + bytes[i]) & 0xff
    if (sum !== 0) throw new Error(`HEX checksum error at address ${addr.toString(16)}`)
    if (type === 0) {
      const at = base + addr
      if (at + len > size) throw new Error(`The program is larger than the chip's flash (${size} bytes)`)
      out.set(bytes.subarray(4, 4 + len), at)
    } else if (type === 1) break
    else if (type === 2) base = ((bytes[4] << 8) | bytes[5]) << 4
    else if (type === 4) base = ((bytes[4] << 8) | bytes[5]) << 16
  }
  return out
}

/** Highest used byte + 1 (program size, for "Sketch uses N bytes"). */
export function hexSize(text: string): number {
  let base = 0, top = 0
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith(":")) continue
    const len = parseInt(line.substr(1, 2), 16), addr = parseInt(line.substr(3, 4), 16), type = parseInt(line.substr(7, 2), 16)
    if (type === 0) top = Math.max(top, base + addr + len)
    else if (type === 2) base = parseInt(line.substr(9, 4), 16) << 4
    else if (type === 4) base = parseInt(line.substr(9, 4), 16) << 16
  }
  return top
}
