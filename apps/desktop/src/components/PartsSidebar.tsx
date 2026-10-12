import { useEffect, useMemo, useState } from "react"
import {
  Activity, ArrowRightToLine, BatteryFull, Binary, Cable, ChevronDown, ChevronRight, ChevronsRight, CircuitBoard, Component, Cpu, Ellipsis, Gauge,
  Library, Lightbulb, Plug, Ruler, Search, Star, Thermometer, Timer, ToggleLeft, ToggleRight, Triangle, Zap,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Kbd } from "@/components/ui/kbd"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { ensureSymbols, getSymbol, loadIndex, searchIndex, visibleRows, type IndexRow } from "@/lib/kicad"
import { toggleFavorite, useFavorites } from "@/lib/favorites"
import { cn } from "@/lib/utils"
import { SymbolThumb } from "./SymbolView"

export interface LibraryItem {
  /** "Lib:Name" */
  id: string
  label: string
  hotkey?: string
}

const it = (id: string, label: string, hotkey?: string): LibraryItem => ({ id, label, hotkey })

/** Quick parts: the hotkey parts plus a few simulation-ready staples. Everything else comes from KiCad's own categories. */
export const LIBRARY: { family: string; items: LibraryItem[] }[] = [
  { family: "Quick parts", items: [
    it("Device:R", "Resistor", "R"), it("Device:C", "Capacitor", "C"), it("Device:L", "Inductor", "L"),
    it("Device:D", "Diode", "D"), it("Device:LED", "LED"), it("Transistor_BJT:2N3904", "2N3904", "Q"),
    it("Simulation_SPICE:VDC", "DC source", "V"), it("Simulation_SPICE:VSIN", "Sine source"), it("Simulation_SPICE:VPULSE", "Pulse source"),
    it("Amplifier_Operational:LM358", "LM358"), it("Timer:NE555P", "NE555"), it("power:GND", "Ground", "G"),
    it("@:label", "Net label", "N"), it("power:+5V", "+5 V"), it("power:+12V", "+12 V"),
  ] },
]
export const LIBRARY_IDS = LIBRARY.flatMap((g) => g.items.map((i) => i.id))

function Tile({ item, active, onPlace, badge }: { item: LibraryItem; active: boolean; onPlace: () => void; badge?: string }) {
  const favs = useFavorites()
  const fav = favs.includes(item.id)
  return (
    <div
      role="button" tabIndex={0}
      onClick={onPlace} onKeyDown={(e) => e.key === "Enter" && onPlace()}
      className={cn("group relative flex cursor-pointer flex-col items-center gap-1 rounded-lg border bg-card px-1 py-1.5 transition-colors hover:border-ring hover:bg-accent", active && "border-canvas-selection ring-2 ring-canvas-selection/30")}
      title={`Place ${item.label} — ${item.id}${item.hotkey ? ` (${item.hotkey})` : ""}`}
    >
      {item.hotkey && <Kbd className="absolute right-1 top-1 h-4 min-w-4 px-1 text-[10px]">{item.hotkey}</Kbd>}
      <button
        onClick={(e) => { e.stopPropagation(); toggleFavorite(item.id) }}
        className={cn("absolute left-1 top-1 rounded p-0.5 text-muted-foreground hover:text-foreground", fav ? "text-warning" : "opacity-0 group-hover:opacity-100")}
        title={fav ? "Remove from favorites" : "Add to favorites"}
      ><Star className={cn("size-3", fav && "fill-current")} /></button>
      <SymbolThumb sym={getSymbol(item.id)} className="h-10 w-12" />
      <span className="line-clamp-1 text-center text-[11px] leading-tight">{item.label}</span>
      {badge && !item.hotkey && <span className="absolute right-1 top-1 rounded bg-success-subtle px-1 font-mono text-[9px] text-success">{badge}</span>}
    </div>
  )
}

/** Icon per KiCad category. */
const CATEGORY_ICON: Record<string, typeof Cpu> = {
  Amplifier: Triangle, Comparator: ChevronsRight, Device: Component, Diode: ArrowRightToLine, LED: Lightbulb, Power: Zap,
  power: Plug, Regulator: Gauge, Simulation: Activity, Switch: ToggleLeft, Timer: Timer, Transistor: CircuitBoard, Reference: Ruler,
  Battery: BatteryFull, Relay: ToggleRight, Connector: Cable, Sensor: Thermometer, Logic: Binary, "74xx": Binary, "4xxx": Binary,
}

/** KiCad category of a library: the prefix before the first "_" (Transistor_BJT → Transistor). */
const categoryOf = (lib: string) => lib.split("_")[0]
/** Library name inside its category: Transistor_BJT → BJT, Device → Device. */
const shortLib = (lib: string) => (lib.includes("_") ? lib.slice(lib.indexOf("_") + 1).replace(/_/g, " ") : lib)

const PAGE = 90

