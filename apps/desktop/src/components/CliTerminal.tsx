// The dock's Terminal tab: live output of the `claude` command behind the AI assistant.
import { useEffect, useRef } from "react"

import { cliLog, useCliLog } from "@/lib/ai/cliLog"
import { cn } from "@/lib/utils"

const TONE = { cmd: "text-info", system: "text-muted-foreground", thinking: "text-muted-foreground", result: "text-success", error: "text-destructive", assistant: "text-foreground", raw: "text-foreground" } as const

export function CliTerminal() {
  const lines = useCliLog()
  const el = useRef<HTMLDivElement>(null)
  useEffect(() => { const e = el.current; if (e) e.scrollTop = e.scrollHeight }, [lines])
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {lines.length > 0 && <button className="absolute right-1 top-0 text-muted-foreground hover:text-foreground" onClick={() => cliLog.clear()}>clear</button>}
      <div ref={el} className="min-h-0 flex-1 overflow-auto pr-10 leading-relaxed">
        {lines.map((l, i) => (
          <div key={i} className={cn("whitespace-pre-wrap break-words", TONE[l.kind])}>
            {l.kind === "cmd" ? `$ ${l.text}` : l.kind === "system" ? `# ${l.text}` : l.kind === "assistant" && l.text.length > 600 ? `${l.text.slice(0, 600)}…` : l.text}
          </div>
        ))}
        {!lines.length && <div className="text-muted-foreground">The claude command's output appears here while the AI assistant works.</div>}
      </div>
    </div>
  )
}
