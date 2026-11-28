import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/apiClient', () => ({}))
vi.mock('../newShipmentEffects', () => ({}))
import { CUSTOMER, filledValues, storedBundle } from './testFixtures'
import {
  accessorialPricing, financialPreview, fuelPreview, percentToBps, rebaseCharges, toBookCarrierDraft, toCharges,
} from './mapping'
import { ACCESSORIAL_SORT_BASE, emptyValues, valuesFromBundle, type AccessorialLine, type ShipmentFormValues } from './model'
import { blockingIssues, validateForm } from './validation'
import { invoiceLinesFor } from '@/lib/invoiceBuild'
import { describeLine } from '@/lib/invoicePdf'
import type { LoadChargeRecord, ShipmentBundle } from '@/types/tms'

const row = (over: Partial<AccessorialLine> = {}): AccessorialLine => ({
  id: '', carrierLineId: '', release: '', paidTo: '', code: 'FSC', label: 'Fuel surcharge', carrierAmount: '', customerAmount: '', note: '', ...over,
})

/** A $3,650.00 customer linehaul and a $3,000.00 carrier linehaul, no Rates box fuel surcharge. */
function priced(lines: AccessorialLine[]): ShipmentFormValues {
  const v = emptyValues()
  v.rates.customer = { rateType: 'FLAT', hours: '', lhRate: '3650', lineId: '' }
  v.rates.carrier = { ...v.rates.carrier, rateType: 'FLAT', lhRate: '3000' }
  v.rates.fscPercent = ''
  v.rates.fscPerMile = ''
  v.rates.lines = lines
  return v
}

describe('percentToBps / accessorialPricing', () => {
  it('reads 0 to 100 with at most two decimals as basis points', () => {
    expect(percentToBps('8.5')).toBe(850)
    expect(percentToBps('8.5%')).toBe(850)
    expect(percentToBps(' 12.34 ')).toBe(1234)
    expect(percentToBps('0')).toBe(0)
    expect(percentToBps('100')).toBe(10000)
  })
  it('refuses anything else', () => {
    for (const bad of ['', 'abc', '-1', '100.01', '101', '8.555', '1e2']) expect(percentToBps(bad)).toBeUndefined()
  })
  it('is a percentage only for a fuel surcharge in PERCENT mode', () => {
    expect(accessorialPricing('FSC', 'PERCENT', '8.5')).toEqual({ calculatedBy: 'PERCENT', rateCents: 850 })
    expect(accessorialPricing('fsc', 'PERCENT', '8.5')).toEqual({ calculatedBy: 'PERCENT', rateCents: 850 })
    expect(accessorialPricing('FSC', 'FLAT', '125.50')).toEqual({ calculatedBy: 'FLAT', rateCents: 12550 })
    expect(accessorialPricing('FSC', undefined, '125.50')).toEqual({ calculatedBy: 'FLAT', rateCents: 12550 })
    // Another accessorial never reads its box as a percentage, even if a stale mode says so.
    expect(accessorialPricing('DETENTION', 'PERCENT', '8.5')).toEqual({ calculatedBy: 'FLAT', rateCents: 850 })
    expect(accessorialPricing('FSC', 'PERCENT', '101')).toBeUndefined()
  })
})

