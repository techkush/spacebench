// CodeMirror 6 editor for Kirk: highlighting, diagnostics, completion of
// parts / pins / nets / constructors, hover cards with live readings, inline
// measurement results, and cross-highlighting with the schematic.
import { useEffect, useRef } from "react"
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { bracketMatching, indentOnInput } from "@codemirror/language"
import { setDiagnostics, type Diagnostic as CmDiagnostic } from "@codemirror/lint"
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search"
import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state"
import { Decoration, EditorView, highlightActiveLine, highlightActiveLineGutter, hoverTooltip, keymap, lineNumbers, WidgetType, type DecorationSet } from "@codemirror/view"

import { isVirtual, placedPins, symbolFor, type Doc } from "@/editor/model"
import type { Netlist } from "@/editor/netlist"
import type { Diagnostic } from "@/kirk/ast"
import { CONSTRUCTORS, FUNCTIONS, kirkHighlight, kirkLanguage } from "@/kirk/language"
import type { AssertOutcome, MeasureOutcome } from "@/kirk/measure"
import { partProbe } from "./SchematicEditor"
import { useSettings } from "@/lib/settings"
import { formatSI } from "@/lib/units"

interface Props {
  value: string
  onChange: (text: string) => void
  diagnostics: Diagnostic[]
  doc: Doc
  netlist: Netlist
  values: Record<string, number>
  measures: Record<string, MeasureOutcome>
  asserts: AssertOutcome[]
  onCursorRef: (ref: string | null) => void
}

// ---------------------------------------------------------------- inline results

class ResultWidget extends WidgetType {
  readonly text: string
  readonly kind: "ok" | "fail" | "error" | "value"
  constructor(text: string, kind: "ok" | "fail" | "error" | "value") { super(); this.text = text; this.kind = kind }
  eq(o: ResultWidget) { return o.text === this.text && o.kind === this.kind }
  toDOM() {
    const s = document.createElement("span")
    s.className = `cm-kirk-result cm-kirk-result-${this.kind}`
    s.textContent = this.text
    return s
  }
}
const setResults = StateEffect.define<DecorationSet>()
const resultsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (deco, tr) => {
    for (const e of tr.effects) if (e.is(setResults)) return e.value
    return deco.map(tr.changes)
  },
  provide: (f) => EditorView.decorations.from(f),
})

function resultDecorations(state: EditorState, measures: Record<string, MeasureOutcome>, asserts: AssertOutcome[]): DecorationSet {
  const out: { pos: number; w: ResultWidget }[] = []
  let ai = 0
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n)
    const m = /^\s*measure\s+([A-Za-z_]\w*)\s*=/.exec(line.text)
    if (m) {
      const r = measures[m[1]]
      if (r) out.push({ pos: line.to, w: new ResultWidget(r.ok ? `= ${formatSI(r.value.value, r.value.unit === "deg" ? "°" : r.value.unit, 4)}` : `⚠ ${r.error}`, r.ok ? "value" : "error") })
      continue
    }
    if (/^\s*assert\b/.test(line.text)) {
      const a = asserts[ai++]
      if (a) out.push({ pos: line.to, w: new ResultWidget(!a.ok ? `⚠ ${a.error}` : a.pass ? "✓ pass" : a.severity === "warning" ? "△ warning" : "✗ fail", !a.ok ? "error" : a.pass ? "ok" : "fail") })
    }
  }
  return Decoration.set(out.map((o) => Decoration.widget({ widget: o.w, side: 1 }).range(o.pos)))
}

