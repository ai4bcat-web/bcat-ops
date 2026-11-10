import { describe, it, expect } from 'vitest'
import { statusPatch, sortFeedback, filterFeedback, groupByPage, isOwnFeedback, priorityOf, type FeedbackItem } from './feedbackLogic'

const mk = (o: Partial<FeedbackItem>): FeedbackItem => ({ id: 'x', page: 'Loads', summary: 's', createdAt: '2026-01-01T00:00:00Z', ...o })

describe('feedback logic', () => {
  it('sets resolvedAt only for DONE', () => {
    const now = new Date('2026-11-04T10:00:00Z')
    expect(statusPatch('DONE', now)).toEqual({ status: 'DONE', resolvedAt: '2026-11-04T10:00:00.000Z' })
    expect(statusPatch('IN_PROGRESS', now).resolvedAt).toBeNull()
  })
  it('sorts by status rank, treating missing status as NEW', () => {
    const a = mk({ id: 'a', status: 'DONE' }), b = mk({ id: 'b' }), c = mk({ id: 'c', status: 'IN_PROGRESS' })
    expect(sortFeedback([a, b, c], 'status', 'asc').map((f) => f.id)).toEqual(['b', 'c', 'a'])
    expect(sortFeedback([a, b, c], 'status', 'desc').map((f) => f.id)).toEqual(['a', 'c', 'b'])
  })
  it('sorts by created date', () => {
    const a = mk({ id: 'a', createdAt: '2026-01-02' }), b = mk({ id: 'b', createdAt: '2026-01-03' })
    expect(sortFeedback([a, b], 'createdAt', 'desc').map((f) => f.id)).toEqual(['b', 'a'])
  })
  it('filters by status, page and search text', () => {
    const items = [mk({ id: 'a', summary: 'Broken grid' }), mk({ id: 'b', page: 'Fuel', status: 'DONE' })]
    expect(filterFeedback(items, { status: 'DONE', page: 'ALL', query: '' }).map((f) => f.id)).toEqual(['b'])
    expect(filterFeedback(items, { status: 'ALL', page: 'Loads', query: 'grid' }).map((f) => f.id)).toEqual(['a'])
    expect(filterFeedback(items, { status: 'ALL', page: 'ALL', query: 'zzz' })).toEqual([])
  })
  it('groups by page alphabetically', () => {
    const g = groupByPage([mk({ id: 'a', page: 'Loads' }), mk({ id: 'b', page: 'Fuel' }), mk({ id: 'c', page: 'Loads' })])
    expect(g.map((x) => [x.page, x.items.length])).toEqual([['Fuel', 1], ['Loads', 2]])
  })
})

describe('isOwnFeedback', () => {
  it('matches the submitter by e-mail, ignoring case and spaces, and never an empty address', () => {
    const f = { id: 'x', page: 'P', summary: 'S', submittedBy: 'Ryne@bcatcorp.com' } as FeedbackItem
    expect(isOwnFeedback(f, ' ryne@bcatcorp.com ')).toBe(true)
    expect(isOwnFeedback(f, 'ruben@bcatcorp.com')).toBe(false)
    expect(isOwnFeedback(f, '')).toBe(false)
    expect(isOwnFeedback({ ...f, submittedBy: null }, '')).toBe(false)
  })
})

describe('priority', () => {
  const f = (id: string, priority: number | null | undefined, createdAt = '2026-01-01T00:00:00Z'): FeedbackItem => ({ id, page: 'P', summary: id, priority, createdAt })
  it('reads 1, 2 and 3; anything else (older reports) is not set', () => {
    expect(priorityOf(f('a', 1))).toBe(1)
    expect(priorityOf(f('b', 3))).toBe(3)
    expect(priorityOf(f('c', undefined))).toBeNull()
    expect(priorityOf(f('d', 7))).toBeNull()
  })
  it('sorts blocking first and unset last, and filters by priority', () => {
    const items = [f('none', null), f('p3', 3), f('p1', 1), f('p2', 2)]
    expect(sortFeedback(items, 'priority', 'asc').map((i) => i.id)).toEqual(['p1', 'p2', 'p3', 'none'])
    expect(filterFeedback(items, { status: 'ALL', page: 'ALL', query: '', priority: 1 }).map((i) => i.id)).toEqual(['p1'])
    expect(filterFeedback(items, { status: 'ALL', page: 'ALL', query: '', priority: 'ALL' })).toHaveLength(4)
  })
})

