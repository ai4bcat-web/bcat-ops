import { describe, expect, it } from 'vitest'
import {
  CAR_SHIPPING_REVIEW_REQUIREMENTS,
  carShippingFactorGaps,
  carShippingKeepsReason,
  rateConRequired,
  reviewRequirementsForLoad,
  DEFAULT_REVIEW_REQUIREMENTS,
} from './reviewRequirements'
import { evaluateLoadReview, type LoadReviewRow } from './loadReview'
import { evaluateReleaseGate, type ReleaseGateInput } from './releaseGate'
import { requiredFieldsForLoad, DEFAULT_REQUIRED_LOAD_FIELDS } from './flowDefaults'
import { pushRefusals } from '@/features/shipments/batchReview'
import type { ShipmentRow } from '@/features/shipments/shipmentViews'
import { carShippingFormKeeps, validateForm } from '@/features/shipments/form/validation'
import { emptyValues } from '@/features/shipments/form/model'

// Ryne 2026-11-16: a car-shipping load needs exactly delivered, customer, division, rep, customer rate, carrier cost,
// profit, billing method and AP e-mail. Everything else is dropped unless the customer factors (OTR).

/** A delivered car-shipping load with only the nine satisfied: no PO, no appointments, no stop states, no carrier. */
const carRow = (over: Partial<LoadReviewRow> = {}): LoadReviewRow => ({
  id: 's1',
  number: '14355',
  status: 'DELIVERED',
  loadReviewPushedAt: '2026-11-16T00:00:00Z',
  arStatus: 'DOCS_NEEDED',
  customerId: 'auto-shipper',
  salesRepId: 'rep-ruben',
  revDivision: 'CAR_SHIPPING',
  assignmentType: null,
  docsRequired: null,
  docsMissing: null,
  openIncidentCount: 2,
  orderRevenueCents: 120_000,
  costCents: 100_000,
  reference: null,
  buildState: 'BUILDING',
  stops: [{ type: 'PICKUP', city: 'Skokie', appt: null }, { type: 'DELIVERY', city: '', appt: null }],
  customerBillingGaps: [],
  customerFactors: false,
  ...over,
})

