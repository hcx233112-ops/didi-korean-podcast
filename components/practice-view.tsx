'use client'

import { useState } from 'react'
import { DRILL_LABEL, type DrillMode, dictionaryUrl, lookupWords } from '@/lib/drill'
import { type Video, formatTime } from '@/lib/library'
import type { Phrase } from '@/lib/phrases'
import { BookmarkIcon, CheckIcon, CopyIcon, PlayIcon, RepeatIcon } from './icons'
import type { TranscriptSegment } from './player-view'

const MODES: { mode: DrillMode; hint: string }[] = [
  { mode: 'off', hint: '正常连续播放' },
  { mode: 'loop', hint: '当前这句反复播放；点别的句子就换成循环那句' },
  { mode: 'shadow', hint: '每句播完停一下，留时间跟着说一遍，再接着播下一句' },
]
export const GAP_SCALES = [{ value: 1, label: '短' }, { value: 1.5, label: '中' }, { value: 2, label: '长' }]

export function DrillOptions({ mode, gapScale, onPick, onGapScale }: {
  mode: DrillMode; gapScale: number; onPick: (mode: DrillMode) => void; onGapScale: (scale: number) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      {MODES.map(m => (
        <button key={m.mode} onClick={() => onPick(m.mode)} aria-pressed={mode === m.mode}
          className="tap w-full text-left rounded-2xl px-4 py-3 flex items-center gap-3"
          style={{ background: mode === m.mode ? 'var(--accent-soft)' : 'var(--surface-2)' }}>
          <div className="flex-1 min-w-0">
            <p className="text-[15px] font-semibold" style={{ color: mode === m.mode ? 'var(--accent)' : 'var(--text)' }}>{m.mode === 'off' ? '关闭' : DRILL_LABEL[m.mode]}</p>
            <p className="text-[12px] mt-0.5" style={{ color: 'var(--text-2)' }}>{m.hint}</p>
          </div>
          {mode === m.mode && <span style={{ color: 'var(--accent)' }}><CheckIcon size={16} /></span>}
        </button>
      ))}
      {mode === 'shadow' && (
        <div className="flex items-center gap-3 mt-2 px-1">
          <span className="text-[13px] flex-1" style={{ color: 'var(--text-2)' }}>停顿时长</span>
          <div className="flex p-1 rounded-full" style={{ background: 'var(--surface-2)' }}>
            {GAP_SCALES.map(g => (
              <button key={g.value} onClick={() => onGapScale(g.value)} aria-pressed={gapScale === g.value}
                className="px-4 py-1 rounded-full text-[13px] font-semibold"
                style={{ background: gapScale === g.value ? 'var(--text)' : 'transparent', color: gapScale === g.value ? 'var(--bg)' : 'var(--text-2)' }}>{g.label}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export function SegmentMenu({ seg, lang, saved, looping, onLoop, onToggleSave, onCopy }: {
  seg: TranscriptSegment; lang?: string; saved: boolean; looping: boolean
  onLoop: () => void; onToggleSave: () => void; onCopy: () => void
}) {
  const words = lookupWords(seg.ko)
  const action = 'tap flex-1 py-3 rounded-2xl text-[14px] font-semibold flex flex-col items-center gap-1'
  return (
    <div>
      <p className="text-[18px] font-semibold leading-relaxed">{seg.ko}</p>
      {seg.zh && seg.zh !== seg.ko && <p className="text-[14px] mt-1.5" style={{ color: 'var(--text-2)' }}>{seg.zh}</p>}
      <p className="text-[12px] mt-1" style={{ color: 'var(--text-3)' }}>{formatTime(seg.start)}</p>
      {words.length > 0 && (
        <>
          <p className="text-[12px] font-semibold mt-4 mb-2" style={{ color: 'var(--text-2)' }}>点词查{lang === 'en' ? '有道' : 'Naver 韩中'}词典</p>
          <div data-sheet-scroll className="flex flex-wrap gap-2 max-h-[22dvh] overflow-y-auto">
            {words.map(w => (
              <a key={w} href={dictionaryUrl(w, lang)} target="_blank" rel="noopener noreferrer"
                className="tap px-3 py-1.5 rounded-full text-[14px]" style={{ background: 'var(--surface-2)', color: 'var(--text)' }}>{w}</a>
            ))}
          </div>
        </>
      )}
      <div className="flex gap-2.5 mt-5">
        <button onClick={onLoop} className={action} style={{ background: looping ? 'var(--accent-soft)' : 'var(--surface-2)', color: looping ? 'var(--accent)' : 'var(--text)' }}>
          <RepeatIcon size={20} />循环这句
        </button>
        <button onClick={onToggleSave} aria-pressed={saved} className={action} style={{ background: saved ? 'var(--accent-soft)' : 'var(--surface-2)', color: saved ? 'var(--accent)' : 'var(--text)' }}>
          <BookmarkIcon size={20} filled={saved} />{saved ? '已收藏' : '收藏句子'}
        </button>
        <button onClick={onCopy} className={action} style={{ background: 'var(--surface-2)' }}>
          <CopyIcon size={20} />复制
        </button>
      </div>
    </div>
  )
}

export function PhraseBook({ phrases, savedKeys, videos, playingKey, onPlay, onToggle }: {
  phrases: Phrase[]; savedKeys: Set<string>; videos: Map<string, Video>; playingKey: string | null
  onPlay: (phrase: Phrase) => void; onToggle: (phrase: Phrase) => void
}) {
  // A snapshot keeps removed sentences on screen, so an accidental removal is one tap to undo.
  const [list] = useState(phrases)
  const [hideZh, setHideZh] = useState(false)
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set())
  if (!list.length) return <p className="py-10 text-center text-sm" style={{ color: 'var(--text-3)' }}>在字幕页长按一句话，就能收藏到这里</p>
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-[13px]" style={{ color: 'var(--text-2)' }}>{savedKeys.size} 句 · 点 ▶ 只播这一句</p>
        <button onClick={() => { setHideZh(v => !v); setRevealed(new Set()) }} aria-pressed={hideZh}
          className="tap px-3 py-1.5 rounded-full text-[12px] font-semibold"
          style={{ background: hideZh ? 'var(--accent-soft)' : 'var(--surface-2)', color: hideZh ? 'var(--accent)' : 'var(--text-2)' }}>遮住翻译</button>
      </div>
      <div data-sheet-scroll className="max-h-[62dvh] overflow-y-auto -mx-5 px-5 flex flex-col gap-2.5 pb-1">
        {list.map(p => {
          const saved = savedKeys.has(p.key), video = videos.get(p.videoId)
          const hidden = hideZh && !revealed.has(p.key)
          return (
            <div key={p.key} className="rounded-2xl p-3.5" style={{ background: 'var(--surface-2)', opacity: saved ? 1 : 0.5 }}>
              <p className="text-[16px] font-semibold leading-relaxed">{p.text}</p>
              {p.zh && (
                <button onClick={() => setRevealed(prev => new Set(prev).add(p.key))} disabled={!hidden} aria-label={hidden ? '显示翻译' : undefined}
                  className="block text-left text-[13px] mt-1" style={{ color: 'var(--text-2)', filter: hidden ? 'blur(6px)' : 'none', transition: 'filter .2s' }}>{p.zh}</button>
              )}
              <div className="flex items-center gap-2 mt-2.5">
                <p className="flex-1 min-w-0 text-[12px] truncate" style={{ color: 'var(--text-3)' }}>{video ? video.title : '已下架的节目'} · {formatTime(p.start)}</p>
                <button aria-label={`播放这一句 ${p.text}`} disabled={!video} onClick={() => onPlay(p)}
                  className="tap w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0"
                  style={{ background: playingKey === p.key ? 'var(--accent)' : 'var(--text)', color: 'var(--bg)', opacity: video ? 1 : 0.3 }}>
                  <PlayIcon size={15} className="ml-0.5" />
                </button>
                <button aria-label={saved ? `取消收藏 ${p.text}` : `重新收藏 ${p.text}`} aria-pressed={saved} onClick={() => onToggle(p)}
                  className="tap w-9 h-9 flex items-center justify-center flex-shrink-0" style={{ color: saved ? 'var(--accent)' : 'var(--text-3)' }}>
                  <BookmarkIcon size={18} filled={saved} />
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
