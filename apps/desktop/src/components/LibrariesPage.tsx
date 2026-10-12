// Libraries (Start screen): the user's component libraries, shared by every project.
import { useEffect, useState } from "react"
import { CircleAlert, FolderInput, Library, Loader2, Pencil, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { SymbolThumb } from "@/components/SymbolView"
import { componentSymbol } from "@/kirk/components"
import { createLibrary, listLibraries, type LibraryInfo } from "@/lib/libraries"
import { dirName, type ProjectFS } from "@/lib/projectfs"

export function LibrariesPage({ fs, root, projectName, onEdit, onAddToProject }: {
  fs: ProjectFS
  /** ~/Documents/Space Bench/Libraries */
  root: string | null
  /** the open project (libraries can be added to it) */
  projectName: string | null
  onEdit: (lib: LibraryInfo) => void
  onAddToProject: (lib: LibraryInfo, how: "import" | "copy") => void
}) {
  const [libs, setLibs] = useState<LibraryInfo[] | null>(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState("")
  const [desc, setDesc] = useState("")
  const [err, setErr] = useState<string | null>(null)
  const [del, setDel] = useState<LibraryInfo | null>(null)
  const load = () => { if (root) listLibraries(fs, root).then(setLibs).catch(() => setLibs([])) }
  useEffect(load, [fs, root]) // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    if (!root) return
    try { await createLibrary(fs, root, name, desc || undefined); setCreating(false); setName(""); setDesc(""); load(); toast.success(`Created library ${name}`) }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }
  return (
    <>
      <div className="mb-6 flex items-end gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-[28px] font-semibold tracking-tight">Libraries</h1>
          <p className="mt-1 text-muted-foreground">Your component libraries, shared by every project. Write components once in Kirk, then use them anywhere with <code className="font-mono text-[13px]">import library "Name"</code>.</p>
          {root && <p className="mt-1 font-mono text-[11px] text-muted-foreground">{root}</p>}
        </div>
        <Button onClick={() => { setErr(null); setCreating(true) }}><Plus /> New library</Button>
      </div>
      {!libs ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Reading libraries…</div> : !libs.length ? (
        <div className="rounded-xl border border-dashed p-10 text-center">
          <Library className="mx-auto size-8 text-muted-foreground" />
          <p className="mt-3 font-medium">No libraries yet</p>
          <p className="mt-1 text-sm text-muted-foreground">A library is a Kirk file of components — subcircuits with parameters and pins, like a filter, a driver or a sensor front end.</p>
          <Button className="mt-4" onClick={() => setCreating(true)}><Plus /> Create your first library</Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {libs.map((l) => (
            <div key={l.file} className="flex flex-col rounded-xl border bg-card p-4">
              <div className="flex items-start gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-background"><Library className="size-4" /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2"><span className="font-semibold">{l.name}</span>{l.version && <Badge variant="secondary" className="font-mono">v{l.version}</Badge>}{l.errors.length > 0 && <Badge variant="destructive"><CircleAlert /> {l.errors.length}</Badge>}</div>
                  {l.description && <div className="text-sm text-muted-foreground">{l.description}</div>}
                  <div className="mt-0.5 text-xs text-muted-foreground">{l.components.length} component{l.components.length === 1 ? "" : "s"}</div>
                </div>
              </div>
              {l.components.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {l.components.slice(0, 6).map((c) => (
                    <div key={c.name} className="flex items-center gap-2 rounded-md border bg-background px-2 py-1" title={`${c.description ?? c.name} · pins ${c.pins.join(", ")}`}>
                      <SymbolThumb sym={componentSymbol({ ...c, source: "", body: "", variants: {} })} className="size-7" pad={4} />
                      <span className="font-mono text-xs">{c.name}</span>
                    </div>
                  ))}
                  {l.components.length > 6 && <span className="self-center text-xs text-muted-foreground">+{l.components.length - 6}</span>}
                </div>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => onEdit(l)}><Pencil /> Edit</Button>
                {projectName && <Button size="sm" variant="outline" onClick={() => onAddToProject(l, "import")} title={`Adds  import library "${l.name}"  to the open circuit`}>Use in {projectName}</Button>}
                {projectName && <Button size="sm" variant="outline" onClick={() => onAddToProject(l, "copy")} title="Copies the library into the project's lib/ folder, so the project carries it"><FolderInput /> Copy into project</Button>}
                <div className="flex-1" />
                <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => setDel(l)}><Trash2 /></Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>New library</DialogTitle>
            <DialogDescription>One word — it's how circuits import it: <code className="font-mono">import library "{name || "MyFilters"}"</code></DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Input autoFocus placeholder="MyFilters" value={name} onChange={(e) => { setName(e.target.value); setErr(null) }} onKeyDown={(e) => { if (e.key === "Enter" && name) create() }} />
            <Input placeholder="Description (optional)" value={desc} onChange={(e) => setDesc(e.target.value)} />
            {err && <p className="text-sm text-destructive">{err}</p>}
          </div>
          <DialogFooter><Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button><Button disabled={!name} onClick={create}>Create</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={!!del} onOpenChange={(o) => !o && setDel(null)}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>Delete {del?.name}?</DialogTitle>
            <DialogDescription>Its folder is removed. Projects that import it will report a missing library; projects that carry a copy keep working.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDel(null)}>Cancel</Button>
            <Button variant="destructive" onClick={async () => { if (del) { await fs.remove(dirName(del.file)); setDel(null); load(); toast(`Deleted ${del.name}`) } }}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
