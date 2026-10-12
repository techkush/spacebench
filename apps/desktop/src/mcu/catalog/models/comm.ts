// Models: communication modules (comm). They talk to *each other*: every part of a kind in the
// simulation shares a medium through ctx.peers(kind) — an RS-232 pair, an RS-485 / CAN bus, the
// air for LoRa radios and Bluetooth, a Wi-Fi access point with a tiny simulated network behind it.
//
// The line side of these modules (RS-485 A/B, CANH/CANL, the RS-232 DB9, the antenna) isn't a
// pin on the Grove connector, so there is no net to solve: the bus is an in-memory medium shared
// by the parts of a kind. Each simulator runs one board (see ../../multiboard.ts), so the medium
// spans the parts of that board's simulation; two boards in one workspace don't share it yet.
import type { CatDevice, SimCtx, UartPort } from "../devices"
import type { ModView } from "../look"
import type { ModelGroup } from "./types"

type Bytes = number[]
const enc = (s: string): Bytes => Array.from(s, (c) => c.charCodeAt(0) & 0xff)
const str = (b: Bytes) => b.map((x) => String.fromCharCode(x)).join("")
const hex = (b: Bytes, sep = "") => b.map((x) => x.toString(16).toUpperCase().padStart(2, "0")).join(sep)
const unhex = (s: string): Bytes => (s.replace(/[^0-9a-f]/gi, "").match(/../g) ?? []).map((x) => parseInt(x, 16))
const sec = (ctx: SimCtx) => ctx.now() / ctx.hz
const powered = (ctx: SimCtx) => ctx.supply("VCC") > 0
const attr = (ctx: SimCtx, k: string, d: string) => (ctx.attrs[k] !== undefined && ctx.attrs[k] !== "" ? ctx.attrs[k] : d)
const yes = (v: string) => /^(1|on|true|yes)$/i.test(v.trim())
const short = (s: string, n = 12) => (s.length > n ? s.slice(0, n - 1) + "…" : s)
/** a stable index among the parts of a kind (diagram order) */
const indexIn = (ctx: SimCtx, kind: string, self: CatDevice) => Math.max(0, ctx.peers(kind).indexOf(self))
const others = <T extends CatDevice>(ctx: SimCtx, kind: string, self: CatDevice) => ctx.peers(kind).filter((d) => d !== self) as T[]

// ── a UART whose baud rate can change (AT+UART, AT+BAUD …), with sends queued in order ──────
interface Serial { send(d: Bytes | string): void; readonly baud: number; setBaud(b: number): void }
function serial(ctx: SimCtx, baud0: number, onByte: (b: number) => void): Serial {
  let baud = baud0, freeAt = 0
  const ports = new Map<number, UartPort>()
  // one decoder per baud rate used; only the current one is heard
  const open = (b: number) => {
    let p = ports.get(b)
    if (!p) { p = ctx.uart({ baud: b, onByte: (x) => { if (b === baud && powered(ctx)) onByte(x) } }); ports.set(b, p) }
    return p
  }
  open(baud)
  return {
    get baud() { return baud },
    setBaud(b: number) { if (b > 0) { baud = b; open(b) } },
    send(d) {
      const bytes = typeof d === "string" ? enc(d) : d
      if (!bytes.length || !powered(ctx)) return
      const now = sec(ctx), p = open(baud)
      // in chunks at the line rate: a hardware UART's receive FIFO (32 bytes on the RP2040) is fed directly
      for (let i = 0; i < bytes.length; i += 16) {
        const chunk = bytes.slice(i, i + 16), start = Math.max(now, freeAt)
        freeAt = start + (chunk.length * 10) / baud
        if (start - now < 1e-7) p.send(chunk)
        else ctx.after(start - now, () => p.send(chunk))
      }
    },
  }
}
const baudOf = (ctx: SimCtx, d: number) => Number(attr(ctx, "baud", String(d))) || d

/** collects a line protocol: complete lines (CR / LF) and, if `gap` is set, a pause ends one too */
function lines(ctx: SimCtx, onLine: (l: string) => void, gap = 0) {
  let buf = "", last = 0
  const flush = () => { const l = buf; buf = ""; if (l.trim()) onLine(l.replace(/[\r\n]+$/, "")) }
  return (b: number) => {
    // a CR waits for its LF (answering while the board still sends would garble a SoftwareSerial)
    if (b === 10) { if (buf) flush(); return }
    if (b === 13) { const t = (last = sec(ctx)); ctx.after(0.003, () => { if (last === t && buf) flush() }); return }
    buf += String.fromCharCode(b)
    if (gap) { const t = (last = sec(ctx)); ctx.after(gap, () => { if (last === t && buf) flush() }) }
  }
}

// ── RS-232 (MAX3232) and RS-485 (MAX485): transparent transceivers on a shared line ─────────
interface Line extends CatDevice { line(b: number): void; driving(): boolean }
function transceiver(kind: "rs232" | "rs485", ctx: SimCtx): CatDevice {
  let txUntil = 0, sent = 0, got = 0
  const self: Line = {
    kind,
    // a byte from the line comes out on TX (RS-485 is half duplex: not while we drive the bus)
    line(b) { if (kind === "rs485" && self.driving()) return; got++; port.send([b]) },
    driving: () => sec(ctx) < txUntil,
    view: (): ModView => ({ text: `${sent}↑ ${got}↓` }),
  }
  const port = serial(ctx, baudOf(ctx, 9600), (b) => {
    sent++
    txUntil = sec(ctx) + 10 / port.baud
    if (kind === "rs232") {
      if (yes(attr(ctx, "loopback", "off"))) { got++; port.send([b]); return }
      others<Line>(ctx, kind, self).slice(0, 1).forEach((o) => o.line(b))
    } else for (const o of others<Line>(ctx, kind, self)) o.line(b)
  })
  return self
}

// ── Grove CAN BUS module (GD32E103, Longan Serial CAN FD protocol) ──────────────────────────
// Frames on the UART: 0xAA, len, cmd, payload[len-1], CRC16 (Modbus, over cmd+payload) LE.
// cmd 1 = a CAN frame (id u32 LE, ext, rtr, fdf, dlc, data), 2 = bus speed (CAN 2.0, FD),
// 3..6 = mask/filter 0..3 (enable, ext, mask, filt), 7 = UART baud. Received frames come back as cmd 1.
function crc16(b: Bytes) { let c = 0xffff; for (const x of b) { c ^= x; for (let i = 0; i < 8; i++) c = c & 1 ? (c >> 1) ^ 0xa001 : c >> 1 } return c }
const u32 = (b: Bytes, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0
const le32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]
interface CanFrame { id: number; ext: number; rtr: number; fdf: number; data: Bytes }
interface CanNode extends CatDevice { speed(): string; rx(f: CanFrame): void }
function canFrameBytes(f: CanFrame): Bytes {
  const body = [0x01, ...le32(f.id), f.ext, f.rtr, f.fdf, f.data.length, ...f.data]
  const c = crc16(body)
  return [0xaa, body.length, ...body, c & 0xff, c >> 8]
}
function canModule(ctx: SimCtx): CatDevice {
  let buf: Bytes = [], speed20 = 500000, speedFd = 4000000, tx = 0, rx = 0
  const filters: ({ ext: number; mask: number; filt: number } | null)[] = [null, null, null, null]
  const accepts = (f: CanFrame) => {
    const on = filters.filter((x): x is NonNullable<typeof x> => !!x)
    return !on.length || on.some((x) => x.ext === f.ext && (f.id & x.mask) === (x.filt & x.mask))
  }
  const self: CanNode = {
    kind: "can",
    speed: () => `${speed20}/${speedFd}`,
    rx(f) { if (!powered(ctx) || !accepts(f)) return; rx++; port.send(canFrameBytes(f)) },
    view: (): ModView => ({ text: `${tx}↑ ${rx}↓` }),
    ui(u) { if (u.v?.node !== undefined && u.v.node > 0) node() },
  }
  // the bus: a frame needs another node to acknowledge it (a lone node keeps retrying, then gives up)
  const put = (f: CanFrame) => {
    const bitTime = 1 / Math.max(10e3, speed20)
    ctx.after((47 + 8 * f.data.length) * bitTime, () => { for (const o of others<CanNode>(ctx, "can", self)) if (o.speed() === self.speed()) o.rx(f) })
  }
  // a virtual ECU on the bus (slider): sends 0x123 with a counter and the slider's value
  let ecu = 0
  const node = () => { ecu = (ecu + 1) & 0xff; self.rx({ id: 0x123, ext: 0, rtr: 0, fdf: 0, data: [ecu, Math.round(ctx.ctl("value")) & 0xff, 0, 0, 0, 0, 0, 0] }) }
  const tick = () => { if (ctx.ctl("node") > 0) node(); ctx.after(Math.max(0.05, ctx.ctl("period") / 1000), tick) }
  ctx.after(0.5, tick)
  const port = serial(ctx, baudOf(ctx, 9600), (b) => {
    buf.push(b)
    while (buf.length && buf[0] !== 0xaa) buf.shift()
    if (buf.length < 2 || buf.length < buf[1] + 4) return
    const n = buf[1], body = buf.slice(2, 2 + n), crc = buf[2 + n] | (buf[3 + n] << 8)
    buf = buf.slice(n + 4)
    if (crc16(body) !== crc) return
    const cmd = body[0]
    if (cmd === 1 && body.length >= 9) {
      const len = Math.min(body[8], body.length - 9)
      tx++
      put({ id: u32(body, 1), ext: body[5], rtr: body[6], fdf: body[7], data: body.slice(9, 9 + len) })
    } else if (cmd === 2 && body.length >= 9) { speed20 = u32(body, 1); speedFd = u32(body, 5) }
    else if (cmd >= 3 && cmd <= 6 && body.length >= 11) filters[cmd - 3] = body[1] ? { ext: body[2], mask: u32(body, 3), filt: u32(body, 7) } : null
    else if (cmd === 7 && body.length >= 5) { const nb = u32(body, 1); ctx.after(0.005, () => port.setBaud(nb)) }
  })
  return self
}

