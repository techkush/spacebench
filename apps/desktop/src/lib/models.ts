// SPICE models for common parts. Device parameters are the widely published
// manufacturer / textbook values; anything not listed falls back to a generic
// model of the right type (the Inspector says so).

const BJT: Record<string, string> = {
  "2N3904": "NPN(IS=6.734f XTI=3 EG=1.11 VAF=74.03 BF=416.4 NE=1.259 ISE=6.734f IKF=66.78m XTB=1.5 BR=.7371 NC=2 ISC=0 IKR=0 RC=1 CJC=3.638p MJC=.3085 VJC=.75 FC=.5 CJE=4.493p MJE=.2593 VJE=.75 TR=239.5n TF=301.2p ITF=.4 VTF=4 XTF=2 RB=10)",
  "2N3906": "PNP(IS=1.41f XTI=3 EG=1.11 VAF=18.7 BF=180.7 NE=1.5 ISE=0 IKF=80m XTB=1.5 BR=4.977 NC=2 ISC=0 IKR=0 RC=2.5 CJC=9.728p MJC=.5776 VJC=.75 FC=.5 CJE=8.063p MJE=.3677 VJE=.75 TR=33.42n TF=179.3p ITF=.4 VTF=4 XTF=6 RB=10)",
  "2N2222": "NPN(IS=14.34f XTI=3 EG=1.11 VAF=74.03 BF=255.9 NE=1.307 ISE=14.34f IKF=.2847 XTB=1.5 BR=6.092 NC=2 ISC=0 IKR=0 RC=1 CJC=7.306p MJC=.3416 VJC=.75 FC=.5 CJE=22.01p MJE=.377 VJE=.75 TR=46.91n TF=411.1p ITF=.6 VTF=1.7 XTF=3 RB=10)",
  "2N2907": "PNP(IS=650.6E-18 XTI=3 EG=1.11 VAF=115.7 BF=231.7 NE=1.829 ISE=54.81f IKF=1.079 XTB=1.5 BR=3.563 NC=2 ISC=0 IKR=0 RC=.715 CJC=14.76p MJC=.5383 VJC=.75 FC=.5 CJE=19.82p MJE=.3357 VJE=.75 TR=111.3n TF=603.7p ITF=.65 VTF=5 XTF=1.7 RB=10)",
  "2N4401": "NPN(IS=26.03f XTI=3 EG=1.11 VAF=90.7 BF=4.292K NE=1.244 ISE=26.03f IKF=.2061 XTB=1.5 BR=1.01 NC=2 ISC=0 IKR=0 RC=.5 CJC=11.01p MJC=.3763 VJC=.75 FC=.5 CJE=24.07p MJE=.3641 VJE=.75 TR=233.7n TF=466.5p ITF=0 VTF=0 XTF=0 RB=10)",
  "2N4403": "PNP(IS=650.6E-18 XTI=3 EG=1.11 VAF=115.7 BF=216.2 NE=1.829 ISE=58.72f IKF=1.079 XTB=1.5 BR=3.578 NC=2 ISC=0 IKR=0 RC=.715 CJC=14.76p MJC=.5383 VJC=.75 FC=.5 CJE=19.82p MJE=.3357 VJE=.75 TR=111.6n TF=603.7p ITF=.65 VTF=5 XTF=1.7 RB=10)",
  BC547: "NPN(IS=2.39E-14 NF=1.008 ISE=3.545E-15 NE=1.541 BF=294.3 IKF=0.1357 VAF=63.2 NR=1.004 ISC=6.272E-14 NC=1.243 BR=7.946 IKR=0.1144 VAR=25.9 RB=1 IRB=1.00E-06 RBM=1 RE=0.4683 RC=0.85 XTB=0 EG=1.11 XTI=3 CJE=1.358E-11 VJE=0.65 MJE=0.3279 TF=4.391E-10 XTF=120 VTF=2.643 ITF=0.7495 PTF=0 CJC=3.728E-12 VJC=0.3997 MJC=0.2955 XCJC=0.6193 TR=1.00E-32 FC=0.9579)",
  BC557: "PNP(IS=3.83E-14 NF=1.008 ISE=1.22E-14 NE=1.528 BF=344.4 IKF=0.08039 VAF=21.11 NR=1.005 ISC=2.85E-13 NC=1.28 BR=14.84 IKR=0.047 VAR=32.02 RB=1 IRB=1.00E-06 RBM=1 RE=0.6202 RC=0.5713 XTB=0 EG=1.11 XTI=3 CJE=1.23E-11 VJE=0.6106 MJE=0.378 TF=5.60E-10 XTF=3.414 VTF=5.23 ITF=0.1483 PTF=0 CJC=1.08E-11 VJC=0.1022 MJC=0.3563 XCJC=0.6288 TR=1.00E-32 FC=0.8027)",
  BD139: "NPN(IS=1e-13 BF=160 VAF=100 IKF=1.5 RB=2 RE=0.05 RC=0.1 CJE=150p CJC=40p TF=15n BR=5)",
  BD140: "PNP(IS=1e-13 BF=160 VAF=100 IKF=1.5 RB=2 RE=0.05 RC=0.1 CJE=150p CJC=60p TF=15n BR=5)",
  TIP31: "NPN(IS=1e-12 BF=60 VAF=100 IKF=3 RB=1 RE=0.03 RC=0.05 CJE=300p CJC=100p TF=20n BR=5)",
  TIP32: "PNP(IS=1e-12 BF=60 VAF=100 IKF=3 RB=1 RE=0.03 RC=0.05 CJE=300p CJC=150p TF=20n BR=5)",
}
const BJT_ALIAS: [RegExp, string][] = [
  [/^2N2222/, "2N2222"], [/^(PN|MMBT)2222/, "2N2222"], [/^2N2907/, "2N2907"], [/^MMBT3904/, "2N3904"], [/^MMBT3906/, "2N3906"],
  [/^BC54[678]/, "BC547"], [/^BC84[678]/, "BC547"], [/^BC33[78]/, "BC547"], [/^BC55[789]/, "BC557"], [/^BC85[678]/, "BC557"], [/^BC32[78]/, "BC557"],
  [/^BD13[579]/, "BD139"], [/^BD1[34][02468]/, "BD140"], [/^TIP3[13]/, "TIP31"], [/^TIP3[24]/, "TIP32"],
]

