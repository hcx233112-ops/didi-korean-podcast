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

test('list fetch errors have an accessible retry action', async ({ page }) => {
  await page.route('**/data/videos/didi.json', route => route.fulfill({ status: 503, json: { error: 'offline' } }))
  await page.goto('/')
  await expect(page.getByText('节目列表加载失败，请检查网络后重试')).toBeVisible()
  await expect(page.getByRole('button', { name: '重试加载', exact: true })).toBeVisible()
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
