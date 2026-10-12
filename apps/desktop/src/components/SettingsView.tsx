// Settings: a nav of sections on the left, cards of rows on the right.
import { useEffect, useMemo, useState, type ReactNode } from "react"
import { isTauri } from "@tauri-apps/api/core"
import { ArrowLeft, Check, Command, Sparkles, File, Gauge, Info, Layers, Loader2, Microchip, RotateCcw, Settings as SettingsIcon, Sun, Zap } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Kbd } from "@/components/ui/kbd"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { ngspiceLibPath, ngspicePath, ngspiceVersion } from "@/lib/engine"
import { loadIndex, type IndexRow } from "@/lib/kicad"
import { modelCatalog } from "@/lib/models"
import { MODELS as AI_MODELS } from "@/lib/ai/claude"
import { CLI_MODELS, claudeCodeTransport, claudeCodeVersion } from "@/lib/ai/claudecode"
import { clearProjects, useProjects } from "@/lib/projects"
import { resetSettings, setSettings, useSettings, type Settings } from "@/lib/settings"
import { speedLabel, SPEEDS } from "@/lib/playback"
import { parseSI } from "@/lib/units"
import { cn } from "@/lib/utils"
import { ShellBar } from "./Chrome"

export type SettingsSection = "general" | "appearance" | "engine" | "libraries" | "kirk" | "microcontrollers" | "ai" | "instruments" | "shortcuts" | "about"

const NAV: { id: SettingsSection; label: string; icon: typeof Zap; desc: string }[] = [
  { id: "general", label: "General", icon: SettingsIcon, desc: "Start-up, projects and new circuits." },
  { id: "appearance", label: "Appearance", icon: Sun, desc: "Theme and what the schematic shows." },
  { id: "engine", label: "Simulation Engine", icon: Zap, desc: "How Space Bench runs your circuits on ngspice." },
  { id: "libraries", label: "Libraries & Models", icon: Layers, desc: "Symbol libraries and simulation models." },
  { id: "kirk", label: "Kirk Language", icon: File, desc: "The code view and code ⇄ schematic sync." },
  { id: "microcontrollers", label: "Microcontrollers", icon: Microchip, desc: "Compiling Arduino sketches (arduino-cli) and the emulator." },
  { id: "ai", label: "AI Assistant", icon: Sparkles, desc: "Design circuits by chatting: Claude writes the Kirk code, simulates it and connects probes." },
  { id: "instruments", label: "Instruments", icon: Gauge, desc: "Probes, playback and readings." },
  { id: "shortcuts", label: "Keyboard Shortcuts", icon: Command, desc: "Every key the workspace understands." },
  { id: "about", label: "About & Licenses", icon: Info, desc: "Versions and third-party components." },
]

const MOD = navigator.platform.includes("Mac") ? "⌘" : "Ctrl+"

interface Props {
  section: SettingsSection
  setSection: (s: SettingsSection) => void
  onBack: () => void
  backLabel: string
  dark: boolean
  onToggleTheme: () => void
  showAllParts: boolean
  setShowAllParts: (v: boolean) => void
}

