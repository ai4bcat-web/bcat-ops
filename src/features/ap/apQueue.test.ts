import { describe, expect, it } from 'vitest'
import {
  apReportCsv, apReportRows, apReportTotals, apSummary, billCustomerName, billDaysPastDue, billFactsIndex, daysLateLabel, inDivision, cashRequirements, estimatedDueAt, isAljexBill, payablesQueue,
  termsLabel, type BillShipmentFacts,
} from './apQueue'
import type { CarrierBillRecord, OrderRecord, ShipmentRecord } from '@/types/tms'

function bill(patch: Partial<CarrierBillRecord> = {}): CarrierBillRecord {
  return {
    id: 'b1', loadCarrierId: 'lc1', loadId: 'l1', shipmentId: 's1', shipmentNumber: '20027', carrierId: 'c1', carrierName: 'SHERIFAJ',
    payeeKind: 'CARRIER', status: 'IN_REVIEW', billDate: '2026-11-01', billMonth: '2026-11', recordedAt: '2026-11-12T00:00:00Z',
    recordedBy: 'ryne@bcatcorp.com', dueAt: '2026-11-22', termsDays: 21, grossCents: 147_000, quickPayFeeCents: 0, netCents: 147_000,
    billedCents: 147_000, varianceCents: 0, paidCents: 0, creditedCents: 0, balanceCents: 147_000, createdBy: 'ryne@bcatcorp.com',
    updatedBy: 'ryne@bcatcorp.com', version: 1, ...patch,
  }
}

const delivered: BillShipmentFacts = { shipmentNumber: '20027', po: 'FR-113188-3', deliveredAt: '2026-11-12T07:11:00Z', delivered: true }

describe('payablesQueue', () => {
  it('keeps delivered loads from the Load review flow, holds Aljex bills behind the toggle, and drops undelivered and unread ones', () => {
    const facts = new Map<string, BillShipmentFacts>([
      ['s1', delivered],
      ['s2', { ...delivered, delivered: false, deliveredAt: null }],
      ['s3', delivered],
    ])
    const bills = [
      bill(),
      bill({ id: 'b2', shipmentId: 's2' }),
      bill({ id: 'b3', shipmentId: 's3', createdBy: 'aljex-import', recordedBy: 'aljex-import' }),
      bill({ id: 'b4', shipmentId: 'unread' }),
    ]
    expect(payablesQueue(bills, facts, { includeAljex: false }).map((b) => b.id)).toEqual(['b1'])
    expect(payablesQueue(bills, facts, { includeAljex: true }).map((b) => b.id)).toEqual(['b1', 'b3'])
    expect(isAljexBill(bills[2])).toBe(true)
  })
})

describe('billFactsIndex', () => {
  it('reads the PO off the order and delivery off the shipment', () => {
    const shipments = [{ id: 's1', number: '20027', status: 'DELIVERED', deliveredAt: null } as unknown as ShipmentRecord]
    const orders = [{ id: 'o1', shipmentId: 's1', references: [{ code: 'PO', value: ' FR-1 ' }] } as unknown as OrderRecord]
    expect(billFactsIndex(shipments, orders).get('s1')).toEqual({ shipmentNumber: '20027', po: 'FR-1', deliveredAt: null, delivered: true, revDivision: null, revSubdivision: null, customerName: null })
  })

  it('names the customer from the shipment, else its order, and bills read it by shipment', () => {
    const shipments = [
      { id: 's1', number: '20027', status: 'DELIVERED', customerName: ' DENALI INGREDIENTS ' } as unknown as ShipmentRecord,
      { id: 's2', number: '20028', status: 'DELIVERED', customerName: null } as unknown as ShipmentRecord,
      { id: 's3', number: '20029', status: 'DELIVERED' } as unknown as ShipmentRecord,
    ]
    const orders = [{ id: 'o2', shipmentId: 's2', customerName: 'CARLYN DAIRY PRODUCTS' } as unknown as OrderRecord]
    const facts = billFactsIndex(shipments, orders)
    expect(billCustomerName(bill({ shipmentId: 's1' }), facts)).toBe('DENALI INGREDIENTS')
    expect(billCustomerName(bill({ shipmentId: 's2' }), facts)).toBe('CARLYN DAIRY PRODUCTS')
    expect(billCustomerName(bill({ shipmentId: 's3' }), facts)).toBeNull()
    expect(billCustomerName(bill({ shipmentId: 'unread' }), facts)).toBeNull()
  })
})

