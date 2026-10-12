import { useCallback, useRef, useState } from "react"

/**
 * Undo/redo over immutable documents. `commit` records a step. For a drag (a slider, a
 * knob): `begin()`, then `replace()` as it moves (no steps), then `end()` records the whole
 * gesture as one step.
 */
export function useHistory<T>(initial: T, limit = 200) {
  const [state, setState] = useState({ past: [] as T[], present: initial, future: [] as T[] })
  const gesture = useRef<T | null>(null)
  const commit = useCallback((next: T | ((d: T) => T)) => setState((s) => {
    const value = typeof next === "function" ? (next as (d: T) => T)(s.present) : next
    if (value === s.present) return s
    return { past: [...s.past.slice(-limit + 1), s.present], present: value, future: [] }
  }), [limit])
  const begin = useCallback(() => setState((s) => { gesture.current ??= s.present; return s }), [])
  const replace = useCallback((next: T | ((d: T) => T)) => setState((s) => {
    const value = typeof next === "function" ? (next as (d: T) => T)(s.present) : next
    return value === s.present ? s : { ...s, present: value }
  }), [])
  const end = useCallback(() => setState((s) => {
    const start = gesture.current
    gesture.current = null
    if (start === null || start === s.present) return s
    return { past: [...s.past.slice(-limit + 1), start], present: s.present, future: [] }
  }), [limit])
  /** drop the gesture and put the document back as it was before it (momentary buttons) */
  const cancel = useCallback(() => setState((s) => {
    const start = gesture.current
    gesture.current = null
    return start === null ? s : { ...s, present: start }
  }), [])
  const undo = useCallback(() => setState((s) => (s.past.length ? { past: s.past.slice(0, -1), present: s.past[s.past.length - 1], future: [s.present, ...s.future] } : s)), [])
  const redo = useCallback(() => setState((s) => (s.future.length ? { past: [...s.past, s.present], present: s.future[0], future: s.future.slice(1) } : s)), [])
  const reset = useCallback((value: T) => { gesture.current = null; setState({ past: [], present: value, future: [] }) }, [])
  return { doc: state.present, commit, begin, replace, end, cancel, undo, redo, reset, canUndo: state.past.length > 0, canRedo: state.future.length > 0 }
}
