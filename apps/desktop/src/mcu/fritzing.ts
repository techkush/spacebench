// Import Fritzing parts (https://fritzing.org — parts are CC-BY-SA): a .fzpz is a zip of the
// part file (.fzp: title, connectors, buses) and its SVGs. The breadboard SVG becomes the
// part's drawing on the canvas; each connector's SVG element gives its pin position.
// Connectors joined by a <bus> share a name prefix (Wokwi's "GND.1 = GND.2" rule), so the
// circuit treats them as one net. Imported parts are passive: they connect, they don't act.
import { unzipSync, strFromU8 } from "fflate"

export interface FzPart {
  /** custom element tag and diagram part type: "fz-<slug>" */
  type: string
  title: string
  description: string
  author: string
  svg: string
  w: number
  h: number
  pins: { name: string; x: number; y: number; description?: string }[]
  source: string
}

type El = { tagName: string; getAttribute(n: string): string | null; childNodes: ArrayLike<unknown>; parentNode: unknown; nodeType: number; getElementsByTagName?(n: string): ArrayLike<El> }
type Doc = { documentElement: El; getElementsByTagName(n: string): ArrayLike<El> }
export type ParseXml = (text: string) => Doc

const MM = 3.7795275591 // px per mm (96 dpi)
function lengthPx(v: string | null): number | null {
  if (!v) return null
  const m = /^\s*([\d.]+)\s*(mm|cm|in|px|pt)?\s*$/.exec(v)
  if (!m) return null
  const n = parseFloat(m[1])
  return m[2] === "mm" ? n * MM : m[2] === "cm" ? n * 10 * MM : m[2] === "in" ? n * 96 : m[2] === "pt" ? (n * 96) / 72 : n
}

// ── 2-D affine transforms ([a b c d e f] like SVG matrix) ──
type M = [number, number, number, number, number, number]
const I: M = [1, 0, 0, 1, 0, 0]
const mul = (p: M, q: M): M => [p[0] * q[0] + p[2] * q[1], p[1] * q[0] + p[3] * q[1], p[0] * q[2] + p[2] * q[3], p[1] * q[2] + p[3] * q[3], p[0] * q[4] + p[2] * q[5] + p[4], p[1] * q[4] + p[3] * q[5] + p[5]]
const apply = (m: M, x: number, y: number) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] })
function parseTransform(t: string | null): M {
  let m: M = I
  if (!t) return m
  for (const [, fn, args] of t.matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const a = args.split(/[\s,]+/).filter(Boolean).map(Number)
    let n: M = I
    if (fn === "translate") n = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0]
    else if (fn === "scale") n = [a[0], 0, 0, a[1] ?? a[0], 0, 0]
    else if (fn === "matrix") n = a.slice(0, 6) as M
    else if (fn === "rotate") {
      const r = ((a[0] ?? 0) * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r)
      n = [c, s, -s, c, 0, 0]
      if (a.length >= 3) n = mul(mul([1, 0, 0, 1, a[1], a[2]], n), [1, 0, 0, 1, -a[1], -a[2]])
    }
    m = mul(m, n)
  }
  return m
}

