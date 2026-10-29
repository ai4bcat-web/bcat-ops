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
import { buildNavSections, PINNED_ITEMS, TMS_ITEMS, tmsPageTitle } from './navSections'
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
            pageTitle: 'Shipments',
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
            pageTitle: 'Shipments',
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

  it('falls back to the seed divisions before the table has loaded', () => {
    const { sections } = buildNavSections({ divisions: null, hasPageAccess: () => true })
    expect(sections.map((s) => s.key)).toEqual(['BROKERAGE', 'ASSETS', 'CAR_SHIPPING', 'COMPANY'])
  })
})

describe('tmsPageTitle', () => {
  it('names the page a TMS path belongs to, deepest match first', () => {
    expect(tmsPageTitle('/tms/shipments')).toBe('Shipments')
    expect(tmsPageTitle('/tms/shipments/SHP-1')).toBe('Shipments')
    expect(tmsPageTitle('/tms/invoicing/payable/bills/B-1')).toBe('Invoicing')
    expect(tmsPageTitle('/tms/brokerage/users')).toBe('My Brokerage')
    expect(tmsPageTitle('/tms/nothing')).toBe('TMS')
  })
})
