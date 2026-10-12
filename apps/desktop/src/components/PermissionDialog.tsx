// The assistant asks before it installs anything: a dialog with exactly what will happen, and
// Allow / Don't allow. `usePermission()` gives an `ask()` that resolves with the answer.
import { Download } from "lucide-react"
import { useCallback, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"

export function usePermission() {
  const [perm, setPerm] = useState<{ title: string; detail: string; reason: string; resolve: (ok: boolean) => void } | null>(null)
  const ask = useCallback((title: string, detail: string, reason: string) => new Promise<boolean>((resolve) => setPerm({ title, detail, reason, resolve })), [])
  const answer = (ok: boolean) => { perm?.resolve(ok); setPerm(null) }
  const dialog = (
    <Dialog open={!!perm} onOpenChange={(o) => { if (!o) answer(false) }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{perm?.title}</DialogTitle>
          <DialogDescription>The assistant asks to do this{perm?.reason ? ` — ${perm.reason}` : "."}</DialogDescription>
        </DialogHeader>
        <pre className="whitespace-pre-wrap break-all rounded-md bg-muted px-3 py-2 font-mono text-xs">{perm?.detail}</pre>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => answer(false)}>Don't allow</Button>
          <Button onClick={() => answer(true)}><Download /> Allow</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
  return { ask, dialog }
}
