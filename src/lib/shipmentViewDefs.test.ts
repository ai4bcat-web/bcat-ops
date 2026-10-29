import { describe, it, expect } from 'vitest'
import {
  ALJEX_COLUMN_KEYS,
  BOARD_COLUMN_KEYS,
  SEED_VIEWS,
  applyViewFilters,
  slugify,
  validateView,
  viewCallerOf,
  viewsVisibleTo,
} from './shipmentViewDefs'
import type { ShipmentViewRecord, ShipmentViewRow } from '../types/tms'

// A fixed Wednesday, so "today", "tomorrow" and the Monday-start week are stable.
const NOW = new Date(2026, 4, 13, 9, 0, 0)
const at = (dayOffset: number, hour = 9) => new Date(2026, 4, 13 + dayOffset, hour, 0, 0).toISOString()

const row = (id: string, patch: Partial<ShipmentViewRow>): ShipmentViewRow => ({
  id,
  status: 'BOOKED',
  revDivision: null,
  revSubdivision: null,
  assignmentType: null,
  salesRepId: null,
  customerRepId: null,
  pickupAppt: null,
  docsMissing: [],
  arStatus: null,
  apStatus: null,
  trackingProvider: null,
  nextCheckCallAt: null,
  lastCheckCallAt: null,
  quoteId: null,
  searchKey: null,
  voidedAt: null,
  customerId: null,
  carrierName: null,
  pickupName: null,
  consigneeName: null,
  fromState: null,
  toState: null,
  equipmentType: null,
  officeTeamKeys: null,
  dispatcherAssignedId: null,
  dispatcherActualId: null,
  shipDate: null,
  deliveryAppt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  stops: null,
  revenueCents: null,
  costCents: null,
  profitCents: null,
  marginBps: null,
  customerReference: null,
  commodity: null,
  ...patch,
})

const ROWS: ShipmentViewRow[] = [
  row('r1', { revDivision: 'ASSETS', revSubdivision: 'OWNER_OPERATOR', assignmentType: 'OWN_ASSET', pickupAppt: at(0), trackingProvider: 'DRIVER_APP', searchKey: 'l1001 acme chicago' }),
  row('r2', { revDivision: 'ASSETS', revSubdivision: 'BOX_TRUCK', assignmentType: 'OWN_ASSET', pickupAppt: at(1), status: 'DISPATCHED', trackingProvider: 'DRIVER_APP' }),
  row('r3', { revDivision: 'ASSETS', revSubdivision: 'LOCAL', assignmentType: 'OWN_ASSET', pickupAppt: at(7) }),
  row('r4', { revDivision: 'ASSETS', assignmentType: 'OWN_ASSET', pickupAppt: at(0), status: 'IN_TRANSIT', trackingProvider: 'DRIVER_APP' }),
  row('r5', { revDivision: 'BROKERAGE', assignmentType: 'CARRIER', pickupAppt: at(0), status: 'IN_TRANSIT', trackingProvider: 'LINK', nextCheckCallAt: at(-1), apStatus: 'AWAITING_INVOICE' }),
  row('r6', { revDivision: 'BROKERAGE', assignmentType: 'CARRIER', pickupAppt: at(7), status: 'DELIVERED', docsMissing: ['POD'], arStatus: 'DOCS_NEEDED' }),
  row('r7', { revDivision: 'BROKERAGE', assignmentType: 'NEED_TO_COVER', pickupAppt: at(1), status: 'OPEN', trackingProvider: 'NONE', quoteId: 'q-1', salesRepId: 'rep-a' }),
  row('r8', { revDivision: 'CAR_SHIPPING', assignmentType: 'CARRIER', pickupAppt: at(0), status: 'DELIVERED', arStatus: 'UNBILLED' }),
  row('r9', { revDivision: 'BROKERAGE', assignmentType: 'CARRIER', pickupAppt: at(-3), status: 'DELIVERED', arStatus: 'UNPAID', apStatus: 'TO_BE_PAID' }),
  row('r10', { revDivision: 'BROKERAGE', assignmentType: 'CARRIER', pickupAppt: at(-5), status: 'DELIVERED', docsMissing: ['POD'], arStatus: 'PAID' }),
  row('r11', { revDivision: 'ASSETS', revSubdivision: 'LOCAL', assignmentType: 'OWN_ASSET', pickupAppt: at(0), voidedAt: at(-1) }),
  row('r12', { revDivision: 'BROKERAGE', assignmentType: 'CARRIER', pickupAppt: at(4), quoteId: 'q-2', salesRepId: 'rep-b', customerRepId: 'rep-a' }),
]