/** Points that bound an element (its own coordinates). */
function points(el: El): { x: number; y: number }[] {
  const n = (k: string) => parseFloat(el.getAttribute(k) ?? "0") || 0
  switch (el.tagName.replace(/^.*:/, "")) {
    case "rect": return [{ x: n("x"), y: n("y") }, { x: n("x") + n("width"), y: n("y") + n("height") }]
    case "circle": return [{ x: n("cx") - n("r"), y: n("cy") - n("r") }, { x: n("cx") + n("r"), y: n("cy") + n("r") }]
    case "ellipse": return [{ x: n("cx") - n("rx"), y: n("cy") - n("ry") }, { x: n("cx") + n("rx"), y: n("cy") + n("ry") }]
    case "line": return [{ x: n("x1"), y: n("y1") }, { x: n("x2"), y: n("y2") }]
    case "polygon": case "polyline": {
      const v = (el.getAttribute("points") ?? "").split(/[\s,]+/).filter(Boolean).map(Number)
      const out = []
      for (let i = 0; i + 1 < v.length; i += 2) out.push({ x: v[i], y: v[i + 1] })
      return out
    }
    case "path": return pathPoints(el.getAttribute("d") ?? "")
    default: return []
  }
}
/** End points of a path's segments (enough for a pad's bounding box). */
function pathPoints(d: string) {
  const out: { x: number; y: number }[] = []
  let x = 0, y = 0, sx = 0, sy = 0
  const tokens = d.match(/[a-zA-Z]|-?[\d.]+(?:e-?\d+)?/g) ?? []
  let cmd = "", i = 0
  const num = () => parseFloat(tokens[i++])
  const ARGS: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 }
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++]
    const lc = cmd.toLowerCase(), rel = cmd !== cmd.toUpperCase()
    if (lc === "z") { x = sx; y = sy; out.push({ x, y }); continue }
    const k = ARGS[lc]
    if (!k || i + k > tokens.length) break
    const a = Array.from({ length: k }, num)
    if (lc === "h") x = rel ? x + a[0] : a[0]
    else if (lc === "v") y = rel ? y + a[0] : a[0]
    else { const px = a[k - 2], py = a[k - 1]; x = rel ? x + px : px; y = rel ? y + py : py }
    if (lc === "m") { sx = x; sy = y; cmd = rel ? "l" : "L" }
    out.push({ x, y })
  }
  return out
}

