// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { DashboardData } from '@/features/tms/dashboard/types'
import {
  compactDollars, kpiDeltas, kpis, monthlyRevenue, paymentRows, paymentsCsv, revenueByDivision, revenueGauge,
  revenueTarget, weeklyRevenueByDivision, windowFilters, windowFor,
  type ApPaymentLine, type ArPaymentLine,
} from './financeOps'
import { SEED_DIVISIONS } from './ownership'
import { isPodMissing } from './podState'

const sample = (id: string, date: string, over: Record<string, unknown> = {}) => ({
  id, laneKey: 'A>B', date, loadId: `l-${id}`, shipmentId: `s-${id}`,
  revDivision: 'BROKERAGE', revenueCents: 100_00, costCents: 80_00, profitCents: 20_00,
  source: 'LOAD', sampledAt: `${date}T12:00:00.000Z`, version: 1, ...over,
})

const shipment = (id: string, status: string, pickup: string) => ({
  id: `s-${id}`, number: id, status, customerId: 'c', mode: 'TRUCKLOAD', source: 'MANUAL', pickupAppt: `${pickup}T12:00:00.000Z`,
  revDivision: 'BROKERAGE', createdBy: 't', updatedBy: 't', createdAt: '', updatedAt: '',
})

function data(over: Partial<DashboardData> = {}): DashboardData {
  return {
    shipments: [], orders: [], loads: [], loadCarriers: [], samples: [], openInvoices: [], openBills: [],
    quotes: [], profiles: [], divisions: SEED_DIVISIONS as DashboardData['divisions'], now: '2026-10-20T12:00:00.000Z',
    ...over,
  } as DashboardData
}

describe('windowFor', () => {
  it('runs this month to today and compares to the equal-length window before it', () => {
    const w = windowFor('THIS_MONTH', '2026-10-10')
    expect(w).toMatchObject({ from: '2026-10-01', to: '2026-10-10', previous: { from: '2026-09-21', to: '2026-09-30' }, months: 1 })
  })
  it('takes last month whole, and 3 months from the 1st two months back', () => {
    expect(windowFor('LAST_MONTH', '2026-10-10')).toMatchObject({ from: '2026-09-01', to: '2026-09-30' })
    expect(windowFor('LAST_3_MONTHS', '2026-01-15')).toMatchObject({ from: '2025-11-01', to: '2026-01-15', months: 3 })
  })
})

describe('kpis', () => {
  const filters = windowFilters('2026-10-01', '2026-10-31')
  it('averages margin over brokered priced samples only, and counts own-fleet separately', () => {
    const d = data({
      samples: [
        sample('1', '2026-10-02', { profitCents: 30_00, revenueCents: 100_00 }),
        sample('2', '2026-10-03', { profitCents: 10_00, revenueCents: 100_00 }),
        sample('3', '2026-10-04', { assignmentKind: 'OWN_ASSET', profitCents: 0, revenueCents: 500_00 }),
        sample('4', '2026-10-05', { excluded: true, profitCents: 999_00 }),
      ] as DashboardData['samples'],
    })
    const k = kpis(d, filters, [])
    expect(k.avgMarginCents).toBe(20_00)
    expect(k.marginBps).toBe(2000)
    expect(k.ownFleetCount).toBe(1)
    expect(k.revenueCents).toBe(700_00)
  })
  it('is null, not zero, with no priced sample', () => {
    const k = kpis(data(), filters, [])
    expect([k.avgMarginCents, k.revenueCents, k.pendingPayoutsCents, k.creditsCents]).toEqual([null, null, null, null])
  })
  it('counts delivered shipments, sums open bills and nets reversed credits', () => {
    const ar: ArPaymentLine[] = [
      { id: 'a', customerId: 'c', kind: 'CREDIT_MEMO', receivedAt: '2026-10-05T12:00:00.000Z', amountCents: 5_00, appliedCents: 0, unappliedCents: 5_00 },
      { id: 'b', customerId: 'c', kind: 'CREDIT_MEMO', receivedAt: '2026-10-06T12:00:00.000Z', amountCents: 9_00, appliedCents: 0, unappliedCents: 9_00, reversedByPaymentId: 'r' },
      { id: 'w', customerId: 'c', kind: 'WRITE_OFF', receivedAt: '2026-10-07T12:00:00.000Z', amountCents: 2_00, appliedCents: 0, unappliedCents: 0 },
      { id: 'o', customerId: 'c', kind: 'CREDIT_MEMO', receivedAt: '2026-09-07T12:00:00.000Z', amountCents: 7_00, appliedCents: 0, unappliedCents: 0 },
    ]
    const d = data({
      shipments: [shipment('1', 'DELIVERED', '2026-10-02'), shipment('2', 'IN_TRANSIT', '2026-10-02'), shipment('3', 'DELIVERED', '2026-09-02')] as DashboardData['shipments'],
      openBills: [{ id: 'b1', loadId: 'x', balanceCents: 300_00 }, { id: 'b2', loadId: 'y', balanceCents: 50_00 }] as DashboardData['openBills'],
    })
    const k = kpis(d, filters, ar)
    expect(k.shipmentsCompleted).toBe(1)
    expect([k.pendingPayoutsCents, k.pendingBillCount]).toEqual([350_00, 2])
    expect([k.creditsCents, k.writeOffsCents]).toEqual([5_00, 2_00])
  })
  it('gives no delta against an empty previous window', () => {
    const cur = kpis(data({ samples: [sample('1', '2026-10-02')] as DashboardData['samples'] }), filters, [])
    const prev = kpis(data(), windowFilters('2026-09-01', '2026-09-30'), [])
    expect(kpiDeltas(cur, prev)).toMatchObject({ avgMargin: null })
  })
})

