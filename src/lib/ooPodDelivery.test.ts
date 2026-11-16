import { describe, expect, it } from 'vitest'
import { isOwnerOperatorLoad, ooPodStopOps } from './ooPodDelivery'
import { loadStatusFromStopTimes, shipmentStatusFromLoads } from './shipmentStatus'

const POD = '2026-11-12T16:30:00.000Z'

describe('isOwnerOperatorLoad', () => {
  it('reads the revenue subdivision or the driver fleet', () => {
    expect(isOwnerOperatorLoad({ revSubdivision: 'OWNER_OPERATOR' })).toBe(true)
    expect(isOwnerOperatorLoad({ driver: { fleetGroup: 'OWNER_OPERATOR' } })).toBe(true)
    expect(isOwnerOperatorLoad({ driver: { fleetGroup: 'AMAZON' } })).toBe(true)
  })
  it('leaves Ivan local and box truck loads alone', () => {
    expect(isOwnerOperatorLoad({ revSubdivision: 'LOCAL', driver: { fleetGroup: 'LOCAL' } })).toBe(false)
    expect(isOwnerOperatorLoad({ revSubdivision: 'BOX_TRUCK' })).toBe(false)
    expect(isOwnerOperatorLoad({})).toBe(false)
  })
})

describe('ooPodStopOps', () => {
  const stops = [
    { id: 'pu', type: 'pickup' as const, sequence: 0, appt: '2026-11-09T14:00:00.000Z' },
    { id: 'de', type: 'delivery' as const, sequence: 1, appt: '2026-11-11T16:30:00.000Z' },
  ]
  it('fills every blank time and the load reads Delivered', () => {
    const ops = ooPodStopOps(stops, POD)
    expect(ops).toEqual([
      { stopId: 'pu', patch: { arrivedAt: '2026-11-09T14:00:00.000Z', departedAt: '2026-11-09T14:00:00.000Z' } },
      { stopId: 'de', patch: { arrivedAt: POD, departedAt: POD } },
    ])
    const after = stops.map((s) => ({ ...s, ...ops.find((o) => o.stopId === s.id)!.patch }))
    expect(loadStatusFromStopTimes(after, 'BOOKED')).toBe('DELIVERED')
  })
  it('never overwrites a time already on the stop', () => {
    const ops = ooPodStopOps([{ ...stops[0], arrivedAt: '2026-11-09T20:53:00.000Z', departedAt: '2026-11-09T21:00:00.000Z' }, stops[1]], POD)
    expect(ops).toEqual([{ stopId: 'de', patch: { arrivedAt: POD, departedAt: POD } }])
  })
  it('uses the POD time for a pickup whose appointment is after it', () => {
    const ops = ooPodStopOps([{ ...stops[0], appt: '2026-11-20T14:00:00.000Z' }, stops[1]], POD)
    expect(ops[0].patch).toEqual({ arrivedAt: POD, departedAt: POD })
  })
  it('has nothing to do once every stop is stamped', () => {
    expect(ooPodStopOps(stops.map((s) => ({ ...s, arrivedAt: POD, departedAt: POD })), POD)).toEqual([])
  })
})

describe('shipmentStatusFromLoads: draft and tender give way to a moving truck', () => {
  it('a draft or pending tender whose load is delivered reads Delivered', () => {
    expect(shipmentStatusFromLoads([{ status: 'DELIVERED', carrierStatuses: ['ACTIVE'] }], 'DRAFT')).toBe('DELIVERED')
    expect(shipmentStatusFromLoads([{ status: 'DELIVERED', carrierStatuses: ['ACTIVE'] }], 'TENDER_PENDING')).toBe('DELIVERED')
    expect(shipmentStatusFromLoads([{ status: 'IN_TRANSIT', carrierStatuses: ['ACTIVE'] }], 'DRAFT')).toBe('IN_TRANSIT')
  })
  it('stays sticky while nothing is moving, and hold / cancel / rejected never give way', () => {
    expect(shipmentStatusFromLoads([{ status: 'BOOKED', carrierStatuses: ['ACTIVE'] }], 'DRAFT')).toBe('DRAFT')
    expect(shipmentStatusFromLoads([{ status: 'BOOKED' }, { status: 'DELIVERED' }], 'TENDER_PENDING')).toBe('TENDER_PENDING')
    expect(shipmentStatusFromLoads([{ status: 'DELIVERED' }], 'ON_HOLD')).toBe('ON_HOLD')
    expect(shipmentStatusFromLoads([{ status: 'DELIVERED' }], 'CANCELED')).toBe('CANCELED')
    expect(shipmentStatusFromLoads([{ status: 'DELIVERED' }], 'TENDER_REJECTED')).toBe('TENDER_REJECTED')
  })
})