export function SettingsView({ section, setSection, onBack, backLabel, dark, onToggleTheme, showAllParts, setShowAllParts }: Props) {
  const s = useSettings()
  const meta = NAV.find((n) => n.id === section) ?? NAV[0]
  return (
    <div className="flex h-full flex-col bg-background">
      <ShellBar crumb="Settings" onHome={onBack} dark={dark} onToggleTheme={onToggleTheme} />
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-[280px] shrink-0 flex-col gap-0.5 border-r bg-sidebar px-3.5 pt-5">
          <h1 className="mb-3 px-1 text-xl font-semibold">Settings</h1>
          {NAV.map((n) => (
            <button key={n.id} onClick={() => setSection(n.id)}
              className={cn("flex h-9 items-center gap-2.5 rounded-md px-2.5 text-left text-sm transition-colors hover:bg-accent", section === n.id && "bg-accent font-medium")}>
              <n.icon className="size-4 text-muted-foreground" /> {n.label}
            </button>
          ))}
          <div className="flex-1" />
          <Button variant="ghost" size="sm" className="mb-4 justify-start text-muted-foreground" onClick={onBack}><ArrowLeft /> {backLabel}</Button>
        </nav>
        <ScrollArea className="min-h-0 min-w-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
          <div className="mx-14 my-8 flex max-w-[900px] flex-col gap-6 pb-10">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight">{meta.label}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{meta.desc}</p>
            </div>
            {section === "general" && <General s={s} />}
            {section === "appearance" && <Appearance s={s} />}
            {section === "engine" && <Engine s={s} />}
            {section === "libraries" && <Libraries showAll={showAllParts} setShowAll={setShowAllParts} />}
            {section === "kirk" && <Kirk s={s} />}
            {section === "microcontrollers" && <Mcu s={s} />}
            {section === "ai" && <Ai s={s} />}
            {section === "instruments" && <Instruments s={s} />}
            {section === "shortcuts" && <Shortcuts />}
            {section === "about" && <About />}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- building blocks

function Card({ title, badge, action, children }: { title: string; badge?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border bg-card p-5">
      <div className="mb-4 flex min-h-8 items-center gap-2">
        <h3 className="text-base font-medium">{title}</h3>
        {badge}
        <div className="flex-1" />
        {action}
      </div>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  )
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4">
      <div className="min-w-0 flex-1">
        <div className="text-sm">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div role="radiogroup" className="flex rounded-lg bg-muted p-[3px]">
      {options.map(([v, label]) => (
        <button key={v} role="radio" aria-checked={value === v} onClick={() => onChange(v)}
          className={cn("h-7 rounded-md px-3 text-sm transition-colors", value === v ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground")}>{label}</button>
      ))}
    </div>
  )
}

const ResetButton = ({ keys }: { keys: (keyof Settings)[] }) => (
  <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => { resetSettings(keys); toast("Reset to defaults") }}><RotateCcw /> Defaults</Button>
)

// ---------------------------------------------------------------- sections

function General({ s }: { s: Settings }) {
  const projects = useProjects()
  return (
    <>
      <Card title="Start-up" action={<ResetButton keys={["openOnLaunch", "confirmDiscard", "recentLimit", "newAnalysis"]} />}>
        <Row label="When Space Bench opens" hint="The Start screen lists recent projects and examples">
          <Select value={s.openOnLaunch} onValueChange={(v) => setSettings({ openOnLaunch: v as Settings["openOnLaunch"] })}>
            <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="start">Show the Start screen</SelectItem>
              <SelectItem value="last">Reopen the last project</SelectItem>
              <SelectItem value="blank">Open a blank circuit</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <Row label="Ask before discarding unsaved changes" hint="When opening, importing or starting another circuit">
          <Switch checked={s.confirmDiscard} onCheckedChange={(c) => setSettings({ confirmDiscard: c })} />
        </Row>
        <Row label="New circuits start with" hint="The analysis selected for a blank schematic">
          <Segmented value={s.newAnalysis} options={[["tran", "Transient"], ["ac", "AC sweep"], ["op", "Operating point"]]} onChange={(v) => setSettings({ newAnalysis: v })} />
        </Row>
      </Card>
      <Card title="Recent projects">
        <Row label="Projects to remember" hint="Shown on the Start screen with a preview">
          <Slider className="w-60" min={4} max={30} step={1} value={[s.recentLimit]} onValueChange={([v]) => setSettings({ recentLimit: v })} />
          <span className="w-16 text-right font-mono text-xs">{s.recentLimit}</span>
        </Row>
        <Row label="Clear the list" hint={`${projects.length} project${projects.length === 1 ? "" : "s"} remembered · files on disk are not touched`}>
          <Button variant="outline" size="sm" disabled={!projects.length} onClick={() => { clearProjects(); toast("Recent projects cleared") }}>Clear</Button>
        </Row>
      </Card>
      <Card title="Reset">
        <Row label="Restore every setting to its default" hint="Projects, favourites and window sizes are kept">
          <Button variant="outline" size="sm" onClick={() => { resetSettings(); toast("All settings reset") }}>Reset all settings</Button>
        </Row>
      </Card>
    </>
  )
}

function ThemeCard({ id, label, active }: { id: Settings["theme"]; label: string; active: boolean }) {
  const pane = (dark: boolean) => (
    <div className={cn("flex h-full w-full gap-2 p-3", dark ? "bg-zinc-950" : "bg-white")}>
      <div className={cn("w-[22%] rounded", dark ? "bg-zinc-800" : "bg-zinc-200")} />
      <div className="flex flex-1 flex-col gap-2">
        <div className={cn("h-2.5 w-full rounded", dark ? "bg-zinc-800" : "bg-zinc-200")} />
        <div className={cn("h-2 w-3/4 rounded", dark ? "bg-zinc-800" : "bg-zinc-200")} />
        <div className={cn("flex-1 rounded", dark ? "bg-zinc-800" : "bg-zinc-200")} />
      </div>
    </div>
  )
  return (
    <button onClick={() => setSettings({ theme: id })} className="flex flex-col gap-2 text-left" aria-pressed={active}>
      <div className={cn("h-[110px] w-full overflow-hidden rounded-lg border", active && "ring-2 ring-foreground ring-offset-2 ring-offset-card")}>
        {id === "system" ? <div className="flex h-full">{<div className="w-1/2 overflow-hidden">{pane(false)}</div>}<div className="w-1/2 overflow-hidden">{pane(true)}</div></div> : pane(id === "dark")}
      </div>
      <span className="flex items-center gap-2 text-sm">
        <span aria-hidden className={cn("flex size-4 items-center justify-center rounded-[4px] border", active ? "border-primary bg-primary text-primary-foreground" : "border-input")}>{active && <Check className="size-3" />}</span>
        {label}
      </span>
    </button>
  )
}

function Appearance({ s }: { s: Settings }) {
  return (
    <>
      <Card title="Theme">
        <div className="grid grid-cols-3 gap-4">
          <ThemeCard id="light" label="Light" active={s.theme === "light"} />
          <ThemeCard id="dark" label="Dark" active={s.theme === "dark"} />
          <ThemeCard id="system" label="System" active={s.theme === "system"} />
        </div>
      </Card>
      <Card title="Schematic" action={<ResetButton keys={["overlayFlow", "overlayVolt", "overlayTags", "minimap"]} />}>
        <Row label="Current flow" hint="Animated dots along wires, speed ∝ current"><Switch checked={s.overlayFlow} onCheckedChange={(c) => setSettings({ overlayFlow: c })} /></Row>
        <Row label="Voltage colours" hint="Wires tinted by node voltage"><Switch checked={s.overlayVolt} onCheckedChange={(c) => setSettings({ overlayVolt: c })} /></Row>
        <Row label="Voltage tags" hint="A reading on every net"><Switch checked={s.overlayTags} onCheckedChange={(c) => setSettings({ overlayTags: c })} /></Row>
        <Row label="Minimap" hint="Overview in the corner of the canvas"><Switch checked={s.minimap} onCheckedChange={(c) => setSettings({ minimap: c })} /></Row>
      </Card>
    </>
  )
}

/** A text box for an SI number (RELTOL, ABSTOL…), red when it does not parse. */
function SIField({ label, value, onChange, hint }: { label: string; value: string; onChange: (v: string) => void; hint: string }) {
  const ok = (parseSI(value) ?? 0) > 0
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-mono text-xs text-muted-foreground">{label}</span>
      <Input value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={!ok} className="font-mono" title={hint} />
      <span className={cn("text-[11px]", ok ? "text-muted-foreground" : "text-destructive")}>{ok ? hint : "Enter a positive number, e.g. 1e-3 or 1p"}</span>
    </label>
  )
}

function Engine({ s }: { s: Settings }) {
  const [version, setVersion] = useState<string | null | undefined>(undefined)
  const [where, setWhere] = useState<string | null>(null)
  const [lib, setLib] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const check = async (bin = s.ngspicePath) => {
    setTesting(true)
    const [v, p, l] = await Promise.all([ngspiceVersion(bin), ngspicePath(bin), ngspiceLibPath(bin)])
    setVersion(v); setWhere(p); setLib(l); setTesting(false)
    return v
  }
  useEffect(() => { check() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const cores = navigator.hardwareConcurrency || 8
  return (
    <>
      <Card title="Solver"
        badge={version === undefined ? null : version ? <Badge variant="secondary" className="bg-success-subtle text-success">{version}</Badge> : <Badge variant="destructive">not found</Badge>}
        action={<Button variant="outline" size="sm" disabled={testing} onClick={async () => { const v = await check(); if (v) toast.success(`${v} is working`); else toast.error("ngspice was not found") }}>{testing && <Loader2 className="animate-spin" />}Test</Button>}>
        <Row label="ngspice executable" hint={where ? <>Using <span className="font-mono">{where}</span></> : "Leave empty to find it automatically (PATH, Homebrew, /usr/local)"}>
          <Input className="w-[380px] font-mono" placeholder="Automatic" value={s.ngspicePath} disabled={!isTauri()}
            onChange={(e) => setSettings({ ngspicePath: e.target.value })} onBlur={() => check()} />
        </Row>
        <Row label="Engine" hint={!isTauri() ? "The browser preview always runs the ngspice program" : s.engineKind === "program" ? "Starts ngspice for every run" : lib ? <>Library: <span className="font-mono">{lib}</span>{s.engineKind === "auto" ? " · sweeps still use the program, in parallel" : ""}</> : s.engineKind === "library" ? "libngspice was not found — simulations will fail; choose Automatic or Program" : "libngspice not found — using the program"}>
          <Segmented value={s.engineKind} options={[["auto", "Automatic"], ["library", "Library"], ["program", "Program"]]} onChange={(v) => setSettings({ engineKind: v })} />
        </Row>
        <Row label="Run mode" hint="Live re-simulates on every edit and animates the result; Manual runs when you press Simulate">
          <Segmented value={s.runMode} options={[["realtime", "Live"], ["accurate", "Manual"]]} onChange={(v) => setSettings({ runMode: v })} />
        </Row>
        <Row label="Parallel workers" hint="ngspice processes at once for sweeps and Monte Carlo">
          <Slider className="w-60" min={1} max={Math.max(2, cores)} step={1} value={[s.workers]} onValueChange={([v]) => setSettings({ workers: v })} />
          <span className="w-20 whitespace-nowrap text-right font-mono text-xs">{s.workers} worker{s.workers > 1 ? "s" : ""}</span>
        </Row>
      </Card>
      <Card title="Solver options" action={<ResetButton keys={["reltol", "abstol", "vntol", "gmin", "method", "autoRecover", "saveCurrents"]} />}>
        <div className="grid grid-cols-4 gap-4">
          <SIField label="RELTOL" value={s.reltol} onChange={(v) => setSettings({ reltol: v })} hint="relative error" />
          <SIField label="ABSTOL" value={s.abstol} onChange={(v) => setSettings({ abstol: v })} hint="current error (A)" />
          <SIField label="VNTOL" value={s.vntol} onChange={(v) => setSettings({ vntol: v })} hint="voltage error (V)" />
          <SIField label="GMIN" value={s.gmin} onChange={(v) => setSettings({ gmin: v })} hint="min. conductance (S)" />
        </div>
        <Row label="Integration method" hint="Gear is more stable for stiff circuits (switching, oscillators)">
          <Select value={s.method} onValueChange={(v) => setSettings({ method: v as Settings["method"] })}>
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="trap">Trapezoidal</SelectItem><SelectItem value="gear">Gear</SelectItem></SelectContent>
          </Select>
        </Row>
        <Row label="Auto-recover from convergence errors" hint="Retry once with Gear integration and gmin / source stepping">
          <Switch checked={s.autoRecover} onCheckedChange={(c) => setSettings({ autoRecover: c })} />
        </Row>
        <Row label="Save device currents" hint="Needed for current probes and current flow; uses more memory">
          <Switch checked={s.saveCurrents} onCheckedChange={(c) => setSettings({ saveCurrents: c })} />
        </Row>
      </Card>
    </>
  )
}

function Libraries({ showAll, setShowAll }: { showAll: boolean; setShowAll: (v: boolean) => void }) {
  const [rows, setRows] = useState<IndexRow[] | null>(null)
  useEffect(() => { loadIndex().then(setRows).catch(() => setRows([])) }, [])
  const models = useMemo(() => modelCatalog(), [])
  const libs = useMemo(() => {
    const m = new Map<string, { all: number; sim: number }>()
    for (const r of rows ?? []) { const e = m.get(r.lib) ?? { all: 0, sim: 0 }; e.all++; if (r.sim) e.sim++; m.set(r.lib, e) }
    return [...m].sort((a, b) => b[1].sim - a[1].sim || b[1].all - a[1].all)
  }, [rows])
  const sim = rows?.filter((r) => r.sim).length ?? 0
  const byKind = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of models) m.set(e.kind, (m.get(e.kind) ?? 0) + 1)
    return [...m]
  }, [models])
  return (
    <>
      <Card title="Symbol library" badge={<Badge variant="secondary">KiCad 10</Badge>}>
        <Row label="Symbols" hint="Converted from the official KiCad symbol libraries (CC-BY-SA 4.0 with the KiCad exception)">
          <span className="font-mono text-sm">{rows ? `${rows.length.toLocaleString()} · ${sim.toLocaleString()} simulation-ready` : "…"}</span>
        </Row>
        <Row label="Show parts without a simulation model" hint="They stay in the database either way; hidden parts cannot be simulated yet">
          <Switch checked={showAll} onCheckedChange={setShowAll} />
        </Row>
        <Row label="Update the libraries" hint={<>Run <span className="font-mono">pnpm kicad:symbols</span> in the project folder, then restart</>}>
          <span />
        </Row>
        <div className="max-h-72 overflow-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted text-xs text-muted-foreground"><tr><th className="px-3 py-1.5 text-left font-medium">Library</th><th className="px-3 py-1.5 text-right font-medium">Simulation-ready</th><th className="px-3 py-1.5 text-right font-medium">Symbols</th></tr></thead>
            <tbody className="divide-y">
              {libs.map(([lib, n]) => (
                <tr key={lib} className={n.sim ? "" : "text-muted-foreground"}><td className="px-3 py-1.5 font-mono text-xs">{lib}</td><td className="px-3 py-1.5 text-right font-mono text-xs">{n.sim}</td><td className="px-3 py-1.5 text-right font-mono text-xs">{n.all}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card title="Simulation models" badge={<Badge variant="secondary">{models.length} built-in</Badge>}>
        <Row label="Model sources" hint="Datasheet SPICE parameters for common parts, generic models for the rest (the Inspector says which one a part uses)">
          <span />
        </Row>
        <div className="flex flex-wrap gap-2">
          {byKind.map(([k, n]) => <Badge key={k} variant="outline" className="font-normal">{k} · {n}</Badge>)}
        </div>
        <p className="text-xs text-muted-foreground">Browse every model with its parameters on the Start screen → Model Database. Importing your own .lib / .model files is planned.</p>
      </Card>
    </>
  )
}

function Kirk({ s }: { s: Settings }) {
  return (
    <Card title="Code view" action={<ResetButton keys={["kirkView", "kirkDelay", "kirkInline"]} />}>
      <Row label="Kirk opens as" hint={`${MOD}E switches between the schematic and the code`}>
        <Segmented value={s.kirkView === "schematic" ? "split" : s.kirkView} options={[["split", "Split"], ["code", "Code only"]]} onChange={(v) => setSettings({ kirkView: v })} />
      </Row>
      <Row label="Redraw the schematic after typing stops" hint="Code → schematic sync delay; the drawing always updates the code right away">
        <Slider className="w-60" min={100} max={2000} step={50} value={[s.kirkDelay]} onValueChange={([v]) => setSettings({ kirkDelay: v })} />
        <span className="w-16 text-right font-mono text-xs">{s.kirkDelay} ms</span>
      </Row>
      <Row label="Inline results" hint="Measurement values and assert ✓/✗ at the end of their line">
        <Switch checked={s.kirkInline} onCheckedChange={(c) => setSettings({ kirkInline: c })} />
      </Row>
    </Card>
  )
}

function Mcu({ s }: { s: Settings }) {
  const [st, setSt] = useState<{ version: string; path: string; cores: string[] } | null | undefined>(undefined)
  const [err, setErr] = useState("")
  const check = () => { setSt(undefined); import("@/mcu/compile").then((m) => m.cliStatus(s.arduinoCliPath)).then(setSt).catch((e) => { setErr(String(e instanceof Error ? e.message : e)); setSt(null) }) }
  useEffect(check, [s.arduinoCliPath]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="flex flex-col gap-4">
      <Card title="Compiler (arduino-cli)" badge={st === undefined ? <Badge variant="outline">checking…</Badge> : st ? <Badge variant="secondary" className="bg-success-subtle text-success">found</Badge> : <Badge variant="outline">not found</Badge>}
        action={<Button variant="outline" size="sm" onClick={check}>Check</Button>}>
        <Row label="arduino-cli" hint={st ? `${st.version} · ${st.path}` : st === null ? err : "Looking…"}>
          <Input className="w-[320px] font-mono" placeholder="Automatic (PATH, Homebrew)" value={s.arduinoCliPath} onChange={(e) => setSettings({ arduinoCliPath: e.target.value })} />
        </Row>
        <Row label="Board cores" hint="Installed with arduino-cli core install (the Microcontrollers page installs arduino:avr for you)">
          <span className="font-mono text-xs">{st?.cores.join(", ") || "—"}</span>
        </Row>
      </Card>
      <QemuCard s={s} />
      <LinuxCard />
      <RenodeCard />
      <Card title="Emulator">
        <Row label="Speed" hint="1× is real time: delay(1000) takes one second. Slower speeds help watch fast signals.">
          <Select value={String(s.mcuSpeed)} onValueChange={(v) => setSettings({ mcuSpeed: Number(v) })}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>{[0.1, 0.25, 0.5, 1, 2].map((v) => <SelectItem key={v} value={String(v)}>{v}×</SelectItem>)}</SelectContent>
          </Select>
        </Row>
        <Row label="Buzzer sound" hint="tone() plays through the computer's speakers (the same switch as speakers in circuits)">
          <Switch checked={s.outputSound} onCheckedChange={(c) => setSettings({ outputSound: c })} />
        </Row>
      </Card>
    </div>
  )
}

function QemuCard({ s }: { s: Settings }) {
  const [st, setSt] = useState<string | null | undefined>(undefined)
  const [err, setErr] = useState("")
  const [busy, setBusy] = useState(false)
  const check = () => { setSt(undefined); import("@/mcu/esp32/host").then((m) => m.qemuStatus(s.esp32QemuPath)).then(setSt).catch((e) => { setErr(String(e instanceof Error ? e.message : e)); setSt(null) }) }
  useEffect(check, [s.esp32QemuPath]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Card title="ESP32 Emulator (Espressif QEMU)" badge={st === undefined ? <Badge variant="outline">checking…</Badge> : st ? <Badge variant="secondary" className="bg-success-subtle text-success">found</Badge> : <Badge variant="outline">not found</Badge>}
      action={isTauri() && !st ? <Button size="sm" disabled={busy} onClick={async () => { setBusy(true); try { const m = await import("@/mcu/esp32/host"); setSt(await m.installQemu()); toast.success("QEMU installed") } catch (e) { toast.error(String(e instanceof Error ? e.message : e)) } finally { setBusy(false) } }}>{busy && <Loader2 className="animate-spin" />}Install (≈4 MB)</Button> : <Button variant="outline" size="sm" onClick={check}>Check</Button>}>
      <Row label="qemu-system-xtensa" hint={st ?? (st === null ? err : "Looking in PATH and ~/.espressif/tools…")}>
        <Input className="w-[320px] font-mono" placeholder="Automatic" value={s.esp32QemuPath} onChange={(e) => setSettings({ esp32QemuPath: e.target.value })} />
      </Row>
    </Card>
  )
}

/** STM32 / nRF52 boards on Antmicro's Renode (src/renode/). */
function RenodeCard() {
  const [st, setSt] = useState<string | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const check = () => { setSt(undefined); import("@/renode/host").then((m) => m.renodeStatus()).then(setSt).catch(() => setSt(null)) }
  useEffect(check, [])
  const install = async () => {
    setBusy(true)
    try { const m = await import("@/renode/host"); setSt(await m.installRenode()); toast.success("Renode installed") } catch (e) { toast.error(String(e instanceof Error ? e.message : e)) } finally { setBusy(false) }
  }
  return (
    <Card title="STM32 & nRF52 Emulator (Renode)" badge={st === undefined ? <Badge variant="outline">checking…</Badge> : st ? <Badge variant="secondary" className="bg-success-subtle text-success">found</Badge> : <Badge variant="outline">not found</Badge>}
      action={isTauri() && !st ? <Button size="sm" disabled={busy} onClick={install}>{busy && <Loader2 className="animate-spin" />}Install (≈75 MB)</Button> : <Button variant="outline" size="sm" onClick={check}>Check</Button>}>
      <Row label="Boards" hint={st ? `${st.split(" · ")[0]} — STM32F4 Discovery, STM32 Blue Pill and Arduino Nano 33 BLE run their real firmware (bare STM32F407 / F103 chips too, in schematics).` : "Antmicro's Renode (MIT) runs STM32 and nRF52 firmware. It needs the board's Arduino core (installed from the Microcontrollers page)."}>
        <span className="max-w-[320px] truncate font-mono text-xs text-muted-foreground" title={st ?? ""}>{st?.split(" · ")[1] ?? ""}</span>
      </Row>
    </Card>
  )
}

/** Raspberry Pi 5 / 4 / 3 / Zero 2 W: Linux in a QEMU VM (src/linux/), set up once. */
function LinuxCard() {
  const [st, setSt] = useState<import("@/linux/host").LinuxStatus | null | undefined>(undefined)
  const [err, setErr] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const check = () => { setSt(undefined); import("@/linux/host").then((m) => m.linuxStatus()).then(setSt).catch((e) => { setErr(String(e instanceof Error ? e.message : e)); setSt(null) }) }
  useEffect(check, [])
  const ready = !!st?.qemu && !!st.boot
  const setup = async () => {
    setBusy("Starting…")
    try {
      const { setupLinux } = await import("@/linux/provision")
      await setupLinux((p) => setBusy(`${p.step}/${p.of} · ${p.text}`))
      toast.success("The Raspberry Pi system is ready")
      check()
    } catch (e) { toast.error(String(e instanceof Error ? e.message : e)) } finally { setBusy(null) }
  }
  const badge = st === undefined ? <Badge variant="outline">checking…</Badge>
    : ready ? <Badge variant="secondary" className="bg-success-subtle text-success">ready</Badge>
    : <Badge variant="outline">{st?.qemu ? "not set up" : "QEMU missing"}</Badge>
  return (
    <Card title="Linux Boards (Raspberry Pi 5 · 4 · 3 · Zero 2 W)" badge={badge}
      action={st?.qemu ? <Button size="sm" variant={ready ? "outline" : "default"} disabled={!!busy} onClick={setup}>{busy && <Loader2 className="animate-spin" />}{ready ? "Set up again" : "Set up (≈1 GB, 3–10 min)"}</Button> : <Button variant="outline" size="sm" onClick={check}>Check</Button>}>
      <Row label="System" hint={busy ?? (ready
        ? "Debian 13 with Raspberry Pi's packages (gpiozero, lgpio, RPi.GPIO) — boots as the Pi you place, in about 3 s."
        : st?.qemu ? "Downloads Debian 13 for arm64 and prepares it as a Raspberry Pi: the GPIO pins become the circuit's." : (st === null ? err : "Linux boards need QEMU: install it with `brew install qemu`, then press Check."))}>
        <span className="font-mono text-xs text-muted-foreground">{st?.qemu?.split(" · ")[0] ?? ""}</span>
      </Row>
      {st?.dir && <Row label="Folder" hint="The Pi's disk lives here; packages you install with pip stay installed."><span className="max-w-[320px] truncate font-mono text-xs text-muted-foreground" title={st.dir}>{st.dir}</span></Row>}
    </Card>
  )
}

function Ai({ s }: { s: Settings }) {
  const [show, setShow] = useState(false)
  const [testing, setTesting] = useState(false)
  const test = async () => {
    setTesting(true)
    try {
      const { claudeTransport } = await import("@/lib/ai/claude")
      const r = await claudeTransport(s.aiKey.trim())({ model: s.aiModel, max_tokens: 16, system: [], tools: [], messages: [{ role: "user", content: [{ type: "text", text: "Reply with: ok" }] }] })
      toast.success(`Connected · ${s.aiModel}`, { description: r.content.map((b) => (b.type === "text" ? b.text : "")).join("").slice(0, 60) })
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)) } finally { setTesting(false) }
  }
  const [cliVer, setCliVer] = useState<string | null | undefined>(undefined)
  useEffect(() => { claudeCodeVersion(s.aiCliPath).then(setCliVer) }, [s.aiCliPath])
  const testCli = async () => {
    setTesting(true)
    try {
      const v = await claudeCodeVersion(s.aiCliPath)
      setCliVer(v)
      if (!v) throw new Error("Claude Code (the claude command) was not found")
      const r = await claudeCodeTransport({ model: s.aiCliModel, bin: s.aiCliPath })({ model: s.aiCliModel, max_tokens: 16, system: [], tools: [], messages: [{ role: "user", content: [{ type: "text", text: "Reply with just: ok" }] }] })
      toast.success(`Claude Code is working · ${s.aiCliModel}`, { description: r.content.map((b) => (b.type === "text" ? b.text : "")).join("").slice(0, 60) })
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)) } finally { setTesting(false) }
  }
  const cli = s.aiProvider === "claude-code"
  return (
    <>
      <Card title="Connection">
        <Row label="Use" hint={cli ? "Runs the claude command with your Claude Code login (Pro / Max plan or the account it is set up with). No API key needed." : "Calls the Anthropic API directly with your own API key."}>
          <Select value={s.aiProvider} onValueChange={(v) => setSettings({ aiProvider: v as Settings["aiProvider"] })}>
            <SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="claude-code">Claude Code CLI</SelectItem>
              <SelectItem value="api">Anthropic API key</SelectItem>
            </SelectContent>
          </Select>
        </Row>
      </Card>
      {cli ? (
      <Card title="Claude Code CLI" badge={cliVer === undefined ? <Badge variant="outline">checking…</Badge> : cliVer ? <Badge variant="secondary" className="bg-success-subtle text-success">found</Badge> : <Badge variant="outline">not found</Badge>}
        action={<Button variant="outline" size="sm" disabled={testing} onClick={testCli}>{testing && <Loader2 className="animate-spin" />}Test</Button>}>
        <Row label="claude command" hint={cliVer ? cliVer : <>Not found. Install with <code className="font-mono">npm install -g @anthropic-ai/claude-code</code>, then run <code className="font-mono">claude</code> once in a terminal to log in.</>}>
          <Input className="w-[320px] font-mono" placeholder="Automatic (PATH, Homebrew, ~/.claude/local)" value={s.aiCliPath} onChange={(e) => setSettings({ aiCliPath: e.target.value })} />
        </Row>
        <Row label="Model" hint="Uses the model aliases of your Claude Code plan">
          <Select value={s.aiCliModel} onValueChange={(v) => setSettings({ aiCliModel: v })}>
            <SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
            <SelectContent>{CLI_MODELS.map((m) => <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>)}</SelectContent>
          </Select>
        </Row>
        <Row label="Simulate after every design" hint="The assistant checks its circuits on ngspice before answering">
          <Switch checked={s.aiAutoSimulate} onCheckedChange={(c) => setSettings({ aiAutoSimulate: c })} />
        </Row>
      </Card>
      ) : (
      <Card title="Claude (Anthropic)" badge={s.aiKey ? <Badge variant="secondary" className="bg-success-subtle text-success">key set</Badge> : <Badge variant="outline">no key</Badge>}
        action={<Button variant="outline" size="sm" disabled={!s.aiKey || testing} onClick={test}>{testing && <Loader2 className="animate-spin" />}Test</Button>}>
        <Row label="API key" hint={<>Create one at console.anthropic.com → API keys. It is stored on this computer only and sent only to api.anthropic.com.</>}>
          <Input type={show ? "text" : "password"} className="w-[320px] font-mono" placeholder="sk-ant-…" value={s.aiKey} onChange={(e) => setSettings({ aiKey: e.target.value })} />
          <Button variant="ghost" size="sm" onClick={() => setShow((v) => !v)}>{show ? "Hide" : "Show"}</Button>
        </Row>
        <Row label="Model" hint="Sonnet is the best balance; Opus for hard designs; Haiku is quickest">
          <Select value={s.aiModel} onValueChange={(v) => setSettings({ aiModel: v })}>
            <SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
            <SelectContent>{AI_MODELS.map((m) => <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>)}</SelectContent>
          </Select>
        </Row>
        <Row label="Simulate after every design" hint="The assistant checks its circuits on ngspice before answering">
          <Switch checked={s.aiAutoSimulate} onCheckedChange={(c) => setSettings({ aiAutoSimulate: c })} />
        </Row>
      </Card>
      )}
      <Card title="What is sent">
        <p className="text-sm text-muted-foreground">Your messages, attached images, the circuit's Kirk code and simulation summaries go to Anthropic to generate replies. Nothing is sent until you press Send in the AI panel. {cli ? "With Claude Code, the claude command runs with its own tools (files, shell, web) switched off, in an empty temporary folder; usage counts against your Claude Code plan." : "Usage is billed to your Anthropic account."}</p>
      </Card>
    </>
  )
}