const MOS: Record<string, string> = {
  "2N7000": "VDMOS(Rg=3 Vto=1.6 Rd=0.6 Rs=0.75 Rb=3.5 Kp=0.32 Cgdmax=67p Cgdmin=12p Cgs=50p Cjo=50p Is=5p mtriode=1.6)",
  BS170: "VDMOS(Rg=3 Vto=1.8 Rd=0.5 Rs=0.5 Rb=3 Kp=0.35 Cgdmax=60p Cgdmin=10p Cgs=40p Cjo=40p Is=5p mtriode=1.6)",
  BSS138: "VDMOS(Rg=3 Vto=1.3 Rd=0.4 Rs=0.3 Rb=1 Kp=0.6 Cgdmax=10p Cgdmin=2p Cgs=27p Cjo=15p Is=1p)",
  IRF540N: "VDMOS(Rg=3 Vto=3.5 Rd=12m Rs=10m Rb=8m Kp=30 lambda=0.01 Cgdmax=1.5n Cgdmin=100p Cgs=1.6n Cjo=900p Is=10p)",
  IRFZ44N: "VDMOS(Rg=3 Vto=3.2 Rd=8m Rs=6m Rb=6m Kp=40 lambda=0.01 Cgdmax=1.4n Cgdmin=100p Cgs=1.5n Cjo=800p Is=10p)",
  IRLZ44N: "VDMOS(Rg=3 Vto=1.7 Rd=10m Rs=6m Rb=6m Kp=60 lambda=0.01 Cgdmax=1.4n Cgdmin=100p Cgs=1.6n Cjo=800p Is=10p)",
  IRF9540: "VDMOS(pchan Rg=3 Vto=-3.5 Rd=60m Rs=20m Rb=20m Kp=10 lambda=0.01 Cgdmax=1n Cgdmin=100p Cgs=1.2n Cjo=800p Is=10p)",
  IRF9Z34N: "VDMOS(pchan Rg=3 Vto=-3 Rd=60m Rs=20m Rb=20m Kp=12 lambda=0.01 Cgdmax=800p Cgdmin=80p Cgs=600p Cjo=500p Is=10p)",
  BSS84: "VDMOS(pchan Rg=3 Vto=-1.6 Rd=2 Rs=1 Rb=1 Kp=0.2 Cgdmax=10p Cgdmin=3p Cgs=20p Cjo=15p Is=1p)",
}
const MOS_ALIAS: [RegExp, string][] = [[/^IRF540/, "IRF540N"], [/^IRFZ44/, "IRFZ44N"], [/^IRLZ44/, "IRLZ44N"], [/^IRF954/, "IRF9540"], [/^2N7002/, "2N7000"]]

