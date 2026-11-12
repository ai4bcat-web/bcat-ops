import { describe, expect, it } from 'vitest'
import { deliveredText, deliveredTimeOf, reviewStatusText } from './reviewStatus'

const stop = (type: string, over: Record<string, unknown> = {}) => ({ id: type, type, appt: '2026-11-08T10:00:00Z', driverId: null, ...over })
const row = (over: Record<string, unknown> = {}) => ({ id: 's1', number: 'S1', status: 'DELIVERED', stops: [], ...over }) as never

describe('deliveredTimeOf', () => {
  it('prefers the shipment stamp, then the load stamp, then the last delivery stop actual', () => {
    expect(deliveredTimeOf(row({ deliveredAt: '2026-11-08T10:00:00Z', loadDeliveredAt: '2026-11-09T10:00:00Z' }))).toBe('2026-11-08T10:00:00Z')
    expect(deliveredTimeOf(row({ loadDeliveredAt: '2026-11-09T10:00:00Z' }))).toBe('2026-11-09T10:00:00Z')
    expect(deliveredTimeOf(row({ stops: [stop('pickup', { departedAt: '2026-11-05T10:00:00Z' }), stop('delivery', { arrivedAt: '2026-11-07T08:00:00Z', departedAt: '2026-11-07T09:00:00Z' }), stop('delivery', { arrivedAt: '2026-11-08T08:00:00Z' })] }))).toBe('2026-11-08T08:00:00Z')
  })
  it('ignores pickup stops and returns null with no evidence', () => {
    expect(deliveredTimeOf(row({ stops: [stop('pickup', { departedAt: '2026-11-05T10:00:00Z' })] }))).toBeNull()
  })
})

describe('deliveredText', () => {
  it('says so when the load is Delivered but nobody recorded when', () => {
    expect(deliveredText(row())).toBe('Delivered (no time recorded)')
  })
  it('stays a dash while the load is not delivered', () => {
    expect(deliveredText(row({ status: 'IN_TRANSIT' }))).toBe('—')
  })
})

describe('reviewStatusText', () => {
  it('prints the board status with stop progress', () => {
    const text = reviewStatusText(row({ stops: [stop('pickup', { departedAt: '2026-11-05T10:00:00Z' }), stop('delivery', { departedAt: '2026-11-07T10:00:00Z' })] }))
    expect(text).toBe('DELIVERED 2/2')
  })
})
