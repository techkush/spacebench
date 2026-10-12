import { describe, expect, it } from "vitest"
import { badgeFor, findConstants, findSpots, resolvePin } from "./live-code"
import type { LivePin } from "./sim"

const SKETCH = `#define BTN 2
const int ledPin = 9; // the LED
int pot = A0;
void setup() {
  pinMode(ledPin, OUTPUT);
  pinMode(BTN, INPUT_PULLUP);
  Serial.begin(9600);
}
void loop() {
  int v = analogRead(pot);
  analogWrite(ledPin, v / 4);
  if (digitalRead(BTN) == LOW) digitalWrite(LED_BUILTIN, HIGH);
  // digitalWrite(7, HIGH);
  Serial.print("pot = ");
  Serial.println(v);
}`
const pin = (o: Partial<LivePin>): LivePin => ({ mode: "out", v: 0, level: 0, duty: 0, toggles: 0, ...o })
const UNO = ["0", "1", "2", "9", "13", "A0"]

describe("live code view", () => {
  const spots = findSpots(SKETCH), consts = findConstants(SKETCH)
  it("finds the lines that use pins, not the commented ones", () => {
    expect(spots.map((s) => [s.line, s.kind])).toEqual([[5, "mode"], [6, "mode"], [9, "loop"], [10, "aread"], [11, "awrite"], [12, "dread"], [15, "serial"]])
  })
  it("resolves constants, #defines, A0 and LED_BUILTIN", () => {
    expect(resolvePin("ledPin", consts, UNO, "13")).toBe("9")
    expect(resolvePin("BTN", consts, UNO, "13")).toBe("2")
    expect(resolvePin("pot", consts, UNO, "13")).toBe("A0")
    expect(resolvePin("LED_BUILTIN", consts, UNO, "13")).toBe("13")
    expect(resolvePin("25", consts, ["GP25"], "GP25")).toBe("GP25")
    expect(resolvePin("A1", consts, ["GP27"], "GP25")).toBe("GP27")
    expect(resolvePin("nope", consts, UNO, "13")).toBeNull()
  })
  it("words the badges", () => {
    const ctx = { vcc: 5, seconds: 1.5, serial: "pot = 511\r\npot = 512\r\n" }
    const live = { "9": pin({ duty: 0.5, toggles: 40, v: 5, level: 1 }), "2": pin({ mode: "pullup", v: 5, level: 1 }), A0: pin({ mode: "in", v: 2.5, level: 1 }) }
    const by = (line: number) => { const s = spots.find((x) => x.line === line)!; return badgeFor(s, s.arg ? resolvePin(s.arg, consts, UNO, "13") : null, live, ctx) }
    expect(by(11)).toMatchObject({ tone: "pwm", text: expect.stringContaining("D9 PWM 50%") })
    expect(by(10)).toMatchObject({ tone: "analog", text: expect.stringContaining("A0 2.50 V") })
    expect(by(10)!.text).toBe("→ A0 2.50 V · 512")
    expect(by(12)).toMatchObject({ tone: "high", text: "→ D2 HIGH" })
    expect(by(6)).toMatchObject({ tone: "mode", text: "D2 INPUT_PULLUP" })
    expect(by(15)).toMatchObject({ tone: "serial", text: "» pot = 512" })
    expect(by(9)!.text).toContain("1.5 s")
    // the write that set the pin is bright, the other one faded
    const hi = findSpots("digitalWrite(13, HIGH);\ndigitalWrite(13, LOW);\nSerial.println(\"ready\");")
    expect(hi.map((x) => x.value)).toEqual([1, 0, undefined])
    const now = { "13": pin({ level: 1, v: 5, duty: 1 }) }
    expect(badgeFor(hi[0], "13", now, ctx)!.dim).toBeFalsy()
    expect(badgeFor(hi[1], "13", now, ctx)!.dim).toBe(true)
    // a println of a literal shows only output with that text
    expect(badgeFor(hi[2], null, now, ctx)).toBeNull()
    expect(badgeFor(hi[2], null, now, { ...ctx, serial: "ready\nx = 1\n" })).toMatchObject({ text: "» ready", dim: true })
    expect(badgeFor({ line: 1, kind: "dread", arg: "3" }, "3", { "3": pin({ mode: "in", level: 2 }) }, ctx)).toMatchObject({ tone: "float" })
  })
})
