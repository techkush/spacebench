import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { EXAMPLES, loadExample } from "@/editor/examples"
import type { Doc } from "@/editor/model"
import { cn } from "@/lib/utils"
import { CircuitThumb } from "./CircuitThumb"

const ANALYSIS: Record<string, string> = { tran: "Transient", ac: "AC sweep", op: "Operating point", dc: "DC sweep" }

interface Props {
  open: boolean
  onOpenChange: (o: boolean) => void
  currentTitle: string
  onOpen: (id: string) => void
}

/** File → Examples…: every example circuit as a drawing with its title. */
export function ExamplesDialog({ open, onOpenChange, currentTitle, onOpen }: Props) {
  const [docs, setDocs] = useState<Record<string, Doc>>({})
  useEffect(() => {
    if (!open) return
    let live = true
    for (const e of EXAMPLES) if (!docs[e.id]) loadExample(e.id).then((d) => live && setDocs((x) => ({ ...x, [e.id]: d }))).catch(() => {})
    return () => { live = false }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(760px,88vh)] max-w-[min(1100px,94vw)] flex-col gap-0 p-0 sm:max-w-[min(1100px,94vw)]">
        <div className="border-b px-6 pb-4 pt-5">
          <DialogTitle>Examples</DialogTitle>
          <DialogDescription>Ready-to-simulate circuits built from KiCad parts. Open one to explore, edit and simulate it.</DialogDescription>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4 p-6">
            {EXAMPLES.map((e) => {
              const d = docs[e.id]
              return (
                <button key={e.id} onClick={() => { onOpen(e.id); onOpenChange(false) }}
                  className={cn("group flex flex-col overflow-hidden rounded-xl border bg-card text-left transition-colors hover:border-ring", currentTitle === e.title && "border-ring ring-2 ring-ring/20")}>
                  <div className="flex h-40 items-center justify-center border-b bg-canvas p-3">
                    {d ? <CircuitThumb doc={d} className="h-full w-full" /> : <Loader2 className="size-5 animate-spin text-muted-foreground" />}
                  </div>
                  <div className="flex flex-col gap-1 p-3">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{e.title}</span>
                      {currentTitle === e.title && <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">open</Badge>}
                    </div>
                    <span className="line-clamp-2 text-xs text-muted-foreground">{e.description}</span>
                    {d && <span className="mt-1 font-mono text-[10px] text-muted-foreground">{d.parts.filter((p) => !p.lib.startsWith("power:") && !p.lib.startsWith("@")).length} parts · {ANALYSIS[d.defaultAnalysis]}</span>}
                  </div>
                </button>
              )
            })}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
