// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { ApSummaryStrip } from './ApSummaryStrip'
import { apCompactItems } from '../apCompactItems'
import type { ApSummary } from '../apQueue'

const m = (count: number, cents: number) => ({ count, cents })
const summary = (over: Partial<ApSummary> = {}): ApSummary => ({
  open: m(5, 1000_00), fromAljex: m(2, 400_00), expected: m(1, 100_00), aging: m(2, 300_00), selected: m(2, 600_00),
  pastDue: m(1, 150_00), expectedLate: m(0, 0), dueNext7: m(2, 250_00), paidWeek: m(3, 450_00), paidMonth: m(7, 1200_00), payToFactor: m(1, 200_00), payDirect: m(4, 800_00),
  quickPay: { count: 0, feeCents: 0, fee6Cents: 0, fee3Cents: 0 },
  avgDaysToPay: 12.5, avgDaysToPayCount: 8, avgDaysToInvoice: 3, avgDaysToInvoiceCount: 6,
  byDivision: [{ key: 'BROKERAGE', division: 'BROKERAGE', subdivision: null, count: 5, cents: 1000_00 }],
  ...over,
})

const strip = (over: Partial<Parameters<typeof ApSummaryStrip>[0]> = {}) => (
  <ApSummaryStrip
    summary={summary()}
    due={null}
    onDue={vi.fn()}
    missing={{ payees: 2, cents: 750_00, onOpen: vi.fn() }}
    onCashRequirements={vi.fn()}
    onTab={vi.fn()}
    {...over}
  />
)

describe('ApSummaryStrip', () => {
  it('shows six headline tiles in one row and only three small cards in the second', () => {
    render(strip())
    const tiles = screen.getByRole('group', { name: 'Open payables and the payment ladder' })
    expect(within(tiles).getAllByRole('button').length).toBe(5)
    for (const label of ['Open AP', 'Expected', 'Aging', 'Selected', 'Past due', 'Due within 7 days']) expect(within(tiles).getByText(label)).toBeTruthy()
    const row2 = screen.getByTestId('ap-summary-cards')
    expect(row2.children).toHaveLength(3)
    expect(screen.getByTestId('ap-paid-card')).toBeTruthy()
    expect(screen.getByTestId('ap-due-card')).toBeTruthy()
    expect(screen.getByTestId('ap-missing-card')).toBeTruthy()
  })

  it('drops the granular cards: paid-to, how fast, division, quick pay, profit check', () => {
    render(strip())
    for (const text of ['Pay to factor', 'Pay direct', 'From Aljex', 'Days to pay', 'Days to invoice', 'Quick pay', 'Open AP by division', 'Profit check']) {
      expect(screen.queryByText(new RegExp(text))).toBeNull()
    }
  })

  it('Paid shows this week and this month', () => {
    render(strip())
    const paid = within(screen.getByTestId('ap-paid-card'))
    expect(paid.getByText('This week').closest('li')?.textContent).toContain('$450.00')
    expect(paid.getByText('This month').closest('li')?.textContent).toContain('$1,200.00')
  })

  it('Open bills by due date is past due, due this week and later, and the three add up to Open AP', () => {
    render(strip())
    const rows = within(screen.getByTestId('ap-due-card')).getAllByRole('listitem').map((li) => li.textContent ?? '')
    expect(rows).toHaveLength(3)
    expect(rows[0]).toContain('Past due')
    expect(rows[0]).toContain('$150.00')
    expect(rows[1]).toContain('Due this week')
    expect(rows[1]).toContain('$250.00')
    expect(rows[2]).toContain('Later')
    expect(rows[2]).toContain('$600.00')
  })

  it('the Past due and Due this week rows filter the table, and the same row clears it', () => {
    const onDue = vi.fn()
    const { rerender } = render(strip({ onDue }))
    const card = within(screen.getByTestId('ap-due-card'))
    fireEvent.click(card.getByText('Past due'))
    expect(onDue).toHaveBeenLastCalledWith('past')
    fireEvent.click(card.getByText('Due this week'))
    expect(onDue).toHaveBeenLastCalledWith('week')
    rerender(strip({ onDue, due: 'past' }))
    fireEvent.click(within(screen.getByTestId('ap-due-card')).getByText('Past due'))
    expect(onDue).toHaveBeenLastCalledWith(null)
  })

  it('Missing payment info shows the payee count and the dollars waiting, and opens the worklist; hidden when none', () => {
    const onOpen = vi.fn()
    const { rerender } = render(strip({ missing: { payees: 2, cents: 750_00, onOpen } }))
    const card = screen.getByTestId('ap-missing-card')
    expect(card.textContent).toContain('2 payees')
    expect(card.textContent).toContain('$750.00')
    fireEvent.click(within(card).getByRole('button'))
    expect(onOpen).toHaveBeenCalled()
    rerender(strip({ missing: { payees: 0, cents: 0, onOpen } }))
    expect(screen.queryByTestId('ap-missing-card')).toBeNull()
  })

  it('still jumps to the tab when a ladder tile is clicked, and opens cash requirements from Past due', () => {
    const onTab = vi.fn()
    const onCash = vi.fn()
    render(strip({ onTab, onCashRequirements: onCash }))
    const tiles = within(screen.getByRole('group', { name: 'Open payables and the payment ladder' }))
    fireEvent.click(tiles.getByText('Selected'))
    expect(onTab).toHaveBeenCalledWith('selected')
    fireEvent.click(tiles.getByText('Past due'))
    expect(onCash).toHaveBeenCalled()
  })
})

describe('apCompactItems', () => {
  it('shows the same kind of headline row as Receivables: open, the ladder, past due and due next 7 days', () => {
    const items = apCompactItems(summary())
    expect(items.map((i) => i.key)).toEqual(['open', 'expected', 'aging', 'selected', 'past-due', 'next7'])
    expect(items.find((i) => i.key === 'past-due')?.tone).toBe('bad')
    expect(items.find((i) => i.key === 'selected')?.sub).toBe('2 bills')
    expect(items.find((i) => i.key === 'next7')?.value).toBe('$250.00')
  })
})
