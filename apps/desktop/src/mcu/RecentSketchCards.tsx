// Recently used sketches as cards with a preview of their wiring (Start screen).
import { Trash2, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { timeAgo } from "@/lib/projects"
import { McuCanvas } from "./McuCanvas"
import { forgetSketch, type RecentSketch } from "./recent"

export default function RecentSketchCards({ list, dark, onOpen, onDelete }: { list: RecentSketch[]; dark: boolean; onOpen: (s: RecentSketch) => void; onDelete?: (s: RecentSketch) => void }) {
  return (
    <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
      {list.map((s) => (
        <div key={s.path} role="button" tabIndex={0} onClick={() => onOpen(s)} onKeyDown={(e) => e.key === "Enter" && onOpen(s)} title={s.path}
          className="group relative flex cursor-pointer flex-col overflow-hidden rounded-xl border bg-card text-left transition-colors hover:border-ring">
          <div className="h-[150px] border-b">
            <McuCanvas diagram={s.diagram} onChange={() => {}} frame={null} running={false} onUi={() => {}} selected={null} onSelect={() => {}} onSettings={() => {}} onRestart={() => {}} dark={dark} thumb />
          </div>
          <div className="flex flex-col gap-1 p-3">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium">{s.name}</span>
              <div className="flex-1" />
              <Badge variant="secondary">{s.project ? s.project : "Sketch"}</Badge>
            </div>
            <span className="truncate text-xs text-muted-foreground">{timeAgo(s.time)} · {/* older entries keep a short Arduino id ("uno") */ !s.board ? "No board" : s.board.includes(" ") ? s.board : `Arduino ${s.board[0].toUpperCase()}${s.board.slice(1)}`} · {s.parts} part{s.parts === 1 ? "" : "s"}</span>
          </div>
          {onDelete && <button title="Delete (moves the sketch folder to the Trash)" onClick={(e) => { e.stopPropagation(); onDelete(s) }}
            className="absolute right-9 top-2 hidden rounded-md border bg-background p-1 text-muted-foreground hover:text-destructive group-hover:block"><Trash2 className="size-3.5" /></button>}
          <button title="Remove from the list (the folder stays)" onClick={(e) => { e.stopPropagation(); forgetSketch(s.path) }}
            className="absolute right-2 top-2 hidden rounded-md border bg-background p-1 text-muted-foreground hover:text-foreground group-hover:block"><X className="size-3.5" /></button>
        </div>
      ))}
    </div>
  )
}