const ids = (rows: ShipmentViewRow[]) => rows.map((r) => r.id)
const view = (slug: string) => {
  const found = SEED_VIEWS.find((v) => v.slug === slug)
  if (!found) throw new Error(`no seed view ${slug}`)
  return found
}
const apply = (slug: string) => ids(applyViewFilters(view(slug).filters, ROWS, NOW))

describe('the seed views over a fixture board', () => {
  it('ships the default view plus the ten department views Ryne named', () => {
    expect(SEED_VIEWS.map((v) => v.slug)).toEqual([
      'active-shipments', 'dispatch', 'tracking', 'pod-collection', 'accounting', 'sales',
      'brokerage-board', 'car-shipping-board', 'owner-operators', 'box-trucks', 'local-drivers',
    ])
  })

  it('Dispatch shows own-fleet pickups today and tomorrow', () => {
    expect(apply('dispatch')).toEqual(['r1', 'r2', 'r4'])
  })

  it('Tracking shows rolling freight somebody is tracking', () => {
    expect(apply('tracking')).toEqual(['r2', 'r4', 'r5'])
  })

  it('POD collection shows delivered shipments still missing the POD', () => {
    expect(apply('pod-collection')).toEqual(['r6', 'r10'])
  })

  it('Accounting shows docs needed, unbilled and unpaid', () => {
    expect(apply('accounting')).toEqual(['r6', 'r8', 'r9'])
  })

  it('Sales shows the shipments that came from a quote', () => {
    expect(apply('sales')).toEqual(['r7', 'r12'])
    expect(view('sales').sort).toEqual({ key: 'salesRepId', dir: 'asc' })
  })

  it('the division boards split brokerage from car shipping', () => {
    expect(apply('brokerage-board')).toEqual(['r5', 'r6', 'r7', 'r9', 'r10', 'r12'])
    expect(apply('car-shipping-board')).toEqual(['r8'])
  })

  it('the three Ivan subsidiary boards each show their own work', () => {
    expect(apply('owner-operators')).toEqual(['r1'])
    expect(apply('box-trucks')).toEqual(['r2'])
    expect(apply('local-drivers')).toEqual(['r3'])
  })

  it('never shows a voided shipment in any view', () => {
    for (const v of SEED_VIEWS) {
      expect(ids(applyViewFilters(v.filters, ROWS, NOW))).not.toContain('r11')
    }
    expect(ids(applyViewFilters({}, ROWS, NOW))).not.toContain('r11')
  })
})