const JFET: Record<string, string> = {
  "2N3819": "NJF(Beta=1.304m Betatce=-.5 Rd=1 Rs=1 Lambda=2.25m Vto=-3 Vtotc=-2.5m Is=33.57f Isr=322.4f N=1 Nr=2 Xti=3 Alpha=311.7u Vk=243.6 Cgd=1.6p M=.3622 Pb=1 Fc=.5 Cgs=2.414p)",
  J201: "NJF(Beta=1.304m Rd=1 Rs=1 Lambda=2.25m Vto=-0.8 Is=33.57f Cgd=1.6p Cgs=2.414p)",
  "2N5457": "NJF(Beta=1.125m Rd=1 Rs=1 Lambda=2.3m Vto=-1.372 Is=33.57f Cgd=2.3p Cgs=2.3p)",
  J175: "PJF(Beta=1.5m Rd=1 Rs=1 Lambda=10m Vto=-3.5 Is=33f Cgd=10p Cgs=10p)",
}

const DIODE: Record<string, string> = {
  "1N4148": "D(IS=2.52n RS=0.568 N=1.752 CJO=4p M=0.4 TT=20n BV=100 IBV=100u)",
  "1N5817": "D(IS=31.7u RS=0.051 N=1.373 CJO=110p M=0.35 BV=20 IBV=1m EG=0.69 XTI=2)",
  "1N5818": "D(IS=31.7u RS=0.051 N=1.373 CJO=110p M=0.35 BV=30 IBV=1m EG=0.69 XTI=2)",
  "1N5819": "D(IS=31.7u RS=0.051 N=1.373 CJO=110p M=0.35 BV=40 IBV=1m EG=0.69 XTI=2)",
  BAT54: "D(IS=2u RS=0.9 N=1.03 CJO=10p M=0.33 BV=30 IBV=1u EG=0.69 XTI=2)",
}
const RECT_BV: Record<string, number> = { "1": 50, "2": 100, "3": 200, "4": 400, "5": 600, "6": 800, "7": 1000 }
const rectifier = (bv: number) => `D(IS=14.11n N=1.984 RS=33.89m IKF=94.81 XTI=3 EG=1.11 CJO=25.89p M=.44 VJ=.3245 FC=.5 BV=${bv} IBV=10u TT=5.7u)`
export const GENERIC_DIODE = "D(IS=2.52n RS=0.568 N=1.752 CJO=4p M=0.4 TT=20n)"
export const GENERIC_SCHOTTKY = "D(IS=31.7u RS=0.051 N=1.373 CJO=110p M=0.35 EG=0.69 XTI=2)"
export const zener = (bv: number) => `D(IS=1n RS=5 N=1.5 BV=${bv} IBV=5m CJO=50p)`

