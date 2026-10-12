// The Start screen's Microcontrollers page: new sketch, the toolchain's status, the examples.
import { useEffect, useRef, useState } from "react"
import { CircleAlert, CircleCheck, Cpu, Loader2, Plus } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { BOARDS } from "./boards"
import { cliStatus, installCore, type CliStatus } from "./compile"
import { MCU_EXAMPLES } from "./examples"
import { McuCanvas } from "./McuCanvas"
import { recentSketches } from "./recent"
import { importFritzing, onPartsChanged, removeImportedPart } from "./customParts"
import { PARTS } from "./parts"
import { appFS } from "@/lib/projectfs"
import { toast } from "sonner"
import { Trash2, Upload } from "lucide-react"
import { PartThumb } from "./McuWorkspace"

/** board cores the workspace emulates, and where arduino-cli finds them */
const CORES = [
  { core: "arduino:avr", boards: "Uno, Nano, Mega", url: undefined },
  { core: "rp2040:rp2040", boards: "Raspberry Pi Pico", url: BOARDS.find((b) => b.id === "pico")!.coreUrl },
  { core: "esp32:esp32", boards: "ESP32, ESP32-S3, ESP32-C3", url: BOARDS.find((b) => b.id === "esp32")!.coreUrl },
  { core: "ATTinyCore:avr", boards: "ATtiny85", url: BOARDS.find((b) => b.id === "attiny85")!.coreUrl },
  { core: "STMicroelectronics:stm32", boards: "STM32 (Renode)", url: BOARDS.find((b) => b.id === "bluepill")!.coreUrl },
  { core: "arduino:mbed_nano", boards: "Nano 33 BLE (Renode)", url: undefined },
]

export default function McuStartPage({ dark, onNew, onOpenExample, cliPath, onSettings, listSketches, recent, partsRoot }: { dark: boolean; onNew: (boardType: string) => void; onOpenExample: (id: string) => void; cliPath: string; onSettings: () => void; listSketches: () => Promise<{ name: string; where: string; open: () => void }[]>; recent?: React.ReactNode; partsRoot?: string | null }) {
  const [st, setSt] = useState<CliStatus | null | undefined>(undefined)
  const [err, setErr] = useState("")
  const [installing, setInstalling] = useState<string | null>(null)
  const check = () => { setSt(undefined); cliStatus(cliPath).then(setSt).catch((e) => { setErr(e instanceof Error ? e.message : String(e)); setSt(null) }) }
  useEffect(check, [cliPath]) // eslint-disable-line react-hooks/exhaustive-deps
  const [mine, setMine] = useState<{ name: string; where: string; open: () => void }[]>([])
  useEffect(() => { listSketches().then(setMine).catch(() => setMine([])) }, [listSketches])
  const [cat, setCat] = useState("All")
  const cats = ["All", ...new Set(MCU_EXAMPLES.map((e) => e.category))]
  const list = MCU_EXAMPLES.filter((e) => cat === "All" || e.category === cat)
  return (
    <>
      <div className="mb-6 flex items-end gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-[28px] font-semibold tracking-tight">Microcontrollers</h1>
          <p className="mt-1 text-muted-foreground">Write an Arduino sketch, wire parts to the board and run the real compiled firmware on an emulated chip — LEDs, displays, sensors and the Serial Monitor included.</p>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {BOARDS.filter((b) => !b.variantOf).map((b, i) => (
            <button key={b.id} onClick={() => onNew(b.type)} className={cn("flex flex-col rounded-xl border p-4 text-left transition-colors", i === 0 ? "border-primary bg-primary text-primary-foreground hover:bg-primary/90" : "bg-card hover:border-ring")}>
              <span className={cn("flex size-8 items-center justify-center rounded-md border", i === 0 ? "border-transparent bg-primary-foreground text-primary" : "bg-background")}>{i === 0 ? <Plus className="size-4" /> : <Cpu className="size-4" />}</span>
              <span className="mt-5 text-[15px] font-medium">New {b.name} {b.chip === "linux" ? "project" : "sketch"}</span>
              <span className={cn("mt-1 text-xs", i === 0 ? "text-primary-foreground/70" : "text-muted-foreground")}>{b.chip === "linux" ? `Linux · ${b.hz / 1e9} GHz · ${b.sram / (1 << 30)} GB RAM · Python` : `${b.chip === "renode" ? "Renode" : b.chip.toUpperCase()} · ${b.hz / 1e6} MHz · ${b.flash >= 1 << 20 ? `${b.flash / (1 << 20)} MB` : `${Math.round(b.flash / 1024)} KB`} flash · ${b.vcc} V`}</span>
            </button>
          ))}
        </div>
        <div className="rounded-xl border bg-card p-4 text-sm">
          <div className="mb-2 font-medium">Compiler</div>
          {st === undefined && <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Looking for arduino-cli…</div>}
          {st === null && (
            <div className="flex flex-col gap-2">
              <div className="flex items-start gap-2 text-destructive"><CircleAlert className="mt-0.5 size-4 shrink-0" /> <span>{err}</span></div>
              <div className="flex gap-2"><Button size="sm" variant="outline" onClick={check}>Check again</Button><Button size="sm" variant="ghost" onClick={onSettings}>Set the path…</Button></div>
            </div>
          )}
          {st && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2"><CircleCheck className="size-4 text-success" /><span className="truncate font-mono text-xs" title={st.path}>{st.version.replace(/^arduino-cli\s+/i, "")}</span></div>
              <div className="flex flex-wrap items-center gap-1">
                {CORES.map((c) => st.cores.includes(c.core) ? <Badge key={c.core} variant="secondary" className="bg-success-subtle text-success" title={c.boards}>{c.core}</Badge> : (
                  <Button key={c.core} size="sm" variant={c.core === "arduino:avr" ? "default" : "outline"} disabled={!!installing} onClick={async () => { setInstalling(c.core); try { await installCore(c.core, cliPath, c.url); check() } catch (e) { setErr(String(e)) } finally { setInstalling(null) } }}>
                    {installing === c.core && <Loader2 className="animate-spin" />} Install {c.boards} ({c.core})
                  </Button>
                ))}
                {st.cores.filter((c) => !CORES.some((x) => x.core === c)).map((c) => <Badge key={c} variant="outline" className="font-mono">{c}</Badge>)}
              </div>
              <p className="text-xs text-muted-foreground">Sketches compile on this computer with arduino-cli; libraries listed in libraries.txt install on the first compile.</p>
            </div>
          )}
        </div>
      </div>
      {(recent || mine.length > 0) && (
        <>
          <div className="mb-4 mt-10"><h2 className="text-lg font-semibold">My Sketches</h2></div>
          {recent}
          {mine.filter((m) => !recentSketches().some((r) => r.path === m.where)).length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {mine.filter((m) => !recentSketches().some((r) => r.path === m.where)).map((m) => (
                <button key={m.where} onClick={m.open} className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-left text-sm hover:border-ring" title={m.where}><Cpu className="size-4" />{m.name}</button>
              ))}
            </div>
          )}
        </>
      )}
      {partsRoot && <ImportedParts root={partsRoot} />}
      <div className="mb-4 mt-10 flex items-center gap-3">
        <h2 className="flex-1 text-lg font-semibold">Examples</h2>
        <div className="flex flex-wrap gap-1.5">
          {cats.map((c) => <button key={c} onClick={() => setCat(c)} className={cn("h-7 rounded-full border px-3 text-xs transition-colors", cat === c ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-accent")}>{c}</button>)}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {list.map((e) => (
          <button key={e.id} onClick={() => onOpenExample(e.id)} className="flex flex-col overflow-hidden rounded-xl border bg-card text-left transition-colors hover:border-ring">
            <div className="h-[170px] border-b">
              <McuCanvas diagram={e.diagram} onChange={() => {}} frame={null} running={false} onUi={() => {}} selected={null} onSelect={() => {}} onSettings={() => {}} onRestart={() => {}} dark={dark} thumb />
            </div>
            <div className="flex flex-col gap-1 p-3">
              <div className="flex items-center gap-2"><span className="text-sm font-medium">{e.title}</span><div className="flex-1" /><Badge variant="outline" className="font-normal">{e.category}</Badge></div>
              <span className="line-clamp-2 text-xs text-muted-foreground">{e.description}</span>
            </div>
          </button>
        ))}
      </div>
    </>
  )
}

