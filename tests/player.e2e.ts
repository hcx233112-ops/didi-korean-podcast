import { test, expect } from '@playwright/test'

const first = { id: 'abcdefghijk', title: 'First episode', published: '2026-11-01', thumbnail: '/file.svg', duration: 2000 }
const second = { id: 'lmnopqrstuv', title: 'Second episode', published: '2026-10-31', thumbnail: '/file.svg', duration: 2000 }

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('podcast-favorites', JSON.stringify(['abcdefghijk']))
    const prototype = HTMLMediaElement.prototype
    const times = new WeakMap<HTMLMediaElement, number>()
    const paused = new WeakMap<HTMLMediaElement, boolean>()
    Object.defineProperty(prototype, 'duration', { get: () => 2000 })
    Object.defineProperty(prototype, 'currentTime', { get() { return times.get(this) || 0 }, set(value) { times.set(this, value); this.dispatchEvent(new Event('seeked')) } })
    Object.defineProperty(prototype, 'paused', { get() { return paused.get(this) ?? true } })
    Object.defineProperty(prototype, 'src', { get() { return this.getAttribute('data-test-src') || '' }, set(value) { this.setAttribute('data-test-src', value); queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata'))) } })
    prototype.play = function () { paused.set(this, false); this.dispatchEvent(new Event('play')); return Promise.resolve() }
    prototype.pause = function () { paused.set(this, true); this.dispatchEvent(new Event('pause')) }
  })
  await page.route('**/data/videos/didi.json', route => route.fulfill({ json: { channelName: 'Test', videos: [first, second] } }))
  await page.route('**/data/transcripts/*.json', route => {
    const isFirst = route.request().url().includes(first.id)
    const prefix = isFirst ? 'First line' : 'Second line'
    return route.fulfill({ json: { segments: Array.from({ length: 300 }, (_, i) => ({ start: i * 5, end: i * 5 + 4, ko: `${prefix} ${i}`, zh: `Translation ${i}` })) } })
  })
})

test('legacy favorites remain usable, and removals leave a timestamped tombstone', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await page.getByRole('button', { name: '取消收藏 First episode', exact: true }).click()
  await expect(page.getByRole('button', { name: '收藏 First episode', exact: true })).toHaveCount(1)
  const record = await page.evaluate(() => JSON.parse(localStorage.getItem('podcast-sync-v2')!).favorites.abcdefghijk)
  expect(record.value).toBe(false)
  expect(record.updatedAt).toBeGreaterThan(0)
  expect(errors).toEqual([])
})

test('full transcript stays browsable, keyboard seeking works, and autoplay changes subtitles', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await page.getByRole('button', { name: '播放 First episode', exact: true }).click()
  await page.getByRole('button', { name: '打开当前节目字幕', exact: true }).click()
  await expect(page.locator('#seg-299')).toContainText('First line 299')
  await page.locator('#seg-299').scrollIntoViewIfNeeded()
  await expect(page.locator('#seg-299')).toBeVisible()
  const slider = page.getByRole('slider', { name: '播放进度' }).last()
  await slider.focus()
  await slider.press('ArrowRight')
  expect(await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0)
  await page.locator('audio').evaluate(audio => audio.dispatchEvent(new Event('ended')))
  await expect(page.locator('#seg-0')).toContainText('Second line 0')
  expect(errors).toEqual([])
})

test('a failed list refresh keeps the prerendered library usable', async ({ page }) => {
  await page.route('**/data/videos/didi.json', route => route.fulfill({ status: 503, json: { error: 'offline' } }))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /全部节目/ })).toBeVisible()
  await expect(page.locator('[aria-label^="播放 "]').first()).toBeVisible()
  await expect(page.getByText('节目列表加载失败，请检查网络后重试')).toHaveCount(0)
})

test('home resumes the latest unfinished episode slightly before where it stopped', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('podcast-sync-v2', JSON.stringify({ version: 2, favorites: {}, progress: { lmnopqrstuv: { pos: 600, dur: 2000, updatedAt: Date.now() } } }))
  })
  await page.goto('/')
  await page.getByRole('button', { name: '继续播放 Second episode', exact: true }).click()
  await expect.poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBe(597)
  await expect(page.getByRole('button', { name: '继续 First episode' })).toHaveCount(0)
})

test('background audio pause persists the latest listening position', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '播放 First episode', exact: true }).click()
  await page.locator('audio').evaluate((audio: HTMLAudioElement) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    audio.currentTime = 1234
    audio.dispatchEvent(new Event('timeupdate'))
    audio.pause()
  })
  const record = await page.evaluate(() => JSON.parse(localStorage.getItem('podcast-sync-v2')!).progress.abcdefghijk)
  expect(record.pos).toBe(1234)
})

test('an unconfigured real sync endpoint returns a failure instead of pretending to save', async ({ request }) => {
  const response = await request.post('/api/sync', { data: { arbitrary: 'overwrite' } })
  expect(response.status()).toBe(503)
  expect(await response.json()).toHaveProperty('error')
})

test('autoplay skips finished episodes, and tapping the loaded episode opens the player instead of pausing', async ({ page }) => {
  const third = { id: 'wxyzabcdefg', title: 'Third episode', published: '2026-10-30', thumbnail: '/x.jpg', duration: 2000 }
  await page.route('**/data/videos/didi.json', route => route.fulfill({ json: { channelName: 'Test', videos: [first, second, third] } }))
  await page.addInitScript(() => {
    localStorage.setItem('podcast-sync-v2', JSON.stringify({ version: 2, favorites: {}, progress: { lmnopqrstuv: { pos: 1990, dur: 2000, updatedAt: 1 } } }))
  })
  await page.goto('/')
  await page.getByRole('button', { name: '播放 First episode', exact: true }).click()
  await page.getByRole('button', { name: '播放 First episode', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '正在播放' })).toBeVisible()
  expect(await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(false)
  await page.locator('audio').evaluate(audio => audio.dispatchEvent(new Event('ended')))
  await expect(page.getByRole('dialog', { name: '正在播放' })).toContainText('Third episode')
})

