import { useEffect, useState } from "react"
import { Copy, Ellipsis, ExternalLink, Eye, EyeOff, FileText, Footprints, SlidersHorizontal } from "lucide-react"
import { toast } from "sonner"
import { openExternal } from "@/lib/open"
import { cn } from "@/lib/utils"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { displayRef, isLabel, placedPins, symbolFor, type Doc as CircuitDoc, type Part } from "@/editor/model"
import type { Netlist } from "@/editor/netlist"
import { unitLetter } from "@/lib/kicad"
import { formatParams, parseParams, parseValue, resolveSim, type ResolvedSim } from "@/lib/spice"
import { formatSI, parseSI } from "@/lib/units"
import { partProbe } from "./SchematicEditor"
import { SymbolThumb } from "./SymbolView"

interface Props {
  doc: CircuitDoc
  netlist: Netlist
  part: Part | null
  values: Record<string, number>
  onChangePart: (id: string, patch: Partial<Part>) => void
  onChangeAnalyses: (a: CircuitDoc["analyses"]) => void
  onRotate: () => void
  onMirror: () => void
  onDuplicate: () => void
  onDelete: () => void
  series: (signal: string) => { x: number[]; y: number[] } | null
  time: number | null
  onAddToSweep: (target: string) => void
}

/** Text field that accepts SI values ("4.7k") and commits on Enter / blur. */
function SIField({ label, value, unit, onCommit }: { label: string; value: number; unit: string; onCommit: (v: number) => void }) {
  const [text, setText] = useState(formatSI(value, ""))
  const [bad, setBad] = useState(false)
  useEffect(() => { setText(formatSI(value, "").replace(" ", "")); setBad(false) }, [value])
  const commit = () => {
    const v = parseSI(text)
    if (v === null || !Number.isFinite(v)) { setBad(true); return }
    setBad(false)
    if (v !== value) onCommit(v)
  }
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="relative">
        <Input value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} aria-invalid={bad} className="pr-10 font-mono" />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{unit}</span>
      </div>
      {bad && <span className="text-xs text-destructive">Use a number with an SI prefix, e.g. 4.7k, 100n, 2.2M</span>}
    </label>
  )
}

/** Text field that commits on Enter / blur, with validation. */
function TextField({ label, value, validate, onCommit, mono, hint }: { label: string; value: string; validate?: (v: string) => string | null; onCommit: (v: string) => void; mono?: boolean; hint?: string }) {
  const [text, setText] = useState(value)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { setText(value); setErr(null) }, [value])
  const commit = () => {
    const v = text.trim()
    const e = validate?.(v) ?? null
    setErr(e)
    if (!e && v !== value) onCommit(v)
  }
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <Input value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} aria-invalid={!!err} className={mono ? "font-mono" : ""} />
      {err ? <span className="text-xs text-destructive">{err}</span> : hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  )
}

function Reading({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex-1 rounded-lg border bg-card px-2.5 py-2">
      <div className="text-xs text-muted-foreground">{k}</div>
      <div className="font-mono text-sm">{v}</div>
    </div>
  )
}

