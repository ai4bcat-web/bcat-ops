import { describe, expect, it } from 'vitest'
import type { FactoringItem } from '@/types'
import { needsManualInvoice, otrRejection } from './otrRejection'

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
