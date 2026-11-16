import { describe, expect, it } from 'vitest'
import { deliveryDateOf, waitingForReview, weekOf, weeklyReviewLag, type ReviewLagRow } from './reviewLag'

const NOW = Date.parse('2026-11-15T18:00:00Z') // Sunday Nov 15, Chicago

const row = (over: Partial<ReviewLagRow>): ReviewLagRow => ({ status: 'DELIVERED', arStatus: 'DOCS_NEEDED', ...over }) as ReviewLagRow

describe('weekOf', () => {
  it('buckets Monday–Sunday in Chicago time', () => {
    expect(weekOf('2026-11-09T12:00:00Z')).toBe('2026-11-09') // Monday
    expect(weekOf('2026-11-15T18:00:00Z')).toBe('2026-11-09') // Sunday afternoon, same week
    expect(weekOf('2026-11-16T03:00:00Z')).toBe('2026-11-09') // Sunday 9 pm Chicago, still that week
    expect(weekOf('2026-11-16T15:00:00Z')).toBe('2026-11-16')
  })
})

describe('deliveryDateOf', () => {
  it('uses the actual delivery, else the scheduled one', () => {
    expect(deliveryDateOf(row({ deliveredAt: '2026-11-10T10:00:00Z', deliveryAppt: '2026-11-08T10:00:00Z' }))).toBe('2026-11-10T10:00:00Z')
    expect(deliveryDateOf(row({ status: 'IN_TRANSIT', deliveryAppt: '2026-11-08T10:00:00Z', deliveryApptEnd: '2026-11-09T10:00:00Z' }))).toBe('2026-11-09T10:00:00Z')
  })
})

describe('weeklyReviewLag', () => {
  it('averages delivery → push per week and reads empty weeks as null', () => {
    const rows = [
      row({ deliveredAt: '2026-11-10T00:00:00Z', loadReviewPushedAt: '2026-11-12T00:00:00Z' }), // 2 d, this week
      row({ deliveredAt: '2026-11-08T00:00:00Z', loadReviewPushedAt: '2026-11-12T00:00:00Z' }), // 4 d, this week
      row({ deliveredAt: '2026-11-01T00:00:00Z', loadReviewPushedAt: '2026-11-04T00:00:00Z' }), // 3 d, last week
      row({ deliveredAt: '2026-11-01T00:00:00Z', loadReviewPushedAt: '2026-11-04T00:00:00Z', voidedAt: 'x' }),
    ]
    const weeks = weeklyReviewLag(rows, NOW, 3)
    expect(weeks.map((w) => w.week)).toEqual(['2026-10-26', '2026-11-02', '2026-11-09'])
    expect(weeks[2]).toEqual({ week: '2026-11-09', count: 2, avgDays: 3 })
    expect(weeks[1].avgDays).toBe(3)
    expect(weeks[0].avgDays).toBeNull()
  })
})

describe('waitingForReview', () => {
  it('counts delivered or past-due loads not pushed and not released', () => {
    const rows = [
      row({ deliveredAt: '2026-11-13T18:00:00Z' }), // 2 d waiting
      row({ status: 'IN_TRANSIT', deliveryAppt: '2026-11-11T18:00:00Z' }), // past due 4 d
      row({ deliveredAt: '2026-11-13T18:00:00Z', loadReviewPushedAt: '2026-11-14T00:00:00Z' }),
      row({ deliveredAt: '2026-11-13T18:00:00Z', arStatus: 'UNPAID' }), // released without review
      row({ status: 'IN_TRANSIT', deliveryAppt: '2026-11-20T18:00:00Z' }), // not due yet
    ]
    expect(waitingForReview(rows, NOW)).toEqual({ count: 2, avgDays: 3 })
  })
})
