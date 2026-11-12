import { describe, expect, it } from 'vitest'
import { hasGap, isReleasedOrder, reconcileReleasedOrder } from './billingReconcile'

const released = { id: 'o1', arStatus: 'UNPAID', invoiceId: 'INV-1', readyToInvoiceAt: '2026-11-12T21:03:22Z' }

describe('billingReconcile', () => {
  it('only counts orders moved to billing through Load Review', () => {
    expect(isReleasedOrder(released)).toBe(true)
    expect(isReleasedOrder({ ...released, readyToInvoiceAt: null })).toBe(false)
    expect(isReleasedOrder({ ...released, arStatus: 'DOCS_NEEDED' })).toBe(false)
  })

  it('a released, invoiced order with its carrier billed has no gap', () => {
    expect(hasGap(reconcileReleasedOrder({ order: released, apToCreate: [], apUnbillable: [] }))).toBe(false)
  })

  it('an UNBILLED order is the Ready to invoice row, so AR is not missing', () => {
    const f = reconcileReleasedOrder({ order: { ...released, arStatus: 'UNBILLED', invoiceId: null }, apToCreate: [], apUnbillable: [] })
    expect(f.arMissing).toBe(false)
  })

  it('an invoiced order with no invoice is missing from AR', () => {
    const f = reconcileReleasedOrder({ order: { ...released, invoiceId: null }, apToCreate: [], apUnbillable: [] })
    expect(f).toMatchObject({ arMissing: true, arReason: 'Order is UNPAID but has no invoice' })
  })

  it('a carrier the plan would still bill is missing from AP; one it cannot bill is reported', () => {
    const f = reconcileReleasedOrder({
      order: released,
      apToCreate: [{ loadCarrierId: 'lc1', carrierName: 'SHERIFAJ', grossCents: 147_000 }],
      apUnbillable: [{ loadCarrierId: 'lc2', carrierName: 'X', reasons: ['No charge lines'] }],
    })
    expect(hasGap(f)).toBe(true)
    expect(f.apMissing).toHaveLength(1)
    expect(f.apUnbillable[0].reasons).toEqual(['No charge lines'])
  })
})
