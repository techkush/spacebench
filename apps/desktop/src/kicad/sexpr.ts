// KiCad's file format: S-expressions. A list is an array; a quoted string is { s }; anything else
// (numbers, keywords) is its text, so a file reads and writes back without losing anything.

export type Atom = string | { s: string }
export type Node = Atom | Node[]
export type List = Node[]

export function parseSexpr(src: string): List {
  let i = 0
  const n = src.length
  const ws = () => { while (i < n && (src[i] === " " || src[i] === "\n" || src[i] === "\t" || src[i] === "\r")) i++ }
  function node(): Node {
    ws()
    if (src[i] === "(") {
      i++
      const list: Node[] = []
      for (;;) {
        ws()
        if (i >= n) throw new Error("unexpected end of file (a “(” isn't closed)")
        if (src[i] === ")") { i++; return list }
        list.push(node())
      }
    }
    if (src[i] === '"') {
      i++
      let s = ""
      while (i < n && src[i] !== '"') {
        if (src[i] === "\\") { i++; const c = src[i]; s += c === "n" ? "\n" : c === "t" ? "\t" : c } else s += src[i]
        i++
      }
      i++
      return { s }
    }
    const a = i
    while (i < n && !/[\s()]/.test(src[i])) i++
    if (a === i) throw new Error(`unexpected “${src[i]}” at ${i}`)
    return src.slice(a, i)
  }
  const root = node()
  if (!Array.isArray(root)) throw new Error("not a KiCad file")
  return root
}

export const str = (v: Node | undefined): string => (v === undefined ? "" : typeof v === "object" && !Array.isArray(v) ? v.s : Array.isArray(v) ? "" : v)
export const num = (v: Node | undefined): number => parseFloat(str(v))
export const isList = (v: Node | undefined): v is List => Array.isArray(v)
export const kids = (l: List, tag: string): List[] => l.filter((c): c is List => Array.isArray(c) && c[0] === tag)
export const kid = (l: List | undefined, tag: string): List | undefined => (l ? kids(l, tag)[0] : undefined)
/** (hide yes), (hide) or a bare `hide` keyword */
export const yes = (l: List | undefined, tag: string): boolean => {
  if (!l) return false
  if (l.includes(tag)) return true
  const k = kid(l, tag)
  return !!k && (k.length === 1 || str(k[1]) === "yes")
}

const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`
const atomText = (a: Atom) => (typeof a === "object" ? quote(a.s) : a)

/** KiCad's own layout: one list per line, tab-indented; short lists of atoms stay on one line. */
export function printSexpr(root: List): string {
  const out: string[] = []
  const flat = (l: List): boolean => l.every((x) => !Array.isArray(x)) || (l[0] === "xy" || l[0] === "at")
  const one = (l: List): string => `(${l.map((x) => (Array.isArray(x) ? one(x) : atomText(x))).join(" ")})`
  function walk(l: List, depth: number) {
    const pad = "\t".repeat(depth)
    if (flat(l)) { out.push(pad + one(l)); return }
    // the head atoms stay on the first line: (symbol "R" … then the children indented
    const head: string[] = []
    let k = 0
    while (k < l.length && !Array.isArray(l[k])) head.push(atomText(l[k++] as Atom))
    out.push(`${pad}(${head.join(" ")}`)
    // runs of (xy …) points share a line, as KiCad writes them
    while (k < l.length) {
      const c = l[k] as List
      if (Array.isArray(c) && c[0] === "xy") {
        const pts: string[] = []
        while (k < l.length && Array.isArray(l[k]) && (l[k] as List)[0] === "xy") pts.push(one(l[k++] as List))
        out.push(`${pad}\t${pts.join(" ")}`)
        continue
      }
      if (Array.isArray(c)) walk(c, depth + 1)
      else out.push(`${pad}\t${atomText(c as Atom)}`)
      k++
    }
    out.push(`${pad})`)
  }
  walk(root, 0)
  return out.join("\n") + "\n"
}
