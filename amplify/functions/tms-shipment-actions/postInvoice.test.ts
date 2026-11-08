import { describe, expect, it } from 'vitest'
import {
  buildPostInvoiceEntry, cleanGuardedInput, diffSnapshots, isInvoicedOrder, postInvoiceCleared, readChangeReason, snapshotOf,
} from './postInvoice'

describe('isInvoicedOrder', () => {
  it.each([
    [{ arStatus: 'UNPAID' }, true],
    [{ arStatus: 'PAID' }, true],
    [{ arStatus: 'PARTIAL' }, true],
    [{ arStatus: 'DOCS_NEEDED', invoiceId: 'inv-1' }, true],
    [{ arStatus: 'DOCS_NEEDED', invoiceId: null }, false],
    [{ arStatus: 'UNBILLED' }, false],
    [null, false],
  ])('%j -> %s', (order, expected) => {
    expect(isInvoicedOrder(order)).toBe(expected)
  })
})

describe('reason gate input handling', () => {
  it('needs a trimmed reason of at least five characters', () => {
    expect(readChangeReason({}).ok).toBe(false)
    expect(readChangeReason({ changeReason: '  abc ' }).ok).toBe(false)
    expect(readChangeReason({ changeReason: '  typo fix ' })).toEqual({ ok: true, reason: 'typo fix' })
  })

  it('never lets the wire set the bypass flag, only the gate does', () => {
    const forged = { shipmentId: 's', postInvoiceChange: true, changeReason: 'x'.repeat(6) }
    expect(postInvoiceCleared(cleanGuardedInput(forged, false))).toBe(false)
    const cleared = cleanGuardedInput(forged, true)
    expect(postInvoiceCleared(cleared)).toBe(true)
    expect(cleared).not.toHaveProperty('changeReason')
  })
})

describe('diffSnapshots', () => {
  const base = {
    shipment: { id: 's1', status: 'OPEN', updatedAt: 'a', version: 1 },
    orders: [{ id: 'o1', revenueCents: 1000, internalNotes: 'a', invoiceId: 'inv-1', invoiceNumber: '20001' }],
    loads: [{ id: 'l1', miles: 500 }],
    charges: [{ id: 'c1', amountCents: 1000 }, { id: 'c2', amountCents: 50 }],
  }

  it('reports only what moved, ignoring stamps, and covers added/removed charge lines', () => {
    const after = {
      ...base,
      shipment: { ...base.shipment, updatedAt: 'b', version: 2 },
      orders: [{ ...base.orders[0]!, revenueCents: 1200 }],
      charges: [{ id: 'c1', amountCents: 1200 }, { id: 'c3', amountCents: 5 }],
    }
    const diff = diffSnapshots(snapshotOf(base), snapshotOf(after))
    expect(diff.before).toEqual({
      order: { revenueCents: 1000 },
      charges: { c1: { amountCents: 1000 }, c2: { id: 'c2', amountCents: 50 }, c3: null },
    })
    expect(diff.after).toEqual({
      order: { revenueCents: 1200 },
      charges: { c1: { amountCents: 1200 }, c2: null, c3: { id: 'c3', amountCents: 5 } },
    })
  })

  it('is empty when nothing moved, and the entry names the invoice, who and why', () => {
    const diff = diffSnapshots(snapshotOf(base), snapshotOf(base))
    expect(diff).toEqual({ before: {}, after: {} })
    const entry = buildPostInvoiceEntry({
      reason: 'because', sourceAction: 'UPDATE_STOP', diff, user: 'a@b.c', at: '2026-11-07T00:00:00.000Z',
      order: base.orders[0]!, shipmentId: 's1',
    })
    expect(entry).toMatchObject({ action: 'POST_INVOICE_CHANGE', invoiceId: 'inv-1', invoiceNumber: '20001', user: 'a@b.c', reason: 'because' })
  })
})
