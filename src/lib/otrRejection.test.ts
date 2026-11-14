import { describe, expect, it } from 'vitest'
import type { FactoringItem } from '@/types'
import { isOtrRejected, mayInvoiceManually, needsManualInvoice, otrRejection, otrRejectionReason } from './otrRejection'
import { manualInvoiceChangeNote, notesWithChange } from './manualInvoiceMove'

const row = (over: Partial<FactoringItem>): FactoringItem => ({ id: 'p', proNumber: 'p', status: 'NEED_TO_FACTOR', ...over }) as FactoringItem

describe('otrRejection', () => {
  it('flags a broker OTR will not buy from, with its reason', () => {
    const r = otrRejection(row({ brokerCheckResult: 'NO_BUY', brokerMcChecked: '123' }))
    expect(r?.kind).toBe('NO_BUY')
    expect(r?.reason).toMatch(/will not buy from MC 123/)
  })

  it('flags an invoice OTR marked Dead (status 4)', () => {
    expect(otrRejection(row({ status: 'PENDING_WITH_OTR', otrStatus: 4 as never }))).toMatchObject({ kind: 'DEAD' })
  })

  it('flags an OTR error on a row still waiting, and says what OTR said', () => {
    expect(otrRejection(row({ status: 'NEED_TO_FACTOR', otrError: 'Invoice amount does not match the rate con' }))).toEqual({
      kind: 'ERROR', reason: 'OTR refused it: Invoice amount does not match the rate con',
    })
  })

  it('a row already in the manual lane stays flagged only for a real refusal, not a leftover error', () => {
    expect(otrRejection(row({ status: 'MANUAL_INVOICE', manualReason: 'NO_BUY', otrError: 'OTR will not buy' }))?.kind).toBe('NO_BUY')
    expect(otrRejection(row({ status: 'MANUAL_INVOICE', manualReason: 'MANUAL', otrError: 'old error' }))).toBeNull()
  })

  it('never flags a row that has left the OTR queue', () => {
    for (const status of ['FACTORED', 'INVOICED_MANUALLY', 'ARCHIVED'] as const) {
      expect(otrRejection(row({ status, brokerCheckResult: 'NO_BUY', otrError: 'x' }))).toBeNull()
    }
  })

  it('a healthy row and an Approved one are not flagged', () => {
    expect(otrRejection(row({}))).toBeNull()
    expect(otrRejection(row({ status: 'PENDING_WITH_OTR', otrStatus: 3 as never }))).toBeNull()
  })

  it('needsManualInvoice picks out only the rejected rows', () => {
    const items = [row({ id: 'a' }), row({ id: 'b', brokerCheckResult: 'NO_BUY' }), row({ id: 'c', status: 'PENDING_WITH_OTR', otrStatus: 4 as never })]
    expect(needsManualInvoice(items).map((i) => i.id)).toEqual(['b', 'c'])
  })
})

describe('mayInvoiceManually', () => {
  const base = { status: 'PENDING_WITH_OTR', brokerCheckResult: null, manualReason: null, otrError: null, otrStatus: null, brokerMcChecked: null } as never
  const staff = { email: 'jenny@bcatcorp.com', groups: [] as string[] }
  it('allows No buy for anyone, and nothing else for non-admins', () => {
    expect(mayInvoiceManually({ ...(base as object), manualReason: 'NO_BUY' } as never, staff)).toEqual({ allowed: true, override: false })
    expect(mayInvoiceManually({ ...(base as object), otrStatus: 4 } as never, staff).allowed).toBe(false)
    expect(mayInvoiceManually({ ...(base as object), otrError: '400' } as never, staff).allowed).toBe(false)
  })
  it('gives admins an override on Dead / errors, never on a manual row that is not No buy or a finished row', () => {
    expect(mayInvoiceManually({ ...(base as object), otrStatus: 4 } as never, { email: 'x@bcatcorp.com', groups: ['ADMIN'] })).toEqual({ allowed: true, override: true })
    expect(mayInvoiceManually({ ...(base as object), status: 'MANUAL_INVOICE' } as never, { email: 'ryne@bcatcorp.com', groups: [] }).allowed).toBe(false)
    expect(mayInvoiceManually({ ...(base as object), status: 'FACTORED' } as never, { email: 'ryne@bcatcorp.com', groups: [] }).allowed).toBe(false)
  })
})

describe('OTR rejected tab and reason', () => {
  const base = { status: 'PENDING_WITH_OTR' as const, brokerCheckResult: null, manualReason: null, otrError: null, otrStatus: null, brokerMcChecked: null }
  it('No buy, Dead and OTR errors count; our own auth or network failures do not', () => {
    expect(isOtrRejected({ ...base, status: 'MANUAL_INVOICE', manualReason: 'NO_BUY', brokerCheckResult: 'NO_BUY' })).toBe(true)
    expect(isOtrRejected({ ...base, otrError: 'Amount does not match the rate con' })).toBe(true)
    expect(isOtrRejected({ ...base, otrError: '400: OTR auth failed (400)' })).toBe(false)
    expect(isOtrRejected({ ...base, status: 'FACTORED', manualReason: 'NO_BUY' })).toBe(false)
  })
  it('keeps the reason after the row left the queue', () => {
    expect(otrRejectionReason({ ...base, status: 'ARCHIVED', manualReason: 'NO_BUY', otrError: 'OTR will not buy from MC 9' })).toBe('OTR will not buy from MC 9')
    expect(otrRejectionReason({ ...base, status: 'ARCHIVED', otrError: 'Duplicate PO' })).toBe('OTR refused it: Duplicate PO')
    expect(otrRejectionReason({ ...base, otrError: 'fetch failed' })).toBeNull()
    expect(otrRejectionReason(base)).toBeNull()
  })
  it('the customer note says when, who, which PRO and why', () => {
    expect(manualInvoiceChangeNote({ at: '2026-11-14T10:00:00.000Z', by: 'ryne@bcatcorp.com', pro: '14538', reason: 'OTR marked this invoice Dead' }))
      .toBe('Changed to manual invoice on 11/14/2026 by ryne@bcatcorp.com: OTR rejected PRO 14538 — OTR marked this invoice Dead')
    expect(notesWithChange('Old note', 'New line')).toBe('New line\nOld note')
    expect(notesWithChange(null, 'New line')).toBe('New line')
  })
})