function Instruments({ s }: { s: Settings }) {
  return (
    <Card title="Probes & playback" action={<ResetButton keys={["playbackSpeed", "autoDmm", "scopeOnProbe"]} />}>
      <Row label="Real-time playback speed" hint="How fast a transient replays on the schematic">
        <Select value={s.playbackSpeed} onValueChange={(v) => setSettings({ playbackSpeed: v as Settings["playbackSpeed"] })}>
          <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>{SPEEDS.map((sp) => <SelectItem key={sp} value={sp}>{speedLabel(sp)}</SelectItem>)}</SelectContent>
        </Select>
      </Row>
      <Row label="Open the oscilloscope when probing" hint="Switch the dock to the Oscilloscope tab after a probe click">
        <Switch checked={s.scopeOnProbe} onCheckedChange={(c) => setSettings({ scopeOnProbe: c })} />
      </Row>
      <Row label="Show probed currents on the multimeter" hint="A current probe also connects the DMM">
        <Switch checked={s.autoDmm} onCheckedChange={(c) => setSettings({ autoDmm: c })} />
      </Row>
    </Card>
  )
}

export const SHORTCUTS: { group: string; items: [string, string][] }[] = [
  { group: "File", items: [[`${MOD}N`, "New circuit"], [`${MOD}O`, "Open…"], [`${MOD}S`, "Save"], [`${MOD}I`, "Import Kirk / KiCad / netlist…"], [`${MOD}⇧E`, "Examples…"], [`${MOD}⇧H`, "Start screen"], [`${MOD},`, "Settings"]] },
  { group: "Edit", items: [[`${MOD}Z`, "Undo"], [`${MOD}⇧Z`, "Redo"], [`${MOD}D`, "Duplicate"], [`${MOD}A`, "Select all"], ["⌫", "Delete selection"], [`${MOD}R / R`, "Rotate"], ["X / Y", "Mirror"], ["Esc", "Cancel / select tool"]] },
  { group: "Tools", items: [["W", "Wire"], ["P", "Probe"], ["H", "Pan"], ["⇧X", "No-connect flag"], ["A", "Add part (part browser)"], [`${MOD}K`, "Search parts"], ["R C L D …", "Quick-place a part"]] },
  { group: "Simulation", items: [["F5", "Simulate"], ["Space", "Play / pause real-time playback"]] },
  { group: "View", items: [[`${MOD}E`, "Schematic ⇄ Kirk code"], ["Scroll", "Zoom"], ["⌥-drag", "Pan the canvas"]] },
]

