// Pure editing operations on a Doc (each returns a new Doc; never mutates).
import { isVirtual, nextRef, pinPositions, uid, type Doc, type Part, type Pt, type Rot, type Wire } from "./model"

export interface Selection {
  parts: Set<string>
  wires: Set<string>
}
export const emptySelection = (): Selection => ({ parts: new Set(), wires: new Set() })

const key = (p: Pt) => `${p[0]},${p[1]}`
const shift = (p: Pt, dx: number, dy: number): Pt => [p[0] + dx, p[1] + dy]

export function addPart(doc: Doc, part: Part): Doc {
  return { ...doc, parts: [...doc.parts, part] }
}

/** Add an orthogonal polyline as wire segments (zero-length pieces dropped). */
export function addWirePath(doc: Doc, path: Pt[]): Doc {
  const wires: Wire[] = []
  for (let i = 1; i < path.length; i++) {
    if (key(path[i - 1]) !== key(path[i])) wires.push({ id: uid("w"), a: path[i - 1], b: path[i] })
  }
  return wires.length ? { ...doc, wires: [...doc.wires, ...wires] } : doc
}

/**
 * Move the selection by (dx, dy) grid units. Unselected wires whose ends sit on
 * a moved pin or moved wire end are stretched so the circuit stays connected.
 */
export function moveSelection(doc: Doc, sel: Selection, dx: number, dy: number): Doc {
  if (!dx && !dy) return doc
  const moving = new Set<string>()
  for (const p of doc.parts) if (sel.parts.has(p.id)) for (const at of Object.values(pinPositions(p))) moving.add(key(at))
  for (const w of doc.wires) if (sel.wires.has(w.id)) { moving.add(key(w.a)); moving.add(key(w.b)) }
  const parts = doc.parts.map((p) => (sel.parts.has(p.id) ? { ...p, x: p.x + dx, y: p.y + dy } : p))
  const wires = doc.wires.map((w) => {
    if (sel.wires.has(w.id)) return { ...w, a: shift(w.a, dx, dy), b: shift(w.b, dx, dy) }
    const ma = moving.has(key(w.a)), mb = moving.has(key(w.b))
    if (!ma && !mb) return w
    return { ...w, a: ma ? shift(w.a, dx, dy) : w.a, b: mb ? shift(w.b, dx, dy) : w.b }
  })
  return { ...doc, parts, wires: wires.filter((w) => key(w.a) !== key(w.b)) }
}

/** Rotate parts 90° clockwise about their origin; wires attached to their pins follow. */
export function rotateParts(doc: Doc, ids: Set<string>): Doc {
  const remap = new Map<string, Pt>()
  const parts = doc.parts.map((p) => {
    if (!ids.has(p.id)) return p
    const q: Part = { ...p, rot: (((p.rot + 90) % 360) as Rot) }
    const before = pinPositions(p), after = pinPositions(q)
    for (const pin of Object.keys(before)) remap.set(key(before[pin]), after[pin])
    return q
  })
  const wires = doc.wires.map((w) => ({ ...w, a: remap.get(key(w.a)) ?? w.a, b: remap.get(key(w.b)) ?? w.b }))
  return { ...doc, parts, wires: wires.filter((w) => key(w.a) !== key(w.b)) }
}

/** Mirror parts left–right about their origin; wires attached to their pins follow. */
export function mirrorParts(doc: Doc, ids: Set<string>): Doc {
  const remap = new Map<string, Pt>()
  const parts = doc.parts.map((p) => {
    if (!ids.has(p.id)) return p
    const q: Part = { ...p, mirror: !p.mirror }
    const before = pinPositions(p), after = pinPositions(q)
    for (const pin of Object.keys(before)) remap.set(key(before[pin]), after[pin])
    return q
  })
  const wires = doc.wires.map((w) => ({ ...w, a: remap.get(key(w.a)) ?? w.a, b: remap.get(key(w.b)) ?? w.b }))
  return { ...doc, parts, wires: wires.filter((w) => key(w.a) !== key(w.b)) }
}

/** Copy the selection, offset by (dx, dy); copies get fresh references. Returns the doc and the new selection. */
export function duplicateSelection(doc: Doc, sel: Selection, dx = 2, dy = 2): { doc: Doc; sel: Selection } {
  const parts: Part[] = []
  const refMap = new Map<string, string>()
  const all = [...doc.parts]
  for (const p of doc.parts) {
    if (!sel.parts.has(p.id)) continue
    let ref = p.ref
    if (!p.ref.startsWith("#")) {
      ref = refMap.get(p.ref) ?? nextRef(all, p.ref.replace(/\d+$/, ""))
      refMap.set(p.ref, ref)
    } else ref = nextRef(all, p.ref.replace(/[\d_].*$/, "") || "#PWR")
    const q: Part = { ...p, id: uid("p"), ref, x: p.x + dx, y: p.y + dy }
    parts.push(q)
    all.push(q)
  }
  const wires: Wire[] = doc.wires.filter((w) => sel.wires.has(w.id)).map((w) => ({ id: uid("w"), a: shift(w.a, dx, dy), b: shift(w.b, dx, dy) }))
  return {
    doc: { ...doc, parts: [...doc.parts, ...parts], wires: [...doc.wires, ...wires] },
    sel: { parts: new Set(parts.map((p) => p.id)), wires: new Set(wires.map((w) => w.id)) },
  }
}

