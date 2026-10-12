// Start screen → Trash: what was deleted, restore it, or delete it forever.
import { useEffect, useState } from "react"
import { CircuitBoard, FolderOpen, Library, Loader2, Microchip, RotateCcw, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { timeAgo } from "@/lib/projects"
import type { ProjectFS } from "@/lib/projectfs"
import { deleteForever, emptyTrash, listTrash, restoreFromTrash, type TrashItem } from "@/lib/trash"

const ICON = { sketch: Microchip, project: FolderOpen, library: Library, folder: CircuitBoard }
const KIND = { sketch: "Sketch", project: "Project", library: "Library", folder: "Folder" }

export function TrashPage({ fs, root, version, onRestored }: { fs: ProjectFS; root: string | null; version: number; onRestored: (item: TrashItem, path: string) => void }) {
  const [items, setItems] = useState<TrashItem[] | null>(null)
  const [ask, setAsk] = useState<{ title: string; text: string; run: () => Promise<void> } | null>(null)
  const load = () => { if (root) listTrash(fs, root).then(setItems).catch(() => setItems([])) }
  useEffect(load, [fs, root, version]) // eslint-disable-line react-hooks/exhaustive-deps
  const restore = async (it: TrashItem) => {
    try { const to = await restoreFromTrash(fs, it); toast.success(`Restored ${it.name}`, { description: to }); onRestored(it, to); load() }
    catch (e) { toast.error(String(e instanceof Error ? e.message : e)) }
  }
  return (
    <>
      <div className="mb-8 flex items-end gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-3xl font-semibold tracking-tight">Trash</h1>
          <p className="mt-2 text-muted-foreground">Deleted sketches and projects wait here until you restore them or delete them forever.</p>
          {root && <p className="mt-1 font-mono text-[11px] text-muted-foreground">{root}</p>}
        </div>
        <Button variant="outline" disabled={!items?.length} className="hover:text-destructive"
          onClick={() => setAsk({ title: "Empty the Trash?", text: `${items?.length} item${items?.length === 1 ? "" : "s"} will be deleted forever. This can't be undone.`, run: async () => { const n = await emptyTrash(fs, root!); toast(`Deleted ${n} item${n === 1 ? "" : "s"} forever`); load() } })}>
          <Trash2 /> Empty Trash
        </Button>
      </div>
      {!items ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Reading the Trash…</div> : !items.length ? (
        <div className="flex h-40 flex-col items-center justify-center gap-1 rounded-xl border border-dashed text-sm text-muted-foreground">
          <Trash2 className="size-6" /><span>The Trash is empty.</span>
        </div>
      ) : (
        <div className="divide-y rounded-xl border bg-card">
          {items.map((it) => {
            const Icon = ICON[it.kind] ?? FolderOpen
            return (
              <div key={it.id} className="flex items-center gap-3 px-4 py-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-background"><Icon className="size-4" /></span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{it.name}</div>
                  <div className="truncate text-xs text-muted-foreground">{KIND[it.kind]} · deleted {timeAgo(it.time)} · from <span className="font-mono">{it.original}</span></div>
                </div>
                <Button size="sm" variant="outline" onClick={() => restore(it)}><RotateCcw /> Restore</Button>
                <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive"
                  onClick={() => setAsk({ title: `Delete ${it.name} forever?`, text: "Its folder and every file in it are removed. This can't be undone.", run: async () => { await deleteForever(fs, it); toast(`Deleted ${it.name} forever`); load() } })}>
                  <Trash2 /> Delete Forever
                </Button>
              </div>
            )
          })}
        </div>
      )}
      <Dialog open={!!ask} onOpenChange={(o) => !o && setAsk(null)}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader><DialogTitle>{ask?.title}</DialogTitle><DialogDescription>{ask?.text}</DialogDescription></DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAsk(null)}>Cancel</Button>
            <Button variant="destructive" onClick={async () => { const a = ask; setAsk(null); try { await a?.run() } catch (e) { toast.error(String(e instanceof Error ? e.message : e)) } }}>Delete Forever</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
