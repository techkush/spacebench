import { useEffect, useMemo, useState } from "react"
import { Copy, Download } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { saveExport } from "@/editor/file"
import { generateKirk } from "@/kirk/generate"
import { deriveNetlist } from "@/editor/netlist"
import { buildTable, pandasSnippet, toCSV, toJSON, toMAT, xNameOf, xUnitOf, type ResultSet } from "@/lib/results"
import { formatSI, parseSI } from "@/lib/units"
import { cn } from "@/lib/utils"
import { RUN_COLORS } from "./AnalysisView"

type Format = "csv" | "json" | "mat"

interface Props {
  open: boolean
  onOpenChange: (o: boolean) => void
  sets: ResultSet[]
  setId: string | null
  /** math expressions defined in the Analysis view */
  math: string[]
}

function SIBox({ label, value, unit, onChange }: { label: string; value: number | undefined; unit: string; onChange: (v: number | undefined) => void }) {
  const [text, setText] = useState<string | null>(null)
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="relative">
        <Input value={text ?? (value === undefined ? "" : formatSI(value, "").replace(/\s/g, ""))} placeholder="auto"
          onChange={(e) => setText(e.target.value)}
          onBlur={() => { if (text !== null) { onChange(text.trim() ? parseSI(text) ?? undefined : undefined) } setText(null) }}
          className="pr-10 font-mono" />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{unit}</span>
      </div>
    </label>
  )
}

