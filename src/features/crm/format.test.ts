import { describe, it, expect } from 'vitest'
import { dateInputToIso, isCrmManager, isOverdue, relativeDay } from './format'

const NOW = new Date('2026-11-04T15:00:00Z')

describe('crm format', () => {
  it('a due date is overdue only once its calendar day has passed', () => {
    expect(isOverdue('2026-11-03T12:00:00Z', NOW)).toBe(true)
    expect(isOverdue('2026-11-04T01:00:00Z', NOW)).toBe(false)
    expect(isOverdue('2026-11-09T12:00:00Z', NOW)).toBe(false)
    expect(isOverdue(null, NOW)).toBe(false)
  })

  it('relative day counts calendar days in both directions', () => {
    expect(relativeDay('2026-11-04T00:30:00Z', NOW)).toBe('today')
    expect(relativeDay('2026-11-01T23:00:00Z', NOW)).toBe('3d ago')
    expect(relativeDay('2026-11-06T09:00:00Z', NOW)).toBe('in 2d')
    expect(relativeDay(undefined, NOW)).toBe('—')
  })

  it('a date input becomes an instant that keeps the chosen day in every timezone', () => {
    expect(dateInputToIso('2026-11-05')?.slice(0, 10)).toBe('2026-11-05')
    expect(dateInputToIso('')).toBeUndefined()
    expect(dateInputToIso('11/05/2026')).toBeUndefined()
  })

  it('managers, admins and the owner see every account; reps do not', () => {
    expect(isCrmManager({ isAdmin: false, user: { groups: ['role-MANAGER'] } })).toBe(true)
    expect(isCrmManager({ isAdmin: true, user: { groups: [] } })).toBe(true)
    expect(isCrmManager({ isAdmin: false, isOwner: true, user: null })).toBe(true)
    expect(isCrmManager({ isAdmin: false, user: { groups: ['role-CUSTOMER_REP'] } })).toBe(false)
  })
})