/** LED model from a forward voltage at 20 mA (N = 2, small series resistance). */
const ledModel = (vf: number) => `D(IS=${(0.02 / Math.exp((vf - 0.04) / (2 * 0.02585))).toExponential(3)} N=2 RS=2 CJO=20p BV=5 IBV=10u)`
export function ledFor(text: string): { name: string; model: string } {
  const t = text.toLowerCase()
  const [name, vf] = /blue|white|uv|violet|pink/.test(t) ? ["LED_BLUE", 3.1] : /green/.test(t) ? ["LED_GREEN", 2.2] : /yellow|amber|orange/.test(t) ? ["LED_YELLOW", 2.05] : /ir\b|infrared/.test(t) ? ["LED_IR", 1.3] : ["LED_RED", 1.9]
  return { name, model: ledModel(vf as number) }
}

export const GENERIC = {
  NPN: "NPN(IS=1e-14 BF=200 VAF=100 IKF=0.3 RB=10 RC=1 CJE=10p CJC=5p TF=0.3n TR=50n)",
  PNP: "PNP(IS=1e-14 BF=200 VAF=50 IKF=0.3 RB=10 RC=1 CJE=10p CJC=8p TF=0.5n TR=50n)",
  NMOS: "VDMOS(Rg=3 Vto=2 Kp=1 Rd=50m Rs=20m Rb=20m Cgs=500p Cgdmax=300p Cgdmin=50p Cjo=200p Is=1p)",
  PMOS: "VDMOS(pchan Rg=3 Vto=-2 Kp=1 Rd=80m Rs=30m Rb=30m Cgs=500p Cgdmax=300p Cgdmin=50p Cjo=200p Is=1p)",
  NJFET: "NJF(Beta=1m Vto=-2 Lambda=2m Cgd=2p Cgs=2p)",
  PJFET: "PJF(Beta=1m Vto=-2 Lambda=2m Cgd=2p Cgs=2p)",
}

export type ModelKind = keyof typeof GENERIC | "D"

/** Known model text for a part value, or undefined (→ generic). */
export function knownModel(kind: ModelKind, value: string): string | undefined {
  const v = value.trim().toUpperCase().replace(/[-_ ](TO|SOT|SOD|DO)[-_]?\d.*$/i, "")
  if (kind === "NPN" || kind === "PNP") {
    const name = BJT[v] ? v : BJT_ALIAS.find(([re]) => re.test(v))?.[1]
    const m = name ? BJT[name] : undefined
    return m && m.startsWith(kind) ? m : undefined
  }
  if (kind === "NMOS" || kind === "PMOS") {
    const name = MOS[v] ? v : MOS_ALIAS.find(([re]) => re.test(v))?.[1]
    const m = name ? MOS[name] : undefined
    return m && m.includes("pchan") === (kind === "PMOS") ? m : undefined
  }
  if (kind === "NJFET" || kind === "PJFET") {
    const m = JFET[v]
    return m && m.startsWith(kind === "NJFET" ? "NJF" : "PJF") ? m : undefined
  }
  if (DIODE[v]) return DIODE[v]
  if (/^1N914|^1N4148|^LL4148|^CD4148/.test(v)) return DIODE["1N4148"]
  const rect = /^1N400([1-7])/.exec(v)
  if (rect) return rectifier(RECT_BV[rect[1]])
  const sch = /^1N58(1[789])/.exec(v)
  if (sch) return DIODE[`1N58${sch[1]}`]
  return undefined
}

/** Zener voltage from a part name: BZX79-C5V1 → 5.1, 1N4733A → 5.1, "D_Zener 12V" → 12. */
export function zenerVoltage(text: string): number | undefined {
  const m = /C?(\d+)V(\d*)/i.exec(text)
  if (m) return parseFloat(`${m[1]}.${m[2] || 0}`)
  const jedec: Record<string, number> = { "4728": 3.3, "4729": 3.6, "4730": 3.9, "4731": 4.3, "4732": 4.7, "4733": 5.1, "4734": 5.6, "4735": 6.2, "4736": 6.8, "4737": 7.5, "4738": 8.2, "4739": 9.1, "4740": 10, "4741": 11, "4742": 12, "4744": 15, "4746": 18, "4747": 20, "4749": 24 }
  const j = /1N(47[234]\d)/i.exec(text)
  return j ? jedec[j[1]] : undefined
}

