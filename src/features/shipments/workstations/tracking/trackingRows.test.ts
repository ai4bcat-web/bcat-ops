import { describe, expect, it } from 'vitest'
import type { ShipmentRow } from '../../shipmentViews'
import { lifecycleRows } from './trackingTable'

function row(id: string, patch: Partial<ShipmentRow> = {}): ShipmentRow {
  return {
    id,
    number: id,
    status: 'DISPATCHED',
    customerId: 'cust-1',
    customerName: 'Acme Freight',
    mode: 'FTL',
    source: 'MANUAL',
    rateConStatus: 'SENT',
    createdBy: 'rep@bcatcorp.com',
    updatedBy: 'rep@bcatcorp.com',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...patch,
  }
}

// Everything the table could hold: the open work, delivered loads in each POD state, and the history
// (canceled, voided, POD received) that the working set never loads.
const open = [
  row('IN-TRANSIT', { status: 'IN_TRANSIT' }),
  row('BOOKED-UNSENT', { status: 'BOOKED', rateConStatus: 'NOT_SENT' }),
  row('SIGNED', { status: 'DISPATCHED', rateConStatus: 'SIGNED' }),
  row('DELIVERED-POD-DUE', { status: 'DELIVERED', docsMissing: ['POD'] }),
  row('DELIVERED-POD-UNCHECKED', { status: 'DELIVERED', docsMissing: null }),
]
const history = [
  row('CANCELED', { status: 'CANCELED' }),
  row('VOIDED', { status: 'DISPATCHED', voidedAt: '2026-10-01T00:00:00Z' }),
  row('POD-IN', { status: 'DELIVERED', docsMissing: [] }),
]
const all = [...open, ...history]

const ids = (rows: ShipmentRow[]) => rows.map((r) => r.id).sort()

describe('lifecycleRows', () => {
  it('Active and POD-due over the open work equal the same lifecycles over every shipment', () => {
    for (const lifecycle of ['active', 'pod'] as const) {
      for (const includeUnsent of [false, true]) {
        expect(ids(lifecycleRows(open, lifecycle, includeUnsent))).toEqual(ids(lifecycleRows(all, lifecycle, includeUnsent)))
      }
    }
  })

  it('lists only rate-con-sent loads unless asked for the unsent ones', () => {
    expect(ids(lifecycleRows(all, 'active', false))).toEqual(['DELIVERED-POD-DUE', 'DELIVERED-POD-UNCHECKED', 'IN-TRANSIT', 'SIGNED'])
    expect(ids(lifecycleRows(all, 'active', true))).toEqual(['BOOKED-UNSENT', 'DELIVERED-POD-DUE', 'DELIVERED-POD-UNCHECKED', 'IN-TRANSIT', 'SIGNED'])
  })

  it('keeps a delivered load on Active until its POD is on file (Ryne 2026-11-12)', () => {
    const active = ids(lifecycleRows(all, 'active', false))
    expect(active).toContain('DELIVERED-POD-DUE')
    expect(active).not.toContain('POD-IN')
  })

  it('keeps history out of Active and POD due, and shows it under Closed', () => {
    expect(ids(lifecycleRows(all, 'pod', false))).toEqual(['DELIVERED-POD-DUE', 'DELIVERED-POD-UNCHECKED'])
    expect(ids(lifecycleRows(all, 'closed', false))).toEqual(['CANCELED', 'POD-IN', 'VOIDED'])
  })
})
