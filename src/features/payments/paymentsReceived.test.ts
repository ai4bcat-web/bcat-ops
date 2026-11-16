import { describe, expect, it } from 'vitest'
import { computeArSummary } from '@/features/ar/arSummary'
import type { ArPaymentRecord, InvoiceRecord } from '@/types/tms'
import {
  aljexDate, filterReceived, fromAljexMemo, fromArPayment, hideReversed, inView, monthBounds, receivedCsv, receivedTotals, withRunningTotal,
  type ReceivedFilter,
} from './paymentsReceived'

const pay = (over: Partial<ArPaymentRecord>): ArPaymentRecord => ({
  id: 'p1', customerId: 'c1', kind: 'PAYMENT', receivedAt: '2026-11-05T12:00:00.000Z', method: 'CHECK', reference: '1001',
  amountCents: 50_000, appliedCents: 45_000, unappliedCents: 5_000, applications: [{ invoiceId: '14096', amountCents: 45_000 }],
  createdBy: 'jenny@bcatcorp.com', ...over,
})
const names = (id: string) => ({ c1: 'TANAGER LOGISTICS', c2: 'BATORY FOODS' } as Record<string, string>)[id] ?? ''

const memo = (kind: string, amount: string, ref = '11782') => ({
  id: `aljex:memo:${kind}`, pro: '12002', kind,
  fields: JSON.stringify({
    c5: { h: 'Customer Name', v: 'BATORY FOODS' }, c13: { h: 'Reference #', v: ref }, c15: { h: 'Invoice Date', v: '11/05/25' },
    c24: { h: 'Posted Info', v: '11/05/25 13:49:54JWEBER' }, c43: { h: 'Description', v: `CREDIT FOR PRO #  ${ref}` },
    c123: { h: 'Invoice Amount', v: amount }, c292: { h: 'Description', v: 'second description' },
  }),
})

const ALL: ReceivedFilter = { from: '', to: '', customers: [], types: [], methods: [], divisions: [], unappliedOnly: false }

describe('payments received rows', () => {
  it('shapes a BCAT payment with what it was applied to', () => {
    const r = fromArPayment(pay({}), names)
    expect(r).toMatchObject({
      type: 'payment', date: '2026-11-05', customerName: 'TANAGER LOGISTICS', method: 'Check', reference: '1001',
      amountCents: 50_000, appliedCents: 45_000, unappliedCents: 5_000, source: 'BCAT', recordedBy: 'jenny@bcatcorp.com',
    })
    expect(r.invoices).toEqual([{ invoiceId: '14096', amountCents: 45_000 }])
  })

  it('signs credits, write-offs and reversals negative and marks a reversed payment', () => {
    expect(fromArPayment(pay({ kind: 'CREDIT_MEMO', amountCents: 2_000 }), names).amountCents).toBe(-2_000)
    expect(fromArPayment(pay({ kind: 'WRITE_OFF', amountCents: 300, invoiceId: '9752', applications: [] }), names).invoices)
      .toEqual([{ invoiceId: '9752', amountCents: null }])
    expect(fromArPayment(pay({ kind: 'REVERSAL', amountCents: 50_000 }), names).amountCents).toBe(-50_000)
    expect(fromArPayment(pay({ reversedByPaymentId: 'rev-1' }), names).reversed).toBe(true)
  })

  it('reads an Aljex CRED memo as a credit against the PRO in its Reference #', () => {
    const r = fromAljexMemo(memo('MEMO_CRED', '-861.48'), (n) => (n === 'BATORY FOODS' ? 'c2' : null))!
    expect(r).toMatchObject({
      source: 'Aljex', type: 'credit', date: '2025-11-05', customerId: 'c2', customerName: 'BATORY FOODS',
      amountCents: -86_148, recordedBy: 'JWEBER (Aljex)', note: 'CREDIT FOR PRO #  11782', reference: 'Aljex memo 12002',
    })
    expect(r.invoices).toEqual([{ invoiceId: '11782', amountCents: 86_148 }])
  })

  it('reads an Aljex DEBT memo as a positive debit, and ignores load rows', () => {
    expect(fromAljexMemo(memo('MEMO_DEBT', '170.00'), () => null)!).toMatchObject({ type: 'debit', amountCents: 17_000, customerId: null })
    expect(fromAljexMemo(memo('LOAD', '170.00'), () => null)).toBeNull()
  })

  it('parses Aljex dates', () => {
    expect(aljexDate('1/2/26')).toBe('2026-01-02')
    expect(aljexDate('')).toBeNull()
  })
})

