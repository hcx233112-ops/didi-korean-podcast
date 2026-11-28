'use client'

import { useEffect, useState } from 'react'

/**
 * Opened with ?perf on a phone. Frame rate is split into still and scrolling, so a browser that caps
 * frames (heat, Low Power Mode) is told apart from a page that is slow to scroll; render time is how long
 * the browser spends drawing each frame after scripts run.
 */
export function PerfProbe() {
  const [stats, setStats] = useState({ still: 0, scrolling: 0, janks: 0, render: 0, renderMax: 0 })

  useEffect(() => {
    let frame = 0, last = performance.now(), lastScroll = -Infinity
    const frames: { t: number; scrolling: boolean }[] = [], janks: number[] = [], renders: { t: number; ms: number }[] = []
    const onScroll = () => { lastScroll = performance.now() }
    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    const loop = (t: number) => {
      const start = performance.now()
      // A timer queued here runs once the browser has finished drawing this frame.
      setTimeout(() => renders.push({ t, ms: performance.now() - start }), 0)
      if (t - last > 45 && t - last < 1000) janks.push(t)
      last = t
      frames.push({ t, scrolling: t - lastScroll < 200 })
      while (frames[0].t < t - 2000) frames.shift()
      while (janks.length && janks[0] < t - 5000) janks.shift()
      while (renders.length && renders[0].t < t - 2000) renders.shift()
      frame = requestAnimationFrame(loop)
    }
    frame = requestAnimationFrame(loop)
    const rate = (list: typeof frames) => list.length < 2 ? 0 : Math.round((list.length - 1) * 1000 / (list[list.length - 1].t - list[0].t))
    const show = setInterval(() => setStats({
      still: rate(frames.filter(f => !f.scrolling)), scrolling: rate(frames.filter(f => f.scrolling)), janks: janks.length,
      render: renders.length ? Math.round(renders.reduce((sum, r) => sum + r.ms, 0) / renders.length) : 0,
      renderMax: Math.round(Math.max(0, ...renders.map(r => r.ms))),
    }), 500)
    return () => { cancelAnimationFrame(frame); clearInterval(show); document.removeEventListener('scroll', onScroll, { capture: true }) }
  }, [])

  return (
    <section aria-label="性能检测" className="fixed right-2 z-[200] p-2 rounded-xl text-[11px] font-semibold tabular-nums leading-snug pointer-events-none"
      style={{ top: 'calc(env(safe-area-inset-top) + 6px)', background: 'rgba(0,0,0,.9)', border: '1px solid var(--line)', color: stats.janks ? '#ff8a8a' : '#8affa8' }}>
      静止 {stats.still} · 滑动 {stats.scrolling} fps<br />卡顿 {stats.janks} · 渲染 {stats.render}/{stats.renderMax} ms
    </section>
  )
}
