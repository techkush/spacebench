// Built-in microcontroller examples: a sketch, its libraries and its wiring diagram.
import { breadboardHoles } from "./elements/breadboard"
import { boardByType, isLinuxBoard } from "./boards"
import { boardId, type Connection, type Diagram, type DiagramPart } from "./diagram"
import { blankFiles } from "./multiboard"

export interface SketchFileData { name: string; content: string }
export interface McuExample { id: string; title: string; description: string; category: string; files: SketchFileData[]; diagram: Diagram }

const part = (type: string, id: string, left: number, top: number, attrs: Record<string, string> = {}, rotate?: number): DiagramPart => ({ type: `wokwi-${type}`, id, left, top, attrs, ...(rotate ? { rotate } : {}) })
const w = (a: string, b: string, color = "green", hints: string[] = []): Connection => [a, b, color, hints]
/** a catalogue part (catalog/data.ts) */
const cat = (type: string, id: string, left: number, top: number, attrs: Record<string, string> = {}): DiagramPart => ({ type: `sb-${type}`, id, left, top, attrs })
const uno = (...parts: DiagramPart[]) => [part("arduino-uno", "uno", 0, 0), ...parts]
const dia = (parts: DiagramPart[], connections: Connection[]): Diagram => ({ version: 1, author: "Space Bench", editor: "spacebench", parts, connections })
const files = (sketch: string, libs: string[] = []): SketchFileData[] => [{ name: "sketch.ino", content: sketch.trim() + "\n" }, { name: "libraries.txt", content: libs.length ? libs.join("\n") + "\n" : "# Arduino libraries this sketch uses, one per line (Name or Name@version)\n" }]

