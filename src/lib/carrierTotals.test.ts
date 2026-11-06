import { describe, it, expect } from 'vitest'
import { aggregateApStatus, carrierTotals, liveCarriersOf, marginOf, primaryCarrierOf } from './carrierTotals'
import type { CarrierLike, TotalsChargeLine } from './carrierTotals'
import { computeFinancials } from './shipmentCharges'
import { rateConLinesFor } from './carrierBill'
import type { LoadChargeRecord } from '../types/tms'

const lc = (id: string, over: Partial<CarrierLike> = {}): CarrierLike =>
  ({ id, loadId: 'L1', status: 'ACTIVE', kind: 'CARRIER', sequence: 1, carrierName: id, ...over })
const ch = (over: Partial<TotalsChargeLine>): TotalsChargeLine =>
  ({ side: 'CARRIER', amountCents: 0, isRate: true, ...over })

describe('liveCarriersOf / primaryCarrierOf', () => {
  const rows = [lc('b', { sequence: 2 }), lc('x', { loadId: 'L2' }), lc('a', { sequence: 1 }), lc('gone', { status: 'BOUNCED' })]
  it('returns this load\'s ACTIVE rows in booking order', () => {
    expect(liveCarriersOf(rows, 'L1').map((r) => r.id)).toEqual(['a', 'b'])
    expect(primaryCarrierOf(rows)?.id).toBe('a')
    expect(primaryCarrierOf([lc('t', { status: 'TONU' })])).toBeNull()
  })
})

describe('carrierTotals', () => {
  const carriers = [lc('A', { sequence: 1 }), lc('B', { sequence: 2, quickPay: true, quickPayFeeCents: 500 })]
  const charges = [
    ch({ loadCarrierId: 'A', amountCents: 60_000 }),
    ch({ loadCarrierId: 'B', amountCents: 20_000 }),
    ch({ loadCarrierId: 'B', amountCents: 5_000, isRate: false }),
  ]

  it('splits linehaul and accessorials per carrier and sums the gross', () => {
    const t = carrierTotals(charges, carriers)
    expect(t.perCarrier.map((r) => [r.loadCarrierId, r.linehaulCents, r.accessorialCents, r.totalCents, r.netCents]))
      .toEqual([['A', 60_000, 0, 60_000, 60_000], ['B', 20_000, 5_000, 25_000, 24_500]])
    expect(t.totalCents).toBe(85_000)
    expect(t.untaggedCents).toBe(0)
  })

  it('keeps a TONU row and drops a bounced one', () => {
    const t = carrierTotals(
      [...charges, ch({ loadCarrierId: 'T', amountCents: 7_000 }), ch({ loadCarrierId: 'Z', amountCents: 9_000 })],
      [...carriers, lc('T', { status: 'TONU', sequence: 3 }), lc('Z', { status: 'BOUNCED', sequence: 4 })],
    )
    expect(t.perCarrier.map((r) => r.loadCarrierId)).toEqual(['A', 'B', 'T'])
    expect(t.totalCents).toBe(92_000)
  })

  it('surfaces an untagged line with two carriers, attributes it with one', () => {
    const untagged = ch({ amountCents: 3_000, isRate: false })
    expect(carrierTotals([...charges, untagged], carriers).untaggedCents).toBe(3_000)
    expect(carrierTotals([...charges, untagged], carriers).totalCents).toBe(88_000)
    const one = carrierTotals([ch({ amountCents: 60_000 }), untagged], [lc('A')])
    expect(one.untaggedCents).toBe(0)
    expect(one.perCarrier[0].totalCents).toBe(63_000)
  })

  it('equals computeFinancials for one carrier, to the cent', () => {
    const lines = [
      { side: 'CARRIER' as const, code: 'LINEHAUL', calculatedBy: 'PER_CWT' as const, rateCents: 333, isRate: true, loadCarrierId: 'A' },
      { side: 'CARRIER' as const, code: 'FSC', calculatedBy: 'PERCENT' as const, rateCents: 1234, isRate: true, loadCarrierId: 'A' },
    ]
    const fin = computeFinancials(lines, { weightLbs: 40_123 })
    const t = carrierTotals(fin.lines, [lc('A')])
    expect(t.totalCents).toBe(fin.costCents)
    expect(t.perCarrier[0].linehaulCents).toBe(fin.carrierRateCents)
  })

  it('does not drift when odd-cent percent lines are split across carriers', () => {
    const lines = [
      { side: 'CARRIER' as const, code: 'LINEHAUL', calculatedBy: 'FLAT' as const, rateCents: 33_333, isRate: true, loadCarrierId: 'A' },
      { side: 'CARRIER' as const, code: 'LINEHAUL', calculatedBy: 'FLAT' as const, rateCents: 66_667, isRate: true, loadCarrierId: 'B' },
      { side: 'CARRIER' as const, code: 'DET', calculatedBy: 'PERCENT' as const, rateCents: 333, isRate: false, loadCarrierId: 'A' },
      { side: 'CARRIER' as const, code: 'DET', calculatedBy: 'PERCENT' as const, rateCents: 333, isRate: false, loadCarrierId: 'B' },
    ]
    const fin = computeFinancials(lines)
    const t = carrierTotals(fin.lines, carriers)
    expect(t.perCarrier.map((r) => r.accessorialCents)).toEqual([1110, 2220])
    expect(t.totalCents).toBe(fin.costCents)
  })
})

