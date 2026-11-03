// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { FinancialOps } from './useFinancialOps'
import { FinancialOperationsPage } from './FinancialOperationsPage'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver

vi.mock('@/lib/apiClient', () => ({ getRemittancePdfUrl: vi.fn() }))

const state = vi.hoisted(() => ({ ops: null as unknown as FinancialOps }))
vi.mock('./useFinancialOps', () => ({ useFinancialOps: () => state.ops }))

const base: FinancialOps = {
  loading: false,
  errors: [],
  failedMonths: [],
  window: { from: '2026-10-01', to: '2026-10-20', previous: { from: '2026-09-11', to: '2026-09-30' } },
  kpis: {
    avgMarginCents: 20_00, marginBps: 2000, ownFleetCount: 0, shipmentsCompleted: 7, pendingPayoutsCents: 350_00,
    pendingBillCount: 2, creditsCents: 5_00, writeOffsCents: 2_00, revenueCents: 600_00,
  },
  deltas: { avgMargin: null, completed: null, credits: null },
  divisions: [{ key: 'BROKERAGE', label: 'BCAT Logistics', revenueCents: 600_00 }],
  weekly: { series: [{ key: 'BROKERAGE', label: 'BCAT Logistics' }], weeks: [{ start: '2026-10-12', label: 'Oct 12', values: { BROKERAGE: 600_00 } }], currentIndex: 0 },
  target: { targetCents: 500_00, monthlyAverageCents: 500_00, basisMonths: 3 },
  payments: [{
    id: 'p1', type: 'AP', at: '2026-10-10T12:00:00.000Z', counterparty: 'Fast Freight', reference: null, method: 'ACH',
    amountCents: -50_00, status: 'REMITTED', pdfKey: 'remittances/p1.pdf',
  }],
  paymentsLoaded: true,
  refresh: vi.fn(),
}

const renderPage = (over: Partial<FinancialOps> = {}) => {
  state.ops = { ...base, ...over }
  return render(<MemoryRouter><FinancialOperationsPage /></MemoryRouter>)
}

describe('FinancialOperationsPage', () => {
  it('prints the lib figures and the ledger row, with a remittance download only where a PDF exists', () => {
    renderPage()
    const strip = screen.getByRole('group', { name: 'Key figures' })
    expect(within(strip).getByText('$20.00')).toBeInTheDocument()
    expect(within(strip).getByText('7')).toBeInTheDocument()
    expect(within(strip).getByText('$350.00')).toBeInTheDocument()
    expect(screen.getByText('Remitted')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /remittance advice for Fast Freight/ })).toBeInTheDocument()
  })

  it('names the months a read failed for instead of presenting partial numbers silently', () => {
    renderPage({ failedMonths: [{ month: '2026-09', message: 'boom' }] })
    expect(screen.getByRole('alert')).toHaveTextContent('Sep 2026')
  })

  it('names a failed ledger read, shows credits as unknown and hides the empty payments table', () => {
    renderPage({ errors: ['Payments: AppSync refused'], paymentsLoaded: false, payments: [] })
    expect(screen.getByRole('alert')).toHaveTextContent('Payments: AppSync refused')
    expect(screen.getByText('Payments unavailable')).toBeInTheDocument()
    expect(screen.queryByText('Payment transactions')).not.toBeInTheDocument()
  })
})
