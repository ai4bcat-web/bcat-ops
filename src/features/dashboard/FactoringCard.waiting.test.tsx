// @vitest-environment jsdom
/**
 * The dashboard's Factoring card says "Waiting on OTR approval" with the shared definition
 * (src/lib/factoredOpen.ts): OTR-approved rows still sitting at PENDING_WITH_OTR, and refused
 * rows, are not waiting; the money is the open invoice balance.
 */
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { FactoringItem } from '@/types'
import { DashboardPage } from './DashboardPage'

const items = [
  { id: 'f1', status: 'PENDING_WITH_OTR', otrStatus: '1', otrAmount: 100_000, proNumber: '1' },
  // OTR approved it (status 3): no longer waiting, even though the row has not moved yet.
  { id: 'f2', status: 'PENDING_WITH_OTR', otrStatus: '3', otrAmount: 200_000, proNumber: '2' },
  { id: 'f3', status: 'PENDING_WITH_OTR', otrStatus: '1', otrAmount: 50_000, proNumber: '3', otrReadiness: { payload: { InvoiceAmount: 500 } } },
] as unknown as FactoringItem[]

vi.mock('@/hooks/useFactoringItems', () => ({ useFactoringItems: () => ({ items, loading: false }) }))
vi.mock('@/hooks/useOpenInvoices', () => ({
  useOpenInvoices: () => ({
    invoices: [{ id: 'i1', factoringItemId: 'f1', status: 'ISSUED', balanceCents: 123_400 }],
    loading: false, error: null, refresh: vi.fn(),
  }),
}))
vi.mock('@/hooks/useLoads', () => ({ useLoads: () => ({ loads: [] }) }))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ hasPageAccess: () => false, isAdmin: false }) }))
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }))
vi.mock('./useLegacyDashboardKpis', () => ({ useLegacyDashboardKpis: () => ({ kpis: null, state: 'loading', source: null, asOf: null, flips: 0 }) }))
vi.mock('./useBatoryApptCount', () => ({ useBatoryApptCount: () => 0 }))
vi.mock('./VendorApCard', () => ({ VendorApCard: () => null }))
vi.mock('@/lib/apiClient', () => ({}))

describe('dashboard Factoring card', () => {
  it('counts Waiting on OTR approval with the shared definition and open balances', async () => {
    render(<MemoryRouter><DashboardPage /></MemoryRouter>)
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const row = screen.getByText('Waiting on OTR approval').closest('div') as HTMLElement
    // f1 at its open balance ($1,234) + f3 at what was sent ($500); f2 is approved, not waiting.
    expect(row).toHaveTextContent('2')
    expect(row).toHaveTextContent('$1,734')
    expect(screen.queryByText('Pending with OTR')).toBeNull()
  })
})
