// New project: a name, where its folder goes, and whether it starts from the open circuit.
import { useEffect, useState } from "react"
import { isTauri } from "@tauri-apps/api/core"
import { FolderOpen, FolderPlus, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { join } from "@/lib/projectfs"
import { safeName } from "@/lib/project"

export interface NewProjectRequest { name: string; parent: string; description: string; fromCurrent: boolean }

export function NewProjectDialog({ open, onOpenChange, defaultParent, current, onCreate }: {
  open: boolean
  onOpenChange: (o: boolean) => void
  /** ~/Documents/Space Bench/Projects */
  defaultParent: string
  /** the circuit open in the workspace (offered as the starting point) */
  current: string | null
  onCreate: (r: NewProjectRequest) => Promise<void>
}) {
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [parent, setParent] = useState(defaultParent)
  const [fromCurrent, setFromCurrent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { if (open) { setName(current && current !== "Untitled circuit" ? current : ""); setDescription(""); setParent(defaultParent); setFromCurrent(!!current); setError(null) } }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const browse = async () => {
    const { open: pick } = await import("@tauri-apps/plugin-dialog")
    const dir = await pick({ directory: true, multiple: false, defaultPath: parent })
    if (typeof dir === "string") setParent(dir)
  }
  const create = async () => {
    setBusy(true); setError(null)
    try { await onCreate({ name: safeName(name), parent, description: description.trim(), fromCurrent }); onOpenChange(false) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  const folder = join(parent, safeName(name || "Untitled"))
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><FolderPlus className="size-5" /> New project</DialogTitle>
          <DialogDescription>A project is one folder with everything in it: circuits (Kirk code and schematic), board layouts, component libraries, models and results.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Name</span>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Night light" onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) create() }} />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Description <span className="font-normal text-muted-foreground">(optional)</span></span>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What it's for" />
          </label>
          <div className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Location</span>
            <div className="flex gap-2">
              <Input value={parent} onChange={(e) => setParent(e.target.value)} className="font-mono text-xs" disabled={!isTauri()} />
              {isTauri() && <Button variant="outline" onClick={browse}><FolderOpen /> Browse…</Button>}
            </div>
            <span className="truncate font-mono text-[11px] text-muted-foreground" title={folder}>{folder}/</span>
          </div>
          {current && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={fromCurrent} onCheckedChange={(c) => setFromCurrent(!!c)} />
              Start with the open circuit (“{current}”)
            </label>
          )}
          {error && <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!name.trim() || busy} onClick={create}>{busy && <Loader2 className="animate-spin" />} Create project</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