export const MCU_EXAMPLES: McuExample[] = [
  {
    id: "grove-starter", title: "Grove starter kit", category: "Grove & modules", description: "Knob → LED brightness, button → relay that runs a motor from a 9 V battery (with a beep), Grove temperature on Serial.",
    files: files(`
// Grove starter kit: modules from the catalogue, plain Arduino calls
const int KNOB = A0, TEMP = A1, BUTTON = 4, LED = 5, RELAY = 7, BUZZER = 8;
bool motor = false;
int last = LOW;

void setup() {
  Serial.begin(9600);
  pinMode(BUTTON, INPUT);
  pinMode(LED, OUTPUT);
  pinMode(RELAY, OUTPUT);
}

void loop() {
  analogWrite(LED, analogRead(KNOB) / 4);          // turn the knob (slider while running)
  int b = digitalRead(BUTTON);                     // press the Grove button
  if (b == HIGH && last == LOW) {
    motor = !motor;
    digitalWrite(RELAY, motor);                    // the relay switches the 9 V motor
    tone(BUZZER, motor ? 1200 : 600, 80);
  }
  last = b;
  static unsigned long t = 0;
  if (millis() - t > 1000) {
    t = millis();
    float r = 1023.0 / analogRead(TEMP) - 1.0;     // Grove NTC: 100 kΩ, β 4275
    float c = 1.0 / (log(r) / 4275 + 1 / 298.15) - 273.15;
    Serial.print("Temperature: "); Serial.print(c, 1);
    Serial.print(" C, motor "); Serial.println(motor ? "ON" : "OFF");
  }
  delay(10);
}`),
    diagram: dia(uno(
      cat("grove-rotary-angle-sensor", "knob", -10, -150), cat("grove-temperature-sensor", "temp", 70, -150), cat("grove-button", "btn", 150, -150),
      cat("grove-red-led", "led", 230, -150), cat("grove-passive-buzzer", "buzz", 310, -150), cat("grove-relay-5v-10a", "relay", 320, -10),
      cat("dc-motor-fan", "motor", 440, -40), cat("9v-battery", "bat", 420, 80),
    ), [
      ...["knob", "temp", "btn", "led", "buzz", "relay"].flatMap((id, i) => [w(`${id}:GND`, `uno:GND.${(i % 3) + 1}`, "black"), w(`${id}:VCC`, "uno:5V", "red")]),
      w("knob:SIG", "uno:A0", "yellow"), w("temp:SIG", "uno:A1", "yellow"), w("btn:SIG", "uno:4", "yellow"), w("led:SIG", "uno:5", "yellow"), w("relay:SIG", "uno:7", "yellow"), w("buzz:SIG", "uno:8", "yellow"),
      w("bat:+", "relay:COM", "red"), w("relay:NO", "motor:+", "orange"), w("motor:-", "bat:-", "black"),
    ]),
  },
  {
    id: "blink", title: "Blink", category: "Basics", description: "The on-board LED and an external LED blink every half second; Serial says so.",
    files: files(`
// Blink: the "L" LED on pin 13 and an LED on pin 12, every 500 ms
void setup() {
  pinMode(13, OUTPUT);
  pinMode(12, OUTPUT);
  Serial.begin(9600);
  Serial.println("Blink ready!");
}

void loop() {
  digitalWrite(13, HIGH);
  digitalWrite(12, LOW);
  Serial.println("LED ON");
  delay(500);
  digitalWrite(13, LOW);
  digitalWrite(12, HIGH);
  Serial.println("LED OFF");
  delay(500);
}`),
    diagram: dia(uno(part("led", "led1", 120, -120, { color: "red" }), part("resistor", "r1", 130, -48, { value: "220" }, 90)), [
      w("uno:12", "r1:2", "green"), w("r1:1", "led1:A", "green"), w("led1:C", "uno:GND.1", "black"),
    ]),
  },
  {
    id: "breadboard", title: "Breadboard LED", category: "Basics", description: "An LED and its resistor plugged into a breadboard — no wires between them; the strips connect them.",
    files: files(`
// The LED and resistor sit in the breadboard: column 11 joins them, the − rail is ground
void setup() { pinMode(13, OUTPUT); }

void loop() {
  digitalWrite(13, HIGH); delay(400);
  digitalWrite(13, LOW);  delay(400);
}`),
    diagram: (() => {
      const bx = 0, by = -280
      const hole = (n: string) => { const h = breadboardHoles("wokwi-breadboard-half").holes.find((x) => x.name === n)!; return { x: bx + h.x, y: by + h.y } }
      const c = hole("10t.e"), r1 = hole("11t.b")
      return dia(uno(
        part("breadboard-half", "bb1", bx, by),
        part("led", "led1", Math.round((c.x - 15) * 100) / 100, Math.round((c.y - 42) * 100) / 100, { color: "red" }),
        part("resistor", "r1", Math.round(r1.x * 100) / 100, Math.round((r1.y - 5.65) * 100) / 100, { value: "220" }),
      ), [w("uno:13", "bb1:17t.a", "green"), w("bb1:10t.a", "bb1:tn.8", "black"), w("bb1:tn.1", "uno:GND.1", "black")])
    })(),
  },
  {
    id: "button", title: "Button and LED", category: "Basics", description: "Hold the button to light the LED — INPUT_PULLUP, no resistor needed on the button.",
    files: files(`
// The button pulls pin 2 to GND when pressed (INPUT_PULLUP keeps it HIGH otherwise)
const int BUTTON = 2;
const int LED = 9;

void setup() {
  pinMode(BUTTON, INPUT_PULLUP);
  pinMode(LED, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  bool pressed = digitalRead(BUTTON) == LOW;
  digitalWrite(LED, pressed ? HIGH : LOW);
  static bool was = false;
  if (pressed != was) { Serial.println(pressed ? "pressed" : "released"); was = pressed; }
}`),
    diagram: dia(uno(part("pushbutton", "btn1", 210, -110, { color: "green" }), part("led", "led1", 120, -130, { color: "green" }), part("resistor", "r1", 135, -55, { value: "220" }, 90)), [
      w("uno:2", "btn1:2.r", "green"), w("btn1:1.l", "uno:GND.1", "black"),
      w("uno:9", "r1:2", "blue"), w("r1:1", "led1:A", "blue"), w("led1:C", "uno:GND.1", "black"),
    ]),
  },
  {
    id: "fade", title: "Fade (PWM)", category: "Basics", description: "analogWrite fades an LED up and down on PWM pin 9.",
    files: files(`
// Fade an LED with PWM (analogWrite) on pin 9
int brightness = 0, step = 5;

void setup() { pinMode(9, OUTPUT); }

void loop() {
  analogWrite(9, brightness);
  brightness += step;
  if (brightness <= 0 || brightness >= 255) step = -step;
  delay(20);
}`),
    diagram: dia(uno(part("led", "led1", 150, -130, { color: "orange" }), part("resistor", "r1", 160, -55, { value: "220" }, 90)), [
      w("uno:9", "r1:2"), w("r1:1", "led1:A"), w("led1:C", "uno:GND.1", "black"),
    ]),
  },
  {
    id: "pot", title: "Potentiometer → LED and Serial", category: "Basics", description: "Turn the knob: A0 reads 0–1023, the LED brightness follows and Serial prints the voltage.",
    files: files(`
// Read a potentiometer on A0, dim an LED on pin 6, print the voltage
void setup() {
  Serial.begin(115200);
  pinMode(6, OUTPUT);
}

void loop() {
  int raw = analogRead(A0);
  analogWrite(6, raw / 4);
  Serial.print("A0 = ");
  Serial.print(raw);
  Serial.print("  (");
  Serial.print(raw * 5.0 / 1023, 2);
  Serial.println(" V)");
  delay(200);
}`),
    diagram: dia(uno(part("potentiometer", "pot1", 190, 250, { value: "512" }), part("led", "led1", 190, -130, { color: "yellow" }), part("resistor", "r1", 200, -55, { value: "330" }, 90)), [
      w("pot1:GND", "uno:GND.2", "black"), w("pot1:VCC", "uno:5V", "red"), w("pot1:SIG", "uno:A0", "green"),
      w("uno:6", "r1:2", "orange"), w("r1:1", "led1:A", "orange"), w("led1:C", "uno:GND.1", "black"),
    ]),
  },
  {
    id: "traffic", title: "Traffic light", category: "Basics", description: "Red, yellow and green LEDs in sequence — three outputs with their resistors.",
    files: files(`
// A traffic light: green 3 s, yellow 1 s, red 3 s
const int RED = 11, YELLOW = 10, GREEN = 9;

void setup() {
  pinMode(RED, OUTPUT); pinMode(YELLOW, OUTPUT); pinMode(GREEN, OUTPUT);
  Serial.begin(9600);
}

void show(int pin, const char *name, int ms) {
  digitalWrite(RED, pin == RED); digitalWrite(YELLOW, pin == YELLOW); digitalWrite(GREEN, pin == GREEN);
  Serial.println(name);
  delay(ms);
}

void loop() {
  show(GREEN, "green", 3000);
  show(YELLOW, "yellow", 1000);
  show(RED, "red", 3000);
}`),
    diagram: dia(uno(
      part("led", "led1", 110, -150, { color: "red" }), part("led", "led2", 150, -150, { color: "yellow" }), part("led", "led3", 190, -150, { color: "green" }),
      part("resistor", "r1", 105, -75, { value: "220" }, 90), part("resistor", "r2", 145, -75, { value: "220" }, 90), part("resistor", "r3", 185, -75, { value: "220" }, 90),
    ), [
      w("uno:11", "r1:2", "red"), w("r1:1", "led1:A", "red"), w("uno:10", "r2:2", "yellow"), w("r2:1", "led2:A", "yellow"), w("uno:9", "r3:2", "green"), w("r3:1", "led3:A", "green"),
      w("led1:C", "uno:GND.1", "black"), w("led2:C", "uno:GND.1", "black"), w("led3:C", "uno:GND.1", "black"),
    ]),
  },
  {
    id: "rgb", title: "RGB LED colours", category: "Outputs", description: "Mix colours on a common-cathode RGB LED with three PWM pins.",
    files: files(`
// Cycle through colours on an RGB LED (common cathode) on PWM pins 9, 10, 11
void color(int r, int g, int b) { analogWrite(9, r); analogWrite(10, g); analogWrite(11, b); }

void setup() {}

void loop() {
  color(255, 0, 0);   delay(600);
  color(0, 255, 0);   delay(600);
  color(0, 0, 255);   delay(600);
  color(255, 160, 0); delay(600);
  color(160, 0, 255); delay(600);
  for (int i = 0; i < 256; i++) { color(i, 255 - i, 128); delay(8); }
}`),
    diagram: dia(uno(part("rgb-led", "rgb1", 150, -150, { common: "cathode" }), part("resistor", "r1", 120, -70, { value: "220" }, 90), part("resistor", "r2", 150, -70, { value: "220" }, 90), part("resistor", "r3", 180, -70, { value: "220" }, 90)), [
      w("uno:9", "r1:2", "red"), w("r1:1", "rgb1:R", "red"), w("uno:10", "r2:2", "green"), w("r2:1", "rgb1:G", "green"), w("uno:11", "r3:2", "blue"), w("r3:1", "rgb1:B", "blue"), w("rgb1:COM", "uno:GND.1", "black"),
    ]),
  },
  {
    id: "melody", title: "Buzzer melody", category: "Outputs", description: "tone() plays a tune — you hear it through the computer's speakers.",
    files: files(`
// Play a short melody on a buzzer with tone()
const int BUZZER = 8;
int notes[] = { 262, 294, 330, 349, 392, 440, 494, 523 };

void setup() { Serial.begin(9600); }

void loop() {
  for (int i = 0; i < 8; i++) {
    Serial.println(notes[i]);
    tone(BUZZER, notes[i], 250);
    delay(300);
  }
  noTone(BUZZER);
  delay(1000);
}`),
    diagram: dia(uno(part("buzzer", "bz1", 165, -110)), [w("uno:8", "bz1:2", "green"), w("bz1:1", "uno:GND.1", "black")]),
  },
  {
    id: "servo", title: "Servo follows a knob", category: "Outputs", description: "The Servo library turns a servo to the angle set by a potentiometer.",
    files: files(`
#include <Servo.h>
// Map a potentiometer (A0) to a servo angle (pin 9)
Servo servo;

void setup() {
  servo.attach(9);
  Serial.begin(9600);
}

void loop() {
  int angle = map(analogRead(A0), 0, 1023, 0, 180);
  servo.write(angle);
  Serial.println(angle);
  delay(50);
}`, ["Servo"]),
    diagram: dia(uno(part("servo", "servo1", 320, -40), part("potentiometer", "pot1", 200, 250, { value: "300" })), [
      w("servo1:PWM", "uno:9", "orange"), w("servo1:V+", "uno:5V", "red"), w("servo1:GND", "uno:GND.2", "black"),
      w("pot1:GND", "uno:GND.3", "black"), w("pot1:VCC", "uno:5V", "red"), w("pot1:SIG", "uno:A0", "green"),
    ]),
  },
  {
    id: "lcd", title: "LCD 16×2 (I²C)", category: "Displays", description: "LiquidCrystal_I2C prints text and a running counter on a 16×2 display.",
    files: files(`
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
// A 16x2 LCD with an I2C backpack at address 0x27 (SDA = A4, SCL = A5)
LiquidCrystal_I2C lcd(0x27, 16, 2);

void setup() {
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0);
  lcd.print("Hello, Space Bench");
}

void loop() {
  lcd.setCursor(0, 1);
  lcd.print("Uptime: ");
  lcd.print(millis() / 1000);
  lcd.print(" s   ");
  delay(250);
}`, ["LiquidCrystal I2C"]),
    diagram: dia(uno(part("lcd1602", "lcd1", 320, -20, { pins: "i2c" })), [
      w("lcd1:GND", "uno:GND.2", "black"), w("lcd1:VCC", "uno:5V", "red"), w("lcd1:SDA", "uno:A4", "blue"), w("lcd1:SCL", "uno:A5", "yellow"),
    ]),
  },
  {
    id: "lcd-parallel", title: "LCD 16×2 (parallel)", category: "Displays", description: "The classic LiquidCrystal wiring: RS, E and D4–D7 on six pins.",
    files: files(`
#include <LiquidCrystal.h>
// LiquidCrystal(rs, en, d4, d5, d6, d7)
LiquidCrystal lcd(12, 11, 5, 4, 3, 2);

void setup() {
  lcd.begin(16, 2);
  lcd.print("Parallel LCD");
}

void loop() {
  lcd.setCursor(0, 1);
  lcd.print(millis() / 100);
  delay(100);
}`, ["LiquidCrystal"]),
    diagram: dia(uno(part("lcd1602", "lcd1", 40, -190, { pins: "full" })), [
      w("lcd1:VSS", "uno:GND.1", "black"), w("lcd1:K", "uno:GND.1", "black"), w("lcd1:RW", "uno:GND.1", "black"),
      w("lcd1:VDD", "uno:5V", "red"), w("lcd1:A", "uno:5V", "red"),
      w("lcd1:RS", "uno:12", "green"), w("lcd1:E", "uno:11", "green"),
      w("lcd1:D4", "uno:5", "blue"), w("lcd1:D5", "uno:4", "blue"), w("lcd1:D6", "uno:3", "blue"), w("lcd1:D7", "uno:2", "blue"),
    ]),
  },
  {
    id: "oled", title: "OLED 128×64 (SSD1306)", category: "Displays", description: "Adafruit_SSD1306 draws text and shapes on an I²C OLED at 0x3C.",
    files: files(`
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
Adafruit_SSD1306 display(128, 64, &Wire, -1);

void setup() {
  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  display.clearDisplay();
  display.setTextSize(2);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println("Space");
  display.println("Bench");
  display.drawRect(0, 40, 128, 24, SSD1306_WHITE);
  display.display();
}

void loop() {
  static int x = 2;
  display.fillRect(2, 42, 124, 20, SSD1306_BLACK);
  display.fillCircle(x, 52, 8, SSD1306_WHITE);
  display.display();
  x = (x + 4) % 124;
}`, ["Adafruit SSD1306", "Adafruit GFX Library"]),
    diagram: dia(uno(part("ssd1306", "oled1", 320, 0)), [
      w("oled1:GND", "uno:GND.2", "black"), w("oled1:VIN", "uno:5V", "red"), w("oled1:DATA", "uno:A4", "blue"), w("oled1:CLK", "uno:A5", "yellow"),
    ]),
  },
  {
    id: "7seg", title: "7-segment counter", category: "Displays", description: "Count 0–9 on a common-cathode 7-segment display (pins 2–8).",
    files: files(`
// Segments a..g on pins 2..8 (common cathode: HIGH = on)
const byte DIGITS[10] = { 0x3F, 0x06, 0x5B, 0x4F, 0x66, 0x6D, 0x7D, 0x07, 0x7F, 0x6F };

void setup() { for (int p = 2; p <= 8; p++) pinMode(p, OUTPUT); }

void loop() {
  for (int d = 0; d < 10; d++) {
    for (int s = 0; s < 7; s++) digitalWrite(2 + s, (DIGITS[d] >> s) & 1);
    delay(700);
  }
}`),
    diagram: dia(uno(part("7segment", "seg1", 200, -170, { common: "cathode", digits: "1" }),
      ...["a", "b", "c", "d", "e", "f", "g"].map((_, i) => part("resistor", `r${i + 1}`, 140 + i * 18, -60, { value: "220" }, 90))), [
      ...["A", "B", "C", "D", "E", "F", "G"].flatMap((s, i) => [w(`uno:${2 + i}`, `r${i + 1}:2`, "green"), w(`r${i + 1}:1`, `seg1:${s}`, "green")]),
      w("seg1:COM.1", "uno:GND.1", "black"),
    ]),
  },
  {
    id: "thermometer", title: "NTC thermometer", category: "Sensors", description: "Read an NTC thermistor module on A0 and convert to °C (β equation). Drag its temperature while running.",
    files: files(`
// NTC 10k (beta 3950) divider on A0 -> temperature
const float BETA = 3950;

void setup() { Serial.begin(9600); }

void loop() {
  int a = analogRead(A0);
  float celsius = 1 / (log(1 / (1023.0 / a - 1)) / BETA + 1.0 / 298.15) - 273.15;
  Serial.print("Temperature: ");
  Serial.print(celsius, 1);
  Serial.println(" C");
  delay(500);
}`),
    diagram: dia(uno(part("ntc-temperature-sensor", "ntc1", 190, 260, { temperature: "24" })), [
      w("ntc1:GND", "uno:GND.2", "black"), w("ntc1:VCC", "uno:5V", "red"), w("ntc1:OUT", "uno:A0", "green"),
    ]),
  },
  {
    id: "ultrasonic", title: "Ultrasonic distance", category: "Sensors", description: "HC-SR04: a 10 µs TRIG pulse, pulseIn on ECHO, 58 µs per cm.",
    files: files(`
const int TRIG = 3, ECHO = 2;

void setup() {
  pinMode(TRIG, OUTPUT);
  pinMode(ECHO, INPUT);
  Serial.begin(9600);
}

void loop() {
  digitalWrite(TRIG, LOW); delayMicroseconds(2);
  digitalWrite(TRIG, HIGH); delayMicroseconds(10);
  digitalWrite(TRIG, LOW);
  long us = pulseIn(ECHO, HIGH);
  Serial.print("Distance: ");
  Serial.print(us / 58);
  Serial.println(" cm");
  delay(300);
}`),
    diagram: dia(uno(part("hc-sr04", "sonar1", 170, -150, { distance: "100" })), [
      w("sonar1:VCC", "uno:5V", "red"), w("sonar1:GND", "uno:GND.1", "black"), w("sonar1:TRIG", "uno:3", "green"), w("sonar1:ECHO", "uno:2", "blue"),
    ]),
  },
  {
    id: "dht22", title: "DHT22 temperature & humidity", category: "Sensors", description: "The DHT library reads a DHT22 on pin 2 (one-wire protocol, emulated bit by bit).",
    files: files(`
#include <DHT.h>
DHT dht(2, DHT22);

void setup() { Serial.begin(9600); dht.begin(); }

void loop() {
  delay(2000);
  float h = dht.readHumidity();
  float t = dht.readTemperature();
  if (isnan(h) || isnan(t)) { Serial.println("DHT read failed"); return; }
  Serial.print("Humidity: "); Serial.print(h, 1); Serial.print(" %  ");
  Serial.print("Temperature: "); Serial.print(t, 1); Serial.println(" C");
}`, ["DHT sensor library", "Adafruit Unified Sensor"]),
    diagram: dia(uno(part("dht22", "dht1", 225, -140, { temperature: "24", humidity: "40" })), [
      w("dht1:VCC", "uno:5V", "red"), w("dht1:GND", "uno:GND.1", "black"), w("dht1:SDA", "uno:2", "green"),
    ]),
  },
  {
    id: "neopixel", title: "NeoPixel colour cycle", category: "Outputs", description: "Adafruit_NeoPixel drives a WS2812 LED on pin 6 — the bit stream is decoded from pin timing.",
    files: files(`
#include <Adafruit_NeoPixel.h>
Adafruit_NeoPixel pixel(1, 6, NEO_GRB + NEO_KHZ800);

void setup() { pixel.begin(); }

void loop() {
  for (long hue = 0; hue < 65536; hue += 2048) {
    pixel.setPixelColor(0, pixel.gamma32(pixel.ColorHSV(hue)));
    pixel.show();
    delay(40);
  }
}`, ["Adafruit NeoPixel"]),
    diagram: dia(uno(part("neopixel", "px1", 195, -90)), [w("px1:DIN", "uno:6", "green"), w("px1:VDD", "uno:5V", "red"), w("px1:VSS", "uno:GND.1", "black")]),
  },
  {
    id: "serial-echo", title: "Serial echo", category: "Basics", description: "Type in the Serial Monitor; the sketch answers. Send 1 / 0 to switch the LED.",
    files: files(`
void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(9600);
  Serial.println("Type something (1 = LED on, 0 = off)");
}

void loop() {
  if (Serial.available()) {
    String line = Serial.readStringUntil('\\n');
    line.trim();
    if (line == "1") digitalWrite(LED_BUILTIN, HIGH);
    if (line == "0") digitalWrite(LED_BUILTIN, LOW);
    Serial.print("You sent: ");
    Serial.println(line);
  }
}`),
    diagram: dia(uno(), []),
  },
  // ── IoT projects (ideas after the "100 Days 100 IoT Projects" topics; our own Arduino code, offline) ──
  {
    id: "iot-night-light", title: "Auto Night Light", category: "IoT Projects", description: "An LDR module on A0: the LED turns on when it gets dark (drag the light level while running).",
    files: files(`
// Auto night light: LDR module AO on A0 (higher voltage = darker), LED on pin 9
const int THRESHOLD = 600; // ~2.9 V

void setup() { pinMode(9, OUTPUT); Serial.begin(9600); }

void loop() {
  int dark = analogRead(A0);
  bool on = dark > THRESHOLD;
  digitalWrite(9, on);
  Serial.print("light level "); Serial.print(dark); Serial.println(on ? "  -> lamp ON" : "  -> lamp off");
  delay(400);
}`),
    diagram: dia(uno(part("photoresistor-sensor", "ldr1", 180, 250, { lux: "5" }), part("led", "led1", 165, -130, { color: "yellow" }), part("resistor", "r1", 175, -55, { value: "220" }, 90)), [
      w("ldr1:VCC", "uno:5V", "red"), w("ldr1:GND", "uno:GND.2", "black"), w("ldr1:AO", "uno:A0", "green"),
      w("uno:9", "r1:2", "orange"), w("r1:1", "led1:A", "orange"), w("led1:C", "uno:GND.1", "black"),
    ]),
  },
  {
    id: "iot-parking", title: "Parking Sensor", category: "IoT Projects", description: "HC-SR04 distance → green / yellow / red LEDs and a beeper that speeds up as you get closer.",
    files: files(`
const int TRIG = 3, ECHO = 2, GREEN = 11, YELLOW = 10, RED = 9, BUZZER = 8;

long distanceCm() {
  digitalWrite(TRIG, LOW); delayMicroseconds(2);
  digitalWrite(TRIG, HIGH); delayMicroseconds(10);
  digitalWrite(TRIG, LOW);
  return pulseIn(ECHO, HIGH, 30000) / 58;
}

void setup() {
  pinMode(TRIG, OUTPUT); pinMode(ECHO, INPUT);
  pinMode(GREEN, OUTPUT); pinMode(YELLOW, OUTPUT); pinMode(RED, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  long d = distanceCm();
  digitalWrite(GREEN, d > 50);
  digitalWrite(YELLOW, d > 20 && d <= 50);
  digitalWrite(RED, d <= 20);
  Serial.print(d); Serial.println(" cm");
  if (d <= 50) { tone(BUZZER, 1500, 60); delay(d * 8); } else delay(200);
}`),
    diagram: dia(uno(part("hc-sr04", "sonar1", 175, -175, { distance: "35" }), part("led", "g1", 60, -120, { color: "green" }), part("led", "y1", 95, -120, { color: "yellow" }), part("led", "r1", 130, -120, { color: "red" }),
      part("resistor", "rg", 50, -55, { value: "220" }, 90), part("resistor", "ry", 85, -55, { value: "220" }, 90), part("resistor", "rr", 120, -55, { value: "220" }, 90), part("buzzer", "bz1", 300, 250)), [
      w("sonar1:VCC", "uno:5V", "red"), w("sonar1:GND", "uno:GND.1", "black"), w("sonar1:TRIG", "uno:3", "green"), w("sonar1:ECHO", "uno:2", "blue"),
      w("uno:11", "rg:2", "green"), w("rg:1", "g1:A", "green"), w("uno:10", "ry:2", "yellow"), w("ry:1", "y1:A", "yellow"), w("uno:9", "rr:2", "red"), w("rr:1", "r1:A", "red"),
      w("g1:C", "uno:GND.1", "black"), w("y1:C", "uno:GND.1", "black"), w("r1:C", "uno:GND.1", "black"),
      w("bz1:2", "uno:8", "orange"), w("bz1:1", "uno:GND.2", "black"),
    ]),
  },
  {
    id: "iot-intruder", title: "PIR Intruder Alarm", category: "IoT Projects", description: "A PIR sensor triggers a siren and a flashing LED; click the PIR while running to make 'motion'.",
    files: files(`
const int PIR = 2, LED = 13, BUZZER = 8;

void setup() { pinMode(PIR, INPUT); pinMode(LED, OUTPUT); Serial.begin(9600); Serial.println("Armed"); }

void loop() {
  if (digitalRead(PIR)) {
    Serial.println("MOTION! alarm");
    for (int i = 0; i < 4; i++) {
      digitalWrite(LED, HIGH); tone(BUZZER, 2000); delay(120);
      digitalWrite(LED, LOW);  tone(BUZZER, 1200); delay(120);
    }
    noTone(BUZZER);
  }
  delay(50);
}`),
    diagram: dia(uno(part("pir-motion-sensor", "pir1", 200, -140), part("buzzer", "bz1", 100, -130)), [
      w("pir1:VCC", "uno:5V", "red"), w("pir1:GND", "uno:GND.1", "black"), w("pir1:OUT", "uno:2", "green"),
      w("bz1:2", "uno:8", "orange"), w("bz1:1", "uno:GND.1", "black"),
    ]),
  },
  {
    id: "iot-thermostat", title: "Thermostat with Relay LED", category: "IoT Projects", description: "NTC temperature with hysteresis: the 'heater' LED switches on below 20 °C and off above 22 °C; the LCD shows both.",
    files: files(`
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
LiquidCrystal_I2C lcd(0x27, 16, 2);
const float BETA = 3950;
bool heating = false;

float readC() {
  int a = analogRead(A0);
  return 1 / (log(1 / (1023.0 / a - 1)) / BETA + 1.0 / 298.15) - 273.15;
}

void setup() { pinMode(7, OUTPUT); lcd.init(); lcd.backlight(); Serial.begin(9600); }

void loop() {
  float t = readC();
  if (t < 20) heating = true;
  if (t > 22) heating = false;
  digitalWrite(7, heating);
  lcd.setCursor(0, 0); lcd.print("Temp "); lcd.print(t, 1); lcd.print((char)223); lcd.print("C   ");
  lcd.setCursor(0, 1); lcd.print(heating ? "Heater: ON " : "Heater: off");
  Serial.print(t, 1); Serial.println(heating ? " C heating" : " C idle");
  delay(500);
}`, ["LiquidCrystal I2C"]),
    diagram: dia(uno(part("ntc-temperature-sensor", "ntc1", 130, 250, { temperature: "18" }), part("lcd1602", "lcd1", 320, -20, { pins: "i2c" }), part("led", "heat", 185, -130, { color: "red" }), part("resistor", "rh", 195, -55, { value: "220" }, 90)), [
      w("ntc1:GND", "uno:GND.2", "black"), w("ntc1:VCC", "uno:5V", "red"), w("ntc1:OUT", "uno:A0", "green"),
      w("lcd1:GND", "uno:GND.3", "black"), w("lcd1:VCC", "uno:5V", "red"), w("lcd1:SDA", "uno:A4", "blue"), w("lcd1:SCL", "uno:A5", "yellow"),
      w("uno:7", "rh:2", "orange"), w("rh:1", "heat:A", "orange"), w("heat:C", "uno:GND.1", "black"),
    ]),
  },
  {
    id: "iot-weather", title: "Weather Station (DHT22 + OLED)", category: "IoT Projects", description: "Temperature and humidity from a DHT22 drawn on an SSD1306 OLED, refreshed every two seconds.",
    files: files(`
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <DHT.h>
Adafruit_SSD1306 oled(128, 64, &Wire, -1);
DHT dht(2, DHT22);

void setup() {
  Serial.begin(9600);
  dht.begin();
  oled.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  oled.setTextColor(SSD1306_WHITE);
}

void loop() {
  float t = dht.readTemperature(), h = dht.readHumidity();
  oled.clearDisplay();
  oled.setTextSize(1); oled.setCursor(0, 0); oled.println("Weather station");
  oled.setTextSize(2); oled.setCursor(0, 18); oled.print(t, 1); oled.println(" C");
  oled.setCursor(0, 42); oled.print(h, 0); oled.println(" %");
  oled.display();
  Serial.print(t, 1); Serial.print(" C  "); Serial.print(h, 0); Serial.println(" %");
  delay(2000);
}`, ["Adafruit SSD1306", "Adafruit GFX Library", "DHT sensor library", "Adafruit Unified Sensor"]),
    diagram: dia(uno(part("dht22", "dht1", 225, -140, { temperature: "27.5", humidity: "61" }), part("ssd1306", "oled1", 320, 0)), [
      w("dht1:VCC", "uno:5V", "red"), w("dht1:GND", "uno:GND.1", "black"), w("dht1:SDA", "uno:2", "green"),
      w("oled1:GND", "uno:GND.2", "black"), w("oled1:VIN", "uno:5V", "red"), w("oled1:DATA", "uno:A4", "blue"), w("oled1:CLK", "uno:A5", "yellow"),
    ]),
  },
  {
    id: "iot-joystick-servo", title: "Joystick-Controlled Servo", category: "IoT Projects", description: "The joystick's X axis sets a servo angle; pressing the stick centres it.",
    files: files(`
#include <Servo.h>
Servo s;

void setup() { s.attach(9); pinMode(2, INPUT_PULLUP); Serial.begin(9600); }

void loop() {
  int angle = digitalRead(2) == LOW ? 90 : map(analogRead(A0), 0, 1023, 0, 180);
  s.write(angle);
  Serial.println(angle);
  delay(40);
}`, ["Servo"]),
    diagram: dia(uno(part("analog-joystick", "joy1", 200, 250), part("servo", "servo1", 320, -40)), [
      w("joy1:VCC", "uno:5V", "red"), w("joy1:GND", "uno:GND.2", "black"), w("joy1:HORZ", "uno:A0", "green"), w("joy1:SEL", "uno:2", "blue"),
      w("servo1:PWM", "uno:9", "orange"), w("servo1:V+", "uno:5V", "red"), w("servo1:GND", "uno:GND.3", "black"),
    ]),
  },
  {
    id: "iot-counter", title: "Button Press Counter", category: "IoT Projects", description: "A debounced button counts 0–9 on a 7-segment display and logs each press.",
    files: files(`
const byte DIGITS[10] = { 0x3F, 0x06, 0x5B, 0x4F, 0x66, 0x6D, 0x7D, 0x07, 0x7F, 0x6F };
int count = 0;
bool last = HIGH;

void show(int d) { for (int s = 0; s < 7; s++) digitalWrite(3 + s, (DIGITS[d] >> s) & 1); }

void setup() {
  for (int p = 3; p <= 9; p++) pinMode(p, OUTPUT);
  pinMode(2, INPUT_PULLUP);
  Serial.begin(9600);
  show(0);
}

void loop() {
  bool now = digitalRead(2);
  if (last == HIGH && now == LOW) { count = (count + 1) % 10; show(count); Serial.print("presses: "); Serial.println(count); delay(30); }
  last = now;
}`),
    diagram: dia(uno(part("7segment", "seg1", 215, -170, { common: "cathode", digits: "1" }), part("pushbutton", "btn1", 280, 250),
      ...["a", "b", "c", "d", "e", "f", "g"].map((_, i) => part("resistor", `rs${i + 1}`, 130 + i * 18, -60, { value: "220" }, 90))), [
      ...["A", "B", "C", "D", "E", "F", "G"].flatMap((sg, i) => [w(`uno:${3 + i}`, `rs${i + 1}:2`, "green"), w(`rs${i + 1}:1`, `seg1:${sg}`, "green")]),
      w("seg1:COM.1", "uno:GND.1", "black"), w("btn1:1.l", "uno:2", "blue"), w("btn1:2.l", "uno:GND.2", "black"),
    ]),
  },
  {
    id: "iot-reaction", title: "Reaction Timer Game", category: "IoT Projects", description: "Wait for the LED, then press as fast as you can — your reaction time in ms on Serial and the LCD.",
    files: files(`
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
LiquidCrystal_I2C lcd(0x27, 16, 2);

void setup() {
  pinMode(13, OUTPUT); pinMode(2, INPUT_PULLUP);
  lcd.init(); lcd.backlight();
  Serial.begin(9600);
  randomSeed(analogRead(A1));
}

void loop() {
  lcd.clear(); lcd.print("Get ready...");
  digitalWrite(13, LOW);
  delay(1000 + random(2000));
  digitalWrite(13, HIGH);
  unsigned long t0 = millis();
  while (digitalRead(2) == HIGH && millis() - t0 < 5000) {}
  unsigned long ms = millis() - t0;
  lcd.clear(); lcd.print("Reaction:"); lcd.setCursor(0, 1); lcd.print(ms); lcd.print(" ms");
  Serial.print("reaction "); Serial.print(ms); Serial.println(" ms");
  delay(2000);
}`, ["LiquidCrystal I2C"]),
    diagram: dia(uno(part("pushbutton", "btn1", 280, 250, { color: "red" }), part("lcd1602", "lcd1", 320, -20, { pins: "i2c" })), [
      w("btn1:1.l", "uno:2", "blue"), w("btn1:2.l", "uno:GND.2", "black"),
      w("lcd1:GND", "uno:GND.3", "black"), w("lcd1:VCC", "uno:5V", "red"), w("lcd1:SDA", "uno:A4", "blue"), w("lcd1:SCL", "uno:A5", "yellow"),
    ]),
  },
  {
    id: "iot-plant", title: "Plant Moisture Monitor", category: "IoT Projects", description: "A moisture probe (a slide pot here) colours an RGB LED: red = dry, green = fine, blue = too wet.",
    files: files(`
void color(int r, int g, int b) { analogWrite(9, r); analogWrite(10, g); analogWrite(11, b); }

void setup() { Serial.begin(9600); }

void loop() {
  int m = map(analogRead(A0), 0, 1023, 0, 100); // % moisture
  if (m < 30) color(255, 0, 0); else if (m < 70) color(0, 255, 0); else color(0, 0, 255);
  Serial.print("moisture "); Serial.print(m); Serial.println(m < 30 ? " %  water me!" : m < 70 ? " %  ok" : " %  too wet");
  delay(500);
}`),
    diagram: dia(uno(part("slide-potentiometer", "soil1", 150, 260, { travelLength: "30", value: "20" }), part("rgb-led", "rgb1", 150, -150, { common: "cathode" }),
      part("resistor", "r1", 120, -70, { value: "220" }, 90), part("resistor", "r2", 150, -70, { value: "220" }, 90), part("resistor", "r3", 180, -70, { value: "220" }, 90)), [
      w("soil1:VCC", "uno:5V", "red"), w("soil1:GND", "uno:GND.2", "black"), w("soil1:SIG", "uno:A0", "green"),
      w("uno:9", "r1:2", "red"), w("r1:1", "rgb1:R", "red"), w("uno:10", "r2:2", "green"), w("r2:1", "rgb1:G", "green"), w("uno:11", "r3:2", "blue"), w("r3:1", "rgb1:B", "blue"), w("rgb1:COM", "uno:GND.1", "black"),
    ]),
  },
  {
    id: "iot-dice", title: "Electronic Dice", category: "IoT Projects", description: "Press to roll: the 7-segment spins, slows down and stops on 1–6.",
    files: files(`
const byte DIGITS[10] = { 0x3F, 0x06, 0x5B, 0x4F, 0x66, 0x6D, 0x7D, 0x07, 0x7F, 0x6F };
void show(int d) { for (int s = 0; s < 7; s++) digitalWrite(3 + s, (DIGITS[d] >> s) & 1); }

void setup() {
  for (int p = 3; p <= 9; p++) pinMode(p, OUTPUT);
  pinMode(2, INPUT_PULLUP);
  Serial.begin(9600);
  randomSeed(analogRead(A1));
  show(0);
}

void loop() {
  if (digitalRead(2) == LOW) {
    int v = 1;
    for (int i = 0; i < 12; i++) { v = random(1, 7); show(v); delay(30 + i * 15); }
    Serial.print("rolled "); Serial.println(v);
    while (digitalRead(2) == LOW) {}
  }
}`),
    diagram: dia(uno(part("7segment", "seg1", 215, -170, { common: "cathode", digits: "1", color: "#ff3b30" }), part("pushbutton", "btn1", 280, 250, { color: "yellow" }),
      ...["a", "b", "c", "d", "e", "f", "g"].map((_, i) => part("resistor", `rs${i + 1}`, 130 + i * 18, -60, { value: "220" }, 90))), [
      ...["A", "B", "C", "D", "E", "F", "G"].flatMap((sg, i) => [w(`uno:${3 + i}`, `rs${i + 1}:2`, "green"), w(`rs${i + 1}:1`, `seg1:${sg}`, "green")]),
      w("seg1:COM.1", "uno:GND.1", "black"), w("btn1:1.l", "uno:2", "blue"), w("btn1:2.l", "uno:GND.2", "black"),
    ]),
  },

  // ── Raspberry Pi Pico (RP2040, 3.3 V) ──
  {
    id: "pico-blink", title: "Pico Blink", category: "Raspberry Pi Pico", description: "The Pico's green LED (GP25) and an LED on GP15 blink; USB Serial prints the state.",
    files: files(`
// Raspberry Pi Pico: LED_BUILTIN is GP25; an external LED on GP15 through 330 Ω
void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  pinMode(15, OUTPUT);
  Serial.begin(115200);
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  digitalWrite(15, LOW);
  Serial.println("LED on");
  delay(500);
  digitalWrite(LED_BUILTIN, LOW);
  digitalWrite(15, HIGH);
  Serial.println("LED off");
  delay(500);
}`),
    diagram: dia([part("pi-pico", "pico", 0, 0), part("led", "led1", -110, 130, { color: "red" }), part("resistor", "r1", -70, 183, { value: "330" })], [
      w("pico:GP15", "r1:2", "green"), w("r1:1", "led1:A", "green"), w("led1:C", "pico:GND.4", "black"),
    ]),
  },
  {
    id: "pico-button", title: "Pico Button and LED", category: "Raspberry Pi Pico", description: "A button on GP14 (INPUT_PULLUP) switches an LED on GP15.",
    files: files(`
void setup() {
  pinMode(14, INPUT_PULLUP);
  pinMode(15, OUTPUT);
  Serial.begin(115200);
}

void loop() {
  bool pressed = digitalRead(14) == LOW;
  digitalWrite(15, pressed);
  static bool was = false;
  if (pressed != was) { Serial.println(pressed ? "pressed" : "released"); was = pressed; }
  delay(5);
}`),
    diagram: dia([part("pi-pico", "pico", 0, 0), part("pushbutton", "btn1", -150, 120, { color: "blue" }), part("led", "led1", -110, 195, { color: "green" }), part("resistor", "r1", -70, 243, { value: "330" })], [
      w("pico:GP14", "btn1:2.r", "blue"), w("btn1:1.l", "pico:GND.3", "black"),
      w("pico:GP15", "r1:2", "green"), w("r1:1", "led1:A", "green"), w("led1:C", "pico:GND.4", "black"),
    ]),
  },
  {
    id: "pico-adc", title: "Pico Potentiometer (ADC)", category: "Raspberry Pi Pico", description: "A pot on GP26 (ADC0) sets the brightness of an LED on GP16 with PWM.",
    files: files(`
void setup() {
  Serial.begin(115200);
  analogReadResolution(12);
  pinMode(16, OUTPUT);
}

void loop() {
  int raw = analogRead(26);            // 0..4095 for 0..3.3 V
  analogWrite(16, raw / 16);           // 0..255
  Serial.print("ADC0 = ");
  Serial.print(raw);
  Serial.print("  (");
  Serial.print(raw * 3.3 / 4095, 2);
  Serial.println(" V)");
  delay(200);
}`),
    diagram: dia([part("pi-pico", "pico", 0, 0), part("potentiometer", "pot1", 130, 60, { value: "700" }), part("led", "led1", 130, 170, { color: "yellow" }), part("resistor", "r1", 105, 200, { value: "330" }, 90)], [
      w("pot1:SIG", "pico:GP26", "green"), w("pot1:VCC", "pico:3V3", "red"), w("pot1:GND", "pico:AGND", "black"),
      w("pico:GP16", "r1:1", "orange"), w("r1:2", "led1:A", "orange"), w("led1:C", "pico:GND.5", "black"),
    ]),
  },
  {
    id: "pico-lcd", title: "Pico LCD 16×2 (I²C)", category: "Raspberry Pi Pico", description: "Wire on GP4 (SDA) / GP5 (SCL) drives an I²C LCD at 0x27.",
    files: files(`
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
LiquidCrystal_I2C lcd(0x27, 16, 2);

void setup() {
  Wire.setSDA(4);
  Wire.setSCL(5);
  Wire.begin();
  lcd.init();
  lcd.backlight();
  lcd.print("Hello from Pico");
}

void loop() {
  lcd.setCursor(0, 1);
  lcd.print("t = ");
  lcd.print(millis() / 1000);
  lcd.print(" s   ");
  delay(250);
}`, ["LiquidCrystal I2C"]),
    diagram: dia([part("pi-pico", "pico", 0, 0), part("lcd1602", "lcd1", -330, -20, { pins: "i2c" })], [
      w("lcd1:SDA", "pico:GP4", "blue"), w("lcd1:SCL", "pico:GP5", "yellow"), w("lcd1:VCC", "pico:VBUS", "red"), w("lcd1:GND", "pico:GND.1", "black"),
    ]),
  },
  {
    id: "pico-neopixel", title: "Pico NeoPixel (PIO)", category: "Raspberry Pi Pico", description: "Adafruit_NeoPixel drives a WS2812 from the RP2040's PIO state machine on GP2.",
    files: files(`
#include <Adafruit_NeoPixel.h>
Adafruit_NeoPixel pixel(1, 2, NEO_GRB + NEO_KHZ800);

void setup() { pixel.begin(); }

void loop() {
  for (long hue = 0; hue < 65536; hue += 4096) {
    pixel.setPixelColor(0, pixel.ColorHSV(hue));
    pixel.show();
    delay(60);
  }
}`, ["Adafruit NeoPixel"]),
    diagram: dia([part("pi-pico", "pico", 0, 0), part("neopixel", "px1", -90, 20)], [w("px1:DIN", "pico:GP2", "green"), w("px1:VDD", "pico:VBUS", "red"), w("px1:VSS", "pico:GND.1", "black")]),
  },
  // ── ESP32 (Espressif QEMU) ──
  {
    id: "esp32-blink", title: "ESP32 Blink", category: "ESP32", description: "The DevKit's blue LED (GPIO2) and an LED on GPIO4 blink; Serial prints at 115200.",
    files: files(`
// ESP32 DevKit V1: the blue LED is on GPIO2
void setup() {
  pinMode(2, OUTPUT);
  pinMode(4, OUTPUT);
  Serial.begin(115200);
  Serial.println("ESP32 ready");
}

void loop() {
  digitalWrite(2, HIGH); digitalWrite(4, LOW);
  Serial.println("on");
  delay(500);
  digitalWrite(2, LOW); digitalWrite(4, HIGH);
  Serial.println("off");
  delay(500);
}`),
    diagram: dia([part("esp32-devkit-v1", "esp", 0, 0), part("led", "led1", 150, 40, { color: "green" }), part("resistor", "r1", 130, 95, { value: "220" })], [
      w("esp:D4", "r1:1", "green"), w("r1:2", "led1:A", "green"), w("led1:C", "esp:GND.1", "black"),
    ]),
  },
  {
    id: "esp32-pot", title: "ESP32 Potentiometer (ADC)", category: "ESP32", description: "analogRead on GPIO34 (12-bit, 3.3 V) and analogWrite dimming an LED on GPIO4.",
    files: files(`
void setup() { Serial.begin(115200); pinMode(4, OUTPUT); }

void loop() {
  int raw = analogRead(34);            // 0..4095
  analogWrite(4, raw / 16);            // PWM 0..255 (LEDC)
  Serial.printf("GPIO34 = %d (%.2f V)\\n", raw, raw * 3.3 / 4095);
  delay(300);
}`),
    diagram: dia([part("esp32-devkit-v1", "esp", 0, 0), part("potentiometer", "pot1", -150, 40, { value: "600" }), part("led", "led1", 150, 40, { color: "yellow" }), part("resistor", "r1", 130, 95, { value: "220" })], [
      w("pot1:SIG", "esp:D34", "green"), w("pot1:VCC", "esp:3V3", "red"), w("pot1:GND", "esp:GND.2", "black"),
      w("esp:D4", "r1:1", "orange"), w("r1:2", "led1:A", "orange"), w("led1:C", "esp:GND.1", "black"),
    ]),
  },
  {
    id: "esp32-button", title: "ESP32 Button", category: "ESP32", description: "A button on GPIO15 (INPUT_PULLUP) switches the blue LED.",
    files: files(`
void setup() { pinMode(15, INPUT_PULLUP); pinMode(2, OUTPUT); Serial.begin(115200); }

void loop() {
  bool pressed = digitalRead(15) == LOW;
  digitalWrite(2, pressed);
  static bool was = false;
  if (pressed != was) { Serial.println(pressed ? "pressed" : "released"); was = pressed; }
  delay(10);
}`),
    diagram: dia([part("esp32-devkit-v1", "esp", 0, 0), part("pushbutton", "btn1", 150, 100, { color: "red" })], [
      w("esp:D15", "btn1:1.l", "blue"), w("btn1:2.l", "esp:GND.1", "black"),
    ]),
  },
]

/** A new sketch on one board: an Arduino sketch, or a Python program on a Linux board (Raspberry Pi). */
export const blankSketch = (boardType = "wokwi-arduino-uno"): { files: SketchFileData[]; diagram: Diagram } => ({
  files: isLinuxBoard(boardByType(boardType)) ? blankFiles("", true) : files(`
void setup() {
  // put your setup code here, to run once:
  Serial.begin(9600);
}

void loop() {
  // put your main code here, to run repeatedly:
}`),
  diagram: dia([{ type: boardType, id: boardId(boardType), left: 0, top: 0, attrs: {} }], []),
})
