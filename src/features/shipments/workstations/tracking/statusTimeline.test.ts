import { describe, expect, it } from 'vitest'
import type { LoadCarrierRecord, ShipmentBundle, ShipmentLoad } from '@/types/tms'
import { buildStatusTimeline, isFreshPing, lateMinutes } from './statusTimeline'

const stops = [
  { id: 'pu', type: 'pickup', sequence: 0, appt: '2026-10-29T14:00:00Z', driverId: null },
  { id: 'de', type: 'delivery', sequence: 1, appt: '2026-10-30T10:00:00Z', driverId: null },
] as ShipmentLoad['stops']

function bundleOf(load: Partial<ShipmentLoad>, leg: Partial<LoadCarrierRecord> | null, deliveryArrivedAt?: string): ShipmentBundle {
  const ld = {
    id: 'l1', shipmentId: 's1', status: 'BOOKED',
    stops: stops!.map((s) => (s.type === 'delivery' && deliveryArrivedAt ? { ...s, arrivedAt: deliveryArrivedAt } : s)),
    ...load,
  } as ShipmentLoad
  return {
    shipment: { id: 's1' }, orders: [], loads: [ld], charges: [], financials: [],
    loadCarriers: leg ? [{ id: 'c1', loadId: 'l1', shipmentId: 's1', status: 'ACTIVE', kind: 'CARRIER', ...leg } as LoadCarrierRecord] : [],
  } as unknown as ShipmentBundle
}

const states = (items: ReturnType<typeof buildStatusTimeline>) => items.map((i) => `${i.id}:${i.state}`)
const nowMs = Date.parse('2026-10-29T12:00:00Z')

describe('buildStatusTimeline', () => {
  it('scheduled only: Scheduled done, Confirmed is the current step', () => {
    const items = buildStatusTimeline({ row: { loadStatus: 'BOOKED' }, bundle: bundleOf({}, null), nowMs })
    expect(states(items)).toEqual(['scheduled:done', 'confirmed:current', 'on-route:upcoming', 'arrived:upcoming', 'delivered:upcoming'])
  })

  it('booked carrier with a SENT rate con is Confirmed, with the sent time', () => {
    const items = buildStatusTimeline({
      row: { loadStatus: 'BOOKED' },
      bundle: bundleOf({}, { rateConStatus: 'SENT', rateConSentAt: '2026-10-28T09:00:00Z' }),
      nowMs,
    })
    expect(states(items)[1]).toBe('confirmed:done')
    expect(items[1].at).toBeTruthy()
    expect(states(items)[2]).toBe('on-route:current')
  })

  it('a rate con that was never sent does not confirm a carrier leg', () => {
    const items = buildStatusTimeline({ row: { loadStatus: 'BOOKED' }, bundle: bundleOf({}, { rateConStatus: 'NOT_SENT' }), nowMs })
    expect(states(items)[1]).toBe('confirmed:current')
  })

  it('DEPARTED movement puts the load On route and implies Confirmed', () => {
    const items = buildStatusTimeline({ row: { loadStatus: 'IN_TRANSIT' }, bundle: bundleOf({}, null), nowMs })
    expect(states(items)).toEqual(['scheduled:done', 'confirmed:done', 'on-route:done', 'arrived:current', 'delivered:upcoming'])
  })

  it('delivered completes every step with no current step', () => {
    const items = buildStatusTimeline({
      row: { loadStatus: 'DELIVERED', deliveredAt: '2026-10-30T09:00:00Z' },
      bundle: bundleOf({}, null),
      nowMs,
    })
    expect(items.every((i) => i.state === 'done')).toBe(true)
    expect(items[4].at).toBeTruthy()
  })

  it('shows no time for a step with no stored timestamp', () => {
    const items = buildStatusTimeline({ row: { loadStatus: 'IN_TRANSIT' }, bundle: bundleOf({}, { rateConStatus: 'SIGNED' }), nowMs })
    expect(items[2].at).toBeUndefined()
    expect(items[3].at).toBeUndefined()
  })

  it('late pill only when the ETA is at least 15 minutes past the delivery appointment', () => {
    const base = { row: { loadStatus: 'IN_TRANSIT' as const }, bundle: bundleOf({}, null), nowMs }
    expect(buildStatusTimeline({ ...base, eta: { etaAt: '2026-10-30T10:14:00Z' } })[2].tag).toBeUndefined()
    expect(buildStatusTimeline({ ...base, eta: { etaAt: '2026-10-30T10:15:00Z' } })[2].tag).toBe('15 min late')
  })
})

describe('lateMinutes / isFreshPing', () => {
  it('ignores a missing appointment or ETA', () => {
    expect(lateMinutes(null, '2026-10-30T10:30:00Z')).toBeNull()
    expect(lateMinutes('2026-10-30T10:00:00Z', undefined)).toBeNull()
  })

  it('treats a ping under 30 minutes old as fresh and a future or old ping as not', () => {
    expect(isFreshPing('2026-10-29T11:45:00Z', nowMs)).toBe(true)
    expect(isFreshPing('2026-10-29T11:20:00Z', nowMs)).toBe(false)
    expect(isFreshPing('2026-10-29T12:30:00Z', nowMs)).toBe(false)
    expect(isFreshPing(null, nowMs)).toBe(false)
  })
})
