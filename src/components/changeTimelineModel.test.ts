import { describe, expect, it } from 'vitest'
import type { AuditLogEntry } from '@/types'
import { timelineEvents } from './changeTimelineModel'

const row = (id: string, entityType: string, action: string, createdAt: string, changes: unknown, user = 'dee@example.com'): AuditLogEntry =>
  ({ id, entityType, entityId: `${entityType}-1`, action, user, createdAt, changes }) as unknown as AuditLogEntry

describe('timelineEvents', () => {
  const change = { action: 'POST_INVOICE_CHANGE', reason: 'Rate corrected', sourceAction: 'RECALC_CHARGES', at: '2026-11-08T12:00:00.000Z',
    before: { order: { revenueCents: 1000 } }, after: { order: { revenueCents: 1200 } } }

  it('orders release, change, send and payment oldest first and folds the three copies of one change', () => {
    const events = timelineEvents([
      row('p', 'ArPayment', 'RECORD_PAYMENT', '2026-11-10T00:00:00.000Z', {}),
      row('c1', 'SHIPMENT', 'POST_INVOICE_CHANGE', '2026-11-08T12:00:00.100Z', change),
      row('c2', 'ORDER', 'POST_INVOICE_CHANGE', '2026-11-08T12:00:00.200Z', change),
      row('c3', 'Invoice', 'POST_INVOICE_CHANGE', '2026-11-08T12:00:00.300Z', change),
      row('s', 'Invoice', 'EMAIL_INVOICE', '2026-11-09T00:00:00.000Z', {}),
      row('r', 'Invoice', 'RELEASE_TO_BILLING', '2026-11-07T09:00:00.000Z', {}),
      row('x', 'SHIPMENT', 'SET_SALES_REP', '2026-11-07T10:00:00.000Z', {}),
    ])
    expect(events.map((e) => e.title)).toEqual([
      'Released to billing',
      'Changed after invoicing (RECALC_CHARGES)',
      'Invoice e-mailed',
      'Payment recorded',
    ])
    expect(events[1]).toMatchObject({ reason: 'Rate corrected', user: 'dee@example.com' })
    expect(events[1]!.details).toEqual(['order.revenueCents: 1000 → 1200'])
  })

  it('reads the flat before/after the factoring sync writes', () => {
    const [event] = timelineEvents([
      row('f', 'FactoringItem', 'POST_INVOICE_CHANGE', '2026-11-08T00:00:00.000Z',
        { reason: 'Amount fix', before: { invoiceAmountCents: 100 }, after: { invoiceAmountCents: 150 }, at: '2026-11-08T00:00:00.000Z' }),
    ])
    expect(event!.details).toEqual(['invoiceAmountCents: 100 → 150'])
  })
})