function Shortcuts() {
  return (
    <>
      {SHORTCUTS.map((g) => (
        <Card key={g.group} title={g.group}>
          <div className="divide-y">
            {g.items.map(([k, label]) => (
              <div key={label} className="flex items-center py-2 text-sm first:pt-0 last:pb-0">
                <span className="flex-1">{label}</span>
                <Kbd>{k}</Kbd>
              </div>
            ))}
          </div>
        </Card>
      ))}
    </>
  )
}

const LICENSES: [string, string, string][] = [
  ["KiCad symbol libraries", "CC-BY-SA 4.0 with the KiCad library exception", "Schematic symbols, pin maps and Sim.* fields — converted to JSON/SVG by scripts/build-kicad-symbols.mjs; not covered by Space Bench's MIT licence."],
  ["Generic op-amp model", "Public domain (Holger Vogt, KiCad Simulation_SPICE)", "kicad_builtin_opamp single-pole model."],
  ["avr8js", "MIT · Uri Shaked / Wokwi", "AVR (Arduino Uno, Nano, Mega, ATtiny85) emulation."],
  ["rp2040js", "MIT · Uri Shaked / Wokwi", "RP2040 (Raspberry Pi Pico) emulation."],
  ["RP2040 B1 boot ROM", "BSD-3-Clause · Copyright (c) 2020 Raspberry Pi (Trading) Ltd.", "Boots Pico firmware (via rp2040js)."],
  ["@wokwi/elements", "MIT · Wokwi", "Board and part drawings in the Microcontrollers workspace."],
  ["Monaco Editor", "MIT · Microsoft", "Sketch editor."],
  ["CodeMirror", "MIT", "Kirk code editor."],
  ["three.js", "MIT", "3D board view."],
  ["fflate", "MIT", "Compressed files."],
  ["Tauri", "MIT / Apache-2.0", "Desktop shell."],
  ["React", "MIT", "User interface."],
  ["Radix UI · shadcn/ui", "MIT", "Interface components."],
  ["Tailwind CSS", "MIT", "Styling."],
  ["uPlot", "MIT", "Charts."],
  ["Sonner", "MIT", "Notifications."],
  ["Lucide icons", "ISC license", "Icons."],
  ["Geist & Geist Mono", "SIL Open Font License 1.1", "Typefaces."],
  ["ngspice", "Modified BSD (3-clause) license", "The circuit simulator; installed separately, runs as a program or shared library."],
  ["arduino-cli", "GPL-3.0 (separate program, not bundled)", "Compiles sketches."],
  ["QEMU · Espressif QEMU", "GPL-2.0 (separate programs, not bundled)", "Raspberry Pi VM · ESP32 emulation."],
  ["Renode", "MIT (separate program, not bundled)", "STM32 / nRF52 emulation."],
]

