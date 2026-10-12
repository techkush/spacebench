// Monaco for sketch files: one model per file (its own undo history), compiler errors as markers,
// and while the sketch runs, live pin badges on the lines that use the pins.
import { useEffect, useMemo, useRef } from "react"
import Editor, { type OnMount } from "@monaco-editor/react"
import { monaco, setupArduino } from "./monaco"
import type { Diagnostic } from "./compile"
import type { LivePin } from "./sim"
import { badgeFor, findConstants, findSpots, resolvePin, type Badge, type Tone } from "./live-code"
import "./live-code.css"

setupArduino()

/** What the running board shows the code: its pins now, the clock and the serial output. */
export interface LiveView { pins: Record<string, LivePin>; vcc: number; seconds: number; serial: string; led: string }

const FLASH_MS = 700

export default function SketchEditor({ path, language, value, onChange, dark, diagnostics, live }: { path: string; language: string; value: string; onChange: (v: string) => void; dark: boolean; diagnostics: Diagnostic[]; live?: LiveView | null }) {
  const ed = useRef<Parameters<OnMount>[0] | null>(null)
  const deco = useRef<ReturnType<Parameters<OnMount>[0]["createDecorationsCollection"]> | null>(null)
  const seen = useRef(new Map<number, { text: string; at: number }>())
  useEffect(() => {
    const model = ed.current?.getModel()
    if (!model) return
    monaco.editor.setModelMarkers(model, "arduino-cli", diagnostics.map((d) => ({
      startLineNumber: d.line, endLineNumber: d.line, startColumn: d.col, endColumn: model.getLineMaxColumn(Math.min(d.line, model.getLineCount())),
      message: d.message, severity: d.severity === "error" ? monaco.MarkerSeverity.Error : d.severity === "warning" ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info,
    })))
  }, [diagnostics, path])
  useEffect(() => {
    const go = (e: Event) => {
      const d = (e as CustomEvent<Diagnostic>).detail
      if (d.file !== path || !ed.current) return
      ed.current.revealLineInCenter(d.line)
      ed.current.setPosition({ lineNumber: d.line, column: d.col })
      ed.current.focus()
    }
    window.addEventListener("sb-reveal-line", go)
    return () => window.removeEventListener("sb-reveal-line", go)
  }, [path])

  // ── live badges ──
  const code = language === "cpp" || language === "c" || /\.(ino|cpp|c|h)$/.test(path)
  const spots = useMemo(() => (code ? findSpots(value) : []), [code, value])
  const consts = useMemo(() => (code ? findConstants(value) : new Map<string, string>()), [code, value])
  const pinNames = useMemo(() => Object.keys(live?.pins ?? {}).join(","), [live?.pins])
  const badges = useMemo(() => {
    if (!live) return []
    const names = pinNames.split(",")
    return spots.map((s) => {
      const pin = s.arg ? resolvePin(s.arg, consts, names, live.led) : null
      return { spot: s, pin, badge: badgeFor(s, pin, live.pins, live) }
    }).filter((b): b is { spot: typeof b.spot; pin: string | null; badge: Badge } => !!b.badge)
  }, [live, spots, consts, pinNames])
  useEffect(() => {
    const e = ed.current
    if (!e) return
    deco.current ??= e.createDecorationsCollection()
    if (!live) { deco.current.clear(); seen.current.clear(); return }
    const model = e.getModel()
    if (!model) return
    const now = performance.now()
    const n = model.getLineCount()
    deco.current.set(badges.filter((b) => b.spot.line <= n).map(({ spot, badge }) => {
      const was = seen.current.get(spot.line)
      // the clock changes every frame: it never flashes
      const key = spot.kind === "loop" ? "loop" : `${badge.dim ? "-" : ""}${badge.key ?? badge.text}`
      if (!was || was.text !== key) seen.current.set(spot.line, { text: key, at: was ? now : -Infinity })
      const flash = now - (seen.current.get(spot.line)?.at ?? -Infinity) < FLASH_MS
      const col = model.getLineMaxColumn(spot.line)
      return {
        range: new monaco.Range(spot.line, Math.max(1, col - 1), spot.line, col),
        options: {
          after: { content: badge.text, inlineClassName: `sb-live sb-live-${badge.tone}${badge.dim ? " sb-live-dim" : ""}` },
          linesDecorationsClassName: `sb-live-gutter sb-live-gutter-${badge.tone}`,
          className: flash && !badge.dim ? `sb-live-flash sb-live-flash-${badge.tone}` : undefined,
          isWholeLine: flash,
        },
      }
    }))
  }, [badges, live])
  useEffect(() => { seen.current.clear() }, [path])

  // the pins this file uses, once each, for the strip above the code
  const chips = useMemo(() => {
    const m = new Map<string, Badge>()
    for (const b of badges) if (b.pin && b.spot.kind !== "mode" && !m.has(b.pin)) m.set(b.pin, b.badge)
    return [...m]
  }, [badges])

  return (
    <div className="flex h-full flex-col">
      {live && code && (
        <div className="sb-live-strip flex shrink-0 items-center gap-1.5 overflow-x-auto border-b px-3 py-1 text-[11px]">
          <span className="sb-live-pulse" />
          <span className="font-semibold tracking-wide text-[#e11d48] dark:text-[#fb7185]">LIVE</span>
          <span className="tabular-nums text-muted-foreground">{live.seconds.toFixed(2)} s</span>
          {chips.map(([pin, b]) => <Chip key={pin} pin={pin} tone={b.tone} pins={live.pins} vcc={live.vcc} />)}
          {!chips.length && <span className="text-muted-foreground">no pins used in this file</span>}
        </div>
      )}
      <div className="min-h-0 flex-1">
        <Editor
          path={path}
          language={language}
          value={value}
          theme={dark ? "sb-dark" : "sb-light"}
          onChange={(v) => onChange(v ?? "")}
          onMount={(e) => { ed.current = e }}
          options={{
            fontFamily: "'Geist Mono Variable', ui-monospace, monospace", fontSize: 13, lineHeight: 20, minimap: { enabled: true, scale: 1 },
            scrollBeyondLastLine: false, automaticLayout: true, tabSize: 2, renderLineHighlight: "line", padding: { top: 8 }, wordWrap: "on",
            scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 }, lineDecorationsWidth: 12,
          }}
        />
      </div>
    </div>
  )
}

function Chip({ pin, tone, pins, vcc }: { pin: string; tone: Tone; pins: Record<string, LivePin>; vcc: number }) {
  const p = pins[pin]
  const name = /^\d+$/.test(pin) ? `D${pin}` : pin
  const val = !p ? "" : tone === "pwm" ? `${Math.round(p.duty * 100)}%` : tone === "analog" ? `${p.v.toFixed(2)}V` : p.level === 2 ? "float" : p.level ? "HIGH" : "LOW"
  const fill = !p ? 0 : tone === "pwm" ? p.duty : tone === "analog" ? p.v / vcc : p.level === 1 ? 1 : 0
  return (
    <span className={`sb-live sb-live-${tone} relative inline-flex shrink-0 items-center gap-1 overflow-hidden`} title={p ? `${name}: ${p.mode}, ${p.v.toFixed(2)} V` : name}>
      <span className="sb-live-fill" style={{ width: `${Math.round(Math.max(0, Math.min(1, fill)) * 100)}%` }} />
      <span className="relative font-semibold">{name}</span>
      <span className="relative tabular-nums">{val}</span>
    </span>
  )
}
