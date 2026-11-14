import { describe, expect, it } from 'vitest'
import { isDeliveredNotReady } from './useDeliveredNotReady'

describe('isDeliveredNotReady', () => {
  it('counts delivered live shipments only', () => {
    expect(isDeliveredNotReady({ status: 'DELIVERED', deliveredAt: null, voidedAt: null, deletedAt: null } as never)).toBe(true)
    expect(isDeliveredNotReady({ status: 'IN_TRANSIT', deliveredAt: '2026-11-10T12:00:00Z', voidedAt: null, deletedAt: null } as never)).toBe(true)
    expect(isDeliveredNotReady({ status: 'IN_TRANSIT', deliveredAt: null, voidedAt: null, deletedAt: null } as never)).toBe(false)
    expect(isDeliveredNotReady({ status: 'DELIVERED', deliveredAt: null, voidedAt: '2026-11-10T12:00:00Z', deletedAt: null } as never)).toBe(false)
  })
})