describe('applyViewFilters clauses', () => {
  it('filters nothing when no clause is set', () => {
    expect(applyViewFilters(null, ROWS, NOW)).toHaveLength(ROWS.length - 1)
  })

  it('maps the OWN_FLEET carrier type onto the own-asset assignment', () => {
    expect(ids(applyViewFilters({ carrierType: 'OWN_FLEET' }, ROWS, NOW))).toEqual(['r1', 'r2', 'r3', 'r4'])
    expect(ids(applyViewFilters({ carrierType: 'NEED_TO_COVER' }, ROWS, NOW))).toEqual(['r7'])
  })

  it('matches a rep on either the sales rep or the customer rep', () => {
    expect(ids(applyViewFilters({ repId: 'rep-a' }, ROWS, NOW))).toEqual(['r7', 'r12'])
    expect(ids(applyViewFilters({ repId: 'rep-b' }, ROWS, NOW))).toEqual(['r12'])
  })

  it('walks the pickup windows', () => {
    expect(ids(applyViewFilters({ pickupWindow: 'today' }, ROWS, NOW))).toEqual(['r1', 'r4', 'r5', 'r8'])
    expect(ids(applyViewFilters({ pickupWindow: 'tomorrow' }, ROWS, NOW))).toEqual(['r2', 'r7'])
    // The fixed now is a Wednesday, so the Monday-start week runs May 11–17.
    expect(ids(applyViewFilters({ pickupWindow: 'this_week' }, ROWS, NOW))).toEqual(['r1', 'r2', 'r4', 'r5', 'r7', 'r8', 'r12'])
    expect(ids(applyViewFilters({ pickupWindow: 'last_30_days' }, ROWS, NOW))).toEqual(['r1', 'r4', 'r5', 'r8', 'r9', 'r10'])
    expect(ids(applyViewFilters({ pickupWindow: 'this_month' }, ROWS, NOW))).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r12'])
  })

  it('separates docs states', () => {
    expect(ids(applyViewFilters({ docsState: 'POD_MISSING' }, ROWS, NOW))).toEqual(['r6', 'r10'])
    expect(ids(applyViewFilters({ docsState: 'DOCS_NEEDED' }, ROWS, NOW))).toEqual(['r6', 'r10'])
    expect(ids(applyViewFilters({ docsState: 'COMPLETE' }, ROWS, NOW))).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r7', 'r8', 'r9', 'r12'])
  })

  it('reads NONE and a blank provider as untracked, and a past check call as overdue', () => {
    expect(ids(applyViewFilters({ trackingState: 'TRACKED' }, ROWS, NOW))).toEqual(['r1', 'r2', 'r4', 'r5'])
    expect(ids(applyViewFilters({ trackingState: 'UNTRACKED' }, ROWS, NOW))).toEqual(['r3', 'r6', 'r7', 'r8', 'r9', 'r10', 'r12'])
    expect(ids(applyViewFilters({ trackingState: 'OVERDUE' }, ROWS, NOW))).toEqual(['r5'])
  })

  it('filters by AP status and by free text', () => {
    expect(ids(applyViewFilters({ apStatuses: ['TO_BE_PAID'] }, ROWS, NOW))).toEqual(['r9'])
    expect(ids(applyViewFilters({ search: 'ACME' }, ROWS, NOW))).toEqual(['r1'])
    expect(ids(applyViewFilters({ search: 'nothing here' }, ROWS, NOW))).toEqual([])
  })
})