describe('billDaysPastDue', () => {
  const asOf = '2026-11-18'
  it('counts whole days past the due date, 0 on it and negative before it', () => {
    expect(billDaysPastDue(bill({ dueAt: '2026-11-06' }), asOf)).toBe(12)
    expect(billDaysPastDue(bill({ dueAt: '2026-11-17' }), asOf)).toBe(1)
    expect(billDaysPastDue(bill({ dueAt: '2026-11-18' }), asOf)).toBe(0)
    expect(billDaysPastDue(bill({ dueAt: '2026-11-21' }), asOf)).toBe(-3)
  })

  it('is blank for paid and void bills and for a bill still waiting on its invoice date', () => {
    expect(billDaysPastDue(bill({ dueAt: '2026-10-01', status: 'PAID' }), asOf)).toBeNull()
    expect(billDaysPastDue(bill({ dueAt: '2026-10-01', status: 'VOID' }), asOf)).toBeNull()
    expect(billDaysPastDue(bill({ dueAt: '2026-10-01', datesPending: true }), asOf)).toBeNull()
    expect(billDaysPastDue(bill({ dueAt: '' }), asOf)).toBeNull()
  })

  it('reads the same day count the Aging buckets use', async () => {
    const { agingBucket } = await import('@/lib/arAging')
    expect(agingBucket('2026-10-19', asOf)).toBe('D1_30') // 30 days late
    expect(billDaysPastDue(bill({ dueAt: '2026-10-19' }), asOf)).toBe(30)
    expect(agingBucket('2026-10-18', asOf)).toBe('D31_60') // 31 days late
    expect(billDaysPastDue(bill({ dueAt: '2026-10-18' }), asOf)).toBe(31)
  })

  it('words one day as singular', () => {
    expect(daysLateLabel(1)).toBe('1 day late')
    expect(daysLateLabel(986)).toBe('986 days late')
  })
})

describe('reports', () => {
  const facts = new Map([['s1', delivered]])
  it('estimates the due date of a bill still waiting on its invoice date from delivery + terms', () => {
    expect(estimatedDueAt(bill({ datesPending: true }), facts)).toBe('2026-12-03')
    const [row] = apReportRows([bill({ datesPending: true })], facts, [], '2026-11-12')
    expect(row).toMatchObject({ invoiceDate: null, dueAt: '2026-12-03', dueEstimated: true, daysAging: null, po: 'FR-113188-3' })
  })

  it('totals by carrier and in all, and writes a CSV with both', () => {
    const rows = apReportRows([
      bill(),
      bill({ id: 'b2', carrierName: 'Blue', quickPay: true, quickPayDays: 2, quickPayFeeBps: 600, quickPayFeeCents: 6_000, grossCents: 100_000, netCents: 94_000, balanceCents: 94_000 }),
    ], facts, [], '2026-11-12')
    const { byCarrier, total } = apReportTotals(rows)
    expect(byCarrier.map((t) => t.carrier)).toEqual(['SHERIFAJ', 'Blue'])
    expect(total).toMatchObject({ count: 2, grossCents: 247_000, feeCents: 6_000, netCents: 241_000 })
    const csv = apReportCsv(rows)
    expect(csv).toContain('Quick pay 2 days · 6%')
    expect(csv).toContain('Total (2)')
  })

  it('labels the terms', () => {
    expect(termsLabel(bill())).toBe('Standard (21 days)')
    expect(termsLabel(bill({ quickPay: true, quickPayDays: 10, quickPayFeeBps: 300 }))).toBe('Quick pay 10 days · 3%')
  })
})

describe('cashRequirements', () => {
  it('buckets the next 30 days by week, past due first, estimated amounts called out, later ones left out', () => {
    const facts = new Map([['s1', delivered]])
    const rows = apReportRows([
      bill({ id: 'late', dueAt: '2026-11-05', balanceCents: 10_000 }),
      bill({ id: 'w1', dueAt: '2026-11-12', balanceCents: 20_000 }),
      bill({ id: 'w2', dueAt: '2026-11-20', balanceCents: 30_000 }),
      bill({ id: 'est', datesPending: true, balanceCents: 40_000 }), // delivered 11-12 + 21 = 12-03 → week 4
      bill({ id: 'last', dueAt: '2026-12-11', balanceCents: 50_000 }), // day 30 → week 5
      bill({ id: 'later', dueAt: '2027-01-15', balanceCents: 60_000 }),
      bill({ id: 'paid', dueAt: '2026-11-15', balanceCents: 0 }),
    ], facts, [], '2026-11-12')
    const cash = cashRequirements(rows, '2026-11-12')
    expect(cash.pastDue.cents).toBe(10_000)
    expect(cash.weeks.map((w) => w.cents)).toEqual([20_000, 30_000, 0, 40_000, 50_000])
    expect(cash.weeks[3].estimatedCents).toBe(40_000)
    expect(cash.weeks[4]).toMatchObject({ from: '2026-12-10', to: '2026-12-11' })
    expect(cash.totalCents).toBe(150_000)
    expect(cash).toMatchObject({ laterCents: 60_000, laterCount: 1, estimatedCents: 40_000 })
  })
})

