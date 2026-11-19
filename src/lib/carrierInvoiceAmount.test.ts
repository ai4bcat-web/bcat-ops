import { describe, expect, it } from 'vitest'
import { chargeToDraft, repriceToInvoiceAmount } from './carrierInvoiceAmount'
import type { LoadChargeRecord } from '../types/tms'

function line(patch: Partial<LoadChargeRecord> & Pick<LoadChargeRecord, 'code' | 'rateCents' | 'sortOrder'>): LoadChargeRecord {
  return {
    id: `l-${patch.sortOrder}`, shipmentId: 's1', side: 'CARRIER', calculatedBy: 'FLAT', count: 1, isRate: false, amountCents: patch.rateCents,
    loadCarrierId: 'lc1', createdBy: 'x', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', ...patch,
  } as LoadChargeRecord
}

// BISKA, PRO 14563: BCAT has $5,125.00 (linehaul 4,900 + 225 of extras); the carrier invoiced $5,000.00.
const biska = [
  line({ code: 'LINEHAUL', rateCents: 490_000, sortOrder: 0, isRate: true }),
  line({ code: 'DETENTION', rateCents: 22_500, sortOrder: 1 }),
]

describe('repriceToInvoiceAmount', () => {
  it('moves the linehaul so the lines total what the carrier invoiced, and leaves the other lines alone', () => {
    const result = repriceToInvoiceAmount(biska, 500_000)
    expect(result).toMatchObject({ ok: true, fromCents: 512_500, toCents: 500_000 })
    if (!result.ok) return
    expect(result.charges.map((c) => [c.code, c.rateCents])).toEqual([['LINEHAUL', 477_500], ['DETENTION', 22_500]])
  })

  it('hands the lines back unchanged when they already total the invoice', () => {
    const result = repriceToInvoiceAmount(biska, 512_500)
    expect(result).toMatchObject({ ok: true, fromCents: 512_500, toCents: 512_500 })
    if (result.ok) expect(result.charges).toEqual(biska.map(chargeToDraft))
  })

  it('makes a per-mile linehaul a flat amount and counts it once', () => {
    const perMile = [line({ code: 'LINEHAUL', rateCents: 250, sortOrder: 0, isRate: true, calculatedBy: 'PER_MILE' })]
    const result = repriceToInvoiceAmount(perMile, 120_000, { miles: 400 })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.charges[0]).toMatchObject({ calculatedBy: 'FLAT', count: 1, rateCents: 120_000 })
  })

  it('solves through a percent line that rides on the rate', () => {
    const withFuel = [
      line({ code: 'LINEHAUL', rateCents: 100_000, sortOrder: 0, isRate: true }),
      line({ code: 'FSC', rateCents: 1_000, sortOrder: 1, calculatedBy: 'PERCENT', amountCents: 10_000 }),
    ]
    // 10% on top of the linehaul: 1.1 x rate = 55,000.00
    const result = repriceToInvoiceAmount(withFuel, 5_500_000)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.charges[0].rateCents).toBe(5_000_000)
  })

  it('refuses when the other charges already exceed the invoice', () => {
    const result = repriceToInvoiceAmount(biska, 10_000)
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.message).toMatch(/already add up to more/)
  })

  it('refuses when there is no rate line to move', () => {
    const noRate = [line({ code: 'DETENTION', rateCents: 22_500, sortOrder: 0 })]
    const result = repriceToInvoiceAmount(noRate, 500_000)
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.message).toMatch(/no rate line/)
  })

  it('refuses an amount that is not a positive number of cents', () => {
    expect(repriceToInvoiceAmount(biska, 0)).toMatchObject({ ok: false })
    expect(repriceToInvoiceAmount(biska, 12.5)).toMatchObject({ ok: false })
  })
})
