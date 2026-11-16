// @vitest-environment jsdom
/**
 * The dashboard's Payables cards must read the same numbers as the Payable view's cards
 * (Ryne 2026-11-15). Both are rendered from one fixture and the cards' text compared.
 */
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { CarrierBillRecord } from '@/types/tms'
import { ageOpenItems } from '@/lib/arAging'
import { chicagoDateStr } from '@/lib/date'
import { ApPage } from '@/features/ap/ApPage'
import { PayablesCard } from './AccountingSection'

const openBillsMock = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/useApWorklist', () => ({ useApWorklist: () => ({ rows: [], loading: false, error: null, refresh: vi.fn().mockResolvedValue(undefined) }) }))
vi.mock('@/hooks/useOpenBills', () => ({ useOpenBills: openBillsMock }))
vi.mock('@/hooks/useCarrierAp', () => ({ useCarrierAp: () => ({ rows: [], payments: [], loading: false, error: null, refresh: vi.fn().mockResolvedValue(undefined) }) }))
vi.mock('@/features/ap/useBillFacts', () => ({
  useBillFacts: () => ({
    facts: { get: () => ({ shipmentNumber: 'S-1001', po: 'PO-77', deliveredAt: '2026-10-20T12:00:00.000Z', delivered: true }) },
    loading: false,
  }),
}))
vi.mock('@/hooks/useCarriers', () => ({ useCarriers: () => ({ carriers: [], loading: false, error: null, refresh: vi.fn(), replace: vi.fn() }) }))
vi.mock('@/hooks/useAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useAuth')>()),
  useAuth: () => ({ isAdmin: false, isOwner: false, hasPageAccess: () => true }),
}))
vi.mock('@/features/finance/useNeedsReview', () => ({ useNeedsReview: () => ({ rows: [], error: null, refresh: vi.fn() }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() } }))
vi.mock('@/features/ap/inbox/useApInbox', () => ({
  useApInboxStatus: () => ({ status: null, error: null, refresh: vi.fn().mockResolvedValue(undefined), syncing: false, progress: null, syncNow: vi.fn() }),
  useApInboxItems: () => ({ items: [], loading: false, error: null, refresh: vi.fn().mockResolvedValue(undefined) }),
}))
vi.mock('@/lib/apiClient', () => ({
  graphqlErrorText: (e: unknown) => String(e),
  getTmsSettings: vi.fn().mockResolvedValue({ apRequireSignedRateCon: true }),
  listBillsByMonth: vi.fn().mockResolvedValue([]),
  listOwnershipDivisions: vi.fn().mockResolvedValue([]),
  listCarrierPaymentInfo: vi.fn().mockResolvedValue([]),
}))

const TODAY = chicagoDateStr(new Date())
const daysAgo = (days: number) => {
  const [y, m, d] = TODAY.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10)
}

function bill(id: string, patch: Partial<CarrierBillRecord> = {}): CarrierBillRecord {
  return {
    id, loadCarrierId: `lc-${id}`, loadId: 'l1', shipmentId: 's1', shipmentNumber: 'S-1001', carrierId: 'car1', carrierName: 'Blue Line Trucking',
    payeeKind: 'CARRIER', remitTo: { name: 'Blue Line Trucking', method: 'ACH' }, status: 'TO_BE_PAID', billNumber: id,
    billDate: daysAgo(40), billMonth: daysAgo(40).slice(0, 7), recordedAt: '2026-10-21T12:00:00.000Z', recordedBy: 'r', dueAt: daysAgo(10), termsDays: 30,
    grossCents: 150_000, quickPayFeeCents: 0, netCents: 150_000, billedCents: 150_000, varianceCents: 0, paidCents: 0, creditedCents: 0, balanceCents: 150_000,
    apOpen: 'OPEN', createdBy: 'r', updatedBy: 'r', version: 1,
    ...patch,
  }
}

const bills = [
  bill('b1'),
  bill('b2', { status: 'IN_REVIEW', datesPending: true, balanceCents: 80_000, netCents: 80_000, grossCents: 80_000, billedCents: 80_000 } as Partial<CarrierBillRecord>),
  bill('b3', { createdBy: 'aljex-import', dueAt: daysAgo(-5), balanceCents: 42_000, netCents: 42_000, grossCents: 42_000, billedCents: 42_000 }),
]

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

beforeEach(() => {
  localStorage.setItem('ap.payables.cards', 'open')
  openBillsMock.mockReturnValue({
    bills,
    aging: ageOpenItems(bills.map((b) => ({ partyId: b.carrierId, partyName: b.carrierName ?? '', dueAt: b.dueAt, balanceCents: b.balanceCents })), TODAY),
    approvedCents: 0, loading: false, error: null, refresh: vi.fn().mockResolvedValue(undefined),
  })
})

describe('dashboard Accounts payable card', () => {
  it('reads the same figures as the Payable view', async () => {
    const { unmount } = render(<MemoryRouter><ApPage /></MemoryRouter>)
    await settle()
    const page: Record<string, string> = {}
    for (const li of screen.getByTestId('ap-summary').querySelectorAll('li')) {
      const label = li.querySelector('.tms-list-row-label')?.firstChild?.textContent?.trim() ?? ''
      page[label] = (li.querySelector('.tms-list-row-value')?.textContent ?? '').replace(/\.\d\d$/, '')
    }
    unmount()
    render(<MemoryRouter><PayablesCard /></MemoryRouter>)
    await settle()
    expect(screen.getByTestId('dashboard-ap-card')).toHaveTextContent(page['Open AP'])
    // Every open bill, Aljex ones included: 1,500 + 800 + 420.
    expect(page['Open AP']).toBe('$2,720')
    for (const [key, label] of [['expected', 'Expected'], ['aging', 'Aging'], ['past-due', 'Past due'], ['next7', 'Due next 7 days']] as const) {
      expect(screen.getByTestId(`summary-row-${key}`)).toHaveTextContent(page[label])
    }
  })
})
