import { describe, expect, it } from 'vitest'
import { isPodDeliveredLoad, podDeliveryGroup, ooPodStopOps } from './ooPodDelivery'
import { loadStatusFromStopTimes, shipmentStatusFromLoads } from './shipmentStatus'

const POD = '2026-11-12T16:30:00.000Z'

describe('isPodDeliveredLoad', () => {
  it('covers owner operators by subdivision or fleet', () => {
    expect(isPodDeliveredLoad({ revSubdivision: 'OWNER_OPERATOR' })).toBe(true)
    expect(isPodDeliveredLoad({ driver: { fleetGroup: 'OWNER_OPERATOR' } })).toBe(true)
    expect(isPodDeliveredLoad({ driver: { fleetGroup: 'AMAZON' } })).toBe(true)
  })
  it('covers Ivan local drivers and box trucks', () => {
    expect(isPodDeliveredLoad({ revSubdivision: 'LOCAL', driver: { fleetGroup: 'LOCAL' } })).toBe(true)
    expect(isPodDeliveredLoad({ driver: { fleetGroup: 'LOCAL', driverType: null } })).toBe(true)
    expect(isPodDeliveredLoad({ revSubdivision: 'BOX_TRUCK' })).toBe(true)
    expect(isPodDeliveredLoad({ driver: { fleetGroup: 'BOX_TRUCK', driverType: 'COMPANY' } })).toBe(true)
    expect(isPodDeliveredLoad({ driver: { driverType: 'COMPANY' } })).toBe(true)
  })
  it('leaves outside-carrier and unknown loads alone', () => {
    expect(isPodDeliveredLoad({})).toBe(false)
    expect(isPodDeliveredLoad({ revSubdivision: 'BROKERAGE' })).toBe(false)
    expect(isPodDeliveredLoad({ driver: {} })).toBe(false)
  })
  it('names the group for the audit note', () => {
    expect(podDeliveryGroup({ driver: { fleetGroup: 'OWNER_OPERATOR' } })).toBe('owner operator')
    expect(podDeliveryGroup({ driver: { fleetGroup: 'BOX_TRUCK' } })).toBe('box truck')
    expect(podDeliveryGroup({ driver: { fleetGroup: 'LOCAL' } })).toBe('local driver')
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