describe('apSummary', () => {
  it('totals the ladder, past due and next 7 days, factor vs direct, quick pay this month, days to pay, and division slices', () => {
    const facts = new Map<string, BillShipmentFacts>([
      ['s1', { ...delivered, revDivision: 'ASSETS', revSubdivision: 'OWNER_OPERATOR', deliveredAt: '2026-10-28T00:00:00Z' }],
      ['s2', { ...delivered, revDivision: 'BROKERAGE', revSubdivision: null }],
    ])
    const expected = [bill({ id: 'e', datesPending: true, balanceCents: 10_000, shipmentId: 's2' })]
    const aging = [
      bill({ id: 'a1', dueAt: '2026-11-05', balanceCents: 20_000, billDate: '2026-11-01', quickPay: true, quickPayFeeBps: 600, quickPayFeeCents: 1_200 }),
      bill({ id: 'a2', dueAt: '2026-11-15', balanceCents: 30_000, payeeKind: 'FACTOR' }),
    ]
    const selected = [bill({ id: 's', dueAt: '2026-11-30', balanceCents: 40_000, shipmentId: 's2' })]
    const paidRecent = [bill({ id: 'p', status: 'PAID', billDate: '2026-10-01', paidAt: '2026-10-31T12:00:00Z', balanceCents: 0 })]
    const s = apSummary({ expected, aging, selected, paidRecent, facts, asOf: '2026-11-12' })
    expect(s.open).toEqual({ count: 4, cents: 100_000 })
    expect(s.expected).toEqual({ count: 1, cents: 10_000 })
    expect(s.pastDue).toEqual({ count: 1, cents: 20_000 })
    expect(s.dueNext7).toEqual({ count: 1, cents: 30_000 })
    expect(s.payToFactor.cents).toBe(30_000)
    expect(s.payDirect.cents).toBe(70_000)
    expect(s.quickPay).toEqual({ count: 1, feeCents: 1_200, fee6Cents: 1_200, fee3Cents: 0 })
    expect(s.avgDaysToPay).toBe(30)
    expect(s.avgDaysToInvoice).toBe(4)
    expect(s.byDivision.map((d) => [d.key, d.cents])).toEqual([
      ['ASSETS', 50_000], ['ASSETS/OWNER_OPERATOR', 50_000], ['BROKERAGE', 50_000],
    ])
    expect(inDivision(aging[0], facts, 'ASSETS/OWNER_OPERATOR')).toBe(true)
    expect(inDivision(selected[0], facts, 'ASSETS')).toBe(false)
    expect(s.fromAljex).toEqual({ count: 0, cents: 0 })
  })

  it('counts bills brought over from Aljex in every total and says how much of open AP they are', () => {
    const facts = new Map<string, BillShipmentFacts>([['s1', delivered], ['s2', delivered]])
    const all = [
      bill({ id: 'n', balanceCents: 10_000 }),
      bill({ id: 'x', shipmentId: 's2', status: 'TO_BE_PAID', createdBy: 'aljex-import', recordedBy: 'aljex-import', dueAt: '2026-10-01', balanceCents: 25_000 }),
    ]
    // The totals are built from the queue with Aljex included, whatever the list toggle says.
    const queue = payablesQueue(all, facts, { includeAljex: true })
    const s = apSummary({ expected: queue.filter((b) => b.id === 'n'), aging: queue.filter((b) => b.id === 'x'), selected: [], paidRecent: [], facts, asOf: '2026-11-12' })
    expect(s.open).toEqual({ count: 2, cents: 35_000 })
    expect(s.fromAljex).toEqual({ count: 1, cents: 25_000 })
    expect(s.pastDue).toEqual({ count: 1, cents: 25_000 })
    expect(payablesQueue(all, facts, { includeAljex: false }).map((b) => b.id)).toEqual(['n'])
  })
})
