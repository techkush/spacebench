// AI assistant panel next to the Kirk editor: chat with Claude, attach schematic
// images, and watch it write the circuit, simulate it and connect probes.
import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { Activity, Check, CircleAlert, Code2, Cpu, Gauge, ImagePlus, Loader2, Plus, RefreshCw, Search, Send, Sparkles, Square, SquareTerminal, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { runAgent, type AgentEvent, type AgentHost, type AgentProfile } from "@/lib/ai/agent"
import { claudeTransport, type Block, type ImageMedia, type Msg, type Transport } from "@/lib/ai/claude"
import { cliLog } from "@/lib/ai/cliLog"
import { claudeCodeTransport, claudeCodeVersion, type CliTransport } from "@/lib/ai/claudecode"
import { setSettings, useSettings } from "@/lib/settings"
import { cn } from "@/lib/utils"

interface Img { media: ImageMedia; data: string; url: string; name: string }
type Item =
  | { kind: "user"; text: string; images: Img[] }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; id: string; name: string; status: "running" | "ok" | "error"; summary?: string; input: Record<string, unknown> }
  | { kind: "error"; text: string }

const SUGGESTIONS = [
  "Design an RC low-pass filter at 1 kHz and show its Bode plot",
  "Build a 555 LED blinker at about 2 Hz and probe the output",
  "Make a non-inverting op-amp amplifier with a gain of 11 and check it with a 100 mV sine",
  "Probe the output and tell me its peak-to-peak voltage",
]

const TOOL_ICON: Record<string, typeof Code2> = { write_kirk: Code2, simulate: Activity, add_probe: Gauge, remove_probe: Gauge, set_meter: Gauge, measure: Gauge, find_parts: Search, get_circuit: Cpu }
const TOOL_LABEL: Record<string, string> = { write_kirk: "Wrote the circuit", simulate: "Simulated", add_probe: "Probe", remove_probe: "Probe", set_meter: "Multimeter", measure: "Measured", find_parts: "Searched parts", get_circuit: "Read the circuit", get_firmware: "Read the firmware", write_firmware: "Wrote the sketch", compile_firmware: "Compiled", run_with_firmware: "Ran with firmware", check_setup: "Checked the setup", install: "Install" }

/** Downscale an image to ≤ 1568 px on the long side (what the model sees anyway) and base64 it. */
async function readImage(file: File): Promise<Img> {
  const url = URL.createObjectURL(file)
  const img = new Image()
  await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = url })
  const k = Math.min(1, 1568 / Math.max(img.width, img.height))
  const c = document.createElement("canvas")
  c.width = Math.round(img.width * k); c.height = Math.round(img.height * k)
  const g = c.getContext("2d")!
  g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height)
  g.drawImage(img, 0, 0, c.width, c.height)
  const media: ImageMedia = file.type === "image/png" ? "image/png" : "image/jpeg"
  const dataUrl = c.toDataURL(media, 0.9)
  return { media, data: dataUrl.split(",")[1], url: dataUrl, name: file.name || "image" }
}

/** Tiny markdown: ``` code blocks, `inline`, **bold**, lists, paragraphs. */
function Markdown({ text }: { text: string }) {
  const parts = text.split(/```(?:\w+)?\n?([\s\S]*?)```/g)
  return (
    <div className="flex flex-col gap-2">
      {parts.map((p, i) => i % 2 === 1
        ? <pre key={i} className="overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-[11px] leading-relaxed">{p.trimEnd()}</pre>
        : p.split(/\n{2,}/).filter((x) => x.trim()).map((para, j) => (
          <div key={`${i}-${j}`} className="whitespace-pre-wrap">
            {para.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((s, k) => s.startsWith("`") ? <code key={k} className="rounded bg-muted px-1 font-mono text-[12px]">{s.slice(1, -1)}</code>
              : s.startsWith("**") ? <strong key={k}>{s.slice(2, -2)}</strong> : <span key={k}>{s}</span>)}
          </div>
        )))}
    </div>
  )
}