// ── Wi-Fi: an access point and a tiny network behind it ────────────────────────────────────
type Endpoint = { data(b: Bytes): void; close(): void }
interface Ap extends CatDevice { ssid(): string; pass(): string; internet(): boolean; rssi(): number; bssid(): string; net(): string; ch: number }
interface Station extends CatDevice { ip(): string | null; ap(): Ap | null; incoming(port: number, udp: boolean, from: { ip: string; port: number }, back: Endpoint): Endpoint | null }

function accessPoint(ctx: SimCtx): CatDevice {
  const self: Ap = {
    kind: "wifi-ap",
    ch: 6,
    ssid: () => attr(ctx, "ssid", "SpaceBench"),
    pass: () => ctx.attrs.password ?? "spacebench",
    internet: () => yes(attr(ctx, "internet", "on")),
    rssi: () => Math.round(ctx.ctl("rssi")),
    bssid: () => `c8:3a:35:5b:00:${(indexIn(ctx, "wifi-ap", self) + 1).toString(16).padStart(2, "0")}`,
    net: () => `192.168.${indexIn(ctx, "wifi-ap", self) + 1}`,
    view: (): ModView => {
      const n = (ctx.peers("wifi") as Station[]).filter((s) => s.ap() === self).length
      return { text: `${short(self.ssid(), 10)} · ${n}` }
    },
  }
  return self
}

/** a host name's address on the simulated internet */
function dns(host: string): string {
  let h = 2166136261
  for (const c of host.toLowerCase()) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0
  return `93.184.${10 + (h % 200)}.${1 + ((h >>> 8) % 250)}`
}

/** the services every internet host offers: HTTP (any port but 7 / 123), echo (7), NTP (UDP 123) */
function internetHost(ctx: SimCtx, host: string, port: number, udp: boolean, back: Endpoint): Endpoint | null {
  let closed = false
  const later = (s: number, f: () => void) => ctx.after(s, () => { if (!closed) f() })
  if (port === 7) return { data: (b) => later(0.02, () => back.data(b)), close: () => (closed = true) }
  if (udp) {
    if (port !== 123) return { data: () => {}, close: () => (closed = true) }
    return {
      data: (b) => {
        if (b.length < 48) return
        const t = Math.floor(Date.now() / 1000) + 2208988800
        const r = Array(48).fill(0)
        r[0] = 0x24; r[1] = 1; r[2] = b[2]; r[3] = 0xe9; r.splice(12, 4, ...enc("GPS\0"))
        for (const at of [16, 32, 40]) r.splice(at, 4, (t >>> 24) & 0xff, (t >>> 16) & 0xff, (t >>> 8) & 0xff, t & 0xff)
        r.splice(24, 8, ...b.slice(40, 48))
        later(0.03, () => back.data(r))
      },
      close: () => (closed = true),
    }
  }
  let req = ""
  return {
    data(b) {
      req += str(b)
      const end = req.indexOf("\r\n\r\n")
      if (end < 0) return
      const head = req.slice(0, end)
      req = req.slice(end + 4)
      const first = head.split("\r\n")[0] ?? ""
      const [method = "GET", path = "/"] = first.split(" ")
      const close = /connection:\s*close/i.test(head) || /HTTP\/1\.0/.test(first)
      const html = `<!DOCTYPE html><html><head><title>Space Bench</title></head><body><h1>Hello from ${host}</h1><p>${method} ${path}</p></body></html>\n`
      const res = `HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${html.length}\r\nConnection: ${close ? "close" : "keep-alive"}\r\n\r\n${method === "HEAD" ? "" : html}`
      later(0.05, () => { back.data(enc(res)); if (close) later(0.02, () => { closed = true; back.close() }) })
    },
    close: () => (closed = true),
  }
}

interface Link { udp: boolean; ssl: boolean; rip: string; rport: number; lport: number; server: boolean; ep: Endpoint | null; mode: number }
const WIFI_FLAVOURS = {
  esp8285: {
    gmr: "AT version:1.6.2.0(Apr 13 2018 11:10:59)\r\nSDK version:2.2.1(6ab97e9)\r\ncompile time:Jun  7 2018 19:34:26\r\nBin version(Wroom 02):1.6.2\r\nOK\r\n",
    boot: "\r\n ets Jan  8 2013,rst cause:2, boot mode:(3,6)\r\n\r\nload 0x40100000, len 2592, room 16 \r\n\r\nready\r\n",
    mac: "2c:f4:32:5a:00:",
  },
  wizfi360: {
    gmr: "AT version:1.1.1.7(May  4 2021 15:14:59)\r\nSDK version:2.1.0(WizFi360)\r\ncompile time:May  4 2021 15:14:59\r\nOK\r\n",
    boot: "\r\nWizFi360 Version 1.1.1.7 (WIZnet Co.,Ltd)\r\nready\r\n",
    mac: "00:08:dc:5a:00:",
  },
}