describe('revenue by division and weekly trend', () => {
  const d = data({
    samples: [
      sample('1', '2026-10-06', { revenueCents: 100_00 }),
      sample('2', '2026-10-07', { revDivision: 'ASSETS', revSubdivision: 'BOX_TRUCK', revenueCents: 40_00 }),
      sample('3', '2026-10-14', { revDivision: null, revenueCents: 10_00 }),
    ] as DashboardData['samples'],
  })
  it('rolls subdivisions into their top-level division and keeps untagged so the parts sum to the whole', () => {
    const rows = revenueByDivision(d, windowFilters('2026-10-01', '2026-10-31'))
    const by = Object.fromEntries(rows.map((r) => [r.key, r.revenueCents]))
    expect(by).toMatchObject({ BROKERAGE: 100_00, ASSETS: 40_00, UNTAGGED: 10_00 })
    expect(rows.reduce((s, r) => s + r.revenueCents, 0)).toBe(150_00)
  })
  it('buckets Monday-start weeks, includes empty weeks, and marks the current one', () => {
    const t = weeklyRevenueByDivision(d, '2026-10-15', 4)
    expect(t.weeks.map((w) => w.start)).toEqual(['2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12'])
    expect(t.weeks[0].values.BROKERAGE).toBe(0)
    expect(t.weeks[2].values).toMatchObject({ BROKERAGE: 100_00, ASSETS: 40_00 })
    expect(t.weeks[3].values.UNTAGGED).toBe(10_00)
    expect(t.currentIndex).toBe(3)
  })
})

describe('revenue target', () => {
  const win = windowFor('THIS_MONTH', '2026-10-10')
  it('averages the completed months that had revenue and scales to the window length', () => {
    const monthly = monthlyRevenue(
      data({ samples: [sample('1', '2026-09-02', { revenueCents: 300_00 }), sample('2', '2026-07-02', { revenueCents: 100_00 })] as DashboardData['samples'] }),
      ['2026-09', '2026-08', '2026-07'],
    )
    expect(revenueTarget(monthly, win)).toEqual({ targetCents: 200_00, monthlyAverageCents: 200_00, basisMonths: 2 })
    expect(revenueTarget(monthly, windowFor('LAST_3_MONTHS', '2026-10-10'))).toMatchObject({ basisMonths: 1, targetCents: 300_00 })
  })
  it('has no target without a prior month, and the gauge says so', () => {
    const none = revenueTarget({}, win)
    expect(none.targetCents).toBeNull()
    expect(revenueGauge(5_000_00, none)).toEqual({ value: null, label: '$5k', sub: 'No prior months to compare' })
  })
  it('caps the arc but not the label above 100%', () => {
    const g = revenueGauge(600_00, { targetCents: 500_00, monthlyAverageCents: 500_00, basisMonths: 3 })
    expect(g.value).toBe(1)
    expect(g.sub).toBe('120% of $500 · 3-month average')
  })
  it('formats compact dollars', () => {
    expect([compactDollars(412_000_00), compactDollars(1_250_000_00), compactDollars(850_00)]).toEqual(['$412k', '$1.3M', '$850'])
  })
})