/** Add or remove a no-connect marker at a point. */
export function toggleNoConnect(doc: Doc, at: Pt): Doc {
  const list = doc.noConnects ?? []
  const has = list.some((p) => key(p) === key(at))
  return { ...doc, noConnects: has ? list.filter((p) => key(p) !== key(at)) : [...list, at] }
}

/**
 * Delete the selection. Wires that only led to deleted parts go too: from each
 * removed pin, dead-end wire chains are followed and removed until they reach
 * something still connected (another pin, a label, a junction or a wire they
 * join in the middle), so the rest of the circuit keeps its wiring.
 */
export function deleteSelection(doc: Doc, sel: Selection): Doc {
  const parts = doc.parts.filter((p) => !sel.parts.has(p.id))
  let wires = doc.wires.filter((w) => !sel.wires.has(w.id))
  const pinAt = new Set(parts.flatMap((p) => Object.values(pinPositions(p)).map(key)))
  let frontier = doc.parts.filter((p) => sel.parts.has(p.id)).flatMap((p) => Object.values(pinPositions(p)))
  const removedEnds = new Set<string>()
  const onWire = (p: Pt, w: Wire) => {
    const cross = (w.b[0] - w.a[0]) * (p[1] - w.a[1]) - (w.b[1] - w.a[1]) * (p[0] - w.a[0])
    return cross === 0 && p[0] >= Math.min(w.a[0], w.b[0]) && p[0] <= Math.max(w.a[0], w.b[0]) && p[1] >= Math.min(w.a[1], w.b[1]) && p[1] <= Math.max(w.a[1], w.b[1])
  }
  for (let guard = 0; frontier.length && guard < 10_000; guard++) {
    const next: Pt[] = []
    for (const p of frontier) {
      if (pinAt.has(key(p))) continue // still a pin of a remaining part (or a label / power symbol)
      const touching = wires.filter((w) => onWire(p, w))
      // exactly one wire ends here and nothing else touches the point: it is a dead end
      if (touching.length !== 1) continue
      const w = touching[0]
      const end = key(w.a) === key(p) ? w.b : key(w.b) === key(p) ? w.a : null
      if (!end) continue // p is in the middle of a wire (a T): keep it
      // something still connected sits on this segment (a label, a pin, another wire's end): trim back to it
      const along = (q: Pt) => Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1])
      const stops = [
        ...parts.flatMap((q) => Object.values(pinPositions(q))),
        ...wires.filter((x) => x !== w).flatMap((x) => [x.a, x.b]),
      ].filter((q) => key(q) !== key(p) && key(q) !== key(end) && onWire(q, w))
      if (stops.length) {
        const stop = stops.reduce((m, q) => (along(q) < along(m) ? q : m))
        wires = wires.map((x) => (x === w ? { ...x, a: stop, b: end } : x))
        continue
      }
      wires = wires.filter((x) => x !== w)
      removedEnds.add(key(end))
      next.push(end)
    }
    frontier = next
  }
  // a ground symbol or net label left on its own by the removed wiring goes too
  const kept = parts.filter((p) => {
    if (!isVirtual(p)) return true
    const at = Object.values(pinPositions(p))[0]
    if (!at || !removedEnds.has(key(at))) return true
    return wires.some((w) => onWire(at, w)) || parts.some((q) => q !== p && Object.values(pinPositions(q)).some((x) => key(x) === key(at)))
  })
  return { ...doc, parts: kept, wires }
}

export function updatePart(doc: Doc, id: string, patch: Partial<Part>): Doc {
  return { ...doc, parts: doc.parts.map((p) => (p.id === id ? { ...p, ...patch } : p)) }
}

/** L-shaped route from a to b: horizontal first unless `verticalFirst`. */
export function route(a: Pt, b: Pt, verticalFirst = false): Pt[] {
  if (a[0] === b[0] || a[1] === b[1]) return [a, b]
  return verticalFirst ? [a, [a[0], b[1]], b] : [a, [b[0], a[1]], b]
}

/** Parts and wires fully inside the rectangle (grid units). */
export function selectInRect(doc: Doc, x0: number, y0: number, x1: number, y1: number): Selection {
  const [l, r, t, b] = [Math.min(x0, x1), Math.max(x0, x1), Math.min(y0, y1), Math.max(y0, y1)]
  const inside = (p: Pt) => p[0] >= l && p[0] <= r && p[1] >= t && p[1] <= b
  return {
    parts: new Set(doc.parts.filter((p) => inside([p.x, p.y])).map((p) => p.id)),
    wires: new Set(doc.wires.filter((w) => inside(w.a) && inside(w.b)).map((w) => w.id)),
  }
}
