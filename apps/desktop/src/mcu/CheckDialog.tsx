// The result of "Check with ngspice": every part's current, voltage and power at this instant.
import { useEffect, useState } from "react"
import { CircleAlert, CircleCheck, Loader2, TriangleAlert } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { simulate, type OpResult } from "@/lib/engine"
import { formatSI } from "@/lib/units"
import type { BoardDef } from "./boards"
import type { Diagram } from "./diagram"
import type { Snapshot } from "./sim"
import { mcuDeck } from "./spice"

interface Row { part: string; what: string; kind: string; i: number; v: number; p: number; flag?: string }

export function CheckDialog({ open, onOpenChange, diagram, board, snapshot }: { open: boolean; onOpenChange: (o: boolean) => void; diagram: Diagram; board: BoardDef | undefined; snapshot: Snapshot | null }) {
  const [state, setState] = useState<{ rows: Row[]; nets: { name: string; v: number }[]; deck: string } | { error: string } | null>(null)
  const [showDeck, setShowDeck] = useState(false)
  useEffect(() => {
    if (!open || !board || !snapshot) return
    setState(null)
    const { net, rows } = mcuDeck(diagram, board, snapshot)
    simulate(net).then((r) => {
      const op = r as OpResult
      const val = (n: string) => { const i = op.names.indexOf(n); return i < 0 ? NaN : op.values[i] }
      const volt = (node: string) => (node === "0" ? 0 : val(`V(${net.nodes.get(node)})`))
      const pinMax = board.chip === "rp2040" ? 0.012 : 0.04
      const out: Row[] = rows.map((x) => {
        const zero = (n: number) => (Math.abs(n) < 1e-12 ? 0 : n)
        // a pin, supply or module: the voltage it holds its net at; a part: the voltage across it
        const i = zero(val(`I(${x.element})`)), v = zero(x.kind === "resistor" || x.kind === "led" ? volt(x.a) - volt(x.b) : volt(x.b))
        const p = Math.abs(i * v)
        const flag = x.kind === "led" && i > 0.02 ? `over 20 mA` : x.kind === "pin" && Math.abs(i) > pinMax ? `over ${pinMax * 1e3} mA` : x.kind === "resistor" && p > 0.25 ? "over ¼ W" : undefined
        return { part: x.part, what: x.what, kind: x.kind, i, v, p, flag }
      }).filter((x) => Number.isFinite(x.i))
      const nets = [...net.nodes].map(([, name]) => ({ name, v: val(`V(${name})`) })).filter((x) => Number.isFinite(x.v)).map((x) => ({ ...x, v: Math.abs(x.v) < 1e-12 ? 0 : x.v }))
      setState({ rows: out, nets, deck: net.text })
    }).catch((e) => setState({ error: e instanceof Error ? e.message : String(e) }))
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const flags = state && "rows" in state ? state.rows.filter((r) => r.flag) : []
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-[760px]">
        <DialogHeader>
          <DialogTitle>Check with ngspice</DialogTitle>
          <DialogDescription>The circuit at this instant — pin levels, sensor outputs, buttons and knobs — solved by ngspice (operating point, real LED diode models).</DialogDescription>
        </DialogHeader>
        {!snapshot && <p className="text-sm text-muted-foreground">Run the sketch first: the check uses the pin levels at the moment you press it.</p>}
        {snapshot && !state && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Solving…</div>}
        {state && "error" in state && <div className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"><CircleAlert className="mt-0.5 size-4 shrink-0" />{state.error}</div>}
        {state && "rows" in state && (
          <div className="min-h-0 flex-1 overflow-auto">
            <div className={`mb-3 flex items-center gap-2 rounded-md px-3 py-2 text-sm ${flags.length ? "bg-warning-subtle text-warning" : "bg-success-subtle text-success"}`}>
              {flags.length ? <TriangleAlert className="size-4" /> : <CircleCheck className="size-4" />}
              {flags.length ? `${flags.length} part${flags.length > 1 ? "s" : ""} over a limit: ${flags.map((f) => `${f.part} (${f.flag})`).join(", ")}` : "Every part is within its limits."}
            </div>
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground"><tr><th className="py-1 font-medium">Part</th><th className="font-medium">Element</th><th className="text-right font-medium">Current</th><th className="text-right font-medium">Voltage</th><th className="text-right font-medium">Power</th><th /></tr></thead>
              <tbody>
                {state.rows.map((r, i) => (
                  <tr key={i} className="border-t">
                    <td className="py-1 font-mono text-xs">{r.part}</td>
                    <td className="text-xs text-muted-foreground">{r.what}</td>
                    <td className="text-right font-mono text-xs tabular-nums">{formatSI(Math.abs(r.i), "A")}</td>
                    <td className="text-right font-mono text-xs tabular-nums">{formatSI(Math.abs(r.v), "V")}</td>
                    <td className="text-right font-mono text-xs tabular-nums">{formatSI(r.p, "W")}</td>
                    <td className="pl-2 text-xs text-warning">{r.flag}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Net voltages</div>
            <div className="mt-1 grid grid-cols-2 gap-x-6 text-xs">
              {state.nets.map((n) => <div key={n.name} className="flex justify-between border-b py-0.5"><span className="truncate font-mono text-muted-foreground">{n.name}</span><span className="font-mono tabular-nums">{formatSI(n.v, "V")}</span></div>)}
            </div>
            <button className="mt-3 text-xs text-muted-foreground underline" onClick={() => setShowDeck((x) => !x)}>{showDeck ? "Hide" : "Show"} the SPICE deck</button>
            {showDeck && <pre className="mt-1 max-h-60 overflow-auto rounded bg-muted p-2 font-mono text-[11px]">{state.deck}</pre>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