// ---------------------------------------------------------------- theme

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px", backgroundColor: "var(--background)", color: "var(--foreground)" },
  ".cm-scroller": { fontFamily: "var(--font-mono, ui-monospace, monospace)", lineHeight: "1.6" },
  ".cm-content": { caretColor: "var(--foreground)", padding: "8px 0" },
  ".cm-gutters": { backgroundColor: "var(--background)", color: "var(--muted-foreground)", border: "none", paddingRight: "6px" },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklab, var(--canvas-selection) 7%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--foreground)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "color-mix(in oklab, var(--chart-1) 22%, transparent) !important" },
  ".cm-cursor": { borderLeftColor: "var(--foreground)" },
  ".cm-tooltip": { border: "1px solid var(--border)", backgroundColor: "var(--popover)", color: "var(--popover-foreground)", borderRadius: "8px", boxShadow: "0 8px 24px rgb(0 0 0 / 0.12)" },
  ".cm-tooltip-autocomplete > ul": { fontFamily: "var(--font-mono, monospace)", fontSize: "12px", maxHeight: "16em" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--accent)", color: "var(--accent-foreground)" },
  ".cm-completionDetail": { marginLeft: "1.5em", color: "var(--muted-foreground)", fontStyle: "normal" },
  ".cm-completionInfo": { padding: "6px 8px", fontSize: "12px" },
  ".cm-diagnostic-error": { borderLeft: "3px solid var(--destructive)" },
  ".cm-diagnostic-warning": { borderLeft: "3px solid var(--warning)" },
  ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy var(--destructive)", textUnderlineOffset: "3px" },
  ".cm-lintRange-warning": { backgroundImage: "none", textDecoration: "underline wavy var(--warning)", textUnderlineOffset: "3px" },
  ".cm-kirk-result": { marginLeft: "2em", padding: "0 6px", borderRadius: "4px", fontSize: "11.5px" },
  ".cm-kirk-result-value": { color: "var(--chart-3)", backgroundColor: "color-mix(in oklab, var(--chart-3) 10%, transparent)" },
  ".cm-kirk-result-ok": { color: "var(--success)", backgroundColor: "var(--success-subtle)" },
  ".cm-kirk-result-fail": { color: "var(--destructive)", backgroundColor: "color-mix(in oklab, var(--destructive) 12%, transparent)" },
  ".cm-kirk-result-error": { color: "var(--warning)" },
  ".cm-kirk-hover": { padding: "8px 10px", fontFamily: "var(--font-mono, monospace)", fontSize: "12px", lineHeight: "1.6" },
})

