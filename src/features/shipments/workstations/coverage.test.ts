/**
 * Unit tests for the Dispatch workstation's pure coverage logic.
 */
import { describe, expect, it } from 'vitest'
import {
  carrierFlags,
  coverageStateOf,
  suggestCarriers,
  type LaneHistoryEntry,
} from './coverage'
import type { CarrierRecord, InsurancePolicy } from '@/types/tms'

function carrier(overrides: Partial<CarrierRecord> = {}): CarrierRecord {
  return {
    id: 'carrier-1',
    name: 'Test Carrier',
    type: 'TL',
    status: 'ACTIVE',
    mcNumber: '123456',
    dotNumber: '654321',
    authorityStatus: 'ACTIVE',
    safetyRating: 'SATISFACTORY',
    highwayStatus: 'PASS',
    rmisStatus: 'PASS',
    createdBy: 'test',
    updatedBy: 'test',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as CarrierRecord
}

function policy(type: InsurancePolicy['type'], expiresAt: string): InsurancePolicy {
  return {
    id: `${type}-${expiresAt}`,
    type,
    company: 'Acme Insurance',
    expiresAt,
  }
}

describe('coverageStateOf', () => {
  it('returns NEEDS_COVERAGE when there is no assignment', () => {
    expect(coverageStateOf({})).toBe('NEEDS_COVERAGE')
  })

  it('returns COVERED when a carrier is assigned but not signed or dispatched', () => {
    expect(
      coverageStateOf({ assignmentType: 'CARRIER', carrierId: 'c-1' }),
    ).toBe('COVERED')
  })

  it('returns RATE_CON_SIGNED when signed but not dispatched', () => {
    expect(
      coverageStateOf({
        assignmentType: 'CARRIER',
        carrierId: 'c-1',
        rateConSignedAt: '2026-10-28T12:00:00Z',
      }),
    ).toBe('RATE_CON_SIGNED')
  })

  it('returns DISPATCHED when dispatched', () => {
    expect(
      coverageStateOf({
        assignmentType: 'CARRIER',
        carrierId: 'c-1',
        dispatchedAt: '2026-10-28T08:00:00Z',
      }),
    ).toBe('DISPATCHED')
  })
})

describe('suggestCarriers', () => {
  const carriers: CarrierRecord[] = [
    carrier({ id: 'c-1', name: 'Frequent Freight' }),
    carrier({ id: 'c-2', name: 'Rare Runner' }),
  ]

  const history: LaneHistoryEntry[] = [
    {
      carrierId: 'c-1',
      originState: 'TX',
      destinationState: 'CA',
      rateCents: 150_000,
      bookedAt: '2026-10-20T12:00:00Z',
    },
    {
      carrierId: 'c-1',
      originState: 'TX',
      destinationState: 'CA',
      rateCents: 160_000,
      bookedAt: '2026-10-25T12:00:00Z',
    },
    {
      carrierId: 'c-2',
      originState: 'TX',
      destinationState: 'CA',
      rateCents: 140_000,
      bookedAt: '2026-10-24T12:00:00Z',
    },
  ]

  it('ranks a carrier with two prior loads above one with one', () => {
    const result = suggestCarriers({
      originState: 'TX',
      destinationState: 'CA',
      carriers,
      history,
    })

    expect(result).toHaveLength(2)
    expect(result[0].carrier.id).toBe('c-1')
    expect(result[0].loadsOnLane).toBe(2)
    expect(result[1].carrier.id).toBe('c-2')
    expect(result[1].loadsOnLane).toBe(1)
  })

  it('shows the last rate and last load date', () => {
    const result = suggestCarriers({
      originState: 'TX',
      destinationState: 'CA',
      carriers,
      history,
    })
    const first = result[0]
    expect(first.lastRateCents).toBe(160_000)
    expect(first.lastLoadAt).toBe('2026-10-25T12:00:00Z')
  })

  it('ignores carriers that did not run this lane', () => {
    const result = suggestCarriers({
      originState: 'FL',
      destinationState: 'NY',
      carriers,
      history,
    })
    expect(result).toHaveLength(0)
  })

  it('flags and demotes a carrier with expired insurance', () => {
    const expired = carrier({
      id: 'c-bad',
      name: 'Expired Insurance Co',
      insurancePolicies: [policy('CARGO', '2026-01-01T00:00:00Z'), policy('AUTO_LIABILITY', '2026-12-31T00:00:00Z')],
    })
    const result = suggestCarriers({
      originState: 'TX',
      destinationState: 'CA',
      carriers: [carriers[0], carriers[1], expired],
      history: [
        ...history,
        {
          carrierId: 'c-bad',
          originState: 'TX',
          destinationState: 'CA',
          rateCents: 100_000,
          bookedAt: '2026-10-26T12:00:00Z',
        },
      ],
      now: new Date('2026-10-29T12:00:00Z'),
    })

    const bad = result.find((r) => r.carrier.id === 'c-bad')
    expect(bad).toBeDefined()
    expect(bad!.flags.some((f) => f.includes('expired'))).toBe(true)
    expect(bad!.clean).toBe(false)

    const cleanIndex = result.findIndex((r) => r.clean)
    const badIndex = result.findIndex((r) => r.carrier.id === 'c-bad')
    expect(cleanIndex).toBeLessThan(badIndex)
  })

  it('marks a blocked / No-Buy carrier', () => {
    const blocked = carrier({
      id: 'c-blocked',
      name: 'Blocked Broker',
      status: 'DO_NOT_USE',
      statusReason: 'DOUBLE_BROKERING',
    })
    const flags = carrierFlags(blocked)
    expect(flags.some((f) => f.includes('No-buy'))).toBe(true)
  })
})