function About() {
  const [engine, setEngine] = useState<string | null>(null)
  const [app, setApp] = useState("0.1.0")
  useEffect(() => {
    ngspiceVersion().then(setEngine)
    if (isTauri()) import("@tauri-apps/api/app").then((m) => m.getVersion()).then(setApp).catch(() => {})
  }, [])
  return (
    <>
      <Card title="Space Bench" badge={<Badge variant="secondary">v{app}</Badge>}>
        <Row label="Circuit design, simulation and measurement" hint="Draw a schematic or write Kirk code — both stay in sync."><span /></Row>
        <Row label="Simulator"><span className="font-mono text-sm">{engine ?? "ngspice not found"}</span></Row>
        <Row label="Platform"><span className="font-mono text-sm">{isTauri() ? "Desktop app" : "Browser (dev)"} · {navigator.platform}</span></Row>
        <Row label="Licence" hint="Free and open source — github.com/techkush/spacebench"><span className="text-sm">MIT</span></Row>
      </Card>
      <Card title="Third-party components & licenses">
        <div className="divide-y">
          {LICENSES.map(([name, lic, what]) => (
            <div key={name} className="flex items-baseline gap-4 py-2.5 first:pt-0 last:pb-0">
              <div className="min-w-0 flex-1"><div className="text-sm">{name}</div><div className="text-xs text-muted-foreground">{what}</div></div>
              <span className="text-right text-xs text-muted-foreground">{lic}</span>
            </div>
          ))}
        </div>
      </Card>
    </>
  )
}