describe('car-shipping requirement profile', () => {
  it('uses its own fixed review list, plus POD/RC only when the customer factors', () => {
    expect(reviewRequirementsForLoad(DEFAULT_REVIEW_REQUIREMENTS, { revDivision: 'CAR_SHIPPING' })).toEqual([...CAR_SHIPPING_REVIEW_REQUIREMENTS])
    expect(reviewRequirementsForLoad(DEFAULT_REVIEW_REQUIREMENTS, { revDivision: 'CAR_SHIPPING', customerFactors: true }))
      .toEqual(expect.arrayContaining(['podReceived', 'rateConReceived']))
    expect(reviewRequirementsForLoad(DEFAULT_REVIEW_REQUIREMENTS, { revDivision: 'BROKERAGE' })).toEqual([...DEFAULT_REVIEW_REQUIREMENTS])
  })

  it('keeps only the nine codes (and OTR codes when factored)', () => {
    for (const code of ['STOP_INCOMPLETE', 'REFERENCE_NUMBER_MISSING', 'CARRIER_NOT_ASSIGNED', 'CARRIER_RATE_MISSING', 'OPEN_EXCEPTIONS', 'BUILDING', 'DOCS_UNCHECKED', 'FACTOR_PICKUP_ZIP']) {
      expect(carShippingKeepsReason(code)).toBe(false)
    }
    for (const code of ['NOT_DELIVERED', 'NO_CUSTOMER', 'REV_DIVISION_MISSING', 'SALES_REP_MISSING', 'NO_CUSTOMER_CHARGES', 'EXPENSE_MISSING', 'PROFIT_MISSING', 'CUSTOMER_BILLING_METHOD', 'CUSTOMER_AP_EMAIL']) {
      expect(carShippingKeepsReason(code)).toBe(true)
    }
    expect(carShippingKeepsReason('FACTOR_PICKUP_ZIP', { customerFactors: true })).toBe(true)
    expect(carShippingKeepsReason('DOC_MISSING', { customerFactors: true, detail: 'POD' })).toBe(true)
    expect(carShippingKeepsReason('DOC_MISSING', { customerFactors: true, detail: 'BOL' })).toBe(false)
  })

  it('Load Review passes a car-shipping load with only the nine satisfied', () => {
    const verdict = evaluateLoadReview({ row: carRow() })
    expect(verdict.ok).toBe(true)
  })

  it('Load Review still holds a car-shipping load on its own requirements', () => {
    const verdict = evaluateLoadReview({ row: carRow({ costCents: null, salesRepId: null, customerBillingGaps: ['CUSTOMER_AP_EMAIL'] }) })
    const codes = Object.values(verdict.checks).flatMap((c) => c.reasons.map((r) => r.code))
    expect(codes).toEqual(expect.arrayContaining(['EXPENSE_MISSING', 'PROFIT_MISSING', 'SALES_REP_MISSING', 'CUSTOMER_AP_EMAIL']))
    expect(codes).not.toContain('STOP_INCOMPLETE')
  })

  it('a factored car-shipping load still needs what OTR needs', () => {
    const verdict = evaluateLoadReview({ row: carRow({ customerFactors: true, factorGaps: ['PO_MISSING', 'PICKUP_ZIP'], docsMissing: ['POD'], docsRequired: ['POD'] }) })
    const codes = Object.values(verdict.checks).flatMap((c) => c.reasons.map((r) => r.code))
    expect(codes).toEqual(expect.arrayContaining(['FACTOR_PO_MISSING', 'FACTOR_PICKUP_ZIP', 'DOC_MISSING']))
    expect(codes).not.toContain('STOP_INCOMPLETE')
  })

  it('the release gate asks a car-shipping load only that it delivered (OTR documents when factored)', () => {
    const gate: ReleaseGateInput = {
      shipment: { status: 'DELIVERED', voidedAt: null, deletedAt: null, revDivision: 'CAR_SHIPPING' },
      order: { arStatus: 'DOCS_NEEDED', references: [], invoiceId: null },
      requiredDocTypes: ['POD', 'BOL'],
      requiredReferenceCodes: ['PO'],
      documents: [],
      legs: [],
      openIncidentCount: 3,
    }
    expect(evaluateReleaseGate(gate)).toEqual({ ok: true, missing: [] })
    const factored = evaluateReleaseGate({ ...gate, customerFactors: true, rateConRequired: rateConRequired({ asset: false, carShipper: true, customerFactors: true }) })
    expect(factored.missing.map((m) => m.detail)).toEqual(expect.arrayContaining(['POD', 'RATE_CON']))
    expect(factored.missing.map((m) => m.code)).not.toContain('REFERENCE_MISSING')
  })

  it('the board push refuses a car-shipping load only on its nine', () => {
    const row = { ...carRow(), reference: null, revenueCents: 120_000 } as unknown as ShipmentRow
    expect(pushRefusals([row], { customers: [], orgDefault: null })).toEqual([])
    const noCost = { ...row, costCents: null } as unknown as ShipmentRow
    expect(pushRefusals([noCost], { customers: [], orgDefault: null })[0].reasons.join(' ')).toMatch(/expense/i)
  })

  it('booking-time factor gaps keep only rate and billing method unless factored', () => {
    const gaps = [{ code: 'PO_MISSING' }, { code: 'RATE_MISSING' }, { code: 'PICKUP_ZIP' }, { code: 'BILLING_METHOD' }]
    expect(carShippingFactorGaps(gaps, { revDivision: 'CAR_SHIPPING' }).map((g) => g.code)).toEqual(['RATE_MISSING', 'BILLING_METHOD'])
    expect(carShippingFactorGaps(gaps, { revDivision: 'CAR_SHIPPING', customerFactors: true })).toHaveLength(4)
    expect(carShippingFactorGaps(gaps, { revDivision: 'BROKERAGE' })).toHaveLength(4)
  })

  it('required load fields: only rep, division and rate for car shipping', () => {
    expect(requiredFieldsForLoad(DEFAULT_REQUIRED_LOAD_FIELDS, { revDivision: 'CAR_SHIPPING' })).toEqual(['salesRep', 'revenueDivision'])
  })

  it('the form drops references, stops and freight for car shipping, but keeps validity checks', () => {
    expect(carShippingFormKeeps('customer:ref:po', false)).toBe(false)
    expect(carShippingFormKeeps('customer:ref:po', true)).toBe(true)
    expect(carShippingFormKeeps('pickup:appt', false)).toBe(false)
    expect(carShippingFormKeeps('shipping:weightLbs', false)).toBe(false)
    expect(carShippingFormKeeps('pickup:city:0', false)).toBe(false)
    expect(carShippingFormKeeps('pickup:factor:PICKUP_ZIP', false)).toBe(false)
    expect(carShippingFormKeeps('rates:factor:RATE_MISSING', false)).toBe(true)
    expect(carShippingFormKeeps('roles:needs:salesRep', false)).toBe(true)
    expect(carShippingFormKeeps('consignee:needs:deliveryAddress', false)).toBe(false)
    expect(carShippingFormKeeps('rates:customerHours', false)).toBe(true)
    const v = emptyValues()
    v.ship.revDivision = 'CAR_SHIPPING'
    const ids = validateForm(v, { mode: 'create', settings: null, level: 'create', customer: null }).map((i) => i.id)
    expect(ids).not.toContain('pickup:appt')
    expect(ids).not.toContain('customer:ref:po')
    expect(ids).toContain('customer:name')
  })
})
