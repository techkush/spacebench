// Catalogue entries for the comm parts: their model (and look / pins / hint when they change).
import type { Ctl } from "../types"
import type { PartPatch } from "./types"

const c = (key: string, label: string, min: number, max: number, step: number, unit: string, def: number): Ctl => ({ key, label, min, max, step, unit, def })
const BAUDS = ["1200", "2400", "4800", "9600", "19200", "38400", "57600", "115200"]
const phone = [c("phone", "Phone connected", 0, 1, 1, "", 0), c("say", "Phone sends #", 0, 20, 1, "", 0)]
const dist = c("distance", "Distance", 1, 20000, 1, "m", 100)

export const PARTS: Record<string, PartPatch> = {
  "sb-grove-rs232": {
    model: { m: "proto", kind: "comm-rs232" },
    attrs: { baud: "9600", loopback: "off" },
    settings: { baud: BAUDS, loopback: ["off", "on"] },
    hint: "RS-232 level shifter (MAX3232): transparent — bytes into RX come out of the other RS-232 module's TX (a null-modem pair), or straight back with Loopback on. Any UART library works (Serial / SoftwareSerial at the Baud setting).",
  },
  "sb-grove-rs485": {
    model: { m: "proto", kind: "comm-rs485" },
    attrs: { baud: "9600" },
    settings: { baud: BAUDS },
    hint: "RS-485 transceiver (MAX485, automatic direction on the Grove board): a half-duplex bus — bytes sent by one module reach every other RS-485 module's TX; a module doesn't hear the bus while it transmits.",
  },
  "sb-grove-can-bus-module-gd32e103": {
    model: { m: "proto", kind: "comm-can", ctls: [c("node", "Virtual node (0x123)", 0, 1, 1, "", 0), c("value", "Node data byte", 0, 255, 1, "", 42), c("period", "Node period", 50, 2000, 50, "ms", 500)] },
    attrs: { baud: "9600" },
    settings: { baud: ["9600", "19200", "38400", "57600", "115200"] },
    hint: "Grove CAN BUS module (GD32E103) with Longan's Serial CAN FD protocol (Serial_CAN_FD library: can_speed_20, can_send, read_can, set_mask_filt, set_baudrate): frames go to every other CAN module at the same bus speed. The virtual-node slider puts an ECU sending ID 0x123 on the bus.",
  },
  "sb-grove-uart-wifi-v2-esp8285": {
    model: { m: "proto", kind: "comm-esp8285" },
    attrs: { baud: "115200" },
    settings: { baud: ["9600", "19200", "38400", "57600", "115200"] },
    hint: "ESP8285 with Espressif AT firmware 1.6 (WiFiEsp library): AT+CWLAP lists the WiFi Access Points on the canvas, AT+CWJAP joins one (SSID and password must match), TCP/UDP to any host reaches a simulated internet (HTTP on any port, echo on 7, NTP on 123), or another WiFi module's AT+CIPSERVER on the same AP.",
  },
  "sb-grove-uart-wizfi360": {
    model: { m: "proto", kind: "comm-wizfi360" },
    attrs: { baud: "115200" },
    settings: { baud: ["9600", "19200", "38400", "57600", "115200"] },
    hint: "WizFi360 with its ESP-AT compatible firmware (WizFi360 library): joins a WiFi Access Point on the canvas, then TCP/UDP to a simulated internet (HTTP, echo on 7, NTP on 123) or to another WiFi module on the same AP.",
  },
  "sb-grove-ble-hm-11": {
    model: { m: "proto", kind: "comm-hm11", ctls: phone },
    attrs: { baud: "9600" },
    settings: { baud: ["9600", "19200", "38400", "57600", "115200"], name: "text" },
    hint: "HM-11 BLE (CC2541, HMSoft V540 AT commands without CR/LF): two HM-11s pair (AT+ROLE1, AT+DISC?, AT+CON…) and pass bytes transparently; the Phone slider connects a virtual phone to a peripheral, Phone sends # makes it send a line.",
  },
  "sb-grove-serial-bluetooth-csr-bc417": {
    model: { m: "proto", kind: "comm-spp", ctls: phone },
    attrs: { baud: "9600" },
    settings: { baud: ["9600", "19200", "38400", "57600", "115200"], name: "text" },
    hint: "Serial Bluetooth SPP (CSR BC417): Seeed's +STWMOD/+INQ/+CONN commands, HC-05 style AT+ROLE=/AT+INQ/AT+LINK= and the v3.0 AT+ROLEM set — a master pairs with another module, then bytes pass transparently. The Phone slider connects a virtual phone to a slave.",
  },
  "sb-grove-wio-e5-wireless-module-stm32wle5jc": {
    model: { m: "proto", kind: "comm-wio-e5", ctls: [c("gateway", "LoRaWAN gateway in range", 0, 1, 1, "", 1), dist] },
    attrs: { baud: "9600", downlink: "" },
    settings: { baud: ["9600", "19200", "38400", "57600", "115200"], downlink: "text" },
    hint: "Wio-E5 with Seeed's LoRaWAN AT firmware (9600 baud): AT+ID, AT+DR, AT+MODE, AT+JOIN through a virtual gateway (slider; range from Distance and the data rate), AT+MSG/CMSG/MSGHEX with an optional downlink (Settings, hex), and TEST mode TXLRPKT/RXLRPKT between radios.",
  },
  "sb-grove-lora-radio-433mhz": {
    model: { m: "proto", kind: "comm-lora433", ctls: [dist] },
    hint: "Grove LoRa Radio 433 MHz (RFM98 behind an ATmega168 serial bridge at 57600): the SX127x registers through Seeed's RH_RF95 (\"Grove - LoRa Radio 433MHz 868MHz\" library over SoftwareSerial). Packets reach radios on the same frequency/SF/BW; RSSI and range follow the Distance sliders.",
  },
  "sb-grove-lora-radio-868mhz": {
    model: { m: "proto", kind: "comm-lora868", ctls: [dist] },
    hint: "Grove LoRa Radio 868 MHz (RFM95 behind an ATmega168 serial bridge at 57600): the SX127x registers through Seeed's RH_RF95 (\"Grove - LoRa Radio 433MHz 868MHz\" library over SoftwareSerial). Packets reach radios on the same frequency/SF/BW; RSSI and range follow the Distance sliders.",
  },
  "sb-wifi-access-point": {
    model: { m: "proto", kind: "comm-ap", ctls: [c("rssi", "Signal at the modules", -100, -30, 1, "dBm", -55)] },
    attrs: { ssid: "SpaceBench", password: "spacebench", internet: "on" },
    settings: { ssid: "text", password: "text", internet: ["on", "off"] },
    hint: "A simulated WiFi network (SSID and password in Settings): the WiFi modules join it and get 192.168.x.10x addresses; with Internet on, host names resolve and answer HTTP, echo (7) and NTP (123). ESP32 boards can't join — their emulator has no WiFi radio.",
  },
}
