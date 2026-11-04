import { describe, expect, it } from 'vitest'
import type { LoadCarrierRecord, ShipmentBundle, ShipmentDocumentRecord, ShipmentLoad, ShipmentRecord } from '@/types/tms'
import type { DriverPhones } from '@/lib/workPhone'
import { summaryOf } from './trackingSummary'

const NOW = Date.parse('2026-03-02T20:00:00.000Z')
const phones: DriverPhones = { truckId: 't1', truckNumber: '12', work: { number: '+13125550100', label: null }, personal: '+13125550199', personalRaw: '+13125550199' }

function bundleOf(over: { load?: Partial<ShipmentLoad>; leg?: Partial<LoadCarrierRecord>; shipment?: Partial<ShipmentRecord>; documents?: Partial<ShipmentDocumentRecord>[] } = {}): ShipmentBundle {
  return {
    shipment: { id: 'S1', ...over.shipment } as ShipmentRecord,
    orders: [], charges: [], financials: [],
    loads: [{ id: 'L1', shipmentId: 'S1', status: 'IN_TRANSIT', ...over.load } as ShipmentLoad],
    loadCarriers: [{ id: 'C1', loadId: 'L1', shipmentId: 'S1', kind: 'CARRIER', status: 'ACTIVE', carrierName: 'Acme', dispatcherName: 'Dee', ...over.leg } as LoadCarrierRecord],
    documents: (over.documents ?? []) as ShipmentDocumentRecord[],
  }
}
const run = (b: ShipmentBundle) => summaryOf({ bundle: b, phones, lastKnown: null, nowMs: NOW })

describe('summaryOf', () => {
  it('prefers the carrier-reported ETA over the appointment and flags lateness', () => {
    const s = run(bundleOf({ leg: { deliveryEtaAt: '2026-03-03T18:00:00.000Z' }, shipment: { deliveryAppt: '2026-03-03T15:00:00.000Z' } }))
    expect(s.eta).toEqual({ at: '2026-03-03T18:00:00.000Z', estimated: false, lateMinutes: 180 })
  })

  it('falls back to the delivery appointment when nothing better exists, and to null with none', () => {
    expect(run(bundleOf({ shipment: { deliveryAppt: '2026-03-03T15:00:00.000Z' } })).eta?.at).toBe('2026-03-03T15:00:00.000Z')
    expect(run(bundleOf()).eta).toBeNull()
  })

  it('grades the next check call: minutes until due, due now inside grace, overdue after', () => {
    expect(run(bundleOf({ load: { nextCheckCallAt: '2026-03-02T20:22:00.000Z' } })).nextCheck).toMatchObject({ state: 'SCHEDULED', minutes: 22 })
    expect(run(bundleOf({ load: { nextCheckCallAt: '2026-03-02T19:55:00.000Z' } })).nextCheck).toMatchObject({ state: 'DUE', minutes: 5 })
    expect(run(bundleOf({ load: { nextCheckCallAt: '2026-03-02T19:25:00.000Z' } })).nextCheck).toMatchObject({ state: 'OVERDUE', minutes: 35 })
    expect(run(bundleOf()).nextCheck).toEqual({ state: 'NONE', minutes: null, at: null })
  })

  it('reads the POD from documents once delivered, and says nothing before', () => {
    expect(run(bundleOf()).pod).toBeNull()
    const delivered = { load: { status: 'DELIVERED' as const } }
    expect(run(bundleOf(delivered)).pod).toBe('NEEDED')
    expect(run(bundleOf({ ...delivered, leg: { podRequestedAt: '2026-03-02T10:00:00.000Z' } })).pod).toBe('REQUESTED')
    expect(run(bundleOf({ ...delivered, documents: [{ type: 'POD', status: 'ACTIVE', reviewStatus: 'PENDING' }] })).pod).toBe('IN_REVIEW')
    expect(run(bundleOf({ ...delivered, documents: [{ type: 'POD', status: 'ACTIVE', reviewStatus: 'ACCEPTED' }] })).pod).toBe('RECEIVED')
    expect(run(bundleOf({ ...delivered, documents: [{ type: 'POD', status: 'ACTIVE', reviewStatus: 'REJECTED' }] })).pod).toBe('NEEDED')
  })

  it('names own fleet instead of a carrier contact', () => {
    const s = run(bundleOf({ leg: { kind: 'OWN_ASSET', driverName: 'John' } }))
    expect(s.carrier).toEqual({ label: 'Own fleet', contactName: null, phone: null, email: null })
    expect(s.driver).toEqual({ name: 'John', truckNumber: '12' })
  })

  it('reports the last known place and its age', () => {
    const s = run(bundleOf({ load: { lastKnownAt: '2026-03-02T19:46:00.000Z', lastKnownCity: 'Joliet', lastKnownState: 'IL' } }))
    expect(s.lastKnown).toMatchObject({ place: 'Joliet, IL', ageMinutes: 14 })
  })
})