/** File → export: simulated vectors, measurements and settings for Python, MATLAB, Excel. */
export function ExportDialog({ open, onOpenChange, sets, setId, math }: Props) {
  const [sid, setSid] = useState<string | null>(setId)
  const set = sets.find((s) => s.id === sid) ?? sets[0] ?? null
  const first = set?.runs.find((r) => r.result)?.result ?? null
  const [signals, setSignals] = useState<string[]>([])
  const [runsRaw, setRuns] = useState<number[]>([])
  // run indices from a previous result set may not exist in this one
  const runs = useMemo(() => runsRaw.filter((i) => !!set?.runs[i]?.result), [runsRaw, set])
  const [from, setFrom] = useState<number | undefined>()
  const [to, setTo] = useState<number | undefined>()
  const [dt, setDt] = useState<number | undefined>()
  const [format, setFormat] = useState<Format>("csv")
  const [header, setHeader] = useState(true)
  const [wide, setWide] = useState(true)
  const [meas, setMeas] = useState(true)
  const [embed, setEmbed] = useState(true)
  const [path, setPath] = useState("")

  useEffect(() => { if (open) setSid(setId ?? sets[0]?.id ?? null) }, [open, setId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!set || !first || first.type === "op") return
    const names = first.names
    const probes = set.doc.probes.filter((p) => names.includes(p))
    setSignals(probes.length ? probes : names.filter((n) => n.startsWith("V(")).slice(0, 3))
    setRuns(set.runs.map((r, i) => (r.result ? i : -1)).filter((i) => i >= 0).slice(0, 20))
    setFrom(undefined); setTo(undefined)
    setDt(set.runs.length > 1 && first.type === "tran" ? first.time[first.time.length - 1] / 5000 : undefined)
    setPath("")
  }, [set?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const table = useMemo(() => (set && first && first.type !== "op" && signals.length && runs.length ? buildTable({ set, signals, runs, from, to, dt, wide }) : null), [set, first, signals, runs, from, to, dt, wide])
  const precision = 6
  const comments = useMemo(() => {
    if (!set || !embed) return []
    const c = [`Space Bench export · ${set.doc.title} · ${set.label} · ${new Date(set.time).toISOString()}`, `analysis: ${set.analysis}`]
    for (const [i, r] of set.runs.entries()) if (runs.includes(i) && Object.keys(r.params).length) c.push(`run ${i + 1}: ${Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(", ")}`)
    if (set.netlist) c.push(...set.netlist.split("\n").map((l) => `netlist: ${l}`))
    return c
  }, [set, embed, runs])
  const measureRows = useMemo(() => {
    if (!set) return null
    const names = [...new Set(set.runs.flatMap((r) => Object.keys(r.measures)))]
    if (!names.length) return null
    return { names, rows: runs.map((i) => ({ run: i + 1, params: set.runs[i].params, values: names.map((n) => { const m = set.runs[i].measures[n]; return m?.ok ? m.value.value : NaN }) })) }
  }, [set, runs])
  const bytes = useMemo(() => {
    if (!table) return 0
    if (format === "mat") return table.columns.length * (table.rows.length * 8 + 40)
    const sample = toCSV({ ...table, rows: table.rows.slice(0, 200) }, { header: false, precision }).length / Math.max(1, Math.min(200, table.rows.length))
    return sample * table.rows.length * (format === "json" ? 1.3 : 1)
  }, [table, format])

  if (!set || !first) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent><DialogTitle>Export data</DialogTitle><DialogDescription>No results yet — run a simulation first.</DialogDescription></DialogContent>
      </Dialog>
    )
  }

  const allSignals = first.type === "op" ? [] : [...first.names.filter((n) => /^(V|I[a-z]*)\(/.test(n)), ...math]
  const fileBase = `${set.doc.title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")}_${set.analysis}`
  const xu = xUnitOf(first)

  const doExport = async () => {
    if (!table) return
    try {
      let target: string | null
      const extra = { ...(meas && measureRows ? { measurements: measureRows } : {}), ...(embed ? { settings: { title: set.doc.title, analysis: set.analysis, analyses: set.doc.analyses, setup: set.doc.setup, runs: runs.map((i) => ({ run: i + 1, label: set.runs[i].label, params: set.runs[i].params })) }, netlist: set.netlist, kirk: generateKirk(set.doc, deriveNetlist(set.doc)) } : {}) }
      if (format === "csv") {
        target = await saveExport(path || `${fileBase}.csv`, "csv", toCSV(table, { header, precision, comments }))
        if (target && meas && measureRows) {
          const mcsv = [["run", ...Object.keys(measureRows.rows[0]?.params ?? {}), ...measureRows.names].join(","), ...measureRows.rows.map((r) => [r.run, ...Object.values(r.params), ...r.values.map((v) => (Number.isFinite(v) ? v.toPrecision(precision) : ""))].join(","))].join("\n") + "\n"
          await saveExport(target.replace(/\.csv$/i, "") + "_meas.csv", "csv", mcsv, true)
        }
      } else if (format === "json") target = await saveExport(path || `${fileBase}.json`, "json", toJSON(table, { header, precision }, extra))
      else target = await saveExport(path || `${fileBase}.mat`, "mat", toMAT(table))
      if (target) { setPath(target); toast.success(`Exported ${target.split("/").pop()}`); onOpenChange(false) }
    } catch (e) { toast.error(String(e instanceof Error ? e.message : e)) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(760px,88vh)] max-w-[min(1060px,94vw)] flex-col gap-0 p-0 sm:max-w-[min(1060px,94vw)]">
        <div className="border-b px-6 pb-4 pt-5">
          <DialogTitle>Export data</DialogTitle>
          <DialogDescription>Collect simulated vectors, measurements and run settings into a file for Python, MATLAB, Excel or a report.</DialogDescription>
        </div>
        <div className="flex min-h-0 flex-1">
          <ScrollArea className="w-[46%] shrink-0 border-r">
            <div className="flex flex-col gap-4 p-6">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-muted-foreground">Source</span>
                <Select value={set.id} onValueChange={setSid}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{sets.map((s) => <SelectItem key={s.id} value={s.id}>{s.label}</SelectItem>)}</SelectContent>
                </Select>
              </label>
              <div>
                <div className="mb-1.5 text-xs text-muted-foreground">Signals</div>
                <div className="flex flex-col gap-1">
                  {allSignals.map((s) => (
                    <label key={s} className="flex cursor-pointer items-center gap-2 font-mono text-xs">
                      <Checkbox checked={signals.includes(s)} onCheckedChange={() => setSignals((x) => (x.includes(s) ? x.filter((y) => y !== s) : [...x, s]))} />
                      <span className="flex-1 truncate">{s}{math.includes(s) && <span className="text-muted-foreground"> · math</span>}</span>
                    </label>
                  ))}
                </div>
              </div>
              {set.runs.length > 1 && (
                <div>
                  <div className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">Runs <button className="underline" onClick={() => setRuns(set.runs.map((_, i) => i))}>all</button><button className="underline" onClick={() => setRuns([])}>none</button></div>
                  <div className="flex flex-wrap gap-1.5">
                    {set.runs.slice(0, 80).map((r, i) => (
                      <button key={i} onClick={() => setRuns((x) => (x.includes(i) ? x.filter((y) => y !== i) : [...x, i].sort((a, b) => a - b)))}
                        className={cn("flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[11px]", runs.includes(i) ? "border-ring bg-accent" : "text-muted-foreground")}>
                        <span className="size-2 rounded-full" style={{ background: RUN_COLORS[i % RUN_COLORS.length] }} />{Object.values(r.params).join(" ") || r.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {first.type !== "ac" && (
                <div className="grid grid-cols-3 gap-3">
                  <SIBox label="From" value={from} unit={xu} onChange={setFrom} />
                  <SIBox label="To" value={to} unit={xu} onChange={setTo} />
                  <SIBox label="Resample Δ" value={dt} unit={xu} onChange={setDt} />
                </div>
              )}
              <div>
                <div className="mb-1.5 text-xs text-muted-foreground">Format</div>
                <div className="flex rounded-lg bg-muted p-[3px]">
                  {([["csv", "CSV"], ["parquet", "Parquet"], ["mat", "MAT"], ["hdf5", "HDF5"], ["json", "JSON"]] as const).map(([f, l]) => {
                    const soon = f === "parquet" || f === "hdf5"
                    const b = <button key={f} disabled={soon} onClick={() => setFormat(f as Format)} className={cn("h-8 flex-1 rounded-md text-sm disabled:opacity-40", format === f ? "bg-background shadow-sm" : "text-muted-foreground")}>{l}</button>
                    return soon ? <Tooltip key={f}><TooltipTrigger asChild><span className="flex flex-1">{b}</span></TooltipTrigger><TooltipContent>Coming later — use CSV, MAT or JSON</TooltipContent></Tooltip> : b
                  })}
                </div>
              </div>
              <div className="flex flex-col gap-2 text-sm">
                <label className="flex items-center gap-2"><Checkbox checked={header} disabled={format !== "csv"} onCheckedChange={(c) => setHeader(!!c)} /> Header row with units ({xNameOf(first)} [{xu}], {signals[0] ?? "V(out)"} […])</label>
                <label className="flex items-center gap-2"><Checkbox checked={wide} onCheckedChange={(c) => setWide(!!c)} /> Wide format: one column per run</label>
                <label className="flex items-center gap-2"><Checkbox checked={meas} disabled={!measureRows || format === "mat"} onCheckedChange={(c) => setMeas(!!c)} /> Add .meas summary{format === "csv" ? " (…_meas.csv)" : ""}</label>
                <label className="flex items-center gap-2"><Checkbox checked={embed} disabled={format === "mat"} onCheckedChange={(c) => setEmbed(!!c)} /> Embed netlist + settings for reproducibility</label>
              </div>
            </div>
          </ScrollArea>
          <div className="flex min-w-0 flex-1 flex-col gap-3 p-6">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Preview</span>
              {table && <Badge variant="secondary">{table.rows.length.toLocaleString()} rows × {table.columns.length} cols</Badge>}
            </div>
            <div className="min-h-0 flex-1 overflow-auto rounded-lg border">
              {table ? (
                <table className="w-full font-mono text-[11px]">
                  <thead className="sticky top-0 bg-muted text-left"><tr>{table.columns.map((c) => <th key={c.name} className="whitespace-nowrap px-2 py-1.5 font-normal text-muted-foreground">{c.name}{c.unit ? ` [${c.unit}]` : ""}</th>)}</tr></thead>
                  <tbody>
                    {table.rows.slice(0, 14).map((r, i) => <tr key={i} className="border-t">{r.map((v, k) => <td key={k} className="whitespace-nowrap px-2 py-1">{Number.isFinite(v) ? (Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(4) : v.toFixed(4)) : ""}</td>)}</tr>)}
                  </tbody>
                </table>
              ) : <div className="p-4 text-xs text-muted-foreground">Choose at least one signal{set.runs.length > 1 ? " and run" : ""}.</div>}
            </div>
            {table && table.rows.length > 14 && <div className="font-mono text-[11px] text-muted-foreground">… {(table.rows.length - 14).toLocaleString()} more rows</div>}
            <div className="grid grid-cols-3 gap-3 text-xs">
              <div><div className="text-muted-foreground">Estimated size</div><div className="font-mono">≈ {formatSI(bytes, "B", 3)}</div></div>
              <div><div className="text-muted-foreground">Columns</div><div className="font-mono">{table ? `1 ${xNameOf(first)} + ${signals.length} signal${signals.length === 1 ? "" : "s"}${wide && runs.length > 1 ? ` × ${runs.length} runs` : ""}` : "—"}</div></div>
              <div><div className="text-muted-foreground">Precision</div><div className="font-mono">float64 · {precision} sig. digits{table?.resampled ? " · resampled" : ""}</div></div>
            </div>
            <div className="flex items-end gap-2">
              <label className="flex flex-1 flex-col gap-1.5">
                <span className="text-xs text-muted-foreground">Save to</span>
                <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder={`${fileBase}.${format} — choose with Export`} className="font-mono text-xs" />
              </label>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 border-t px-6 py-3">
          <Button variant="ghost" disabled={!table} onClick={() => { if (table) { navigator.clipboard.writeText(pandasSnippet(path || `${fileBase}.${format}`, format, table)); toast("Python snippet copied") } }}><Copy /> Copy as Python (pandas)</Button>
          <div className="flex-1" />
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!table} onClick={doExport}><Download /> Export {format.toUpperCase()}</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
