import { describe, it, expect } from 'vitest'
import { tripHoldReason, splitPayableTrips, PAY_HOLD_LABEL, type HoldableTrip } from './payHold'

const trip = (freightAmount: number, missing: Array<'POD' | 'Rate confirmation'> | null): HoldableTrip =>
  missing === null
    ? { freightAmount }
    : { freightAmount, readiness: { missingDocuments: missing } }

const KNOWN = { podsKnown: true }
const UNKNOWN = { podsKnown: false }

describe('tripHoldReason', () => {
  it('holds a delivered load with no POD', () => {
    expect(tripHoldReason(trip(1200, ['POD']), KNOWN)).toBe('NO_POD')
  })

  it('pays a load whose POD is on file', () => {
    expect(tripHoldReason(trip(1200, []), KNOWN)).toBeNull()
  })

  it('does not hold pay over a missing rate confirmation', () => {
    // A rate con blocks invoicing at OTR, but the driver did the work and the POD
    // proves it. Only the POD gates the cheque.
    expect(tripHoldReason(trip(1200, ['Rate confirmation']), KNOWN)).toBeNull()
  })

  it('pays everything when the POD store could not be read', () => {
    // JobsDone being down must never cost a week of drivers their pay.
    expect(tripHoldReason(trip(1200, ['POD']), UNKNOWN)).toBeNull()
  })

  it('pays a trip whose load could not be resolved at all', () => {
    // No readiness means nothing is known about documents. Unknown is not absent.
    expect(tripHoldReason(trip(1200, null), KNOWN)).toBeNull()
  })
})

describe('splitPayableTrips', () => {
  it('separates held from payable and totals the held freight', () => {
    const trips = [trip(1000, []), trip(500.5, ['POD']), trip(250.25, ['POD', 'Rate confirmation'])]

    const out = splitPayableTrips(trips, KNOWN)

    expect(out.payable).toHaveLength(1)
    expect(out.held.map((h) => h.reason)).toEqual(['NO_POD', 'NO_POD'])
    expect(out.heldFreight).toBe(750.75)
  })

  it('holds nothing when every POD is on file', () => {
    const out = splitPayableTrips([trip(1000, []), trip(2000, [])], KNOWN)
    expect(out.held).toEqual([])
    expect(out.heldFreight).toBe(0)
    expect(out.payable).toHaveLength(2)
  })

  it('holds nothing when the POD store is unreadable, however many PODs are missing', () => {
    const out = splitPayableTrips([trip(1000, ['POD']), trip(2000, ['POD'])], UNKNOWN)
    expect(out.held).toEqual([])
    expect(out.payable).toHaveLength(2)
  })

  it('rounds the held total to cents rather than carrying float noise', () => {
    const out = splitPayableTrips([trip(0.1, ['POD']), trip(0.2, ['POD'])], KNOWN)
    expect(out.heldFreight).toBe(0.3)
  })

  it('names the hold in words a settlement can print', () => {
    expect(PAY_HOLD_LABEL.NO_POD).toBe('POD required')
  })
})
