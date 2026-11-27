'use client'

import { memo, useDeferredValue, useMemo, useState } from 'react'
import {
  DONE_THRESHOLD, type ProgressDetail, type Video, dailyPick, dayKey, formatDuration, formatTime, greeting,
  groupByMonth, inProgress, newEpisodes, pickContinue, progressOf,
} from '@/lib/library'
import type { Phrase } from '@/lib/phrases'
import { BookmarkIcon, CheckIcon, HeartIcon, PauseIcon, PlayIcon, ProgressRing, SearchIcon, ShuffleIcon } from './icons'

export interface Channel { id: string; name: string; description: string; initial: string; color: string; avatar?: string; lang?: string }
type Filter = 'all' | 'unplayed' | 'fav' | 'done'
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: '全部' }, { key: 'unplayed', label: '未听' }, { key: 'fav', label: '收藏' }, { key: 'done', label: '已听完' },
]

interface Props {
  hydrated: boolean
  videos: Video[]
  details: Record<string, ProgressDetail>
  favorites: Set<string>
  notes: Record<string, string>
  currentId: string | null
  playing: boolean
  stats: { week: number; streak: number; finished: number; days: { key: string; label: string; listened: boolean; today: boolean; future: boolean }[]; goal: number }
  phraseCount: number
  phraseOfDay: Phrase | null
  onOpenPhrases: () => void
  channels: Channel[]
  listError: string | null
  onRetryList: () => void
  onPlay: (video: Video) => void
  onContinue: (video: Video) => void
  now: number
  onToggleFav: (id: string) => void
  onResetProgress: (id: string) => void
  onOpenSettings: () => void
}

function remaining(video: Video, detail?: ProgressDetail) {
  const total = video.duration ?? detail?.dur ?? 0
  if (!total) return ''
  return detail ? `还剩 ${formatDuration(Math.max(0, total - detail.pos))}` : formatDuration(total)
}

function shortDate(published: string) {
  const [y, m, d] = published.split('-').map(Number)
  return y === new Date().getFullYear() ? `${m}月${d}日` : `${y}年${m}月${d}日`
}

function Cover({ src, size, radius = 14, className = '' }: { src: string; size: number; radius?: number; className?: string }) {
  return <img src={src} alt="" loading="lazy" decoding="async" className={`object-cover flex-shrink-0 ${className}`}
    style={{ width: size, height: size, borderRadius: radius, background: 'var(--surface-2)' }} />
}

function Equalizer() {
  return (
    <span className="inline-flex items-end gap-[2px]" style={{ height: 12 }} aria-hidden>
      {[0, 0.2, 0.4].map(d => <span key={d} style={{ width: 2.5, height: 12, borderRadius: 2, background: 'var(--accent)', transformOrigin: 'bottom', animation: `eq .7s ${d}s ease-in-out infinite` }} />)}
    </span>
  )
}

function SectionTitle({ children, extra }: { children: React.ReactNode; extra?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-5 mb-3">
      <h2 className="text-[19px] font-bold tracking-tight">{children}</h2>
      {extra}
    </div>
  )
}

function ContinueCard({ video, detail, resume, isCurrent, playing, onPlay }: {
  video: Video; detail?: ProgressDetail; resume: boolean; isCurrent: boolean; playing: boolean; onPlay: (v: Video) => void
}) {
  const p = progressOf(detail)
  const label = isCurrent && playing ? `暂停 ${video.title}` : resume ? `继续播放 ${video.title}` : `开始收听 ${video.title}`
  return (
    <div className="px-5 rise">
      <button aria-label={label} onClick={() => onPlay(video)}
        className="tap relative w-full overflow-hidden rounded-[26px] text-left p-4 flex gap-4 items-center"
        style={{ background: 'var(--surface)', border: '1px solid var(--line)' }}>
        <img src={video.thumbnail} alt="" aria-hidden className="absolute inset-0 w-full h-full object-cover scale-125 blur-2xl opacity-35" />
        <div className="absolute inset-0" style={{ background: 'linear-gradient(120deg, rgba(11,11,16,.35), rgba(11,11,16,.85))' }} />
        <Cover src={video.thumbnail} size={96} radius={18} className="relative shadow-lg" />
        <div className="relative flex-1 min-w-0">
          <p className="text-[12px] font-semibold tracking-wide" style={{ color: 'var(--accent)' }}>{resume ? '继续收听' : '最新一期'}</p>
          <p className="text-[16px] font-semibold leading-snug line-clamp-2 mt-1">{video.title}</p>
          <div className="mt-3 h-[4px] rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,.14)' }}>
            <div className="h-full rounded-full" style={{ width: `${Math.round(p * 100)}%`, background: 'var(--accent)', transition: 'width .4s' }} />
          </div>
          <p className="text-[12px] mt-1.5 tabular-nums" style={{ color: 'var(--text-2)' }}>{remaining(video, detail) || shortDate(video.published)}</p>
        </div>
        <span className="relative w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0 shadow-lg" style={{ background: '#fff', color: '#000' }}>
          {isCurrent && playing ? <PauseIcon size={20} /> : <PlayIcon size={20} className="ml-0.5" />}
        </span>
      </button>
    </div>
  )
}