/** Parts imported from Fritzing (.fzpz), shared by every sketch. */
function ImportedParts({ root }: { root: string }) {
  const [, bump] = useState(0)
  useEffect(() => onPartsChanged(() => bump((x) => x + 1)), [])
  const input = useRef<HTMLInputElement>(null)
  const parts = PARTS.filter((p) => p.category === "Imported")
  return (
    <>
      <div className="mb-4 mt-10 flex items-center gap-3">
        <div className="flex-1"><h2 className="text-lg font-semibold">Imported Parts</h2><p className="text-xs text-muted-foreground">Fritzing parts (.fzpz) — placed and wired like any part; they connect but don't act. Fritzing parts are CC-BY-SA.</p></div>
        <input ref={input} type="file" accept=".fzpz" multiple hidden onChange={async (e) => {
          for (const f of Array.from(e.target.files ?? [])) {
            try { const p = await importFritzing(f, appFS(), root); toast.success(`Imported ${p.title}`, { description: `${p.pins.length} pins — in Parts → Imported` }) }
            catch (err) { toast.error(`${f.name}: ${err instanceof Error ? err.message : err}`) }
          }
          e.target.value = ""
        }} />
        <Button variant="outline" onClick={() => input.current?.click()}><Upload /> Import Fritzing Part…</Button>
      </div>
      {parts.length ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 2xl:grid-cols-6">
          {parts.map((p) => (
            <div key={p.type} className="group relative flex flex-col items-center gap-1.5 rounded-xl border bg-card p-3 text-center">
              <PartThumb type={p.type} size={72} />
              <span className="line-clamp-2 text-xs font-medium">{p.title}</span>
              <span className="text-[10px] text-muted-foreground">{p.hint}</span>
              <button title="Remove from Imported Parts" className="absolute right-2 top-2 hidden rounded-md border bg-background p-1 text-muted-foreground hover:text-destructive group-hover:block" onClick={() => removeImportedPart(appFS(), root, p.type)}><Trash2 className="size-3.5" /></button>
            </div>
          ))}
        </div>
      ) : <p className="text-sm text-muted-foreground">None yet. Fritzing's part library is at github.com/fritzing/fritzing-parts; makers' parts come as .fzpz files.</p>}
    </>
  )
}
