import { describe, expect, it } from 'vitest'
import { billLabel, payablesQueue, type BillShipmentFacts } from './apQueue'
import { billsAging, billsExpected } from './apViews'
import { payablesSummary } from './useApSummaryModel'
import type { CarrierBillRecord } from '@/types/tms'

function bill(patch: Partial<CarrierBillRecord> = {}): CarrierBillRecord {
  return {
    id: 'b1', loadCarrierId: 'lc1', loadId: 'l1', shipmentId: 's1', shipmentNumber: '20027', carrierId: 'c1', carrierName: 'SHERIFAJ',
    payeeKind: 'CARRIER', status: 'IN_REVIEW', billDate: '2026-11-01', billMonth: '2026-11', recordedAt: '2026-11-12T00:00:00Z',
    recordedBy: 'ryne@bcatcorp.com', dueAt: '2026-11-22', termsDays: 21, grossCents: 10_000, quickPayFeeCents: 0, netCents: 10_000,
    billedCents: 10_000, varianceCents: 0, paidCents: 0, creditedCents: 0, balanceCents: 10_000, createdBy: 'ryne@bcatcorp.com',
    updatedBy: 'ryne@bcatcorp.com', version: 1, ...patch,
  }
}
const aljex = { createdBy: 'aljex-import', recordedBy: 'aljex-import' }
const facts = new Map<string, BillShipmentFacts>([['s1', { shipmentNumber: '20027', po: null, deliveredAt: '2026-11-12T00:00:00Z', delivered: true }]])
const bills = [
  bill({ id: 'e-new', datesPending: true }),
  bill({ id: 'e-aljex', datesPending: true, balanceCents: 20_000, ...aljex }),
  bill({ id: 'a-new', status: 'TO_BE_PAID', balanceCents: 30_000 }),
  bill({ id: 'a-aljex', status: 'TO_BE_PAID', balanceCents: 40_000, ...aljex }),
  bill({ id: 'a-aljex2', status: 'PARTIAL', balanceCents: 50_000, dueAt: '2026-10-01', ...aljex }),
]
const sum = (list: CarrierBillRecord[]) => ({ count: list.length, cents: list.reduce((s, b) => s + b.balanceCents, 0) })

describe('Payables tabs tie to the summary, Aljex bills always included', () => {
  it('lists every open bill and each tab equals its summary line', () => {
    // ApPage: the lists and the totals are the same set (Aljex imports always in).
    const shown = payablesQueue(bills, facts, { includeAljex: true })
    expect(shown).toHaveLength(5)
    const summary = payablesSummary({ owned: shown, party: shown, paidRecent: [], facts, asOf: '2026-11-16' })
    expect(sum(billsExpected(shown))).toEqual(summary.expected)
    expect(sum(billsAging(shown))).toEqual(summary.aging)
  })
})

describe('billLabel', () => {
  it('prints the carrier invoice number when it is a real one', () => {
    expect(billLabel(bill({ billNumber: 'INV-7781' }))).toBe('INV-7781')
  })
  it('replaces internal ids with PRO and carrier', () => {
    expect(billLabel(bill({ id: 'cb:lcr-arsheet-14372:1', billNumber: undefined, shipmentNumber: '14372', carrierName: 'W GUZY TRUCKING INC' }))).toBe('PRO 14372 · W GUZY TRUCKING INC')
    expect(billLabel(bill({ id: 'cb:lcr-a0545bae:1', billNumber: 'cb:lcr-a0545bae:1' }))).toBe('PRO 20027 · SHERIFAJ')
  })
})
