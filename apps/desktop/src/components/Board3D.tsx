// 3D view of the board (three.js): FR4 core with solder mask, copper seen through the
// mask, gold pads, drilled holes, silkscreen, and simple bodies for every part.
import { useEffect, useRef, useState } from "react"
import * as THREE from "three"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"
import { Box, Camera, Eye, EyeOff, RotateCcw } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { saveExport } from "@/editor/file"
import { labelSize, LABEL_H, type Board, type BoardPart, type MaskColor } from "@/pcb/board"
import { textStrokes } from "@/pcb/gerber"
import { bodiesFor } from "@/pcb/model3d"

const MASK: Record<MaskColor, { base: string; copper: string; silk: string }> = {
  green: { base: "#14532d", copper: "#1f7a3e", silk: "#f8fafc" }, black: { base: "#111113", copper: "#262629", silk: "#f8fafc" },
  blue: { base: "#1e3a8a", copper: "#2f55b8", silk: "#f8fafc" }, red: { base: "#991b1b", copper: "#c0392b", silk: "#f8fafc" },
  white: { base: "#e7e5e4", copper: "#f5f5f4", silk: "#18181b" }, purple: { base: "#4c1d95", copper: "#6d3fc4", silk: "#f8fafc" },
}

/** Draw one side of the board as an image: mask, copper under mask, pads, holes, silkscreen. */
function surface(board: Board, parts: BoardPart[], side: "F" | "B"): HTMLCanvasElement {
  const ppm = Math.min(28, 4096 / Math.max(board.width, board.height))
  const c = document.createElement("canvas")
  c.width = Math.ceil(board.width * ppm); c.height = Math.ceil(board.height * ppm)
  const g = c.getContext("2d")!
  const col = MASK[board.mask ?? "green"]
  // bottom view is mirrored left-right so it reads correctly from below
  if (side === "B") { g.translate(c.width, 0); g.scale(-1, 1) }
  g.scale(ppm, ppm)
  g.fillStyle = col.base; g.fillRect(0, 0, board.width, board.height)
  g.lineCap = "round"; g.lineJoin = "round"
  g.strokeStyle = col.copper
  for (const t of board.tracks) if (t.layer === side) { g.lineWidth = t.width; g.beginPath(); g.moveTo(t.a[0], t.a[1]); g.lineTo(t.b[0], t.b[1]); g.stroke() }
  g.fillStyle = col.copper
  for (const v of board.vias) { g.beginPath(); g.arc(v.x, v.y, v.dia / 2, 0, 2 * Math.PI); g.fill() }
  // exposed pads (ENIG gold)
  for (const p of parts.flatMap((x) => x.pads)) {
    if (!p.layers.includes(side)) continue
    g.fillStyle = "#d9b44a"
    g.beginPath()
    if (p.shape === "circle") g.arc(p.ax, p.ay, p.aw / 2, 0, 2 * Math.PI)
    else g.roundRect(p.ax - p.aw / 2, p.ay - p.ah / 2, p.aw, p.ah, p.shape === "oval" ? Math.min(p.aw, p.ah) / 2 : p.shape === "roundrect" ? Math.min(p.aw, p.ah) * 0.25 : 0)
    g.fill()
  }
  // holes
  g.fillStyle = "#0a0a0a"
  for (const p of parts.flatMap((x) => x.pads)) if (p.drill) { g.beginPath(); g.arc(p.ax, p.ay, p.drill / 2, 0, 2 * Math.PI); g.fill() }
  for (const v of board.vias) { g.beginPath(); g.arc(v.x, v.y, v.drill / 2, 0, 2 * Math.PI); g.fill() }
  if (side === "F") {
    g.strokeStyle = col.silk; g.lineWidth = 0.15
    for (const bp of parts) {
      const T = (q: [number, number]): [number, number] => { const a = bp.at, r = a.rot === 90 ? [-q[1], q[0]] : a.rot === 180 ? [-q[0], -q[1]] : a.rot === 270 ? [q[1], -q[0]] : q; return [r[0] + a.x, r[1] + a.y] }
      for (const s of bp.fp.silk) {
        g.beginPath()
        if (s.k === "line") { const a = T(s.a), b = T(s.b); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]) } else { const cc = T(s.c); g.arc(cc[0], cc[1], s.r, 0, 2 * Math.PI) }
        g.stroke()
      }
      const L = bp.label, w = labelSize(bp.ref).w
      for (const poly of textStrokes(bp.ref, 0, LABEL_H)) {
        g.beginPath()
        poly.forEach((q, i) => { const [x, y] = L.rot === 90 ? [L.x + q[1], L.y + w - q[0]] : [L.x + q[0], L.y + q[1]]; if (i) g.lineTo(x, y); else g.moveTo(x, y) })
        g.stroke()
      }
    }
  }
  return c
}

