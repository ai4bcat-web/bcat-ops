import { describe, expect, it } from 'vitest'
import { formatDigest } from './digest'
import type { ApRunDigest } from './types'

const run = (over: Partial<ApRunDigest> = {}): ApRunDigest => ({
  id: 'r', trigger: 'SCHEDULE', startedAt: '2026-11-04T12:01:00Z', endedAt: '2026-11-04T12:02:00Z', listed: 40, reviewed: 31, stage1Rejected: 0, stage2Rejected: 0,
  modelCalls: 8, notInvoice: 3, invoices: 7, applied: 4, updatedBills: 4, needReview: 3, errors: 0, abandoned: 0, partial: false, ...over,
})
const now = new Date('2026-11-04T18:00:00Z')

describe('formatDigest', () => {
  it('healthy', () => {
    expect(formatDigest({ connection: 'CONNECTED', run: run(), openCount: 5, now }).text).toBe(
      'AP inbox · today 6:02 AM — reviewed 31 e-mails, updated 4 bills, 3 need review (5 open in the queue)',
    )
  })
  it('never run, not connected, needs reconnect', () => {
    expect(formatDigest({ connection: 'CONNECTED', run: null, openCount: 0, now, runHourChicago: 6 }).text).toContain('first review runs at 6:00 AM')
    expect(formatDigest({ connection: 'NOT_CONNECTED', run: null, openCount: 0, now }).text).toContain('is not connected')
    expect(formatDigest({ connection: 'NEEDS_RECONNECT', run: run(), openCount: 0, now })).toMatchObject({ tone: 'warn' })
  })
  it('partial and error variants', () => {
    const d = formatDigest({ connection: 'CONNECTED', run: run({ partial: true, errors: 1, abandoned: 1, reviewed: 1, updatedBills: 1 }), openCount: 0, now })
    expect(d.text).toContain('1 e-mail, updated 1 bill')
    expect(d.text).toContain('2 could not be read')
    expect(d.text).toContain('stopped early')
    expect(d.tone).toBe('warn')
  })
})