export function Inspector({ doc, netlist, part, values, onChangePart, onChangeAnalyses, ...actions }: Props) {
  if (!part) {
    const { tran, ac } = doc.analyses
    return (
      <div className="flex h-full flex-col gap-4 overflow-auto p-4">
        <div>
          <div className="text-lg font-semibold">{doc.title}</div>
          <p className="mt-1 text-sm text-muted-foreground">{doc.description}</p>
        </div>
        <Separator />
        <div className="text-sm font-medium">Transient</div>
        <div className="grid grid-cols-2 gap-3">
          <SIField label="Stop time" value={tran.stop} unit="s" onCommit={(v) => onChangeAnalyses({ ...doc.analyses, tran: { ...tran, stop: v } })} />
          <SIField label="Max step" value={tran.step} unit="s" onCommit={(v) => onChangeAnalyses({ ...doc.analyses, tran: { ...tran, step: v } })} />
        </div>
        <div className="text-sm font-medium">AC sweep</div>
        <div className="grid grid-cols-2 gap-3">
          <SIField label="Start" value={ac.start} unit="Hz" onCommit={(v) => onChangeAnalyses({ ...doc.analyses, ac: { ...ac, start: v } })} />
          <SIField label="Stop" value={ac.stop} unit="Hz" onCommit={(v) => onChangeAnalyses({ ...doc.analyses, ac: { ...ac, stop: v } })} />
        </div>
        <p className="text-xs text-muted-foreground">Select a part on the schematic to edit it. Edits re-simulate live on ngspice.</p>
      </div>
    )
  }
  const taken = new Set(doc.parts.filter((p) => p.ref !== part.ref || p.lib !== part.lib).map((p) => p.ref))
  return <PartInspector key={part.id} doc={doc} part={part} values={values} netlist={netlist} taken={taken} onChangePart={onChangePart} {...actions} />
}

const SOURCE_FIELDS: Record<string, [string, string, string][]> = {
  SIN: [["dc", "Offset", ""], ["ampl", "Amplitude", ""], ["f", "Frequency", "Hz"], ["td", "Delay", "s"], ["theta", "Damping", "1/s"], ["phase", "Phase", "°"]],
  PULSE: [["y1", "Initial", ""], ["y2", "Pulsed", ""], ["td", "Delay", "s"], ["tr", "Rise", "s"], ["tf", "Fall", "s"], ["tw", "Width", "s"], ["per", "Period", "s"]],
  EXP: [["y1", "Initial", ""], ["y2", "Pulsed", ""], ["td1", "Rise delay", "s"], ["tau1", "Rise τ", "s"], ["td2", "Fall delay", "s"], ["tau2", "Fall τ", "s"]],
  WHITENOISE: [["rms", "RMS", ""], ["dt", "Step", "s"]],
}

const KIND_NAME: Record<string, string> = {
  R: "Resistor", C: "Capacitor", L: "Inductor", V: "Voltage source", I: "Current source", D: "Diode", NPN: "NPN BJT", PNP: "PNP BJT",
  NMOS: "N-MOSFET", PMOS: "P-MOSFET", NJFET: "N-JFET", PJFET: "P-JFET", OPAMP: "Op-amp", "555": "555 timer", REG: "Linear regulator",
  REGADJ: "Adjustable regulator", SWITCH: "Switch", VSWITCH: "Voltage-controlled switch", SUBCKT: "Subcircuit",
}