/** Text for an IC's top face. */
function labelTexture(text: string): THREE.CanvasTexture {
  const c = document.createElement("canvas")
  c.width = 256; c.height = 128
  const g = c.getContext("2d")!
  g.fillStyle = "#1c1c1f"; g.fillRect(0, 0, 256, 128)
  g.fillStyle = "#a1a1aa"; g.font = "600 44px ui-monospace, monospace"; g.textAlign = "center"; g.textBaseline = "middle"
  g.fillText(text.slice(0, 9), 128, 64)
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace
  return t
}

export function Board3D({ board, parts }: { board: Board; parts: BoardPart[] }) {
  const host = useRef<HTMLDivElement>(null)
  const api = useRef<{ view: (v: "top" | "bottom" | "iso" | "front") => void; shot: () => string; setParts: (on: boolean) => void } | null>(null)
  const [showParts, setShowParts] = useState(true)

  useEffect(() => {
    const el = host.current
    if (!el) return
    const W = board.width, H = board.height, T = board.thickness ?? 1.6, R = Math.min(board.radius ?? 0.5, W / 4, H / 4)
    const scene = new THREE.Scene()
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.setClearColor(new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue("--canvas-background").trim() || "#f4f4f5"))
    el.appendChild(renderer.domElement)
    const camera = new THREE.PerspectiveCamera(35, 1, 0.5, 2000)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.target.set(W / 2, 0, H / 2)

    // light from above and below, so the back of the board is as readable as the front
    scene.add(new THREE.HemisphereLight("#ffffff", "#9a9aa8", 1.6))
    const sun = new THREE.DirectionalLight("#ffffff", 2.2); sun.position.set(W * 0.2, Math.max(W, H) * 1.5, H * 1.4); scene.add(sun)
    const fill = new THREE.DirectionalLight("#ffffff", 0.6); fill.position.set(-W, Math.max(W, H), -H); scene.add(fill)
    const under = new THREE.DirectionalLight("#ffffff", 1.8); under.position.set(W * 0.6, -Math.max(W, H) * 1.5, H * 1.2); scene.add(under)
    const under2 = new THREE.DirectionalLight("#ffffff", 0.5); under2.position.set(-W, -Math.max(W, H), -H); scene.add(under2)

    // ---- board: rounded outline in board coordinates (x right, y down → 3D x, z)
    const shape = new THREE.Shape()
    shape.moveTo(R, 0); shape.lineTo(W - R, 0); shape.quadraticCurveTo(W, 0, W, -R)
    shape.lineTo(W, -(H - R)); shape.quadraticCurveTo(W, -H, W - R, -H); shape.lineTo(R, -H); shape.quadraticCurveTo(0, -H, 0, -(H - R))
    shape.lineTo(0, -R); shape.quadraticCurveTo(0, 0, R, 0)
    const core = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: T, bevelEnabled: false }), [new THREE.MeshStandardMaterial({ color: MASK[board.mask ?? "green"].base, roughness: 0.6 }), new THREE.MeshStandardMaterial({ color: "#c9b37e", roughness: 0.9 })])
    core.rotation.x = -Math.PI / 2; core.position.y = -T
    scene.add(core)
    // the same outline with y = +board y: rotated +90° about X it faces down (no inside-out mirror)
    const backShape = new THREE.Shape(shape.getPoints(24).map((pt) => new THREE.Vector2(pt.x, -pt.y)))
    const face = (side: "F" | "B") => {
      const tex = new THREE.CanvasTexture(surface(board, parts, side))
      tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8
      // ShapeGeometry UVs are the shape coordinates: top (x, −y), bottom (x, +y); map them onto the image
      // (the bottom image is drawn mirrored, so it reads correctly when seen from below)
      if (side === "F") { tex.repeat.set(1 / W, 1 / H); tex.offset.set(0, 1) } else { tex.repeat.set(-1 / W, -1 / H); tex.offset.set(1, 1) }
      const m = new THREE.Mesh(new THREE.ShapeGeometry(side === "F" ? shape : backShape, 24), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.45, metalness: 0.05 }))
      m.rotation.x = side === "F" ? -Math.PI / 2 : Math.PI / 2
      m.position.y = side === "F" ? 0.004 : -T - 0.004
      scene.add(m)
    }
    face("F"); face("B")

    // ---- parts
    const group = new THREE.Group()
    const mats = new Map<string, THREE.Material>()
    const mat = (color: string, metal = false, opacity = 1) => {
      const k = `${color}${metal}${opacity}`
      let m = mats.get(k)
      if (!m) { m = new THREE.MeshStandardMaterial({ color, metalness: metal ? 0.85 : 0.05, roughness: metal ? 0.3 : 0.55, transparent: opacity < 1, opacity }); mats.set(k, m) }
      return m
    }
    for (const bp of parts) for (const p of bodiesFor(bp, T)) {
      let mesh: THREE.Mesh
      if (p.k === "box") {
        const g = new THREE.BoxGeometry(p.s[0], p.s[2], p.s[1])
        const m = mat(p.color, p.metal)
        mesh = new THREE.Mesh(g, p.label ? [m, m, new THREE.MeshStandardMaterial({ map: labelTexture(p.label), roughness: 0.6 }), m, m, m] : m)
        // label texture reads along the long side
        if (p.label && p.s[1] > p.s[0]) { const t = ((mesh.material as THREE.Material[])[2] as THREE.MeshStandardMaterial).map!; t.center.set(0.5, 0.5); t.rotation = Math.PI / 2 }
      } else if (p.k === "cyl") {
        mesh = new THREE.Mesh(new THREE.CylinderGeometry(p.rTop ?? p.r, p.r, p.h, 32), mat(p.color, p.metal))
        if (p.axis === "x") mesh.rotation.z = Math.PI / 2
        if (p.axis === "y") mesh.rotation.x = Math.PI / 2
      } else {
        mesh = new THREE.Mesh(new THREE.SphereGeometry(p.r, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), mat(p.color, false, p.opacity ?? 1))
      }
      mesh.position.set(p.c[0], p.k === "sphere" ? p.c[2] : p.c[2], p.c[1])
      group.add(mesh)
    }
    scene.add(group)

    const size = Math.max(W, H)
    const view = (v: "top" | "bottom" | "iso" | "front") => {
      const c = new THREE.Vector3(W / 2, 0, H / 2)
      controls.target.copy(c)
      // straight down / up (a hair of z keeps the board's top edge at the top of the view)
      if (v === "top") camera.position.set(W / 2, size * 1.9, H / 2 + size * 0.004)
      else if (v === "bottom") camera.position.set(W / 2, -size * 1.9, H / 2 + size * 0.004)
      else if (v === "front") camera.position.set(W / 2, size * 0.45, H / 2 + size * 1.7)
      else camera.position.set(W / 2 + size * 1.15, size * 1.3, H / 2 + size * 1.6)
      camera.lookAt(c); controls.update()
    }
    view("iso")
    const resize = () => {
      const w = el.clientWidth, h = el.clientHeight
      renderer.setSize(w, h, false); renderer.domElement.style.width = "100%"; renderer.domElement.style.height = "100%"
      camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix()
    }
    resize()
    const ro = new ResizeObserver(resize); ro.observe(el)
    let raf = 0
    const loop = () => { controls.update(); renderer.render(scene, camera); raf = requestAnimationFrame(loop) }
    loop()
    api.current = {
      view,
      shot: () => { renderer.render(scene, camera); return renderer.domElement.toDataURL("image/png") },
      setParts: (on) => { group.visible = on },
    }
    return () => {
      cancelAnimationFrame(raf); ro.disconnect(); controls.dispose()
      scene.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose(); const mm = m.material; (Array.isArray(mm) ? mm : mm ? [mm] : []).forEach((x) => { (x as THREE.MeshStandardMaterial).map?.dispose(); x.dispose() }) })
      renderer.dispose(); el.removeChild(renderer.domElement)
      api.current = null
    }
  }, [board, parts])

  useEffect(() => { api.current?.setParts(showParts) }, [showParts, board, parts])

  const save = async () => {
    const url = api.current?.shot()
    if (!url) return
    const bin = Uint8Array.from(atob(url.split(",")[1]), (ch) => ch.charCodeAt(0))
    try { const p = await saveExport("board-3d.png", "png", bin); if (p) toast.success(`Saved ${p.split("/").pop()}`) } catch (e) { toast.error(String(e instanceof Error ? e.message : e)) }
  }

  return (
    <div className="relative h-full w-full">
      <div ref={host} className="absolute inset-0" />
      <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-md border bg-background/90 p-0.5 shadow-sm backdrop-blur">
        {(["iso", "top", "front", "bottom"] as const).map((v) => <Button key={v} size="sm" variant="ghost" className="h-7 text-xs capitalize" onClick={() => api.current?.view(v)}>{v === "iso" ? <><Box /> 3D</> : v}</Button>)}
        <span className="mx-1 h-5 w-px bg-border" />
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setShowParts((s) => !s)}>{showParts ? <EyeOff /> : <Eye />} Parts</Button>
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => api.current?.view("iso")} title="Reset view"><RotateCcw /></Button>
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={save} title="Save image"><Camera /> Image</Button>
      </div>
      <div className="pointer-events-none absolute bottom-14 left-1/2 -translate-x-1/2 text-[11px] text-muted-foreground">drag to orbit · right-drag to pan · scroll to zoom</div>
    </div>
  )
}