describe('marginOf', () => {
  it('is customer total minus carrier gross, with bps', () => {
    expect(marginOf({ customerTotalCents: 115_000, carrierGrossCents: 80_000 })).toEqual({ marginCents: 35_000, marginBps: 3043 })
    expect(marginOf({ customerTotalCents: 0, carrierGrossCents: 100 })).toEqual({ marginCents: -100, marginBps: 0 })
  })

  it('uses gross, so quick pay on a carrier does not move it', () => {
    const t = carrierTotals(
      [ch({ loadCarrierId: 'A', amountCents: 60_000 })],
      [lc('A', { quickPay: true, quickPayFeeCents: 900 })],
    )
    expect(marginOf({ customerTotalCents: 100_000, carrierGrossCents: t.totalCents }).marginCents).toBe(40_000)
  })
})

describe('aggregateApStatus', () => {
  it('is the least advanced live rung', () => {
    expect(aggregateApStatus([lc('a', { apStatus: 'PAID' }), lc('b', { apStatus: 'IN_REVIEW' })])).toBe('IN_REVIEW')
    expect(aggregateApStatus([lc('a', { apStatus: 'PAID' }), lc('b', { apStatus: null })])).toBe('AWAITING_INVOICE')
    expect(aggregateApStatus([lc('a', { apStatus: 'TO_BE_PAID' })])).toBe('TO_BE_PAID')
    expect(aggregateApStatus([lc('a', { status: 'BOUNCED', apStatus: 'AWAITING_INVOICE' })])).toBeNull()
  })
})

describe('rateConLinesFor (paidTo routing)', () => {
  const rec = (id: string, loadCarrierId: string | null, amountCents: number, sortOrder: number): LoadChargeRecord => ({
    id, shipmentId: 's', side: 'CARRIER', loadCarrierId, code: 'X', calculatedBy: 'FLAT', rateCents: amountCents,
    amountCents, isRate: false, sortOrder, createdBy: 't', createdAt: '', updatedAt: '',
  })
  const charges = [rec('1', 'A', 100, 1), rec('2', 'B', 200, 2), rec('3', null, 50, 3), { ...rec('4', 'B', 9, 4), side: 'CUSTOMER' as const }]

  it('prints only that carrier\'s lines when several are live; untagged go to the primary', () => {
    expect(rateConLinesFor(charges, { id: 'B' }, 2).lines.map((l) => l.chargeId)).toEqual(['2'])
    expect(rateConLinesFor(charges, { id: 'A' }, 2).grossCents).toBe(100)
    const primary = rateConLinesFor(charges, { id: 'A' }, 2, true)
    expect(primary.lines.map((l) => l.chargeId)).toEqual(['1', '3'])
    expect(primary.grossCents).toBe(150)
  })

  it('keeps the legacy single-carrier output: its lines plus untagged ones', () => {
    expect(rateConLinesFor([rec('1', 'A', 100, 1), rec('3', null, 50, 3)], { id: 'A' }, 1).grossCents).toBe(150)
  })
})
