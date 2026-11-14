import { describe, expect, it } from 'vitest'
import { withInvoiceStatus } from './useBoardInvoiceStatus'
import type { ShipmentRow } from './shipmentViews'
import type { InvoiceRecord } from '@/types/tms'
import type { FactoringItem } from '@/types'

const row = (over: Partial<ShipmentRow>) => ({ id: 'r', status: 'DELIVERED', ...over }) as ShipmentRow

describe('withInvoiceStatus', () => {
  it('stamps released rows from the open invoice and OTR row, and leaves the rest alone', () => {
    const open = row({ id: 'a', status: 'OPEN' })
    const sent = row({ id: 'b', arStatus: 'UNPAID', invoiceId: 'i1' })
    const factored = row({ id: 'c', arStatus: 'UNPAID', invoiceId: 'i2', factoringItemId: 'f2' })
    const invoices = [
      { id: 'i1', status: 'PARTIAL', paidCents: 50_00, balanceCents: 50_00, sentAt: '2026-11-01' },
      { id: 'i2', status: 'ISSUED', paidCents: 0, balanceCents: 100_00 },
    ] as InvoiceRecord[]
    const items = [{ id: 'f2', status: 'PENDING_WITH_OTR', otrInvoiceId: 'o2' }] as FactoringItem[]
    const [a, b, c] = withInvoiceStatus([open, sent, factored], invoices, items)
    expect(a).toBe(open)
    expect(b.invoiceStatus?.key).toBe('PARTIAL')
    expect(c.invoiceStatus?.key).toBe('FACTORING_PENDING')
  })
})