async function openTranscript(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.getByRole('button', { name: '播放 First episode', exact: true }).click()
  await page.getByRole('button', { name: '打开当前节目字幕', exact: true }).click()
  await expect(page.locator('#seg-2')).toContainText('First line 2')
  await page.evaluate(() => {
    const audio = document.querySelector('audio')!
    const log: string[] = []
    Object.assign(window, { audioLog: log })
    for (const type of ['pause', 'play', 'seeked']) audio.addEventListener(type, () => log.push(`${type}@${audio.currentTime}`))
  })
}
const audioLog = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as { audioLog: string[] }).audioLog)
const setTime = (page: import('@playwright/test').Page, t: number) => page.locator('audio').evaluate((audio: HTMLAudioElement, time) => { audio.currentTime = time }, t)

test('sentence loop rests briefly at the end of the sentence, then replays it', async ({ page }) => {
  await openTranscript(page)
  await page.getByRole('button', { name: /^跟读练习/ }).click()
  await page.getByRole('button', { name: /^单句循环/ }).click()
  await setTime(page, 7)
  await setTime(page, 8.96)
  await expect.poll(() => audioLog(page)).toEqual(['seeked@7', 'seeked@8.96', 'pause@8.96', 'seeked@5', 'play@5'])
  await expect(page.locator('#seg-1')).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.07)')
})

test('shadowing pauses after each sentence for the listener, then carries on without rewinding', async ({ page }) => {
  await page.route('**/data/transcripts/*.json', route => route.fulfill({ json: { segments: Array.from({ length: 50 }, (_, i) => ({ start: i * 2, end: i * 2 + 1, ko: `First line ${i}`, zh: `Translation ${i}` })) } }))
  await openTranscript(page)
  await page.getByRole('button', { name: /^跟读练习/ }).click()
  await page.getByRole('button', { name: /^逐句跟读/ }).click()
  await setTime(page, 4.97)
  await expect(page.locator('#seg-2')).toContainText('该你说了')
  expect(await audioLog(page)).toEqual(['seeked@4.97', 'pause@4.97'])
  await expect.poll(() => audioLog(page), { timeout: 4000 }).toEqual(['seeked@4.97', 'pause@4.97', 'play@4.97'])
  await expect(page.locator('#seg-2')).not.toContainText('该你说了')
  // The next sentence is drilled next.
  await setTime(page, 6.96)
  await expect.poll(() => audioLog(page)).toContain('pause@6.96')
})

test('pressing play during a shadow pause continues at once', async ({ page }) => {
  await openTranscript(page)
  await page.getByRole('button', { name: /^跟读练习/ }).click()
  await page.getByRole('button', { name: /^逐句跟读/ }).click()
  await setTime(page, 8.97)
  await expect(page.locator('#seg-1')).toContainText('该你说了')
  await page.getByRole('button', { name: '开始播放' }).last().click()
  expect(await audioLog(page)).toEqual(['seeked@8.97', 'pause@8.97', 'play@8.97'])
  await expect(page.locator('#seg-1')).not.toContainText('该你说了')
})

test('a long-pressed sentence opens its menu without seeking, and saved sentences play alone from home', async ({ page }) => {
  await openTranscript(page)
  // hover waits for the player's slide-up animation to settle before pressing.
  await page.locator('#seg-2').hover()
  await page.mouse.down()
  const menu = page.getByRole('dialog', { name: '这一句' })
  await expect(menu).toContainText('First line 2')
  await page.mouse.up()
  expect(await audioLog(page)).toEqual([])
  await expect(menu.getByRole('link', { name: 'First' })).toHaveAttribute('href', /korean\.dict\.naver\.com/)
  await menu.getByRole('button', { name: '收藏句子' }).click()
  await expect(menu.getByRole('button', { name: '已收藏' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await page.getByRole('button', { name: '收起播放器' }).click()
  await page.getByRole('button', { name: /^打开句子本/ }).click()
  const book = page.getByRole('dialog', { name: '句子本' })
  await expect(book).toContainText('Translation 2')
  await book.getByRole('button', { name: '播放这一句 First line 2' }).click()
  await expect.poll(() => audioLog(page)).toEqual(['seeked@10', 'play@10'])
  await setTime(page, 13.95)
  await expect.poll(() => audioLog(page)).toEqual(['seeked@10', 'play@10', 'seeked@13.95', 'pause@13.95'])
  await book.getByRole('button', { name: '取消收藏 First line 2' }).click()
  await expect(book.getByRole('button', { name: '重新收藏 First line 2' })).toBeVisible()
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('podcast-phrases-v1')!))).toEqual([])
})

test('the week strip counts listening days, and keyboard shortcuts drive playback', async ({ page }) => {
  await page.addInitScript(() => {
    const d = new Date(), key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    localStorage.setItem('podcast-stats-v1', JSON.stringify({ days: { [key]: 600 } }))
  })
  await page.goto('/')
  await expect(page.getByRole('img', { name: '本周已有 1 天在听，目标 4 天' })).toBeVisible()
  await page.getByRole('button', { name: '播放 First episode', exact: true }).click()
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('Space')
  expect(await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true)
  await page.keyboard.press('ArrowRight')
  expect(await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBe(5)
})
