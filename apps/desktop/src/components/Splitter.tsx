// Drag handle between two panes. Reports pointer movement; double-click resets.
import { useRef, useState } from "react"

import { cn } from "@/lib/utils"

interface Props {
  /** "x": a vertical bar that resizes widths; "y": a horizontal bar that resizes heights */
  axis: "x" | "y"
  onDrag: (delta: number) => void
  onReset?: () => void
  className?: string
}

export function Splitter({ axis, onDrag, onReset, className }: Props) {
  const last = useRef(0)
  const [active, setActive] = useState(false)
  // a ref, not the state: the first pointer moves arrive before React re-renders
  const dragging = useRef(false)
  return (
    <div
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      title="Drag to resize · double-click to reset"
      onPointerDown={(e) => {
        e.preventDefault()
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
        last.current = axis === "x" ? e.clientX : e.clientY
        dragging.current = true
        setActive(true)
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return
        const pos = axis === "x" ? e.clientX : e.clientY
        const d = pos - last.current
        if (d) { last.current = pos; onDrag(d) }
      }}
      onPointerUp={() => { dragging.current = false; setActive(false) }}
      onPointerCancel={() => { dragging.current = false; setActive(false) }}
      onDoubleClick={onReset}
      className={cn(
        "group relative z-20 shrink-0 select-none",
        axis === "x" ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize",
        className,
      )}
    >
      {/* wider invisible hit area, thin visible line */}
      <div className={cn("absolute", axis === "x" ? "inset-y-0 -left-1.5 -right-1.5" : "inset-x-0 -top-1.5 -bottom-1.5")} />
      <div className={cn("absolute bg-border transition-colors group-hover:bg-ring", active && "bg-ring", axis === "x" ? "inset-y-0 left-0 w-px group-hover:w-1 group-hover:-left-px" : "inset-x-0 top-0 h-px group-hover:h-1 group-hover:-top-px", active && (axis === "x" ? "w-1" : "h-1"))} />
    </div>
  )
}