/** Symbols of one library as thumbnail tiles (the library loads when opened). */
function LibraryTiles({ lib, rows, placing, onPlace }: { lib: string; rows: IndexRow[]; placing: string | null; onPlace: (id: string) => void }) {
  const [ready, setReady] = useState(false)
  const [shown, setShown] = useState(PAGE)
  useEffect(() => {
    let live = true
    setReady(false)
    ensureSymbols([`${lib}:${rows[0]?.name ?? ""}`]).then(() => live && setReady(true)).catch(() => live && setReady(true))
    return () => { live = false }
  }, [lib, rows])
  if (!ready) return <div className="px-2 py-2 text-xs text-muted-foreground">Loading {lib}…</div>
  return (
    <div className="pb-2 pt-1">
      <div className="grid grid-cols-3 gap-1.5">
        {rows.slice(0, shown).map((r) => {
          const id = `${r.lib}:${r.name}`
          return <Tile key={id} item={{ id, label: r.name }} active={placing === id} onPlace={() => onPlace(id)} />
        })}
      </div>
      {rows.length > shown && (
        <Button variant="ghost" size="sm" className="mt-1 w-full" onClick={() => setShown((n) => n + PAGE * 2)}>Show more ({rows.length - shown} left)</Button>
      )}
    </div>
  )
}

function Row({ row, onPlace, active }: { row: IndexRow; onPlace: () => void; active: boolean }) {
  return (
    <button onClick={onPlace} className={cn("flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent", active && "bg-accent")} title={row.desc}>
      <Cpu className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span className="truncate text-xs font-medium">{row.name}</span>
          {row.units > 1 && <span className="shrink-0 text-[10px] text-muted-foreground">{row.units} units</span>}
        </span>
        <span className="line-clamp-1 text-[11px] text-muted-foreground">{row.desc || row.lib}</span>
      </span>
    </button>
  )
}

interface Props {
  onPlace: (id: string) => void
  onBrowse: (query?: string) => void
  placing: string | null
  recent: string[]
  /** also list parts without a simulation model (hidden by default; still in the database) */
  showAll: boolean
  onShowAll: (v: boolean) => void
  /** libraries used in the open circuit, most used first */
  inProject: string[]
}