/** ESP-AT firmware (ESP8285 on the Grove UART WiFi V2, and the AT-compatible WizFi360) */
function wifiModule(ctx: SimCtx, flavour: keyof typeof WIFI_FLAVOURS): CatDevice {
  const F = WIFI_FLAVOURS[flavour]
  let echo = true, mux = false, dinfo = false, cwmode = 1, autoconn = true, passive = false
  /** passive receive mode (AT+CIPRECVMODE=1): what each link received, read with AT+CIPRECVDATA */
  const rxq: Bytes[] = [[], [], [], [], []]
  let ap: Ap | null = null, saved: { ssid: string; pwd: string } | null = null
  let server: number | null = null, busy = false, ever = false
  let send: { id: number; len: number; buf: Bytes; ip?: string; port?: number } | null = null
  let links: (Link | null)[] = [null, null, null, null, null]
  let nextPort = 4097, status = "idle"
  const out = (s: string | Bytes) => port.send(s)
  const later = (s: number, f: () => void) => { busy = true; ctx.after(s, () => { busy = false; f() }) }
  // what arrives from the network (+IPD, CLOSED, CONNECT) waits until a command's answer is out,
  // so it doesn't land in the middle of it (or in the buffer the library empties before a command)
  let held: (() => void)[] = [], lastRx = -1, pumping = false
  const pump = () => {
    pumping = false
    if (!held.length) return
    if (busy || send || sec(ctx) - lastRx < 0.006) { pumping = true; ctx.after(0.006, pump); return }
    for (const h of held.splice(0)) h()
  }
  const note = (f: () => void) => { held.push(f); if (!pumping) pump() }
  const myIdx = () => indexIn(ctx, "wifi", self)
  const ip = () => (ap ? `${ap.net()}.${100 + myIdx()}` : null)
  const mac = () => F.mac + (myIdx() + 1).toString(16).padStart(2, "0")
  const prefix = (id: number) => (mux ? `${id},` : "")
  const inRange = (a: Ap) => a.rssi() > -95

  const ipd = (link: Link, b: Bytes) => {
    note(() => {
      const id = links.indexOf(link)
      if (id < 0) return
      if (passive && mux && !link.udp) { rxq[id].push(...b); out(`+IPD,${id},${rxq[id].length}\r\n`); return }
      out(`\r\n+IPD,${prefix(id)}${b.length}${dinfo ? `,${link.rip},${link.rport}` : ""}:`)
      out(b)
    })
  }
  const endpointFor = (link: Link): Endpoint => ({
    data: (b) => ipd(link, b),
    close: () => note(() => { const id = links.indexOf(link); if (id < 0) return; links[id] = null; out(`${prefix(id)}CLOSED\r\n`) }),
  })
  const dropAll = () => { links.forEach((l, id) => { if (l) { l.ep?.close(); out(`${prefix(id)}CLOSED\r\n`) } }); links = [null, null, null, null, null] }
  const leave = (say = true) => { if (!ap) return; dropAll(); ap = null; status = "idle"; if (say) out("WIFI DISCONNECT\r\n") }
  const join = (ssid: string, pwd: string, done: (ok: boolean, code: number) => void) => {
    const cand = (ctx.peers("wifi-ap") as Ap[]).filter((a) => a.ssid() === ssid && inRange(a))
    if (!cand.length) { ctx.after(2, () => done(false, 3)); return }
    const a = cand[0]
    if (a.pass() && a.pass() !== pwd) { ctx.after(2, () => done(false, 2)); return }
    ctx.after(1, () => {
      if (ap) leave()
      ap = a; status = a.ssid(); out("WIFI CONNECTED\r\n")
      ctx.after(0.5, () => { if (ap === a) { out("WIFI GOT IP\r\n"); done(true, 0) } })
    })
  }

  const self: Station = {
    kind: "wifi",
    ip,
    ap: () => ap,
    incoming(lport, udp, from, back) {
      if (!ap || !powered(ctx)) return null
      if (udp) {
        const l = links.find((x) => x?.udp && x.lport === lport)
        if (!l) return null
        if (l.mode !== 0) { l.rip = from.ip; l.rport = from.port; l.ep = back }
        return endpointFor(l)
      }
      if (server !== lport || !mux) return null
      const id = links.indexOf(null)
      if (id < 0) return null
      const l: Link = { udp: false, ssl: false, rip: from.ip, rport: from.port, lport, server: true, ep: back, mode: 0 }
      links[id] = l; rxq[id] = []; ever = true
      note(() => out(`${id},CONNECT\r\n`))
      return endpointFor(l)
    },
    view: (): ModView => ({ text: ap ? short(ap.ssid(), 10) : status === "idle" ? "AT" : status }),
  }

  const open = (id: number, type: string, host: string, rport: number, lport: number, mode: number) => {
    if (!ap) { out("no ip\r\n\r\nERROR\r\n"); return }
    if (links[id]) { out("ALREADY CONNECTED\r\n\r\nERROR\r\n"); return }
    const udp = type === "UDP", ssl = type === "SSL"
    const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(host)
    if (!isIp && !ap.internet()) { later(1, () => out("DNS Fail\r\n\r\nERROR\r\n")); return }
    const rip = isIp ? host : dns(host)
    const me = ip()!
    const l: Link = { udp, ssl, rip, rport, lport: udp && lport ? lport : nextPort++, server: false, ep: null, mode }
    const local = rip.startsWith(ap.net() + ".")
    if (local) {
      const st = (ctx.peers("wifi") as Station[]).find((s) => s !== self && s.ap() === ap && s.ip() === rip)
      l.ep = st?.incoming(rport, udp, { ip: me, port: l.lport }, endpointFor(l)) ?? null
      if (!l.ep && !udp) { later(0.2, () => out("ERROR\r\nCLOSED\r\n")); return }
    } else {
      if (!ap.internet()) { later(1, () => out("ERROR\r\nCLOSED\r\n")); return }
      l.ep = internetHost(ctx, isIp ? rip : host, rport, udp, endpointFor(l))
    }
    links[id] = l; rxq[id] = []; ever = true
    later(ssl ? 0.4 : 0.1, () => out(`${prefix(id)}CONNECT\r\n\r\nOK\r\n`))
  }

  const args = (s: string) => {
    const r: string[] = []
    const re = /\s*("((?:[^"\\]|\\.)*)"|[^,]*)\s*(,|$)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(s)) && m[0] !== "") { r.push(m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : m[1]); if (!m[3]) break }
    return r
  }
  const OK = "\r\nOK\r\n", ERR = "\r\nERROR\r\n"

  const command = (line: string) => {
    if (echo) out(line + "\r\n")
    if (busy) { out("busy p...\r\n"); return }
    const u = line.trim()
    if (/^AT$/i.test(u)) return out(OK)
    if (/^ATE[01]$/i.test(u)) { echo = u.endsWith("1"); return out(OK) }
    const m = /^AT\+([A-Z0-9_]+?)(?:_CUR|_DEF)?(\?|=(.*))?$/i.exec(u)
    if (!m) return out(ERR)
    const name = m[1].toUpperCase(), q = m[2] === "?", a = m[3] !== undefined ? args(m[3]) : null
    switch (name) {
      case "RST": out(OK); leave(false); later(0.3, () => { echo = true; mux = false; dinfo = false; passive = false; server = null; out(F.boot); if (saved && autoconn) join(saved.ssid, saved.pwd, () => {}) }); return
      case "GMR": return out(F.gmr)
      case "RESTORE": out(OK); leave(false); saved = null; later(0.3, () => { echo = true; mux = false; out(F.boot) }); return
      case "UART": case "CIOBAUD": {
        if (q) return out(`+${name}:${port.baud}${name === "UART" ? ",8,1,0,0" : ""}\r\n${OK}`)
        const b = Number(a?.[0]); if (!(b >= 1200)) return out(ERR)
        out(OK); ctx.after(0.01 + 30 / port.baud, () => port.setBaud(b)); return
      }
      case "CWMODE": if (q) return out(`+CWMODE:${cwmode}\r\n${OK}`); cwmode = Number(a?.[0]) || 1; return out(OK)
      case "CWAUTOCONN": if (!q) autoconn = a?.[0] !== "0"; return out(q ? `+CWAUTOCONN:${autoconn ? 1 : 0}\r\n${OK}` : OK)
      case "CWDHCP": case "CIPMODE": case "CIPSSLSIZE": case "SLEEP": case "CWHOSTNAME": case "CIPSTO": case "CWCOUNTRY": case "SYSSTORE": case "CIPSNTPCFG": case "CWLAPOPT": case "CIPDNS": case "CIPCLOSEMODE": case "CIPSERVERMAXCONN":
        return out(OK)
      case "CIPRECVMODE": if (!q) passive = a?.[0] === "1"; return out(q ? `+CIPRECVMODE:${passive ? 1 : 0}\r\n${OK}` : OK)
      case "CIPRECVLEN": return out(`+CIPRECVLEN:${rxq.map((r) => r.length).join(",")}\r\n${OK}`)
      case "CIPRECVDATA": {
        const id = mux ? Number(a?.[0]) : 0, n = Number(mux ? a?.[1] : a?.[0])
        if (!(id >= 0 && id < 5) || !(n > 0) || !rxq[id].length) return out(ERR)
        const d = rxq[id].splice(0, n)
        out(`+CIPRECVDATA,${d.length}:`); out(d); return out(OK)
      }
      case "CIPDINFO": if (!q) dinfo = a?.[0] === "1"; return out(q ? `+CIPDINFO:${dinfo ? "TRUE" : "FALSE"}\r\n${OK}` : OK)
      case "CIPMUX":
        if (q) return out(`+CIPMUX:${mux ? 1 : 0}\r\n${OK}`)
        if (links.some(Boolean)) return out(`link is builded\r\n${ERR}`)
        mux = a?.[0] === "1"; return out(OK)
      case "CWLAP": {
        later(1.5, () => {
          const aps = (ctx.peers("wifi-ap") as Ap[]).filter(inRange)
          out(aps.map((x) => `+CWLAP:(${x.pass() ? 3 : 0},"${x.ssid()}",${x.rssi()},"${x.bssid()}",${x.ch},-12,0)\r\n`).join("") + OK)
        })
        return
      }
      case "CWJAP": {
        if (q) return out(ap ? `+CWJAP:"${ap.ssid()}","${ap.bssid()}",${ap.ch},${ap.rssi()}\r\n${OK}` : `No AP\r\n${OK}`)
        if (!a || !a[0]) return out(ERR)
        const [ssid, pwd = ""] = a
        if (/_DEF/i.test(u) || !/_CUR/i.test(u)) saved = { ssid, pwd }
        busy = true
        join(ssid, pwd, (ok, code) => { busy = false; out(ok ? OK : `+CWJAP:${code}\r\n\r\nFAIL\r\n`) })
        return
      }
      case "CWQAP": out(OK); leave(); return
      case "CIFSR": return out(`+CIFSR:STAIP,"${ip() ?? "0.0.0.0"}"\r\n+CIFSR:STAMAC,"${mac()}"\r\n${OK}`)
      case "CIPSTA":
        if (!q) return out(OK)
        return out(`+CIPSTA:ip:"${ip() ?? "0.0.0.0"}"\r\n+CIPSTA:gateway:"${ap ? ap.net() + ".1" : "0.0.0.0"}"\r\n+CIPSTA:netmask:"${ap ? "255.255.255.0" : "0.0.0.0"}"\r\n${OK}`)
      case "CIPSTAMAC": return out(q ? `+CIPSTAMAC:"${mac()}"\r\n${OK}` : OK)
      case "CIPSTATUS": {
        const st = !ap ? 5 : links.some(Boolean) ? 3 : ever ? 4 : 2
        const rows = links.map((l, id) => (l ? `+CIPSTATUS:${id},"${l.udp ? "UDP" : l.ssl ? "SSL" : "TCP"}","${l.rip}",${l.rport},${l.lport},${l.server ? 1 : 0}\r\n` : "")).join("")
        return out(`STATUS:${st}\r\n${rows}${OK}`)
      }
      case "CIPDOMAIN": {
        if (!a?.[0]) return out(ERR)
        if (!ap || !ap.internet()) { later(1, () => out(`DNS Fail\r\n${ERR}`)); return }
        later(0.05, () => out(`+CIPDOMAIN:${dns(a[0])}\r\n${OK}`)); return
      }
      case "PING": {
        if (!a?.[0]) return out(ERR)
        const local = ap && (a[0] === ap.net() + ".1" || (ctx.peers("wifi") as Station[]).some((s) => s.ap() === ap && s.ip() === a[0]))
        if (!ap || (!local && !ap.internet())) { later(1, () => out(`+timeout\r\n${ERR}`)); return }
        later(0.03, () => out(`+${local ? 4 : 28}\r\n${OK}`)); return
      }
      case "CIPSTART": {
        if (!a) return out(ERR)
        const id = mux ? Number(a.shift()) : 0
        if (!(id >= 0 && id < 5)) return out(ERR)
        const [type = "TCP", host = "", rp = "0", lp = "0", md = "0"] = a
        if (!host || !Number(rp)) return out(ERR)
        open(id, type.toUpperCase(), host, Number(rp), Number(lp), Number(md)); return
      }
      case "CIPSEND": case "CIPSENDEX": {
        if (!a) return out(ERR)
        const id = mux ? Number(a[0]) : 0, len = Number(mux ? a[1] : a[0])
        const l = links[id]
        if (!l) return out(`link is not valid\r\n${ERR}`)
        if (!(len > 0 && len <= 2048)) return out(ERR)
        const extra = a.slice(mux ? 2 : 1)
        send = { id, len, buf: [], ip: extra[0], port: extra[1] ? Number(extra[1]) : undefined }
        return out(`${OK}> `)
      }
      case "CIPCLOSE": {
        const id = mux ? (a ? Number(a[0]) : 0) : 0
        if (mux && id === 5) { dropAll(); return out(OK) }
        const l = links[id]
        if (!l) return out(`UNLINK\r\n${ERR}`)
        links[id] = null; l.ep?.close()
        return out(`${prefix(id)}CLOSED\r\n${OK}`)
      }
      case "CIPSERVER": {
        if (q) return out(`+CIPSERVER:${server === null ? 0 : `1,${server}`}\r\n${OK}`)
        if (!mux) return out(ERR)
        server = a?.[0] === "1" ? Number(a[1] ?? 333) : null
        return out(OK)
      }
      case "CWSAP": case "CIPAP": return out(q ? ERR : OK) // soft-AP mode isn't simulated
      default: return out(ERR)
    }
  }
  const toLines = lines(ctx, command)
  const port = serial(ctx, baudOf(ctx, 115200), (b) => {
    lastRx = sec(ctx)
    if (send) {
      const s = send
      s.buf.push(b)
      if (s.buf.length < s.len) return
      send = null
      const l = links[s.id]
      out(`\r\nRecv ${s.len} bytes\r\n`)
      later(0.02, () => {
        out("\r\nSEND OK\r\n")
        if (!l) return
        if (l.udp && s.ip && s.port && ap) {
          const local = s.ip.startsWith(ap.net() + ".")
          const st = local ? (ctx.peers("wifi") as Station[]).find((x) => x !== self && x.ip() === s.ip) : null
          const ep = local ? st?.incoming(s.port, true, { ip: ip()!, port: l.lport }, endpointFor(l)) : ap.internet() ? internetHost(ctx, s.ip, s.port, true, endpointFor(l)) : null
          ep?.data(s.buf)
        } else l.ep?.data(s.buf)
      })
      return
    }
    toLines(b)
  })
  return self
}