describe('viewsVisibleTo', () => {
  const record = (slug: string, audience: ShipmentViewRecord['audience'], active = true): ShipmentViewRecord => ({
    ...SEED_VIEWS[0],
    id: slug,
    slug,
    name: slug,
    audience,
    active,
    sortOrder: 10,
    createdBy: 'seed',
    updatedBy: 'seed',
    version: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  })
  const everyone = record('everyone', null)
  const blankAudience = record('blank', { groups: [], roles: [] })
  const accountingOnly = record('accounting-only', { groups: ['page-invoicing'] })
  const managersOnly = record('managers-only', { roles: ['MANAGER'] })
  const assetsOnly = record('assets-only', { divisions: ['ASSETS'] })
  const assetsBilling = record('assets-billing', { groups: ['page-invoicing'], divisions: ['ASSETS'] })
  const archived = record('archived', null, false)
  const all = [everyone, blankAudience, accountingOnly, managersOnly, assetsOnly, assetsBilling, archived]

  const slugs = (caller: Parameters<typeof viewsVisibleTo>[1]) => viewsVisibleTo(all, caller).map((v) => v.slug)

  it('shows the owner and an admin every active view, division-scoped ones included', () => {
    const owner = viewCallerOf({ groups: [], divisions: [], isOwner: true, isAdmin: false })
    const admin = viewCallerOf({ groups: [], divisions: [], isOwner: false, isAdmin: true })
    expect(slugs(owner)).toEqual([
      'accounting-only', 'assets-billing', 'assets-only', 'blank', 'everyone', 'managers-only',
    ])
    expect(slugs(admin)).toHaveLength(6)
  })

  it('shows a view with no audience facets to everyone', () => {
    const dispatcher = viewCallerOf({ groups: ['page-loads'], divisions: [], isOwner: false, isAdmin: false })
    expect(slugs(dispatcher)).toEqual(['blank', 'everyone'])
  })

  it('matches on a group or on a role', () => {
    const biller = viewCallerOf({ groups: ['page-invoicing'], divisions: [], isOwner: false, isAdmin: false })
    expect(slugs(biller)).toContain('accounting-only')
    expect(slugs(biller)).not.toContain('managers-only')
  })

  it('reads the role off the one role- group the token carries', () => {
    const manager = viewCallerOf({ groups: ['role-MANAGER', 'page-loads'], divisions: [], isOwner: false, isAdmin: false })
    expect(manager.role).toBe('MANAGER')
    expect(slugs(manager)).toContain('managers-only')

    const roleless = viewCallerOf({ groups: ['page-loads'], divisions: [], isOwner: false, isAdmin: false })
    expect(roleless.role).toBeNull()
    expect(slugs(roleless)).not.toContain('managers-only')
  })

  it('hides a division-scoped view from somebody who works in another division', () => {
    const brokerage = viewCallerOf({ groups: ['page-loads'], divisions: ['BROKERAGE'], isOwner: false, isAdmin: false })
    expect(slugs(brokerage)).not.toContain('assets-only')
  })

  it('shows a division-scoped view to somebody who works in that division', () => {
    const assets = viewCallerOf({ groups: ['page-loads'], divisions: ['BROKERAGE', 'ASSETS'], isOwner: false, isAdmin: false })
    expect(slugs(assets)).toContain('assets-only')
  })

  it('lets the division narrow a view a group would otherwise admit', () => {
    const biller = viewCallerOf({ groups: ['page-invoicing'], divisions: ['BROKERAGE'], isOwner: false, isAdmin: false })
    expect(slugs(biller)).toContain('accounting-only')
    expect(slugs(biller)).not.toContain('assets-billing')

    const assetsBiller = viewCallerOf({ groups: ['page-invoicing'], divisions: ['ASSETS'], isOwner: false, isAdmin: false })
    expect(slugs(assetsBiller)).toContain('assets-billing')
  })

  it('still refuses a division member a view whose group and role both miss', () => {
    const assets = viewCallerOf({ groups: ['page-loads'], divisions: ['ASSETS'], isOwner: false, isAdmin: false })
    expect(slugs(assets)).not.toContain('assets-billing')
  })

  it('never shows an archived view', () => {
    const owner = viewCallerOf({ groups: [], divisions: [], isOwner: true, isAdmin: true })
    expect(slugs(owner)).not.toContain('archived')
  })
})

describe('slugify and validateView', () => {
  it('turns a department name into its URL', () => {
    expect(slugify('POD collection')).toBe('pod-collection')
    expect(slugify('  Owner Operators / Flatbed  ')).toBe('owner-operators-flatbed')
    expect(slugify('!!!')).toBe('')
  })

  it('accepts every seed view', () => {
    for (const v of SEED_VIEWS) expect(validateView(v)).toEqual([])
  })

  it('reports a blank name, a bad slug, an unknown status and a bad sort', () => {
    expect(validateView({
      name: '  ',
      slug: 'POD Collection',
      filters: { statuses: ['SHIPPED' as never] },
      sort: { key: '', dir: 'sideways' as never },
    })).toEqual([
      'The view needs a name.',
      '"POD Collection" is not a valid slug — use pod-collection.',
      '"SHIPPED" is not a shipment status.',
      'The sort direction must be asc or desc.',
      'The sort needs a column.',
    ])
  })
})

