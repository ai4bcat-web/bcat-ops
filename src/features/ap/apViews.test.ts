import { describe, expect, it } from 'vitest'
import { ageOpenItems } from '@/lib/arAging'
import type { CarrierBillRecord } from '@/types/tms'
import {
  billsInReview, sharedProIndex, sharedProLabel, siblingCarriers, awaitingInvoiceTotals,
  billsExpected, billsAging, billsSelected, canSelectForPayment, invoiceAgeBuckets, payToLabel, paymentInfoFor, remitEmailOf,
} from './apViews'

const lc = (id: string, over: Record<string, unknown> = {}) => ({
  id, loadId: 'l1', kind: 'CARRIER' as const, status: 'ACTIVE' as const, carrierName: `Carrier ${id}`, invoiceId: null, sequence: 1, ...over,
})

describe('a load with several carriers in AP (Step AT)', () => {
  it('names the other live carriers of the bill, in booking order, with their bill when recorded', () => {
    const rows = [
      lc('lc2', { sequence: 2, invoiceId: 'cb:lc2:1' }),
      lc('lc1'),
      lc('lc3', { sequence: 3 }),
      lc('bounced', { status: 'BOUNCED', sequence: 4 }),
      lc('own', { kind: 'OWN_ASSET', sequence: 5 }),
      lc('elsewhere', { loadId: 'l2' }),
    ]
    expect(siblingCarriers(rows, { loadId: 'l1', loadCarrierId: 'lc1' })).toEqual([
      { loadCarrierId: 'lc2', carrierName: 'Carrier lc2', billId: 'cb:lc2:1' },
      { loadCarrierId: 'lc3', carrierName: 'Carrier lc3', billId: null },
    ])
    expect(siblingCarriers([lc('lc1')], { loadId: 'l1', loadCarrierId: 'lc1' })).toEqual([])
  })

  it('marks a PRO shared only from two distinct carrier legs, and a voided bill is not a leg', () => {
    const rows = [{ loadId: 'l1', loadCarrierId: 'lc1' }, { loadId: 'l9', loadCarrierId: 'lc9' }]
    const bills = [
      { loadId: 'l1', loadCarrierId: 'lc1', status: 'IN_REVIEW' as const },
      { loadId: 'l1', loadCarrierId: 'lc2', status: 'TO_BE_PAID' as const },
      { loadId: 'l9', loadCarrierId: 'lc10', status: 'VOID' as const },
    ]
    const index = sharedProIndex(rows, bills)
    expect(sharedProLabel(index, 'l1')).toBe('Shared PRO · 2 carriers')
    // lc1 appears as a row and as a bill: one leg, not two.
    expect(index.get('l1')).toBe(2)
    expect(sharedProLabel(index, 'l9')).toBeNull()
    expect(sharedProLabel(index, 'nowhere')).toBeNull()
  })

  it('counts each carrier bill once in awaiting totals and ages each bill in its own bucket', () => {
    const awaiting = awaitingInvoiceTotals([
      { costCents: 150_000, assignment: { kind: 'CARRIER' } }, { costCents: 80_000, assignment: { kind: 'CARRIER' } },
    ] as Parameters<typeof awaitingInvoiceTotals>[0])
    expect(awaiting).toEqual({ cents: 230_000, count: 2 })

    const asOf = '2026-11-05'
    const aged = ageOpenItems([
      { partyId: 'car1', partyName: 'A', dueAt: '2026-11-01', balanceCents: 150_000 },
      { partyId: 'car2', partyName: 'B', dueAt: '2026-09-01', balanceCents: 80_000 },
    ], asOf)
    expect(aged.totalCents).toBe(230_000)
    expect(aged.byParty.map((p) => [p.partyId, p.totalCents])).toEqual([['car1', 150_000], ['car2', 80_000]])
    expect(aged.byBucket.D1_30).toBe(150_000)
    expect(aged.byBucket.D61_90).toBe(80_000)
  })
})

describe('bills in review', () => {
  const review = (id: string, recordedAt: string, datesPending = false) =>
    ({ id, status: 'IN_REVIEW', recordedAt, datesPending }) as unknown as CarrierBillRecord

  it('works the bills still waiting on their invoice date and due date first, then oldest recorded first', () => {
    const rows = [review('old', '2026-11-01T00:00:00Z'), review('pending-new', '2026-11-10T00:00:00Z', true), review('pending-old', '2026-11-05T00:00:00Z', true), review('new', '2026-11-09T00:00:00Z')]
    expect(billsInReview(rows).map((b) => b.id)).toEqual(['pending-old', 'pending-new', 'old', 'new'])
  })
})

