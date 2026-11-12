import { describe, expect, it } from 'vitest'
import { matchesFlag, pastDeliveryOf } from './boardChips'
import type { ShipmentRow } from './shipmentViews'

// Noon Chicago on Nov 12, 2026.
const NOW = Date.parse('2026-11-12T18:00:00Z')
const row = (over: Partial<ShipmentRow>): ShipmentRow => ({ status: 'IN_TRANSIT', ...over }) as ShipmentRow

describe('pastDeliveryOf', () => {
  it('flags a live load whose delivery day is before today, with days late', () => {
    const r = pastDeliveryOf(row({ deliveryAppt: '2026-11-10T14:00:00Z' }), NOW)
    expect(r).toMatchObject({ day: '2026-11-10', daysLate: 2 })
    expect(r?.tooltip).toBe('Scheduled delivery Nov 10, 2026 — not marked delivered (2 days)')
  })

  it('does not flag a load due earlier today (day-level)', () => {
    expect(pastDeliveryOf(row({ deliveryAppt: '2026-11-12T14:00:00Z' }), NOW)).toBeNull()
  })

  it('treats a date-only appointment (Chicago midnight) as its whole day', () => {
    // Nov 11 00:00 Chicago = 06:00Z
    expect(pastDeliveryOf(row({ deliveryAppt: '2026-11-11T06:00:00Z' }), NOW)?.daysLate).toBe(1)
  })

  it('uses the end of a delivery window', () => {
    expect(pastDeliveryOf(row({ deliveryAppt: '2026-11-10T14:00:00Z', deliveryApptEnd: '2026-11-12T20:00:00Z' }), NOW)).toBeNull()
  })

  it('never flags delivered, voided, canceled, draft or unscheduled shipments', () => {
    const past = '2026-11-01T14:00:00Z'
    expect(pastDeliveryOf(row({ status: 'DELIVERED', deliveryAppt: past }), NOW)).toBeNull()
    expect(pastDeliveryOf(row({ voidedAt: '2026-11-02T00:00:00Z', deliveryAppt: past }), NOW)).toBeNull()
    expect(pastDeliveryOf(row({ status: 'CANCELED', deliveryAppt: past }), NOW)).toBeNull()
    expect(pastDeliveryOf(row({ status: 'DRAFT', deliveryAppt: past }), NOW)).toBeNull()
    expect(pastDeliveryOf(row({ deliveryAppt: null }), NOW)).toBeNull()
  })

  it('backs the pastDeliveryDate board flag', () => {
    expect(matchesFlag(row({ status: 'OPEN', deliveryAppt: '2026-11-05T14:00:00Z' }), 'pastDeliveryDate', NOW)).toBe(true)
    expect(matchesFlag(row({ status: 'DELIVERED', deliveryAppt: '2026-11-05T14:00:00Z' }), 'pastDeliveryDate', NOW)).toBe(false)
  })
})