describe('R2 board filters inside a saved view', () => {
  const NOW = new Date('2026-03-10T17:00:00.000Z')

  it('runs the board filter set alongside existing view filters', () => {
    const rows = [
      row('brokerage-van', { revDivision: 'BROKERAGE', equipmentType: 'VAN' }),
      row('brokerage-flat', { revDivision: 'BROKERAGE', equipmentType: 'FLATBED' }),
      row('assets-van', { revDivision: 'ASSETS', equipmentType: 'VAN' }),
    ]
    const filters: ShipmentViewFilters = {
      divisions: ['BROKERAGE'],
      board: { statuses: [], details: { equipment: { values: ['VAN'], exclude: false } }, dates: {} },
    }
    expect(ids(applyViewFilters(filters, rows, NOW))).toEqual(['brokerage-van'])
  })

  it('keeps dropping voided rows unless VOIDED is selected', () => {
    const rows = [
      row('live', { status: 'DELIVERED' }),
      row('void', { status: 'DELIVERED', voidedAt: '2026-02-01T00:00:00.000Z' }),
    ]
    expect(ids(applyViewFilters({ board: { statuses: [], details: {}, dates: {} } }, rows, NOW))).toEqual(['live'])
    expect(ids(applyViewFilters({ board: { statuses: ['VOIDED'], details: {}, dates: {} } }, rows, NOW))).toEqual(['void'])
  })

  it('applies board date filters to the projected view row', () => {
    const rows = [
      row('on-day', { shipDate: '2026-03-10T12:00:00.000Z' }),
      row('next-day', { shipDate: '2026-03-11T12:00:00.000Z' }),
    ]
    const filters: ShipmentViewFilters = {
      board: { statuses: [], details: {}, dates: { ship: { mode: 'FIXED', date: '2026-03-10' } } },
    }
    expect(ids(applyViewFilters(filters, rows, NOW))).toEqual(['on-day'])
  })

  it('agrees on FIXED and RANGE at a local/UTC boundary', () => {
    // 2026-03-10 23:30 in UTC-5 is 2026-03-11 04:30 UTC, so the UTC date part is the 11th
    // but the viewer's local calendar day is the 10th.
    const localZoneTestTime = '2026-03-11T04:30:00.000Z'
    const rows = [row('late-local', { shipDate: localZoneTestTime })]
    const fixed: ShipmentViewFilters = {
      board: { statuses: [], details: {}, dates: { ship: { mode: 'FIXED', date: '2026-03-10' } } },
    }
    const range: ShipmentViewFilters = {
      board: { statuses: [], details: {}, dates: { ship: { mode: 'RANGE', from: '2026-03-10', to: '2026-03-10' } } },
    }
    // The exact match depends on the zone the test runs in. Assert both branches agree.
    expect(ids(applyViewFilters(fixed, rows, NOW))).toEqual(ids(applyViewFilters(range, rows, NOW)))
  })
})

describe('BOARD_COLUMN_KEYS', () => {
  it('lists every valid board column key', () => {
    expect(BOARD_COLUMN_KEYS).toContain('number')
    expect(BOARD_COLUMN_KEYS).toContain('exceptions')
    expect(BOARD_COLUMN_KEYS).toContain('docsMissing')
    expect(BOARD_COLUMN_KEYS).toHaveLength(33)
    expect(new Set(BOARD_COLUMN_KEYS).size).toBe(BOARD_COLUMN_KEYS.length)
  })

  it('contains every Aljex column key and has no duplicates', () => {
    for (const key of ALJEX_COLUMN_KEYS) {
      expect(BOARD_COLUMN_KEYS).toContain(key)
    }
    expect(BOARD_COLUMN_KEYS).toHaveLength(33)
    expect(new Set(BOARD_COLUMN_KEYS).size).toBe(BOARD_COLUMN_KEYS.length)
  })
})