// ── conversations outlive the panel: one per session key (the open project / sketch) ──
interface ChatSession { items: Item[]; history: Msg[]; busy: boolean; draft: string; abort: AbortController | null; transport: { key: string; t: Transport } | null }
const sessions = new Map<string, ChatSession>()
const listeners = new Set<() => void>()
const blank = (): ChatSession => ({ items: [], history: [], busy: false, draft: "", abort: null, transport: null })
function sessionOf(key: string): ChatSession { let x = sessions.get(key); if (!x) sessions.set(key, (x = blank())); return x }
function patchSession(key: string, f: (x: ChatSession) => Partial<ChatSession>) {
  const cur = sessionOf(key)
  sessions.set(key, { ...cur, ...f(cur) })
  for (const l of listeners) l()
}
/** Forget a conversation (when its project / sketch closes). Stops a running turn. */
export function clearChat(key: string) {
  sessions.get(key)?.abort?.abort()
  sessions.delete(key)
  for (const l of listeners) l()
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }

export function AiChat({ host, profile, sessionKey = "default", request, onOpenSettings, onOpenTerminal, onClose }: {
  host?: AgentHost; profile?: AgentProfile; sessionKey?: string
  /** a message from the app ("Fix with assistant"): sent once (a new id sends again) */
  request?: { id: number; text: string } | null
  onOpenSettings: () => void; onOpenTerminal: () => void; onClose: () => void
}) {
  const s = useSettings()
  const sess = useSyncExternalStore(subscribe, () => sessionOf(sessionKey))
  const { items, history, busy } = sess
  const setItems = (v: Item[] | ((x: Item[]) => Item[])) => patchSession(sessionKey, (c) => ({ items: typeof v === "function" ? v(c.items) : v }))
  const setHistory = (h: Msg[]) => patchSession(sessionKey, () => ({ history: h }))
  const setBusy = (b: boolean) => patchSession(sessionKey, () => ({ busy: b }))
  const [text, setTextState] = useState(sess.draft)
  const setText = (t: string) => { setTextState(t); sessionOf(sessionKey).draft = t }
  const [images, setImages] = useState<Img[]>([])
  const [keyDraft, setKeyDraft] = useState("")
  const [drag, setDrag] = useState(false)
  const abort = { get current() { return sessionOf(sessionKey).abort }, set current(a: AbortController | null) { sessionOf(sessionKey).abort = a } }
  const scroller = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  // the input grows with what is typed (wrapped lines too) up to its max height
  const input = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { const el = input.current; if (!el) return; el.style.height = "auto"; el.style.height = `${el.scrollHeight}px` }, [text])
  useEffect(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight }, [items])
  // ---- Claude Code CLI: availability, one CLI session per chat, live terminal output
  const cli = s.aiProvider === "claude-code"
  const [cliVersion, setCliVersion] = useState<string | null | undefined>(undefined)
  const checkCli = () => { setCliVersion(undefined); claudeCodeVersion(s.aiCliPath).then(setCliVersion) }
  useEffect(() => { if (cli) checkCli() }, [cli, s.aiCliPath]) // eslint-disable-line react-hooks/exhaustive-deps
  const transport = { get current() { return sessionOf(sessionKey).transport }, set current(t: { key: string; t: Transport } | null) { sessionOf(sessionKey).transport = t } }
  const getTransport = (): Transport => {
    const key = cli ? `cc:${s.aiCliModel}:${s.aiCliPath}` : `api:${s.aiKey}`
    if (!transport.current || transport.current.key !== key) {
      transport.current = { key, t: cli ? claudeCodeTransport({ model: s.aiCliModel, bin: s.aiCliPath, onLine: (l) => cliLog.push(l) }) : claudeTransport(s.aiKey.trim()) }
    }
    return transport.current.t
  }
  const resetSession = () => { const t = transport.current?.t as CliTransport | undefined; t?.reset?.() }
  const ready = cli ? !!cliVersion : !!s.aiKey

  const addFiles = async (files: FileList | File[]) => {
    const list = [...files].filter((f) => f.type.startsWith("image/")).slice(0, 4)
    const read = await Promise.all(list.map(readImage))
    setImages((x) => [...x, ...read].slice(0, 4))
  }

  const send = async (prompt = text) => {
    const t = prompt.trim()
    if ((!t && !images.length) || busy || !ready) return
    const imgs = images
    setText(""); setImages([])
    setItems((x) => [...x, { kind: "user", text: t, images: imgs }])
    const content: Block[] = [
      ...imgs.map((im): Block => ({ type: "image", source: { type: "base64", media_type: im.media, data: im.data } })),
      { type: "text", text: `${t || "Turn this schematic into a Kirk circuit."}${s.aiAutoSimulate ? "" : "\n\n(Do not run simulations unless I ask.)"}` },
    ]
    const next: Msg[] = [...history, { role: "user", content }]
    setBusy(true)
    const ac = new AbortController()
    abort.current = ac
    const onEvent = (e: AgentEvent) => setItems((x) => {
      if (e.kind === "text") return [...x, { kind: "assistant", text: e.text }]
      const i = x.findIndex((y) => y.kind === "tool" && y.id === e.id)
      const item: Item = { kind: "tool", id: e.id, name: e.name, status: e.status, summary: e.summary, input: e.input }
      return i >= 0 ? x.map((y, k) => (k === i ? item : y)) : [...x, item]
    })
    try {
      const h = await runAgent({ transport: getTransport(), model: cli ? s.aiCliModel : s.aiModel, history: next, host, profile, onEvent, signal: ac.signal })
      setHistory(h)
    } catch (e) {
      if ((e as Error).name !== "AbortError") setItems((x) => [...x, { kind: "error", text: e instanceof Error ? e.message : String(e) }])
      // drop the failed turn so the next message keeps user / assistant turns alternating;
      // the CLI session may hold part of it, so the next turn starts a fresh session with a transcript
      setHistory(history)
      resetSession()
    } finally {
      setBusy(false); abort.current = null
      setItems((x) => x.map((y) => (y.kind === "tool" && y.status === "running" ? { ...y, status: "error", summary: "stopped" } : y)))
    }
  }

  // the app's message goes out once the assistant is connected and free; without a connection it waits in the box
  const asked = useRef(0)
  useEffect(() => {
    if (!request || request.id === asked.current || busy || (cli && cliVersion === undefined)) return
    asked.current = request.id
    if (ready) void send(request.text)
    else setText(request.text)
  }, [request, busy, ready, cli, cliVersion]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-background", drag && "ring-2 ring-inset ring-ring")}
      onDragOver={(e) => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files) }}>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <Sparkles className="size-4 text-primary" />
        <span className="text-sm font-medium">AI assistant</span>
        <button onClick={() => !busy && setSettings({ aiProvider: cli ? "api" : "claude-code" })} title="Switch between your Claude Code login and an API key"
          className="truncate rounded-md border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent">{cli ? `Claude Code · ${s.aiCliModel}` : `API · ${s.aiModel.replace("claude-", "").replace(/-\d{8}$/, "")}`}</button>
        <div className="flex-1" />
        {cli && <Button variant="ghost" size="icon-sm" title="Terminal: what the claude command is doing (bottom panel)" onClick={onOpenTerminal}><SquareTerminal /></Button>}
        <Button variant="ghost" size="icon-sm" title="New chat" disabled={busy} onClick={() => { setItems([]); setHistory([]); cliLog.clear(); resetSession() }}><Plus /></Button>
        <Button variant="ghost" size="icon-sm" title="Close" onClick={onClose}><X /></Button>
      </div>

      {cli && !cliVersion ? (
        <div className="flex flex-1 flex-col gap-3 p-4 text-sm">
          {cliVersion === undefined ? <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Looking for Claude Code…</p> : (<>
            <p className="font-medium">Claude Code was not found</p>
            <p className="text-muted-foreground">The assistant runs through the <code className="rounded bg-muted px-1 font-mono text-[12px]">claude</code> command with your Claude Code login. In a terminal:</p>
            <pre className="rounded-md bg-muted px-3 py-2 font-mono text-[12px]">npm install -g @anthropic-ai/claude-code{"\n"}claude    # log in once, then quit</pre>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={checkCli}><RefreshCw /> Check again</Button>
              <Button variant="ghost" onClick={onOpenSettings}>Set the path…</Button>
              <Button variant="ghost" onClick={() => setSettings({ aiProvider: "api" })}>Use an API key instead</Button>
            </div>
          </>)}
        </div>
      ) : !cli && !s.aiKey ? (
        <div className="flex flex-1 flex-col gap-3 p-4 text-sm">
          <p className="font-medium">Connect Claude to design circuits by chat</p>
          <p className="text-muted-foreground">Paste an Anthropic API key (console.anthropic.com → API keys). It stays on this computer and is only sent to Anthropic when you chat.</p>
          <Input type="password" placeholder="sk-ant-…" value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} className="font-mono" onKeyDown={(e) => e.key === "Enter" && keyDraft.trim() && setSettings({ aiKey: keyDraft.trim() })} />
          <div className="flex flex-wrap gap-2">
            <Button disabled={!keyDraft.trim()} onClick={() => setSettings({ aiKey: keyDraft.trim() })}>Save key</Button>
            <Button variant="ghost" onClick={() => setSettings({ aiProvider: "claude-code" })}>Use my Claude Code login</Button>
            <Button variant="ghost" onClick={onOpenSettings}>More settings</Button>
          </div>
        </div>
      ) : (
        <>
          <div ref={scroller} className="min-h-0 flex-1 overflow-auto px-3 py-3 text-sm">
            {!items.length && (
              <div className="flex flex-col gap-3">
                <p className="text-muted-foreground">{profile ? profile.intro : "Describe a circuit, ask for changes, or drop a picture of a schematic — the assistant writes the Kirk code (the drawing follows), simulates it and connects probes."}</p>
                {(profile?.suggestions ?? SUGGESTIONS).map((q) => <button key={q} onClick={() => send(q)} className="rounded-lg border bg-card px-3 py-2 text-left text-xs hover:border-ring">{q}</button>)}
              </div>
            )}
            <div className="flex flex-col gap-3">
              {items.map((it, i) => {
                if (it.kind === "user") return (
                  <div key={i} className="ml-6 flex flex-col items-end gap-1.5">
                    {it.images.length > 0 && <div className="flex flex-wrap justify-end gap-1.5">{it.images.map((im, k) => <img key={k} src={im.url} alt={im.name} className="h-20 rounded-md border object-cover" />)}</div>}
                    {it.text && <div className="whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-primary-foreground">{it.text}</div>}
                  </div>
                )
                if (it.kind === "assistant") return <div key={i} className="mr-4 leading-relaxed"><Markdown text={it.text} /></div>
                if (it.kind === "error") return <div key={i} className="flex gap-2 rounded-lg border border-destructive/50 bg-destructive-subtle px-3 py-2 text-xs text-destructive"><CircleAlert className="mt-0.5 size-3.5 shrink-0" />{it.text}</div>
                const Icon = TOOL_ICON[it.name] ?? Cpu
                return (
                  <div key={i} className={cn("flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs", it.status === "error" ? "border-warning/60 bg-warning-subtle" : "bg-card")}>
                    {it.status === "running" ? <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" /> : it.status === "ok" ? <Check className="size-3.5 shrink-0 text-success" /> : <CircleAlert className="size-3.5 shrink-0 text-warning" />}
                    <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="shrink-0 font-medium">{profile?.labels?.[it.name] ?? TOOL_LABEL[it.name] ?? it.name}</span>
                    <span className="min-w-0 truncate text-muted-foreground" title={it.summary}>{it.status === "running" ? (it.name === "simulate" ? `${String(it.input.analysis ?? "")}…` : "…") : it.summary}</span>
                  </div>
                )
              })}
              {busy && <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> Thinking…</div>}
            </div>
          </div>

          <div className="shrink-0 border-t p-2.5">
            {images.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {images.map((im, k) => (
                  <div key={k} className="relative">
                    <img src={im.url} alt={im.name} className="h-14 rounded-md border object-cover" />
                    <button onClick={() => setImages((x) => x.filter((_, j) => j !== k))} className="absolute -right-1.5 -top-1.5 rounded-full border bg-background p-0.5" aria-label="Remove image"><X className="size-3" /></button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-end gap-1.5 rounded-xl border bg-card p-1.5 focus-within:ring-2 focus-within:ring-ring/40">
              <Button variant="ghost" size="icon-sm" title="Attach a schematic image (or paste / drop one)" onClick={() => fileInput.current?.click()}><ImagePlus /></Button>
              <input ref={fileInput} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = "" }} />
              <textarea ref={input} value={text} onChange={(e) => setText(e.target.value)} rows={1} title="↵ send · ⇧↵ new line"
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send() } }}
                onPaste={(e) => { const f = [...e.clipboardData.files]; if (f.length) { e.preventDefault(); addFiles(f) } }}
                placeholder={profile?.placeholder ?? "Ask for a circuit, a change, or a probe…"} className="max-h-40 min-h-8 flex-1 resize-none overflow-y-auto bg-transparent [scrollbar-width:none] [&::-webkit-scrollbar]:hidden px-1 py-1.5 text-sm outline-none placeholder:text-muted-foreground" />
              {busy
                ? <Button size="icon-sm" variant="outline" title="Stop" onClick={() => abort.current?.abort()}><Square /></Button>
                : <Button size="icon-sm" title="Send (↵)" disabled={!text.trim() && !images.length} onClick={() => send()}><Send /></Button>}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