function ctm(el: El): M {
  const chain: El[] = []
  for (let e: El | null = el; e && e.nodeType === 1 && e.tagName.replace(/^.*:/, "") !== "svg"; e = e.parentNode as El) chain.unshift(e)
  return chain.reduce((m, e) => mul(m, parseTransform(e.getAttribute("transform"))), I)
}
function bbox(el: El): { x: number; y: number; w: number; h: number } | null {
  const pts: { x: number; y: number }[] = []
  const walk = (e: El) => {
    const own = points(e)
    if (own.length) { const m = ctm(e); for (const p of own) pts.push(apply(m, p.x, p.y)) }
    for (const c of Array.from(e.childNodes) as El[]) if (c.nodeType === 1) walk(c)
  }
  walk(el)
  if (!pts.length) return null
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y)
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
}
function byId(doc: Doc, id: string): El | null {
  const all = doc.getElementsByTagName("*")
  for (let i = 0; i < all.length; i++) if (all[i].getAttribute("id") === id) return all[i]
  return null
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "part"

/** Build a part from an .fzp text and its breadboard SVG text. */
export function partFromFzp(fzp: string, svgText: string, parse: ParseXml, source = ""): FzPart {
  const doc = parse(fzp)
  const root = doc.documentElement
  const text = (tag: string) => { const e = doc.getElementsByTagName(tag)[0] as unknown as { textContent?: string } | undefined; return (e?.textContent ?? "").trim() }
  const title = text("title") || "Imported part"
  const svgDoc = parse(svgText)
  const svgEl = svgDoc.documentElement
  const vb = (svgEl.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number)
  const wPx = lengthPx(svgEl.getAttribute("width")) ?? (vb[2] || 100)
  const hPx = lengthPx(svgEl.getAttribute("height")) ?? (vb[3] || 100)
  const [vx, vy, vw, vh] = vb.length === 4 && vb.every((v) => Number.isFinite(v)) ? vb : [0, 0, wPx, hPx]
  const sx = wPx / vw, sy = hPx / vh
  // buses: connector id → group name
  const busOf = new Map<string, string>()
  const buses = doc.getElementsByTagName("bus")
  for (let i = 0; i < buses.length; i++) {
    const members = buses[i].getElementsByTagName?.("nodeMember") as ArrayLike<El> | undefined
    const ids = members ? Array.from(members).map((m) => m.getAttribute("connectorId") ?? "") : []
    for (const id of ids) busOf.set(id, ids[0])
  }
  const connectors = Array.from(doc.getElementsByTagName("connector"))
  const nameOf = new Map<string, string>()
  for (const c of connectors) nameOf.set(c.getAttribute("id") ?? "", (c.getAttribute("name") ?? c.getAttribute("id") ?? "pin").replace(/[\s:.]+/g, "_"))
  const used = new Map<string, number>()
  const pins: FzPart["pins"] = []
  for (const c of connectors) {
    const id = c.getAttribute("id") ?? ""
    const bb = (c.getElementsByTagName?.("breadboardView") as ArrayLike<El> | undefined)?.[0]
    const p = (bb?.getElementsByTagName?.("p") as ArrayLike<El> | undefined)?.[0]
    const svgId = p?.getAttribute("terminalId") || p?.getAttribute("svgId")
    const el = svgId ? byId(svgDoc, svgId) : null
    const box = el ? bbox(el) : null
    if (!box) continue
    // terminal points are the wire end; pads: the centre
    const cx = p?.getAttribute("terminalId") ? box.x + box.w / 2 : box.x + box.w / 2
    const cy = box.y + box.h / 2
    let name = nameOf.get(id)!
    const bus = busOf.get(id)
    if (bus) name = `${nameOf.get(bus)}.${used.set(bus, (used.get(bus) ?? 0) + 1).get(bus)}`
    else if (pins.some((x) => x.name === name)) name = `${name}_${id}`
    const desc = (c.getElementsByTagName?.("description") as ArrayLike<{ textContent?: string }> | undefined)?.[0]?.textContent?.trim()
    pins.push({ name, x: (cx - vx) * sx, y: (cy - vy) * sy, ...(desc ? { description: desc } : {}) })
  }
  void root
  const svg = svgText.replace(/<\?xml[^>]*>/, "").replace(/<!DOCTYPE[^>]*>/i, "").trim()
  return { type: `fz-${slug(title)}`, title, description: text("description").replace(/<[^>]+>/g, "").slice(0, 300), author: text("author"), svg, w: wPx, h: hPx, pins, source }
}

/** A .fzpz (zip) → part. */
export function partFromFzpz(data: Uint8Array, parse: ParseXml, source = ""): FzPart {
  const files = unzipSync(data)
  const names = Object.keys(files)
  const fzpName = names.find((n) => n.toLowerCase().endsWith(".fzp"))
  if (!fzpName) throw new Error("No .fzp part file in this .fzpz")
  const fzp = strFromU8(files[fzpName])
  const doc = parse(fzp)
  const views = doc.getElementsByTagName("breadboardView")
  let image = ""
  for (let i = 0; i < views.length && !image; i++) {
    const layers = (views[i].getElementsByTagName?.("layers") as ArrayLike<El> | undefined)?.[0]
    image = layers?.getAttribute("image") ?? ""
  }
  if (!image) throw new Error("The part has no breadboard view")
  const base = image.split("/").pop()!.toLowerCase()
  const svgName = names.find((n) => n.toLowerCase().endsWith(base))
  if (!svgName) throw new Error(`The breadboard picture ${base} is missing from the .fzpz`)
  return partFromFzp(fzp, strFromU8(files[svgName]), parse, source)
}

/** Make the part a web component the canvas can place (idempotent). */
export function definePart(p: FzPart) {
  if (typeof customElements === "undefined" || customElements.get(p.type)) return
  customElements.define(p.type, class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: "open" }) }
    connectedCallback() {
      this.shadowRoot!.innerHTML = `<style>:host{display:inline-block;line-height:0}svg{display:block;width:${p.w}px;height:${p.h}px}</style>${p.svg}`
    }
    get pinInfo() { return p.pins.map((x) => ({ ...x, signals: [] })) }
  })
}