describe('paymentRows', () => {
  const names = { customers: new Map([['c1', 'Acme']]), carriers: new Map([['k1', 'Fast Freight']]) }
  const win = { from: '2026-10-01', to: '2026-10-31' }
  const ar: ArPaymentLine[] = [
    { id: 'a1', customerId: 'c1', kind: 'PAYMENT', receivedAt: '2026-10-05T12:00:00.000Z', amountCents: 100_00, appliedCents: 100_00, unappliedCents: 0, method: 'ACH' },
    { id: 'a2', customerId: 'c1', kind: 'PAYMENT', receivedAt: '2026-10-06T12:00:00.000Z', amountCents: 100_00, appliedCents: 40_00, unappliedCents: 60_00 },
    { id: 'a3', customerId: 'c1', kind: 'PAYMENT', receivedAt: '2026-10-07T12:00:00.000Z', amountCents: 100_00, appliedCents: 0, unappliedCents: 100_00 },
    { id: 'a4', customerId: 'c1', kind: 'PAYMENT', receivedAt: '2026-10-08T12:00:00.000Z', amountCents: 100_00, appliedCents: 0, unappliedCents: 0, reversedByPaymentId: 'r' },
    { id: 'a5', customerId: 'c1', kind: 'CREDIT_MEMO', receivedAt: '2026-10-09T12:00:00.000Z', amountCents: 1_00, appliedCents: 0, unappliedCents: 1_00 },
    { id: 'a6', customerId: 'c1', kind: 'PAYMENT', receivedAt: '2026-09-30T12:00:00.000Z', amountCents: 1_00, appliedCents: 1_00, unappliedCents: 0 },
  ]
  const ap: ApPaymentLine[] = [
    { id: 'p1', carrierId: 'k1', kind: 'PAYMENT', paidAt: '2026-10-10T12:00:00.000Z', amountCents: 50_00, appliedCents: 50_00, unappliedCents: 0, pdfKey: 'remittances/p1.pdf', remittanceSentAt: '2026-10-10T13:00:00.000Z' },
    { id: 'p2', carrierId: 'k1', kind: 'PAYMENT', paidAt: '2026-10-11T12:00:00.000Z', amountCents: 20_00, appliedCents: 20_00, unappliedCents: 0 },
  ]
  const rows = paymentRows(ar, ap, names, win)

  it('lists only in-window PAYMENT rows, newest first, with money out negative', () => {
    expect(rows.map((r) => r.id)).toEqual(['p2', 'p1', 'a4', 'a3', 'a2', 'a1'])
    expect(rows.find((r) => r.id === 'p1')?.amountCents).toBe(-50_00)
    expect(rows.find((r) => r.id === 'a1')).toMatchObject({ counterparty: 'Acme', amountCents: 100_00 })
  })
  it('derives statuses from the ledger fields', () => {
    const status = Object.fromEntries(rows.map((r) => [r.id, r.status]))
    expect(status).toEqual({ a1: 'APPLIED', a2: 'PARTIAL', a3: 'UNAPPLIED', a4: 'REVERSED', p1: 'REMITTED', p2: 'RECORDED' })
  })
  it('offers a remittance key only for AP rows that stored one', () => {
    expect(rows.filter((r) => r.pdfKey).map((r) => r.id)).toEqual(['p1'])
  })
  it('writes a CSV with signed dollar amounts and quoted commas', () => {
    const csv = paymentsCsv(paymentRows([], [{ ...ap[1], reference: 'A,B' }], names, win))
    expect(csv.split('\n')[1]).toBe('2026-10-11,AP payment,Fast Freight,"A,B",,-20.00,Recorded')
  })
})

describe('isPodMissing', () => {
  it('only waits on a POD once delivered; a sample outranks the order list', () => {
    expect(isPodMissing('IN_TRANSIT', ['POD'], null)).toBe(false)
    expect(isPodMissing('DELIVERED', ['POD'], null)).toBe(true)
    expect(isPodMissing('DELIVERED', [], null)).toBe(false)
    expect(isPodMissing('DELIVERED', ['POD'], true)).toBe(false)
    expect(isPodMissing('DELIVERED', [], false)).toBe(true)
  })
})
