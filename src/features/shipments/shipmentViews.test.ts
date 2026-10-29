import { describe, it, expect } from 'vitest'
import {
  BOARD_TABS, DEFAULT_COLUMN_KEYS, EMPTY_FILTERS, applyBoard, carrierLabel, divisionCodeOfViewSlug,
  divisionLabel, filtersToViewFilters, tabCounts, toCsv, toViewRow, type ShipmentRow,
} from './shipmentViews'
import { applyViewFilters } from '@/lib/shipmentViewDefs'

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

/** Noon local on the day `nowMs` falls in, as the ISO instant an appointment carries. */
function localNoon(nowMs: number, dayOffset = 0): string {
  const d = new Date(nowMs)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset, 12, 0, 0).toISOString()
}

const NOW = Date.parse('2026-03-10T17:00:00.000Z')

describe('quick tabs', () => {
  it('puts each MVMNT status group under its own tab', () => {
    const rows: ShipmentRow[] = [
      row('open-today', { status: 'OPEN', pickupAppt: localNoon(NOW) }),
      row('hold-today', { status: 'ON_HOLD', pickupAppt: localNoon(NOW) }),
      row('open-later', { status: 'OPEN', pickupAppt: localNoon(NOW, 3) }),
      row('booked', { status: 'BOOKED' }),
      row('planned', { status: 'PLANNED' }),
      row('dispatched', { status: 'DISPATCHED' }),
      row('loading', { status: 'LOADING' }),
      row('unloading', { status: 'UNLOADING' }),
      row('ofd', { status: 'OUT_FOR_DELIVERY' }),
      row('transit', { status: 'IN_TRANSIT' }),
      row('recovered', { status: 'RECOVERED' }),
      row('delivered', { status: 'DELIVERED' }),
    ]
    const counts = tabCounts(rows, NOW)

    expect(counts['todays-open']).toBe(2)
    expect(counts.booked).toBe(2)
    expect(counts.load).toBe(2)
    expect(counts.disp).toBe(1)
    expect(counts.unload).toBe(2)
    expect(counts.transit).toBe(2)
    expect(counts.delivered).toBe(1)
    expect(counts.all).toBe(rows.length)
  })

  it('keeps the pre-MVMNT tabs so nothing the list could show disappears', () => {
    const rows = [
      row('d', { status: 'DRAFT' }),
      row('t', { status: 'TENDER_PENDING' }),
      row('r', { status: 'TENDER_REJECTED' }),
      row('c', { status: 'CANCELED' }),
    ]
    const counts = tabCounts(rows, NOW)
    expect(counts.draft).toBe(1)
    expect(counts.tender).toBe(2)
    expect(counts.canceled).toBe(1)
    expect(BOARD_TABS.filter((t) => t.overflow).map((t) => t.key))
      .toEqual(['all', 'draft', 'tender', 'canceled', 'voided'])
  })

  it('shows a voided shipment under Voided and under no other tab', () => {
    const rows = [row('live'), row('gone', { voidedAt: '2026-02-01T00:00:00.000Z' })]
    const counts = tabCounts(rows, NOW)
    expect(counts.voided).toBe(1)
    expect(counts.all).toBe(1)

    const board = (tab: Parameters<typeof applyBoard>[1]['tab']) =>
      applyBoard(rows, { tab, query: '', filters: EMPTY_FILTERS, sortKey: 'number', sortDir: 'asc', nowMs: NOW })
        .map((r) => r.id)
    expect(board('all')).toEqual(['live'])
    expect(board('voided')).toEqual(['gone'])
  })

  it('reads a shipment soft-deleted before Void existed as voided, never as missing', () => {
    const rows = [row('1'), row('2', { deletedAt: '2026-02-01T00:00:00.000Z' })]
    const counts = tabCounts(rows, NOW)
    expect(counts.all).toBe(1)
    expect(counts.voided).toBe(1)
  })
})

