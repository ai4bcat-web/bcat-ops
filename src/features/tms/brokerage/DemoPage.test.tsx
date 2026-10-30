// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import '@testing-library/jest-dom/vitest'

import { DemoPage } from './DemoPage'
import { TmsShell } from '../TmsShell'
import * as apiClient from '@/lib/apiClient'
import * as authHook from '@/hooks/useAuth'

const DEMO_STATE_SEEDED = {
  seedVersion: 'p1-2026-10-29',
  seededAt: '2026-10-29T00:00:00Z',
  devStack: true,
  records: [
    { id: 'rec-1', kind: 'shipment', demoKey: 'shipment.open.assigned', recordId: 'shp-open', seedVersion: 'p1-2026-10-29', createdBy: 'seed', createdAt: '', updatedAt: '' },
    { id: 'rec-2', kind: 'customer', demoKey: 'customer.auto', recordId: 'cust-auto', seedVersion: 'p1-2026-10-29', createdBy: 'seed', createdAt: '', updatedAt: '' },
    { id: 'rec-3', kind: 'quote', demoKey: 'quote.inbound', recordId: 'quote-in', seedVersion: 'p1-2026-10-29', createdBy: 'seed', createdAt: '', updatedAt: '' },
    { id: 'rec-4', kind: 'shipment', demoKey: 'shipment.building', recordId: 'shp-build', seedVersion: 'p1-2026-10-29', createdBy: 'seed', createdAt: '', updatedAt: '' },
    { id: 'rec-5', kind: 'shipment', demoKey: 'shipment.posted', recordId: 'shp-post', seedVersion: 'p1-2026-10-29', createdBy: 'seed', createdAt: '', updatedAt: '' },
    { id: 'rec-6', kind: 'shipment', demoKey: 'shipment.intransit', recordId: 'shp-track', seedVersion: 'p1-2026-10-29', createdBy: 'seed', createdAt: '', updatedAt: '' },
    { id: 'rec-7', kind: 'shipment', demoKey: 'shipment.podflagged', recordId: 'shp-pod', seedVersion: 'p1-2026-10-29', createdBy: 'seed', createdAt: '', updatedAt: '' },
    { id: 'rec-8', kind: 'shipment', demoKey: 'shipment.readytobill', recordId: 'shp-bill', seedVersion: 'p1-2026-10-29', createdBy: 'seed', createdAt: '', updatedAt: '' },
  ],
  facts: {
    shipmentCount: 42,
    staffCount: 6,
    assignedCount: 1,
    customersWithFlowDefaults: 1,
    quotesWithMarketRate: 1,
    buildingShipments: 1,
    activePostings: 2,
    carrierOffers: 3,
    shipmentsWithThread: 1,
    checkCallMessages: 4,
    podReviews: 2,
    readyForBilling: 1,
    releasedToBilling: 0,
    seedVersion: 'p1-2026-10-29',
  },
}

const EMPTY_FACTS = {
  shipmentCount: 0,
  staffCount: 0,
  assignedCount: 0,
  customersWithFlowDefaults: 0,
  quotesWithMarketRate: 0,
  buildingShipments: 0,
  activePostings: 0,
  carrierOffers: 0,
  shipmentsWithThread: 0,
  checkCallMessages: 0,
  podReviews: 0,
  readyForBilling: 0,
  releasedToBilling: 0,
  seedVersion: null,
}

function renderDemo(auth: Partial<{
  user: { userId: string; email: string; groups: string[] } | null
  loading: boolean
  needsNewPassword: boolean
  login: (email: string, password: string) => Promise<unknown>
  completeNewPassword: (newPassword: string) => Promise<void>
  logout: () => Promise<void>
  isAdmin: boolean
  isOwner: boolean
  hasPageAccess: (pageKey: string) => boolean
}> = {}) {
  vi.spyOn(authHook, 'useAuth').mockReturnValue({
    user: { userId: 'owner@bcatcorp.com', email: 'owner@bcatcorp.com', groups: [] },
    loading: false,
    needsNewPassword: false,
    login: vi.fn(),
    completeNewPassword: vi.fn(),
    logout: vi.fn(),
    isAdmin: false,
    isOwner: true,
    hasPageAccess: () => true,
    ...(auth as authHook.AuthContextValue),
  })
  return render(
    <BrowserRouter>
      <DemoPage />
    </BrowserRouter>,
  )
}

