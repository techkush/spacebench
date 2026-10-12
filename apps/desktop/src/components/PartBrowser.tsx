import { openExternal } from "@/lib/open"
import { useEffect, useMemo, useRef, useState } from "react"
import { Cpu, ExternalLink, Search } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Kbd } from "@/components/ui/kbd"
import { ScrollArea } from "@/components/ui/scroll-area"
import { defaultPart, type Part } from "@/editor/model"
import { loadIndex, loadSymbol, searchIndex, unitLetter, visibleRows, type IndexRow, type SymbolDef } from "@/lib/kicad"
import { resolveSim } from "@/lib/spice"
import { cn } from "@/lib/utils"
import { SymbolThumb } from "./SymbolView"

const FAMILIES: [string, RegExp][] = [
  ["All", /./],
  ["Passives", /^Device$/],
  ["Simulation", /^Simulation_SPICE$/],
  ["Diodes", /^(Diode|LED|Diode_Bridge)$/],
  ["Transistors", /^Transistor_/],
  ["Op-amps", /^(Amplifier_|Comparator)/],
  ["Regulators", /^Regulator_/],
  ["Timers & logic", /^(Timer|74xx|4xxx|Logic_)/],
  ["MCUs", /^MCU_/],
  ["Connectors", /^Connector/],
  ["Power", /^power$/],
]

interface Props {
  open: boolean
  initialQuery?: string
  onOpenChange: (o: boolean) => void
  onPlace: (id: string) => void
  recent: string[]
  showAll: boolean
}

