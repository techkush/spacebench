// Starter programs for "New from code" and the Learn Kirk page. Every snippet
// compiles (kirk/snippets.test.ts) and simulates.

export interface Snippet { id: string; title: string; summary: string; teaches: string[]; code: string }

export const NEW_FROM_CODE = `// New circuit — write Kirk, the schematic draws itself.
// Parts:   R1 = R(1k)   C1 = C(100n)   V1 = Vdc(5 V)   Q1 = NPN("2N3904")
// Wiring:  a -- R1 -- b   (a chain, pin 1 on the left)    R1.2 -- out   (one pin)
circuit MyCircuit {
    ground GND
    V1 = Vdc(5 V)
    R1 = R(1k)
    R2 = R(1k)
    IN -- V1 -- GND
    IN -- R1 -- OUT -- R2 -- GND
}
simulate op
`

export const SNIPPETS: Snippet[] = [
  {
    id: "divider", title: "Voltage divider", summary: "Two resistors halve a 5 V supply.",
    teaches: ["parts", "chains", "ground", "simulate op"],
    code: `circuit Divider {
    ground GND
    V1 = Vdc(5 V)
    R1 = R(10k)
    R2 = R(10k)
    IN -- V1 -- GND
    IN -- R1 -- MID -- R2 -- GND
}
simulate op
measure vmid = V(MID)
assert vmid in 2.4 V .. 2.6 V
`,
  },
  {
    id: "rc", title: "RC low-pass + Bode", summary: "A first-order filter, its corner frequency measured from the AC sweep.",
    teaches: ["AC sources", "simulate ac", "measure", "assert"],
    code: `circuit RcLowPass {
    ground GND
    V1 = Vsin(amp: 1 V, freq: 1 kHz, ac: 1 V)
    R1 = R(1.6k)
    C1 = C(100n)
    IN -- V1 -- GND
    IN -- R1 -- OUT -- C1 -- GND
}
simulate ac(from: 10 Hz, to: 100 kHz, points: 40/dec)
measure fc = fc(V(OUT))
assert fc in 900 Hz .. 1.1 kHz
`,
  },
  {
    id: "led", title: "LED with a series resistor", summary: "Pick the resistor for 15 mA and check the current.",
    teaches: ["diodes", "pin names", "current probes"],
    code: `circuit LedDriver {
    ground GND
    V1 = Vdc(5 V)
    R1 = R(220)
    D1 = LED(red)
    VCC -- V1 -- GND
    VCC -- R1 -- A -- D1' -- GND
}
simulate op
measure id = I(R1)
`,
  },
  {
    id: "blinker", title: "555 blinker", summary: "An astable 555 driving an LED; frequency measured from the transient.",
    teaches: ["ICs by name", "pin names (U1.TRIG)", "simulate tran", "frequency()"],
    code: `circuit Blinker {
    supply VCC = 5 V
    ground GND
    U1 = NE555
    R1 = R(1k)
    R2 = R(10k)
    C1 = C(1 uF)
    R3 = R(330)
    D1 = LED(red)
    VCC -- R1 -- DISCH -- R2 -- TRIG -- C1 -- GND
    U1.OUT -- OUT -- R3 -- LED_A -- D1' -- GND
    U1.VCC, U1.RST -- VCC
    U1.DISCH -- DISCH
    U1.THRES, U1.TRIG -- TRIG
    U1.GND -- GND
    U1.CONT -- nc
}
simulate tran(stop: 60 ms, step: 10 us)
measure f = frequency(V(OUT))
`,
  },
  {
    id: "sweep", title: "Sweep a resistor", summary: "Run the divider for five values of R2 and compare the results.",
    teaches: ["sweep", "result sets"],
    code: `circuit DividerSweep {
    ground GND
    V1 = Vdc(5 V)
    R1 = R(10k)
    R2 = R(10k)
    IN -- V1 -- GND
    IN -- R1 -- MID -- R2 -- GND
}
simulate op
sweep R2.value in [1k, 2.2k, 4.7k, 10k, 22k]
measure vmid = V(MID)
`,
  },
]

/** One-line reminders for the Learn Kirk cheat sheet. */
export const CHEAT_SHEET: [string, string][] = [
  ["R1 = R(10k)", "a part: constructor + value (R C L Pot D LED NPN PNP NMOS Vdc Vsin Vpulse OpAmp NE555 lib(\"Lib:Name\"))"],
  ["a -- R1 -- b", "a chain: R1 between nets a and b (pin 1 on the left)"],
  ["U1.TRIG -- t", "connect one pin, by name or number"],
  ["A -- D1' -- GND", "a part turned round in a chain (D1' puts the anode on A)"],
  ["ground GND · supply VCC = 5 V", "global nets"],
  ["simulate tran(stop: 5 ms, step: 10 us)", "analysis: op · tran · ac(from:, to:, points:) · dc(V1, from:, to:, step:)"],
  ["measure f = frequency(V(OUT))", "measurements: max min avg rms pp final frequency period duty rise_time fc gain_db"],
  ["assert f in 60 Hz .. 80 Hz", "a spec check, ✓/✗ after every run"],
  ["sweep R2.value in [1k, 10k]", "multi-run: sweep · montecarlo · temp"],
  ["for i in 1..8 { R{i} = R(1k) }", "repeat parts and wiring; names take i, i+1, 2*i"],
  ["parts(R*).footprint = \"…\"", "set a property of a part (R1.MPN = …) or of a selection: parts(R*, value: 10k, on: VCC)"],
  ["check connected(U1.OUT, R3.1)", "a design rule on every compile: connected · parts(C*).footprint · parts(R*).count == 8"],
]
