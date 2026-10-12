// Report: one self-contained HTML file with the circuit, plots, measurements,
// statistics, Kirk source and netlist of a result set.
import { renderToStaticMarkup } from "react-dom/server"

import { CircuitThumb } from "@/components/CircuitThumb"
import { specLimits } from "@/components/AnalysisView"
import { deriveNetlist } from "@/editor/netlist"
import { generateKirk } from "@/kirk/generate"
import type { MeasureOutcome } from "@/kirk/measure"
import type { ResultSet } from "@/lib/results"
import { formatSI } from "@/lib/units"

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/** Replace CSS variables with their current values so the SVG renders outside the app. */
function inlineVars(html: string): string {
  const cs = getComputedStyle(document.documentElement)
  return html.replace(/var\((--[\w-]+)\)/g, (_, v) => cs.getPropertyValue(v).trim() || "#888")
}

export function buildReport(set: ResultSet, area: HTMLElement | null): string {
  const doc = set.doc
  const measures = [...new Set(set.runs.flatMap((r) => Object.keys(r.measures)))]
  const fmt = (m: MeasureOutcome | undefined) => (!m ? "—" : m.ok ? formatSI(m.value.value, m.value.unit === "deg" ? "°" : m.value.unit, 4) : "error")
  const circuit = inlineVars(renderToStaticMarkup(<CircuitThumb doc={doc} className="circuit" />))
  // the plots currently on screen: uPlot canvases and SVG charts
  const plots: string[] = []
  area?.querySelectorAll(".rounded-lg.border").forEach((card) => {
    const title = card.querySelector(".font-mono")?.textContent ?? ""
    const canvas = card.querySelector("canvas")
    const svg = card.querySelector("svg[role=img]")
    if (canvas) plots.push(`<figure><figcaption>${esc(title)}</figcaption><img src="${canvas.toDataURL("image/png")}" alt="${esc(title)}"></figure>`)
    else if (svg) plots.push(`<figure><figcaption>${esc(title)}</figcaption>${inlineVars(svg.outerHTML)}</figure>`)
  })
  const stats = measures.map((n) => {
    const v = set.runs.map((r) => r.measures[n]).filter((m): m is Extract<MeasureOutcome, { ok: true }> => !!m && m.ok)
    if (!v.length) return ""
    const xs = v.map((m) => m.value.value), unit = v[0].value.unit
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, xs.length - 1))
    const lim = specLimits(doc.asserts ?? [], n)
    const pass = xs.filter((x) => (lim.lo === undefined || x >= lim.lo) && (lim.hi === undefined || x <= lim.hi)).length
    return `<tr><td>${esc(n)}</td><td>${formatSI(mean, unit, 4)}</td><td>${formatSI(sd, unit, 3)}</td><td>${formatSI(Math.min(...xs), unit, 4)}</td><td>${formatSI(Math.max(...xs), unit, 4)}</td><td>${lim.lo !== undefined || lim.hi !== undefined ? `${((pass / xs.length) * 100).toFixed(1)} %` : "—"}</td></tr>`
  }).join("")
  const runRows = set.runs.slice(0, 500).map((r, i) => `<tr><td>${i + 1}</td><td>${esc(Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(", ") || r.label)}</td>${measures.map((n) => `<td>${fmt(r.measures[n])}</td>`).join("")}<td>${r.asserts.length ? (r.asserts.every((a) => a.ok && a.pass) ? "✓" : "✗") : ""}</td></tr>`).join("")
  const kirk = generateKirk(doc, deriveNetlist(doc))
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(doc.title)} — Space Bench report</title>
<style>
  body { font: 14px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; color: #18181b; background: #fff; max-width: 1080px; margin: 32px auto; padding: 0 24px; }
  h1 { font-size: 24px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 32px 0 8px; border-bottom: 1px solid #e4e4e7; padding-bottom: 4px; }
  .meta { color: #71717a; } table { border-collapse: collapse; width: 100%; font: 12px ui-monospace, monospace; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #f4f4f5; } th { color: #71717a; font-weight: 500; }
  figure { margin: 12px 0; border: 1px solid #e4e4e7; border-radius: 8px; padding: 8px; background: #fafafa; } figcaption { font: 12px ui-monospace, monospace; color: #52525b; margin-bottom: 4px; }
  figure img, figure svg { width: 100%; height: auto; display: block; } .circuit { width: 100%; max-height: 420px; background: #fcfcfd; border: 1px solid #e4e4e7; border-radius: 8px; }
  pre { background: #f4f4f5; border-radius: 8px; padding: 12px; overflow: auto; font: 12px/1.5 ui-monospace, monospace; }
</style></head><body>
<h1>${esc(doc.title)}</h1>
<div class="meta">${esc(set.label)} · ${new Date(set.time).toLocaleString()} · Space Bench (ngspice) · ${set.runs.length} run${set.runs.length > 1 ? "s" : ""}</div>
${doc.description ? `<p>${esc(doc.description)}</p>` : ""}
<h2>Circuit</h2>${circuit}
${plots.length ? `<h2>Plots</h2>${plots.join("\n")}` : ""}
${measures.length ? `<h2>Measurements</h2><table><thead><tr><th>#</th><th>Run</th>${measures.map((n) => `<th>${esc(n)}</th>`).join("")}<th>Asserts</th></tr></thead><tbody>${runRows}</tbody></table>` : ""}
${stats && set.runs.length > 1 ? `<h2>Statistics</h2><table><thead><tr><th>Measure</th><th>Mean</th><th>σ</th><th>Min</th><th>Max</th><th>Yield</th></tr></thead><tbody>${stats}</tbody></table>` : ""}
${(doc.asserts ?? []).length ? `<h2>Specifications</h2><pre>${esc((doc.asserts ?? []).map((a) => `assert ${a}`).join("\n"))}</pre>` : ""}
<h2>Kirk source</h2><pre>${esc(kirk)}</pre>
${set.netlist ? `<h2>ngspice netlist</h2><pre>${esc(set.netlist)}</pre>` : ""}
</body></html>
`
}