export function PartBrowser({ open, initialQuery = "", onOpenChange, onPlace, recent, showAll }: Props) {
  const [allRows, setIndex] = useState<IndexRow[]>([])
  const index = useMemo(() => visibleRows(allRows, showAll), [allRows, showAll])
  const [q, setQ] = useState(initialQuery)
  const [family, setFamily] = useState("All")
  const [sel, setSel] = useState(0)
  const [detail, setDetail] = useState<SymbolDef | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => { if (open) { setQ(initialQuery); setSel(0) } }, [open, initialQuery])
  useEffect(() => { if (open && !allRows.length) loadIndex().then(setIndex).catch(() => {}) }, [open, allRows.length])

  const { rows, ms } = useMemo(() => {
    const t0 = performance.now()
    const fam = FAMILIES.find(([f]) => f === family)![1]
    const base = family === "All" ? index : index.filter((r) => fam.test(r.lib))
    const out = q.trim() ? searchIndex(base, q, 500)
      : family === "All" ? recent.map((id) => index.find((r) => `${r.lib}:${r.name}` === id)).filter((r): r is IndexRow => !!r)
      : base.slice(0, 500)
    return { rows: out, ms: performance.now() - t0 }
  }, [index, q, family, recent])

  const current = rows[Math.min(sel, rows.length - 1)]
  const currentId = current ? `${current.lib}:${current.name}` : null
  useEffect(() => {
    let live = true
    if (!currentId) { setDetail(null); return }
    loadSymbol(currentId).then((s) => live && setDetail(s)).catch(() => live && setDetail(null))
    return () => { live = false }
  }, [currentId])

  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" })
  }, [sel])

  const place = (id: string | null) => { if (id) { onPlace(id); onOpenChange(false) } }
  const sim = detail ? resolveSim({ ...defaultPart(detail), id: "x", ref: `${detail.refPrefix}1`, x: 0, y: 0 } as Part) : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(760px,85vh)] max-w-[min(1120px,92vw)] flex-col gap-0 p-0 sm:max-w-[min(1120px,92vw)]" showCloseButton={false}>
        <DialogTitle className="sr-only">Part browser</DialogTitle>
        <DialogDescription className="sr-only">Search the KiCad symbol libraries and place a part</DialogDescription>
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <Search className="size-4 text-muted-foreground" />
          <Input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setSel(0) }} placeholder="Search parts: 2N3904, op-amp, 555, regulator 3.3V…"
            className="h-9 border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(rows.length - 1, s + 1)) }
              else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)) }
              else if (e.key === "Enter") { e.preventDefault(); place(currentId) }
            }} />
          <span className="shrink-0 font-mono text-xs text-muted-foreground">{rows.length >= 500 ? "500+" : rows.length} results · {ms.toFixed(0)} ms</span>
          <Kbd>esc</Kbd>
        </div>
        <div className="flex flex-wrap gap-1.5 border-b px-4 py-2">
          {FAMILIES.map(([f]) => (
            <button key={f} onClick={() => { setFamily(f); setSel(0) }} className={cn("rounded-full border px-2.5 py-0.5 text-xs transition-colors hover:bg-accent", family === f && "border-foreground bg-foreground text-background hover:bg-foreground")}>{f}</button>
          ))}
        </div>
        <div className="flex min-h-0 flex-1">
          <ScrollArea className="w-[46%] border-r">
            <div ref={listRef} className="p-2">
              {!q.trim() && family === "All" && <div className="px-2 pb-1 text-xs text-muted-foreground">{recent.length ? "Recently placed" : `Type to search ${index.length.toLocaleString()} ${showAll ? "symbols" : "simulation-ready parts"}`}</div>}
              {rows.map((r, i) => (
                <button key={`${r.lib}:${r.name}`} data-i={i} onMouseEnter={() => setSel(i)} onClick={() => setSel(i)} onDoubleClick={() => place(`${r.lib}:${r.name}`)}
                  className={cn("flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left", i === sel ? "bg-accent" : "hover:bg-accent/60")}>
                  <Cpu className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="truncate text-sm font-medium">{r.name}</span>
                      <span className="shrink-0 truncate text-[11px] text-muted-foreground">{r.lib}</span>
                    </span>
                    <span className="line-clamp-1 text-xs text-muted-foreground">{r.desc}</span>
                  </span>
                </button>
              ))}
            </div>
          </ScrollArea>
          <div className="flex min-w-0 flex-1 flex-col">
            {detail && current ? (
              <ScrollArea className="min-h-0 flex-1">
                <div className="flex flex-col gap-4 p-5">
                  <div className="flex h-56 items-center justify-center rounded-xl border bg-canvas">
                    <SymbolThumb sym={detail} className="h-48 w-full" pad={14} />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-lg font-semibold">{detail.name}</span>
                      {sim && !("error" in sim) ? <Badge variant="secondary" className="bg-success-subtle text-success">Sim model</Badge> : <Badge variant="secondary">No sim model</Badge>}
                      {detail.units.length > 1 && <Badge variant="outline">{detail.units.length} units</Badge>}
                    </div>
                    <div className="font-mono text-xs text-muted-foreground">{detail.id}{detail.bases.length ? ` · extends ${detail.bases[0]}` : ""}</div>
                    <p className="mt-2 text-sm text-muted-foreground">{detail.desc}</p>
                    {sim && !("error" in sim) && sim.note && <p className="mt-1 text-xs text-muted-foreground">Simulation: {sim.note}</p>}
                  </div>
                  <div>
                    <div className="mb-1 text-sm font-medium">Pins</div>
                    <table className="w-full font-mono text-xs">
                      <thead className="text-left text-muted-foreground"><tr><th className="pb-1 font-normal">#</th><th className="pb-1 font-normal">Name</th><th className="pb-1 font-normal">Type</th><th className="pb-1 font-normal">Unit</th></tr></thead>
                      <tbody>
                        {detail.units.flatMap((u, k) => u.pins.map((p) => (
                          <tr key={`${k}-${p.n}`} className="border-t">
                            <td className="py-0.5">{p.n}</td><td className="py-0.5">{p.name.replace(/~\{([^}]*)\}/g, "$1") || "—"}</td>
                            <td className="py-0.5 text-muted-foreground">{p.t.replace("_", " ")}{p.h ? " (hidden)" : ""}</td><td className="py-0.5">{detail.units.length > 1 ? unitLetter(k + 1) : "—"}</td>
                          </tr>
                        )))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </ScrollArea>
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">{current ? "Loading…" : "No part selected"}</div>
            )}
            <div className="flex items-center gap-2 border-t px-4 py-3">
              <span className="text-xs text-muted-foreground"><Kbd>↑</Kbd> <Kbd>↓</Kbd> choose · <Kbd>↵</Kbd> place</span>
              <div className="flex-1" />
              {detail?.datasheet && /^https?:/.test(detail.datasheet) && <Button variant="ghost" size="sm" onClick={() => openExternal(detail.datasheet!)}><ExternalLink /> Datasheet</Button>}
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button size="sm" disabled={!currentId} onClick={() => place(currentId)}>Place {detail?.name ?? ""}</Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
