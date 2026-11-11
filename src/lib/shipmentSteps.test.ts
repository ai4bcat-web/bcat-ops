import { describe, expect, it } from 'vitest'
import { buildShipmentSteps, nextStepOf, type AuditStepRow } from './shipmentSteps'
import type { ShipmentBundle } from '../types/tms'

const staff = [{ id: 'dee@bcatcorp.com', email: 'dee@bcatcorp.com', name: 'Dee Park' }] as never

function bundle(over: { status?: string; carriers?: object[]; assignmentType?: string } = {}): ShipmentBundle {
  return {
    shipment: { id: 'shp-1', number: '20018', status: over.status ?? 'OPEN', createdBy: 'dee@bcatcorp.com', createdAt: '2026-11-10T10:00:00.000Z' },
    orders: [{ id: 'o1' }],
    loads: [{ id: 'l1', assignmentType: over.assignmentType ?? 'NEED_TO_COVER' }],
    loadCarriers: over.carriers ?? [],
  } as unknown as ShipmentBundle
}

const audit = (action: string, user: string, entityId: string, createdAt: string): AuditStepRow =>
  ({ entityType: 'LOAD_CARRIER', entityId, action, user, createdAt })

describe('buildShipmentSteps', () => {
  it('an open load: created is done, cover is the next step', () => {
    const steps = buildShipmentSteps(bundle(), [], staff)
    expect(steps.find((s) => s.key === 'created')).toMatchObject({ state: 'done', by: 'Dee Park' })
    const next = nextStepOf(steps)
    expect(next).toMatchObject({ key: 'covered', short: 'Cover it' })
    expect(next?.action).toMatch(/choose the carrier/i)
    expect(steps.filter((s) => s.state === 'next')).toHaveLength(1)
  })

  it('a covered carrier load shows the carrier and who covered it; the next step waits on carrier setup', () => {
    const lc = { id: 'lc1', status: 'ACTIVE', kind: 'CARRIER', carrierName: 'Acme Freight', createdBy: 'dee@bcatcorp.com', createdAt: '2026-11-10T11:00:00.000Z', assignmentStatus: 'ASSIGNED_SETUP_PENDING' }
    const steps = buildShipmentSteps(bundle({ carriers: [lc], assignmentType: 'CARRIER' }), [audit('COVER_CARRIER', 'dee@bcatcorp.com', 'lc1', '2026-11-10T11:05:00.000Z')], staff)
    expect(steps.find((s) => s.key === 'covered')).toMatchObject({ state: 'done', carrier: 'Acme Freight', by: 'Dee Park', at: '2026-11-10T11:05:00.000Z' })
    expect(nextStepOf(steps)).toMatchObject({ key: 'setup', waiting: expect.stringMatching(/MyCarrierPackets/) })
  })

  it('walks the rate confirmation: sent by a person, signed by the carrier, then driver info is next', () => {
    const lc = {
      id: 'lc1', status: 'ACTIVE', kind: 'CARRIER', carrierName: 'Acme Freight', createdBy: 'dee@bcatcorp.com', createdAt: '2026-11-10T11:00:00.000Z',
      assignmentStatus: 'RATE_CON_SIGNED', rateConSentAt: '2026-11-10T12:00:00.000Z', rateConSignedAt: '2026-11-10T13:00:00.000Z', rateConSignerName: 'Sam Carrier',
    }
    const steps = buildShipmentSteps(bundle({ carriers: [lc], assignmentType: 'CARRIER' }), [audit('SEND_RATE_CON', 'dee@bcatcorp.com', 'lc1', '2026-11-10T12:00:00.000Z')], staff)
    expect(steps.find((s) => s.key === 'rateConSent')).toMatchObject({ state: 'done', by: 'Dee Park' })
    expect(steps.find((s) => s.key === 'rateConSigned')).toMatchObject({ state: 'done', by: 'Sam Carrier' })
    expect(nextStepOf(steps)?.key).toBe('driverInfo')
  })

  it('an own-fleet load has no carrier setup or rate confirmation steps and names the driver', () => {
    const lc = { id: 'lc1', status: 'ACTIVE', kind: 'OWN_ASSET', driverName: 'Lee Lara', createdBy: 'dee@bcatcorp.com', createdAt: '2026-11-10T11:00:00.000Z' }
    const steps = buildShipmentSteps(bundle({ carriers: [lc], assignmentType: 'OWN_ASSET' }), [], staff)
    expect(steps.map((s) => s.key)).not.toContain('rateConSent')
    expect(steps.map((s) => s.key)).not.toContain('setup')
    expect(steps.find((s) => s.key === 'covered')).toMatchObject({ state: 'done', carrier: 'Ivan Cartage · Lee Lara', label: 'Covered by our own fleet' })
  })

  it('a removed assignment puts the load back at cover (uncovered)', () => {
    const removed = { id: 'lc1', status: 'REMOVED', kind: 'CARRIER', carrierName: 'Acme Freight' }
    const steps = buildShipmentSteps(bundle({ carriers: [removed] }), [], staff)
    expect(nextStepOf(steps)?.key).toBe('covered')
  })

  it('a voided shipment has no steps', () => {
    const b = bundle()
    ;(b.shipment as unknown as { voidedAt: string }).voidedAt = '2026-11-10T12:00:00.000Z'
    ;(b.shipment as unknown as { status: string }).status = 'VOIDED'
    expect(buildShipmentSteps(b, [], staff)).toEqual([])
  })

  it('no bundle (create mode): no steps', () => {
    expect(buildShipmentSteps(null, [], staff)).toEqual([])
  })
})

