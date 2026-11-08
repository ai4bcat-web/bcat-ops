import { describe, it, expect } from 'vitest'
import {
  CARRIER_DO_NOT_USE_REASONS,
  CARRIER_INACTIVE_REASONS,
  canTransitionCarrierStatus,
  carrierStatusReasonRequired,
  carrierStatusReasonsFor,
  effectiveCarrierStatus,
  nextCarrierStatuses,
} from './carrierStatus'
import type { CarrierRecord, CarrierStatus, InsurancePolicy } from '../types/tms'

const policy = (over: Partial<InsurancePolicy> = {}): InsurancePolicy => ({
  id: 'p1',
  type: 'CARGO',
  expiresAt: '2027-01-01T00:00:00.000Z',
  ...over,
})

const carrier = (
  over: Partial<Pick<CarrierRecord, 'status' | 'statusReason' | 'insurancePolicies'>> = {},
): Pick<CarrierRecord, 'status' | 'statusReason' | 'insurancePolicies'> => ({
  status: 'ACTIVE',
  statusReason: null,
  insurancePolicies: [policy()],
  ...over,
})

const NOW = '2026-06-01T00:00:00.000Z'

describe('nextCarrierStatuses', () => {
  it('treats a carrier with no status yet as pending', () => {
    expect(nextCarrierStatuses(null, false)).toEqual(['REVIEW', 'ACTIVE', 'INACTIVE', 'DO_NOT_USE'])
    expect(nextCarrierStatuses(undefined, false)).toEqual(nextCarrierStatuses('PENDING', false))
  })

  it('never offers a status as a move to itself', () => {
    for (const status of ['PENDING', 'REVIEW', 'ACTIVE', 'INACTIVE', 'DO_NOT_USE'] as CarrierStatus[]) {
      expect(nextCarrierStatuses(status, true)).not.toContain(status)
    }
  })
})

describe('canTransitionCarrierStatus', () => {
  const legal: [CarrierStatus, CarrierStatus][] = [
    ['PENDING', 'REVIEW'],
    ['PENDING', 'ACTIVE'],
    ['PENDING', 'INACTIVE'],
    ['PENDING', 'DO_NOT_USE'],
    ['REVIEW', 'ACTIVE'],
    ['REVIEW', 'INACTIVE'],
    ['REVIEW', 'DO_NOT_USE'],
    ['ACTIVE', 'INACTIVE'],
    ['ACTIVE', 'DO_NOT_USE'],
    ['INACTIVE', 'ACTIVE'],
    ['INACTIVE', 'DO_NOT_USE'],
  ]

  it.each(legal)('allows %s -> %s for anyone', (from, to) => {
    expect(canTransitionCarrierStatus(from, to, false)).toBe(true)
  })

  it('refuses to walk an active carrier back to review', () => {
    expect(canTransitionCarrierStatus('ACTIVE', 'REVIEW', true)).toBe(false)
  })

  it('lets only an admin bring a do-not-use carrier back, and only to inactive', () => {
    expect(canTransitionCarrierStatus('DO_NOT_USE', 'INACTIVE', true)).toBe(true)
    expect(canTransitionCarrierStatus('DO_NOT_USE', 'INACTIVE', false)).toBe(false)
    expect(nextCarrierStatuses('DO_NOT_USE', false)).toEqual([])
    expect(canTransitionCarrierStatus('DO_NOT_USE', 'ACTIVE', true)).toBe(false)
  })
})

describe('carrier status reasons', () => {
  it('asks for a reason only when the carrier is being switched off', () => {
    expect(carrierStatusReasonRequired('INACTIVE')).toBe(true)
    expect(carrierStatusReasonRequired('DO_NOT_USE')).toBe(true)
    expect(carrierStatusReasonRequired('ACTIVE')).toBe(false)
    expect(carrierStatusReasonRequired('REVIEW')).toBe(false)
    expect(carrierStatusReasonRequired('PENDING')).toBe(false)
  })

  it('offers operational reasons for inactive and trust reasons for do not use', () => {
    expect(carrierStatusReasonsFor('INACTIVE')).toEqual(CARRIER_INACTIVE_REASONS)
    expect(carrierStatusReasonsFor('DO_NOT_USE')).toEqual(CARRIER_DO_NOT_USE_REASONS)
    expect(carrierStatusReasonsFor('INACTIVE')).not.toContain('THEFT')
    expect(carrierStatusReasonsFor('DO_NOT_USE')).not.toContain('EXPIRED_INSURANCE')
    expect(carrierStatusReasonsFor('ACTIVE')).toEqual([])
  })
})

describe('effectiveCarrierStatus', () => {
  it('demotes an active carrier whose every cargo policy has lapsed', () => {
    const result = effectiveCarrierStatus(
      carrier({
        insurancePolicies: [
          policy({ id: 'a', expiresAt: '2026-01-01T00:00:00.000Z' }),
          policy({ id: 'b', expiresAt: '2026-05-31T23:59:59.000Z' }),
        ],
      }),
      NOW,
    )
    expect(result).toEqual({ status: 'INACTIVE', reason: 'EXPIRED_INSURANCE', derived: true })
  })

  it('leaves the carrier alone while one cargo policy is still good', () => {
    const result = effectiveCarrierStatus(
      carrier({
        insurancePolicies: [
          policy({ id: 'a', expiresAt: '2026-01-01T00:00:00.000Z' }),
          policy({ id: 'b', expiresAt: '2026-12-01T00:00:00.000Z' }),
        ],
      }),
      NOW,
    )
    expect(result).toEqual({ status: 'ACTIVE', reason: null, derived: false })
  })

  it('does not demote a carrier that has no cargo policy at all', () => {
    const result = effectiveCarrierStatus(
      carrier({
        insurancePolicies: [
          policy({ id: 'a', type: 'AUTO_LIABILITY', expiresAt: '2026-01-01T00:00:00.000Z' }),
        ],
      }),
      NOW,
    )
    expect(result).toEqual({ status: 'ACTIVE', reason: null, derived: false })
  })

  it('reports a stored status untouched, reason and all', () => {
    const result = effectiveCarrierStatus(
      carrier({ status: 'DO_NOT_USE', statusReason: 'THEFT', insurancePolicies: [] }),
      NOW,
    )
    expect(result).toEqual({ status: 'DO_NOT_USE', reason: 'THEFT', derived: false })
  })
})
