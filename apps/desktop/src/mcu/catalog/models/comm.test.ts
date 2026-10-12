// Communication modules with real sketches: each sketch is compiled by arduino-cli and runs on
// the emulated board with the modules wired to it. Modules of a kind talk to each other, so most
// tests put two of them on one board (SoftwareSerial on the Uno: only one port listens at a
// time, so the sender writes while the receiver listens; the Pico's Serial1 / Serial2 when both
// sides must answer). Libraries go into a scratch sketchbook (SB_ARDUINO_USER, see devices.test.ts):
//   "WiFiEsp" "WizFi360" "Grove - LoRa Radio 433MHz 868MHz" and Longan's Serial_CAN_FD_Module (GitHub).
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import type { PartUi } from "../../circuit"
import type { Connection, Diagram } from "../../diagram"
import { McuSim } from "../../sim"
import { catalogPart, simulated } from "../index"

const cli = ["/opt/homebrew/bin/arduino-cli", "/usr/local/bin/arduino-cli"].find((p) => fs.existsSync(p))
const user = process.env.SB_ARDUINO_USER ?? path.join(os.homedir(), ".cache", "spacebench-test-libs")
const env = fs.existsSync(user) ? { ...process.env, ARDUINO_DIRECTORIES_USER: user } : process.env
const libs = cli ? execFileSync(cli, ["lib", "list"], { encoding: "utf8", env }) : ""
const has = (l: string) => libs.includes(l)
const hasPico = !!cli && execFileSync(cli, ["core", "list"], { encoding: "utf8" }).includes("rp2040:rp2040")

function build(code: string, fqbn = "arduino:avr:uno", props: string[] = []): string | Uint8Array {
  const key = `${fqbn.replace(/:/g, "_")}-${props.length}-${code.length}-${[...code].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)}`
  const dir = path.join(os.tmpdir(), `sbcomm-${key}`)
  fs.mkdirSync(path.join(dir, "sketch"), { recursive: true })
  fs.writeFileSync(path.join(dir, "sketch", "sketch.ino"), code)
  execFileSync(cli!, ["compile", "--fqbn", fqbn, ...props.flatMap((x) => ["--build-property", x]), "--build-path", path.join(dir, "build"), "--output-dir", path.join(dir, "out"), path.join(dir, "sketch")], { encoding: "utf8", env, stdio: "pipe" })
  const pico = fqbn.startsWith("rp2040")
  const f = path.join(dir, "out", pico ? "sketch.ino.bin" : "sketch.ino.hex")
  return pico ? new Uint8Array(fs.readFileSync(f)) : fs.readFileSync(f, "utf8")
}

type P = [string, string, Record<string, string>?]
interface Run { sim: McuSim; serial: () => string; step: (ms: number) => void; until: (re: RegExp | string, ms: number) => boolean }
function start(code: string, parts: P[], wires: [string, string][], board: "uno" | "pico" = "uno", ui: Record<string, PartUi> = {}, props: string[] = []): Run {
  const bt = board === "uno" ? "wokwi-arduino-uno" : "wokwi-pi-pico"
  const d: Diagram = { version: 1, author: "", editor: "t", parts: [{ type: bt, id: board, top: 0, left: 0, attrs: {} }, ...parts.map(([type, id, attrs]) => ({ type, id, top: 0, left: 0, attrs: attrs ?? {} }))], connections: wires.map(([a, b]) => [a, b, "", []] as Connection) }
  const sim = new McuSim(d, build(code, board === "uno" ? "arduino:avr:uno" : "rp2040:rp2040:rpipico", props))
  let serial = ""
  sim.onSerial = (s) => (serial += s)
  for (const [id, u] of Object.entries(ui)) sim.setUi(id, u)
  sim.step(1, 1)
  const step = (ms: number) => { for (let t = 0; t < ms; t += 50) sim.step(50, 50) }
  const until = (re: RegExp | string, ms: number) => {
    for (let t = 0; t < ms; t += 50) { if (typeof re === "string" ? serial.includes(re) : re.test(serial)) return true; sim.step(50, 50) }
    return typeof re === "string" ? serial.includes(re) : re.test(serial)
  }
  return { sim, serial: () => serial, step, until }
}
/** a Grove UART module on the Uno: its RX on `tx` (the sketch's TX), its TX on `rx` */
const unoUart = (id: string, rx: string, tx: string): [string, string][] => [[`${id}:GND`, "uno:GND.1"], [`${id}:VCC`, "uno:5V"], [`${id}:RX`, `uno:${tx}`], [`${id}:TX`, `uno:${rx}`]]
/** on the Pico: Serial1 (GP0 TX / GP1 RX) or Serial2 (GP8 TX / GP9 RX) */
const picoUart = (id: string, port: 1 | 2): [string, string][] => [[`${id}:GND`, "pico:GND.1"], [`${id}:VCC`, "pico:3V3"], [`${id}:RX`, port === 1 ? "pico:GP0" : "pico:GP8"], [`${id}:TX`, port === 1 ? "pico:GP1" : "pico:GP9"]]