function modelText(sim: ResolvedSim): string | null {
  if (sim.type && /\(/.test(sim.type) && sim.model) return `.model ${sim.model} ${sim.type}`
  if (sim.model) return `${sim.model}${Object.keys(sim.params).length ? ` ${formatParams(sim.params)}` : ""}`
  return null
}

interface PartProps {
  doc: CircuitDoc
  part: Part
  values: Record<string, number>
  netlist: Netlist
  taken: Set<string>
  onChangePart: Props["onChangePart"]
  onRotate: () => void
  onMirror: () => void
  onDuplicate: () => void
  onDelete: () => void
  series: Props["series"]
  time: number | null
  onAddToSweep: (target: string) => void
}

// E-series preferred values (one decade)
const E_SERIES: Record<string, number[]> = {
  E6: [1, 1.5, 2.2, 3.3, 4.7, 6.8],
  E12: [1, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2],
  E24: [1, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2, 2.2, 2.4, 2.7, 3, 3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1],
  E96: Array.from({ length: 96 }, (_, i) => Number((10 ** (i / 96)).toPrecision(3))),
}
/** Nearest preferred value (log distance). */
export function snapE(v: number, series: string): number {
  const list = E_SERIES[series]
  if (!list || !(v > 0)) return v
  const dec = 10 ** Math.floor(Math.log10(v))
  let best = v, err = Infinity
  for (const d of [dec / 10, dec, dec * 10]) for (const m of list) {
    const c = m * d, e = Math.abs(Math.log(c / v))
    if (e < err) { err = e; best = c }
  }
  return Number(best.toPrecision(3))
}
const compact = (v: number) => formatSI(v, "").replace(/\s/g, "").replace("µ", "u")

/** Sparkline of a signal over the run, with the playback time marked. */
function Spark({ s, t, color }: { s: { x: number[]; y: number[] }; t: number | null; color: string }) {
  const n = s.x.length, step = Math.max(1, Math.floor(n / 300))
  let lo = Infinity, hi = -Infinity
  for (let i = 0; i < n; i += step) { lo = Math.min(lo, s.y[i]); hi = Math.max(hi, s.y[i]) }
  const span = hi - lo || 1, x0 = s.x[0], xs = s.x[n - 1] - x0 || 1
  const pts: string[] = []
  for (let i = 0; i < n; i += step) pts.push(`${(((s.x[i] - x0) / xs) * 300).toFixed(1)},${(38 - ((s.y[i] - lo) / span) * 34).toFixed(1)}`)
  const tx = t !== null ? ((t - x0) / xs) * 300 : null
  return (
    <svg viewBox="0 0 300 40" className="h-10 w-full" preserveAspectRatio="none">
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      {tx !== null && <line x1={tx} x2={tx} y1={0} y2={40} stroke="var(--canvas-selection)" strokeWidth={1} vectorEffect="non-scaling-stroke" />}
    </svg>
  )
}

function PartInspector({ doc, part, values, netlist, taken, onChangePart, onRotate, onMirror, onDuplicate, onDelete, series, time, onAddToSweep }: PartProps) {
  const sym = symbolFor(part)!
  const sim = resolveSim(part)
  const resolved = sim && !("error" in sim) ? sim : null
  const params = resolved?.params ?? parseParams(part.sim?.Params)
  const setParams = (patch: Record<string, string>) => onChangePart(part.id, { sim: { ...part.sim, Params: formatParams({ ...params, ...patch }) } })
  const passive = resolved && (resolved.kind === "R" || resolved.kind === "C" || resolved.kind === "L") && resolved.type !== "POT"
  const unitSym = resolved?.kind === "R" ? "Ω" : resolved?.kind === "C" ? "F" : resolved?.kind === "L" ? "H" : ""
  const numeric = parseValue(part.value)
  const [base] = useState(() => Math.log10(Math.max(numeric ?? 1, 1e-15)))
  const pins = placedPins(part).map((p) => {
    const net = netlist.pinNet.get(`${part.ref}.${p.n}`)
    return { ...p, net, v: net === "0" ? 0 : net ? values[`V(${net})`] : undefined }
  })
  const probe = partProbe(part)
  const i = probe ? values[probe] : undefined
  const vAcross = pins.length === 2 && pins.every((p) => p.v !== undefined) ? pins[0].v! - pins[1].v! : NaN
  const label = isLabel(part)
  const srcType = resolved && (resolved.kind === "V" || resolved.kind === "I") ? (resolved.type ?? "DC") : null
  const mt = resolved ? modelText(resolved) : null
  const eSeries = part.fields?.Series ?? "none"
  const setField = (k: string, v: string) => onChangePart(part.id, { fields: { ...part.fields, [k]: v } })
  const siblings = doc.parts.filter((p) => p.ref === part.ref && p.lib === part.lib).map((p) => p.unit)

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-3 p-4">
        <div className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-muted">
          <SymbolThumb sym={sym} unit={part.unit} className="size-10" pad={4} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-lg font-semibold">{label ? part.net : sym.power ? part.value : displayRef(part)}</span>
            {resolved ? <Badge variant="secondary" className="bg-success-subtle text-success">Sim</Badge> : sim && "error" in sim ? <Badge variant="secondary">No model</Badge> : null}
          </div>
          <div className="truncate text-xs text-muted-foreground" title={sym.desc}>{sym.desc || sym.name}</div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">{sym.id}</div>
        </div>
        {!label && !sym.power && (
          <Tooltip><TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={() => onChangePart(part.id, { sim: { ...part.sim, Exclude: part.sim?.Exclude === "1" ? undefined : "1" } })}>
              {part.sim?.Exclude === "1" ? <EyeOff /> : <Eye />}
            </Button>
          </TooltipTrigger><TooltipContent>{part.sim?.Exclude === "1" ? "Excluded from simulation" : "Included in simulation"}</TooltipContent></Tooltip>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm"><Ellipsis /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onRotate}>Rotate 90° <span className="ml-auto text-xs text-muted-foreground">⌘R</span></DropdownMenuItem>
            <DropdownMenuItem onClick={onMirror}>Mirror <span className="ml-auto text-xs text-muted-foreground">X</span></DropdownMenuItem>
            <DropdownMenuItem onClick={onDuplicate}>Duplicate <span className="ml-auto text-xs text-muted-foreground">⌘D</span></DropdownMenuItem>
            {sym.datasheet && /^https?:/.test(sym.datasheet) && <DropdownMenuItem asChild><a href={sym.datasheet} target="_blank" rel="noreferrer">Open datasheet</a></DropdownMenuItem>}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onDelete}>Delete <span className="ml-auto text-xs">⌫</span></DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Tabs defaultValue="props" className="min-h-0 flex-1 gap-0">
        <TabsList className="mx-4 flex w-auto">
          <TabsTrigger value="props" className="flex-1">Properties</TabsTrigger>
          <TabsTrigger value="model" className="flex-1" disabled={label || sym.power}>Model</TabsTrigger>
          <TabsTrigger value="footprint" className="flex-1" disabled={label || sym.power}>Footprint</TabsTrigger>
        </TabsList>
        <TabsContent value="props" className="min-h-0 overflow-auto">
          <div className="flex flex-col gap-4 p-4">
            {label ? (
              <TextField label="Net name" value={part.net ?? ""} mono onCommit={(v) => onChangePart(part.id, { net: v })}
                validate={(v) => (/^[A-Za-z_+\-][\w+\-.]*$/.test(v) ? null : "Start with a letter; use letters, digits, _ + - .")} />
            ) : sym.power ? (
              <TextField label="Net (power symbol)" value={part.value} mono onCommit={(v) => onChangePart(part.id, { value: v })}
                hint={/^(gnd|gnda|gndd|earth|0)$/i.test(part.value) ? "Ground — SPICE node 0" : "Every power symbol with this name is the same net. Add a source to drive it."} />
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <TextField label="Reference" value={part.ref} mono onCommit={(v) => onChangePart(part.id, { ref: v })}
                  validate={(v) => (!/^[A-Za-z][\w]*$/.test(v) ? "Letters, digits and _ only" : taken.has(v) ? `${v} is already used` : null)} />
                <TextField label="Value" value={part.value} mono onCommit={(v) => onChangePart(part.id, { value: v })}
                  validate={(v) => (passive && parseValue(v) === null ? "e.g. 4.7k, 4k7, 100n" : null)} />
              </div>
            )}
            {sym.units.length > 1 && (
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">Unit</span>
                <Select value={String(part.unit)} onValueChange={(v) => onChangePart(part.id, { unit: Number(v) })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {sym.units.map((u, k) => (
                      <SelectItem key={k} value={String(k + 1)} disabled={k + 1 !== part.unit && siblings.includes(k + 1)}>
                        Unit {unitLetter(k + 1)}{u.name ? ` · ${u.name}` : u.pins.some((p) => p.t === "power_in") && u.pins.every((p) => p.t === "power_in") ? " · power" : ""}{k + 1 !== part.unit && siblings.includes(k + 1) ? " (placed)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            )}
            {passive && numeric !== null && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-muted-foreground">Live tune</span>
                  <Badge variant="secondary" className="bg-success-subtle text-success">{formatSI(numeric, unitSym)}</Badge>
                  <div className="flex-1" />
                  <Select value={eSeries} onValueChange={(v) => { setField("Series", v); if (v !== "none") onChangePart(part.id, { value: compact(snapE(numeric, v)), fields: { ...part.fields, Series: v } }) }}>
                    <SelectTrigger size="sm" className="h-7 w-24 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>{["none", "E6", "E12", "E24", "E96"].map((e) => <SelectItem key={e} value={e}>{e === "none" ? "Any value" : e}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <Slider value={[Math.min(base + 1, Math.max(base - 1, Math.log10(Math.max(numeric, 1e-15))))]} min={base - 1} max={base + 1} step={0.01}
                  onValueChange={([v]) => onChangePart(part.id, { value: compact(eSeries === "none" ? Number((10 ** v).toPrecision(3)) : snapE(10 ** v, eSeries)) })} />
                <div className="flex justify-between font-mono text-xs text-muted-foreground">
                  <span>{formatSI(10 ** (base - 1), unitSym)}</span><span>{formatSI(10 ** (base + 1), unitSym)}</span>
                </div>
              </div>
            )}
            {passive && (
              <div className="grid grid-cols-2 gap-3">
                <TextField label="Tolerance (%)" value={part.fields?.Tolerance ?? (resolved!.kind === "R" ? "1" : "10")} mono onCommit={(v) => setField("Tolerance", v)}
                  validate={(v) => (parseValue(v) === null ? "A number" : null)} />
                {resolved!.kind === "R" && <TextField label="Power rating (W)" value={part.fields?.Power ?? "0.25"} mono onCommit={(v) => setField("Power", v)} validate={(v) => (parseValue(v) === null ? "A number" : null)} />}
                {resolved!.kind === "R" && <TextField label="Tempco (ppm/°C)" value={part.fields?.Tempco ?? "100"} mono onCommit={(v) => setField("Tempco", v)} validate={(v) => (parseValue(v) === null ? "A number" : null)} />}
                {resolved!.kind === "C" && <TextField label="Voltage rating (V)" value={part.fields?.Voltage ?? "50"} mono onCommit={(v) => setField("Voltage", v)} validate={(v) => (parseValue(v) === null ? "A number" : null)} />}
                {resolved!.kind === "L" && <TextField label="Current rating (A)" value={part.fields?.Current ?? "1"} mono onCommit={(v) => setField("Current", v)} validate={(v) => (parseValue(v) === null ? "A number" : null)} />}
              </div>
            )}
            {resolved?.type === "POT" && (
              <div className="flex flex-col gap-2">
                <span className="text-xs font-medium text-muted-foreground">Wiper position · {Math.round(Number(params.pos ?? 0.5) * 100)} %</span>
                <Slider value={[Number(params.pos ?? 0.5)]} min={0} max={1} step={0.01} onValueChange={([v]) => setParams({ pos: v.toFixed(2) })} />
              </div>
            )}
            {resolved?.kind === "SWITCH" && (
              <label className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
                Closed <Switch checked={/^(1|true|on|closed)$/i.test(params.closed ?? "0")} onCheckedChange={(c) => setParams({ closed: c ? "1" : "0" })} />
              </label>
            )}
            {srcType && (
              <div className="flex flex-col gap-3">
                <div className="text-sm font-medium">{srcType === "DC" ? "DC source" : `${srcType} waveform`}</div>
                {srcType === "DC" ? (
                  <TextField label={resolved!.kind === "V" ? "Voltage" : "Current"} value={params.dc ?? part.value} mono
                    validate={(v) => (parseValue(v) === null ? "A number, e.g. 5, 3.3, 100m" : null)}
                    onCommit={(v) => (params.dc !== undefined ? setParams({ dc: v }) : onChangePart(part.id, { value: v }))} />
                ) : srcType === "PWL" ? (
                  <TextField label="Points (time value …)" value={params.pwl ?? ""} mono onCommit={(v) => setParams({ pwl: v })} hint="e.g. 0 0 1m 5 2m 5 3m 0" />
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    {(SOURCE_FIELDS[srcType] ?? []).map(([k, l, u]) => (
                      <TextField key={k} label={`${l}${u ? ` (${u})` : ""}`} value={params[k] ?? ""} mono onCommit={(v) => setParams({ [k]: v })}
                        validate={(v) => (v === "" || parseValue(v) !== null ? null : "Number with SI prefix")} />
                    ))}
                  </div>
                )}
                <TextField label="AC magnitude (for AC sweep)" value={params.ac ?? ""} mono onCommit={(v) => setParams({ ac: v })}
                  validate={(v) => (v === "" || parseValue(v) !== null ? null : "Number")} />
              </div>
            )}
            {!label && !sym.power && (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={part.sim?.Exclude !== "1"} onCheckedChange={(c) => onChangePart(part.id, { sim: { ...part.sim, Exclude: c ? undefined : "1" } })} />
                Include in simulation
              </label>
            )}
          </div>
          {!label && !sym.power && (<>
            <Separator />
            <div className="flex flex-col gap-2 p-4">
              <div className="text-sm font-medium">Live readings</div>
              <div className="flex gap-2">
                {pins.length === 2 && <Reading k="Voltage" v={formatSI(vAcross, "V")} />}
                <Reading k={probe ? probe.split("(")[0] : "Current"} v={i !== undefined ? formatSI(i, "A") : "—"} />
                {pins.length === 2 && <Reading k="Power" v={i !== undefined && Number.isFinite(vAcross) ? formatSI(Math.abs(vAcross * i), "W") : "—"} />}
              </div>
              {resolved?.kind === "R" && i !== undefined && Number.isFinite(vAcross) && (() => {
                const rating = parseValue(part.fields?.Power ?? "0.25") ?? 0.25
                const frac = Math.abs(vAcross * i) / rating
                return (
                  <div className="flex flex-col gap-1">
                    <div className="flex justify-between text-xs"><span className="text-muted-foreground">Power vs rating</span><span className={`font-mono ${frac > 1 ? "text-destructive" : frac > 0.5 ? "text-warning" : ""}`}>{(frac * 100).toFixed(frac < 0.1 ? 2 : 0)} %</span></div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className={`h-full rounded-full ${frac > 1 ? "bg-destructive" : frac > 0.5 ? "bg-warning" : "bg-success"}`} style={{ width: `${Math.min(100, frac * 100)}%` }} /></div>
                  </div>
                )
              })()}
              {probe && series(probe) && (
                <div className="flex flex-col gap-1">
                  <div className="flex justify-between font-mono text-[11px] text-muted-foreground"><span>{probe} · whole run</span>{time !== null && <span>t = {formatSI(time, "s", 3)}</span>}</div>
                  <Spark s={series(probe)!} t={time} color="var(--canvas-current)" />
                </div>
              )}
            </div>
          </>)}
          <Separator />
          <div className="p-4">
            <div className="mb-2 text-sm font-medium">Pins</div>
            <table className="w-full font-mono text-xs">
              <thead className="text-left text-muted-foreground"><tr><th className="pb-1 font-normal">#</th><th className="pb-1 font-normal">Name</th><th className="pb-1 font-normal">Net</th><th className="pb-1 text-right font-normal">V</th></tr></thead>
              <tbody>
                {pins.map((p) => (
                  <tr key={p.n} className="border-t">
                    <td className="py-1">{p.n}</td>
                    <td className="py-1">{p.name.replace(/~\{([^}]*)\}/g, "$1") || "—"}</td>
                    <td className="py-1">{p.net === "0" ? "GND" : p.net ?? "—"}</td>
                    <td className="py-1 text-right">{p.v !== undefined ? formatSI(p.v, "V") : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!label && !sym.power && (
            <div className={cn("grid gap-2 px-4 pb-4", sym.datasheet && /^https?:/.test(sym.datasheet) ? "grid-cols-2" : "grid-cols-1")}>
              <Button variant="outline" size="sm" className="w-full" disabled={parseValue(part.value) === null} onClick={() => onAddToSweep(`${part.ref}.value`)}><SlidersHorizontal /> Add to sweep</Button>
              {sym.datasheet && /^https?:/.test(sym.datasheet) && (
                <Button variant="outline" size="sm" onClick={() => openExternal(sym.datasheet!)}><FileText /> Datasheet</Button>
              )}
            </div>
          )}
        </TabsContent>
        <TabsContent value="model" className="min-h-0 overflow-auto">
          <div className="flex flex-col gap-3 p-4">
            {sim && "error" in sim ? (
              <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">Not simulated: {sim.error}. The part stays on the schematic; its pins are left open in the simulation.</p>
            ) : resolved && (<>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <span className="text-muted-foreground">Device</span><span>{KIND_NAME[resolved.kind] ?? resolved.kind}</span>
                <span className="text-muted-foreground">Source</span><span>{resolved.origin === "inferred" ? "Inferred from symbol" : resolved.origin === "symbol" ? "Symbol Sim.* fields" : "Part override"}</span>
                {resolved.model && (<><span className="text-muted-foreground">Model</span><span className="font-mono">{resolved.model}</span></>)}
              </div>
              {resolved.note && <p className="text-xs text-muted-foreground">{resolved.note}</p>}
              {mt && (
                <div className="relative rounded-lg border bg-muted/50 p-3 pr-9 font-mono text-[11px] leading-relaxed break-all">
                  {mt}
                  <Button variant="ghost" size="icon-sm" className="absolute right-1 top-1" onClick={() => { navigator.clipboard.writeText(mt); toast("Model copied") }}><Copy /></Button>
                </div>
              )}
              <TextField label="Sim.Params" value={part.sim?.Params ?? ""} mono onCommit={(v) => onChangePart(part.id, { sim: { ...part.sim, Params: v || undefined } })}
                hint="key=value pairs, e.g. gain=200k pole=10 — override the model" />
            </>)}
            {sym.datasheet && /^https?:/.test(sym.datasheet) && (
              <Button variant="outline" size="sm" onClick={() => openExternal(sym.datasheet!)}><ExternalLink /> Datasheet</Button>
            )}
          </div>
        </TabsContent>
        <TabsContent value="footprint" className="min-h-0 overflow-auto">
          <div className="flex flex-col gap-3 p-4">
            <div className="flex items-center gap-3 rounded-lg border bg-card p-3">
              <div className="flex size-10 items-center justify-center rounded-md bg-muted"><Footprints className="size-5 text-muted-foreground" /></div>
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-sm">{(part.footprint ?? sym.footprint ?? "").split(":")[1] || "No footprint"}</div>
                <div className="truncate text-xs text-muted-foreground">{(part.footprint ?? sym.footprint ?? "").split(":")[0] || "Assign one for the PCB"}</div>
              </div>
            </div>
            <TextField label="Footprint (Library:Name)" value={part.footprint ?? sym.footprint ?? ""} mono onCommit={(v) => onChangePart(part.id, { footprint: v || undefined })}
              validate={(v) => (v === "" || /^[^:\s]+:[^:\s]+$/.test(v) ? null : "Use Library:Footprint, e.g. Resistor_SMD:R_0603_1608Metric")} />
            {sym.footprintFilters?.length ? <p className="text-xs text-muted-foreground">Suggested by KiCad: <span className="font-mono">{sym.footprintFilters.join("  ")}</span></p> : null}
            <p className="text-xs text-muted-foreground">Footprints are used by the PCB editor (later milestone); the simulation doesn't need them.</p>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
