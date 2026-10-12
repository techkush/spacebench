// The C++ added to ESP32 sketches when they run on QEMU (see src-tauri/src/esp32.rs).
export const ESP32_BRIDGE_FILE = "spacebench_bridge.cpp"
export const ESP32_BRIDGE = `// Space Bench ESP32 bridge (added when the sketch runs in the emulator; never needed on real hardware).
// Espressif's QEMU doesn't model GPIO levels, so pin activity is reported to Space Bench over a
// spare UART (frames A5 cmd pin lo hi), and input levels / analog voltages come back the same way:
// UART2 on the ESP32, UART1 on the ESP32-S3 / C3 (QEMU wires only UART0 and UART1 there).
#include <Arduino.h>
#if CONFIG_IDF_TARGET_ESP32
#define SB_UART_FIFO   (*(volatile uint32_t *)0x3FF6E000)
#define SB_UART_STATUS (*(volatile uint32_t *)0x3FF6E01C)
#define SB_RXCNT(s) ((s) & 0xFF)
#define SB_TXCNT(s) (((s) >> 16) & 0xFF)
#else
#define SB_UART_FIFO   (*(volatile uint32_t *)0x60010000)
#define SB_UART_STATUS (*(volatile uint32_t *)0x6001001C)
#define SB_RXCNT(s) ((s) & 0x3FF)
#define SB_TXCNT(s) (((s) >> 16) & 0x3FF)
#endif
#define SB_PINS 49
static uint8_t sb_in[SB_PINS];      // 0 / 1 / 0xFF = not set by the host
static uint16_t sb_mv[SB_PINS];
static bool sb_init = false;
static void sb_setup() { if (sb_init) return; sb_init = true; for (int i = 0; i < SB_PINS; i++) { sb_in[i] = 0xFF; sb_mv[i] = 0xFFFF; } }
static void sb_send(uint8_t cmd, uint8_t pin, uint16_t v) {
  uint8_t f[5] = { 0xA5, cmd, pin, (uint8_t)(v & 0xFF), (uint8_t)(v >> 8) };
  for (int i = 0; i < 5; i++) { while (SB_TXCNT(SB_UART_STATUS) > 120) {} SB_UART_FIFO = f[i]; }
}
static uint8_t sb_rx[5]; static int sb_rxn = 0;
static void sb_poll() {
  sb_setup();
  while (SB_RXCNT(SB_UART_STATUS)) {
    uint8_t b = SB_UART_FIFO & 0xFF;
    if (sb_rxn == 0 && b != 0xA5) continue;
    sb_rx[sb_rxn++] = b;
    if (sb_rxn == 5) {
      sb_rxn = 0;
      uint8_t pin = sb_rx[2]; uint16_t v = sb_rx[3] | (sb_rx[4] << 8);
      if (pin < SB_PINS) { if (sb_rx[1] == 'I') sb_in[pin] = v ? 1 : 0; else if (sb_rx[1] == 'A') sb_mv[pin] = v; }
    }
  }
}
extern "C" void __pinMode(uint8_t pin, uint8_t mode);
extern "C" void __digitalWrite(uint8_t pin, uint8_t val);
extern "C" int __digitalRead(uint8_t pin);
extern "C" void pinMode(uint8_t pin, uint8_t mode) { __pinMode(pin, mode); sb_send('M', pin, mode); }
extern "C" void digitalWrite(uint8_t pin, uint8_t val) { __digitalWrite(pin, val); sb_send('W', pin, val ? 1 : 0); }
extern "C" int digitalRead(uint8_t pin) { sb_poll(); return pin < SB_PINS && sb_in[pin] != 0xFF ? sb_in[pin] : __digitalRead(pin); }
// QEMU has no ADC model (its driver set-up panics): the voltage comes from Space Bench, 0 V until it does
extern "C" uint32_t analogReadMilliVolts(uint8_t pin) { sb_poll(); return pin < SB_PINS && sb_mv[pin] != 0xFFFF ? sb_mv[pin] : 0; }
extern "C" uint16_t analogRead(uint8_t pin) { sb_poll(); if (pin < SB_PINS && sb_mv[pin] != 0xFFFF) { uint32_t r = (uint32_t)sb_mv[pin] * 4095 / 3300; return r > 4095 ? 4095 : r; } return 0; }
// PWM (analogWrite / ledcWrite → ESP-IDF's LEDC driver): linked with --wrap of the three calls
// below, so each channel's pin, its timer's resolution and every duty change are known
#include "driver/ledc.h"
static uint8_t sb_ch_pin[LEDC_SPEED_MODE_MAX][8]; // GPIO + 1 (0 = not configured)
static uint8_t sb_ch_timer[LEDC_SPEED_MODE_MAX][8];
static uint8_t sb_tm_bits[LEDC_SPEED_MODE_MAX][4] = {{8, 8, 8, 8}};
extern "C" esp_err_t __real_ledc_channel_config(const ledc_channel_config_t *c);
extern "C" esp_err_t __wrap_ledc_channel_config(const ledc_channel_config_t *c) {
  if (c->channel < 8) { sb_ch_pin[c->speed_mode][c->channel] = c->gpio_num + 1; sb_ch_timer[c->speed_mode][c->channel] = c->timer_sel; }
  return __real_ledc_channel_config(c);
}
extern "C" esp_err_t __real_ledc_timer_config(const ledc_timer_config_t *t);
extern "C" esp_err_t __wrap_ledc_timer_config(const ledc_timer_config_t *t) {
  if (t->timer_num < 4) sb_tm_bits[t->speed_mode][t->timer_num] = t->duty_resolution;
  return __real_ledc_timer_config(t);
}
extern "C" esp_err_t __real_ledc_set_duty(ledc_mode_t mode, ledc_channel_t ch, uint32_t duty);
extern "C" esp_err_t __wrap_ledc_set_duty(ledc_mode_t mode, ledc_channel_t ch, uint32_t duty) {
  esp_err_t r = __real_ledc_set_duty(mode, ch, duty);
  if (ch < 8 && sb_ch_pin[mode][ch]) {
    uint8_t bits = sb_tm_bits[mode][sb_ch_timer[mode][ch]];
    uint32_t full = bits >= 31 ? 0xFFFFFFFF : (1u << bits) - 1;
    uint32_t d = full ? (uint32_t)((uint64_t)duty * 255 / full) : 0;
    sb_send('P', sb_ch_pin[mode][ch] - 1, d > 255 ? 255 : d);
  }
  return r;
}
`
