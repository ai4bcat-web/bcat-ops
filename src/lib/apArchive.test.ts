import { describe, expect, it } from 'vitest'
import { planApArchive, billPaidDay, archiveReason, type ArchiveBill, type ArchivePayment } from './apArchive'

const bill = (id: string, over: Partial<ArchiveBill> = {}): ArchiveBill => ({
  id, status: 'PAID', paidAt: '2026-10-01T12:00:00.000Z', billDate: '2026-09-20', shipmentNumber: id.replace('cb:', ''), loadCarrierId: `lcr-${id}`, ...over,
})
const pay = (id: string, billIds: string[], over: Partial<ArchivePayment> = {}): ArchivePayment => ({
  id, kind: 'PAYMENT', paidAt: '2026-10-01T12:00:00.000Z', amountCents: 10000, unappliedCents: 0,
  applications: billIds.map((billId) => ({ billId, amountCents: 10000 })), ...over,
})
const plan = (payments: ArchivePayment[], bills: ArchiveBill[], verify: string[] = []) =>
  planApArchive({ payments, bills, cutoff: '2026-11-12', verifyPros: new Set(verify) })

describe('planApArchive', () => {
  it('archives payments on or before the cut-off on the Chicago calendar, and the bills they settled', () => {
    // 9:30 pm Chicago on 11/12 is 03:30 UTC on 11/13: still 11/12 in Chicago.
    const p = plan(
      [pay('p1', ['cb:100'], { paidAt: '2026-11-13T03:30:00.000Z' }), pay('p2', ['cb:101'], { paidAt: '2026-11-13T12:00:00.000Z' })],
      [bill('cb:100', { paidAt: '2026-11-13T03:30:00.000Z' }), bill('cb:101', { paidAt: '2026-11-13T12:00:00.000Z' })],
    )
    expect(p.paymentIds).toEqual(['p1'])
    expect(p.billIds).toEqual(['cb:100'])
  })

  it('leaves a payment made after the cut-off (14525, paid 11/18) alone', () => {
    const p = plan([pay('p1', ['cb:14525'], { paidAt: '2026-11-18T12:00:00.000Z' })], [bill('cb:14525', { paidAt: '2026-11-18T21:40:00.000Z' })])
    expect(p.paymentIds).toEqual([])
    expect(p.billIds).toEqual([])
  })

  it('never archives a Verify-payment bill, or any payment that touches one, or the other bills in that payment', () => {
    const p = plan(
      [pay('shared', ['cb:14400', 'cb:200']), pay('own', ['cb:201'])],
      [bill('cb:14400', { shipmentNumber: '14400' }), bill('cb:200'), bill('cb:201')],
      ['14400'],
    )
    expect(p.paymentIds).toEqual(['own'])
    expect(p.billIds).toEqual(['cb:201'])
    expect(p.keptPayments).toContainEqual({ id: 'shared', why: 'VERIFY_GROUP' })
    expect(p.keptBills).toContainEqual({ id: 'cb:14400', why: 'VERIFY' })
    expect(p.keptBills).toContainEqual({ id: 'cb:200', why: 'PAYMENT_KEPT' })
  })

  it('keeps a bill whose other payment is after the cut-off (a straddling payment archives, the bill stays)', () => {
    const p = plan(
      [pay('old', ['cb:300'], { paidAt: '2026-11-02T12:00:00.000Z' }), pay('late', ['cb:300'], { paidAt: '2026-11-16T12:00:00.000Z', amountCents: 0 })],
      [bill('cb:300', { paidAt: '2026-11-16T16:00:00.000Z' })],
    )
    expect(p.paymentIds).toEqual(['old'])
    expect(p.billIds).toEqual([])
  })

  it('keeps a payment applied to a bill that is still open, and reversals with what they reverse', () => {
    const p = plan(
      [
        pay('partial', ['cb:400']),
        pay('reversed', ['cb:401'], { reversedByPaymentId: 'rev1' }),
        { id: 'rev1', kind: 'REVERSAL', paidAt: '2026-11-15T12:00:00.000Z', reversesPaymentId: 'reversed' },
        pay('clean', ['cb:402']),
      ],
      [bill('cb:400', { status: 'PARTIAL' }), bill('cb:401'), bill('cb:402')],
    )
    expect(p.paymentIds).toEqual(['clean'])
    expect(p.keptPayments).toContainEqual({ id: 'partial', why: 'OPEN_BILL' })
    expect(p.keptPayments).toContainEqual({ id: 'reversed', why: 'REVERSAL_LINK' })
  })

  it('archives a credit memo with its companion payment, keeps a credit memo with money left, and a credit tied to a verify bill', () => {
    const p = plan(
      [
        { id: 'cm1', kind: 'CREDIT_MEMO', paidAt: '2026-09-17T12:00:00.000Z', loadCarrierId: 'lcr-cb:500', unappliedCents: 0, applications: [] },
        pay('apply1', ['cb:500'], { creditApplications: [{ paymentId: 'cm1', amountCents: 5000 }] }),
        { id: 'cmLive', kind: 'CREDIT_MEMO', paidAt: '2026-09-17T12:00:00.000Z', unappliedCents: 2500, applications: [] },
        { id: 'cmV', kind: 'CREDIT_MEMO', paidAt: '2026-09-17T12:00:00.000Z', loadCarrierId: 'lcr-cb:14407', unappliedCents: 0, applications: [] },
      ],
      [bill('cb:500'), bill('cb:14407', { shipmentNumber: '14407' })],
      ['14407'],
    )
    expect(p.paymentIds.sort()).toEqual(['apply1', 'cm1'])
    expect(p.keptPayments).toContainEqual({ id: 'cmLive', why: 'LIVE_CREDIT' })
    expect(p.keptPayments).toContainEqual({ id: 'cmV', why: 'VERIFY_GROUP' })
  })

  it('files a PAID bill with no paid date by its bill date, and archives a paid bill with no payment rows at all', () => {
    expect(billPaidDay({ paidAt: null, billDate: '2025-03-02' })).toBe('2025-03-02')
    const p = plan([], [bill('cb:600', { paidAt: null, billDate: '2025-03-02' }), bill('cb:601', { paidAt: null, billDate: '2026-11-14' })])
    expect(p.billIds).toEqual(['cb:600'])
  })

  it('never archives reversal rows, open bills or voided bills, and a re-run counts archived rows as archivable for the bill decision', () => {
    const p = plan(
      [pay('done', ['cb:700'], { archivedAt: '2026-11-18T22:00:00.000Z' })],
      [bill('cb:700'), bill('cb:701', { status: 'TO_BE_PAID' }), bill('cb:702', { status: 'VOID' })],
    )
    expect(p.paymentIds).toEqual([])
    expect(p.billIds).toEqual(['cb:700'])
    expect(p.alreadyArchivedPayments).toBe(1)
  })

  it('names the reason', () => {
    expect(archiveReason('2026-11-12')).toBe('Paid outside BCAT Ops (on or before 2026-11-12)')
  })
})
