// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { pushRecent, rankWithRecents, readRecents, recentFirst } from './recents'

beforeEach(() => localStorage.clear())

describe('recents', () => {
  it('keeps five, most recent first, no repeats, per user and kind', () => {
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) pushRecent('customer', 'u@x.test', id)
    pushRecent('customer', 'u@x.test', 'c')
    expect(readRecents('customer', 'u@x.test')).toEqual(['c', 'f', 'e', 'd', 'b'])
    expect(readRecents('customer', 'other@x.test')).toEqual([])
    expect(readRecents('location', 'u@x.test')).toEqual([])
  })

  it('survives corrupt storage', () => {
    localStorage.setItem('tms:ship-form:recent:customer:u@x.test', '{oops')
    expect(readRecents('customer', 'u@x.test')).toEqual([])
  })

  it('puts recent items first in recency order and leaves the rest in place', () => {
    const items = ['a', 'b', 'c', 'd'].map((id) => ({ id }))
    expect(recentFirst(items, ['c', 'zzz', 'a']).map((i) => i.id)).toEqual(['c', 'a', 'b', 'd'])
  })

  it('a recent match jumps the queue only when it is about as good as the best match', () => {
    const m = (id: string, score: number) => ({ record: { id }, score })
    const ranked = [m('exact', 1), m('close', 0.95), m('stale', 0.5)]
    expect(rankWithRecents(ranked, ['stale']).map((r) => r.id)).toEqual(['exact', 'close', 'stale'])
    expect(rankWithRecents(ranked, ['close']).map((r) => r.id)).toEqual(['close', 'exact', 'stale'])
  })
})