describe.skipIf(!cli)("communication modules", { timeout: 300_000 }, () => {
  it("RS-232: a pair passes bytes both ways; loopback echoes", () => {
    const code = `#include <SoftwareSerial.h>
SoftwareSerial a(2, 3), b(4, 5);
void setup(){ Serial.begin(115200); a.begin(9600); b.begin(9600);
  b.listen(); a.print("ping"); delay(20); Serial.print("b got "); while (b.available()) Serial.write(b.read()); Serial.println();
  a.listen(); b.print("pong"); delay(20); Serial.print("a got "); while (a.available()) Serial.write(a.read()); Serial.println(); }
void loop(){}`
    const r = start(code, [["sb-grove-rs232", "a"], ["sb-grove-rs232", "b"]], [...unoUart("a", "2", "3"), ...unoUart("b", "4", "5")])
    r.step(400)
    expect(r.serial()).toContain("b got ping")
    expect(r.serial()).toContain("a got pong")
    const lb = start(`#include <SoftwareSerial.h>
SoftwareSerial a(2, 3);
void setup(){ Serial.begin(115200); a.begin(9600); a.print("echo?"); delay(20); Serial.print("got "); while (a.available()) Serial.write(a.read()); Serial.println(); }
void loop(){}`, [["sb-grove-rs232", "a", { loopback: "on" }]], unoUart("a", "2", "3"))
    lb.step(300)
    expect(lb.serial()).toContain("got echo?")
  })

  it("RS-485: one node's bytes reach every other node on the bus (and not itself)", () => {
    const code = `#include <SoftwareSerial.h>
SoftwareSerial a(2, 3), b(4, 5), c(6, 7);
void show(const char* n, SoftwareSerial& s){ Serial.print(n); Serial.print(":"); while (s.available()) Serial.write(s.read()); Serial.println(); }
void setup(){ Serial.begin(115200); a.begin(9600); b.begin(9600); c.begin(9600);
  b.listen(); a.print("hi all"); delay(20); show("b", b);
  c.listen(); a.print("again"); delay(20); show("c", c);
  a.listen(); a.print("self"); delay(20); show("a", a); }
void loop(){}`
    const r = start(code, [["sb-grove-rs485", "a"], ["sb-grove-rs485", "b"], ["sb-grove-rs485", "c"]], [...unoUart("a", "2", "3"), ...unoUart("b", "4", "5"), ...unoUart("c", "6", "7")])
    r.step(500)
    expect(r.serial()).toContain("b:hi all")
    expect(r.serial()).toContain("c:again")
    expect(r.serial()).toMatch(/a:\r?\n/)
  })

  it.skipIf(!has("Serial CAN FD"))("CAN: Serial_CAN_FD frames between two modules, filters, and the virtual node", () => {
    const code = `#include "Serial_CAN_FD.h"
#include <SoftwareSerial.h>
SoftwareSerial a(2, 3), b(4, 5);
SoftwareSerial* cur = &a;
void uart_init(unsigned long baud){ cur->begin(baud); }
void uart_write(unsigned char c){ cur->write(c); }
unsigned char uart_read(){ return cur->read(); }
int uart_available(){ return cur->available(); }
unsigned long id; unsigned char ext, rtr, fdf, len, dta[64];
void recv(){ unsigned long t = millis(); while (millis() - t < 300) if (read_can(&id, &ext, &rtr, &fdf, &len, dta)) {
  Serial.print("id=0x"); Serial.print(id, HEX); Serial.print(" len="); Serial.print(len); Serial.print(" d="); for (int i = 0; i < len; i++) { Serial.print(dta[i]); Serial.print(','); } Serial.println(); return; }
  Serial.println("none"); }
void setup(){ Serial.begin(115200);
  cur = &a; uart_init(9600); can_speed_20(500000);
  cur = &b; uart_init(9600); can_speed_20(500000);
  b.listen();
  unsigned char d[8] = {1,2,3,4,5,6,7,8};
  cur = &a; can_send(0x55, 0, 0, 0, 8, d);
  cur = &b; recv();
  set_mask_filt(0, 0, 0x7ff, 0x100);   // b only takes 0x100
  cur = &a; can_send(0x55, 0, 0, 0, 2, d); cur = &b; recv();
  cur = &a; can_send(0x100, 0, 0, 0, 3, d); cur = &b; recv();
  set_mask_filt(0, 0, 0, 0);
  Serial.println("done"); }
void loop(){ if (read_can(&id, &ext, &rtr, &fdf, &len, dta)) { Serial.print("node 0x"); Serial.print(id, HEX); Serial.print(" "); Serial.println(dta[1]); } }`
    const r = start(code, [["sb-grove-can-bus-module-gd32e103", "a"], ["sb-grove-can-bus-module-gd32e103", "b"]], [...unoUart("a", "2", "3"), ...unoUart("b", "4", "5")])
    expect(r.until("done", 3000)).toBe(true)
    const s = r.serial()
    expect(s).toContain("id=0x55 len=8 d=1,2,3,4,5,6,7,8,")
    expect(s).toContain("none")
    expect(s).toContain("id=0x100 len=3 d=1,2,3,")
    r.sim.setUi("b", { v: { node: 1, value: 77 } })
    expect(r.until("node 0x123 77", 2000)).toBe(true)
  })

  const AP: P = ["sb-wifi-access-point", "ap", { ssid: "Lab", password: "secret123", internet: "on" }]
  const webClient = (lib: string, cls: string) => `#include <${lib}.h>
#include <SoftwareSerial.h>
SoftwareSerial ss(2, 3);
${cls}Client client;
void setup(){ Serial.begin(115200); ss.begin(9600); WiFi.init(&ss);
  if (WiFi.status() == WL_NO_SHIELD) { Serial.println("no shield"); while(1); }
  int n = WiFi.scanNetworks(); Serial.print("scan "); Serial.print(n); for (int i = 0; i < n; i++) { Serial.print(" "); Serial.print(WiFi.SSID(i)); Serial.print(WiFi.RSSI(i)); } Serial.println();
  Serial.println(WiFi.begin("Lab", "wrong") == WL_CONNECTED ? "joined?!" : "refused");
  if (WiFi.begin("Lab", "secret123") != WL_CONNECTED) { Serial.println("join failed"); while(1); }
  Serial.print("ip "); Serial.println(WiFi.localIP());
  if (client.connect("example.com", 80)) {
    Serial.println("connected");
    client.println("GET /hello HTTP/1.1"); client.println("Host: example.com"); client.println("Connection: close"); client.println();
  } else Serial.println("connect failed");
}
void loop(){ while (client.available()) Serial.write(client.read());
  delay(10); // WiFiEsp polls AT+CIPSTATUS back to back: give +IPD a gap to arrive in (see the hint)
  if (!client.connected()) { static bool once = false; if (!once) { once = true; Serial.println(); Serial.println("[closed]"); client.stop(); } } }`

  it.skipIf(!has("WiFiEsp"))("Wi-Fi (ESP8285): WiFiEsp scans, is refused a wrong password, joins and GETs a page", () => {
    const r = start(webClient("WiFiEsp", "WiFiEsp"), [["sb-grove-uart-wifi-v2-esp8285", "w", { baud: "9600" }], AP], unoUart("w", "2", "3"))
    expect(r.until("[closed]", 40000), r.serial()).toBe(true)
    const s = r.serial()
    expect(s).toContain("scan 1 Lab-55")
    expect(s).toContain("refused")
    expect(s).toContain("ip 192.168.1.100")
    expect(s).toContain("HTTP/1.1 200 OK")
    expect(s).toContain("<h1>Hello from example.com</h1><p>GET /hello</p>")
  })

  it.skipIf(!has("WiFiEspAT"))("Wi-Fi (ESP8285): WiFiEspAT (AT 1.x, passive receive) joins and GETs a page", () => {
    const code = `#include <WiFiEspAT.h>
#include <SoftwareSerial.h>
SoftwareSerial ss(2, 3);
WiFiClient client;
void setup(){ Serial.begin(115200); ss.begin(9600);
  if (!WiFi.init(ss)) { Serial.println("no module"); while(1); }
  if (WiFi.begin("Lab", "secret123") != WL_CONNECTED) { Serial.println("join failed"); while(1); }
  Serial.print("ip "); Serial.println(WiFi.localIP());
  if (client.connect("arduino.tips", 80)) {
    client.print("GET /asciilogo.txt HTTP/1.1\\r\\nHost: arduino.tips\\r\\nConnection: close\\r\\n\\r\\n");
    client.flush();
  } else Serial.println("connect failed");
}
void loop(){ while (client.available()) Serial.write(client.read());
  if (!client.connected()) { static bool once = false; if (!once) { once = true; Serial.println(); Serial.println("[closed]"); client.stop(); } } }`
    const r = start(code, [["sb-grove-uart-wifi-v2-esp8285", "w", { baud: "9600" }], AP], unoUart("w", "2", "3"), "uno", {}, ["compiler.cpp.extra_flags=-DWIFIESPAT1"])
    expect(r.until("[closed]", 40000), r.serial()).toBe(true)
    expect(r.serial()).toContain("ip 192.168.1.100")
    expect(r.serial()).toContain("<h1>Hello from arduino.tips</h1><p>GET /asciilogo.txt</p>")
  })

  it.skipIf(!has("WizFi360"))("Wi-Fi (WizFi360): the WizFi360 library joins and GETs a page; no AP in range fails", () => {
    const r = start(webClient("WizFi360", "WiFi"), [["sb-grove-uart-wizfi360", "w", { baud: "9600" }], AP], unoUart("w", "2", "3"))
    expect(r.until("[closed]", 40000), r.serial()).toBe(true)
    const s = r.serial()
    expect(s).toContain("scan 1 Lab-55")
    expect(s).toContain("refused")
    expect(s).toContain("ip 192.168.1.100")
    expect(s).toContain("<h1>Hello from example.com</h1><p>GET /hello</p>")
    const far = start(webClient("WizFi360", "WiFi"), [["sb-grove-uart-wizfi360", "w", { baud: "9600" }], AP], unoUart("w", "2", "3"), "uno", { ap: { v: { rssi: -100 } } })
    expect(far.until("join failed", 40000), far.serial()).toBe(true)
    expect(far.serial()).toContain("scan 0")
  })

  /** a Pico sketch helper: send an AT command on a port and print what comes back, prefixed */
  const AT_HELPER = `String at(HardwareSerial& s, const char* tag, const char* cmd, int ms, bool nl = true) {
  if (nl) s.println(cmd); else s.print(cmd);
  String r; unsigned long t = millis(); while (millis() - t < (unsigned long)ms) while (s.available()) r += (char)s.read();
  Serial.print(tag); Serial.print("|"); r.replace("\\r", ""); r.replace("\\n", "~"); Serial.println(r); return r; }
String drain(HardwareSerial& s, const char* tag, int ms) { return at(s, tag, "", ms, false); }
`
  it.skipIf(!hasPico)("Wi-Fi: two modules on the same AP — a TCP server and a client exchange data", () => {
    const code = `${AT_HELPER}
void setup(){ Serial.begin(115200); Serial1.begin(115200); Serial2.begin(115200); delay(1500);
  at(Serial1, "A", "AT+CWJAP=\\"Lab\\",\\"secret123\\"", 2500); at(Serial2, "B", "AT+CWJAP=\\"Lab\\",\\"secret123\\"", 2500);
  at(Serial1, "A", "AT+CIFSR", 200); at(Serial2, "B", "AT+CIFSR", 200);
  at(Serial1, "A", "AT+CIPMUX=1", 100); at(Serial1, "A", "AT+CIPSERVER=1,333", 100);
  at(Serial2, "B", "AT+CIPSTART=\\"TCP\\",\\"192.168.1.100\\",333", 400);
  drain(Serial1, "A", 50);
  at(Serial2, "B", "AT+CIPSEND=5", 100); at(Serial2, "B", "hello", 200, false);
  drain(Serial1, "A", 100);
  at(Serial1, "A", "AT+CIPSEND=0,3", 100); at(Serial1, "A", "hey", 200, false);
  drain(Serial2, "B", 100);
  at(Serial1, "A", "AT+CIPCLOSE=0", 200); drain(Serial2, "B", 100);
  Serial.println("done"); }
void loop(){}`
    const pw = (id: string, port: 1 | 2) => picoUart(id, port)
    const r = start(code, [["sb-grove-uart-wifi-v2-esp8285", "a"], ["sb-grove-uart-wifi-v2-esp8285", "b"], AP], [...pw("a", 1), ...pw("b", 2)], "pico")
    expect(r.until("done", 15000), r.serial()).toBe(true)
    const s = r.serial()
    expect(s).toMatch(/A\|.*STAIP,"192\.168\.1\.100"/)
    expect(s).toMatch(/B\|.*STAIP,"192\.168\.1\.101"/)
    expect(s).toMatch(/B\|.*CONNECT~~OK/)
    expect(s).toMatch(/A\|.*0,CONNECT/)
    expect(s).toMatch(/A\|.*\+IPD,0,5:hello/)
    expect(s).toMatch(/B\|.*\+IPD,3:hey/)
    expect(s).toMatch(/B\|.*CLOSED/)
  })

  it.skipIf(!hasPico)("BLE (HM-11): a central discovers and connects to a peripheral, bytes pass both ways, AT drops the link", () => {
    const code = `${AT_HELPER}
void setup(){ Serial.begin(115200); Serial1.begin(9600); Serial2.begin(9600); delay(1500);
  at(Serial2, "B", "AT", 200, false); at(Serial2, "B", "AT+NAMEpeer", 200, false); at(Serial2, "B", "AT+NOTI1", 200, false); at(Serial2, "B", "AT+ADDR?", 200, false);
  at(Serial1, "A", "AT+ROLE1", 200, false); at(Serial1, "A", "AT+IMME1", 200, false);
  at(Serial1, "A", "AT+DISC?", 1500, false);
  at(Serial1, "A", "AT+CONN0", 1000, false); drain(Serial2, "B", 50);
  at(Serial1, "A", "hi there", 200, false); drain(Serial2, "B", 50);
  at(Serial2, "B", "back", 200, false); drain(Serial1, "A", 50);
  at(Serial1, "A", "AT", 300, false); drain(Serial2, "B", 50);
  Serial.println("done"); }
void loop(){}`
    const r = start(code, [["sb-grove-ble-hm-11", "a"], ["sb-grove-ble-hm-11", "b"]], [...picoUart("a", 1), ...picoUart("b", 2)], "pico")
    expect(r.until("done", 15000), r.serial()).toBe(true)
    const s = r.serial()
    expect(s).toContain("B|OK")
    expect(s).toContain("B|OK+Set:peer")
    expect(s).toContain("B|OK+ADDR:20C38FF61DA2")
    expect(s).toContain("A|OK+DISCSOK+DIS0:20C38FF61DA2OK+DISCE")
    expect(s).toContain("A|OK+CONNAOK+CONN")
    expect(s).toContain("B|OK+CONN")
    expect(s).toContain("B|hi there")
    expect(s).toContain("A|back")
    expect(s).toContain("A|OK+LOST")
    expect(s.split("B|OK+LOST").length).toBe(2)
  })

  it("BLE (HM-11) and Serial Bluetooth: the virtual phone connects, sends a line and hears the sketch", () => {
    const code = `#include <SoftwareSerial.h>
SoftwareSerial bt(2, 3);
void setup(){ Serial.begin(115200); bt.begin(9600); delay(50); bt.print("AT+NOTI1"); }
void loop(){ while (bt.available()) { char c = bt.read(); Serial.write(c); if (c == '\\n') bt.print("pong from sketch\\r\\n"); } }`
    for (const type of ["sb-grove-ble-hm-11", "sb-grove-serial-bluetooth-csr-bc417"]) {
      const r = start(code, [[type, "h"]], unoUart("h", "2", "3"))
      r.step(300)
      r.sim.setUi("h", { v: { phone: 1 } })
      r.step(100)
      r.sim.setUi("h", { v: { say: 3 } })
      expect(r.until("Hello from phone 3", 1000), r.serial()).toBe(true)
      if (type.includes("hm-11")) expect(r.serial()).toContain("OK+CONN")
      r.step(300)
      expect(r.sim.step(1, 1).mods.get("h")?.text).toContain("pong")
    }
  })

  it.skipIf(!hasPico)("Serial Bluetooth (BC417): Seeed +ST master/slave pairing, HC-05 style AT, and the v3.0 auto-connecting master", () => {
    const code = `${AT_HELPER}
void setup(){ Serial.begin(115200); Serial1.begin(9600); Serial2.begin(9600); delay(1500);
  at(Serial2, "S", "\\r\\n+STWMOD=0\\r\\n", 100, false); at(Serial2, "S", "\\r\\n+STNA=SeeedBTSlave\\r\\n", 100, false); at(Serial2, "S", "\\r\\n+INQ=1\\r\\n", 100, false);
  at(Serial1, "M", "\\r\\n+STWMOD=1\\r\\n", 100, false); at(Serial1, "M", "\\r\\n+INQ=1\\r\\n", 2000, false);
  at(Serial1, "M", "\\r\\n+CONN=00,13,ef,00,05,11\\r\\n", 1500, false); drain(Serial2, "S", 50);
  at(Serial1, "M", "data!", 100, false); drain(Serial2, "S", 50);
  Serial.println("st done"); }
void loop(){}`
    const r = start(code, [["sb-grove-serial-bluetooth-csr-bc417", "m"], ["sb-grove-serial-bluetooth-csr-bc417", "s"]], [...picoUart("m", 1), ...picoUart("s", 2)], "pico")
    expect(r.until("st done", 15000), r.serial()).toBe(true)
    let s = r.serial()
    expect(s).toContain("M|~OK~~+RTSTA:2~~+RTINQ=00,13,ef,00,05,11;SeeedBTSlave~")
    expect(s).toMatch(/M\|.*CONNECT:OK/)
    expect(s).toMatch(/S\|.*CONNECT:OK/)
    expect(s).toContain("S|data!")
    const hc = start(`${AT_HELPER}
void setup(){ Serial.begin(115200); Serial1.begin(9600); Serial2.begin(9600); delay(1500);
  at(Serial2, "S", "AT+NAME=Robot", 100); at(Serial2, "S", "AT+ADDR?", 100);
  at(Serial1, "M", "AT+ROLE=1", 100); at(Serial1, "M", "AT+INQ", 2000); at(Serial1, "M", "AT+LINK=0013,ef,000511", 1500);
  at(Serial1, "M", "ping", 100, false); drain(Serial2, "S", 50);
  at(Serial2, "S", "AT+VERSION?", 100); drain(Serial1, "M", 50);
  Serial.println("hc done"); }
void loop(){}`, [["sb-grove-serial-bluetooth-csr-bc417", "m"], ["sb-grove-serial-bluetooth-csr-bc417", "s"]], [...picoUart("m", 1), ...picoUart("s", 2)], "pico")
    expect(hc.until("hc done", 15000), hc.serial()).toBe(true)
    s = hc.serial()
    expect(s).toContain("S|OK~")
    expect(s).toContain("S|+ADDR:0013:ef:000511~OK~")
    expect(s).toContain("M|+INQ:0013:ef:000511,1F00,7FFF~OK~")
    expect(s).toContain("S|ping")
    expect(s).toContain("M|AT+VERSION?") // connected: the slave's bytes are data now
    const v3 = start(`${AT_HELPER}
void setup(){ Serial.begin(115200); Serial1.begin(9600); Serial2.begin(9600); delay(1500);
  at(Serial2, "S", "AT", 400, false); at(Serial2, "S", "AT+NAMESeeedSlave", 400, false); at(Serial2, "S", "AT+ROLES", 400, false);
  at(Serial1, "M", "AT+ROLEM", 400, false); at(Serial1, "M", "AT+AUTH1", 400, false); at(Serial1, "M", "AT+CLEAR", 2500, false);
  at(Serial1, "M", "1", 100, false); drain(Serial2, "S", 50);
  Serial.println("v3 done"); }
void loop(){}`, [["sb-grove-serial-bluetooth-csr-bc417", "m"], ["sb-grove-serial-bluetooth-csr-bc417", "s"]], [...picoUart("m", 1), ...picoUart("s", 2)], "pico")
    expect(v3.until("v3 done", 15000), v3.serial()).toBe(true)
    expect(v3.serial()).toContain("M|OKOK+CONN")
    expect(v3.serial()).toContain("S|1")
  })

  const loraPair = (freq: string) => `#include <RH_RF95.h>
RH_RF95<HardwareSerial> a(Serial1), b(Serial2);
uint8_t buf[RH_RF95_MAX_MESSAGE_LEN];
String log_; // printed at the end: Serial1's traffic shows up in the Pico's serial output too
bool wait(RH_RF95<HardwareSerial>& r, const char* tag) {
  if (!r.waitAvailableTimeout(3000)) { log_ += String(tag) + " nothing\\n"; return false; }
  uint8_t len = sizeof(buf); r.recv(buf, &len); buf[len] = 0;
  log_ += String(tag) + " got '" + (char*)buf + "' rssi " + r.lastRssi() + "\\n"; return true; }
void setup(){ Serial.begin(115200); delay(1500);
  log_ += a.init() && b.init() ? "init ok\\n" : "init failed\\n";
  a.setFrequency(${freq}); b.setFrequency(${freq});
  b.available();                       // b listens
  a.send((uint8_t*)"Hello World!", 13); a.waitPacketSent();
  if (wait(b, "b")) { a.available(); b.send((uint8_t*)"And hello back", 15); b.waitPacketSent(); wait(a, "a"); }
  Serial.print(log_); Serial.println("done"); }
void loop(){}`
  it.skipIf(!hasPico || !has("Grove - LoRa Radio"))("LoRa (RFM95 / RFM98): Seeed's RH_RF95 over a serial bridge, a packet and a reply, RSSI and range from the distance", () => {
    const r = start(loraPair("868.0"), [["sb-grove-lora-radio-868mhz", "a"], ["sb-grove-lora-radio-868mhz", "b"]], [...picoUart("a", 1), ...picoUart("b", 2)], "pico")
    expect(r.until("done", 20000), r.serial()).toBe(true)
    expect(r.serial()).toContain("init ok")
    expect(r.serial()).toMatch(/b got 'Hello World!' rssi -7\d/)
    expect(r.serial()).toMatch(/a got 'And hello back' rssi -7\d/)
    const far = start(loraPair("868.0"), [["sb-grove-lora-radio-868mhz", "a", { distance: "20000" }], ["sb-grove-lora-radio-868mhz", "b"]], [...picoUart("a", 1), ...picoUart("b", 2)], "pico")
    expect(far.until("done", 20000), far.serial()).toBe(true)
    expect(far.serial()).toContain("b nothing")
    const uhf = start(loraPair("434.0"), [["sb-grove-lora-radio-433mhz", "a"], ["sb-grove-lora-radio-433mhz", "b"]], [...picoUart("a", 1), ...picoUart("b", 2)], "pico")
    expect(uhf.until("done", 20000), uhf.serial()).toBe(true)
    expect(uhf.serial()).toMatch(/b got 'Hello World!' rssi -\d+/)
    const mixed = start(loraPair("434.0"), [["sb-grove-lora-radio-433mhz", "a"], ["sb-grove-lora-radio-868mhz", "b"]], [...picoUart("a", 1), ...picoUart("b", 2)], "pico")
    expect(mixed.until("done", 20000), mixed.serial()).toBe(true)
    expect(mixed.serial()).toContain("b nothing") // an RFM95 can't tune to 434 MHz
  })

  const E5_HELPER = `#include <SoftwareSerial.h>
SoftwareSerial e5(2, 3);
void at(const char* c, int ms) { e5.print(c); e5.print("\\r\\n"); unsigned long t = millis(); String r;
  while (millis() - t < (unsigned long)ms) while (e5.available()) r += (char)e5.read();
  r.replace("\\r", ""); r.replace("\\n", "~"); Serial.println(r); }
`
  it("Wio-E5: LoRaWAN join through the virtual gateway, uplinks with a downlink; no gateway, no join", () => {
    const code = `${E5_HELPER}
void setup(){ Serial.begin(115200); e5.begin(9600);
  at("AT", 200); at("AT+VER", 200); at("AT+ID", 300); at("AT+DR=EU868", 200); at("AT+DR=DR5", 300);
  at("AT+MSG=\\"early\\"", 300);
  at("AT+MODE=LWOTAA", 200); at("AT+JOIN", 6500);
  at("AT+MSG=\\"hello\\"", 2500); at("AT+CMSGHEX=\\"0102\\"", 2500);
  Serial.println("done"); }
void loop(){}`
    const r = start(code, [["sb-grove-wio-e5-wireless-module-stm32wle5jc", "e", { downlink: "CAFE" }]], unoUart("e", "2", "3"))
    expect(r.until("done", 20000), r.serial()).toBe(true)
    const s = r.serial()
    expect(s).toContain("+AT: OK~")
    expect(s).toContain("+VER: 4.0.11~")
    expect(s).toContain("+ID: DevEui, 2C:F7:F1:20:42:00:3F:6A~")
    expect(s).toContain("+DR: DR5~+DR: EU868 DR5  SF7 BW125K ~")
    expect(s).toContain("+MSG: Please join network first~")
    expect(s).toMatch(/\+JOIN: Start~\+JOIN: NORMAL~\+JOIN: Network joined~\+JOIN: NetID 000013 DevAddr [0-9A-F:]+~\+JOIN: Done~/)
    expect(s).toMatch(/\+MSG: Start~\+MSG: PORT: 8; RX: "CAFE"~\+MSG: RXWIN1, RSSI -\d+, SNR [-\d.]+~\+MSG: Done~/)
    expect(s).toMatch(/\+CMSGHEX: Start~\+CMSGHEX: Wait ACK~\+CMSGHEX: ACK Received~\+CMSGHEX: PORT: 8; RX: "CAFE"~.*\+CMSGHEX: Done~/)
    const off = start(code, [["sb-grove-wio-e5-wireless-module-stm32wle5jc", "e"]], unoUart("e", "2", "3"), "uno", { e: { v: { gateway: 0 } } })
    expect(off.until("done", 20000), off.serial()).toBe(true)
    expect(off.serial()).toContain("+JOIN: Start~+JOIN: NORMAL~")
    expect(off.serial()).not.toContain("Network joined")
    expect(off.serial()).toContain("+MSG: Please join network first~")
  })

  it.skipIf(!hasPico)("Wio-E5: TEST mode — TXLRPKT from one module arrives at the other's RXLRPKT", () => {
    const code = `${AT_HELPER}
void setup(){ Serial.begin(115200); Serial1.setFIFOSize(256); Serial2.setFIFOSize(256); Serial1.begin(9600); Serial2.begin(9600); delay(1500);
  String log_;
  const char* cfg = "AT+TEST=RFCFG,868,SF7,125,12,15,14,ON,OFF,OFF";
  for (int i = 0; i < 2; i++) { HardwareSerial& s = i ? Serial2 : Serial1; const char* t = i ? "B" : "A";
    at(s, t, "AT+MODE=TEST", 200); at(s, t, cfg, 200); }
  at(Serial2, "B", "AT+TEST=RXLRPKT", 200);
  log_ += at(Serial1, "A", "AT+TEST=TXLRPKT,\\"00AABBCC\\"", 500); log_ += "|";
  log_ += drain(Serial2, "B", 100);
  Serial.println(); Serial.println(log_); Serial.println("done"); }
void loop(){}`
    const r = start(code, [["sb-grove-wio-e5-wireless-module-stm32wle5jc", "a"], ["sb-grove-wio-e5-wireless-module-stm32wle5jc", "b"]], [...picoUart("a", 1), ...picoUart("b", 2)], "pico")
    expect(r.until("done", 15000), r.serial()).toBe(true)
    const s = r.serial()
    expect(s).toContain("+TEST: RFCFG F:868000000, SF7, BW125K, TXPR:12, RXPR:15, POW:14dBm, CRC:ON, IQ:OFF, NET:OFF")
    expect(s).toMatch(/\+TEST: TXLRPKT "00AABBCC"~\+TEST: TX DONE~\|\+TEST: LEN:4, RSSI:-\d+, SNR:\d+~\+TEST: RX "00AABBCC"/)
  })

  it.skipIf(!has("Grove - LoRa Radio"))("LoRa over SoftwareSerial: RH_RF95 on the Uno and a Wio-E5 in TEST mode hear each other", () => {
    const code = `#include <RH_RF95.h>
#include <SoftwareSerial.h>
SoftwareSerial ss(5, 6);
RH_RF95<SoftwareSerial> rf(ss);
String log_;
void e5(const char* c, int ms) { Serial.print(c); Serial.print("\\r\\n"); unsigned long t = millis(); String r;
  while (millis() - t < (unsigned long)ms) while (Serial.available()) r += (char)Serial.read();
  r.replace("\\r", ""); r.replace("\\n", "~"); log_ += r; log_ += "|"; }
void setup(){ Serial.begin(9600); delay(100);
  e5("AT+MODE=TEST", 200); e5("AT+TEST=RFCFG,868,SF7,125,8,8,14,ON,OFF,OFF", 200); e5("AT+TEST=RXLRPKT", 200);
  log_ += rf.init() ? "rf ok|" : "rf failed|";
  rf.send((uint8_t*)"hi e5", 5); rf.waitPacketSent();
  e5("", 300);
  rf.available();
  e5("AT+TEST=TXLRPKT,\\"FFFF000068656C6C6F\\"", 600);
  if (rf.waitAvailableTimeout(2000)) { uint8_t b[32], n = sizeof(b); rf.recv(b, &n); b[n] = 0; log_ += "rf got "; log_ += (char*)b; log_ += " "; log_ += rf.lastRssi(); }
  else log_ += "rf nothing";
  Serial.println(); Serial.println(log_); Serial.println("done"); }
void loop(){}`
    const r = start(code, [["sb-grove-lora-radio-868mhz", "rf"], ["sb-grove-wio-e5-wireless-module-stm32wle5jc", "e"]], [...unoUart("rf", "5", "6"), ["e:GND", "uno:GND.1"], ["e:VCC", "uno:5V"], ["e:RX", "uno:1"], ["e:TX", "uno:0"]])
    expect(r.until("done", 15000), r.serial()).toBe(true)
    const s = r.serial()
    expect(s).toContain("rf ok|")
    expect(s).toMatch(/\+TEST: LEN:9, RSSI:-\d+, SNR:\d+~\+TEST: RX "FFFF00006869206535"~/)
    expect(s).toMatch(/rf got hello -\d+/)
  })

  it("every comm part is simulated, and unwired / unpowered ones run without errors", () => {
    const types = ["sb-grove-rs232", "sb-grove-rs485", "sb-grove-can-bus-module-gd32e103", "sb-grove-uart-wifi-v2-esp8285", "sb-grove-uart-wizfi360", "sb-grove-ble-hm-11",
      "sb-grove-serial-bluetooth-csr-bc417", "sb-grove-wio-e5-wireless-module-stm32wle5jc", "sb-grove-lora-radio-433mhz", "sb-grove-lora-radio-868mhz", "sb-wifi-access-point"]
    for (const t of types) { const c = catalogPart(t)!; expect(c.model.m, t).toBe("proto"); expect(simulated(c), t).toBe(true) }
    // half of them unwired, the other half with data lines but no power
    const parts: P[] = types.map((t, i) => [t, `p${i}`])
    const wires: [string, string][] = types.flatMap((t, i): [string, string][] => (i % 2 && t !== "sb-wifi-access-point" ? [[`p${i}:RX`, "uno:3"], [`p${i}:TX`, "uno:2"]] : []))
    const r = start(`#include <SoftwareSerial.h>
SoftwareSerial s(2, 3);
void setup(){ Serial.begin(115200); s.begin(9600); s.println("AT"); Serial.println("alive"); }
void loop(){ s.println("AT+DISC?"); delay(100); }`, parts, wires)
    for (const id of parts.map((p) => p[1])) r.sim.setUi(id, { v: { phone: 1, say: 1, node: 1, gateway: 0 } })
    r.step(1500)
    expect(r.serial()).toContain("alive")
    expect(r.sim.step(1, 1).mods.get("p10")?.text).toBe("SpaceBench · 0")
  })
})
