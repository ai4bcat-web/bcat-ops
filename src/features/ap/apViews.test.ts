import { describe, expect, it } from 'vitest'
import { ageOpenItems } from '@/lib/arAging'
import { sharedProIndex, sharedProLabel, siblingCarriers, awaitingInvoiceTotals } from './apViews'

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
