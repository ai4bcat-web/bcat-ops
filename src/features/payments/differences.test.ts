import { describe, expect, it } from 'vitest'
import type { ArPaymentRecord, InvoiceRecord } from '@/types/tms'
import { acceptItems, differenceRows, openCount, selectUpTo, totalsByKind } from './differences'
import { fromArPayment } from './paymentsReceived'

const inv = (id: string, p: Partial<InvoiceRecord>): InvoiceRecord => ({
  id, number: id, shipmentNumber: id, customerId: 'c1', customerName: 'ACME', status: 'PARTIAL', invoiceDate: '2026-10-01',
  totalCents: 10_000, paidCents: 9_000, balanceCents: 1_000, ...p,
} as InvoiceRecord)

const pay = (id: string, p: Partial<ArPaymentRecord>): ArPaymentRecord => ({
  id, customerId: 'c1', kind: 'PAYMENT', receivedAt: '2026-11-01T12:00:00.000Z', method: 'CHECK', amountCents: 5_000, appliedCents: 5_000,
  unappliedCents: 0, applications: [{ invoiceId: 'X', amountCents: 5_000 }], createdBy: 'a@b.c', ...p,
} as ArPaymentRecord)

const nameOf = (_id: string, f: string) => f
const ledger = (list: ArPaymentRecord[]) => list.map((p) => fromArPayment(p, () => 'ACME'))

describe('differenceRows', () => {
  const rows = differenceRows(
    [
      inv('A', {}),
      inv('B', { paidCents: 0, balanceCents: 10_000, status: 'ISSUED' }),
      inv('C', { status: 'PAID', balanceCents: 0, paidCents: 10_000 }),
      inv('V', { status: 'VOID' }),
    ],
    ledger([
      pay('p1', { amountCents: 6_000, unappliedCents: 1_000 }),
      pay('p2', { amountCents: 6_000, unappliedCents: 1_000, reversedByPaymentId: 'r1' }),
      pay('p3', { amountCents: 6_000, appliedCents: 5_000, unappliedCents: 0, overageAcceptedCents: 1_000 }),
      pay('w1', { kind: 'WRITE_OFF', amountCents: 400, appliedCents: 400, note: 'Short pay accepted as paid in full', invoiceId: 'C', applications: [{ invoiceId: 'C', amountCents: 400 }] }),
      pay('cm', { kind: 'CREDIT_MEMO', amountCents: 900, appliedCents: 0, unappliedCents: 900 }),
    ]),
    nameOf,
  )

  it('lists open shorts (part-paid with a balance only), open overs (not reversed, payments only) and accepted ones', () => {
    expect(rows.map((r) => `${r.kind}:${r.paymentId ?? r.invoiceId}`).sort()).toEqual([
      'over-accepted:p3', 'over-open:p1', 'short-accepted:C', 'short-open:A',
    ].sort())
  })

  it('totals each kind and counts only the open ones for the tab badge', () => {
    const t = totalsByKind(rows)
    expect(t['short-open']).toEqual({ count: 1, cents: 1_000 })
    expect(t['over-open']).toEqual({ count: 1, cents: 1_000 })
    expect(t['short-accepted']).toEqual({ count: 1, cents: 400 })
    expect(t['over-accepted']).toEqual({ count: 1, cents: 1_000 })
    expect(openCount(rows)).toBe(2)
  })

  it('builds the bulk request from open rows only, carrying the amount each must still find', () => {
    const items = acceptItems(rows)
    expect(items).toHaveLength(2)
    expect(items).toContainEqual({ kind: 'SHORT', invoiceId: 'A', expectedCents: 1_000 })
    expect(items).toContainEqual({ kind: 'OVER', paymentId: 'p1', expectedCents: 1_000 })
  })

  it('selects open differences up to a limit, never accepted ones', () => {
    expect(selectUpTo(rows, 999)).toEqual([])
    expect(selectUpTo(rows, 1_000)).toHaveLength(2)
    expect(selectUpTo(rows, 1_000).every((id) => id.startsWith('short:') || id.startsWith('over:'))).toBe(true)
  })
})
