import { describe, expect, it } from 'vitest'
import type { Driver, Load } from '@/types'
import type { Equipment } from '@/types/equipment'
import { auditFleetRevenue, classifyOtherFleetLoad, type OtherFleetKind } from './revenueAudit'

const RANGE = { start: '2026-11-01', end: '2026-11-30' }
const TODAY = '2026-11-28'

const drivers = [
  { id: 'd-chad', name: 'Chad Salerno', phone: '', active: true, fleetGroup: 'OWNER_OPERATOR', assignedTruckId: 'truck-oo' },
  { id: 'd-mike', name: 'Michael Bodle', phone: '', active: true, fleetGroup: 'OWNER_OPERATOR', assignedTruckId: 'truck-oo2' },
  { id: 'd-local', name: 'John Brittich', phone: '', active: true, fleetGroup: 'LOCAL', assignedTruckId: 'truck-local' },
  { id: 'd-zak', name: 'Zak Pace', phone: '', active: true, fleetGroup: 'BOX_TRUCK', assignedTruckId: null },
] as unknown as Driver[]

const equipment = [
  { id: 'truck-oo', type: 'truck', unitNumber: '27', fleetGroup: 'OWNER_OPERATOR', active: true },
  { id: 'truck-local', type: 'truck', unitNumber: '4', fleetGroup: 'LOCAL', active: true },
  { id: 'truck-oo2', type: 'truck', unitNumber: '23', fleetGroup: 'OWNER_OPERATOR', active: true },
] as unknown as Equipment[]

function load(over: Partial<Load> & { id: string; aljexId: string }): Load {
  return {
    tmsId: '', pickupNumber: '', pickupAppt: '2026-11-20T15:00:00.000Z', deliveryAppt: '2026-11-22T15:00:00.000Z',
    pickupDriverId: null, deliveryDriverId: null, readyToInvoice: false, rate: 100000,
    originCity: 'A, IL', destinationCity: 'B, TX',
    ...over,
  } as Load
}

function kindOf(l: Load): OtherFleetKind {
  const audit = auditFleetRevenue({ loads: [l], drivers, equipment, range: RANGE, group: 'LOCAL', today: TODAY })
  const row = audit.buckets.otherFleet.rows[0]
  expect(row, `load ${l.aljexId} should land in the otherFleet bucket`).toBeDefined()
  return row.otherKind as OtherFleetKind
}

describe('classifyOtherFleetLoad: why a load is in "On another fleet / no driver"', () => {
  it('own-fleet loads nobody is driving need a fix (14638, 14842, 14843)', () => {
    expect(kindOf(load({ id: 'l1', aljexId: '14638', customer: 'Batory', assignmentType: 'OWN_ASSET', deliveryAppt: '2026-11-03T15:00:00.000Z' }))).toBe('needsFix')
    // Recent Aljex imports of Ivan Cartage's own loads: still flagged unless marked legacy-imported history.
    expect(kindOf(load({ id: 'l2', aljexId: '14842', customer: 'Whimsy', carrierName: 'Zak Pace', rate: 180000 }))).toBe('needsFix')
    expect(kindOf(load({ id: 'l3', aljexId: '14843', customer: 'Whimsy', assignmentType: 'OWN_ASSET', rate: 180000 }))).toBe('needsFix')
  })

  it('imported own-fleet history is exempt: no driver by design', () => {
    expect(kindOf(load({ id: 'l4', aljexId: '11111', assignmentType: 'OWN_ASSET', legacyImported: true }))).toBe('history')
    expect(kindOf(load({ id: 'l5', aljexId: '11112', legacyImported: true }))).toBe('history')
  })

  it('booked, uncovered and still ahead is "not covered yet" (20165)', () => {
    expect(kindOf(load({ id: 'l6', aljexId: '20165', assignmentType: 'NEED_TO_COVER', status: 'SOURCING', deliveryAppt: '2026-11-30T15:00:00.000Z', rate: 90000 }))).toBe('notCovered')
    expect(kindOf(load({ id: 'l7', aljexId: '20178', status: 'SOURCING', deliveryAppt: '2026-11-29T15:00:00.000Z' }))).toBe('notCovered')
  })

  it('uncovered with a delivery already behind us is a mistake, not a to-do', () => {
    expect(kindOf(load({ id: 'l8', aljexId: '20061', assignmentType: 'NEED_TO_COVER', status: 'SOURCING', deliveryAppt: '2026-11-10T15:00:00.000Z' }))).toBe('needsFix')
  })

  it('Auto Shipper loads get their own group, whether brokered or not (20003, 14458)', () => {
    expect(kindOf(load({ id: 'l9', aljexId: '20003', customer: 'AUTO SHIPPER', assignmentType: 'CARRIER', carrierName: 'Some Hauler' }))).toBe('autoShipper')
    expect(kindOf(load({ id: 'l10', aljexId: '14458', customer: ' auto  shipper ', deliveryAppt: '2026-11-05T15:00:00.000Z' }))).toBe('autoShipper')
  })

  it('outside-carrier loads are brokered (14662, 14900)', () => {
    expect(kindOf(load({ id: 'l11', aljexId: '14662', customer: 'The Royal Group', assignmentType: 'CARRIER', carrierName: 'EM CARGO LLC' }))).toBe('brokered')
    expect(kindOf(load({ id: 'l12', aljexId: '14900', carrierName: 'Navu Trans' }))).toBe('brokered')
    expect(kindOf(load({ id: 'l13', aljexId: '20016', activeLoadCarrierId: 'lc-1' }))).toBe('brokered')
    // Imported brokered history stays brokered, not "history".
    expect(kindOf(load({ id: 'l14', aljexId: '12000', carrierName: 'ROAD RUNNERS EXPRESS LLC', legacyImported: true }))).toBe('brokered')
  })

  it('owner-operator loads are "owner operators" (Chad 20132, Michael 20169)', () => {
    expect(kindOf(load({ id: 'l15', aljexId: '20132', deliveryDriverId: 'd-chad', truckId: 'truck-oo' }))).toBe('ownerOperator')
    expect(kindOf(load({ id: 'l16', aljexId: '20169', deliveryDriverId: 'd-mike' }))).toBe('ownerOperator')
  })

  it("a company driver of another fleet is not an owner operator (Local driver seen from Amazon)", () => {
    const l = load({ id: 'l18', aljexId: '20200', deliveryDriverId: 'd-local', truckId: 'truck-local' })
    const audit = auditFleetRevenue({ loads: [l], drivers, equipment, range: RANGE, group: 'AMAZON', today: TODAY })
    expect(audit.buckets.otherFleet.rows[0]?.otherKind).toBe('otherFleetDriver')
  })

  it('a carrier name that is really one of our drivers counts as own fleet', () => {
    const names = new Set(['ZAK PACE'])
    const l = load({ id: 'l17', aljexId: '14000', carrierName: 'Zak Pace' })
    expect(classifyOtherFleetLoad(l, { driverId: null, hasTruck: false, driverNames: names, today: TODAY })).toBe('needsFix')
    expect(classifyOtherFleetLoad({ ...l, legacyImported: true }, { driverId: null, hasTruck: false, driverNames: names, today: TODAY })).toBe('history')
  })
})

