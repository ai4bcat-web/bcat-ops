// @vitest-environment jsdom
/**
 * The sidebar is now the org chart: three businesses plus the company, built from
 * division rows. What breaks silently here is access — a Brokerage grant that leaks the
 * fleet's pages into somebody's rail, or a division that has no pages of its own
 * vanishing instead of showing its shipments.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router-dom'
import { createElement } from 'react'
import { buildNavSections, companyOptions, flatNavDefs, PINNED_ITEMS, tmsBreadcrumb } from './navSections'
import { PERMISSION_PAGES } from './navItems'
import { TmsShell } from '@/features/tms/TmsShell'
import type { OwnershipDivisionRecord } from '@/types/tms'

function division(partial: Partial<OwnershipDivisionRecord> & { code: string }): OwnershipDivisionRecord {
  return {
    id: partial.code,
    name: partial.code,
    brand: null,
    parentId: null,
    color: null,
    sortOrder: 10,
    active: true,
    owners: null,
    flows: null,
    createdBy: 'seed',
    updatedBy: 'seed',
    version: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...partial,
  }
}

const FOUR = [
  division({ code: 'BROKERAGE', name: 'BCAT Logistics', brand: 'BCAT Logistics', sortOrder: 10 }),
  division({ code: 'ASSETS', name: 'Ivan Cartage', brand: 'Ivan Cartage', sortOrder: 20 }),
  division({ code: 'CAR_SHIPPING', name: 'Best Care Auto Transport', brand: 'Best Care Auto Transport', sortOrder: 30 }),
  division({ code: 'COMPANY', name: 'Company', sortOrder: 40 }),
]

const grants = (...keys: string[]) => (key: string) => keys.includes(key)

beforeEach(() => {
  window.localStorage.clear()
})

describe('buildNavSections', () => {
  const labels = (items: Array<{ label: string }> | undefined) => (items ?? []).map((i) => i.label)
  const pinnedOf = (...keys: string[]) => buildNavSections({ divisions: FOUR, hasPageAccess: grants(...keys) }).pinned

  it('gives the owner the whole rail in order: the pinned freight list, then Assets, Car shipping, Company', () => {
    const { pinned, sections, businesses } = buildNavSections({ divisions: FOUR, hasPageAccess: () => false, isOwner: true })
    expect(labels(pinned)).toEqual([
      'Company Dashboard', 'Quotes', 'Shipments', 'Carrier Sales', 'Load Tracking', 'Load Review',
      'Customers', 'Carriers', 'Locations', 'Accounting', 'Settings',
    ])
    const kids = (label: string) => labels(pinned.find((i) => i.label === label)?.children)
    expect(kids('Quotes')).toEqual(['Quotes', 'Spot inbox'])
    expect(kids('Shipments')).toEqual(['Active', 'All', 'Intake'])
    expect(pinned.find((i) => i.label === 'Load Tracking')?.children).toBeUndefined()
    expect(kids('Customers')).toEqual(['Customers', 'Follow-ups'])
    expect(kids('Accounting')).toEqual(['Accounts Receivable', 'Accounts Payable', 'Vendors', 'Factoring'])
    expect(kids('Settings')).toEqual([
      'General & automation', 'Company', 'Divisions & ownership', 'Users & roles', 'Integrations', 'AI agents',
      'Spot quoter & e-mail', 'Carrier Sales', 'Commissions', 'Reports', 'Audit log', 'Compliance', 'Platform health', 'Demo',
    ])
    // Every child lands somewhere different.
    const childTargets = pinned.flatMap((i) => (i.children ?? []).map((c) => c.to))
    expect(new Set(childTargets).size).toBe(childTargets.length)

    // No BROKERAGE section and no "Intake · BCAT" fallback; the business is still offered.
    expect(sections.map((s) => s.key)).toEqual(['ASSETS', 'CAR_SHIPPING', 'COMPANY'])
    expect(businesses.map((b) => b.key)).toEqual(['BROKERAGE', 'ASSETS', 'CAR_SHIPPING'])
    expect(labels(sections[2].items)).toEqual([
      'Financial operations', 'Finances', 'Profit Review', 'Weekly Cash Check-in', 'Reddit Queue',
    ])
    // The header reads as a business name, not as a code: `CAR SHIPPING [Best Care Auto Transport]`.
    expect(sections[1].name).toBe('CAR SHIPPING')
    expect(sections[1].brand).toBe('Best Care Auto Transport')
  })

  it('opens the whole freight list on the one `tms` grant, minus the admin-only rows', () => {
    const { pinned, sections, businesses } = buildNavSections({ divisions: FOUR, hasPageAccess: grants('tms') })
    expect(pinned.map((i) => i.to)).toEqual(
      PINNED_ITEMS.map((i) => (i.group ? i.children?.find((c) => c.adminOnly !== true)?.to : i.to)),
    )
    const settings = pinned.find((i) => i.label === 'Settings')
    expect(labels(settings?.children)).toEqual(['General & automation', 'Commissions', 'Reports', 'Audit log', 'Demo'])
    expect(sections).toEqual([])
    expect(businesses).toEqual([{ key: 'BROKERAGE' }])
  })

  it('shows admin-only rows to an admin and never to a page grant', () => {
    const everyGrant = new Set(PERMISSION_PAGES.map((p) => p.key))
    const adminOnly = ['Company', 'Divisions & ownership', 'Users & roles', 'Integrations', 'AI agents', 'Platform health']
    const granted = labels(buildNavSections({ divisions: FOUR, hasPageAccess: (k) => everyGrant.has(k) })
      .pinned.find((i) => i.label === 'Settings')?.children)
    const admin = labels(buildNavSections({ divisions: FOUR, hasPageAccess: () => false, isAdmin: true })
      .pinned.find((i) => i.label === 'Settings')?.children)
    for (const label of adminOnly) {
      expect(granted).not.toContain(label)
      expect(admin).toContain(label)
    }
    expect(granted).toContain('Compliance')
  })

  it('shows a carriers-only grant Carriers and nothing else', () => {
    const { pinned, sections } = buildNavSections({ divisions: FOUR, hasPageAccess: grants('carriers') })
    expect(labels(pinned)).toEqual(['Carriers'])
    // Find & Invite is a Carriers sub-page on the same grant.
    expect(labels(pinned[0].children)).toEqual(['Carriers', 'Find & Invite'])
    expect(sections).toEqual([])
  })

  it('shows a loads grant the shared freight pages, not Load Review or the money pages', () => {
    const { pinned, sections } = buildNavSections({ divisions: FOUR, hasPageAccess: grants('loads') })
    expect(labels(pinned)).toEqual(['Shipments', 'Carrier Sales', 'Load Tracking'])
    expect(sections).toEqual([])
    expect(pinned[0].children).toEqual([
      expect.objectContaining({ to: '/tms/shipments', label: 'Active' }),
      expect.objectContaining({ to: '/tms/shipments?list=all', label: 'All' }),
      expect.objectContaining({ to: '/tms/shipments/intake', label: 'Intake', badgeKey: 'intakeLoads' }),
    ])
  })

  it('shows a loadReview-only grant Load Review alone', () => {
    expect(labels(pinnedOf('loadReview'))).toEqual(['Load Review'])
  })

  it('puts a compliance-only grant under Settings, landing the group on Compliance', () => {
    const { pinned, sections } = buildNavSections({ divisions: FOUR, hasPageAccess: grants('compliance') })
    expect(labels(pinned)).toEqual(['Settings'])
    expect(labels(pinned[0].children)).toEqual(['Compliance'])
    expect(pinned[0].to).toBe('/compliance')
    expect(pinned[0].group).toBe(true)
    // Compliance used to sit in COMPANY; it is not in any section any more.
    expect(sections).toEqual([])
  })

  it('never lets a hidden Accounting child leak, and lands the group on the first visible one', () => {
    const ar = pinnedOf('invoicing')
    expect(labels(ar)).toEqual(['Accounting'])
    expect(labels(ar[0].children)).toEqual(['Accounts Receivable'])
    expect(ar[0].to).toBe('/tms/invoicing')
    const ap = pinnedOf('carrierPay')
    expect(labels(ap[0].children)).toEqual(['Accounts Payable'])
    expect(ap[0].to).toBe('/tms/invoicing/payable')
  })

  it('shows a quotes grant the Quotes parent with its own children, and no other freight page', () => {
    const quotes = pinnedOf('quotes')
    expect(labels(quotes)).toEqual(['Quotes'])
    expect(quotes[0].to).toBe('/tms/rates')
    expect(labels(quotes[0].children)).toEqual(['Quotes', 'Spot inbox'])
  })

  it('keeps a fleet user out of the freight list and the Brokerage business', () => {
    const { pinned, sections, businesses } = buildNavSections({ divisions: FOUR, hasPageAccess: grants('calendar', 'trucks') })
    expect(pinned).toEqual([])
    expect(sections.map((s) => s.key)).toEqual(['ASSETS'])
    expect(labels(sections[0].items)).toEqual(['Calendar', 'Fleet'])
    expect(businesses).toEqual([{ key: 'ASSETS' }])
  })

  it('renders the Shipments children as Active, All and Intake', () => {
    const { pinned, sections } = buildNavSections({ divisions: FOUR, hasPageAccess: grants('tms') })
    render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/tms/shipments'] },
        createElement(
          TmsShell,
          {
            pinned,
            sections,
            activePath: '/tms/shipments',
            breadcrumb: [{ label: 'Shipments' }],
            user: { initial: 'R', email: 'ryne@bcatcorp.com' },
          },
          createElement('div', null, 'page body')
        )
      )
    )
    expect(screen.getByRole('link', { name: /^Company Dashboard$/ })).toHaveAttribute('href', '/tms/dashboard')
    expect(screen.getByRole('link', { name: 'Active' })).toHaveAttribute('href', '/tms/shipments')
    expect(screen.getByRole('link', { name: 'All' })).toHaveAttribute('href', '/tms/shipments?list=all')
    expect(screen.getByRole('link', { name: 'Intake' })).toHaveAttribute('href', '/tms/shipments/intake')
    expect(screen.queryByRole('link', { name: 'Dispatch' })).not.toBeInTheDocument()
  })

  it('has no Academy, Workflows or Dispatch row anywhere in the rail', () => {
    const { pinned, sections } = buildNavSections({ divisions: FOUR, hasPageAccess: () => false, isOwner: true })
    const hrefs = [...pinned, ...pinned.flatMap((i) => i.children ?? []), ...sections.flatMap((s) => s.items)].map((i) => i.to)
    for (const gone of ['/tms/academy', '/tms/workflows', '/tms/dispatch']) expect(hrefs).not.toContain(gone)
  })

  it('offers Intake review and Load review as grantable pages', () => {
    expect(PERMISSION_PAGES).toContainEqual({ key: 'intakeReview', label: 'Intake review' })
    expect(PERMISSION_PAGES).toContainEqual({ key: 'loadReview', label: 'Load review' })
  })

  it('gives a division with no pages of its own an intake link, but never the brokerage', () => {
    const withNew = [...FOUR, division({ code: 'FLATBED', name: 'Flatbed Division', sortOrder: 25 })]
    const { sections } = buildNavSections({ divisions: withNew, hasPageAccess: grants('tms') })
    expect(sections.map((s) => s.key)).toEqual(['FLATBED'])
    expect(sections[0].items).toEqual([{
      to: '/tms/shipments/intake?division=FLATBED',
      label: 'Intake · Flatbed Division',
      icon: expect.anything(),
      badge: null,
      pageKey: 'tms',
    }])
  })

  it('drops an inactive division and rolls a subsidiary up into its parent', () => {
    const divisions = [
      ...FOUR.map((d) => (d.code === 'CAR_SHIPPING' ? { ...d, active: false } : d)),
      division({ code: 'OWNER_OPERATOR', name: 'Owner Operators', parentId: 'ASSETS', sortOrder: 21 }),
    ]
    const { sections, businesses } = buildNavSections({ divisions, hasPageAccess: () => true })
    expect(sections.map((s) => s.key)).toEqual(['ASSETS', 'COMPANY'])
    expect(businesses.map((b) => b.key)).toEqual(['BROKERAGE', 'ASSETS'])
    // The subsidiary is not a section of its own; its pages belong to the fleet.
    expect(sections.find((s) => s.key === 'ASSETS')?.items.map((i) => i.label)).toContain('Owner Operator Settlements')
  })

  it('falls back to the seed divisions before the table has loaded', () => {
    const { sections } = buildNavSections({ divisions: null, hasPageAccess: () => true })
    expect(sections.map((s) => s.key)).toEqual(['ASSETS', 'CAR_SHIPPING', 'COMPANY'])
  })

  it('has a route behind every nav row (a row with no route is a dead link)', () => {
    const app = readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8')
    const defs = flatNavDefs()
    expect(defs.map((d) => d.label)).not.toContain('Accounting')
    expect(defs.map((d) => d.label)).not.toContain('Settings')
    for (const { to } of defs) {
      const path = to.split('?')[0]
      // Settings tabs are routed inside BrokeragePage; its own test walks its tab strip.
      if (path.startsWith('/tms/brokerage')) continue
      const relative = path.startsWith('/tms/') ? path.slice('/tms/'.length) : path
      expect(app, `no route for ${to}`).toContain(`path="${relative}"`)
    }
  })
})


describe('tmsBreadcrumb', () => {
  const labels = (path: string) => tmsBreadcrumb(path).map((c) => c.label)

  it('gives the intake queue and an intake load their own trail, not "Shipment"', () => {
    expect(labels('/tms/shipments/new')).toEqual(['Shipments', 'New shipment'])
    expect(labels('/tms/shipments/intake')).toEqual(['Shipments', 'Intake'])
    expect(labels('/tms/shipments/intake/abc')).toEqual(['Shipments', 'Intake', 'Load'])
    expect(tmsBreadcrumb('/tms/shipments/intake/abc')[1].to).toBe('/tms/shipments/intake')
  })

  it('files Load Tracking as one crumb, Customer links under it, and drops the retired pages', () => {
    expect(labels('/tms/tracking')).toEqual(['Load Tracking'])
    expect(labels('/tms/tracking/links')).toEqual(['Load Tracking', 'Customer links'])
  })

  it('files the money pages under Accounting, an invoice or bill under its list', () => {
    expect(labels('/tms/invoicing')).toEqual(['Accounting', 'Accounts Receivable'])
    expect(labels('/tms/invoicing/invoices/INV-1')).toEqual(['Accounting', 'Accounts Receivable', 'Invoice'])
    expect(tmsBreadcrumb('/tms/invoicing/invoices/INV-1')[1].to).toBe('/tms/invoicing')
    expect(labels('/tms/invoicing/payable')).toEqual(['Accounting', 'Accounts Payable'])
    expect(labels('/tms/invoicing/payable/bills/B-1')).toEqual(['Accounting', 'Accounts Payable', 'Bill'])
    expect(labels('/tms/vendors')).toEqual(['Accounting', 'Vendors'])
    expect(labels('/tms/factors')).toEqual(['Accounting', 'Factoring'])
  })

  it('names the quote pages without leaking an id', () => {
    expect(labels('/tms/rates')).toEqual(['Quotes'])
    expect(labels('/tms/rates/new')).toEqual(['Quotes', 'New quote'])
    expect(labels('/tms/rates/Q-12')).toEqual(['Quotes', 'Quote'])
    expect(labels('/tms/rates/spot/callback')).toEqual(['Quotes', 'Spot inbox'])
  })

  it('files every Settings page under Settings, with the sidebar label', () => {
    expect(labels('/tms/brokerage')).toEqual(['Settings', 'General & automation'])
    expect(labels('/tms/brokerage/users')).toEqual(['Settings', 'Users & roles'])
    expect(labels('/tms/brokerage/company/billing')).toEqual(['Settings', 'Company'])
    expect(labels('/tms/brokerage/integrations/quickbooks')).toEqual(['Settings', 'Integrations'])
    expect(labels('/compliance')).toEqual(['Settings', 'Compliance'])
    expect(labels('/platform-health')).toEqual(['Settings', 'Platform health'])
    expect(labels('/tms/workflows/runs/r1')).toEqual(['Settings', 'Workflows'])
  })

  it('names the item and one level below it, hiding ids behind Details', () => {
    expect(labels('/tms/customers/CUS-12')).toEqual(['Customers', 'Details'])
    expect(labels('/tms/customers/follow-ups')).toEqual(['Customers', 'Follow-ups'])
    expect(labels('/tms/shipments/SHP-1')).toEqual(['Shipments', 'Shipment'])
    expect(labels('/tms/carrier-sales')).toEqual(['Carrier Sales'])
    expect(labels('/tms/load-review')).toEqual(['Load Review'])
  })

  it('links every crumb but the last, and never links a group crumb', () => {
    const crumbs = tmsBreadcrumb('/tms/invoicing/payable/bills/B-1')
    expect(crumbs[0].to).toBeUndefined()
    expect(crumbs[1].to).toBe('/tms/invoicing/payable')
    expect(crumbs[crumbs.length - 1].to).toBeUndefined()
    expect(tmsBreadcrumb('/tms/shipments')).toEqual([{ label: 'Shipments' }])
  })

  it('falls back to TMS for an unknown /tms path', () => {
    expect(labels('/tms/nothing')).toEqual(['TMS'])
  })

  it('names legacy pages by their nav item or an explicit trail, never TMS', () => {
    expect(labels('/trucks')).toEqual(['Fleet'])
    expect(labels('/driver-pay')).toEqual(['Amazon Settlements'])
    expect(labels('/finances/review')).toEqual(['Finances', 'Profit review'])
    expect(labels('/driver-view/abc')).toEqual(['Owner operator pay', 'Driver app'])
    expect(labels('/some-new-page/x')).toEqual(['Some new page'])
  })
})

describe('companyOptions', () => {
  const sections = [{ key: 'BROKERAGE' }, { key: 'ASSETS' }, { key: 'COMPANY' }]

  it('offers one option per business in section order, never the COMPANY group', () => {
    expect(companyOptions(sections, null)).toEqual([
      { code: 'BROKERAGE', name: expect.any(String) },
      { code: 'ASSETS', name: expect.any(String) },
    ])
  })

  it('names a business from the division list and falls back to its code', () => {
    const named = companyOptions(sections, [{ code: 'ASSETS', name: 'Ivan Cartage' }])
    expect(named).toEqual([
      { code: 'BROKERAGE', name: 'BROKERAGE' },
      { code: 'ASSETS', name: 'Ivan Cartage' },
    ])
  })
})
