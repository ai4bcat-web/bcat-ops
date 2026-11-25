import { describe, expect, it } from 'vitest'
import { offersRelease } from '@/lib/factoringResubmit'

const dead = { status: 'PENDING_WITH_OTR' as const, otrInvoiceId: '26308819', otrStatus: '4', otrScheduleId: null, factoredAt: null }

describe('offersRelease', () => {
  it('offers it for a waiting row OTR holds as Dead and never funded', () => {
    expect(offersRelease(dead)).toBe(true)
    expect(offersRelease({ ...dead, status: 'NEED_TO_FACTOR' })).toBe(true)
  })
  it('not for a live, funded, finished or never-submitted row', () => {
    expect(offersRelease({ ...dead, otrStatus: '1' })).toBe(false)
    expect(offersRelease({ ...dead, factoredAt: '2026-11-25T00:00:00Z' })).toBe(false)
    expect(offersRelease({ ...dead, otrScheduleId: 'S1' })).toBe(false)
    expect(offersRelease({ ...dead, status: 'FACTORED' })).toBe(false)
    expect(offersRelease({ ...dead, otrInvoiceId: null })).toBe(false)
  })
})