function WeekStrip({ days, goal }: { days: Props['stats']['days']; goal: number }) {
  const count = days.filter(d => d.listened).length
  const met = count >= goal
  return (
    <div className="flex items-center gap-1 mt-2.5" role="img" aria-label={`本周已有 ${count} 天在听，目标 ${goal} 天`}>
      {days.map(d => (
        <span key={d.key} className="w-[22px] h-[22px] rounded-full flex items-center justify-center text-[10px] font-semibold"
          style={{
            background: d.listened ? 'var(--accent)' : 'transparent', color: d.listened ? '#000' : 'var(--text-3)',
            border: d.listened ? 'none' : `1px solid ${d.today ? 'var(--accent)' : 'var(--line)'}`, opacity: d.future ? 0.45 : 1,
          }}>{d.label}</span>
      ))}
      <span className="text-[12px] ml-1.5 font-semibold" style={{ color: met ? 'var(--accent)' : 'var(--text-2)' }}>
        {met ? '本周目标达成' : `本周 ${count}/${goal} 天`}
      </span>
    </div>
  )
}

function ContinueSkeleton() {
  return <div className="px-5"><div className="skeleton rounded-[26px]" style={{ height: 128 }} /></div>
}

const VideoRow = memo(function VideoRow({ video, channelLabel, isCurrent, playing, isFav, detail, note, onPlay, onToggleFav, onResetProgress }: {
  video: Video; channelLabel?: string; isCurrent: boolean; playing: boolean; isFav: boolean; detail?: ProgressDetail; note?: string
  onPlay: (v: Video) => void; onToggleFav: (id: string) => void; onResetProgress: (id: string) => void
}) {
  const p = progressOf(detail)
  const done = p >= DONE_THRESHOLD
  return (
    <div className="relative">
      <div role="button" tabIndex={0} aria-label={`播放 ${video.title}`}
        onKeyDown={e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onPlay(video) } }}
        onClick={() => onPlay(video)}
        className="flex items-center gap-3.5 pl-5 pr-24 py-3 cursor-pointer active:bg-white/5 transition-colors"
        style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 78px' }}>
        <Cover src={video.thumbnail} size={54} radius={12} />
        <div className="flex-1 min-w-0">
          <p className="text-[15px] leading-snug line-clamp-2" style={{ color: isCurrent ? 'var(--accent)' : done ? 'var(--text-2)' : 'var(--text)', fontWeight: isCurrent ? 600 : 500 }}>
            {video.title}
          </p>
          <p className="text-[12px] mt-1 flex items-center gap-1.5 tabular-nums" style={{ color: 'var(--text-3)' }}>
            {isCurrent && playing && <Equalizer />}
            {channelLabel && <span>{channelLabel} ·</span>}
            <span>{shortDate(video.published)}</span>
            {!done && (video.duration || detail) ? <span>· {detail && p > 0 ? remaining(video, detail) : formatTime(video.duration ?? detail?.dur ?? 0)}</span> : null}
          </p>
          {note && <p className="text-[12px] mt-1 line-clamp-1 italic" style={{ color: 'var(--text-3)' }}>{note}</p>}
        </div>
      </div>
      <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
        {done ? (
          <button aria-label={`重置进度 ${video.title}`} onClick={() => onResetProgress(video.id)} className="tap p-2" title="已听完，点按重听">
            <ProgressRing value={1} done size={24} />
          </button>
        ) : p > 0 ? (
          <span className="p-2" aria-label={`已听 ${Math.round(p * 100)}%`}><ProgressRing value={p} size={24} /></span>
        ) : null}
        <button aria-label={isFav ? `取消收藏 ${video.title}` : `收藏 ${video.title}`} aria-pressed={isFav}
          onClick={() => onToggleFav(video.id)} className="tap p-2" style={{ color: isFav ? 'var(--accent)' : 'var(--text-3)' }}>
          <HeartIcon filled={isFav} />
        </button>
      </div>
    </div>
  )
})