describe('auditFleetRevenue: the split only explains the bucket, it never moves money', () => {
  const loads = [
    load({ id: 'a', aljexId: '14638', assignmentType: 'OWN_ASSET', rate: 52500 }),
    load({ id: 'b', aljexId: '14662', carrierName: 'EM CARGO LLC', assignmentType: 'CARRIER', rate: 175000 }),
    load({ id: 'c', aljexId: '20132', deliveryDriverId: 'd-chad', truckId: 'truck-oo', rate: 365000 }),
    load({ id: 'd', aljexId: '20003', customer: 'AUTO SHIPPER', rate: 120000 }),
    load({ id: 'e', aljexId: '20165', assignmentType: 'NEED_TO_COVER', status: 'SOURCING', deliveryAppt: '2026-11-30T15:00:00.000Z', rate: 90000 }),
    load({ id: 'f', aljexId: '11111', assignmentType: 'OWN_ASSET', legacyImported: true, rate: 70000 }),
  ]
  const audit = auditFleetRevenue({ loads, drivers, equipment, range: RANGE, group: 'LOCAL', today: TODAY })

  it('the groups add up to the old otherFleet bucket (rows and dollars)', () => {
    const g = audit.otherFleetGroups
    const rows = Object.values(g).reduce((n, x) => n + x.rows.length, 0)
    const total = Object.values(g).reduce((n, x) => n + x.total, 0)
    expect(rows).toBe(audit.buckets.otherFleet.rows.length)
    expect(rows).toBe(6)
    expect(total).toBeCloseTo(audit.buckets.otherFleet.total, 2)
  })

  it('each load lands in exactly one group', () => {
    const g = audit.otherFleetGroups
    expect(g.needsFix.rows.map((r) => r.ref)).toEqual(['14638'])
    expect(g.brokered.rows.map((r) => r.ref)).toEqual(['14662'])
    expect(g.ownerOperator.rows.map((r) => r.ref)).toEqual(['20132'])
    expect(g.otherFleetDriver.rows).toEqual([])
    expect(g.autoShipper.rows.map((r) => r.ref)).toEqual(['20003'])
    expect(g.notCovered.rows.map((r) => r.ref)).toEqual(['20165'])
    expect(g.history.rows.map((r) => r.ref)).toEqual(['11111'])
  })

  it('does not change what counts toward revenue', () => {
    expect(audit.countedTotal).toBe(0)
  })
})

describe('loads with no delivery date', () => {
  it('are in no month: they list under "No delivery date" in the month they were picked up, and never count toward revenue', () => {
    const undated = load({ id: 'u1', aljexId: '14619', customer: 'AUTO SHIPPER', rate: 120900, deliveryAppt: '', pickupAppt: '2026-11-10T15:00:00.000Z' })
    const undatedOtherMonth = load({ id: 'u2', aljexId: '14364', rate: 790000, deliveryAppt: '', pickupAppt: '2026-09-10T15:00:00.000Z' })
    const dated = load({ id: 'd1', aljexId: '20001', rate: 50000, deliveryAppt: '2026-11-12T15:00:00.000Z', truckId: undefined })
    const audit = auditFleetRevenue({ loads: [undated, undatedOtherMonth, dated], drivers, equipment, range: RANGE, group: 'LOCAL', today: TODAY })
    expect(audit.buckets.noDeliveryDate.rows.map((r) => r.ref)).toEqual(['14619'])
    expect(audit.buckets.noDeliveryDate.total).toBeCloseTo(1209, 2)
    expect(audit.buckets.noDeliveryDate.rows[0]!.deliveryDate).toBe('')
    expect(audit.countedTotal).toBe(0)
    // Not in the other-fleet groups or the "delivered elsewhere" bucket either: one home each.
    expect(audit.buckets.otherFleet.rows.map((r) => r.ref)).toEqual(['20001'])
    expect(audit.buckets.outOfRange.rows).toEqual([])
  })
})
