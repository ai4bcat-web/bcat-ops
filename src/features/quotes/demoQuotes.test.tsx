// @vitest-environment jsdom
/**
 * The demo is fake, but its arithmetic must still be honest: every roll-up is derived from
 * the quote rows, so these tests pin that the numbers add up, and that the views render.
 */
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { DEMO_CUSTOMERS, DEMO_QUOTES, allCustomerStats, customerStats, quoteSummary, threadFor } from './demoQuotes'
import { DemoCustomersView } from './demo/DemoCustomersView'

describe('demo quote data', () => {
  it('has 6-8 customers with 4-12 quotes each and a mix of outcomes', () => {
    expect(DEMO_CUSTOMERS.length).toBeGreaterThanOrEqual(6)
    expect(DEMO_CUSTOMERS.length).toBeLessThanOrEqual(8)
    for (const s of allCustomerStats()) {
      expect(s.received).toBeGreaterThanOrEqual(4)
      expect(s.received).toBeLessThanOrEqual(12)
    }
    expect(allCustomerStats().some((s) => s.pending === s.received)).toBe(true)
  })

  it('derives every total from the quote rows', () => {
    for (const customer of DEMO_CUSTOMERS) {
      const rows = DEMO_QUOTES.filter((q) => q.customerId === customer.id)
      const s = customerStats(customer)
      expect(s.received).toBe(rows.length)
      expect(s.won).toBe(rows.filter((q) => q.outcome === 'won').length)
      expect(s.won + s.lost + s.pending + s.expired).toBe(s.received)
      expect(s.quotedCents).toBe(rows.reduce((n, q) => n + q.quotedCents, 0))
      expect(s.wonCents).toBe(rows.filter((q) => q.outcome === 'won').reduce((n, q) => n + (q.finalCents ?? 0), 0))
      expect(s.winRate).toBeCloseTo(s.won / s.received)
    }
  })

  it('gives every quote a thread whose last rate matches a won final rate', () => {
    const ids = new Set(DEMO_QUOTES.map((q) => q.id))
    expect(ids.size).toBe(DEMO_QUOTES.length)
    for (const q of DEMO_QUOTES) {
      const thread = threadFor(q)
      expect(thread.length).toBeGreaterThanOrEqual(2)
      if (q.outcome === 'won') {
        const rates = thread.filter((m) => m.rateCents !== undefined)
        expect(rates[rates.length - 1].rateCents).toBe(q.finalCents)
      }
    }
    expect(DEMO_QUOTES.filter((q) => threadFor(q).length >= 5).length).toBeGreaterThanOrEqual(3)
    expect(quoteSummary(DEMO_QUOTES[0]).minutesToQuote).toBe(4)
  })
})

describe('DemoCustomersView', () => {
  it('lists customers, opens a panel, then a conversation drawer, all labelled demo', () => {
    render(<DemoCustomersView onBack={() => {}} />)
    expect(screen.getAllByTestId('demo-badge').length).toBeGreaterThan(0)
    expect(screen.getByText('Midwest Packaging Co.')).toBeTruthy()

    fireEvent.click(screen.getByText('Midwest Packaging Co.'))
    const panel = screen.getByTestId('customer-panel')
    expect(within(panel).getAllByTestId('demo-outcome').length).toBe(10)
    expect(within(panel).getAllByText('Lost').length).toBe(2)

    fireEvent.click(within(panel).getByText('DQ-1001'))
    expect(screen.getAllByTestId('thread-message').length).toBe(5)
    expect(screen.getAllByTestId('thread-rate').length).toBe(4)
    expect(within(screen.getByTestId('thread-summary')).getByText('$2,390.00')).toBeTruthy()
    expect(screen.getAllByTestId('demo-badge').length).toBeGreaterThanOrEqual(3)
  })
})
