// @vitest-environment jsdom
/**
 * The sidebar is now the org chart: three businesses plus the company, built from
 * division rows. What breaks silently here is access — a Brokerage grant that leaks the
 * fleet's pages into somebody's rail, or a division that has no pages of its own
 * vanishing instead of showing its shipments.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router-dom'
import { createElement } from 'react'
import { buildNavSections, companyOptions, PINNED_ITEMS, TMS_ITEMS, tmsBreadcrumb } from './navSections'
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
  it('pins Company Dashboard first and Shipments second, and keeps its view children working', () => {
    const { pinned, sections } = buildNavSections({ divisions: FOUR, hasPageAccess: grants('tms') })

    // Company Dashboard is the top-level home; Shipments is the shared freight list.
    // Neither item also lives inside a business section.
    expect(pinned.map((i) => i.label)).toEqual(['Company Dashboard', 'Shipments'])
    expect(pinned[0].to).toBe('/tms/dashboard')
    expect(pinned[1].to).toBe('/tms/shipments')
    for (const section of sections) {
      expect(section.items.some((i) => i.to === '/tms/dashboard')).toBe(false)
      expect(section.items.some((i) => i.to === '/tms/shipments')).toBe(false)
    }

    // The Shipments row renders fixed workstation pages first, then saved views under
    // a labelled group.
    const views = [
      { slug: 'brokerage-board', name: 'Brokerage Board' },
      { slug: 'car-shipping', name: 'Car Shipping Board' },
    ]
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
            shipmentViews: views,
          },
          createElement('div', null, 'page body')
        )
      )
    )
    expect(screen.getByRole('link', { name: /^Company Dashboard$/ })).toHaveAttribute('href', '/tms/dashboard')
    expect(screen.getByRole('link', { name: /^Shipments$/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Active Shipments' })).toHaveAttribute('href', '/tms/shipments')
    expect(screen.getByRole('link', { name: 'Dispatch' })).toHaveAttribute('href', '/tms/dispatch')
    expect(screen.getByRole('link', { name: 'Tracking' })).toHaveAttribute('href', '/tms/tracking')
    expect(screen.getByRole('link', { name: 'Documents' })).toHaveAttribute('href', '/tms/documents')
    expect(screen.getByRole('link', { name: 'Brokerage Board' })).toHaveAttribute(
      'href',
      '/tms/shipments/view/brokerage-board'
    )
    expect(screen.getByRole('link', { name: 'Car Shipping Board' })).toHaveAttribute(
      'href',
      '/tms/shipments/view/car-shipping'
    )
  })

  it('opens the whole Brokerage section on the one `tms` grant, and nothing else', () => {
    const { pinned, sections } = buildNavSections({ divisions: FOUR, hasPageAccess: grants('tms') })
    expect(pinned.map((i) => i.label)).toEqual(['Company Dashboard', 'Shipments'])
    expect(sections.map((s) => s.key)).toEqual(['BROKERAGE'])
    expect(sections[0].items.map((i) => i.to)).toEqual(TMS_ITEMS.map((i) => i.to))
    expect(sections[0].items.some((i) => i.label === 'Dashboard')).toBe(false)
    expect(sections[0].brand).toBe('BCAT Logistics')
  })

  it('still opens a Brokerage page on its original grant alone', () => {
    const { pinned, sections } = buildNavSections({ divisions: FOUR, hasPageAccess: grants('carriers') })
    expect(sections.map((s) => s.key)).toEqual(['BROKERAGE'])
    expect(sections[0].items.map((i) => i.label)).toEqual(['Carriers'])
    // A carrier-only grant does not open Shipments.
    expect(pinned).toEqual([])
  })

  it('gives the owner all four sections, Company last', () => {
    const { pinned, sections } = buildNavSections({ divisions: FOUR, hasPageAccess: () => false, isOwner: true })
    expect(sections.map((s) => s.key)).toEqual(['BROKERAGE', 'ASSETS', 'CAR_SHIPPING', 'COMPANY'])
    expect(sections[3].items.map((i) => i.label)).toContain('Finances')
    // The header reads as a business name, not as a code: `CAR SHIPPING [Best Care Auto Transport]`.
    expect(sections[2].name).toBe('CAR SHIPPING')
    expect(sections[2].brand).toBe('Best Care Auto Transport')
    expect(pinned.map((i) => i.to)).toEqual(PINNED_ITEMS.map((i) => i.to))
  })

  it('keeps a fleet user out of the Brokerage section', () => {
    const { pinned, sections } = buildNavSections({ divisions: FOUR, hasPageAccess: grants('calendar', 'trucks') })
    expect(sections.map((s) => s.key)).toEqual(['ASSETS'])
    expect(sections[0].items.map((i) => i.label)).toEqual(['Calendar', 'Fleet'])
    // Fleet-only access does not open Shipments.
    expect(pinned).toEqual([])
  })

  it('shows Shipments and its workstation children to a shared-loads grant', () => {
    const { pinned, sections } = buildNavSections({ divisions: FOUR, hasPageAccess: grants('loads') })
    // Shipments is still reachable for the same people; it just lives in pinned now.
    // Company Dashboard is not visible on `loads` alone.
    expect(pinned.map((i) => i.label)).toEqual(['Shipments'])
    // No other Brokerage page leaks through.
    expect(sections).toEqual([])

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
            shipmentViews: [{ slug: 'local', name: 'Local Drivers' }],
          },
          createElement('div', null, 'page body')
        )
      )
    )
    expect(screen.getByRole('link', { name: 'Active Shipments' })).toHaveAttribute('href', '/tms/shipments')
    expect(screen.getByRole('link', { name: 'Dispatch' })).toHaveAttribute('href', '/tms/dispatch')
    expect(screen.getByRole('link', { name: 'Local Drivers' })).toHaveAttribute('href', '/tms/shipments/view/local')
  })

  it('gives a division with no pages of its own a shipments link', () => {
    const withNew = [...FOUR, division({ code: 'FLATBED', name: 'Flatbed Division', sortOrder: 25 })]
    const { pinned, sections } = buildNavSections({ divisions: withNew, hasPageAccess: grants('tms') })
    const flatbed = sections.find((s) => s.key === 'FLATBED')
    expect(flatbed?.items).toEqual([{
      to: '/tms/shipments/view/division-FLATBED',
      label: 'Shipments · Flatbed Division',
      icon: expect.anything(),
      badge: null,
      pageKey: 'tms',
    }])
    expect(pinned.map((i) => i.to)).toEqual(PINNED_ITEMS.map((i) => i.to))
  })

  it('drops an inactive division and rolls a subsidiary up into its parent', () => {
    const divisions = [
      ...FOUR.map((d) => (d.code === 'CAR_SHIPPING' ? { ...d, active: false } : d)),
      division({ code: 'OWNER_OPERATOR', name: 'Owner Operators', parentId: 'ASSETS', sortOrder: 21 }),
    ]
    const { sections } = buildNavSections({ divisions, hasPageAccess: () => true })
    expect(sections.map((s) => s.key)).toEqual(['BROKERAGE', 'ASSETS', 'COMPANY'])
    // The subsidiary is not a section of its own; its pages belong to the fleet.
    expect(sections.find((s) => s.key === 'ASSETS')?.items.map((i) => i.label)).toContain('Owner Operator Settlements')
  })

  describe('S4 pages', () => {
    const labelsOf = (opts: Omit<Parameters<typeof buildNavSections>[0], 'divisions'>) =>
      buildNavSections({ divisions: FOUR, ...opts }).sections.flatMap((s) => s.items.map((i) => i.label))

    it('shows the four new pages to an admin', () => {
      const all = labelsOf({ hasPageAccess: () => false, isAdmin: true })
      expect(all).toEqual(expect.arrayContaining(['Compliance', 'Financial operations', 'Expenses', 'Platform health']))
    })

    it('never shows Platform health to a non-admin, whatever pages they are granted', () => {
      const everyGrant = new Set(PERMISSION_PAGES.map((p) => p.key))
      const all = labelsOf({ hasPageAccess: (k) => everyGrant.has(k) })
      expect(all).toContain('Compliance')
      expect(all).not.toContain('Platform health')
    })

    it('shows Compliance for the compliance grant but not for a files-only grant (that user reaches it by route)', () => {
      expect(labelsOf({ hasPageAccess: grants('compliance') })).toContain('Compliance')
      expect(labelsOf({ hasPageAccess: grants('files') })).not.toContain('Compliance')
    })
  })

  it('falls back to the seed divisions before the table has loaded', () => {
    const { sections } = buildNavSections({ divisions: null, hasPageAccess: () => true })
    expect(sections.map((s) => s.key)).toEqual(['BROKERAGE', 'ASSETS', 'CAR_SHIPPING', 'COMPANY'])
  })
})

describe('tmsBreadcrumb', () => {
  const labels = (path: string, views?: Array<{ slug: string; name: string }>) =>
    tmsBreadcrumb(path, views).map((c) => c.label)

  it('puts a saved view under Shipments, by its name', () => {
    expect(labels('/tms/shipments/view/my-queue', [{ slug: 'my-queue', name: 'My queue' }])).toEqual(['Shipments', 'My queue'])
    expect(labels('/tms/shipments/view/pod-collection')).toEqual(['Shipments', 'Pod collection'])
  })

  it('files the workstation pages under Shipments', () => {
    expect(labels('/tms/dispatch')).toEqual(['Shipments', 'Dispatch'])
    expect(labels('/tms/check-calls')).toEqual(['Shipments', 'Check calls'])
    expect(labels('/tms/tracking/links')).toEqual(['Shipments', 'Tracking', 'Manage links'])
    expect(tmsBreadcrumb('/tms/tracking/links')[1].to).toBe('/tms/tracking')
  })

  it('names the item and one level below it, hiding ids behind Details', () => {
    expect(labels('/tms/invoicing/payable/bills/B-1')).toEqual(['Invoicing', 'Payable'])
    expect(labels('/tms/customers/CUS-12')).toEqual(['Customers', 'Details'])
    expect(labels('/tms/shipments/SHP-1')).toEqual(['Shipments', 'Shipment'])
    expect(labels('/tms/brokerage/users')).toEqual(['My Brokerage', 'Users'])
  })

  it('links every crumb but the last', () => {
    const crumbs = tmsBreadcrumb('/tms/invoicing/payable')
    expect(crumbs[0].to).toBe('/tms/invoicing')
    expect(crumbs[crumbs.length - 1].to).toBeUndefined()
    expect(tmsBreadcrumb('/tms/shipments')).toEqual([{ label: 'Shipments' }])
  })

  it('falls back to TMS for an unknown /tms path', () => {
    expect(labels('/tms/nothing')).toEqual(['TMS'])
  })

  it('titles /compliance as the Document overview', () => {
    expect(labels('/compliance')).toEqual(['Compliance', 'Document overview'])
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