// ── Bluetooth: HM-11 (BLE) and the Grove Serial Bluetooth (classic SPP) ─────────────────────
/** the other end of a Bluetooth link: another module, or the virtual phone */
interface BtEnd { recv(b: Bytes): void; lost(): void; name: string }
interface BtModule extends CatDevice { addr(): Bytes; btName(): string; connectable(): boolean; accept(from: BtEnd): BtEnd | null }

/** the virtual phone: the "Phone" slider connects it, "Phone sends" sends a line */
function phone(mod: () => BtModule, link: () => BtEnd | null, attach: (e: BtEnd) => void, drop: () => void) {
  let heard = ""
  const end: BtEnd = { name: "Phone", recv: (b) => { heard = (heard + str(b)).slice(-200) }, lost: () => {} }
  return {
    end,
    heard: () => heard.replace(/[\r\n]+/g, " ").trim(),
    ui(v: Record<string, number> | undefined): string | undefined {
      if (!v) return
      if (v.phone !== undefined) {
        if (v.phone > 0 && !link() && mod().connectable()) attach(end)
        else if (v.phone <= 0 && link() === end) drop()
      }
      if (v.say !== undefined && link() === end) return `Hello from phone ${Math.round(v.say)}\r\n`
    },
  }
}

const HM_BAUD = [9600, 19200, 38400, 57600, 115200, 4800, 2400, 1200, 230400]
function hm11(ctx: SimCtx): CatDevice {
  let role = 0, imme = 0, noti = 0, mode = 0, type = 0, baudIdx = Math.max(0, HM_BAUD.indexOf(baudOf(ctx, 9600))), name = attr(ctx, "name", "HMSoft"), pass = "000000"
  let link: BtEnd | null = null, found: BtModule[] = [], last: Bytes | null = null, pendingBaud = -1
  const out = (s: string | Bytes) => port.send(s)
  const addr = () => [0x20, 0xc3, 0x8f, 0xf6, 0x1d, 0xa1 + indexIn(ctx, "ble", self)]
  const endFor = (): BtEnd => ({ name, recv: (b) => out(b), lost: () => { link = null; if (noti || role === 1) out("OK+LOST") } })
  const connect = (m: BtModule | undefined, reply: string) => {
    out(reply)
    ctx.after(0.5, () => {
      const far = m && m.connectable() ? m.accept(endFor()) : null
      if (!far) { out("OK+CONNF"); return }
      link = far; last = m!.addr(); out("OK+CONN")
    })
  }
  const self: BtModule = {
    kind: "ble",
    addr,
    btName: () => name,
    connectable: () => role === 0 && !link && powered(ctx),
    accept(from) { if (!self.connectable()) return null; link = from; if (noti) out("OK+CONN"); return endFor() },
    view: (): ModView => ({ text: link ? short(link === ph.end ? ph.heard() || "Phone" : link.name, 10) : role ? "Central" : "Adv" }),
    ui(u) { const say = ph.ui(u.v); if (say) out(say) },
  }
  const ph = phone(() => self, () => link, (e) => { link = e; if (noti) out("OK+CONN") }, () => { link = null; if (noti) out("OK+LOST") })
  const set = (cmd: string, get: () => string, put: (v: string) => void, re: RegExp) => {
    const v = cmd.slice(cmd.indexOf("+") + 1).replace(/^[A-Z]+/, "")
    if (v === "?") return out(`OK+Get:${get()}`)
    if (!re.test(v)) return out("ERROR")
    put(v); out(`OK+Set:${v}`)
  }
  const command = (c: string) => {
    const C = c.toUpperCase()
    if (C === "AT") return out("OK")
    if (C === "AT+RESET") { out("OK+RESET"); ctx.after(0.5, () => { link?.lost(); link = null; if (pendingBaud >= 0) port.setBaud(HM_BAUD[pendingBaud]); pendingBaud = -1 }); return }
    if (C === "AT+RENEW") { out("OK+RENEW"); role = 0; imme = 0; noti = 0; name = "HMSoft"; return }
    if (C === "AT+NAME?") return out(`OK+NAME:${name}`)
    if (C.startsWith("AT+NAME")) { name = c.slice(7, 19); return out(`OK+Set:${name}`) }
    if (C === "AT+ADDR?") return out(`OK+ADDR:${hex(addr())}`)
    if (C === "AT+VERR?" || C === "AT+VERS?") return out("HMSoft V540")
    if (C.startsWith("AT+ROLE")) return set(C, () => String(role), (v) => (role = Number(v)), /^[01]$/)
    if (C.startsWith("AT+IMME")) return set(C, () => String(imme), (v) => (imme = Number(v)), /^[01]$/)
    if (C.startsWith("AT+NOTI")) return set(C, () => String(noti), (v) => (noti = Number(v)), /^[01]$/)
    if (C.startsWith("AT+MODE")) return set(C, () => String(mode), (v) => (mode = Number(v)), /^[012]$/)
    if (C.startsWith("AT+TYPE")) return set(C, () => String(type), (v) => (type = Number(v)), /^[0-3]$/)
    if (C.startsWith("AT+PASS")) return set(C, () => pass, (v) => (pass = v), /^\d{6}$/)
    if (C.startsWith("AT+BAUD")) return set(C, () => String(pendingBaud >= 0 ? pendingBaud : baudIdx), (v) => { baudIdx = Number(v); pendingBaud = baudIdx }, /^[0-8]$/)
    if (C === "AT+RSSI?") return out(link ? "OK+RSSI:-62" : "OK+Get:0")
    if (C === "AT+START") return out("OK+START")
    if (C === "AT+SLEEP") return out("OK+SLEEP")
    if (C === "AT+DISC?") {
      if (role !== 1) return out("ERROR")
      out("OK+DISCS")
      ctx.after(1, () => {
        found = others<BtModule>(ctx, "ble", self).filter((m) => m.connectable())
        out(found.map((m, i) => `OK+DIS${i}:${hex(m.addr())}`).join("") + "OK+DISCE")
      })
      return
    }
    if (C === "AT+CONNL") return last ? connect(others<BtModule>(ctx, "ble", self).find((m) => hex(m.addr()) === hex(last!)), "OK+CONNL") : out("OK+CONNE")
    if (/^AT\+CONN\d$/.test(C)) return role === 1 ? connect(found[Number(C.slice(7))], "OK+CONNA") : out("OK+CONNE")
    if (/^AT\+CON[0-9A-F]{12}$/.test(C)) return role === 1 ? connect(others<BtModule>(ctx, "ble", self).find((m) => hex(m.addr()) === C.slice(6)), "OK+CONNA") : out("OK+CONNE")
    out("ERROR")
  }
  // no CR/LF: a command ends when the bytes pause; connected, the bytes go to the other end
  let buf: Bytes = [], at = 0
  const port = serial(ctx, HM_BAUD[baudIdx], (b) => {
    buf.push(b)
    const t = (at = sec(ctx))
    ctx.after(link ? 0.01 : 0.02, () => {
      if (at !== t || !buf.length) return
      const chunk = buf; buf = []
      if (link) {
        if (str(chunk) === "AT") { const l = link; link = null; l.lost(); out("OK+LOST"); return }
        link.recv(chunk); return
      }
      for (const c of str(chunk).replace(/[\r\n]/g, "").split(/(?=AT)/)) if (c) command(c)
    })
  })
  return self
}