describe('ASSETS loads (Ryne 2026-11-11)', () => {
  const stop = (type: string, over: object = {}) => ({ id: `${type}1`, type, ...over })
  function assetBundle(over: { status?: string; driver?: object; stops?: object[]; lastKnown?: object } = {}): ShipmentBundle {
    const lc = { id: 'lc1', status: 'ACTIVE', kind: 'OWN_ASSET', driverId: 'd1', driverName: 'Lee Lara', truckNumber: '118', createdBy: 'dee@bcatcorp.com', createdAt: '2026-11-10T11:00:00.000Z', ...over.driver }
    return {
      shipment: { id: 'shp-1', number: '20009', status: over.status ?? 'IN_TRANSIT', revDivision: 'ASSETS', createdBy: 'dee@bcatcorp.com', createdAt: '2026-11-10T10:00:00.000Z', deliveredAt: over.status === 'DELIVERED' ? '2026-11-10T20:00:00.000Z' : null },
      orders: [{ id: 'o1' }],
      loads: [{ id: 'l1', assignmentType: 'OWN_ASSET', status: over.status ?? 'IN_TRANSIT', stops: over.stops ?? [stop('pickup'), stop('delivery')], ...over.lastKnown }],
      loadCarriers: [lc],
    } as unknown as ShipmentBundle
  }
  const keys = (b: ShipmentBundle, extras = {}) => buildShipmentSteps(b, [], staff, extras).map((s) => s.key)

  it('a local driver shows the driver-app steps, not carrier setup or rate confirmation', () => {
    expect(keys(assetBundle(), { driverType: 'COMPANY' })).toEqual(['created', 'assetAssigned', 'assetStarted', 'assetArrivedPickup', 'assetLeftPickup', 'assetArrivedDelivery', 'delivered', 'loadReview', 'billed', 'paid'])
  })

  it('an owner operator shows the Motive location step instead of the driver-app dispatch', () => {
    const k = keys(assetBundle(), { driverType: 'OWNER_OPERATOR' })
    expect(k).toContain('assetLocated')
    expect(k).not.toContain('assetStarted')
  })

  it('only recorded stop clocks are done; the next step is the next driver status, never "Cover it"', () => {
    const b = assetBundle({ status: 'LOADING', driver: { dispatchedAt: '2026-11-10T12:00:00.000Z' }, stops: [stop('pickup', { arrivedAt: '2026-11-10T13:41:00.000Z' }), stop('delivery')] })
    const steps = buildShipmentSteps(b, [], staff, { driverType: 'COMPANY' })
    expect(steps.find((s) => s.key === 'assetArrivedPickup')).toMatchObject({ state: 'done', at: '2026-11-10T13:41:00.000Z', carrier: 'Lee Lara' })
    expect(steps.find((s) => s.key === 'assetLeftPickup')?.state).not.toBe('done')
    expect(nextStepOf(steps)).toMatchObject({ key: 'assetLeftPickup' })
  })

  it('names who tapped a driver-app update from its check call', () => {
    const b = assetBundle({ stops: [stop('pickup', { arrivedAt: '2026-11-10T13:41:00.000Z' }), stop('delivery')] })
    const calls = [{ stopId: 'pickup1', type: 'ARRIVED', source: 'DRIVER_APP', at: '2026-11-10T13:41:00.000Z', createdBy: 'driver:d1', personName: 'Lee Lara' }] as never
    expect(buildShipmentSteps(b, [], staff, { driverType: 'COMPANY', checkCalls: calls }).find((s) => s.key === 'assetArrivedPickup')?.by).toBe('Lee Lara')
  })

  it('an owner operator is located only when the last fix came from Motive', () => {
    const motive = assetBundle({ lastKnown: { lastKnownSource: 'MOTIVE', lastKnownAt: '2026-11-10T14:00:00.000Z' } })
    expect(buildShipmentSteps(motive, [], staff, { driverType: 'OWNER_OPERATOR' }).find((s) => s.key === 'assetLocated')).toMatchObject({ state: 'done', by: 'Motive', at: '2026-11-10T14:00:00.000Z' })
    const none = assetBundle()
    expect(buildShipmentSteps(none, [], staff, { driverType: 'OWNER_OPERATOR' }).find((s) => s.key === 'assetLocated')?.state).not.toBe('done')
  })

  it('a DELIVERED asset load shows every earlier step as done, with nothing recorded, and no next chip before billing', () => {
    const b = assetBundle({ status: 'DELIVERED' })
    const steps = buildShipmentSteps(b, [], staff, { driverType: 'COMPANY' })
    for (const key of ['created', 'assetAssigned', 'assetStarted', 'assetArrivedPickup', 'assetLeftPickup', 'assetArrivedDelivery', 'delivered']) {
      expect(steps.find((s) => s.key === key)?.state, key).toBe('done')
    }
    expect(steps.find((s) => s.key === 'assetArrivedPickup')).toMatchObject({ at: null, by: null })
    expect(nextStepOf(steps)?.key).toBe('loadReview')
    expect(steps.some((s) => s.short === 'Cover it')).toBe(false)
  })

  it('a delivered asset load with no assignment recorded still shows the driver step done', () => {
    const b = assetBundle({ status: 'DELIVERED' })
    ;(b as unknown as { loadCarriers: unknown[] }).loadCarriers = []
    expect(buildShipmentSteps(b, [], staff).find((s) => s.key === 'assetAssigned')?.state).toBe('done')
  })

  it('a saved configuration picks, orders and renames the steps; a rename shows, a default name keeps the dynamic wording', () => {
    const config = { ASSETS: { LOCAL_DRIVER: [
      { key: 'created', label: 'Created', enabled: true }, { key: 'assetArrivedDelivery', label: 'At the dock', enabled: true },
      { key: 'assetArrivedPickup', label: 'Arrived at pickup', enabled: false }, { key: 'delivered', label: 'Delivered', enabled: true },
    ] } }
    const steps = buildShipmentSteps(assetBundle(), [], staff, { driverType: 'COMPANY', config })
    expect(steps.map((s) => [s.key, s.label])).toEqual([['created', 'Created'], ['assetArrivedDelivery', 'At the dock'], ['delivered', 'Delivered']])
  })

  it('a delivered non-asset load with nobody recorded shows its steps before delivery as done', () => {
    const b = bundle({ status: 'DELIVERED' })
    ;(b.shipment as unknown as { deliveredAt: string }).deliveredAt = '2026-11-10T20:00:00.000Z'
    const steps = buildShipmentSteps(b, [], staff)
    expect(steps.find((s) => s.key === 'covered')?.state).toBe('done')
    expect(steps.find((s) => s.key === 'dispatched')?.state).toBe('done')
  })
})
