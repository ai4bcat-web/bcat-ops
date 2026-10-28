import { describe, it, expect } from 'vitest'
import { evaluateCarrierBooking, insuranceState, oosBps } from './carrierEligibility'
import type { BookingFinding, CarrierBookingInput } from './carrierEligibility'
import type { CarrierDocumentRecord, CarrierDocumentType, CarrierRecord, InsurancePolicy } from '../types/tms'

const NOW = '2026-06-01T00:00:00.000Z'
const PICKUP = '2026-06-10T12:00:00.000Z'

const policy = (over: Partial<InsurancePolicy> = {}): InsurancePolicy => ({
  id: 'p1',
  type: 'CARGO',
  limitCents: 10_000_000,
  expiresAt: '2027-01-01T00:00:00.000Z',
  ...over,
})

const doc = (
  type: CarrierDocumentType,
  over: Partial<CarrierDocumentRecord> = {},
): CarrierDocumentRecord => ({
  id: `doc-${type}`,
  carrierId: 'c1',
  type,
  name: `${type}.pdf`,
  s3Key: `carrier-docs/c1/${type}.pdf`,
  contentType: 'application/pdf',
  sizeBytes: 1024,
  source: 'UPLOAD',
  uploadedBy: 'ryne@bcatcorp.com',
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
})

const carrier = (over: Partial<CarrierRecord> = {}): CarrierRecord => ({
  id: 'c1',
  name: 'Acme Trucking',
  type: 'TL',
  status: 'ACTIVE',
  authorityStatus: 'ACTIVE',
  insurancePolicies: [policy(), policy({ id: 'p2', type: 'AUTO_LIABILITY' })],
  createdBy: 'ryne@bcatcorp.com',
  updatedBy: 'ryne@bcatcorp.com',
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
})

/** A booking nobody has any reason to complain about; each test spoils one thing. */
const input = (over: Partial<CarrierBookingInput> = {}): CarrierBookingInput => ({
  carrier: carrier(),
  documents: [doc('COI_CARGO'), doc('COI_AUTO'), doc('W9'), doc('CARRIER_AGREEMENT')],
  load: {
    id: 'load-1',
    pickupAppt: PICKUP,
    commodity: 'Paper',
    weight: 42_000,
    cargoValueCents: 500_000,
    freightDescription: '20 pallets',
    activeLoadCarrierId: null,
  },
  financials: { topSpendCents: 300_000 },
  carrierRateCents: 250_000,
  otherActiveLoadCarriers: [],
  settings: null,
  now: NOW,
  isAdmin: false,
  ...over,
})

const keys = (findings: BookingFinding[]): string[] => findings.map((f) => f.key)

describe('evaluateCarrierBooking — nothing wrong', () => {
  it('has nothing to say about a clean carrier on a clean load', () => {
    const result = evaluateCarrierBooking(input())
    expect(result.blocks).toEqual([])
    expect(result.warnings).toEqual([])
  })
})

describe('evaluateCarrierBooking — flat refusals', () => {
  it('refuses a carrier whose status is not approved for booking', () => {
    const result = evaluateCarrierBooking(input({ carrier: carrier({ status: 'PENDING' }) }))
    expect(keys(result.blocks)).toContain('STATUS_NOT_ALLOWED')
  })

  it('refuses a do-not-use carrier by name as well as by status', () => {
    const result = evaluateCarrierBooking(input({ carrier: carrier({ status: 'DO_NOT_USE' }) }))
    expect(keys(result.blocks)).toContain('DO_NOT_USE')
  })

  it('refuses a carrier with inactive authority', () => {
    const result = evaluateCarrierBooking(
      input({ carrier: carrier({ authorityStatus: 'INACTIVE' }) }),
    )
    expect(keys(result.blocks)).toContain('AUTHORITY_INACTIVE')
  })

  it('refuses a load that already has a carrier on it', () => {
    const result = evaluateCarrierBooking(
      input({ load: { ...input().load, activeLoadCarrierId: 'lc-9' } }),
    )
    expect(keys(result.blocks)).toContain('ALREADY_COVERED')
  })

  it('refuses a negative carrier rate', () => {
    const result = evaluateCarrierBooking(input({ carrierRateCents: -1 }))
    expect(keys(result.blocks)).toContain('NEGATIVE_CARRIER_CHARGE')
  })

  it('honours the org list of bookable statuses', () => {
    const result = evaluateCarrierBooking(
      input({
        carrier: carrier({ status: 'REVIEW' }),
        settings: { allowedCarrierStatuses: ['ACTIVE', 'REVIEW'] },
      }),
    )
    expect(keys(result.blocks)).not.toContain('STATUS_NOT_ALLOWED')
  })
})