export function PartsSidebar({ onPlace, onBrowse, placing, recent, showAll, onShowAll, inProject }: Props) {
  const favorites = useFavorites()
  const [q, setQ] = useState("")
  const [allRows, setIndex] = useState<IndexRow[]>([])
  const index = useMemo(() => visibleRows(allRows, showAll), [allRows, showAll])
  const [, setLoaded] = useState(0)
  const [quickOpen, setQuickOpen] = useState(true)
  const [openCat, setOpenCat] = useState<string | null>(null)
  const [openLib, setOpenLib] = useState<string | null>(null)

  useEffect(() => {
    loadIndex().then(setIndex).catch(() => {})
    ensureSymbols([...LIBRARY_IDS, ...recent, ...favorites]).then(() => setLoaded((n) => n + 1)).catch(() => {})
  }, [recent, favorites])

  const results = useMemo(() => (q.trim() ? searchIndex(index, q, 200) : []), [index, q])
  // KiCad's own organisation: category (library prefix) → libraries → symbols
  const categories = useMemo(() => {
    const cats = new Map<string, { count: number; libs: Map<string, number> }>()
    for (const r of index) {
      const c = categoryOf(r.lib)
      const cat = cats.get(c) ?? { count: 0, libs: new Map() }
      cat.count++
      cat.libs.set(r.lib, (cat.libs.get(r.lib) ?? 0) + 1)
      cats.set(c, cat)
    }
    return [...cats].sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: "base" }))
      .map(([name, c]) => ({ name, count: c.count, libs: [...c.libs].sort((a, b) => a[0].localeCompare(b[0])) }))
  }, [index])
  const libRows = useMemo(() => (openLib ? index.filter((r) => r.lib === openLib) : []), [index, openLib])

  return (
    <aside className="flex w-[300px] shrink-0 flex-col border-r bg-sidebar">
      <div className="flex items-center gap-2 px-4 pb-2 pt-3">
        <span className="text-sm font-medium">Parts</span>
        <Badge variant="secondary">{index.length ? index.length.toLocaleString() : "…"}</Badge>
        <div className="flex-1" />
        <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" onClick={() => onBrowse(q)}><Library /></Button></TooltipTrigger><TooltipContent>Part browser <Kbd className="ml-1">A</Kbd></TooltipContent></Tooltip>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm"><Ellipsis /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72">
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              {visibleRows(allRows).length.toLocaleString()} of {allRows.length.toLocaleString()} KiCad symbols simulate today
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem checked={showAll} onCheckedChange={(v) => onShowAll(!!v)}>Show parts without simulation models</DropdownMenuCheckboxItem>
            <DropdownMenuItem onClick={() => onBrowse()}>Open part browser…</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="relative px-3 pb-2">
        <Search className="pointer-events-none absolute left-5.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input placeholder={`Search ${index.length ? index.length.toLocaleString() : ""} ${showAll ? "KiCad symbols" : "simulation-ready parts"}…`} className="pl-8" value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && results[0]) onPlace(`${results[0].lib}:${results[0].name}`) }} />
      </div>
      <Tabs defaultValue="library" className="min-h-0 flex-1 gap-0">
        <TabsList className="mx-3 mb-2 flex w-auto">
          <TabsTrigger value="library" className="flex-1"><Library /> Library</TabsTrigger>
          <TabsTrigger value="favorites" className="flex-1"><Star /> Favorites</TabsTrigger>
        </TabsList>
        <TabsContent value="library" className="min-h-0">
          <ScrollArea className="h-full px-3">
            {q.trim() ? (
              <div className="pb-3">
                <div className="mb-1 px-1 text-xs text-muted-foreground">{results.length >= 200 ? "200+" : results.length} matches · Enter places the first</div>
                {results.map((r) => <Row key={`${r.lib}:${r.name}`} row={r} active={placing === `${r.lib}:${r.name}`} onPlace={() => onPlace(`${r.lib}:${r.name}`)} />)}
                {results.length >= 200 && <Button variant="link" size="sm" onClick={() => onBrowse(q)}>Show all in the part browser</Button>}
              </div>
            ) : (
              <>
                <div className="mb-2">
                  <button className="flex w-full items-center gap-1 px-1 py-1 text-xs font-medium text-muted-foreground hover:text-foreground" onClick={() => setQuickOpen((o) => !o)}>
                    {quickOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                    Quick parts
                    <span className="ml-auto font-mono text-[10px]">{LIBRARY[0].items.length}</span>
                  </button>
                  {quickOpen && (
                    <div className="grid grid-cols-3 gap-1.5">
                      {LIBRARY[0].items.map((item) => <Tile key={item.id} item={item} active={placing === item.id} onPlace={() => onPlace(item.id)} />)}
                    </div>
                  )}
                </div>
                {inProject.length > 0 && (
                  <div className="mb-2">
                    <div className="flex items-center gap-1 px-1 py-1 text-xs font-medium text-muted-foreground">Popular in this project<span className="ml-auto text-[10px] font-normal">click to place</span></div>
                    <div className="grid grid-cols-3 gap-1.5">
                      {inProject.slice(0, 6).map((id) => <Tile key={id} item={{ id, label: id.split(":")[1] }} active={placing === id} onPlace={() => onPlace(id)} badge="Model" />)}
                    </div>
                  </div>
                )}
                <div className="mb-1 mt-3 flex items-center gap-1 px-1 text-xs font-medium text-muted-foreground">
                  KiCad categories <span className="ml-auto font-mono text-[10px]">{categories.length}</span>
                </div>
                <div className="mb-3">
                  {categories.map((cat) => {
                    const single = cat.libs.length === 1
                    const isOpen = openCat === cat.name
                    return (
                      <div key={cat.name}>
                        <button
                          onClick={() => { setOpenCat(isOpen ? null : cat.name); setOpenLib(single && !isOpen ? cat.libs[0][0] : null) }}
                          className="flex w-full items-center gap-1 rounded-md px-1 py-1 text-left text-sm hover:bg-accent"
                        >
                          {isOpen ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
                          {(() => { const I = CATEGORY_ICON[cat.name] ?? Cpu; return <I className="size-3.5 shrink-0 text-muted-foreground" /> })()}
                          <span className="truncate">{cat.name}</span>
                          <span className="ml-auto font-mono text-[10px] text-muted-foreground">{cat.count.toLocaleString()}</span>
                        </button>
                        {isOpen && (single ? (
                          openLib && <div className="ml-2"><LibraryTiles lib={openLib} rows={libRows} placing={placing} onPlace={onPlace} /></div>
                        ) : (
                          <div className="ml-3 border-l pl-1">
                            {cat.libs.map(([lib, n]) => (
                              <div key={lib}>
                                <button onClick={() => setOpenLib((o) => (o === lib ? null : lib))} className="flex w-full items-center gap-1 rounded-md px-1 py-1 text-left text-xs hover:bg-accent" title={lib}>
                                  {openLib === lib ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
                                  <span className="truncate">{shortLib(lib)}</span>
                                  <span className="ml-auto font-mono text-[10px] text-muted-foreground">{n}</span>
                                </button>
                                {openLib === lib && <LibraryTiles lib={lib} rows={libRows} placing={placing} onPlace={onPlace} />}
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    )
                  })}
                </div>
              </>
            )}
          </ScrollArea>
        </TabsContent>
        <TabsContent value="favorites" className="min-h-0">
          <ScrollArea className="h-full px-3">
            {favorites.length === 0 ? <p className="px-1 py-4 text-xs text-muted-foreground">Hover a part tile and click the star to keep it here.</p> : (
              <div className="grid grid-cols-3 gap-1.5 pb-3">
                {favorites.map((id) => <Tile key={id} item={{ id, label: id.split(":")[1] }} active={placing === id} onPlace={() => onPlace(id)} />)}
              </div>
            )}
          </ScrollArea>
        </TabsContent>
      </Tabs>
      <div className="flex items-center gap-2 border-t px-4 py-2 text-[11px] text-muted-foreground">
        <Star className="size-3.5" /> KiCad 10 symbol libraries
        <span className="ml-auto">CC-BY-SA 4.0</span>
      </div>
    </aside>
  )
}
