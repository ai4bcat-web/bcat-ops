import { describe, expect, it } from 'vitest'
import { deliveredTimeOf, lastDeliveryActual } from './deliveredAt'

const delivery = { type: 'delivery', arrivedAt: '2026-11-12T13:11:26.304Z', departedAt: '2026-11-12T13:11:30.808Z' }

describe('deliveredTimeOf', () => {
  it('prefers the shipment stamp', () => {
    expect(deliveredTimeOf({ deliveredAt: '2026-11-11T00:00:00Z', loadDeliveredAt: 'x', stops: [delivery] })).toBe('2026-11-11T00:00:00Z')
  })
  it('falls back to the loads stamp, then the last delivery actual', () => {
    expect(deliveredTimeOf({ deliveredAt: null, loadDeliveredAt: '2026-11-10T00:00:00Z' })).toBe('2026-11-10T00:00:00Z')
    expect(deliveredTimeOf({ deliveredAt: null, stops: [{ type: 'pickup', departedAt: '2026-11-13T00:00:00Z' }, delivery] })).toBe(delivery.departedAt)
  })
  it('uses arrival when no departure was recorded', () => {
    expect(lastDeliveryActual([{ type: 'Delivery', arrivedAt: '2026-11-12T10:00:00Z' }])).toBe('2026-11-12T10:00:00Z')
  })
  it('uses the status change only when the shipment is DELIVERED (20027)', () => {
    expect(deliveredTimeOf({ deliveredAt: null, status: 'DELIVERED', statusChangedAt: '2026-11-12T13:11:32.050Z' })).toBe('2026-11-12T13:11:32.050Z')
    expect(deliveredTimeOf({ deliveredAt: null, status: 'IN_TRANSIT', statusChangedAt: '2026-11-12T13:11:32.050Z' })).toBeNull()
    expect(deliveredTimeOf(null)).toBeNull()
  })
})