describe('a fuel surcharge accessorial row', () => {
  it('writes a flat customer charge in dollars', () => {
    const v = priced([row({ customerAmount: '125.50' })])
    const fsc = toCharges(v, { orderId: 'o', loadId: 'l' }).find((c) => c.code === 'FSC')!
    expect(fsc).toMatchObject({ side: 'CUSTOMER', calculatedBy: 'FLAT', rateCents: 12550, count: 1, isRate: true, sortOrder: ACCESSORIAL_SORT_BASE })
  })

  it('writes a percentage customer charge in basis points and prices it off the linehaul', () => {
    const v = priced([row({ customerAmount: '8.5', customerMode: 'PERCENT' })])
    const fsc = toCharges(v, { orderId: 'o', loadId: 'l' }).find((c) => c.code === 'FSC')!
    expect(fsc).toMatchObject({ side: 'CUSTOMER', calculatedBy: 'PERCENT', rateCents: 850, count: 1, isRate: true, sortOrder: ACCESSORIAL_SORT_BASE })
    const fuel = fuelPreview(v)
    expect(fuel.rows[0].customer).toEqual({ amountCents: 31_025, baseCents: 365_000 }) // 8.5% of $3,650.00 = $310.25
    const p = financialPreview(v, CUSTOMER, null)
    expect(p.customerTotalCents).toBe(365_000 + 31_025)
  })

  it('does not take the percentage of a flat fuel line next to it', () => {
    const v = priced([row({ customerAmount: '100' }), row({ customerAmount: '10', customerMode: 'PERCENT' })])
    expect(fuelPreview(v).rows[1].customer).toEqual({ amountCents: 36_500, baseCents: 365_000 })
  })

  it('prices the carrier side against the carrier linehaul, separately from the customer side', () => {
    const v = priced([row({ customerAmount: '8.5', customerMode: 'PERCENT', carrierAmount: '5', carrierMode: 'PERCENT' })])
    const fuel = fuelPreview(v)
    expect(fuel.rows[0].customer).toEqual({ amountCents: 31_025, baseCents: 365_000 })
    expect(fuel.rows[0].carrier).toEqual({ amountCents: 15_000, baseCents: 300_000 }) // 5% of $3,000.00
    const p = financialPreview(v, CUSTOMER, null)
    expect(p.carrierTotalCents).toBe(300_000 + 15_000)
    expect(p.netCents).toBe(365_000 + 31_025 - 315_000)
  })

  it('lets each side choose its own mode', () => {
    const v = priced([row({ customerAmount: '8.5', customerMode: 'PERCENT', carrierAmount: '75' })])
    const lines = toCharges(v, { orderId: 'o', loadId: 'l', activeLoadCarrierId: 'lc-1' }).filter((c) => c.code === 'FSC')
    expect(lines.map((c) => [c.side, c.calculatedBy, c.rateCents])).toEqual([['CUSTOMER', 'PERCENT', 850], ['CARRIER', 'FLAT', 7500]])
  })

  it('sends a percentage carrier fuel surcharge with the booking draft', () => {
    const v = priced([row({ carrierAmount: '5', carrierMode: 'PERCENT' })])
    expect(toBookCarrierDraft(v).charges?.[0]).toMatchObject({ side: 'CARRIER', code: 'FSC', calculatedBy: 'PERCENT', rateCents: 500, count: 1, isRate: true })
  })

  it('writes nothing for an invalid percentage and the form says why', () => {
    const v = priced([row({ customerAmount: '101', customerMode: 'PERCENT' }), row({ customerAmount: '8.555', customerMode: 'PERCENT' })])
    expect(toCharges(v, { orderId: 'o', loadId: 'l' }).some((c) => c.code === 'FSC')).toBe(false)
    const issues = blockingIssues(validateForm(v, { mode: 'create', settings: null, level: 'draft', customer: null })).map((i) => i.id)
    expect(issues).toContain('rates:fscRowCustomer:0')
    expect(issues).toContain('rates:fscRowCustomer:1')
  })

  it('an empty percentage box is an empty line, not an error', () => {
    const v = priced([row({ customerAmount: '', customerMode: 'PERCENT' })])
    expect(blockingIssues(validateForm(v, { mode: 'create', settings: null, level: 'draft', customer: null })).map((i) => i.id)).not.toContain('rates:fscRowCustomer:0')
  })

  it('a stale percentage mode on another accessorial stays dollars', () => {
    const v = priced([row({ code: 'DETENTION', label: 'Detention', customerAmount: '90', customerMode: 'PERCENT' })])
    expect(toCharges(v, { orderId: 'o', loadId: 'l' }).find((c) => c.code === 'DETENTION')).toMatchObject({ calculatedBy: 'FLAT', rateCents: 9000 })
  })

  it('keeps the Rates box FSC % separate from the rows, and the read-only box line counts only itself', () => {
    const v = priced([row({ customerAmount: '2', customerMode: 'PERCENT' })])
    v.rates.fscPercent = '10'
    const fuel = fuelPreview(v)
    expect(fuel.boxFscCents).toBe(36_500) // 10% of the $3,650.00 linehaul
    expect(fuel.rows[0].customer?.amountCents).toBe(7_300) // 2%
  })

  it('counts the fuel row in the accessorials subtotal, with the lines that are not rate lines', () => {
    const v = priced([row({ customerAmount: '8.5', customerMode: 'PERCENT' }), row({ code: 'DETENTION', label: 'Detention', customerAmount: '90' })])
    expect(fuelPreview(v).accessorialCents.CUSTOMER).toBe(31_025 + 9_000)
  })
})

