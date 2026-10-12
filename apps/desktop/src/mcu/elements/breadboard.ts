// <wokwi-breadboard-half>, <wokwi-breadboard>, <wokwi-breadboard-mini>: solderless breadboards
// (our own drawing, Wokwi's hole names, so diagrams move between the two):
//   "12t.a" … "12t.e"  column 12, top half — one strip (same prefix "12t" = same net)
//   "12b.f" … "12b.j"  column 12, bottom half
//   "tp.1"… / "tn.1"…  top + / − rails; "bp.n" / "bn.n" bottom rails (one net per rail)
// Holes are 2.54 mm apart. A part whose pins sit on holes is connected to them (see seating
// in McuCanvas).

const P = 2.54 * 3.7795 // hole pitch in px
export interface Hole { name: string; x: number; y: number }

interface Size { cols: number; rails: boolean }
const SIZES: Record<string, Size> = {
  "wokwi-breadboard-mini": { cols: 17, rails: false },
  "wokwi-breadboard-half": { cols: 30, rails: true },
  "wokwi-breadboard": { cols: 63, rails: true },
}

export function breadboardHoles(tag: string): { holes: Hole[]; w: number; h: number } {
  const { cols, rails } = SIZES[tag] ?? SIZES["wokwi-breadboard-half"]
  const x0 = P * 1.5
  const holes: Hole[] = []
  const railY = rails ? [P * 1, P * 2] : []
  const top = rails ? P * 4 : P * 1.5
  const rowY = (r: number) => top + r * P + (r >= 5 ? P * 2 : 0) // a–e, gap, f–j
  for (let c = 1; c <= cols; c++) {
    const x = x0 + (c - 1) * P
    "abcde".split("").forEach((r, i) => holes.push({ name: `${c}t.${r}`, x, y: rowY(i) }))
    "fghij".split("").forEach((r, i) => holes.push({ name: `${c}b.${r}`, x, y: rowY(5 + i) }))
  }
  const bottom = rowY(9)
  let h = bottom + P * 1.5
  if (rails) {
    // rail holes in groups of five, one gap between groups
    const n = Math.floor((cols * 5) / 6)
    for (let i = 1; i <= n; i++) {
      const c = i + Math.floor((i - 1) / 5) + 1
      if (c > cols) break
      const x = x0 + (c - 1) * P
      holes.push({ name: `tn.${i}`, x, y: railY[0] }, { name: `tp.${i}`, x, y: railY[1] })
      holes.push({ name: `bn.${i}`, x, y: bottom + P * 2 }, { name: `bp.${i}`, x, y: bottom + P * 3 })
    }
    h = bottom + P * 4
  }
  return { holes, w: x0 * 2 + (cols - 1) * P, h }
}

const Base = (typeof HTMLElement === "undefined" ? class {} : HTMLElement) as typeof HTMLElement
class BreadboardElement extends Base {
  constructor() { super(); this.attachShadow({ mode: "open" }) }
  connectedCallback() { this.render() }
  get pinInfo() { return breadboardHoles(this.tagName.toLowerCase()).holes.map((h) => ({ ...h, signals: [] })) }
  private render() {
    const tag = this.tagName.toLowerCase()
    const { holes, w, h } = breadboardHoles(tag)
    const rails = SIZES[tag]?.rails
    const hole = (x: number, y: number) => `<rect x="${x - 2.4}" y="${y - 2.4}" width="4.8" height="4.8" rx="0.8" fill="#3a3a3a"/>`
    const labels = holes.filter((x) => x.name.endsWith(".a") && (Number(x.name.split("t")[0]) % 5 === 0 || x.name.startsWith("1t"))).map((x) => `<text x="${x.x}" y="${x.y - 6}" font-size="5" text-anchor="middle" fill="#888" font-family="monospace">${x.name.split("t")[0]}</text>`).join("")
    const rows = holes.filter((x) => x.name.startsWith("1t.") || x.name.startsWith("1b.")).map((x) => `<text x="${x.x - 9}" y="${x.y + 1.8}" font-size="5" text-anchor="middle" fill="#888" font-family="monospace">${x.name.slice(-1)}</text>`).join("")
    const mid = (holes.find((x) => x.name === "1t.e")!.y + holes.find((x) => x.name === "1b.f")!.y) / 2
    const railLines = rails ? (() => {
      const tn = holes.find((x) => x.name === "tn.1")!, tp = holes.find((x) => x.name === "tp.1")!, bn = holes.find((x) => x.name === "bn.1")!, bp = holes.find((x) => x.name === "bp.1")!
      const line = (y: number, color: string) => `<line x1="6" y1="${y}" x2="${w - 6}" y2="${y}" stroke="${color}" stroke-width="0.8"/>`
      return line(tn.y - 5, "#3b82f6") + line(tp.y + 5, "#ef4444") + line(bn.y - 5, "#3b82f6") + line(bp.y + 5, "#ef4444")
        + `<text x="4" y="${tn.y + 2}" font-size="6" fill="#3b82f6">−</text><text x="4" y="${tp.y + 2}" font-size="6" fill="#ef4444">+</text>`
        + `<text x="4" y="${bn.y + 2}" font-size="6" fill="#3b82f6">−</text><text x="4" y="${bp.y + 2}" font-size="6" fill="#ef4444">+</text>`
    })() : ""
    this.shadowRoot!.innerHTML = `
      <style>:host { display: inline-block; line-height: 0 } svg { display: block }</style>
      <svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
        <rect x="0" y="0" width="${w}" height="${h}" rx="4" fill="#f4f1ea" stroke="#d6d0c2" stroke-width="1"/>
        <rect x="2" y="${mid - 3}" width="${w - 4}" height="6" fill="#e3ddd0"/>
        ${railLines}${labels}${rows}
        ${holes.map((x) => hole(x.x, x.y)).join("")}
      </svg>`
  }
}

if (typeof customElements !== "undefined") for (const tag of Object.keys(SIZES)) if (!customElements.get(tag)) customElements.define(tag, class extends BreadboardElement {})

export const isBreadboard = (type: string) => type in SIZES
