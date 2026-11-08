import { describe, expect, it } from 'vitest'
import { dueDate, resolveTermsDays } from './terms'

describe('resolveTermsDays', () => {
  it('prefers bill-to, then customer, then org default, and never invents Net 0', () => {
    expect(resolveTermsDays({ billToTermsDays: 15, customerTermsDays: 30, orgDefaultTermsDays: 45 })).toEqual({ days: 15, source: 'BILL_TO' })
    expect(resolveTermsDays({ customerTermsDays: 30, orgDefaultTermsDays: 45 })).toEqual({ days: 30, source: 'CUSTOMER' })
    expect(resolveTermsDays({ billToTermsDays: null, customerTermsDays: undefined, orgDefaultTermsDays: 45 })).toEqual({ days: 45, source: 'ORG_DEFAULT' })
    expect(resolveTermsDays({})).toEqual({ days: null, source: 'NONE' })
  })
  it('an explicit 0 on a record is honoured, a negative or fractional value is ignored', () => {
    expect(resolveTermsDays({ customerTermsDays: 0, orgDefaultTermsDays: 30 }).days).toBe(0)
    expect(resolveTermsDays({ customerTermsDays: -1, orgDefaultTermsDays: 30 }).days).toBe(30)
    expect(resolveTermsDays({ customerTermsDays: 2.5, orgDefaultTermsDays: 30 }).days).toBe(30)
  })
  it('due date is a calendar add across month and year ends', () => {
    expect(dueDate('2025-12-20', 30)).toBe('2026-01-19')
    expect(dueDate('2025-01-31', 0)).toBe('2025-01-31')
  })
})