// ── reading the lines back ───────────────────────────────────────────────────

const stored = (over: Partial<LoadChargeRecord>): LoadChargeRecord => ({
  id: 'c', shipmentId: 'shp-1', side: 'CUSTOMER', orderId: 'ord-1', code: 'FSC', label: 'Fuel surcharge', calculatedBy: 'FLAT', rateCents: 0, count: 1, amountCents: 0,
  isRate: true, sortOrder: 10, createdBy: '', createdAt: '', updatedAt: '', ...over,
}) as LoadChargeRecord

function bundleWith(charges: LoadChargeRecord[]): ShipmentBundle {
  const v = filledValues()
  v.rates.lines = []
  v.rates.fscPercent = ''
  return { ...storedBundle(v), charges } as ShipmentBundle
}

describe('reading fuel surcharge lines back into the form', () => {
  it('a percentage line from sort order 10 is an accessorial row, not the Rates box FSC', () => {
    const v = valuesFromBundle(bundleWith([stored({ id: 'f1', calculatedBy: 'PERCENT', rateCents: 850, amountCents: 31_025 })]), { customer: CUSTOMER })
    expect(v.rates.fscPercent).toBe('')
    expect(v.rates.lines).toHaveLength(1)
    expect(v.rates.lines[0]).toMatchObject({ id: 'f1', code: 'FSC', customerAmount: '8.5', customerMode: 'PERCENT' })
    expect(v.rates.passthrough).toEqual([])
  })

  it('keeps the Rates box FSC % in its box when a fuel row sits beside it', () => {
    const v = valuesFromBundle(bundleWith([
      stored({ id: 'box', calculatedBy: 'PERCENT', rateCents: 1000, amountCents: 36_500, sortOrder: 1 }),
      stored({ id: 'f1', calculatedBy: 'PERCENT', rateCents: 850, amountCents: 31_025 }),
    ]), { customer: CUSTOMER })
    expect(v.rates.fscPercent).toBe('10')
    expect(v.rates.fscLineId).toBe('box')
    expect(v.rates.lines.map((l) => [l.id, l.customerAmount, l.customerMode])).toEqual([['f1', '8.5', 'PERCENT']])
  })

  it('a flat fuel line (the shape the Aljex import writes) is an editable row instead of hidden', () => {
    const v = valuesFromBundle(bundleWith([stored({ id: 'a1', calculatedBy: 'FLAT', rateCents: 12_550, amountCents: 12_550, sortOrder: 6 })]), { customer: CUSTOMER })
    expect(v.rates.lines).toHaveLength(1)
    expect(v.rates.lines[0]).toMatchObject({ id: 'a1', code: 'FSC', customerAmount: '125.50' })
    expect(v.rates.lines[0].customerMode).toBeUndefined()
    expect(v.rates.passthrough).toEqual([])
  })

  it('pairs a carrier fuel line with the customer one and keeps each side its own mode', () => {
    const v = valuesFromBundle({
      ...bundleWith([
        stored({ id: 'f1', calculatedBy: 'PERCENT', rateCents: 850, amountCents: 31_025 }),
        stored({ id: 'f2', side: 'CARRIER', orderId: null, loadCarrierId: 'lc-1', calculatedBy: 'FLAT', rateCents: 7_500, amountCents: 7_500 }),
      ]),
      loadCarriers: [{ id: 'lc-1', loadId: 'ld-1', status: 'ACTIVE', kind: 'CARRIER', sequence: 0, carrierId: 'car-1', carrierName: 'C', updatedAt: 'u' }],
    } as unknown as ShipmentBundle, { customer: CUSTOMER })
    expect(v.rates.lines).toHaveLength(1)
    expect(v.rates.lines[0]).toMatchObject({ id: 'f1', carrierLineId: 'f2', customerAmount: '8.5', customerMode: 'PERCENT', carrierAmount: '75' })
    expect(v.rates.lines[0].carrierMode).toBeUndefined()
  })

  it('writes the same lines back out, so an unchanged form re-saves the same money', () => {
    const bundle = bundleWith([stored({ id: 'f1', calculatedBy: 'PERCENT', rateCents: 850, amountCents: 31_025 })])
    const v = valuesFromBundle(bundle, { customer: CUSTOMER })
    const out = toCharges(v, { orderId: 'ord-1', loadId: 'ld-1' }).find((c) => c.code === 'FSC')!
    expect(out).toMatchObject({ id: 'f1', calculatedBy: 'PERCENT', rateCents: 850, count: 1, isRate: true })
  })

  it('after CREATE a server-seeded percentage fuel line is adopted by its row, not duplicated', () => {
    const v = priced([row({ customerAmount: '8.5', customerMode: 'PERCENT' })])
    const bundle = bundleWith([stored({ id: 'srv-1', calculatedBy: 'PERCENT', rateCents: 850, amountCents: 31_025 })])
    const rebased = rebaseCharges(v, bundle)
    expect(rebased.rates.lines).toHaveLength(1)
    expect(rebased.rates.lines[0].id).toBe('srv-1')
  })
})