// Memoized: the player ticks up to four times a second and the library need not re-render with it.
export const HomeView = memo(function HomeView(props: Props) {
  const { hydrated, videos, details, favorites, notes, currentId, playing, stats, channels, onPlay } = props
  const [channelFilter, setChannelFilter] = useState<string | null>(null)
  const shortName = (id?: string) => channels.length > 1 ? channels.find(c => c.id === id)?.name.split(/[의']/)[0].trim() : undefined
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const deferredQuery = useDeferredValue(query)
  const now = useMemo(() => new Date(props.now), [props.now])

  const sections = useMemo(() => {
    if (!hydrated) return null
    const cont = pickContinue(videos, details)
    const contId = cont?.video.id
    const fresh = newEpisodes(videos, details, now.getTime(), contId)
    const going = inProgress(videos, details, contId)
    const pick = dailyPick(videos, details, dayKey(now), [contId, ...fresh.map(v => v.id)].filter(Boolean) as string[])
    return { cont, fresh, going, pick }
  }, [hydrated, videos, details, now])

  const groups = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase()
    return groupByMonth(videos.filter(v => {
      if (q && !v.title.toLowerCase().includes(q)) return false
      if (channelFilter && v.channel !== channelFilter) return false
      const p = progressOf(details[v.id])
      if (filter === 'unplayed') return !details[v.id]
      if (filter === 'fav') return favorites.has(v.id)
      if (filter === 'done') return p >= DONE_THRESHOLD
      return true
    }))
  }, [videos, details, favorites, filter, deferredQuery, channelFilter])

  const subtitle = hydrated
    ? stats.week > 0
      ? `本周已听 ${formatDuration(stats.week)}${stats.streak > 1 ? ` · 连续 ${stats.streak} 天` : ''}`
      : stats.finished ? `已听完 ${stats.finished} 集，今天也来一集吧` : '找一期喜欢的，开始听吧'
    : ' '

  return (
    <div className="pb-6">
      <header className="px-5 flex items-center gap-3" style={{ paddingTop: 'calc(env(safe-area-inset-top) + 18px)' }}>
        <div className="flex-1 min-w-0">
          <h1 className="text-[28px] font-bold tracking-tight">{hydrated ? greeting(now.getHours()) : 'Didi 播客'}</h1>
          <p className="text-[13px] mt-0.5 tabular-nums" style={{ color: 'var(--text-2)' }}>
            {stats.streak > 1 && hydrated ? <span aria-hidden>🔥 </span> : null}{subtitle}
          </p>
          {hydrated ? <WeekStrip days={stats.days} goal={stats.goal} /> : <div className="h-[22px] mt-2.5" />}
        </div>
        <button aria-label="设置与云同步" onClick={props.onOpenSettings} className="tap flex flex-shrink-0 items-center">
          {channels.map((c, i) => (
            <span key={c.id} className="w-10 h-10 rounded-full overflow-hidden flex items-center justify-center"
              style={{ background: c.color, marginLeft: i ? -14 : 0, border: '2px solid var(--bg)', zIndex: channels.length - i }}>
              {c.avatar ? <img src={c.avatar} alt="" className="w-full h-full object-cover" /> : <span className="font-bold">{c.initial}</span>}
            </span>
          ))}
        </button>
      </header>

      {props.listError && videos.length === 0 && (
        <div role="alert" className="mx-5 mt-6 p-4 rounded-2xl text-sm" style={{ background: 'var(--surface)' }}>
          <p>{props.listError}</p>
          <button className="tap mt-2 font-semibold" style={{ color: 'var(--accent)' }} onClick={props.onRetryList}>重试加载</button>
        </div>
      )}

      <div className="mt-5">
        {!sections ? <ContinueSkeleton /> : sections.cont && (
          <ContinueCard video={sections.cont.video} detail={details[sections.cont.video.id]} resume={sections.cont.resume}
            isCurrent={currentId === sections.cont.video.id} playing={playing} onPlay={props.onContinue} />
        )}
      </div>

      {sections?.fresh.map((fresh, i) => (
        <div key={fresh.id} className="px-5 mt-3 rise" style={{ animationDelay: `${60 + i * 40}ms` }}>
          <button aria-label={`收听新一期 ${fresh.title}`} onClick={() => onPlay(fresh)}
            className="tap w-full flex items-center gap-3 p-3 rounded-2xl text-left" style={{ background: 'var(--accent-soft)' }}>
            <Cover src={fresh.thumbnail} size={44} radius={10} />
            <div className="flex-1 min-w-0">
              <p className="text-[11px] font-bold tracking-wider" style={{ color: 'var(--accent)' }}>NEW · {[shortName(fresh.channel), shortDate(fresh.published)].filter(Boolean).join(' · ')}</p>
              <p className="text-[14px] font-semibold truncate">{fresh.title}</p>
            </div>
            <PlayIcon size={18} className="mr-1" />
          </button>
        </div>
      ))}

      {sections && sections.going.length > 0 && (
        <section className="mt-8 rise" style={{ animationDelay: '100ms' }}>
          <SectionTitle>还没听完</SectionTitle>
          <div className="flex gap-3 overflow-x-auto no-scrollbar px-5 snap-x snap-mandatory scroll-px-5">
            {sections.going.map(v => {
              const d = details[v.id]
              return (
                <button key={v.id} aria-label={`继续 ${v.title}`} onClick={() => onPlay(v)} className="tap snap-start flex-shrink-0 w-[138px] text-left">
                  <div className="relative">
                    <img src={v.thumbnail} alt="" loading="lazy" className="w-[138px] h-[138px] object-cover rounded-2xl" style={{ background: 'var(--surface-2)' }} />
                    <div className="absolute left-2 right-2 bottom-2 h-[4px] rounded-full overflow-hidden" style={{ background: 'rgba(0,0,0,.45)' }}>
                      <div className="h-full" style={{ width: `${Math.round(progressOf(d) * 100)}%`, background: 'var(--accent)' }} />
                    </div>
                  </div>
                  <p className="text-[13px] font-medium leading-snug line-clamp-2 mt-2">{v.title}</p>
                  <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-3)' }}>{remaining(v, d)}</p>
                </button>
              )
            })}
          </div>
        </section>
      )}

      {sections?.pick && (
        <section className="mt-8 px-5 rise" style={{ animationDelay: '140ms' }}>
          <button aria-label={`收听推荐 ${sections.pick.title}`} onClick={() => onPlay(sections.pick!)}
            className="tap w-full text-left rounded-[22px] p-4 flex gap-3.5 items-center"
            style={{ background: 'linear-gradient(135deg, var(--surface-2), var(--surface))', border: '1px solid var(--line)' }}>
            <Cover src={sections.pick.thumbnail} size={64} radius={14} />
            <div className="flex-1 min-w-0">
              <p className="text-[12px] font-semibold flex items-center gap-1" style={{ color: 'var(--accent)' }}><ShuffleIcon /> 今天听这个</p>
              <p className="text-[15px] font-semibold leading-snug line-clamp-2 mt-1">{sections.pick.title}</p>
              <p className="text-[12px] mt-1" style={{ color: 'var(--text-3)' }}>{shortDate(sections.pick.published)} · {remaining(sections.pick)}</p>
            </div>
          </button>
        </section>
      )}

      {props.phraseOfDay && (
        <section className="mt-8 px-5 rise" style={{ animationDelay: '180ms' }}>
          <button aria-label={`打开句子本，共 ${props.phraseCount} 句`} onClick={props.onOpenPhrases}
            className="tap w-full text-left rounded-[22px] p-4" style={{ background: 'var(--surface)', border: '1px solid var(--line)' }}>
            <div className="flex items-center justify-between">
              <p className="text-[12px] font-semibold flex items-center gap-1" style={{ color: 'var(--accent)' }}><BookmarkIcon size={12} filled /> 句子本 · 今日复习</p>
              <span className="text-[12px]" style={{ color: 'var(--text-3)' }}>{props.phraseCount} 句 ›</span>
            </div>
            <p className="text-[16px] font-semibold leading-snug line-clamp-2 mt-2">{props.phraseOfDay.text}</p>
            {props.phraseOfDay.zh && <p className="text-[13px] mt-1 line-clamp-1" style={{ color: 'var(--text-3)' }}>{props.phraseOfDay.zh}</p>}
          </button>
        </section>
      )}

      <section className="mt-9">
        <div className="sticky z-10 glass" style={{ top: 'env(safe-area-inset-top)', borderBottom: '1px solid var(--line)' }}>
          <div className="flex items-center justify-between px-5 pt-3">
            <h2 className="text-[19px] font-bold tracking-tight">全部节目 <span className="text-[13px] font-medium" style={{ color: 'var(--text-3)' }}>{videos.length}</span></h2>
            <button aria-label={searching ? '收起搜索' : '搜索节目'} aria-pressed={searching}
              // A hidden search box must not keep filtering the list.
              onClick={() => { if (searching) setQuery(''); setSearching(s => !s) }} className="tap w-9 h-9 rounded-full flex items-center justify-center" style={{ background: 'var(--surface-2)', color: 'var(--text-2)' }}>
              <SearchIcon />
            </button>
          </div>
          {searching && (
            <div className="px-5 pt-3">
              <input autoFocus aria-label="搜索节目标题" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索标题…"
                className="w-full px-4 py-2.5 rounded-xl text-[15px] outline-none" style={{ background: 'var(--surface-2)', color: 'var(--text)' }} />
            </div>
          )}
          {channels.length > 1 && (
            <div className="flex gap-2 px-5 pt-3 overflow-x-auto no-scrollbar">
              {[{ id: null as string | null, name: '全部博主', avatar: undefined as string | undefined }, ...channels].map(c => (
                <button key={c.id ?? 'all'} onClick={() => setChannelFilter(c.id)} aria-pressed={channelFilter === c.id}
                  className="tap flex items-center gap-1.5 pl-1 pr-3 py-1 rounded-full text-[13px] whitespace-nowrap"
                  style={{ background: channelFilter === c.id ? 'var(--accent-soft)' : 'transparent', border: `1px solid ${channelFilter === c.id ? 'var(--accent)' : 'var(--line)'}`, color: channelFilter === c.id ? 'var(--accent)' : 'var(--text-2)' }}>
                  {c.avatar ? <img src={c.avatar} alt="" className="w-6 h-6 rounded-full object-cover" /> : <span className="w-1" />}
                  {c.id ? shortName(c.id) : c.name}
                </button>
              ))}
            </div>
          )}
          <div className="flex gap-2 px-5 py-3 overflow-x-auto no-scrollbar">
            {FILTERS.map(f => (
              <button key={f.key} onClick={() => setFilter(f.key)} aria-pressed={filter === f.key}
                className="tap px-3.5 py-1.5 rounded-full text-[13px] whitespace-nowrap"
                style={{ background: filter === f.key ? 'var(--text)' : 'var(--surface-2)', color: filter === f.key ? 'var(--bg)' : 'var(--text-2)', fontWeight: filter === f.key ? 600 : 500 }}>
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {groups.length === 0 && (
          <p className="px-5 py-14 text-center text-sm" style={{ color: 'var(--text-3)' }}>
            {videos.length === 0 ? '暂时没有节目' : query ? `没有找到「${query}」` : filter === 'fav' ? '还没有收藏，点 ♡ 收藏喜欢的节目' : filter === 'done' ? '还没有听完的节目' : '全部都听过啦'}
          </p>
        )}
        {groups.map(group => (
          <div key={group.key}>
            <p className="px-5 pt-5 pb-1 text-[12px] font-semibold tracking-wide" style={{ color: 'var(--text-3)' }}>{group.label}</p>
            {group.videos.map(v => (
              <VideoRow key={v.id} video={v} channelLabel={channelFilter ? undefined : shortName(v.channel)} isCurrent={currentId === v.id} playing={currentId === v.id && playing}
                isFav={favorites.has(v.id)} detail={details[v.id]} note={notes[v.id]}
                onPlay={onPlay} onToggleFav={props.onToggleFav} onResetProgress={props.onResetProgress} />
            ))}
          </div>
        ))}
        {hydrated && stats.finished > 0 && (
          <p className="px-5 pt-8 text-center text-[12px] flex items-center justify-center gap-1" style={{ color: 'var(--text-3)' }}>
            <CheckIcon /> 已经听完 {stats.finished} 集
          </p>
        )}
      </section>
    </div>
  )
})