describe('evaluateCarrierBooking — insurance against the pickup', () => {
  it('refuses when the only cargo policy lapses before the pickup', () => {
    const result = evaluateCarrierBooking(
      input({
        carrier: carrier({
          insurancePolicies: [
            policy({ expiresAt: '2026-06-09T12:00:00.000Z' }),
            policy({ id: 'p2', type: 'AUTO_LIABILITY' }),
          ],
        }),
      }),
    )
    expect(keys(result.blocks)).toContain('INSURANCE_EXPIRED:CARGO')
    expect(keys(result.blocks)).not.toContain('INSURANCE_EXPIRED:AUTO_LIABILITY')
  })

  it('accepts a policy that expires exactly at the pickup instant', () => {
    const result = evaluateCarrierBooking(
      input({
        carrier: carrier({
          insurancePolicies: [
            policy({ expiresAt: PICKUP }),
            policy({ id: 'p2', type: 'AUTO_LIABILITY', expiresAt: PICKUP }),
          ],
        }),
      }),
    )
    expect(keys(result.blocks)).toEqual([])
  })

  it('judges insurance against the pickup, not against today', () => {
    const lapsesAfterToday = policy({ expiresAt: '2026-06-05T00:00:00.000Z' })
    const result = evaluateCarrierBooking(
      input({
        carrier: carrier({
          insurancePolicies: [lapsesAfterToday, policy({ id: 'p2', type: 'AUTO_LIABILITY' })],
        }),
      }),
    )
    expect(keys(result.blocks)).toContain('INSURANCE_EXPIRED:CARGO')
  })

  it('says each lapsed type once, however many certificates are on file', () => {
    const result = evaluateCarrierBooking(
      input({
        carrier: carrier({
          insurancePolicies: [
            policy({ id: 'a', expiresAt: '2026-01-01T00:00:00.000Z' }),
            policy({ id: 'b', expiresAt: '2026-02-01T00:00:00.000Z' }),
            policy({ id: 'c', type: 'AUTO_LIABILITY' }),
          ],
        }),
      }),
    )
    expect(keys(result.blocks).filter((k) => k === 'INSURANCE_EXPIRED:CARGO')).toHaveLength(1)
  })
})

describe('evaluateCarrierBooking — the three an admin may wave through', () => {
  const overValue = { ...input().load, cargoValueCents: 20_000_000 }

  it('blocks cargo value over the insurance limit for a non-admin', () => {
    const result = evaluateCarrierBooking(input({ load: overValue }))
    expect(keys(result.blocks)).toContain('CARGO_VALUE_EXCEEDS_INSURANCE')
    expect(keys(result.warnings)).not.toContain('CARGO_VALUE_EXCEEDS_INSURANCE')
  })

  it('warns an admin about cargo value over the insurance limit', () => {
    const result = evaluateCarrierBooking(input({ load: overValue, isAdmin: true }))
    expect(keys(result.blocks)).not.toContain('CARGO_VALUE_EXCEEDS_INSURANCE')
    const warning = result.warnings.find((f) => f.key === 'CARGO_VALUE_EXCEEDS_INSURANCE')
    expect(warning?.adminOnly).toBe(true)
  })

  it('blocks a carrier with no cargo insurance for a non-admin and warns an admin', () => {
    const noCargo = carrier({ insurancePolicies: [policy({ id: 'p2', type: 'AUTO_LIABILITY' })] })
    expect(keys(evaluateCarrierBooking(input({ carrier: noCargo })).blocks)).toContain(
      'INSURANCE_UNVERIFIED',
    )
    const asAdmin = evaluateCarrierBooking(input({ carrier: noCargo, isAdmin: true }))
    expect(keys(asAdmin.blocks)).not.toContain('INSURANCE_UNVERIFIED')
    expect(asAdmin.warnings.find((f) => f.key === 'INSURANCE_UNVERIFIED')?.adminOnly).toBe(true)
  })

  it('blocks a rate over top spend for a non-admin and warns an admin', () => {
    expect(keys(evaluateCarrierBooking(input({ carrierRateCents: 300_001 })).blocks)).toContain(
      'COST_EXCEEDS_TOP_SPEND',
    )
    const asAdmin = evaluateCarrierBooking(input({ carrierRateCents: 300_001, isAdmin: true }))
    expect(keys(asAdmin.blocks)).not.toContain('COST_EXCEEDS_TOP_SPEND')
    expect(asAdmin.warnings.find((f) => f.key === 'COST_EXCEEDS_TOP_SPEND')?.adminOnly).toBe(true)
  })

  it('lets a rate equal to top spend through', () => {
    const result = evaluateCarrierBooking(input({ carrierRateCents: 300_000 }))
    expect(keys(result.blocks)).not.toContain('COST_EXCEEDS_TOP_SPEND')
    expect(keys(result.warnings)).not.toContain('COST_EXCEEDS_TOP_SPEND')
  })
})