describe('filters, totals, ledger and CSV', () => {
  const rows = [
    fromArPayment(pay({ id: 'a', receivedAt: '2026-11-05T12:00:00.000Z' }), names),
    fromArPayment(pay({ id: 'b', customerId: 'c2', method: 'ACH', receivedAt: '2026-10-30T12:00:00.000Z', unappliedCents: 0, amountCents: 10_000 }), names),
    fromArPayment(pay({ id: 'c', kind: 'CREDIT_MEMO', amountCents: 1_500, unappliedCents: 0, receivedAt: '2026-11-10T12:00:00.000Z' }), names),
    fromAljexMemo(memo('MEMO_DEBT', '25.00'), () => 'c2')!,
  ]

  it('defaults to the current month', () => {
    expect(monthBounds('2026-11-15')).toEqual({ from: '2026-11-01', to: '2026-11-30' })
    expect(monthBounds('2026-02-03')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
  })

  it('filters by date, customer, type, method, division and unapplied', () => {
    const nov = { ...ALL, ...monthBounds('2026-11-15') }
    expect(filterReceived(rows, nov, () => []).map((r) => r.id)).toEqual(['a', 'c'])
    expect(filterReceived(rows, { ...ALL, customers: ['c2'] }, () => []).map((r) => r.id)).toEqual(['b', 'aljex:memo:MEMO_DEBT'])
    expect(filterReceived(rows, { ...ALL, types: ['debit'] }, () => []).map((r) => r.id)).toEqual(['aljex:memo:MEMO_DEBT'])
    expect(filterReceived(rows, { ...ALL, methods: ['ACH'] }, () => []).map((r) => r.id)).toEqual(['b'])
    expect(filterReceived(rows, { ...ALL, methods: ['(none)'] }, () => []).map((r) => r.id)).toEqual(['aljex:memo:MEMO_DEBT'])
    expect(filterReceived(rows, { ...ALL, unappliedOnly: true }, () => []).map((r) => r.id)).toEqual(['a'])
    const div = (r: { id: string }) => (r.id === 'a' ? ['ASSETS/LOCAL'] : ['BROKERAGE'])
    expect(filterReceived(rows, { ...ALL, divisions: ['ASSETS'] }, div).map((r) => r.id)).toEqual(['a'])
  })

  it('totals each type and the net', () => {
    const t = receivedTotals(rows)
    expect(t).toMatchObject({ paymentsCents: 60_000, paymentsCount: 2, creditsCents: -1_500, debitsCents: 2_500, unappliedCents: 5_000, netCents: 61_000 })
  })

  it('leaves a reversal and the payment it undid out of the totals', () => {
    const undone = fromArPayment(pay({ id: 'x', amountCents: 9_000, unappliedCents: 0, reversedByPaymentId: 'r' }), names)
    const reversal = fromArPayment(pay({ id: 'r', kind: 'REVERSAL', amountCents: 9_000, unappliedCents: 0, reversesPaymentId: 'x' }), names)
    const t = receivedTotals([...rows, undone, reversal])
    expect(t).toMatchObject({ paymentsCents: 60_000, paymentsCount: 2, reversalsCount: 1, netCents: 61_000 })
  })

  it('runs a total oldest first for one customer', () => {
    const ledger = withRunningTotal(rows.filter((r) => r.customerId === 'c1'))
    expect(ledger.map((r) => [r.id, r.runningCents])).toEqual([['a', 50_000], ['c', 48_500]])
  })

  it('exports every row with quoted cells', () => {
    const csv = receivedCsv(rows.slice(0, 1))
    expect(csv.split('\n')[0]).toBe('Date,Customer,Type,Method,Reference,Amount,Applied,Unapplied,Applied to,Recorded by,Source,Reversed,Note')
    expect(csv.split('\n')[1]).toBe('2026-11-05,TANAGER LOGISTICS,Payment,Check,1001,500.00,450.00,50.00,14096,jenny@bcatcorp.com,BCAT,,')
  })

  it('reads "Collected" from the same computation the Receivables card uses', () => {
    const paid = (id: string, paidAt: string, totalCents: number) => ({ id, status: 'PAID', paidAt, totalCents, customerId: 'c1' }) as InvoiceRecord
    const s = computeArSummary({
      open: [], paid: [paid('i1', '2026-11-12T12:00:00Z', 10_000), paid('i2', '2026-11-02T12:00:00Z', 5_000), paid('i3', '2026-10-31T12:00:00Z', 1_000)],
      factorByItemId: new Map(), shipmentsById: new Map(), divisionName: () => '', asOf: '2026-11-15',
    })
    expect([s.collectedMonthCount, s.collectedMonthCents, s.collectedWeekCount, s.collectedWeekCents]).toEqual([2, 15_000, 1, 10_000])
  })

describe('reversed pairs and views', () => {
  const undone = pay({ id: 'x', reversedByPaymentId: 'r', amountCents: 9_000 })
  const reversal = pay({ id: 'r', kind: 'REVERSAL', reversesPaymentId: 'x', amountCents: 9_000, receivedAt: '2026-11-15T12:00:00.000Z', note: 'OTR never paid' })
  const rows = [
    fromArPayment(undone, names, (id) => (id === 'x' ? reversal : undefined)),
    fromArPayment(reversal, names),
    fromArPayment(pay({ id: 'ok' }), names),
    fromArPayment(pay({ id: 'cm', kind: 'CREDIT_MEMO', amountCents: 100 }), names),
  ]

  it('carries the reversal date and reason onto the reversed payment', () => {
    expect(rows[0]).toMatchObject({ reversed: true, reversedOn: '2026-11-15', reversedReason: 'OTR never paid' })
  })

  it('hides a reversed payment and its reversal unless asked', () => {
    expect(hideReversed(rows, false).map((r) => r.id)).toEqual(['ok', 'cm'])
    expect(hideReversed(rows, true)).toHaveLength(4)
  })

  it('splits payments from credits and debits', () => {
    expect(rows.filter((r) => inView(r, 'payments')).map((r) => r.id)).toEqual(['x', 'r', 'ok'])
    expect(rows.filter((r) => inView(r, 'adjustments')).map((r) => r.id)).toEqual(['cm'])
  })
})
})
