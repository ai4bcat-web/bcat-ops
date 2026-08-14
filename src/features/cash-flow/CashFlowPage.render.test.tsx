// @vitest-environment jsdom
/**
 * Smoke tests that the Cash Flow page actually RENDERS and shows the reference numbers.
 *
 * cashFlow.test.ts already proves the math. What it can't catch is the page throwing on
 * mount — a hook called conditionally, a map over something undefined — which leaves the
 * user a blank screen while the suite stays green. These tests mount the real component
 * tree with only the network edge stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver

// The two CashFlow* tables are the page's only network edge. Empty responses mean the
// page falls back to the seeded inputs — which is exactly the first-load experience.
const listWeeks = vi.fn().mockResolvedValue([])
const getCurrent = vi.fn().mockResolvedValue(null)

vi.mock('@/lib/cashFlowClient', () => ({
  getCurrentCashFlowInputs: () => getCurrent(),
  listCashFlowWeeks: () => listWeeks(),
  createCashFlowInputs: vi.fn(),
  updateCashFlowInputs: vi.fn(),
  createCashFlowWeek: vi.fn(),
  deleteCashFlowWeek: vi.fn(),
  isSchemaMissingError: () => false,
}))

vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }))

import { CashFlowPage } from './CashFlowPage'

beforeEach(() => {
  vi.clearAllMocks()
  getCurrent.mockResolvedValue(null)
  listWeeks.mockResolvedValue([])
})

describe('CashFlowPage', () => {
  it('mounts without throwing and renders all three sections', async () => {
    render(<CashFlowPage />)

    expect(await screen.findByRole('heading', { name: 'Cash Flow' })).toBeTruthy()
    expect(screen.getByText("This week's inputs")).toBeTruthy()
    expect(screen.getAllByText('Runway').length).toBeGreaterThanOrEqual(2) // heading + card
    expect(screen.getByText('Weekly log')).toBeTruthy()
  })

  it('renders populated from the seed values on first load', async () => {
    render(<CashFlowPage />)
    await screen.findByRole('heading', { name: 'Cash Flow' })

    // Money inputs show dollars, not cents.
    expect((screen.getByLabelText('Cash — BCAT') as HTMLInputElement).value).toBe('24350')
    expect((screen.getByLabelText('Cash — IVAN') as HTMLInputElement).value).toBe('51764')
    expect((screen.getByLabelText('30-day AR') as HTMLInputElement).value).toBe('220000')
    expect((screen.getByLabelText('120-day AR collection rate') as HTMLInputElement).value).toBe('90')
  })

  it('shows the computed input totals', async () => {
    render(<CashFlowPage />)
    await screen.findByRole('heading', { name: 'Cash Flow' })

    // Total cash appears twice by design: the computed row, and the runway stat.
    expect(screen.getAllByText('$76,114').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('$90,502')).toBeTruthy()
  })

  it('answers "how long do I have" as the headline', async () => {
    render(<CashFlowPage />)
    await screen.findByRole('heading', { name: 'Cash Flow' })

    // Seeded: 220k in, 205k out — +15k a steady month, so the cash never runs out.
    expect(screen.getByText('No limit')).toBeTruthy()
    expect(screen.getByText(/a steady month adds \$15,000/)).toBeTruthy()
    expect(screen.getByText('Added per steady month')).toBeTruthy()
    expect(screen.getByText('Not within 5 years')).toBeTruthy()
  })

  it('reports a finite runway and the month it ends when burning', async () => {
    getCurrent.mockResolvedValue({
      id: 'r1', weekOf: '2026-08-12', isCurrent: true,
      cashBcatCents: 2_435_000, cashIvanCents: 5_176_400,
      ar30Cents: 22_000_000, ar120Cents: 7_000_000, ar120CollectionRate: 0.9,
      apBcatAgingCents: 7_630_200, apBcatExpectedCents: 620_000, apBcatAmexCents: 450_000,
      apIvanCcCents: 0, apIvanMiscCents: 350_000,
      // Costs above revenue → the balance falls every steady month.
      recurringRevenueCents: 10_000_000, recurringExpensesCents: 20_500_000,
      minCashThresholdCents: 0, createdAt: '', updatedAt: '',
    })

    render(<CashFlowPage />)
    await screen.findByRole('heading', { name: 'Cash Flow' })

    expect(screen.getByText('Burn per steady month')).toBeTruthy()
    expect(screen.getByText('$105,000')).toBeTruthy()
    expect(screen.getByText(/cash drops below your floor in/)).toBeTruthy()
  })

  it('explains how runway is worked out rather than leaving it a black box', async () => {
    render(<CashFlowPage />)
    await screen.findByRole('heading', { name: 'Cash Flow' })

    expect(screen.getByText(/How runway is worked out/)).toBeTruthy()
    expect(screen.getByText(/first two months aren't typical/)).toBeTruthy()
  })

  it('offers a payables stagger and defaults to paying now', async () => {
    render(<CashFlowPage />)
    await screen.findByRole('heading', { name: 'Cash Flow' })

    const now = screen.getByLabelText('Spread payables over 1 month')
    expect(now.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByLabelText('Spread payables over 3 months')).toBeTruthy()
  })

  it('suggests a spread when a recoverable dip could be smoothed away', async () => {
    getCurrent.mockResolvedValue({
      id: 'r1', weekOf: '2026-08-12', isCurrent: true,
      cashBcatCents: 2_435_000, cashIvanCents: 5_176_400,
      ar30Cents: 22_000_000, ar120Cents: 7_000_000, ar120CollectionRate: 0.9,
      apBcatAgingCents: 7_630_200, apBcatExpectedCents: 620_000, apBcatAmexCents: 450_000,
      apIvanCcCents: 0, apIvanMiscCents: 350_000,
      recurringRevenueCents: 22_000_000, recurringExpensesCents: 20_500_000,
      payablesSpreadMonths: 1,
      minCashThresholdCents: 5_000_000,   // $50k floor — the $612 August trough breaches it
      createdAt: '', updatedAt: '',
    })

    render(<CashFlowPage />)
    await screen.findByRole('heading', { name: 'Cash Flow' })

    expect(screen.getByText(/dips below your floor in Aug 2026/)).toBeTruthy()
    expect(screen.getByText(/Spreading the payables over/)).toBeTruthy()
    expect(screen.getByText('3 months')).toBeTruthy()
  })

  it('invites the first log entry when no weeks are recorded', async () => {
    render(<CashFlowPage />)
    await screen.findByRole('heading', { name: 'Cash Flow' })

    expect(screen.getByText(/No weeks logged yet/)).toBeTruthy()
  })

  it('warns instead of failing when the tables are not deployed yet', async () => {
    getCurrent.mockRejectedValue(new Error('Cannot query field "listCashFlowInputs"'))
    listWeeks.mockRejectedValue(new Error('Cannot query field "listCashFlowWeekLogs"'))
    const mod = await import('@/lib/cashFlowClient')
    vi.spyOn(mod, 'isSchemaMissingError').mockReturnValue(true)

    render(<CashFlowPage />)
    await screen.findByRole('heading', { name: 'Cash Flow' })

    // Runway must still compute from the seed values — the page stays useful.
    expect(screen.getByText('No limit')).toBeTruthy()
  })

  it('renders the logged weeks and their trend when history exists', async () => {
    listWeeks.mockResolvedValue([
      { id: 'w1', weekOf: '2026-08-05', totalCashCents: 7_611_400, ar30Cents: 22_000_000,
        ar120Cents: 7_000_000, totalPayablesCents: 9_050_200, projectedLowCents: 61_200,
        projectedEndingCents: 13_861_200, runwayMonths: null, createdAt: '', updatedAt: '' },
      { id: 'w2', weekOf: '2026-08-12', totalCashCents: 8_000_000, ar30Cents: 21_000_000,
        ar120Cents: 6_500_000, totalPayablesCents: 8_000_000, projectedLowCents: -50_000,
        projectedEndingCents: 14_000_000, runwayMonths: 4, createdAt: '', updatedAt: '' },
    ])

    render(<CashFlowPage />)
    await screen.findByRole('heading', { name: 'Cash Flow' })

    const rows = await screen.findAllByRole('row')
    const logged = rows.filter((r) => within(r).queryByText(/2026-08-/))
    expect(logged).toHaveLength(2)
    // Newest first.
    expect(within(logged[0]).getByText('2026-08-12')).toBeTruthy()
    expect(screen.getByLabelText('Delete the week of 2026-08-12')).toBeTruthy()
    // A negative projected low is called out in red — the number must still be shown.
    expect(screen.getByText('-$500')).toBeTruthy()
    // Runway is tracked per week; "no limit" must not collapse into a number.
    expect(screen.getByText('4 mo')).toBeTruthy()
    // Also the runway headline, so more than one match.
    expect(screen.getAllByText('No limit').length).toBeGreaterThanOrEqual(2)
  })
})
