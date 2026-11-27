'use client'

import { useEffect, useRef, useState } from 'react'

/** A release past this distance, or a flick faster than FLICK px/ms, dismisses. */
export const dismissDistance = (height: number) => Math.min(150, height * 0.25)
const FLICK = 0.45
const SLOP = 6

/**
 * Drag down to dismiss. Native listeners, because React's touch handlers are passive and could not
 * stop the content underneath from scrolling or rubber-banding along with the finger.
 */
export function useDragDismiss<T extends HTMLElement>(onDismiss: () => void, canStart: (target: Element) => boolean) {
  const ref = useRef<T>(null)
  const [offset, setOffset] = useState(0)
  const [dragging, setDragging] = useState(false)
  const latest = useRef({ onDismiss, canStart })
  useEffect(() => { latest.current = { onDismiss, canStart } })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let state: 'idle' | 'pending' | 'drag' = 'idle'
    let x0 = 0, y0 = 0, lastY = 0, lastT = 0, velocity = 0, distance = 0
    const start = (e: TouchEvent) => {
      state = 'idle'
      if (e.touches.length !== 1 || !latest.current.canStart(e.target as Element)) return
      const t = e.touches[0]
      x0 = t.clientX; y0 = lastY = t.clientY; lastT = e.timeStamp; velocity = 0; distance = 0
      state = 'pending'
    }
    const move = (e: TouchEvent) => {
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
    }
    const end = (e: TouchEvent) => {
      if (state === 'drag') {
        setDragging(false)
        const flick = e.type === 'touchend' && e.timeStamp - lastT < 100 && velocity > FLICK && distance > 20
        if (e.type === 'touchend' && (distance > dismissDistance(el.offsetHeight) || flick)) latest.current.onDismiss()
        else setOffset(0)
      }
      state = 'idle'
    }
    el.addEventListener('touchstart', start, { passive: true })
    el.addEventListener('touchmove', move, { passive: false })
    el.addEventListener('touchend', end)
    el.addEventListener('touchcancel', end)
    return () => {
      el.removeEventListener('touchstart', start)
      el.removeEventListener('touchmove', move)
      el.removeEventListener('touchend', end)
      el.removeEventListener('touchcancel', end)
    }
  }, [])

  return { ref, offset, dragging }
}
