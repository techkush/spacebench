// Minimal client for Anthropic's Messages API (Claude), with tool use and images.
// Calls go straight from the app to api.anthropic.com with the user's own API key.

export type ImageMedia = "image/png" | "image/jpeg" | "image/webp" | "image/gif"
export type Block =
  | { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
  | { type: "image"; source: { type: "base64"; media_type: ImageMedia; data: string } }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }

export interface Msg { role: "user" | "assistant"; content: Block[] }
export interface ToolDef { name: string; description: string; input_schema: Record<string, unknown>; cache_control?: { type: "ephemeral" } }

export interface Request {
  model: string
  max_tokens: number
  system: Block[]
  tools: ToolDef[]
  messages: Msg[]
}
export interface Response { content: Block[]; stop_reason: string; usage?: { input_tokens: number; output_tokens: number } }

/** Anything that answers a request (the real API, or a script in tests). */
export type Transport = (req: Request, signal?: AbortSignal) => Promise<Response>

export const MODELS: { id: string; label: string }[] = [
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (recommended)" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (most capable)" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 (fastest)" },
]

export class AiError extends Error {
  status?: number
  constructor(message: string, status?: number) { super(message); this.status = status }
}

export function claudeTransport(apiKey: string): Transport {
  return async (req, signal) => {
    let res: globalThis.Response
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          // the request comes from the app itself, with the user's own key
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify(req),
      })
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e
      throw new AiError("Could not reach api.anthropic.com — check the internet connection.")
    }
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`
      try { const j = await res.json(); msg = j?.error?.message ?? msg } catch { /* not JSON */ }
      if (res.status === 401) msg = "The API key was rejected. Check it in Settings → AI Assistant."
      if (res.status === 429) msg = `Rate limited — wait a moment and try again. (${msg})`
      throw new AiError(msg, res.status)
    }
    return (await res.json()) as Response
  }
}
