import { describe, expect, it } from 'vitest'
import { DOCS_LOCKED_MESSAGE, DOC_FIXABLE, docsLockedReason } from './arDocuments'

const draft = { status: 'ISSUED' as const, sentAt: null, markedSentAt: null, sentCount: 0, paidCents: 0 }

describe('docsLockedReason', () => {
  it('a draft invoice, with or without a queue row still waiting for OTR, may be changed', () => {
    expect(docsLockedReason(draft)).toBeNull()
    expect(docsLockedReason(draft, { status: 'NEED_TO_FACTOR' })).toBeNull()
    expect(docsLockedReason(draft, { status: 'MANUAL_INVOICE' })).toBeNull()
    expect(docsLockedReason(null)).toBeNull()
  })

  it('an invoice that was e-mailed, marked sent, paid in part or is no longer plain issued is locked', () => {
    expect(docsLockedReason({ ...draft, sentAt: '2026-11-16T10:00:00Z' })).toBe(DOCS_LOCKED_MESSAGE)
    expect(docsLockedReason({ ...draft, markedSentAt: '2026-11-16T10:00:00Z' })).toBe(DOCS_LOCKED_MESSAGE)
    expect(docsLockedReason({ ...draft, sentCount: 1 })).toBe(DOCS_LOCKED_MESSAGE)
    expect(docsLockedReason({ ...draft, paidCents: 100 })).toBe(DOCS_LOCKED_MESSAGE)
    expect(docsLockedReason({ ...draft, status: 'PARTIAL' })).toBe(DOCS_LOCKED_MESSAGE)
  })

  it('a factored invoice is locked once OTR has it, whatever the queue row says it was before', () => {
    for (const status of ['PENDING_WITH_OTR', 'FACTORED', 'INVOICED_MANUALLY', 'ARCHIVED'] as const) {
      expect(docsLockedReason(draft, { status })).toBe(DOCS_LOCKED_MESSAGE)
    }
    expect(docsLockedReason(draft, { status: 'NEED_TO_FACTOR', otrInvoiceId: '26170636' })).toBe(DOCS_LOCKED_MESSAGE)
  })

  it('recognizes POD and rate-confirmation blockers', () => {
    expect(DOC_FIXABLE.test('Missing document: RATE_CON — Rate confirmation')).toBe(true)
    expect(DOC_FIXABLE.test('Missing document: POD')).toBe(true)
    expect(DOC_FIXABLE.test('Broker MC')).toBe(false)
  })
})
