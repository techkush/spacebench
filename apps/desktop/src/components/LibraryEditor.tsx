// Edit a component library: the Kirk code on the left (checked as you type), the components it
// defines on the right with their symbols, parameters and pins. Versions go up from the menu.
import { useEffect, useMemo, useRef, useState } from "react"
import { ArrowLeft, ChevronDown, CircleAlert, CircleCheck, Library, Loader2, Save } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { KirkEditor } from "@/components/KirkEditor"
import { SymbolThumb } from "@/components/SymbolView"
import { emptyDoc } from "@/editor/model"
import { deriveNetlist } from "@/editor/netlist"
import type { Diagnostic } from "@/kirk/ast"
import { compileKirk, type CompileOptions } from "@/kirk/compile"
import { componentsOf, componentSymbol } from "@/kirk/components"
import { parse } from "@/kirk/parser"
import { bumpVersion } from "@/lib/libraries"

export function LibraryEditor({ title, where, text: initial, resolve, onSave, onClose }: {
  title: string
  /** shown under the title: the file's path */
  where: string
  text: string
  resolve: CompileOptions["resolve"]
  onSave: (text: string) => Promise<void>
  onClose: (dirty: boolean) => void
}) {
  const [text, setText] = useState(initial)
  const [saved, setSaved] = useState(initial)
  const [diag, setDiag] = useState<Diagnostic[]>([])
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => { setText(initial); setSaved(initial) }, [initial])
  // check as you type (each component compiled with its defaults)
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      setChecking(true)
      const r = await compileKirk(text, null, { resolve })
      setDiag(r.diagnostics)
      setChecking(false)
    }, 350)
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [text, resolve])
  const parsed = useMemo(() => parse(text), [text])
  const head = parsed.file.items.find((i) => i.k === "library") as { name: string; version?: string } | undefined
  const comps = useMemo(() => componentsOf(parsed.file, text), [parsed, text])
  const errors = diag.filter((d) => d.severity === "error")
  const dirty = text !== saved
  const save = async () => {
    setSaving(true)
    try { await onSave(text); setSaved(text); toast.success(`Saved ${head?.name ?? title}${head?.version ? ` ${head.version}` : ""}`) }
    catch (e) { toast.error(e instanceof Error ? e.message : String(e)) }
    finally { setSaving(false) }
  }
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save() } }
    window.addEventListener("keydown", k)
    return () => window.removeEventListener("keydown", k)
  })
  const blank = useMemo(() => emptyDoc(), [])
  const blankNl = useMemo(() => deriveNetlist(blank), [blank])
  const errorFor = (name: string) => errors.find((d) => d.message.startsWith(`${name}:`))?.message.slice(name.length + 1).trim()

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header data-tauri-drag-region className="flex h-12 shrink-0 items-center gap-3 border-b pl-20 pr-3">
        <Button variant="ghost" size="sm" onClick={() => onClose(dirty)}><ArrowLeft /> Back</Button>
        <Library className="pointer-events-none size-4" />
        <div className="pointer-events-none min-w-0">
          <div className="truncate text-sm font-semibold">{head?.name ?? title} {head?.version && <span className="font-mono text-xs font-normal text-muted-foreground">v{head.version}</span>}</div>
          <div className="truncate font-mono text-[10px] text-muted-foreground">{where}</div>
        </div>
        <div data-tauri-drag-region className="flex-1 self-stretch" />
        {checking ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : errors.length ? <span className="flex items-center gap-1 text-xs text-destructive"><CircleAlert className="size-3.5" /> {errors.length} problem{errors.length > 1 ? "s" : ""}</span> : <span className="flex items-center gap-1 text-xs text-success"><CircleCheck className="size-3.5" /> {comps.length} component{comps.length === 1 ? "" : "s"} OK</span>}
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="outline" size="sm" disabled={!head?.version}>Version <ChevronDown /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {(["patch", "minor", "major"] as const).map((part) => (
              <DropdownMenuItem key={part} onClick={() => setText((t) => bumpVersion(t, part))}>
                {part === "patch" ? "Patch — fixes" : part === "minor" ? "Minor — new components" : "Major — changed pins or parameters"} <span className="ml-auto font-mono text-xs text-muted-foreground">{/(\d+\.\d+\.\d+)/.exec(bumpVersion(text, part).match(/version\s+"([^"]+)"/)?.[1] ?? "")?.[1]}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="sm" disabled={!dirty || saving} onClick={save}>{saving ? <Loader2 className="animate-spin" /> : <Save />} Save</Button>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-h-0 border-r">
          <KirkEditor value={text} onChange={setText} diagnostics={diag} doc={blank} netlist={blankNl} values={{}} measures={{}} asserts={[]} onCursorRef={() => {}} />
        </div>
        <aside className="min-h-0 overflow-auto p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Components</div>
          {!comps.length && <p className="text-sm text-muted-foreground">No components yet. Write one: <code className="font-mono">component Name(param: 1k) {"{ pins a, b … }"}</code></p>}
          <div className="flex flex-col gap-2">
            {comps.map((c) => {
              const err = errorFor(c.name)
              return (
                <div key={c.name} className={`rounded-lg border p-3 ${err ? "border-destructive/50" : ""}`}>
                  <div className="flex items-start gap-3">
                    <div className="flex size-20 shrink-0 items-center justify-center rounded-md border bg-canvas"><SymbolThumb sym={componentSymbol(c)} className="h-full w-full" pad={6} /></div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2"><span className="font-mono text-sm font-semibold">{c.name}</span>{err ? <Badge variant="destructive" className="h-4 px-1 text-[10px]">error</Badge> : null}</div>
                      {c.description && <div className="text-xs text-muted-foreground">{c.description}</div>}
                      <div className="mt-1.5 text-[11px]"><span className="text-muted-foreground">pins </span><span className="font-mono">{c.pins.join(", ") || "—"}</span></div>
                      {c.params.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{c.params.map((p) => <span key={p.name} className="rounded border px-1.5 py-0.5 font-mono text-[10px]">{p.name}{p.type ? `: ${p.type}` : ""}{p.def ? ` = ${p.def}` : ""}</span>)}</div>}
                    </div>
                  </div>
                  {err && <p className="mt-2 text-[11px] text-destructive">{err}</p>}
                  <code className="mt-2 block truncate rounded bg-muted px-2 py-1 font-mono text-[11px]" title="Use it in a circuit">U1 = {c.name}({c.params.filter((p) => !p.def).map((p) => `${p.name}: …`).join(", ")})</code>
                </div>
              )
            })}
          </div>
        </aside>
      </div>
    </div>
  )
}