describe('board search and filters', () => {
  const rows = [
    row('1', {
      searchKey: 's1 acme freight chicago il indianapolis in po-4471',
      pickupAppt: '2026-03-10T14:00:00.000Z',
      deliveryAppt: '2026-03-12T14:00:00.000Z',
      originCity: 'Chicago, IL',
      destinationCity: 'Indianapolis, IN',
      revDivision: 'ASSETS',
      revSubdivision: 'BOX_TRUCK',
      salesRepId: 'ryne',
    }),
    row('2', {
      searchKey: 's2 globex dallas tx houston tx',
      pickupAppt: '2026-03-20T14:00:00.000Z',
      deliveryAppt: '2026-03-22T14:00:00.000Z',
      originCity: 'Dallas, TX',
      destinationCity: 'Houston, TX',
      customerId: 'cust-2',
      revDivision: 'BROKERAGE',
      customerRepId: 'dennis',
    }),
  ]
  const board = (patch: Partial<Parameters<typeof applyBoard>[1]> = {}) =>
    applyBoard(rows, { tab: 'all', query: '', filters: EMPTY_FILTERS, sortKey: 'number', sortDir: 'asc', nowMs: NOW, ...patch })

  it('requires every search term to match the shipment', () => {
    expect(board({ query: 'acme chicago' }).map((r) => r.id)).toEqual(['1'])
    expect(board({ query: 'acme houston' })).toHaveLength(0)
  })

  it('treats the pickup date range as inclusive of both ends', () => {
    expect(board({ filters: { ...EMPTY_FILTERS, pickupFrom: '2026-03-10', pickupTo: '2026-03-10' } }).map((r) => r.id))
      .toEqual(['1'])
    expect(board({ filters: { ...EMPTY_FILTERS, pickupFrom: '2026-03-10', pickupTo: '2026-03-20' } }))
      .toHaveLength(2)
  })

  it('narrows by delivery day, origin, destination, division and rep', () => {
    expect(board({ filters: { ...EMPTY_FILTERS, deliveryFrom: '2026-03-22' } }).map((r) => r.id)).toEqual(['2'])
    expect(board({ filters: { ...EMPTY_FILTERS, origin: 'chicago' } }).map((r) => r.id)).toEqual(['1'])
    expect(board({ filters: { ...EMPTY_FILTERS, destination: 'houston' } }).map((r) => r.id)).toEqual(['2'])
    expect(board({ filters: { ...EMPTY_FILTERS, division: 'ASSETS' } }).map((r) => r.id)).toEqual(['1'])
    // A subdivision code is as good a division chip as its parent.
    expect(board({ filters: { ...EMPTY_FILTERS, division: 'BOX_TRUCK' } }).map((r) => r.id)).toEqual(['1'])
    expect(board({ filters: { ...EMPTY_FILTERS, repId: 'dennis' } }).map((r) => r.id)).toEqual(['2'])
  })

  it('excludes a row with no AR status once the AR facet is chosen', () => {
    const withAr = [row('1', { arStatus: 'UNBILLED' }), row('2')]
    const filtered = applyBoard(withAr, {
      tab: 'all', query: '', filters: { ...EMPTY_FILTERS, arStatus: 'UNBILLED' }, sortKey: 'number', sortDir: 'asc',
    })
    expect(filtered.map((r) => r.id)).toEqual(['1'])
  })
})