describe('evaluateCarrierBooking — advisory warnings', () => {
  it('warns about a policy expiring inside the window and not one outside it', () => {
    const inside = evaluateCarrierBooking(
      input({
        carrier: carrier({
          insurancePolicies: [
            policy({ expiresAt: '2026-06-20T00:00:00.000Z' }),
            policy({ id: 'p2', type: 'AUTO_LIABILITY' }),
          ],
        }),
      }),
    )
    expect(keys(inside.warnings)).toContain('INSURANCE_EXPIRING:CARGO')

    const outside = evaluateCarrierBooking(
      input({
        carrier: carrier({
          insurancePolicies: [
            policy({ expiresAt: '2026-08-20T00:00:00.000Z' }),
            policy({ id: 'p2', type: 'AUTO_LIABILITY' }),
          ],
        }),
      }),
    )
    expect(keys(outside.warnings)).toEqual([])
  })

  it('warns about a required document that is missing or expired', () => {
    const missing = evaluateCarrierBooking(
      input({ documents: [doc('COI_CARGO'), doc('COI_AUTO'), doc('W9')] }),
    )
    expect(keys(missing.warnings)).toEqual(['MISSING_DOC:CARRIER_AGREEMENT'])

    const expired = evaluateCarrierBooking(
      input({
        documents: [
          doc('COI_CARGO'),
          doc('COI_AUTO'),
          doc('W9'),
          doc('CARRIER_AGREEMENT', { expiresAt: '2026-01-01T00:00:00.000Z' }),
        ],
      }),
    )
    expect(keys(expired.warnings)).toEqual(['DOC_EXPIRED:CARRIER_AGREEMENT'])
  })

  it('warns per booking field the org asks for and the load does not have', () => {
    const result = evaluateCarrierBooking(
      input({
        load: { ...input().load, commodity: '   ', cargoValueCents: null },
        settings: { bookingRequiredFields: ['COMMODITY', 'VALUE', 'WEIGHT'] },
      }),
    )
    expect(keys(result.warnings)).toEqual([
      'MISSING_REQUIRED_FIELD:COMMODITY',
      'MISSING_REQUIRED_FIELD:VALUE',
    ])
  })

  it('warns when the carrier is already picking up elsewhere the same day', () => {
    const sameDay = evaluateCarrierBooking(
      input({
        otherActiveLoadCarriers: [{ loadId: 'load-2', pickupAppt: '2026-06-10T06:00:00.000Z' }],
      }),
    )
    expect(keys(sameDay.warnings)).toEqual(['DOUBLE_BOOKED:load-2'])

    const nextDay = evaluateCarrierBooking(
      input({
        otherActiveLoadCarriers: [{ loadId: 'load-2', pickupAppt: '2026-06-11T06:00:00.000Z' }],
      }),
    )
    expect(keys(nextDay.warnings)).toEqual([])
  })
})

describe('insuranceState', () => {
  it('reads a certificate against today and the warn window', () => {
    expect(insuranceState(policy({ expiresAt: null }), NOW, 30)).toBe('ACTIVE')
    expect(insuranceState(policy({ effectiveAt: '2026-07-01T00:00:00.000Z' }), NOW, 30)).toBe('UPCOMING')
    expect(insuranceState(policy({ expiresAt: '2026-05-31T00:00:00.000Z' }), NOW, 30)).toBe('EXPIRED')
    expect(insuranceState(policy({ expiresAt: '2026-06-20T00:00:00.000Z' }), NOW, 30)).toBe('EXPIRING')
    expect(insuranceState(policy({ expiresAt: '2026-08-20T00:00:00.000Z' }), NOW, 30)).toBe('ACTIVE')
  })

  it('counts the last day of the window as expiring', () => {
    expect(insuranceState(policy({ expiresAt: '2026-07-01T00:00:00.000Z' }), NOW, 30)).toBe('EXPIRING')
  })
})

describe('oosBps', () => {
  it('has no answer without inspections to divide by', () => {
    expect(oosBps(null, 3)).toBeNull()
    expect(oosBps(0, 0)).toBeNull()
  })

  it('reports the out-of-service share in basis points', () => {
    expect(oosBps(40, 3)).toBe(750)
    expect(oosBps(3, null)).toBe(0)
  })
})
