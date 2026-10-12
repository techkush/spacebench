// Kirk syntax highlighting for CodeMirror 6 (stream tokenizer; the real
// parser in parser.ts drives diagnostics and the schematic).
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language"
import { tags as t } from "@lezer/highlight"

const KEYWORDS = new Set("circuit component supply ground net nc import library use simulate measure assert check not parts probe scope meter funcgen bode logger spectrum sweep montecarlo temp environment stimulus seed for in param pins symbol footprint model behavior draw export layout true false runs seed tolerance points lin log severity wire label power at rot mirror unit".split(" "))
export const CONSTRUCTORS = ["R", "C", "L", "Pot", "D", "LED", "Zener", "Schottky", "NPN", "PNP", "NMOS", "PMOS", "NJFET", "PJFET", "Vdc", "Vsin", "Vpulse", "Vpwl", "Idc", "Isin", "Ipulse", "OpAmp", "NE555", "Switch", "PushButton", "Battery", "Lamp", "Speaker", "Fuse", "lib"]
const CTOR = new Set(CONSTRUCTORS)
export const FUNCTIONS = ["avg", "rms", "pp", "max", "min", "final", "at", "frequency", "period", "duty", "rise_time", "fall_time", "gain_db", "phase", "fc", "bandwidth", "abs", "sqrt", "log10", "exp"]
const FUNCS = new Set([...FUNCTIONS, "tran", "ac", "op", "dc"])

interface State { inLayout: boolean; depth: number }

export const kirkLanguage = StreamLanguage.define<State>({
  name: "kirk",
  startState: () => ({ inLayout: false, depth: 0 }),
  token(stream, state) {
    if (stream.eatSpace()) return null
    if (stream.match("//")) { stream.skipToEnd(); return "comment" }
    if (stream.match("/*")) { while (!stream.eol() && !stream.match("*/")) stream.next(); return "comment" }
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string"
    if (stream.match(/^`[^`]*`?/)) return "variableName.special"
    if (stream.match(/^\d[\d_]*(\.\d+)?([eE][-+]?\d+)?(Meg|[fpnuµmkKMGT])?(Vpp|V|A|Ω|ohm|F|H|Hz|s|W|°C|%|ppm|dB|deg)?/)) {
      // a separate unit word right after: "10 uF"
      stream.match(/^\s+(?=(?:[fpnuµmkMGT]|Meg)?(?:Vpp|V|A|Ω|ohm|F|H|Hz|s|W|°C|%|ppm|dB|deg)\b)/)
      stream.match(/^(?:[fpnuµmkMGT]|Meg)?(?:Vpp|V|A|Ω|ohm|F|H|Hz|s|W|°C|%|ppm|dB|deg)\b/)
      return "number"
    }
    if (stream.match("--") || stream.match("->") || stream.match("..")) return "operator"
    if (stream.match("@")) { stream.match(/^\w+/); return "meta" }
    const m = stream.match(/^[A-Za-z_][\w]*/) as RegExpMatchArray | null
    if (m) {
      const w = m[0]
      if (w === "layout") state.inLayout = true
      if (KEYWORDS.has(w)) return "keyword"
      if (stream.peek() === "(") {
        if (w === "V" || /^I[a-z]*$/.test(w)) return "typeName"
        if (CTOR.has(w)) return "className"
        if (FUNCS.has(w)) return "function(variableName)"
      }
      if (CTOR.has(w) && w === "NE555") return "className"
      if (stream.peek() === "." && /^[A-Za-z]/.test(stream.string.slice(stream.pos + 1, stream.pos + 2) || "")) return "variableName.definition"
      return "variableName"
    }
    if (stream.match("{")) { state.depth++; return "brace" }
    if (stream.match("}")) { state.depth = Math.max(0, state.depth - 1); if (!state.depth) state.inLayout = false; return "brace" }
    stream.next()
    return "punctuation"
  },
  languageData: { commentTokens: { line: "//", block: { open: "/*", close: "*/" } }, closeBrackets: { brackets: ["(", "[", "{", '"', "`"] } },
})

export const kirkHighlight = syntaxHighlighting(HighlightStyle.define([
  { tag: t.comment, color: "var(--muted-foreground)", fontStyle: "italic" },
  { tag: t.keyword, color: "var(--chart-5)", fontWeight: "500" },
  { tag: t.number, color: "var(--chart-4)" },
  { tag: t.string, color: "var(--chart-2)" },
  { tag: t.className, color: "var(--chart-1)" },
  { tag: t.typeName, color: "var(--chart-3)" },
  { tag: t.function(t.variableName), color: "var(--chart-3)" },
  { tag: t.special(t.variableName), color: "var(--chart-1)" },
  { tag: t.definition(t.variableName), color: "var(--foreground)", fontWeight: "500" },
  { tag: t.operator, color: "var(--muted-foreground)" },
  { tag: t.meta, color: "var(--chart-4)" },
]))
