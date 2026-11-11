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
