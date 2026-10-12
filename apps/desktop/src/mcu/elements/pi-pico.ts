// <wokwi-pi-pico>: a Raspberry Pi Pico drawn for the canvas (our own drawing, Wokwi's pin names
// so diagram.json files move between Space Bench and Wokwi). 21 × 51 mm, USB at the top,
// 2 × 20 castellated pins at 2.54 mm; the green "LED" (GP25) lights from the `led` property.

const MM = 3.7795
const W = 21, H = 51
const LEFT = ["GP0", "GP1", "GND.1", "GP2", "GP3", "GP4", "GP5", "GND.2", "GP6", "GP7", "GP8", "GP9", "GND.3", "GP10", "GP11", "GP12", "GP13", "GND.4", "GP14", "GP15"]
const RIGHT = ["VBUS", "VSYS", "GND.8", "3V3_EN", "3V3", "ADC_VREF", "GP28", "AGND", "GP27", "GP26", "RUN", "GP22", "GND.6", "GP21", "GP20", "GP19", "GP18", "GND.5", "GP17", "GP16"]
const pinY = (i: number) => 1.37 + i * 2.54

export interface PicoPin { name: string; x: number; y: number; signals: never[]; description?: string }

class PiPicoElement extends HTMLElement {
  private _led = false
  constructor() { super(); this.attachShadow({ mode: "open" }) }
  connectedCallback() { this.render() }
  get led() { return this._led }
  set led(v: boolean) { if (v !== this._led) { this._led = v; const l = this.shadowRoot?.getElementById("led"); if (l) l.setAttribute("fill", v ? "#7CFC6B" : "#e8f5e9"); const g = this.shadowRoot?.getElementById("glow"); if (g) g.setAttribute("opacity", v ? "0.9" : "0") } }
  get pinInfo(): PicoPin[] {
    return [
      ...LEFT.map((name, i) => ({ name, x: 1.61 * MM, y: pinY(i) * MM, signals: [] as never[] })),
      ...RIGHT.map((name, i) => ({ name, x: 19.39 * MM, y: pinY(i) * MM, signals: [] as never[] })),
    ]
  }
  private render() {
    const label = (name: string, x: number, y: number, anchor: string) =>
      `<text x="${x}" y="${y + 0.35}" font-size="0.95" text-anchor="${anchor}" fill="#fff" font-family="monospace">${name.replace(/\.\d+$/, "").replace("ADC_VREF", "VREF").replace("3V3_EN", "3V3E")}</text>`
    const pads = [
      ...LEFT.map((n, i) => `<circle cx="1.61" cy="${pinY(i)}" r="0.85" fill="#d4af37" stroke="#9a7b1f" stroke-width="0.15"/><circle cx="1.61" cy="${pinY(i)}" r="0.45" fill="#1b1b1b"/>${label(n, 3.0, pinY(i), "start")}`),
      ...RIGHT.map((n, i) => `<circle cx="19.39" cy="${pinY(i)}" r="0.85" fill="#d4af37" stroke="#9a7b1f" stroke-width="0.15"/><circle cx="19.39" cy="${pinY(i)}" r="0.45" fill="#1b1b1b"/>${label(n, 18.0, pinY(i), "end")}`),
    ].join("")
    this.shadowRoot!.innerHTML = `
      <style>:host { display: inline-block; line-height: 0 } svg { display: block }</style>
      <svg width="${W * MM}" height="${H * MM}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
        <rect x="0" y="0" width="${W}" height="${H}" rx="1.2" fill="#1d6b3a"/>
        <rect x="0.35" y="0.35" width="${W - 0.7}" height="${H - 0.7}" rx="1" fill="none" stroke="#2f8a50" stroke-width="0.2"/>
        <rect x="6.5" y="0" width="8" height="4.4" rx="0.5" fill="#c7c9cc" stroke="#8d9094" stroke-width="0.2"/>
        <rect x="7.4" y="0.5" width="6.2" height="1.3" rx="0.3" fill="#9da1a6"/>
        <rect x="6.9" y="18.5" width="7.2" height="7.2" rx="0.4" fill="#222"/>
        <text x="10.5" y="22.4" font-size="1.05" text-anchor="middle" fill="#bbb" font-family="monospace">RP2-B2</text>
        <text x="10.5" y="23.8" font-size="0.75" text-anchor="middle" fill="#888" font-family="monospace">20/21 P64M15.00</text>
        <rect x="8.2" y="29.5" width="4.6" height="4.6" rx="0.3" fill="#333"/>
        <rect x="11.2" y="7.4" width="3.2" height="2.4" rx="0.3" fill="#f2f2f2" stroke="#bdbdbd" stroke-width="0.15"/>
        <circle cx="12.8" cy="8.6" r="0.75" fill="#e0e0e0"/>
        <text x="12.8" y="11.1" font-size="0.75" text-anchor="middle" fill="#fff" font-family="sans-serif">BOOTSEL</text>
        <circle id="glow" cx="6.6" cy="8.0" r="2.2" fill="#7CFC6B" opacity="0" style="filter: blur(0.5px)"/>
        <rect id="led" x="5.9" y="7.4" width="1.4" height="1.1" rx="0.2" fill="#e8f5e9"/>
        <text x="6.6" y="10.1" font-size="0.75" text-anchor="middle" fill="#fff" font-family="sans-serif">LED</text>
        <text x="10.5" y="44.5" font-size="1.4" text-anchor="middle" fill="#fff" font-family="sans-serif" font-weight="600">Raspberry Pi</text>
        <text x="10.5" y="46.4" font-size="1.4" text-anchor="middle" fill="#fff" font-family="sans-serif" font-weight="600">Pico</text>
        ${pads}
      </svg>`
  }
}

if (!customElements.get("wokwi-pi-pico")) customElements.define("wokwi-pi-pico", PiPicoElement)
