require('./register-ts.cjs')
const test = require('node:test')
const assert = require('node:assert/strict')
const drill = require('../lib/drill.ts')
const phrases = require('../lib/phrases.ts')
const stats = require('../lib/listening-stats.ts')

const segs = [{ start: 1, end: 3 }, { start: 3, end: 6 }, { start: 8, end: 10 }]

test('anchor finds the sentence being heard, and a silent gap belongs to the next one', () => {
  assert.equal(drill.drillAnchor(segs, 0), 0)
  assert.equal(drill.drillAnchor(segs, 1), 0)
  assert.equal(drill.drillAnchor(segs, 3), 1)
  assert.equal(drill.drillAnchor(segs, 7), 2)
  assert.equal(drill.drillAnchor(segs, 99), 2)
  assert.equal(drill.drillAnchor([], 5), -1)
})

test('loop returns to the start of the same sentence after a short gap', () => {
  assert.deepEqual(drill.drillStep('loop', segs, 1, 4), { kind: 'none' })
  assert.deepEqual(drill.drillStep('loop', segs, 1, 5.96), { kind: 'pause', waitMs: 600, resumeAt: 3, next: 1 })
  assert.deepEqual(drill.drillStep('off', segs, 1, 5.99), { kind: 'none' })
})

test('shadowing pauses for the listener to repeat, then moves on without rewinding', () => {
  const step = drill.drillStep('shadow', segs, 1, 6)
  assert.equal(step.kind, 'pause')
  assert.equal(step.resumeAt, null)
  assert.equal(step.next, 2)
  assert.equal(step.waitMs, 4100)
  assert.equal(drill.drillStep('shadow', segs, 2, 10).next, 3)
  assert.deepEqual(drill.drillStep('shadow', segs, 3, 10), { kind: 'none' })
})

test('shadow gaps stay between a breath and a long pause', () => {
  assert.equal(drill.shadowGapMs({ start: 0, end: 0.2 }, 1.2), 1200)
  assert.equal(drill.shadowGapMs({ start: 0, end: 60 }, 2), 15000)
})

test('a far jump re-anchors instead of acting on a stale sentence', () => {
  assert.deepEqual(drill.drillStep('loop', segs, 0, 9), { kind: 'anchor' })
  // Resuming a shadow pause mid-gap waits for the next sentence instead of re-drilling the last one.
  assert.deepEqual(drill.drillStep('shadow', segs, 2, 5.95), { kind: 'none' })
  assert.deepEqual(drill.drillStep('loop', segs, 5, 1), { kind: 'none' })
})

test('replay goes to the sentence start, or the previous one when already at its start', () => {
  assert.equal(drill.replayTarget(segs, 4.5), 1)
  assert.equal(drill.replayTarget(segs, 3.3), 0)
  assert.equal(drill.replayTarget(segs, 1.2), 0)
  assert.equal(drill.replayTarget(segs, 0.5), null)
})

test('lookup words drop punctuation and duplicates', () => {
  assert.deepEqual(drill.lookupWords('"안녕하세요." 디디입니다, 디디입니다!'), ['안녕하세요', '디디입니다'])
  assert.deepEqual(drill.lookupWords("Hello, how're you?"), ['Hello', "how're", 'you'])
  assert.match(drill.dictionaryUrl('사과'), /korean\.dict\.naver\.com\/kozhdict\/#\/search\?query=%EC%82%AC%EA%B3%BC$/)
  assert.match(drill.dictionaryUrl('apple', 'en'), /youdao/)
})

test('saved sentences list newest first and keep no duplicate translation', () => {
  const a = phrases.phraseRecord({ start: 1.5, end: 3, ko: ' 안녕 ', zh: '你好' })
  const b = phrases.phraseRecord({ start: 5, end: 4, ko: 'Hi', zh: 'Hi' })
  assert.deepEqual(a, { value: true, start: 1.5, end: 3, text: '안녕', zh: '你好' })
  assert.deepEqual([b.end, b.zh], [5, ''])
  const list = phrases.phraseList({
    [phrases.phraseKey('abcdefghijk', 1.5)]: { ...a, updatedAt: 10 },
    [phrases.phraseKey('abcdefghijk', 5)]: { ...b, updatedAt: 20 },
    'abcdefghijk@700': { value: false, start: 7, end: 8, text: '', zh: '', updatedAt: 30 },
  })
  assert.deepEqual(list.map(p => [p.key, p.videoId, p.savedAt]), [['abcdefghijk@500', 'abcdefghijk', 20], ['abcdefghijk@150', 'abcdefghijk', 10]])
})

test('the week runs Monday to Sunday and counts only real listening days', () => {
  const wednesday = new Date(2026, 10, 25)
  const week = stats.weekDays({ days: { '2026-11-23': 600, '2026-11-24': 30, '2026-11-25': 61, '2026-11-22': 900 } }, wednesday)
  assert.deepEqual(week.map(d => d.label).join(''), '一二三四五六日')
  assert.deepEqual(week.map(d => d.listened), [true, false, true, false, false, false, false])
  assert.equal(week.findIndex(d => d.today), 2)
  assert.deepEqual(week.map(d => d.future), [false, false, false, true, true, true, true])
  const sunday = stats.weekDays({ days: {} }, new Date(2026, 10, 29))
  assert.equal(sunday[0].key, '2026-11-23')
  assert.equal(sunday[6].today, true)
})