/** Grove Serial Bluetooth (CSR BC417): the Seeed "+ST…" commands (CR LF), HC-05 style "AT+X=…" (CR LF) and the v3.0 "AT+ROLEM" set */
function spp(ctx: SimCtx): CatDevice {
  let role = 0, name = attr(ctx, "name", "SeeedBTSlave"), pin = "0000", inq = true, dialect: "st" | "hc" | "v3" | null = null
  let link: BtEnd | null = null, auto = false
  const out = (s: string | Bytes) => port.send(s)
  const addr = () => [0x00, 0x13, 0xef, 0x00, 0x05, 0x10 + indexIn(ctx, "spp", self)]
  const stAddr = (a: Bytes) => a.map((x) => x.toString(16).padStart(2, "0")).join(",")
  const hcAddr = (a: Bytes) => `${hex(a.slice(0, 2))}:${hex(a.slice(2, 3))}:${hex(a.slice(3))}`.toLowerCase()
  const notify = (on: boolean) => { if (dialect === "st") out(on ? "\r\n+RTSTA:4\r\nCONNECT:OK\r\n" : "\r\n+RTSTA:1\r\n") }
  const endFor = (): BtEnd => ({ name, recv: (b) => out(b), lost: () => { link = null; notify(false) } })
  const self: BtModule = {
    kind: "spp",
    addr,
    btName: () => name,
    connectable: () => role === 0 && inq && !link && powered(ctx),
    accept(from) { if (!self.connectable()) return null; link = from; notify(true); return endFor() },
    view: (): ModView => ({ text: link ? short(link === ph.end ? ph.heard() || "Phone" : link.name, 10) : role ? "Master" : "Slave" }),
    ui(u) { const say = ph.ui(u.v); if (say) out(say) },
  }
  const ph = phone(() => self, () => link, (e) => { link = e; notify(true) }, () => { link = null; notify(false) })
  const slaves = () => others<BtModule>(ctx, "spp", self).filter((m) => m.connectable())
  const connectTo = (m: BtModule | undefined, ok: () => void, fail: () => void) => {
    ctx.after(1, () => {
      const far = m && m.connectable() ? m.accept(endFor()) : null
      if (!far) return fail()
      link = far; ok()
    })
  }
  // the v3.0 master connects to a slave by itself (AT+ROLEM, AT+CLEAR …)
  const autoConnect = () => { if (!auto || link || role !== 1) return; const s = slaves()[0]; if (s) connectTo(s, () => out("OK+CONN"), () => {}); else ctx.after(1, autoConnect) }
  const st = (l: string) => {
    dialect = "st"
    const [k, v = ""] = l.slice(1).split("=")
    const K = k.trim().toUpperCase()
    const ok = () => out("\r\nOK\r\n")
    if (K === "STWMOD") { role = v === "1" ? 1 : 0; return ok() }
    if (K === "STBD") { ok(); ctx.after(0.02, () => port.setBaud(Number(v) || port.baud)); return }
    if (K === "STNA") { name = v; return ok() }
    if (K === "STPIN") { pin = v.trim(); return ok() }
    if (["STAUTO", "STOAUT", "DLPIN", "SETCHO", "LOSSRECONN", "RTPIN"].includes(K)) return ok()
    if (K === "RTADDR") return out(`\r\n+RTADDR=${stAddr(addr())}\r\n`)
    if (K === "INQ") {
      if (role === 0) { inq = v === "1"; return ok() }
      ok()
      if (v === "1") { out("\r\n+RTSTA:2\r\n"); ctx.after(1.5, () => out(slaves().map((m) => `\r\n+RTINQ=${stAddr(m.addr())};${m.btName()}\r\n`).join(""))) }
      return
    }
    if (K === "CONN") {
      const want = v.replace(/[^0-9a-f]/gi, "").toLowerCase()
      out("\r\n+RTSTA:3\r\n")
      connectTo(slaves().find((m) => hex(m.addr()).toLowerCase() === want), () => out("\r\n+RTSTA:4\r\nCONNECT:OK\r\n"), () => out("\r\nCONNECT:FAIL\r\n+RTSTA:1\r\n"))
      return
    }
    out("\r\nERROR\r\n")
  }
  const hc = (l: string) => {
    dialect = "hc"
    const m = /^AT\+([A-Z]+)(\?|=(.*))?$/i.exec(l)
    if (!m) return out("ERROR:(0)\r\n")
    const K = m[1].toUpperCase(), q = m[2] === "?", v = m[3] ?? ""
    const ok = (pre = "") => out(`${pre}OK\r\n`)
    switch (K) {
      case "NAME": if (q) return ok(`+NAME:${name}\r\n`); name = v; return ok()
      case "ROLE": if (q) return ok(`+ROLE:${role}\r\n`); role = v === "1" ? 1 : 0; return ok()
      case "ADDR": return ok(`+ADDR:${hcAddr(addr())}\r\n`)
      case "VERSION": return ok("+VERSION:2.0-20100601\r\n")
      case "PSWD": case "PIN": if (q) return ok(`+${K}:${pin}\r\n`); pin = v.replace(/"/g, ""); return ok()
      case "UART": if (q) return ok(`+UART:${port.baud},0,0\r\n`); ok(); ctx.after(0.02, () => port.setBaud(Number(v.split(",")[0]) || port.baud)); return
      case "STATE": return ok(`+STATE:${link ? "CONNECTED" : role ? "INQUIRING" : "PAIRABLE"}\r\n`)
      case "INQ": ctx.after(1.5, () => out(slaves().map((s) => `+INQ:${hcAddr(s.addr())},1F00,7FFF\r\n`).join("") + "OK\r\n")); return
      case "RNAME": { const s = slaves().find((x) => hcAddr(x.addr()).replace(/:/g, ",") === v.toLowerCase().replace(/:/g, ",")); return s ? ok(`+RNAME:${s.btName()}\r\n`) : out("FAIL\r\n") }
      case "LINK": case "PAIR": {
        if (K === "PAIR") return ok()
        const want = v.replace(/[^0-9a-f]/gi, "").toLowerCase()
        connectTo(slaves().find((s) => hex(s.addr()).toLowerCase() === want), () => ok(), () => out("FAIL\r\n"))
        return
      }
      case "DISC": if (link) { const l = link; link = null; l.lost() } return ok("+DISC:SUCCESS\r\n")
      default: return ok() // RESET, ORGL, INIT, CMODE, INQM, BIND, CLASS, IAC …
    }
  }
  const v3 = (l: string) => {
    dialect = "v3"
    const C = l.toUpperCase()
    if (C === "AT") return out("OK")
    if (C === "AT+ROLEM") { role = 1; auto = true; ctx.after(1, autoConnect); return out("OK") }
    if (C === "AT+ROLES") { role = 0; auto = false; return out("OK") }
    if (C === "AT+DEFAULT") { role = 0; name = "HMSoft"; pin = "1234"; return out("OK") }
    if (C.startsWith("AT+NAME") || C.startsWith("AT+NMAE")) { name = l.slice(7, 19); return out("OK") }
    if (C.startsWith("AT+PIN")) { pin = l.slice(6); return out("OK") }
    if (C === "AT+ADDR" || C === "AT+ADDR?") return out(`+ADDR:${hex(addr())}`)
    if (C === "AT+RADD" || C === "AT+RADD?") return out("+RADD:000000000000")
    if (/^AT\+BAUD[4-9A]$/.test(C)) { const b = [9600, 19200, 38400, 57600, 115200, 230400, 460800][parseInt(C.slice(-1), 16) - 4]; out("OK"); ctx.after(0.02, () => port.setBaud(b)); return }
    if (C === "AT+CLEAR") { ctx.after(1, autoConnect); return out("OK") }
    out("OK") // AT+AUTH1, AT+VERSION …
  }
  const command = (l: string) => {
    const t = l.trim()
    if (!t) return
    if (t.startsWith("+")) return st(t)
    if (/^AT\+[A-Z]+(=|\?)/i.test(t) || (/^AT\+(INQ|RESET|ORGL|INIT|DISC|STATE)$/i.test(t))) return hc(t)
    if (/^AT/i.test(t)) return v3(t)
  }
  let buf = "", at = 0, raw: Bytes = []
  const port = serial(ctx, baudOf(ctx, 9600), (b) => {
    const t = (at = sec(ctx))
    if (link) { // transparent: pass the bytes on in short bursts
      raw.push(b)
      ctx.after(0.005, () => { if (at === t && raw.length && link) { const c = raw; raw = []; link.recv(c) } })
      return
    }
    if (b === 10 || b === 13) { const l = buf; buf = ""; command(l); return }
    buf += String.fromCharCode(b)
    ctx.after(0.03, () => { if (at === t && buf) { const l = buf; buf = ""; for (const c of l.split(/(?=AT)/)) command(c) } })
  })
  return self
}

// ── LoRa: the air between radios ────────────────────────────────────────────────────────────
interface Air { freq: number; sf: number; bw: number; iq: boolean; sync: number; power: number; data: Bytes; dist: number }
interface Radio extends CatDevice { band: [number, number]; hear(p: Air, rssi: number, snr: number): void; dist(): number }
const DEMOD = [0, 0, 0, 0, 0, 0, -5, -7.5, -10, -12.5, -15, -17.5, -20]
function airtime(sf: number, bw: number, len: number, cr = 1, preamble = 8, crc = true, explicit = true) {
  const ts = 2 ** sf / bw, ldro = ts > 0.016 ? 1 : 0
  const n = 8 + Math.max(Math.ceil((8 * len - 4 * sf + 28 + 16 * (crc ? 1 : 0) - 20 * (explicit ? 0 : 1)) / (4 * (sf - 2 * ldro))) * (cr + 4), 0)
  return (preamble + 4.25) * ts + n * ts
}
/** RSSI after a log-distance path loss (exponent 2.7, free space to 1 m) */
const linkRssi = (power: number, freqHz: number, m: number) => power - (20 * Math.log10(freqHz / 1e6) - 27.55 + 27 * Math.log10(Math.max(1, m)))
function radiate(ctx: SimCtx, self: Radio, p: Air) {
  for (const r of others<Radio>(ctx, "lora", self)) {
    const mhz = p.freq / 1e6
    if (mhz < r.band[0] || mhz > r.band[1]) continue
    const m = Math.max(p.dist, r.dist())
    const rssi = linkRssi(p.power, p.freq, m), snr = Math.min(12, rssi - (-174 + 10 * Math.log10(p.bw) + 6))
    if (snr < DEMOD[p.sf]) continue
    r.hear(p, Math.round(rssi), Math.round(snr * 4) / 4)
  }
}
const BWS = [7800, 10400, 15600, 20800, 31250, 41700, 62500, 125000, 250000, 500000]

/** Grove LoRa Radio: an ATmega168 bridge ('W' reg len data / 'R' reg len → bytes, 'I' on DIO0) to an RFM9x (SX127x registers) */
function rfm(ctx: SimCtx, band: [number, number], def: number): CatDevice {
  const regs = new Uint8Array(128), fifo = new Uint8Array(256)
  const reset = () => {
    regs.fill(0); fifo.fill(0)
    const f = Math.round((def * 1e6) / 61.03515625)
    Object.assign(regs, { 1: 0x09, 6: (f >> 16) & 0xff, 7: (f >> 8) & 0xff, 8: f & 0xff, 9: 0x4f, 0x0a: 0x09, 0x0b: 0x2b, 0x0c: 0x20, 0x0e: 0x80, 0x1d: 0x72, 0x1e: 0x70, 0x1f: 0x64, 0x21: 0x08, 0x22: 0x01, 0x23: 0xff, 0x26: 0x04, 0x31: 0xc3, 0x33: 0x27, 0x39: 0x12, 0x42: 0x12, 0x4d: 0x84 })
  }
  reset()
  let txs = 0, rxs = 0, txUntil = 0
  const freq = () => ((regs[6] << 16) | (regs[7] << 8) | regs[8]) * 61.03515625
  const sf = () => Math.min(12, Math.max(6, regs[0x1e] >> 4))
  const bw = () => BWS[regs[0x1d] >> 4] ?? 125000
  const opMode = () => regs[1] & 7
  const power = () => {
    const pa = regs[9]
    if (pa & 0x80) return 2 + (pa & 0x0f) + ((regs[0x4d] & 7) === 7 ? 3 : 0)
    return 10.8 + 0.6 * ((pa >> 4) & 7) - (15 - (pa & 0x0f))
  }
  const irq = (flag: number, dio0: number) => {
    regs[0x12] |= flag
    if (regs[0x40] >> 6 === dio0) port.send([0x49]) // 'I'
  }
  const self: Radio = {
    kind: "lora",
    band,
    dist: () => ctx.ctl("distance"),
    hear(p, rssi, snr) {
      if (!powered(ctx) || !(regs[1] & 0x80) || (opMode() !== 5 && opMode() !== 6) || sec(ctx) < txUntil) return
      if (Math.abs(p.freq - freq()) > p.bw / 2 || p.sf !== sf() || p.bw !== bw() || p.iq !== !!(regs[0x33] & 0x40) || p.sync !== regs[0x39]) return
      const base = regs[0x0f]
      p.data.forEach((b, i) => (fifo[(base + i) & 0xff] = b))
      regs[0x10] = base; regs[0x13] = p.data.length
      regs[0x19] = (Math.round(snr * 4) + 256) & 0xff
      regs[0x1a] = Math.max(0, Math.min(255, rssi + 137))
      rxs++
      if (opMode() === 6) regs[1] = (regs[1] & 0xf8) | 1
      irq(0x50, 0) // RxDone + ValidHeader
    },
    view: (): ModView => ({ text: `${(freq() / 1e6).toFixed(1)} ${opMode() === 3 ? "TX" : opMode() >= 5 ? "RX" : txs + rxs ? `${txs}↑${rxs}↓` : ""}`.trim() }),
  }
  const write = (reg: number, v: number) => {
    if (reg === 0) { fifo[regs[0x0d]] = v; regs[0x0d] = (regs[0x0d] + 1) & 0xff; return }
    if (reg === 0x12) { regs[0x12] &= ~v; return }
    if (reg === 0x42) return
    // LongRangeMode (bit 7) is taken only with a write that selects sleep mode (RadioHead writes STDBY / RX / TX without it)
    if (reg === 1 && (v & 7) !== 0) v = (v & 0x7f) | (regs[1] & 0x80)
    regs[reg] = v
    if (reg === 1 && (v & 7) === 3) {
      const len = regs[0x22], start = regs[0x0e]
      const data = Array.from({ length: len }, (_, i) => fifo[(start + i) & 0xff])
      const p: Air = { freq: freq(), sf: sf(), bw: bw(), iq: !!(regs[0x33] & 0x40), sync: regs[0x39], power: power(), data, dist: self.dist() }
      const t = airtime(p.sf, p.bw, len, (regs[0x1d] >> 1) & 7, (regs[0x20] << 8) | regs[0x21], !!(regs[0x1e] & 4), !(regs[0x1d] & 1))
      txUntil = sec(ctx) + t
      const mhz = p.freq / 1e6
      ctx.after(t, () => {
        if (opMode() !== 3) return
        txs++
        if (mhz >= band[0] && mhz <= band[1]) radiate(ctx, self, p)
        regs[1] = (regs[1] & 0xf8) | 1
        irq(0x08, 1) // TxDone
      })
    }
  }
  const read = (reg: number) => {
    if (reg === 0) { const v = fifo[regs[0x0d]]; regs[0x0d] = (regs[0x0d] + 1) & 0xff; return v }
    if (reg === 0x1b) return Math.max(0, Math.min(255, Math.round(-115 + 137)))
    return regs[reg]
  }
  let cmd = 0, reg = 0, len = 0, n = 0
  const port = serial(ctx, 57600, (b) => {
    if (n === 0) { if (b === 0x57 || b === 0x52) { cmd = b; n = 1 } return }
    if (n === 1) { reg = b & 0x7f; n = 2; return }
    if (n === 2) {
      len = b; n = 3
      if (cmd === 0x52) {
        const r: number[] = []
        for (let i = 0; i < len; i++) r.push(read(reg === 0 ? 0 : (reg + i) & 0x7f))
        port.send(r); n = 0
      } else if (len === 0) n = 0
      return
    }
    write(reg, b)
    if (reg !== 0) reg = (reg + 1) & 0x7f
    if (++n >= len + 3) n = 0
  })
  return self
}

/** Seeed Wio-E5 (STM32WLE5JC) with the LoRaWAN AT firmware: LoRaWAN through a virtual gateway, and TEST mode (raw LoRa) */
const E5_DR = [[12, 125000], [11, 125000], [10, 125000], [9, 125000], [8, 125000], [7, 125000], [7, 250000]] as const
function wioE5(ctx: SimCtx): CatDevice {
  const idx = () => indexIn(ctx, "lora", self)
  let mode = "LWOTAA", dr = 0, band = "EU868", cls = "A", port8 = 8, adr = "ON", joined = false, joining = false, sleeping = false, rx = false, ups = 0, downs = 0
  let devEui = () => `2C:F7:F1:20:42:00:3F:${(0x6a + idx()).toString(16).toUpperCase().padStart(2, "0")}`
  let appEui = "80:00:00:00:00:00:00:06", devAddr = "", appKey = "2B7E151628AED2A6ABF7158809CF4F3C"
  let rf = { freq: 868e6, sf: 12, bw: 125000, txpr: 12, rxpr: 15, pow: 14, crc: true, iq: false, net: false }
  const out = (s: string) => port.send(s + "\r\n")
  const gwRssi = () => linkRssi(14, 868.1e6, ctx.ctl("distance"))
  const gwOk = () => ctx.ctl("gateway") > 0 && gwRssi() + 117 >= DEMOD[E5_DR[dr][0]]
  const self: Radio = {
    kind: "lora",
    band: [862, 1020],
    dist: () => ctx.ctl("distance"),
    hear(p, rssi, snr) {
      if (!powered(ctx) || mode !== "TEST" || !rx) return
      if (Math.abs(p.freq - rf.freq) > p.bw / 2 || p.sf !== rf.sf || p.bw !== rf.bw || p.iq !== rf.iq || p.sync !== (rf.net ? 0x34 : 0x12)) return
      downs++
      out(`+TEST: LEN:${p.data.length}, RSSI:${rssi}, SNR:${Math.round(snr)}`)
      out(`+TEST: RX "${hex(p.data)}"`)
    },
    view: (): ModView => ({ text: mode === "TEST" ? (rx ? "RX" : "TEST") : joined ? `Joined ${ups}↑` : joining ? "Joining" : "LoRaWAN" }),
  }
  const rfcfg = () => `+TEST: RFCFG F:${Math.round(rf.freq)}, SF${rf.sf}, BW${rf.bw / 1000}K, TXPR:${rf.txpr}, RXPR:${rf.rxpr}, POW:${rf.pow}dBm, CRC:${rf.crc ? "ON" : "OFF"}, IQ:${rf.iq ? "ON" : "OFF"}, NET:${rf.net ? "ON" : "OFF"}`
  const uplink = (name: string, payload: Bytes, confirmed: boolean) => {
    const C = name
    if (mode === "TEST") return out(`+${C}: ERROR(-12)`)
    if (mode === "LWOTAA" && !joined) return out(`+${C}: Please join network first`)
    if (joining) return out(`+${C}: ERROR(-14)`)
    out(`+${C}: Start`)
    if (confirmed) out(`+${C}: Wait ACK`)
    const [sf, bw] = E5_DR[dr]
    joining = true // busy
    ctx.after(airtime(sf, bw, payload.length + 13) + 1, () => {
      joining = false
      ups++
      const ok = gwOk(), down = attr(ctx, "downlink", "")
      if (ok && confirmed) out(`+${C}: ACK Received`)
      if (ok && (confirmed || down)) {
        if (down) out(`+${C}: PORT: ${port8}; RX: "${hex(unhex(down))}"`)
        out(`+${C}: RXWIN1, RSSI ${Math.round(gwRssi())}, SNR ${Math.max(-20, Math.min(10, Math.round(gwRssi() + 117)))}.0`)
      }
      out(`+${C}: Done`)
    })
  }
  const command = (line: string) => {
    if (sleeping) { sleeping = false; out("+LOWPOWER: WAKEUP"); return }
    const m = /^AT(?:\+([A-Z0-9]+))?(?:(\?)|=(.*))?$/i.exec(line.trim())
    if (!m) return out("+AT: ERROR(-1)")
    const K = (m[1] ?? "AT").toUpperCase(), v = m[3]?.trim(), q = m[2] === "?" || v === undefined
    const val = (s = "") => s.replace(/^"|"$/g, "")
    switch (K) {
      case "AT": return out("+AT: OK")
      case "VER": return out("+VER: 4.0.11")
      case "RESET": joined = false; rx = false; return out("+RESET: OK")
      case "FDEFAULT": joined = false; mode = "LWOTAA"; dr = 0; return out("+FDEFAULT: OK")
      case "LOWPOWER": sleeping = true; return out("+LOWPOWER: SLEEP")
      case "ID": {
        const ids: Record<string, () => string> = { DEVADDR: () => devAddr || `42:00:3F:${devEui().slice(-2)}`, DEVEUI: devEui, APPEUI: () => appEui }
        const names: Record<string, string> = { DEVADDR: "DevAddr", DEVEUI: "DevEui", APPEUI: "AppEui" }
        if (!v) return Object.keys(ids).forEach((k) => out(`+ID: ${names[k]}, ${ids[k]()}`))
        const [k, x] = v.split(",").map((s) => s.trim())
        const key = k.toUpperCase()
        if (!ids[key]) return out("+ID: ERROR(-1)")
        if (x) { const h = hex(unhex(val(x)), ":"); if (key === "DEVEUI") devEui = () => h; else if (key === "APPEUI") appEui = h; else devAddr = h }
        return out(`+ID: ${names[key]}, ${ids[key]()}`)
      }
      case "KEY": { const [k, x = ""] = (v ?? "").split(","); if (k.trim().toUpperCase() === "APPKEY") appKey = val(x.trim()); return out(`+KEY: ${k.trim().toUpperCase()} ${val(x.trim()).toUpperCase() || appKey}`) }
      case "MODE": {
        if (!q) { const x = (v ?? "").toUpperCase(); if (!["LWOTAA", "LWABP", "TEST"].includes(x)) return out("+MODE: ERROR(-1)"); mode = x; rx = false; if (x !== "LWOTAA") joined = false }
        return out(`+MODE: ${mode}`)
      }
      case "DR": {
        if (v && /^[A-Z]{2}\d{3}/i.test(v)) { band = v.toUpperCase(); return out(`+DR: ${band}`) }
        if (v) { const n = Number(v.replace(/^DR/i, "")); if (!(n >= 0 && n < E5_DR.length)) return out("+DR: ERROR(-1)"); dr = n }
        out(`+DR: DR${dr}`)
        return out(`+DR: ${band} DR${dr}  SF${E5_DR[dr][0]} BW${E5_DR[dr][1] / 1000}K `)
      }
      case "CH": return out("+CH: 3; 0,868100000,DR0,DR5; 1,868300000,DR0,DR5; 2,868500000,DR0,DR5")
      case "CLASS": if (!q) cls = (v ?? "A").toUpperCase(); return out(`+CLASS: ${cls}`)
      case "PORT": if (!q) port8 = Number(v) || port8; return out(`+PORT: ${port8}`)
      case "ADR": if (!q) adr = (v ?? "").toUpperCase(); return out(`+ADR: ${adr}`)
      case "DELAY": case "RETRY": case "REPT": case "POWER": case "LW": return out(`+${K}: ${v ?? ""}`.trimEnd())
      case "UART": { const n = Number((v ?? "").split(",")[1]); if (n > 0) { out(`+UART: BR, ${n}`); ctx.after(0.05, () => port.setBaud(n)) } else out(`+UART: BR, ${port.baud}`); return }
      case "JOIN": {
        if (mode !== "LWOTAA") return out("+JOIN: ERROR(-1)")
        if (joined && !/FORCE/i.test(v ?? "")) return out("+JOIN: Joined already")
        if (joining) return out("+JOIN: LoRaWAN modem is busy")
        joining = true; joined = false
        out("+JOIN: Start"); out("+JOIN: NORMAL")
        const ok = gwOk()
        ctx.after(ok ? 5 : 8, () => {
          joining = false
          if (!ok || !gwOk()) { out("+JOIN: Join failed"); out("+JOIN: Done"); return }
          joined = true
          devAddr = devAddr || `26:0B:${(0x5f + idx()).toString(16).toUpperCase()}:66`
          out("+JOIN: Network joined"); out(`+JOIN: NetID 000013 DevAddr ${devAddr}`); out("+JOIN: Done")
        })
        return
      }
      case "MSG": case "CMSG": return uplink(K, enc(val(v)), K === "CMSG")
      case "MSGHEX": case "CMSGHEX": return uplink(K, unhex(val(v)), K === "CMSGHEX")
      case "TEST": {
        if (mode !== "TEST") return out("+TEST: ERROR(-12)")
        const [sub = "", ...rest] = (v ?? "").split(",")
        const S = sub.trim().toUpperCase()
        if (S === "STOP") { rx = false; return out("+TEST: STOP") }
        if (S === "RFCFG") {
          if (rest.length) {
            const [f, s, b, tp, rp, pw, crc, iq, net] = rest.map((x) => x.trim())
            const mhz = Number(f)
            rf = { freq: (mhz > 1e5 ? mhz : mhz * 1e6), sf: Number((s ?? "SF12").replace(/SF/i, "")) || 12, bw: (Number(b) || 125) * 1000, txpr: Number(tp) || 12, rxpr: Number(rp) || 15, pow: Number(pw) || 14, crc: !/OFF/i.test(crc ?? "ON"), iq: /ON/i.test(iq ?? "OFF"), net: /ON/i.test(net ?? "OFF") }
          }
          return out(rfcfg())
        }
        if (S === "TXLRPKT" || S === "TXLRSTR") {
          const arg = rest.join(",").trim()
          const data = S === "TXLRPKT" ? unhex(val(arg)) : enc(val(arg))
          rx = false
          out(`+TEST: ${S} "${S === "TXLRPKT" ? hex(data) : val(arg)}"`)
          const p: Air = { freq: rf.freq, sf: rf.sf, bw: rf.bw, iq: rf.iq, sync: rf.net ? 0x34 : 0x12, power: rf.pow, data, dist: self.dist() }
          ctx.after(airtime(rf.sf, rf.bw, data.length, 1, rf.txpr, rf.crc), () => { ups++; radiate(ctx, self, p); out("+TEST: TX DONE") })
          return
        }
        if (S === "RXLRPKT") { rx = true; return out("+TEST: RXLRPKT") }
        return out("+TEST: ERROR(-1)")
      }
      default: return out(`+${K}: ERROR(-1)`)
    }
  }
  const port = serial(ctx, baudOf(ctx, 9600), lines(ctx, command, 0.05))
  return self
}

const group: ModelGroup = {
  proto: {
    "comm-rs232": (_c, ctx) => transceiver("rs232", ctx),
    "comm-rs485": (_c, ctx) => transceiver("rs485", ctx),
    "comm-can": (_c, ctx) => canModule(ctx),
    "comm-esp8285": (_c, ctx) => wifiModule(ctx, "esp8285"),
    "comm-wizfi360": (_c, ctx) => wifiModule(ctx, "wizfi360"),
    "comm-ap": (_c, ctx) => accessPoint(ctx),
    "comm-hm11": (_c, ctx) => hm11(ctx),
    "comm-spp": (_c, ctx) => spp(ctx),
    "comm-wio-e5": (_c, ctx) => wioE5(ctx),
    "comm-lora433": (_c, ctx) => rfm(ctx, [410, 525], 434),
    "comm-lora868": (_c, ctx) => rfm(ctx, [862, 1020], 868),
  },
}
export default group