describe('DemoPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('renders all eleven steps in order with their titles', async () => {
    vi.spyOn(apiClient, 'getDemoState').mockResolvedValue(DEMO_STATE_SEEDED)
    renderDemo()
    await waitFor(() => expect(screen.getByText('End-to-end demo')).toBeInTheDocument())
    const titles = screen.getAllByRole('heading', { level: 3 })
    expect(titles.map((h) => h.textContent)).toEqual([
      'Seeded data',
      'Assign a carrier rep or team',
      'Customer flow defaults',
      'Quote in, rate out',
      'Tender to a built load',
      'Post to DAT and Truckstop',
      'Carrier answers the posting',
      'Rate con, thread and tracking',
      'POD requested and reviewed',
      'Release to billing',
      'Run it again',
    ])
  })

  it('ticks a step only when the facts say so', async () => {
    vi.spyOn(apiClient, 'getDemoState').mockResolvedValue({
      ...DEMO_STATE_SEEDED,
      facts: { ...EMPTY_FACTS, shipmentCount: 42, staffCount: 6, assignedCount: 0 },
    })
    renderDemo()
    await waitFor(() => expect(screen.getByText('Seeded data')).toBeInTheDocument())
    const seeded = screen.getByText('Seeded data').closest('.tms-demo-step') as HTMLElement
    const p2 = screen.getByText('Assign a carrier rep or team').closest('.tms-demo-step') as HTMLElement
    expect(seeded.querySelector('.tms-demo-tick:not(.tms-demo-tick-off)')).toBeInTheDocument()
    expect(p2.querySelector('.tms-demo-tick-off')).toBeInTheDocument()
  })

  it('disables the open button and explains when the seeded record is missing', async () => {
    vi.spyOn(apiClient, 'getDemoState').mockResolvedValue({
      ...DEMO_STATE_SEEDED,
      records: [],
    })
    renderDemo()
    await waitFor(() => expect(screen.getByText('Assign a carrier rep or team')).toBeInTheDocument())
    const p2 = screen.getByText('Assign a carrier rep or team').closest('.tms-demo-step') as HTMLElement
    const btn = within(p2).getByRole('button', { name: /open/i })
    expect(btn).toBeDisabled()
    expect(within(p2).getByText(/seeded record not found/i)).toBeInTheDocument()
  })

  it('shows Reset for an owner on dev and confirms before resetting', async () => {
    vi.spyOn(apiClient, 'getDemoState').mockResolvedValue(DEMO_STATE_SEEDED)
    const resetSpy = vi.spyOn(apiClient, 'resetDemoData').mockResolvedValue({ counts: {}, seedVersion: 'p1-2026-10-29' })
    renderDemo()
    await waitFor(() => expect(screen.getByText('Reset demo data')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Reset demo data'))
    expect(screen.getByText('Reset demo data?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^reset$/i }))
    await waitFor(() => expect(resetSpy).toHaveBeenCalled())
  })

  it('hides Reset for a non-admin and shows why', async () => {
    vi.spyOn(apiClient, 'getDemoState').mockResolvedValue(DEMO_STATE_SEEDED)
    renderDemo({ isOwner: false, isAdmin: false })
    await waitFor(() => expect(screen.getByText('End-to-end demo')).toBeInTheDocument())
    expect(screen.queryByText('Reset demo data')).not.toBeInTheDocument()
    expect(screen.queryByText('Seed demo data')).not.toBeInTheDocument()
    expect(screen.getByText(/owner\/ADMIN only/i)).toBeInTheDocument()
  })

  it('hides Reset off the dev stack and shows why', async () => {
    vi.spyOn(apiClient, 'getDemoState').mockResolvedValue({ ...DEMO_STATE_SEEDED, devStack: false })
    renderDemo()
    await waitFor(() => expect(screen.getByText('End-to-end demo')).toBeInTheDocument())
    expect(screen.queryByText('Reset demo data')).not.toBeInTheDocument()
    expect(screen.getByText(/not the dev stack/i)).toBeInTheDocument()
  })

  it('shows Seed demo data when nothing is seeded', async () => {
    vi.spyOn(apiClient, 'getDemoState').mockResolvedValue({
      ...DEMO_STATE_SEEDED,
      seedVersion: null,
      seededAt: null,
      facts: EMPTY_FACTS,
      records: [],
    })
    const seedSpy = vi.spyOn(apiClient, 'seedDemoData').mockResolvedValue({ counts: {}, seedVersion: 'p1-2026-10-29' })
    renderDemo()
    await waitFor(() => expect(screen.getByText('Seed demo data')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Seed demo data'))
    await waitFor(() => expect(seedSpy).toHaveBeenCalled())
  })
})

describe('TmsShell badge counts', () => {
  it('renders a numeric badge on My queue when the count is greater than zero', () => {
    render(
      <BrowserRouter>
        <TmsShell
          pinned={[
            {
              to: '/tms/shipments',
              label: 'Shipments',
              icon: () => null,
              children: [
                { to: '/tms/shipments/view/my-queue', label: 'My queue', badgeKey: 'myQueue' },
                { to: '/tms/shipments/view/team-queue', label: 'Team queue', badgeKey: 'teamQueue' },
              ],
            },
          ]}
          sections={[]}
          activePath="/tms/shipments"
          pageTitle="TMS"
          user={{ initial: 'O', email: 'owner@bcatcorp.com' }}
          shipmentViews={[]}
          badgeCounts={{ myQueue: 3, teamQueue: 0 }}
        />
      </BrowserRouter>,
    )
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('renders no badge when the count is zero', () => {
    render(
      <BrowserRouter>
        <TmsShell
          pinned={[
            {
              to: '/tms/shipments',
              label: 'Shipments',
              icon: () => null,
              children: [
                { to: '/tms/shipments/view/my-queue', label: 'My queue', badgeKey: 'myQueue' },
              ],
            },
          ]}
          sections={[]}
          activePath="/tms/shipments"
          pageTitle="TMS"
          user={{ initial: 'O', email: 'owner@bcatcorp.com' }}
          shipmentViews={[]}
          badgeCounts={{ myQueue: 0 }}
        />
      </BrowserRouter>,
    )
    const child = screen.getByText('My queue').closest('a') as HTMLElement
    expect(within(child).queryByText('0')).not.toBeInTheDocument()
  })
})