/** Op-amp gain-bandwidth (Hz) and open-loop gain by part family. */
export function opampParams(value: string): { gbw: number; gain: number } {
  const v = value.toUpperCase()
  const table: [RegExp, number, number][] = [
    [/LM358|LM2904|LM324|LM2902|MCP600[24]|MCP6001/, 1e6, 100e3],
    [/TL07|TL08|LF35|LM4558|RC4558|NJM4558/, 3e6, 200e3],
    [/NE5532|NE5534|SA5532/, 10e6, 100e3],
    [/OPA2134|OPA134|OPA4134/, 8e6, 1e6],
    [/[UL]A?M?741|LM741|UA741/, 1e6, 200e3],
    [/OP07|OP27|OP37/, 0.6e6, 400e3],
    [/AD8[0-9]{2}|OPA[0-9]+/, 10e6, 300e3],
    [/LMV3[0-9]{2}|TLV[0-9]+/, 1e6, 100e3],
  ]
  const hit = table.find(([re]) => re.test(v))
  return hit ? { gbw: hit[1], gain: hit[2] } : { gbw: 1e6, gain: 100e3 }
}

/** Fixed output voltage from a regulator name: L7805 → 5, LM7812 → 12, AMS1117-3.3 → 3.3, 79xx → negative. */
export function regulatorVoltage(text: string): number | undefined {
  const t = text.toUpperCase()
  const m78 = /(?:^|[A-Z])7([89])L?M?(\d{2})/.exec(t)
  if (m78) return (m78[1] === "9" ? -1 : 1) * parseInt(m78[2], 10)
  const suffix = /[-_](\d{1,2}(?:\.\d+)?)(?:V|$|[-_])/.exec(t) ?? /[-_](\d)(\d)(?:$|[-_])/.exec(t)
  if (suffix) return suffix.length === 3 ? parseFloat(`${suffix[1]}.${suffix[2]}`) : parseFloat(suffix[1])
  return undefined
}

// ---------------------------------------------------------------- subcircuits

/** KiCad's built-in single-pole op-amp (Holger Vogt, public domain). */
export const SUBCKT_OPAMP = `* Simple generic single-pole op-amp — Holger Vogt, public domain (KiCad Simulation_SPICE.sp)
.subckt kicad_builtin_opamp in+ in- vcc vee out params: POLE=20 GAIN=20k VOFF=10m ROUT=10
Voff in+ inoff dc {VOFF}
G10 0 int inoff in- 100u
R1 int 0 {GAIN/100u}
C1 int 0 {1/(6.28*(GAIN/100u)*POLE)}
Eout 2 0 int 0 1
Rout 2 out {ROUT}
Elow lee 0 vee 0 1
Ehigh lcc 0 vcc 0 1
Dlow lee int Dlimit
Dhigh int lcc Dlimit
.model Dlimit D N=0.01
.ends`

/** Behavioural 555: divider, two comparators, RS latch, output stage, discharge switch. */
export const SUBCKT_555 = `* Behavioural 555 timer (Space Bench)
.subckt sb_555 gnd trig out rst ctrl thr dis vcc
R1 vcc ctrl 5k
R2 ctrl lo 5k
R3 lo gnd 5k
Bset s gnd V = 0.5*(1 + tanh(50*(v(lo,gnd) - v(trig,gnd))))
Brst r gnd V = 0.5*(1 + tanh(50*(v(thr,gnd) - v(ctrl,gnd))))
Bq qx gnd V = v(rst,gnd) < 0.7 ? 0 : v(s,gnd) + (1 - v(s,gnd)) * (1 - v(r,gnd)) * 0.5*(1 + tanh(20*(v(qd,gnd) - 0.5)))
Rq qx qd 1k
Cq qd gnd 2p
Bo o1 gnd V = v(qd,gnd) > 0.5 ? max(v(vcc,gnd) - 1.7, 0) : 0.05
Ro o1 out 10
Sdis dis gnd qd gnd sw555
.model sw555 SW(Vt=0.5 Vh=0.05 Ron=1e9 Roff=10)
Rsup vcc gnd 1Meg
.ends`

