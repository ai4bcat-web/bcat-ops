import { describe, it, expect, vi } from 'vitest'
import type { AssignmentType, BoardStatusKey } from '@/types/tms'
import {
  ALJEX_COLUMN_KEYS,
  BOARD_COLUMNS,
  BOARD_COLUMN_GROUPS,
  DEFAULT_COLUMN_KEYS,
  EMPTY_BOARD_FILTER_SET,
  boardFilterCount,
  boardFiltersEqual,
  boardRowTone,
  boardStatusCounts,
  boardStatusOf,
  carrierLabel,
  detailOptions,
  divisionCodeOfViewSlug,
  divisionLabel,
  massReleaseReady,
  matchesBoardFilters,
  matchesQuery,
  stopProgressOf,
  toCsv,
  toViewRow,
  visibleColumns,
  type ShipmentRow,
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


describe('search', () => {
  it('requires every search term to match the shipment', () => {
    const r = row('1', {
      searchKey: 's1 acme freight chicago il indianapolis in po-4471',
      originCity: 'Chicago, IL',
      destinationCity: 'Indianapolis, IN',
    })
    expect(matchesQuery(r, 'acme chicago')).toBe(true)
    expect(matchesQuery(r, 'acme houston')).toBe(false)
  })

  it('falls back to visible text when the shipment has no searchKey', () => {
    const r = row('2', {
      searchKey: null,
      number: 'S2',
      customerName: 'Globex',
      originCity: 'Dallas, TX',
      destinationCity: 'Houston, TX',
    })
    expect(matchesQuery(r, 'globex dallas')).toBe(true)
    expect(matchesQuery(r, 'chicago')).toBe(false)
  })
})

describe('columns', () => {
  it('defaults to MVMNT’s thirteen, in MVMNT’s order', () => {
    expect(DEFAULT_COLUMN_KEYS).toEqual([
      'number', 'status', 'originCity', 'destinationCity', 'pickupAppt', 'deliveryAppt',
      'stops', 'salesRepId', 'customerName', 'carrier', 'division', 'driver',
    ])
  })

  it('renders columns in the order of the supplied keys, dropping unknown keys', () => {
    const cols = visibleColumns(['carrier', 'status', 'unknown', 'number'])
    expect(cols.map((c) => c.key)).toEqual(['carrier', 'status', 'number'])
    expect(cols.map((c) => c.label)).toEqual(['Carrier', 'Status', 'Shipment ID'])
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
    // Columns keep the supplied order.
    expect(header).toBe('Shipment ID,Status,Customer,Origin')
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
})

// ── Step R2 board logic ─────────────────────────────────────────────────────

describe('board status mapping', () => {
  it('maps each TMS status to the right board status', () => {
    const cases: Array<[AssignmentType | null, BoardStatusKey | 'CANCELED']> = [
      [null, 'OPEN'],
      ['CARRIER', 'COVERED'],
      ['OWN_ASSET', 'RESERVED'],
    ]
    for (const [assignmentType, expected] of cases) {
      expect(boardStatusOf(row('r', { status: 'BOOKED', assignmentType }))).toBe(expected)
    }

    expect(boardStatusOf(row('r', { status: 'ON_HOLD' }))).toBe('HOLD')
    expect(boardStatusOf(row('r', { status: 'DISPATCHED' }))).toBe('DISPATCHED')
    expect(boardStatusOf(row('r', { status: 'PICKED_UP' }))).toBe('DEPARTED')
    expect(boardStatusOf(row('r', { status: 'ARRIVED_AT_DELIVERY_TERMINAL' }))).toBe('ARRIVED')
    expect(boardStatusOf(row('r', { status: 'DELIVERED' }))).toBe('DELIVERED')
    expect(boardStatusOf(row('r', { status: 'CANCELED' }))).toBe('CANCELED')
  })

  it('makes VOIDED win over every other status, including CANCELED', () => {
    expect(boardStatusOf(row('void-delivered', { status: 'DELIVERED', voidedAt: '2026-01-01T00:00:00.000Z' }))).toBe('VOIDED')
    expect(boardStatusOf(row('void-canceled', { status: 'CANCELED', voidedAt: '2026-01-01T00:00:00.000Z' }))).toBe('VOIDED')
  })
})

describe('stop progress', () => {
  it('counts departed stops over total stops', () => {
    const stops = [
      { id: 's1', type: 'PICKUP' as const, appt: '2026-01-01T12:00:00.000Z', sequence: 0, driverId: null, departedAt: '2026-01-01T13:00:00.000Z' },
      { id: 's2', type: 'DELIVERY' as const, appt: '2026-01-02T12:00:00.000Z', sequence: 1, driverId: null, departedAt: '2026-01-02T13:00:00.000Z' },
    ]
    expect(stopProgressOf(row('done', { status: 'DELIVERED', stops }))).toEqual({ done: 2, total: 2 })
  })

  it('renders status plus progress and omits 0/0', () => {
    const done = row('done', { status: 'DELIVERED', stops: [
      { id: 's1', type: 'PICKUP' as const, appt: '2026-01-01T12:00:00.000Z', sequence: 0, driverId: null, departedAt: '2026-01-01T13:00:00.000Z' },
      { id: 's2', type: 'DELIVERY' as const, appt: '2026-01-02T12:00:00.000Z', sequence: 1, driverId: null, departedAt: '2026-01-02T13:00:00.000Z' },
    ] })
    const noStops = row('no-stops', { status: 'DELIVERED', stops: [] })
    const cols = visibleColumns(['status'])
    expect(cols[0]!.value(done)).toMatch(/2\/2$/)
    expect(cols[0]!.value(noStops)).not.toMatch(/\d\/\d/)
  })

  it('says nothing rather than 0/2 when freight that moved carries no departures', () => {
    const legacy = row('legacy', { status: 'DELIVERED', stops: [
      { id: 's1', type: 'PICKUP' as const, appt: '2026-01-01T12:00:00.000Z', sequence: 0, driverId: null },
      { id: 's2', type: 'DELIVERY' as const, appt: '2026-01-02T12:00:00.000Z', sequence: 1, driverId: null },
    ] })
    expect(stopProgressOf(legacy)).toEqual({ done: 0, total: 0 })
    expect(visibleColumns(['status'])[0]!.value(legacy)).toBe('DELIVERED')
  })

  it('still shows 0/2 for freight that has not moved yet', () => {
    const open = row('open', { status: 'OPEN', stops: [
      { id: 's1', type: 'PICKUP' as const, appt: '2026-01-01T12:00:00.000Z', sequence: 0, driverId: null },
      { id: 's2', type: 'DELIVERY' as const, appt: '2026-01-02T12:00:00.000Z', sequence: 1, driverId: null },
    ] })
    expect(visibleColumns(['status'])[0]!.value(open)).toBe('OPEN 0/2')
  })

  it('prints the board vocabulary, not the MVMNT abbreviation', () => {
    const booked = row('b', { status: 'BOOKED', assignmentType: 'CARRIER', stops: [] })
    expect(visibleColumns(['status'])[0]!.value(booked)).toBe('COVERED')
  })
})

describe('row tone', () => {
  it('gives each board status its token name', () => {
    expect(boardRowTone(row('d', { status: 'DELIVERED' }))).toBe('delivered')
    expect(boardRowTone(row('c', { status: 'CANCELED' }))).toBe('canceled')
    expect(boardRowTone(row('v', { status: 'DELIVERED', voidedAt: '2026-01-01T00:00:00.000Z' }))).toBe('voided')
  })
})

describe('board filters', () => {
  const NOW = new Date('2026-03-10T17:00:00.000Z')

  it('hides voided rows when statuses is empty and shows them only when VOIDED is named', () => {
    const rows = [
      row('live', { status: 'DELIVERED' }),
      row('void', { status: 'DELIVERED', voidedAt: '2026-02-01T00:00:00.000Z' }),
    ]
    expect(rows.filter((r) => matchesBoardFilters(r, EMPTY_BOARD_FILTER_SET, NOW)).map((r) => r.id)).toEqual(['live'])
    expect(rows.filter((r) => matchesBoardFilters(r, { ...EMPTY_BOARD_FILTER_SET, statuses: ['VOIDED'] }, NOW)).map((r) => r.id))
      .toEqual(['void'])
    expect(rows.filter((r) => matchesBoardFilters(r, { ...EMPTY_BOARD_FILTER_SET, statuses: ['DELIVERED'] }, NOW)).map((r) => r.id))
      .toEqual(['live'])
  })

  it('ignores a detail filter with no values, whatever exclude says', () => {
    const rows = [row('1', { customerId: 'cust-1' }), row('2', { customerId: null })]
    const emptyInclude = { ...EMPTY_BOARD_FILTER_SET, details: { customer: { values: [], exclude: false } } }
    const emptyExclude = { ...EMPTY_BOARD_FILTER_SET, details: { customer: { values: [], exclude: true } } }
    expect(rows.filter((r) => matchesBoardFilters(r, emptyInclude, NOW)).map((r) => r.id)).toEqual(['1', '2'])
    expect(rows.filter((r) => matchesBoardFilters(r, emptyExclude, NOW)).map((r) => r.id)).toEqual(['1', '2'])
  })

  it('keeps a null facet under an exclusion and drops it under an inclusion', () => {
    const rows = [
      row('known', { equipmentType: 'VAN' }),
      row('unknown', { equipmentType: null }),
    ]
    const include = { ...EMPTY_BOARD_FILTER_SET, details: { equipment: { values: ['VAN'], exclude: false } } }
    const exclude = { ...EMPTY_BOARD_FILTER_SET, details: { equipment: { values: ['VAN'], exclude: true } } }
    expect(rows.filter((r) => matchesBoardFilters(r, include, NOW)).map((r) => r.id)).toEqual(['known'])
    expect(rows.filter((r) => matchesBoardFilters(r, exclude, NOW)).map((r) => r.id)).toEqual(['unknown'])
  })

  it('matches a FIXED date only on that calendar day in the viewer zone', () => {
    const rows = [
      row('noon-utc', { createdAt: '2026-03-10T12:00:00.000Z' }),
      row('next-day', { createdAt: '2026-03-11T12:00:00.000Z' }),
    ]
    const fixed = { ...EMPTY_BOARD_FILTER_SET, dates: { created: { mode: 'FIXED', date: '2026-03-10' } } }
    expect(rows.filter((r) => matchesBoardFilters(r, fixed, NOW)).map((r) => r.id)).toEqual(['noon-utc'])
  })

  it('matches a RANGE inclusive of both ends, with open ends', () => {
    const rows = [
      row('before', { pickupAppt: '2026-03-08T12:00:00.000Z' }),
      row('start', { pickupAppt: '2026-03-09T12:00:00.000Z' }),
      row('middle', { pickupAppt: '2026-03-10T12:00:00.000Z' }),
      row('end', { pickupAppt: '2026-03-11T12:00:00.000Z' }),
      row('after', { pickupAppt: '2026-03-12T12:00:00.000Z' }),
    ]
    const range = { ...EMPTY_BOARD_FILTER_SET, dates: { pickup: { mode: 'RANGE', from: '2026-03-09', to: '2026-03-11' } } }
    expect(rows.filter((r) => matchesBoardFilters(r, range, NOW)).map((r) => r.id)).toEqual(['start', 'middle', 'end'])

    const openStart = { ...EMPTY_BOARD_FILTER_SET, dates: { pickup: { mode: 'RANGE', from: null, to: '2026-03-10' } } }
    expect(rows.filter((r) => matchesBoardFilters(r, openStart, NOW)).map((r) => r.id)).toEqual(['before', 'start', 'middle'])
  })

  it('maps states to regions for from/to region filters', () => {
    const rows = [
      row('mw', { fromState: 'IL' }),
      row('sw', { fromState: 'TX' }),
    ]
    const midwest = { ...EMPTY_BOARD_FILTER_SET, details: { fromRegion: { values: ['MIDWEST'], exclude: false } } }
    expect(rows.filter((r) => matchesBoardFilters(r, midwest, NOW)).map((r) => r.id)).toEqual(['mw'])
  })

  it('flags check-call state, open exceptions and missing docs', () => {
    const rows = [
      row('due', { status: 'DISPATCHED', nextCheckCallAt: '2026-03-10T17:00:00.000Z' }),
      row('overdue', { status: 'DISPATCHED', nextCheckCallAt: '2026-03-10T16:00:00.000Z' }),
      row('no-call', { status: 'DISPATCHED', nextCheckCallAt: null }),
      row('exception', { status: 'DISPATCHED', openIncidentCount: 2 }),
      row('no-exception', { status: 'DISPATCHED', openIncidentCount: 0 }),
      row('docs-missing', { status: 'DELIVERED', docsMissing: ['POD'] }),
      row('docs-ok', { status: 'DELIVERED', docsMissing: [] }),
      row('docs-unchecked', { status: 'DELIVERED', docsMissing: null }),
    ]
    expect(rows.filter((r) => matchesBoardFilters(r, { ...EMPTY_BOARD_FILTER_SET, flags: { checkCallDue: true } }, NOW)).map((r) => r.id))
      .toEqual(['due', 'overdue'])
    expect(rows.filter((r) => matchesBoardFilters(r, { ...EMPTY_BOARD_FILTER_SET, flags: { checkCallOverdue: true } }, NOW)).map((r) => r.id))
      .toEqual(['overdue'])
    expect(rows.filter((r) => matchesBoardFilters(r, { ...EMPTY_BOARD_FILTER_SET, flags: { openExceptions: true } }, NOW)).map((r) => r.id))
      .toEqual(['exception'])
    expect(rows.filter((r) => matchesBoardFilters(r, { ...EMPTY_BOARD_FILTER_SET, flags: { docsMissing: true } }, NOW)).map((r) => r.id))
      .toEqual(['docs-missing'])
  })
})

describe('board status counts', () => {
  it('counts what the left-panel checkboxes show', () => {
    const rows = [
      row('open', { status: 'OPEN' }),
      row('covered', { status: 'BOOKED', assignmentType: 'CARRIER' }),
      row('reserved', { status: 'PLANNED', assignmentType: 'OWN_ASSET' }),
      row('dispatched', { status: 'DISPATCHED' }),
      row('arrived', { status: 'ARRIVED_AT_DELIVERY_TERMINAL' }),
      row('departed', { status: 'IN_TRANSIT' }),
      row('delivered', { status: 'DELIVERED' }),
      row('hold', { status: 'ON_HOLD' }),
      row('void', { status: 'DELIVERED', voidedAt: '2026-01-01T00:00:00.000Z' }),
      row('canceled', { status: 'CANCELED' }),
    ]
    const counts = boardStatusCounts(rows)
    expect(counts.OPEN).toBe(1)
    expect(counts.COVERED).toBe(1)
    expect(counts.RESERVED).toBe(1)
    expect(counts.DISPATCHED).toBe(1)
    expect(counts.ARRIVED).toBe(1)
    expect(counts.DEPARTED).toBe(1)
    expect(counts.DELIVERED).toBe(1)
    expect(counts.HOLD).toBe(1)
    expect(counts.VOIDED).toBe(1)
    // CANCELED is not a checkbox and is not counted.
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(9)
  })
})

describe('detail options', () => {
  it('lists values with counts for a facet', () => {
    const rows = [
      row('1', { equipmentType: 'VAN' }),
      row('2', { equipmentType: 'VAN' }),
      row('3', { equipmentType: 'FLATBED' }),
      row('4', { equipmentType: null }),
    ]
    expect(detailOptions(rows, 'equipment')).toEqual([
      { value: 'FLATBED', label: 'FLATBED', count: 1 },
      { value: 'VAN', label: 'VAN', count: 2 },
    ])
  })

  it('counts each value of a multi-value facet', () => {
    const rows = [
      row('1', { revDivision: 'ASSETS', revSubdivision: 'BOX_TRUCK' }),
      row('2', { revDivision: 'ASSETS', revSubdivision: null }),
    ]
    expect(detailOptions(rows, 'revenueType')).toEqual([
      { value: 'ASSETS', label: 'ASSETS', count: 2, codes: ['ASSETS'] },
      { value: 'BOX_TRUCK', label: 'BOX_TRUCK', count: 1, codes: ['BOX_TRUCK'] },
    ])
  })

  it('carries the carrier MC and SCAC as codes on the carrier facet', () => {
    const rows = [
      row('1', { carrierName: 'Bay Logistics', carrierMc: 'MC-123', carrierScac: 'BAYL' }),
      row('2', { carrierName: 'Road One', carrierMc: null, carrierScac: null }),
    ]
    expect(detailOptions(rows, 'carrier')).toEqual([
      { value: 'Bay Logistics', label: 'Bay Logistics', count: 1, codes: ['MC-123', 'BAYL'] },
      { value: 'Road One', label: 'Road One', count: 1 },
    ])
  })

  it('carries the two-letter abbreviation as the state facet code', () => {
    expect(detailOptions([row('1', { fromState: 'IL' })], 'fromStates')).toEqual([
      { value: 'IL', label: 'IL', count: 1, codes: ['IL'] },
    ])
  })
})

describe('board filter set helpers', () => {
  it('counts only facets that narrow the list', () => {
    expect(boardFilterCount(EMPTY_BOARD_FILTER_SET)).toBe(0)
    expect(boardFilterCount({ ...EMPTY_BOARD_FILTER_SET, statuses: ['OPEN'] })).toBe(1)
    expect(boardFilterCount({ ...EMPTY_BOARD_FILTER_SET, details: { customer: { values: ['x'], exclude: false } } })).toBe(1)
    expect(boardFilterCount({ ...EMPTY_BOARD_FILTER_SET, details: { customer: { values: [], exclude: true } } })).toBe(0)
    expect(boardFilterCount({ ...EMPTY_BOARD_FILTER_SET, dates: { pickup: { mode: 'FIXED', date: '2026-01-01' } } })).toBe(1)
    expect(boardFilterCount({ ...EMPTY_BOARD_FILTER_SET, dates: { pickup: { mode: 'RANGE', from: '2026-01-01', to: null } } })).toBe(1)
    expect(boardFilterCount({ ...EMPTY_BOARD_FILTER_SET, flags: { checkCallDue: true } })).toBe(1)
    expect(boardFilterCount({ ...EMPTY_BOARD_FILTER_SET, flags: { checkCallDue: false, openExceptions: true } })).toBe(1)
  })

  it('compares two filter sets by value, not identity', () => {
    const a = { ...EMPTY_BOARD_FILTER_SET, statuses: ['OPEN', 'COVERED'] }
    const b = { ...EMPTY_BOARD_FILTER_SET, statuses: ['COVERED', 'OPEN'] }
    const c = { ...EMPTY_BOARD_FILTER_SET, statuses: ['OPEN'] }
    expect(boardFiltersEqual(a, b)).toBe(true)
    expect(boardFiltersEqual(a, c)).toBe(false)

    const withFlagsA = { ...EMPTY_BOARD_FILTER_SET, flags: { checkCallDue: true, docsMissing: true } }
    const withFlagsB = { ...EMPTY_BOARD_FILTER_SET, flags: { docsMissing: true, checkCallDue: true } }
    const withFlagsC = { ...EMPTY_BOARD_FILTER_SET, flags: { checkCallDue: true } }
    expect(boardFiltersEqual(withFlagsA, withFlagsB)).toBe(true)
    expect(boardFiltersEqual(withFlagsA, withFlagsC)).toBe(false)
  })
})

describe('mass release readiness', () => {
  it('is ready only when documents are complete and the order is not released', () => {
    expect(massReleaseReady(row('ready', { status: 'DELIVERED', docsMissing: [] }))).toEqual({ ready: true, reason: null })
  })

  it('refuses with a reason when documents are missing', () => {
    const result = massReleaseReady(row('missing', { status: 'DELIVERED', docsMissing: ['POD'] }))
    expect(result.ready).toBe(false)
    expect(result.reason).toMatch(/Missing documents/i)
    expect(result.reason).toMatch(/Proof of delivery/i)
  })

  it('refuses when the document gate has not run', () => {
    expect(massReleaseReady(row('unchecked', { status: 'DELIVERED', docsMissing: null }))).toEqual({
      ready: false, reason: 'Documents not checked',
    })
  })

  it('refuses when the order is already released', () => {
    expect(massReleaseReady(row('released', { status: 'DELIVERED', docsMissing: [], readyToInvoiceAt: '2026-01-01T00:00:00.000Z' })))
      .toEqual({ ready: false, reason: 'Already released to accounting' })
    expect(massReleaseReady(row('invoiced', { status: 'DELIVERED', docsMissing: [], invoiceId: 'inv-1' })))
      .toEqual({ ready: false, reason: 'Already released to accounting' })
  })

  it('refuses voided and canceled shipments', () => {
    expect(massReleaseReady(row('void', { status: 'DELIVERED', docsMissing: [], voidedAt: '2026-01-01T00:00:00.000Z' })))
      .toEqual({ ready: false, reason: 'Voided shipment' })
    expect(massReleaseReady(row('canceled', { status: 'CANCELED', docsMissing: [] })))
      .toEqual({ ready: false, reason: 'Canceled shipment' })
  })
})

describe('Aljex column order', () => {
  it('lists the Active Shipments default columns in plan order', () => {
    expect(ALJEX_COLUMN_KEYS).toEqual([
      'exceptions', 'status', 'proNumber', 'massRelease', 'equip', 'customerReference', 'description',
      'revenueType', 'salesRep', 'customerName', 'carrier', 'customerTotalRate', 'carrierTotalRates',
      'grossProfit', 'netMargin', 'pickupShip', 'originCity', 'destinationCity', 'deliveryAppt', 'stops',
      'driver', 'truck', 'arStatus', 'apStatus', 'lastUpdateAt', 'nextCheckCallAt', 'mode', 'docsMissing',
    ])
  })

  it('renders money columns empty when the figure is unknown', () => {
    const cols = visibleColumns(['customerTotalRate', 'carrierTotalRates', 'grossProfit', 'netMargin'])
    const r = row('r')
    expect(cols.map((c) => c.value(r))).toEqual(['', '', '', ''])
  })

  it('formats money columns as US dollars and net margin as a percent', () => {
    const cols = visibleColumns(['customerTotalRate', 'carrierTotalRates', 'grossProfit', 'netMargin'])
    const r = row('r', { revenueCents: 123456, costCents: 98765, profitCents: 24691, marginBps: 1234 })
    expect(cols.map((c) => c.value(r))).toEqual(['$1,234.56', '$987.65', '$246.91', '12.34%'])
  })
})

describe('R2 column catalog', () => {
  it('groups every column by its source record, in the catalog display order', () => {
    expect(BOARD_COLUMN_GROUPS).toEqual(['Shipment', 'Order', 'Load', 'Carrier leg', 'Customer', 'Carrier', 'Computed'])
    for (const col of BOARD_COLUMNS) {
      expect(BOARD_COLUMN_GROUPS).toContain(col.group)
    }
    const keys = BOARD_COLUMNS.map((c) => c.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('prints a timestamp in Central time even when the UTC day has already rolled', () => {
    // 02:30 UTC on March 10 is 9:30 PM CDT on March 9 — the board must say March 9.
    const [col] = visibleColumns(['createdAt'])
    expect(col.value(row('r', { createdAt: '2026-03-10T02:30:00.000Z' }))).toBe('Mar 9, 9:30 PM')
  })

  it('prints dollars from cents on every money column the catalog adds', () => {
    const r = row('r', {
      customerRateCents: 123450, arBalanceCents: 999, loadRateCents: 250000,
      cargoValueCents: 10000000, creditLimitCents: 5000000,
    })
    const value = (key: string) => visibleColumns([key])[0]!.value(r)
    expect(value('customerRate')).toBe('$1,234.50')
    expect(value('arBalance')).toBe('$9.99')
    expect(value('loadRate')).toBe('$2,500.00')
    expect(value('cargoValue')).toBe('$100,000.00')
    expect(value('creditLimit')).toBe('$50,000.00')
  })

  it('prints nothing — never 0, never a dash — when the source is absent', () => {
    const r = row('r')
    for (const key of [
      'carrierMc', 'billTo', 'invoiceNumber', 'arBalance', 'miles', 'cargoValue',
      'quickPay', 'customerFactored', 'podPresent', 'nextEvent', 'trackingMotion',
      'loadAljexId', 'rating', 'stopProgress', 'postedBoards',
    ]) {
      expect(visibleColumns([key])[0]!.value(r), key).toBe('')
    }
  })

  it('resolves rep ids to the names the data layer projected', () => {
    const r = row('r', { salesRepId: 'dennis@bcat.io', salesRepName: 'Dennis' })
    expect(visibleColumns(['salesRep'])[0]!.value(r)).toBe('Dennis')
    // No projection, no guess: the raw id is still what the record holds.
    const raw = row('r2', { salesRepId: 'dennis@bcat.io' })
    expect(visibleColumns(['salesRep'])[0]!.value(raw)).toBe('dennis@bcat.io')
  })

  it('counts whole days in the current status', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-03-10T12:00:00.000Z'))
      const r = row('r', { statusChangedAt: '2026-03-07T12:00:00.000Z' })
      expect(visibleColumns(['daysInStatus'])[0]!.value(r)).toBe('3')
      expect(visibleColumns(['daysInStatus'])[0]!.value(row('x', { statusChangedAt: null }))).toBe('')
    } finally {
      vi.useRealTimers()
    }
  })

  it('announces the next event in hours, and nothing when nothing is coming', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-03-10T12:00:00.000Z'))
      const pickup = row('r', { status: 'OPEN', pickupAppt: '2026-03-11T11:00:00.000Z', stops: [] })
      expect(visibleColumns(['nextEvent'])[0]!.value(pickup)).toBe('Pickup starts in 23 h')
      const delivered = row('r2', { status: 'DELIVERED', pickupAppt: '2026-03-01T11:00:00.000Z', deliveryAppt: '2026-03-02T11:00:00.000Z' })
      expect(visibleColumns(['nextEvent'])[0]!.value(delivered)).toBe('')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads motion off the newest stop clock', () => {
    const rolling = row('r', {
      stops: [
        { id: 's1', type: 'pickup' as const, appt: '2026-03-01T10:00:00.000Z', sequence: 0, driverId: null, arrivedAt: '2026-03-01T09:00:00.000Z', departedAt: '2026-03-01T10:00:00.000Z' },
        { id: 's2', type: 'delivery' as const, appt: '2026-03-02T10:00:00.000Z', sequence: 1, driverId: null },
      ],
    })
    expect(visibleColumns(['trackingMotion'])[0]!.value(rolling)).toBe('Rolling')
    const atStop = row('r2', {
      stops: [
        { id: 's1', type: 'pickup' as const, appt: '2026-03-01T10:00:00.000Z', sequence: 0, driverId: null, departedAt: '2026-03-01T10:00:00.000Z' },
        { id: 's2', type: 'delivery' as const, appt: '2026-03-02T10:00:00.000Z', sequence: 1, driverId: null, arrivedAt: '2026-03-02T09:00:00.000Z' },
      ],
    })
    expect(visibleColumns(['trackingMotion'])[0]!.value(atStop)).toBe('At stop')
  })
})