describe('columns', () => {
  it('defaults to MVMNT’s thirteen, in MVMNT’s order', () => {
    expect(DEFAULT_COLUMN_KEYS).toEqual([
      'number', 'status', 'reference', 'originCity', 'destinationCity', 'pickupAppt', 'deliveryAppt',
      'stops', 'salesRepId', 'customerName', 'carrier', 'division', 'driver',
    ])
  })

  it('names who is hauling it, or says nobody is', () => {
    expect(carrierLabel(row('1', { assignmentType: 'CARRIER', carrierName: 'Bay Logistics' }))).toBe('Bay Logistics')
    expect(carrierLabel(row('2', { assignmentType: 'OWN_ASSET', driverName: 'Pavel K', truckNumber: '117' })))
      .toBe('Pavel K · Truck 117')
    expect(carrierLabel(row('3', { assignmentType: 'NEED_TO_COVER' }))).toBe('Need to cover')
  })

  it('puts the subdivision in brackets behind the division name', () => {
    const names: Record<string, string> = { ASSETS: 'Ivan Cartage', BOX_TRUCK: 'Box trucks' }
    expect(divisionLabel(row('1', { revDivision: 'ASSETS', revSubdivision: 'BOX_TRUCK' }), (c) => names[c] ?? c))
      .toBe('Ivan Cartage (Box trucks)')
    expect(divisionLabel(row('2', { revDivision: 'ASSETS' }), (c) => names[c] ?? c)).toBe('Ivan Cartage')
    expect(divisionLabel(row('3'))).toBe('')
  })

  it('writes the visible column labels and quotes values containing a comma', () => {
    const columns = ['number', 'status', 'customerName', 'originCity']
    const csv = toCsv([row('1', { customerName: 'Acme, Inc.', originCity: 'Chicago, IL' })], columns)
    const [header, line] = csv.split('\n')
    // Columns keep the board's order, whatever order the keys were asked for in.
    expect(header).toBe('Shipment ID,Status,Origin,Customer')
    expect(line).toContain('"Acme, Inc."')
    expect(line).toContain('"Chicago, IL"')
  })

  it('says VOIDED in the status cell of a voided row', () => {
    const csv = toCsv([row('1', { status: 'DELIVERED', voidedAt: '2026-02-01T00:00:00.000Z' })], ['status'])
    expect(csv.split('\n')[1]).toBe('VOIDED')
  })
})

describe('department views', () => {
  it('projects a board row onto the shape the saved views filter', () => {
    const projected = toViewRow(row('1', {
      revDivision: 'ASSETS', revSubdivision: 'LOCAL', assignmentType: 'OWN_ASSET',
      docsMissing: ['POD'], arStatus: 'DOCS_NEEDED', trackingProvider: 'MOTIVE', quoteId: 'Q-7',
    }))
    expect(applyViewFilters({ divisions: ['ASSETS'], docsState: 'POD_MISSING' }, [projected])).toHaveLength(1)
    expect(applyViewFilters({ carrierType: 'OWN_FLEET', trackingState: 'TRACKED' }, [projected])).toHaveLength(1)
    expect(applyViewFilters({ divisions: ['BROKERAGE'] }, [projected])).toHaveLength(0)
  })

  it('never lets a voided shipment through a department view', () => {
    const projected = toViewRow(row('1', { revDivision: 'BROKERAGE', voidedAt: '2026-02-01T00:00:00.000Z' }))
    expect(applyViewFilters({ divisions: ['BROKERAGE'] }, [projected])).toHaveLength(0)
  })

  it('reads the division code out of the sidebar’s synthetic view slug', () => {
    expect(divisionCodeOfViewSlug('division-ASSETS')).toBe('ASSETS')
    expect(divisionCodeOfViewSlug('dispatch')).toBeNull()
    expect(divisionCodeOfViewSlug(null)).toBeNull()
  })

  it('turns the chips the user set into a saveable view', () => {
    const filters = filtersToViewFilters(
      { ...EMPTY_FILTERS, division: 'BROKERAGE', assignmentType: 'OWN_ASSET', repId: 'ryne', arStatus: 'UNBILLED' },
      '  acme  ',
      'transit',
    )
    expect(filters).toEqual({
      statuses: ['PICKED_UP', 'IN_TRANSIT', 'RECOVERED'],
      divisions: ['BROKERAGE'],
      carrierType: 'OWN_FLEET',
      repId: 'ryne',
      arStatuses: ['UNBILLED'],
      search: 'acme',
    })
  })
})