// ── what leaves the building ─────────────────────────────────────────────────

describe('the invoice and the leak guard', () => {
  const charges = [
    stored({ id: 'lh', code: 'LINEHAUL', calculatedBy: 'FLAT', rateCents: 365_000, amountCents: 365_000, sortOrder: 0 }),
    stored({ id: 'f1', calculatedBy: 'PERCENT', rateCents: 850, amountCents: 31_025 }),
    stored({ id: 'cf', side: 'CARRIER', orderId: null, loadCarrierId: 'lc-1', calculatedBy: 'PERCENT', rateCents: 500, amountCents: 15_000 }),
  ]

  it('bills the customer fuel surcharge and never the carrier one', () => {
    const inv = invoiceLinesFor(charges, 'ord-1')
    expect(inv.lines.map((l) => [l.code, l.amountCents])).toEqual([['LINEHAUL', 365_000], ['FSC', 31_025]])
    expect(inv.subtotalCents).toBe(396_025)
    expect(JSON.stringify(inv)).not.toContain('15000')
  })

  it('reads "Fuel surcharge (8.5%)" for a percentage and plain "Fuel surcharge" for a flat one', () => {
    const [, pct] = invoiceLinesFor(charges, 'ord-1').lines
    expect(describeLine(pct)).toBe('Fuel surcharge (8.5%)')
    const flat = invoiceLinesFor([stored({ id: 'f2', calculatedBy: 'FLAT', rateCents: 12_550, amountCents: 12_550 })], 'ord-1').lines[0]
    expect(describeLine(flat)).toBe('Fuel surcharge')
    const whole = invoiceLinesFor([stored({ id: 'f3', calculatedBy: 'PERCENT', rateCents: 1000, amountCents: 36_500 })], 'ord-1').lines[0]
    expect(describeLine(whole)).toBe('Fuel surcharge (10%)')
  })

  it('names a percentage line that has no label by its code', () => {
    const line = invoiceLinesFor([stored({ id: 'f4', label: null, calculatedBy: 'PERCENT', rateCents: 825, amountCents: 1 })], 'ord-1').lines[0]
    expect(describeLine(line)).toBe('FSC (8.25%)')
  })
})