describe('the payable ladder: Expected, Aging, Selected', () => {
  const b = (id: string, over: Record<string, unknown>) =>
    ({ id, carrierId: 'car1', recordedAt: '2026-11-01T00:00:00Z', billDate: '2026-11-01', dueAt: '2026-12-01', balanceCents: 100_000, ...over }) as unknown as CarrierBillRecord
  const bills = [
    b('expected', { status: 'IN_REVIEW', datesPending: true }),
    b('review-dated', { status: 'IN_REVIEW', datesPending: false, dueAt: '2026-11-20' }),
    b('approved', { status: 'TO_BE_PAID', dueAt: '2026-11-10' }),
    b('partial', { status: 'PARTIAL', dueAt: '2026-11-15' }),
    b('chosen', { status: 'TO_BE_PAID', selectedForPayment: true, dueAt: '2026-11-05' }),
    b('paid', { status: 'PAID' }),
    b('void', { status: 'VOID' }),
  ]

  it('puts bills waiting on their invoice date in Expected, dated open bills in Aging, and chosen ones in Selected', () => {
    expect(billsExpected(bills).map((x) => x.id)).toEqual(['expected'])
    expect(billsAging(bills).map((x) => x.id)).toEqual(['approved', 'partial', 'review-dated'])
    expect(billsSelected(bills).map((x) => x.id)).toEqual(['chosen'])
  })

  it('lets only an approved, dated bill be selected for payment', () => {
    expect(canSelectForPayment({ status: 'TO_BE_PAID', datesPending: false })).toBe(true)
    expect(canSelectForPayment({ status: 'PARTIAL' })).toBe(true)
    expect(canSelectForPayment({ status: 'IN_REVIEW', datesPending: false })).toBe(false)
    expect(canSelectForPayment({ status: 'TO_BE_PAID', datesPending: true })).toBe(false)
  })

  it('buckets open balances by days since the invoice date', () => {
    const asOf = '2026-11-12'
    const buckets = invoiceAgeBuckets([
      b('a', { billDate: '2026-11-02', balanceCents: 100 }),
      b('c', { billDate: '2026-10-01', balanceCents: 200 }),
      b('d', { billDate: '2026-08-01', balanceCents: 400 }),
    ], asOf)
    expect(buckets.map((x) => [x.key, x.count, x.cents])).toEqual([['D0_30', 1, 100], ['D31_60', 1, 200], ['D61_PLUS', 1, 400]])
  })
})

describe('who is paid and where', () => {
  const info = [
    { id: 'pm1', carrierId: 'car1', recipientType: 'CARRIER', bankName: 'Fifth Third', accountLast4: '1234', routingLast4: '5678', payeeEmail: 'ap@carrier.test', isPreferred: true, status: 'ACTIVE' },
    { id: 'pm2', carrierId: 'car1', recipientType: 'FACTOR', factorName: 'Triumph', payeeEmail: 'ap@factor.test', status: 'ACTIVE' },
    { id: 'pm3', carrierId: 'car1', status: 'INACTIVE', payeeEmail: 'old@carrier.test' },
  ]
  const bill = (over: Record<string, unknown>) => ({ carrierId: 'car1', payeeKind: 'CARRIER', paymentMethodId: null, remitTo: null, ...over }) as unknown as CarrierBillRecord

  it('says Direct, or the factor by name', () => {
    expect(payToLabel(bill({}))).toBe('Direct')
    expect(payToLabel(bill({ payeeKind: 'FACTOR', remitTo: { name: 'Blue Line', factorName: 'Triumph' } }))).toBe('Factor — Triumph')
    expect(payToLabel(bill({ payeeKind: 'FACTOR' }))).toBe('Factor')
  })

  it('finds the method the bill was recorded against, else the preferred active one', () => {
    expect(paymentInfoFor(bill({ paymentMethodId: 'pm2' }), info)?.id).toBe('pm2')
    expect(paymentInfoFor(bill({}), info)?.id).toBe('pm1')
    expect(paymentInfoFor(bill({ carrierId: 'other' }), info)).toBeNull()
  })

  it('remits to the e-mail snapshotted on the bill, else the payment method\'s', () => {
    expect(remitEmailOf(bill({ remitTo: { name: 'x', payeeEmail: 'snap@carrier.test' } }), info)).toBe('snap@carrier.test')
    expect(remitEmailOf(bill({}), info)).toBe('ap@carrier.test')
    expect(remitEmailOf(bill({ carrierId: 'other' }), info)).toBe('')
  })
})
