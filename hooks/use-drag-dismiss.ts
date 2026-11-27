'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/** A release past this distance, or a flick faster than FLICK px/ms, dismisses. */
export const dismissDistance = (height: number) => Math.min(150, height * 0.25)
const FLICK = 0.45
const SLOP = 6

/**
 * Drag down to dismiss. Native listeners, because React's touch handlers are passive and could not
 * stop the content underneath from scrolling or rubber-banding along with the finger.
 * `area` goes only on the elements a drag may start from: a non-passive touchmove listener makes the
 * browser wait for script before scrolling anything inside it, so long lists must stay outside.
 */
export function useDragDismiss<T extends HTMLElement>(onDismiss: () => void, canStart: (target: Element) => boolean, closing: boolean) {
  const [offset, setOffset] = useState(0)
  const [dragging, setDragging] = useState(false)
  const latest = useRef({ onDismiss, canStart })
  useEffect(() => { latest.current = { onDismiss, canStart } })
  // A drag-dismissed layer keeps its offset while it slides away, and drops it if reopened before it is gone.
  useEffect(() => { if (!closing) setOffset(0) }, [closing])

  const handlers = useRef<{ start: (e: TouchEvent) => void; move: (e: TouchEvent) => void; end: (e: TouchEvent) => void } | null>(null)
  if (!handlers.current) {
    let state: 'idle' | 'pending' | 'drag' = 'idle'
    let x0 = 0, y0 = 0, lastY = 0, lastT = 0, velocity = 0, distance = 0
    handlers.current = {
      start: e => {
        state = 'idle'
        if (e.touches.length !== 1 || !latest.current.canStart(e.target as Element)) return
        const t = e.touches[0]
        x0 = t.clientX; y0 = lastY = t.clientY; lastT = e.timeStamp; velocity = 0; distance = 0
        state = 'pending'
      },
      move: e => {
        if (state === 'idle') return
        const t = e.touches[0], dx = t.clientX - x0, dy = t.clientY - y0
        if (state === 'pending') {
          if (Math.hypot(dx, dy) < SLOP) return
          // Only a clearly downward start is a drag; sideways or upward belongs to the content.
          if (dy <= 0 || dy < Math.abs(dx) * 1.5) { state = 'idle'; return }
          state = 'drag'
          setDragging(true)
        }
        if (e.cancelable) e.preventDefault()
        const dt = e.timeStamp - lastT
        if (dt > 0) velocity = (t.clientY - lastY) / dt
        lastY = t.clientY; lastT = e.timeStamp
        distance = Math.max(0, dy)
        setOffset(distance)
      },
      end: e => {
        if (state === 'drag') {
          setDragging(false)
          const layer = (e.currentTarget as HTMLElement).closest('[role="dialog"]') as HTMLElement | null
          const flick = e.type === 'touchend' && e.timeStamp - lastT < 100 && velocity > FLICK && distance > 20
          if (e.type === 'touchend' && (distance > dismissDistance(layer?.offsetHeight ?? innerHeight) || flick)) latest.current.onDismiss()
          else setOffset(0)
        }
        state = 'idle'
      },
    }
  }

  const area = useCallback((el: T | null) => {
    const h = handlers.current
    if (!el || !h) return
    el.addEventListener('touchstart', h.start, { passive: true })
    el.addEventListener('touchmove', h.move, { passive: false })
    el.addEventListener('touchend', h.end)
    el.addEventListener('touchcancel', h.end)
    return () => {
      el.removeEventListener('touchstart', h.start)
      el.removeEventListener('touchmove', h.move)
      el.removeEventListener('touchend', h.end)
      el.removeEventListener('touchcancel', h.end)
    }
  }, [])

  return { area, offset, dragging }
}
