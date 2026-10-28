import { describe, it, expect } from 'vitest'
import {
  BOARD_TABS, DEFAULT_COLUMN_KEYS, EMPTY_FILTERS, applyBoard, readSavedViews, tabCounts, toCsv,
  upsertView, writeSavedViews, type SavedView, type ShipmentRow,
} from './shipmentViews'
import type { ShipmentStatus } from '@/types/tms'

function row(id: string, patch: Partial<ShipmentRow> = {}): ShipmentRow {
  return {
    id,
    number: `S${id}`,
    status: 'OPEN',
    customerId: 'cust-1',
    customerName: 'Acme Freight',
    mode: 'FTL',
    source: 'MANUAL',
    createdBy: 'a@b.c',
    updatedBy: 'a@b.c',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  }
}

describe('board tabs', () => {
  it('counts a shipment under All and under exactly one status tab', () => {
    const counts = tabCounts([row('1', { status: 'DRAFT' })])
    expect(counts.all).toBe(1)
    expect(counts.draft).toBe(1)
    const named = BOARD_TABS.filter((t) => t.key !== 'all' && counts[t.key] > 0)
    expect(named.map((t) => t.key)).toEqual(['draft'])
  })

  it('groups every in-transit movement label under one tab', () => {
    const moving: ShipmentStatus[] = [
      'DISPATCHED', 'LOADING', 'PICKED_UP', 'IN_TRANSIT', 'RECOVERED',
      'ARRIVED_AT_DELIVERY_TERMINAL', 'OUT_FOR_DELIVERY', 'UNLOADING',
    ]
    const counts = tabCounts(moving.map((status, i) => row(String(i), { status })))
    expect(counts.transit).toBe(moving.length)
    expect(counts.delivered).toBe(0)
  })

  it('leaves deleted shipments out of every count and every list', () => {
    const rows = [row('1'), row('2', { deletedAt: '2026-02-01T00:00:00.000Z' })]
    expect(tabCounts(rows).all).toBe(1)
    expect(applyBoard(rows, { tab: 'all', query: '', filters: EMPTY_FILTERS, sortKey: 'number', sortDir: 'asc' }))
      .toHaveLength(1)
  })
})

describe('board search and filters', () => {
  const rows = [
    row('1', { searchKey: 's1 acme freight chicago il indianapolis in po-4471', pickupAppt: '2026-03-10T14:00:00.000Z' }),
    row('2', { searchKey: 's2 globex dallas tx houston tx', pickupAppt: '2026-03-20T14:00:00.000Z', customerId: 'cust-2' }),
  ]
  const board = (patch: Partial<Parameters<typeof applyBoard>[1]> = {}) =>
    applyBoard(rows, { tab: 'all', query: '', filters: EMPTY_FILTERS, sortKey: 'number', sortDir: 'asc', ...patch })

  it('requires every search term to match the shipment', () => {
    expect(board({ query: 'acme chicago' }).map((r) => r.id)).toEqual(['1'])
    expect(board({ query: 'acme houston' })).toHaveLength(0)
  })

  it('matches a reference value carried in the search key', () => {
    expect(board({ query: 'PO-4471' }).map((r) => r.id)).toEqual(['1'])
  })

  it('treats the pickup date range as inclusive of both ends', () => {
    expect(board({ filters: { ...EMPTY_FILTERS, pickupFrom: '2026-03-10', pickupTo: '2026-03-10' } }).map((r) => r.id))
      .toEqual(['1'])
    expect(board({ filters: { ...EMPTY_FILTERS, pickupFrom: '2026-03-10', pickupTo: '2026-03-20' } }))
      .toHaveLength(2)
  })

  it('excludes a row with no AR status once the AR facet is chosen', () => {
    const withAr = [row('1', { arStatus: 'UNBILLED' }), row('2')]
    const filtered = applyBoard(withAr, {
      tab: 'all', query: '', filters: { ...EMPTY_FILTERS, arStatus: 'UNBILLED' }, sortKey: 'number', sortDir: 'asc',
    })
    expect(filtered.map((r) => r.id)).toEqual(['1'])
  })
})

describe('CSV export', () => {
  it('writes the visible column labels and quotes values containing a comma', () => {
    // An explicit column list, so adding a column to the default view is not a CSV change.
    const columns = ['number', 'status', 'customerName', 'originCity']
    const csv = toCsv([row('1', { customerName: 'Acme, Inc.', originCity: 'Chicago, IL' })], columns)
    const [header, line] = csv.split('\n')
    expect(header).toBe('Shipment,Status,Customer,Origin')
    expect(line).toContain('"Acme, Inc."')
    expect(line).toContain('"Chicago, IL"')
  })
})

describe('saved views', () => {
  const view = (id: string, patch: Partial<SavedView> = {}): SavedView => ({
    id, name: id, tab: 'all', query: '', filters: EMPTY_FILTERS,
    columnKeys: [...DEFAULT_COLUMN_KEYS], sortKey: 'pickupAppt', sortDir: 'asc', ...patch,
  })

  it('keeps at most one default view', () => {
    const next = upsertView([view('a', { isDefault: true })], view('b', { isDefault: true }))
    expect(next.filter((v) => v.isDefault).map((v) => v.id)).toEqual(['b'])
  })

  it('replaces a view saved under an id it already has', () => {
    const next = upsertView([view('a', { query: 'old' })], view('a', { query: 'new' }))
    expect(next).toHaveLength(1)
    expect(next[0].query).toBe('new')
  })

  it('round-trips through storage and drops entries it cannot trust', () => {
    const store: Record<string, string> = {}
    const storage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v },
      removeItem: (k: string) => { delete store[k] },
    }
    writeSavedViews('Ryne@bcatcorp.com', [view('a', { tab: 'draft' })], storage)
    expect(readSavedViews('ryne@bcatcorp.com', storage)).toEqual([view('a', { tab: 'draft', isDefault: false })])

    store['bcat.shipments.views.ryne@bcatcorp.com'] = JSON.stringify([{ name: 'no id' }, view('b')])
    expect(readSavedViews('ryne@bcatcorp.com', storage).map((v) => v.id)).toEqual(['b'])
  })

  it('clears storage rather than persisting an empty list', () => {
    const store: Record<string, string> = { 'bcat.shipments.views.x': '[]' }
    writeSavedViews('x', [], {
      setItem: (k: string, v: string) => { store[k] = v },
      removeItem: (k: string) => { delete store[k] },
    })
    expect(store['bcat.shipments.views.x']).toBeUndefined()
  })
})
