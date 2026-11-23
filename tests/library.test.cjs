require('./register-ts.cjs')
const test = require('node:test')
const assert = require('node:assert/strict')
const lib = require('../lib/library.ts')
const stats = require('../lib/listening-stats.ts')

const v = (id, published) => ({ id: id.padEnd(11, 'x'), title: id, published, thumbnail: '' })
const videos = [v('a', '2026-11-20'), v('b', '2026-11-06'), v('c', '2026-10-30'), v('d', '2026-10-01'), v('e', '2026-09-15'), v('f', '2026-09-01')]
const id = name => name.padEnd(11, 'x')

test('continue picks the latest unfinished episode, else the newest unstarted one', () => {
  const details = {
    [id('c')]: { pos: 100, dur: 1000, updatedAt: 5 },
    [id('d')]: { pos: 300, dur: 1000, updatedAt: 9 },
    [id('a')]: { pos: 990, dur: 1000, updatedAt: 20 },
  }
  assert.deepEqual(lib.pickContinue(videos, details), { video: videos[3], resume: true })
  assert.deepEqual(lib.pickContinue(videos, { [id('a')]: { pos: 990, dur: 1000, updatedAt: 1 } }), { video: videos[1], resume: false })
  assert.deepEqual(lib.inProgress(videos, details, id('d')).map(x => x.title), ['c'])
})

test('new episode is only the recent, never-played newest', () => {
  const now = Date.parse('2026-11-24')
  assert.equal(lib.newEpisode(videos, {}, now)?.title, 'a')
  assert.equal(lib.newEpisode(videos, { [id('a')]: { pos: 1, dur: 9, updatedAt: 1 } }, now), null)
  assert.equal(lib.newEpisode(videos, {}, Date.parse('2027-01-30')), null)
  assert.equal(lib.newEpisode(videos, {}, now, id('a')), null)
})

test('daily pick is stable for a day and avoids played and newest episodes', () => {
  const first = lib.dailyPick(videos, {}, '2026-11-24')
  assert.equal(lib.dailyPick(videos, {}, '2026-11-24'), first)
  assert.ok(!['a', 'b', 'c'].includes(first.title))
  const played = Object.fromEntries(['d', 'e'].map(n => [id(n), { pos: 1, dur: 9, updatedAt: 1 }]))
  assert.equal(lib.dailyPick(videos, played, '2026-11-24').title, 'f')
  assert.equal(lib.dailyPick(videos, played, '2026-11-24', [id('f')]), null)
})

test('library groups consecutive episodes by month', () => {
  assert.deepEqual(lib.groupByMonth(videos).map(g => [g.label, g.videos.length]), [['2026年11月', 2], ['2026年10月', 2], ['2026年9月', 2]])
})

test('resume rewinds a little, more after a long break, and restarts finished episodes', () => {
  const now = 10 * 86_400_000
  assert.equal(lib.resumePosition(100, 1000, now - 1000, now), 97)
  assert.equal(lib.resumePosition(100, 1000, now - 2 * 86_400_000, now), 90)
  assert.equal(lib.resumePosition(2, 1000, now, now), 0)
  assert.equal(lib.resumePosition(998, 1000, now, now), 0)
})

test('time formatting covers hours', () => {
  assert.equal(lib.formatTime(3725), '1:02:05')
  assert.equal(lib.formatTime(65), '1:05')
  assert.equal(lib.formatDuration(5400), '1 小时 30 分')
})

test('listening stats sum a week, count streaks and prune old days', () => {
  const today = new Date(2026, 10, 24, 12)
  let s = { days: {} }
  s = stats.addListening(s, new Date(2026, 10, 22), 600)
  s = stats.addListening(s, new Date(2026, 10, 23), 300)
  s = stats.addListening(s, new Date(2026, 10, 10), 999)
  assert.equal(stats.weekSeconds(s, today), 900)
  assert.equal(stats.streak(s, today), 2)
  s = stats.addListening(s, today, 30)
  assert.equal(stats.streak(s, today), 2)
  s = stats.addListening(s, today, 30)
  assert.equal(stats.streak(s, today), 3)
  s = stats.addListening(s, new Date(2027, 5, 1), 10)
  assert.deepEqual(Object.keys(s.days), ['2027-06-01'])
})

test('stored stats are validated', () => {
  const read = value => stats.readStats({ getItem: () => value })
  assert.deepEqual(read('{"days":{"2026-11-24":120,"bad":5,"2026-11-23":-1}}'), { days: { '2026-11-24': 120 } })
  assert.deepEqual(read('not json'), { days: {} })
})
