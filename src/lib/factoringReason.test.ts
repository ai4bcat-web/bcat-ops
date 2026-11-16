import { describe, expect, it } from 'vitest'
import type { FactoringItem } from '@/types'
import { factoringReasonOf } from './factoringReason'

const item = (over: Partial<FactoringItem> = {}): FactoringItem => ({
  id: '14916', proNumber: '14916', status: 'MANUAL_INVOICE', subject: 'Invoice for Pro # 14916 Attached from IVAN CARTAGE CO',
  fromEmail: 'bcatlogistics@aljex.descartesservices.com', receivedAt: '2026-11-06T16:02:22.000Z', messageId: 'm', createdAt: '2026-11-06T16:05:23.958Z', updatedAt: '2026-11-06T21:44:28.257Z',
  manualReason: 'MANUAL', ...over,
}) as FactoringItem

describe('factoringReasonOf', () => {
  it('says a manual row with no customer was pulled by hand, not rejected by OTR, and names the e-mail', () => {
    const r = factoringReasonOf(item(), { customerName: '' })
    expect(r.kind).toBe('PULLED_MANUAL')
    expect(r.short).toBe('Pulled from the OTR queue to invoice manually. Not rejected by OTR. Invoice e-mail from Aljex (Nov 6) is not matched to a customer.')
    expect(r.lines.join('\n')).toContain('Customer: not matched')
    expect(r.lines.join('\n')).toContain('bcatlogistics@aljex.descartesservices.com')
    expect(r.tone).toBe('orange')
  })

  it('warns when the linked invoice is marked factored but the queue says manual', () => {
    const r = factoringReasonOf(item(), { customerName: 'APT INC', invoice: { id: '14916', number: '14916', customerName: 'APT INC', totalCents: 25000, factored: true } })
    expect(r.warning).toMatch(/Invoice says factored, queue says manual/)
    expect(r.lines.join('\n')).toContain('Invoice 14916 · APT INC · $250.00 · marked factored.')
    const plain = factoringReasonOf(item(), { customerName: 'APT INC', invoice: { id: '14916', number: '14916', factored: false } })
    expect(plain.warning).toBeNull()
  })

  it('reports an OTR No buy with the broker MC', () => {
    const r = factoringReasonOf(item({ manualReason: 'NO_BUY', brokerCheckResult: 'NO_BUY', brokerMcChecked: '1092343' }), { customerName: 'K1 GROUP LLC' })
    expect(r.kind).toBe('OTR_NO_BUY')
    expect(r.short).toBe('OTR: No buy — OTR will not buy from MC 1092343')
    expect(r.tone).toBe('red')
  })

  it('reports a Dead invoice and a refusal, and keeps our own sign-in failure out of the rejections', () => {
    const dead = factoringReasonOf(item({ status: 'PENDING_WITH_OTR', manualReason: null, otrStatus: 4 as never, otrInvoiceId: '26156194' }), { customerName: 'X' })
    expect(dead.kind).toBe('OTR_DEAD')
    expect(dead.short).toBe('OTR: Dead — this invoice will not be funded')
    expect(dead.lines.join('\n')).toContain('OTR invoice #26156194')
    const refused = factoringReasonOf(item({ status: 'PENDING_WITH_OTR', manualReason: null, otrError: 'Amount does not match the rate con' }), { customerName: 'X' })
    expect(refused.kind).toBe('OTR_REFUSED')
    expect(refused.short).toBe('OTR: OTR refused it: Amount does not match the rate con')
    const own = factoringReasonOf(item({ status: 'NEED_TO_FACTOR', manualReason: null, otrError: '400: OTR auth failed (400)' }), { customerName: 'X' })
    expect(own.kind).toBe('OTR_UNREACHABLE')
    expect(own.short).toMatch(/not an OTR rejection/)
  })

  it('has a sentence for every other status', () => {
    expect(factoringReasonOf(item({ status: 'NEED_TO_FACTOR', manualReason: null }), { customerName: 'X' }).short).toBe('Not submitted to OTR yet.')
    expect(factoringReasonOf(item({ status: 'PENDING_WITH_OTR', manualReason: null, otrStatus: 8 as never }), { customerName: 'X' }).kind).toBe('WAITING')
    expect(factoringReasonOf(item({ status: 'FACTORED', manualReason: null }), { customerName: 'X' }).short).toBe('OTR approved this invoice.')
    expect(factoringReasonOf(item({ status: 'INVOICED_MANUALLY' }), { customerName: 'X' }).short).toMatch(/^Invoiced manually/)
    const archived = factoringReasonOf(item({ status: 'ARCHIVED', manualReason: 'NO_BUY', brokerCheckResult: 'NO_BUY', brokerMcChecked: '9' }), { customerName: 'X' })
    expect(archived.kind).toBe('ARCHIVED')
    expect(archived.short).toBe('Archived: taken out of the queue by hand. OTR had said: OTR will not buy from MC 9.')
    expect(factoringReasonOf(item({ status: 'ARCHIVED' }), { customerName: 'X' }).short).toBe('Archived: taken out of the queue by hand. Nothing was deleted.')
  })

  it('lists the OTR fields still missing', () => {
    const r = factoringReasonOf(item(), { customerName: 'X', missingFields: ['Broker MC', 'From zip'] })
    expect(r.lines.join('\n')).toContain('Missing for OTR: Broker MC, From zip.')
  })
})
