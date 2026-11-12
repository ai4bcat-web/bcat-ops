import { describe, expect, it } from 'vitest'
import { decideResubmit, offersResend, sameInvoiceBack, withPriorInvoice } from './factoringResubmit'

const base = { status: 'PENDING_WITH_OTR' as const, otrInvoiceId: '25884230', otrStatus: '4', brokerCheckResult: null }

describe('decideResubmit', () => {
  it('replaces an invoice OTR holds as Dead', () => {
    expect(decideResubmit(base)).toEqual({ ok: true, kind: 'REPLACE_DEAD' })
  })
  it('trusts OTR\'s live status over the row\'s copy', () => {
    expect(decideResubmit({ ...base, otrStatus: '4' }, '1')).toEqual({ ok: true, kind: 'REFRESH' })
    expect(decideResubmit({ ...base, otrStatus: '1' }, '4')).toEqual({ ok: true, kind: 'REPLACE_DEAD' })
  })
  it('never creates a second invoice while OTR holds the first as live', () => {
    for (const live of ['1', '2', '3', '5', '6', '7', '8', '9', '99']) {
      expect(decideResubmit(base, live)).toEqual({ ok: true, kind: 'REFRESH' })
    }
  })
  it('runs the ordinary submit for a row that never reached OTR', () => {
    expect(decideResubmit({ ...base, otrInvoiceId: null, otrStatus: null })).toEqual({ ok: true, kind: 'SUBMIT' })
  })
  it('refuses a finished row and a broker OTR will not take', () => {
    expect(decideResubmit({ ...base, status: 'FACTORED' }).ok).toBe(false)
    expect(decideResubmit({ ...base, status: 'MANUAL_INVOICE' }).ok).toBe(false)
    expect(decideResubmit({ ...base, brokerCheckResult: 'NO_BUY' }).ok).toBe(false)
    expect(decideResubmit({ ...base, brokerCheckResult: 'NOT_APPROVED' }).ok).toBe(false)
  })
})

describe('offersResend', () => {
  const extra = { otrError: null, brokerMcChecked: null, manualReason: null }
  it('shows for Dead, and for an errored row, not for a healthy pending one', () => {
    expect(offersResend({ ...base, ...extra })).toBe(true)
    expect(offersResend({ ...base, ...extra, otrStatus: '1' })).toBe(false)
    expect(offersResend({ ...base, ...extra, otrStatus: '1', otrError: 'OTR auth failed (400)' })).toBe(true)
    expect(offersResend({ ...base, ...extra, otrInvoiceId: null, otrStatus: null, otrError: 'OTR auth failed (400)' })).toBe(true)
    expect(offersResend({ ...base, ...extra, otrInvoiceId: null, otrStatus: null })).toBe(false)
    expect(offersResend({ ...base, ...extra, status: 'FACTORED' })).toBe(false)
  })
})

describe('history and the same-invoice guard', () => {
  it('appends the replaced invoice, newest last', () => {
    const first = withPriorInvoice(null, { otrInvoiceId: 1, otrStatus: '4', otrSubmittedAt: 't0', otrSubmittedBy: 'a@x' } as never, 'b@x', 't1')
    const second = withPriorInvoice(first, { otrInvoiceId: '2', otrStatus: '4' } as never, 'c@x', 't2')
    expect(second.map((p) => p.otrInvoiceId)).toEqual(['1', '2'])
    expect(second[0]).toMatchObject({ otrStatus: '4', replacedBy: 'b@x', replacedAt: 't1' })
  })
  it('recognises OTR handing the same invoice back', () => {
    expect(sameInvoiceBack('25884230', 25884230)).toBe(true)
    expect(sameInvoiceBack(' 25884230 ', '25884230')).toBe(true)
    expect(sameInvoiceBack('25884230', 25999999)).toBe(false)
  })
})
