// Kirk lexer (spec §3). Comments are kept as tokens so the formatter and the
// code generator can preserve them.

export type TokKind =
  | "ident" | "number" | "string" | "quoted" | "comment" | "newline" | "eof"
  | "--" | "->" | ".." | "(" | ")" | "{" | "}" | "[" | "]" | "," | ":" | "=" | "." | "'" | "@"
  | "+" | "-" | "*" | "/" | "^" | "<" | ">" | "<=" | ">=" | "==" | "!=" | "→" | ";"

export interface Token {
  kind: TokKind
  text: string
  from: number
  to: number
  /** number tokens: value with the SI prefix applied, and the attached unit (if any) */
  value?: number
  unit?: string
}

const PREFIX: Record<string, number> = { f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, "µ": 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, Meg: 1e6, G: 1e9, T: 1e12 }
export const UNITS = ["Vpp", "V", "A", "Ω", "ohm", "F", "H", "Hz", "s", "W", "°C", "%", "ppm", "dB", "deg", "rad", "lux", "lx", "Pa", "cm", "mm", "N", "g", "T", "S"] as const

/** Split "kΩ", "uF", "ms", "Meg" … into prefix and unit; null if it isn't a (prefixed) unit. */
export function splitUnit(word: string): { scale: number; unit: string } | null {
  for (const u of UNITS) {
    if (!word.endsWith(u)) continue
    const pre = word.slice(0, word.length - u.length)
    if (pre === "") return { scale: 1, unit: u }
    if (pre in PREFIX && u !== "%" && u !== "ppm" && u !== "dB" && u !== "°C") return { scale: PREFIX[pre], unit: u }
  }
  return null
}

const isIdStart = (c: string) => /[A-Za-z_]/.test(c)
const isId = (c: string) => /[A-Za-z0-9_]/.test(c)

export function lex(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  const push = (kind: TokKind, from: number, to: number, extra: Partial<Token> = {}) => out.push({ kind, text: src.slice(from, to), from, to, ...extra })
  while (i < src.length) {
    const c = src[i]
    if (c === "\n") { push("newline", i, i + 1); i++; continue }
    if (c === " " || c === "\t" || c === "\r") { i++; continue }
    if (c === "/" && src[i + 1] === "/") { const s = i; while (i < src.length && src[i] !== "\n") i++; push("comment", s, i); continue }
    if (c === "/" && src[i + 1] === "*") { const s = i; i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i = Math.min(src.length, i + 2); push("comment", s, i); continue }
    if (c === '"') {
      const s = i; i++
      while (i < src.length && src[i] !== '"' && src[i] !== "\n") { if (src[i] === "\\") i++; i++ }
      i++
      push("string", s, i, { unit: src.slice(s + 1, i - 1).replace(/\\"/g, '"') })
      continue
    }
    if (c === "`") { const s = i; i++; while (i < src.length && src[i] !== "`" && src[i] !== "\n") i++; i++; push("quoted", s, i, { unit: src.slice(s + 1, i - 1) }); continue }
    // ".5" is a number, but in "R1.1" the dot separates part and pin
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? "") && !/[A-Za-z0-9_)\]`]/.test(src[i - 1] ?? ""))) {
      const s = i
      while (/[0-9_]/.test(src[i] ?? "")) i++
      if (src[i] === "." && src[i + 1] !== ".") { i++; while (/[0-9_]/.test(src[i] ?? "")) i++ }
      if (/[eE]/.test(src[i] ?? "") && /[-+0-9]/.test(src[i + 1] ?? "") && /[0-9]/.test((src[i + 1] === "-" || src[i + 1] === "+" ? src[i + 2] : src[i + 1]) ?? "")) {
        i += 2; while (/[0-9]/.test(src[i] ?? "")) i++
      }
      let value = parseFloat(src.slice(s, i).replace(/_/g, ""))
      // attached prefix and/or unit: 10k, 4.7uF, 5V, 1Meg, 20us, 1kΩ, 27°C, 1%
      let j = i
      while (j < src.length && /[A-Za-zΩµ°%]/.test(src[j])) j++
      const word = src.slice(i, j)
      let unit: string | undefined
      if (word) {
        const su = splitUnit(word)
        const digits = src.slice(s, i).replace(/_/g, "")
        const exact = (scale: number) => (/e/i.test(digits) ? parseFloat(digits) * scale : parseFloat(`${digits}e${Math.round(Math.log10(scale))}`))
        if (su) { value = exact(su.scale); unit = su.unit; i = j }
        else if (word in PREFIX) { value = exact(PREFIX[word]); i = j }
        else if (word.startsWith("Meg")) { value *= 1e6; i += 3 }
        else if (word[0] in PREFIX && !isId(src[i + 1] ?? "")) { value *= PREFIX[word[0]]; i += 1 }
      }
      push("number", s, i, { value, unit })
      continue
    }
    if (isIdStart(c) || c === "µ" || c === "Ω") {
      const s = i; i++
      for (;;) {
        while (i < src.length && (isId(src[i]) || src[i] === "Ω")) i++
        // a name made in a for loop: R{i}, N{i+1}, LED{2*i}_A (no spaces inside the braces)
        const m = src[i] === "{" ? /^\{[A-Za-z0-9_+\-*]{1,24}\}/.exec(src.slice(i, i + 27)) : null
        if (!m) break
        i += m[0].length
      }
      push("ident", s, i)
      continue
    }
    if (c === "°" && src[i + 1] === "C") { push("ident", i, i + 2); i += 2; continue }
    const two = src.slice(i, i + 2)
    if (["--", "->", "..", "<=", ">=", "==", "!="].includes(two)) { push(two as TokKind, i, i + 2); i += 2; continue }
    if (c === "→") { push("→", i, i + 1); i++; continue }
    if ("(){}[],:=.'@+-*/^<>%;".includes(c)) { push((c === "%" ? "ident" : c) as TokKind, i, i + 1); i++; continue }
    // unknown character: emit as an ident-like token so the parser reports it
    push("ident", i, i + 1)
    i++
  }
  out.push({ kind: "eof", text: "", from: src.length, to: src.length })
  return out
}

/** Line/column (1-based) of an offset. */
export function lineCol(src: string, offset: number): { line: number; col: number } {
  let line = 1, last = 0
  for (let i = 0; i < offset && i < src.length; i++) if (src[i] === "\n") { line++; last = i + 1 }
  return { line, col: offset - last + 1 }
}