/** Fixed linear regulator (78xx / LDO): output tracks min(Vin − dropout, Vout); input supplies the load current. */
export const SUBCKT_REG = `* Behavioural fixed regulator (Space Bench)
.subckt sb_reg in gnd out params: vout=5 drop=2 iq=5m
Bo o1 gnd V = max(min(v(in,gnd) - {drop}, {vout}), 0)
Vs o1 o2 0
Ro o2 out 20m
Bin in gnd I = max(i(Vs), 0) + {iq}
.ends`

/** Negative fixed regulator (79xx). */
export const SUBCKT_REG_NEG = `* Behavioural negative regulator (Space Bench)
.subckt sb_regn in gnd out params: vout=-5 drop=2 iq=5m
Bo o1 gnd V = min(max(v(in,gnd) + {drop}, {vout}), 0)
Vs o1 o2 0
Ro o2 out 20m
Bin in gnd I = min(i(Vs), 0) - {iq}
.ends`

/** LM317-style adjustable regulator: Vout = Vadj + 1.25 V. */
export const SUBCKT_REG_ADJ = `* Behavioural adjustable regulator (Space Bench)
.subckt sb_regadj in adj out params: vref=1.25 drop=2 iadj=50u
Iadj adj_src adj {iadj}
Vadj adj_src 0 0
Bo o1 0 V = max(min(v(in) - {drop}, v(adj) + {vref}), 0)
Vs o1 o2 0
Ro o2 out 10m
Bin in 0 I = max(i(Vs), 0) + 5m
.ends`

export interface ModelEntry { name: string; kind: string; model: string; source: "datasheet" | "generic" | "behavioural" }
/** Every model Space Bench ships (Start screen → Model database). */
export function modelCatalog(): ModelEntry[] {
  const out: ModelEntry[] = []
  const typeOf = (m: string) => m.split("(")[0].replace(/^VDMOS$/, "MOSFET")
  for (const [name, model] of Object.entries(BJT)) out.push({ name, kind: `BJT ${typeOf(model)}`, model, source: "datasheet" })
  for (const [name, model] of Object.entries(MOS)) out.push({ name, kind: model.includes("pchan") ? "P-MOSFET" : "N-MOSFET", model, source: "datasheet" })
  for (const [name, model] of Object.entries(JFET)) out.push({ name, kind: model.startsWith("PJF") ? "P-JFET" : "N-JFET", model, source: "datasheet" })
  for (const [name, model] of Object.entries(DIODE)) out.push({ name, kind: /EG=0.69/.test(model) ? "Schottky diode" : "Diode", model, source: "datasheet" })
  for (const [k, bv] of Object.entries(RECT_BV)) out.push({ name: `1N400${k}`, kind: "Rectifier diode", model: rectifier(bv), source: "datasheet" })
  for (const c of ["Red", "Green", "Yellow", "Blue"]) { const l = ledFor(c); out.push({ name: l.name, kind: "LED", model: l.model, source: "generic" }) }
  for (const [name, model] of Object.entries(GENERIC)) out.push({ name: `Generic ${name}`, kind: name, model, source: "generic" })
  out.push({ name: "Generic diode", kind: "Diode", model: GENERIC_DIODE, source: "generic" }, { name: "Generic Schottky", kind: "Schottky diode", model: GENERIC_SCHOTTKY, source: "generic" })
  out.push({ name: "Zener (by voltage)", kind: "Zener diode", model: zener(5.1), source: "generic" })
  out.push({ name: "Op-amp (single pole)", kind: "Op-amp", model: SUBCKT_OPAMP, source: "behavioural" })
  out.push({ name: "555 timer", kind: "Timer", model: SUBCKT_555, source: "behavioural" })
  out.push({ name: "Fixed regulator (78xx)", kind: "Regulator", model: SUBCKT_REG, source: "behavioural" })
  out.push({ name: "Negative regulator (79xx)", kind: "Regulator", model: SUBCKT_REG_NEG, source: "behavioural" })
  out.push({ name: "Adjustable regulator (LM317)", kind: "Regulator", model: SUBCKT_REG_ADJ, source: "behavioural" })
  return out
}
