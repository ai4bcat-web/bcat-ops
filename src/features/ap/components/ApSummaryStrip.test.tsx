// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { ApSummaryStrip } from './ApSummaryStrip'
import { apCompactItems } from '../apCompactItems'
import type { ApSummary } from '../apQueue'

const m = (count: number, cents: number) => ({ count, cents })
const summary = (over: Partial<ApSummary> = {}): ApSummary => ({
  open: m(5, 1000_00), fromAljex: m(2, 400_00), expected: m(1, 100_00), aging: m(2, 300_00), selected: m(2, 600_00),
  pastDue: m(1, 150_00), dueNext7: m(2, 250_00), paidWeek: m(3, 450_00), paidMonth: m(7, 1200_00), payToFactor: m(1, 200_00), payDirect: m(4, 800_00),
  quickPay: { count: 0, feeCents: 0, fee6Cents: 0, fee3Cents: 0 },
  avgDaysToPay: 12.5, avgDaysToPayCount: 8, avgDaysToInvoice: 3, avgDaysToInvoiceCount: 6,
  byDivision: [{ key: 'BROKERAGE', division: 'BROKERAGE', subdivision: null, count: 5, cents: 1000_00 }],
  ...over,
})

describe('ApSummaryStrip', () => {
  it('lays the Payables card out like the Receivables card: Aljex under Open AP as a sub row, factor then direct, then the ladder, then days', () => {
    render(<ApSummaryStrip summary={summary()} divisionName={(c) => c ?? 'None'} division={null} onDivision={vi.fn()} onCashRequirements={vi.fn()} onTab={vi.fn()} />)
    const card = screen.getByTestId('ap-summary')
    const labels = within(card).getAllByRole('listitem').map((li) => li.textContent ?? '')
    const order = ['Open AP', 'From Aljex', 'Pay to factor', 'Pay direct', 'Expected', 'Aging', 'Selected', 'Past due', 'Due next 7 days', 'Paid this week', 'Paid this month', 'Quick pay this month', 'Days to pay · carriers', 'Days to invoice · carriers']
    const at = order.map((label) => labels.findIndex((t) => t.startsWith(label)))
    expect(at.every((i) => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    const subRows = Array.from(card.querySelectorAll('.tms-list-row-sub')).map((el) => el.textContent ?? '')
    expect(subRows.some((t) => t.startsWith('From Aljex'))).toBe(true)
  })

  it('still jumps to the tab when a ladder row is clicked, and opens cash requirements from Past due', () => {
    const onTab = vi.fn()
    const onCash = vi.fn()
    render(<ApSummaryStrip summary={summary()} divisionName={(c) => c ?? 'None'} division={null} onDivision={vi.fn()} onCashRequirements={onCash} onTab={onTab} />)
    fireEvent.click(screen.getByText('Selected'))
    expect(onTab).toHaveBeenCalledWith('selected')
    fireEvent.click(screen.getByText('Past due'))
    expect(onCash).toHaveBeenCalled()
  })

  it('leaves the Aljex row out when none of the open bills came from Aljex', () => {
    render(<ApSummaryStrip summary={summary({ fromAljex: m(0, 0) })} divisionName={(c) => c ?? 'None'} division={null} onDivision={vi.fn()} onCashRequirements={vi.fn()} onTab={vi.fn()} />)
    expect(screen.queryByText('From Aljex')).toBeNull()
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
