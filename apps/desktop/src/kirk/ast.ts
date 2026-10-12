// Kirk syntax tree (spec Appendix A). Every node carries its source span.

export interface Span { from: number; to: number }

export type Expr =
  | { k: "num"; value: number; unit?: string; text: string; span: Span }
  | { k: "str"; value: string; span: Span }
  | { k: "id"; name: string; quoted?: boolean; span: Span }
  | { k: "member"; obj: Expr; prop: string; span: Span }
  | { k: "call"; fn: string; args: Arg[]; span: Span }
  | { k: "bin"; op: string; a: Expr; b: Expr; span: Span }
  | { k: "neg"; a: Expr; span: Span }
  | { k: "list"; items: Expr[]; span: Span }
  | { k: "range"; a: Expr; b: Expr; span: Span }
  /** parts(R*, value: 10k, on: VCC) — the parts a pattern and filters select */
  | { k: "sel"; pattern?: string; filters: Arg[]; span: Span }

export interface Arg { name?: string; value: Expr; span: Span }

export type Endpoint =
  | { k: "name"; name: string; reversed?: boolean; through?: [string, string]; span: Span } // net or part (resolved later)
  | { k: "pins"; pins: { ref: string; pin: string; span: Span }[]; span: Span }
  | { k: "nc"; span: Span }
  | { k: "anon"; span: Span }
  | { k: "inline"; decl: PartDecl; span: Span }

export interface Annotation { name: string; args: Arg[]; span: Span }

export interface PartDecl { k: "part"; ref: string; call: Expr & { k: "call" | "id" }; annotations: Annotation[]; span: Span }

export type Stmt =
  | { k: "supply"; name: string; value: Expr; span: Span }
  | { k: "ground"; names: string[]; span: Span }
  | { k: "net"; names: string[]; span: Span }
  | PartDecl
  | { k: "conn"; ends: Endpoint[]; span: Span }
  | { k: "param"; name: string; value: Expr; span: Span }
  /** inside a component: its pins, in order */
  | { k: "pins"; names: string[]; span: Span }
  /** inside a component: which pins go on which side of its box symbol */
  | { k: "symbolbox"; sides: Partial<Record<"left" | "right" | "top" | "bottom", string[]>>; span: Span }
  | { k: "describe"; text: string; span: Span }
  /** for i in 1..8 { … } — the body once per value; names like R{i} and N{i+1} take the value */
  | { k: "for"; name: string; values: Expr; body: Stmt[]; span: Span }
  /** R1.footprint = "…"  or  parts(R*).MPN = "…" — set a property of a part or of every selected part */
  | { k: "set"; target: { k: "ref"; ref: string; span: Span } | Extract<Expr, { k: "sel" }>; prop: string; value: Expr; span: Span }
  /** check connected(U1.OUT, R3.1)  /  check parts(C*).footprint  /  check parts(R*).count == 8 — a design rule, checked on compile */
  | { k: "check"; negate: boolean; expr: Expr; span: Span }

export interface LayoutLine { k: "at"; target: string; unit?: string; x: number; y: number; rot: number; mirror: boolean; lib?: string; value?: string; span: Span }
export interface LayoutWire { k: "wire"; points: [number, number][]; span: Span }
export interface LayoutLabel { k: "label"; net: string; x: number; y: number; rot: number; span: Span }
export interface LayoutPower { k: "power"; name: string; lib: string; x: number; y: number; rot: number; span: Span }
export interface LayoutNc { k: "nc"; x: number; y: number; span: Span }
export type LayoutItem = LayoutLine | LayoutWire | LayoutLabel | LayoutPower | LayoutNc

export interface InstrumentLine { key: string; args: Expr[]; span: Span }

export type Item =
  | { k: "import"; path: string; library: boolean; span: Span }
  | { k: "use"; path: string; span: Span }
  | { k: "circuit"; name: string; body: Stmt[]; annotations: Annotation[]; span: Span }
  | { k: "param"; name: string; value: Expr; span: Span }
  | { k: "simulate"; name?: string; analysis: string; args: Arg[]; span: Span }
  | { k: "measure"; name: string; expr: Expr; span: Span }
  | { k: "assert"; expr: Expr; severity?: string; span: Span }
  | { k: "instrument"; kind: string; name: string; target?: string; value?: Expr; lines: InstrumentLine[]; span: Span }
  | { k: "sweep"; target: Expr; values: Expr; spacing?: { mode: "lin" | "log"; points: Expr }; span: Span }
  | { k: "montecarlo"; runs: number; seed?: number; tolerances: { glob: string; value: Expr }[]; span: Span }
  | { k: "temp"; values: Expr; span: Span }
  /** environment { light: 300 lux, temp: 25°C, sound: 60 dB, tone: 1 kHz } — the room sensors read */
  | { k: "environment"; entries: { key: string; value: Expr; span: Span }[]; span: Span }
  /** component Name(param: Type = default, …) { pins …  parts and connections } — a reusable part (a class) */
  | { k: "component"; name: string; params: ComponentParam[]; body: Stmt[]; bodySpan: Span; annotations: Annotation[]; span: Span }
  /** library Filters version "1.0.0" — this file is a library of components */
  | { k: "library"; name: string; version?: string; span: Span }
  /** stimulus { seed: 7  V1 = 12 V + noise(sd: 0.2 V)  TH1 = walk(…) } — data fed to the inputs while simulating */
  | { k: "stimulus"; seed?: Expr; feeds: { target: string; value: Expr; span: Span }[]; span: Span }
  | { k: "layout"; items: LayoutItem[]; span: Span }

export interface Comment { text: string; span: Span }

export interface File { items: Item[]; comments: Comment[] }

export interface Diagnostic {
  code: string
  severity: "error" | "warning" | "info"
  message: string
  span: Span
  help?: string
}

/** A component parameter: `r: Resistance = 1.6k`, `r: 1.6k`, `r = 1.6k` or just `r`. */
export interface ComponentParam { name: string; type?: string; def?: Expr; span: Span }