export function KirkEditor(props: Props) {
  const inline = useSettings().kirkInline
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const latest = useRef(props)
  latest.current = props
  const applying = useRef(false)

  // ---- completion: parts, pins after "U1.", nets, constructors, functions
  const complete = (ctx: CompletionContext): CompletionResult | null => {
    const { doc, netlist } = latest.current
    const pin = ctx.matchBefore(/([A-Za-z_]\w*)\.(\w*)$/)
    if (pin) {
      const ref = /^([A-Za-z_]\w*)\./.exec(pin.text)![1]
      const part = doc.parts.find((p) => p.ref === ref)
      const sym = part && symbolFor(part)
      if (!sym) return null
      const from = pin.from + ref.length + 1
      const options = sym.units.flatMap((u, ui) => u.pins.map((x) => {
        const name = x.name.replace(/~\{([^}]*)\}/g, "$1")
        const label = name && /^[A-Za-z_]\w*$/.test(name) && sym.units.flatMap((v) => v.pins).filter((y) => y.name === x.name).length === 1 ? name : x.n
        const net = netlist.pinNet.get(`${ref}.${x.n}`)
        return { label, type: "property", detail: `#${x.n} · ${x.t.replace("_", " ")}${sym.units.length > 1 ? ` · unit ${String.fromCharCode(65 + ui)}` : ""}`, info: net ? `connected to ${net === "0" ? "GND" : net}` : "unconnected", boost: net ? -1 : 0 }
      }))
      return { from, options, validFor: /^\w*$/ }
    }
    const word = ctx.matchBefore(/[A-Za-z_]\w*/)
    if (!word && !ctx.explicit) return null
    const from = word ? word.from : ctx.pos
    const line = ctx.state.doc.lineAt(ctx.pos).text.slice(0, ctx.pos - ctx.state.doc.lineAt(ctx.pos).from)
    if (/=\s*[A-Za-z_]*$/.test(line) && !/measure|assert/.test(line)) {
      return { from, options: CONSTRUCTORS.map((c) => ({ label: c, type: "class", apply: c === "NE555" ? c : `${c}(`, detail: c === "lib" ? "any KiCad symbol" : "part" })) }
    }
    const refs = [...new Set(doc.parts.filter((p) => !isVirtual(p)).map((p) => p.ref))]
    const nets = netlist.nets.filter((n) => n !== "0" && !/^N\d+$/.test(n))
    return {
      from,
      options: [
        ...refs.map((r) => ({ label: r, type: "variable", detail: symbolFor(doc.parts.find((p) => p.ref === r)!)?.name ?? "part" })),
        ...nets.map((n) => ({ label: /^[A-Za-z_]\w*$/.test(n) ? n : `\`${n}\``, type: "constant", detail: "net" })),
        ...FUNCTIONS.map((f) => ({ label: f, type: "function", apply: `${f}(` })),
        ...["V(", "I("].map((s) => ({ label: s, type: "function", detail: "signal" })),
        ...["circuit", "ground", "supply", "simulate", "measure", "assert", "check", "for", "parts", "scope", "meter", "sweep", "montecarlo", "temp", "nc"].map((k) => ({ label: k, type: "keyword" })),
      ],
      validFor: /^\w*$/,
    }
  }

  // ---- hover: part / net cards with live readings
  const hover = hoverTooltip((v, pos) => {
    const { doc, netlist, values } = latest.current
    const w = v.state.wordAt(pos)
    if (!w) return null
    const word = v.state.sliceDoc(w.from, w.to)
    const part = doc.parts.find((p) => p.ref === word && !isVirtual(p))
    const net = netlist.nets.includes(word) ? word : word === "GND" ? "0" : null
    if (!part && !net) return null
    return {
      pos: w.from, end: w.to, above: true,
      create: () => {
        const dom = document.createElement("div")
        dom.className = "cm-kirk-hover"
        if (part) {
          const sym = symbolFor(part)
          const pins = placedPins(part)
          const nv = (p: typeof pins[number]) => { const n = netlist.pinNet.get(`${part.ref}.${p.n}`); return n === "0" ? 0 : n ? values[`V(${n})`] : undefined }
          const va = pins.length === 2 ? (nv(pins[0]) ?? NaN) - (nv(pins[1]) ?? NaN) : NaN
          const probe = partProbe(part)
          const i = probe ? values[probe] : undefined
          dom.innerHTML = `<b>${part.ref}</b> <span style="color:var(--muted-foreground)">${sym?.desc ?? sym?.name ?? ""} · ${part.value}</span><br>` +
            (Number.isFinite(va) ? `V ${formatSI(va, "V", 3)} ` : "") + (i !== undefined ? `· ${probe!.split("(")[0]} ${formatSI(i, "A", 3)} ` : "") +
            (Number.isFinite(va) && i !== undefined ? `· P ${formatSI(Math.abs(va * i), "W", 3)}` : "") +
            `<br><span style="color:var(--muted-foreground)">${sym?.id ?? ""} · cursor here selects it on the schematic</span>`
        } else {
          const v0 = net === "0" ? 0 : values[`V(${net})`]
          dom.innerHTML = `<b>net ${word}</b>${v0 !== undefined ? ` · ${formatSI(v0, "V", 4)}` : ""}<br><span style="color:var(--muted-foreground)">${[...netlist.pinNet].filter(([, n]) => n === net).map(([k]) => k).join(", ")}</span>`
        }
        return { dom }
      },
    }
  })

  useEffect(() => {
    const extensions: Extension[] = [
      lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), history(), indentOnInput(), bracketMatching(), closeBrackets(),
      highlightSelectionMatches(), kirkLanguage, kirkHighlight, theme, resultsField, hover,
      autocompletion({ override: [complete], icons: false }),
      keymap.of([indentWithTab, ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...completionKeymap, ...searchKeymap]),
      EditorState.tabSize.of(4),
      EditorView.contentAttributes.of({ spellcheck: "false", autocorrect: "off", autocapitalize: "off" }),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && !applying.current) latest.current.onChange(u.state.doc.toString())
        if (u.selectionSet || u.docChanged) {
          const w = u.state.wordAt(u.state.selection.main.head)
          const word = w ? u.state.sliceDoc(w.from, w.to) : null
          latest.current.onCursorRef(word && latest.current.doc.parts.some((p) => p.ref === word && !isVirtual(p)) ? word : null)
        }
      }),
    ]
    view.current = new EditorView({ state: EditorState.create({ doc: props.value, extensions }), parent: host.current! })
    return () => { view.current?.destroy(); view.current = null }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // external text (generated from the schematic) replaces the buffer
  useEffect(() => {
    const v = view.current
    if (!v) return
    const cur = v.state.doc.toString()
    if (cur === props.value) return
    applying.current = true
    const head = Math.min(v.state.selection.main.head, props.value.length)
    v.dispatch({ changes: { from: 0, to: cur.length, insert: props.value }, selection: { anchor: head } })
    applying.current = false
  }, [props.value])

  // diagnostics
  useEffect(() => {
    const v = view.current
    if (!v) return
    const len = v.state.doc.length
    const ds: CmDiagnostic[] = props.diagnostics.map((d) => ({
      from: Math.min(d.span.from, len), to: Math.min(Math.max(d.span.to, d.span.from + 1), len), severity: d.severity === "info" ? "info" : d.severity,
      message: `${d.code}: ${d.message}${d.help ? `\nhelp: ${d.help}` : ""}`,
    }))
    v.dispatch(setDiagnostics(v.state, ds))
  }, [props.diagnostics])

  // inline measurement / assert results
  useEffect(() => {
    const v = view.current
    if (!v) return
    v.dispatch({ effects: setResults.of(inline ? resultDecorations(v.state, props.measures, props.asserts) : Decoration.none) })
  }, [props.measures, props.asserts, props.value, inline])

  return <div ref={host} className="h-full min-h-0 overflow-hidden" />
}
