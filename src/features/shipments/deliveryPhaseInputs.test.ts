import { describe, expect, it } from 'vitest'
import { phaseInputOfBundle } from './deliveryPhaseInputs'
import type { ShipmentBundle } from '@/types/tms'

const bundle = (order: Record<string, unknown>, shipment: Record<string, unknown> = {}): ShipmentBundle => ({
  shipment: { id: 's1', status: 'DELIVERED', deliveredAt: '2026-11-24T19:09:00Z', ...shipment },
  orders: [{ id: 'o1', ...order }], loads: [{ id: 'l1', stops: [] }], loadCarriers: [],
} as unknown as ShipmentBundle)

describe('phaseInputOfBundle billing', () => {
  it('delivered, not invoiced: no billing stage', () => {
    expect(phaseInputOfBundle(bundle({ arStatus: 'DOCS_NEEDED' }), 0).billing).toBeNull()
  })
  it('an invoiced order reads Invoiced (PRO 20158)', () => {
    expect(phaseInputOfBundle(bundle({ arStatus: 'UNPAID', invoiceId: 'inv1' }), 0).billing).toEqual({ stage: 'INVOICED', factored: false })
  })
  it('a factored invoice is marked factored', () => {
    expect(phaseInputOfBundle(bundle({ arStatus: 'UNPAID', invoiceId: 'inv1', factoringItemId: 'f1' }), 0).billing).toEqual({ stage: 'INVOICED', factored: true })
  })
  it('paid reads Paid; a voided invoice with delivery undone reads nothing', () => {
    expect(phaseInputOfBundle(bundle({ arStatus: 'PAID', invoiceId: 'inv1' }), 0).billing).toEqual({ stage: 'PAID' })
    expect(phaseInputOfBundle(bundle({ arStatus: 'DOCS_NEEDED', invoiceId: null }, { status: 'IN_TRANSIT', deliveredAt: null }), 0).billing).toBeNull()
  })
})
