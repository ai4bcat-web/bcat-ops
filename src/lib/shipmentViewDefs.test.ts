import { describe, it, expect } from 'vitest'
import {
  SEED_VIEWS,
  applyViewFilters,
  slugify,
  validateView,
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
  it('ships the ten department views Ryne named', () => {
    expect(SEED_VIEWS.map((v) => v.slug)).toEqual([
      'dispatch', 'tracking', 'pod-collection', 'accounting', 'sales',
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
  const blankAudience = record('blank', { groups: [], roles: [], divisions: ['ASSETS'] })
  const accountingOnly = record('accounting-only', { groups: ['page-invoicing'] })
  const managersOnly = record('managers-only', { roles: ['MANAGER'] })
  const archived = record('archived', null, false)
  const all = [everyone, blankAudience, accountingOnly, managersOnly, archived]

  it('shows the owner and an admin every active view', () => {
    const owner = { groups: [], role: null, isOwner: true, isAdmin: false }
    const admin = { groups: [], role: null, isOwner: false, isAdmin: true }
    expect(viewsVisibleTo(all, owner).map((v) => v.slug)).toEqual(['accounting-only', 'blank', 'everyone', 'managers-only'])
    expect(viewsVisibleTo(all, admin)).toHaveLength(4)
  })

  it('treats an empty audience as everyone and a division list as grouping only', () => {
    const dispatcher = { groups: ['page-loads'], role: 'CUSTOMER_REP', isOwner: false, isAdmin: false }
    expect(viewsVisibleTo(all, dispatcher).map((v) => v.slug)).toEqual(['blank', 'everyone'])
  })

  it('matches on a group or on a role', () => {
    const biller = { groups: ['page-invoicing'], role: null, isOwner: false, isAdmin: false }
    const manager = { groups: [], role: 'MANAGER', isOwner: false, isAdmin: false }
    expect(viewsVisibleTo(all, biller).map((v) => v.slug)).toContain('accounting-only')
    expect(viewsVisibleTo(all, biller).map((v) => v.slug)).not.toContain('managers-only')
    expect(viewsVisibleTo(all, manager).map((v) => v.slug)).toContain('managers-only')
  })

  it('never shows an archived view', () => {
    const owner = { groups: [], role: null, isOwner: true, isAdmin: true }
    expect(viewsVisibleTo(all, owner).map((v) => v.slug)).not.toContain('archived')
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
