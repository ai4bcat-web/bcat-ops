import { describe, expect, it } from 'vitest'
import { ageOpenItems } from '@/lib/arAging'
import type { CarrierBillRecord } from '@/types/tms'
import { buildApAgingReport } from './apAgingReport'

const asOf = '2026-11-16'
function bill(over: Partial<CarrierBillRecord> & { id: string }): CarrierBillRecord {
  return {
    loadCarrierId: 'lc', loadId: 'l', shipmentId: `s-${over.id}`, carrierId: 'car1', carrierName: 'Blue Line', payeeKind: 'CARRIER',
    status: 'TO_BE_PAID', dueAt: '2026-11-20', balanceCents: 100_00, billNumber: null, quickPay: false, ...over,
  } as CarrierBillRecord
}
const lookups = { proOf: (b: CarrierBillRecord) => `PRO-${b.id}`, payToOf: () => 'Direct' }

describe('Aging by carrier', () => {
  const bills = [
    bill({ id: 'a', dueAt: '2026-11-30', balanceCents: 100_00 }), // current
    bill({ id: 'b', dueAt: '2026-11-06', balanceCents: 200_00 }), // 10 days late
    bill({ id: 'c', carrierId: 'car2', carrierName: 'Red Line', dueAt: '2026-08-01', balanceCents: 300_00 }), // 90+
    bill({ id: 'd', status: 'PAID', balanceCents: 0 }),
    bill({ id: 'e', status: 'VOID', balanceCents: 999_00 }),
    bill({ id: 'f', status: 'IN_REVIEW', carrierId: 'car2', carrierName: 'Red Line', dueAt: '2026-10-01', balanceCents: 50_00 }), // 46 days late
  ]

  it('groups by carrier, ages by due date, and puts the bills under each carrier', () => {
    const report = buildApAgingReport(bills, asOf, lookups)
    expect(report.carriers.map((c) => c.carrierName)).toEqual(['Red Line', 'Blue Line'])
    const red = report.carriers[0]
    expect(red).toMatchObject({ totalCents: 350_00, count: 2, pastDueCents: 350_00, oldestDays: 107 })
    expect(red.byBucket).toMatchObject({ D91_PLUS: 300_00, D31_60: 50_00 })
    expect(red.bills.map((b) => b.pro)).toEqual(['PRO-c', 'PRO-f'])
    const blue = report.carriers[1]
    expect(blue.byBucket).toMatchObject({ CURRENT: 100_00, D1_30: 200_00 })
    expect(blue.pastDueCents).toBe(200_00)
  })

  it('totals exactly what the page\'s own aging (ageOpenItems over the open bills) totals', () => {
    const report = buildApAgingReport(bills, asOf, lookups)
    const own = ageOpenItems(
      bills.filter((b) => b.status === 'IN_REVIEW' || b.status === 'TO_BE_PAID' || b.status === 'PARTIAL')
        .map((b) => ({ partyId: b.carrierId, partyName: b.carrierName, dueAt: b.dueAt, balanceCents: b.balanceCents })),
      asOf,
    )
    expect(report.totalCents).toBe(own.totalCents)
    expect(report.byBucket).toEqual(own.byBucket)
    expect(report.pastDueCents).toBe(own.lateCents)
    expect(report.carriers.map((c) => [c.carrierId, c.totalCents])).toEqual(own.byParty.map((p) => [p.partyId, p.totalCents]))
  })
})
