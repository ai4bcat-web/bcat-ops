// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { OwedSummary } from './OwedSummary'
import { OwedFilterBar } from './OwedFilterBar'
import { EMPTY_OWED_FILTER, summarizeOwed } from '../owedFilters'

afterEach(cleanup)

const summary = summarizeOwed([
  { dueAt: '2026-11-01', balanceCents: 10_000 },
  { dueAt: '2026-11-14', balanceCents: 20_000 },
], '2026-11-12')

describe('OwedSummary', () => {
  it('shows the total, the buckets and the next due date; a bucket toggles the due filter', () => {
    const onDue = vi.fn()
    const { rerender } = render(<OwedSummary title="Owed by Royal Group" summary={summary} unit="invoice" due={null} onDue={onDue} />)
    expect(screen.getByText('Owed by Royal Group')).toBeTruthy()
    expect(screen.getByText('$300.00')).toBeTruthy()
    expect(screen.getByText('Past due').closest('button')?.className).toContain('tms-list-row-tone-bad')
    fireEvent.click(screen.getByText('Past due'))
    expect(onDue).toHaveBeenLastCalledWith('past')
    rerender(<OwedSummary title="t" summary={summary} unit="invoice" due="past" onDue={onDue} />)
    expect(screen.getByText('Past due').closest('button')?.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByText('Past due'))
    expect(onDue).toHaveBeenLastCalledWith(null)
    expect(screen.queryByText('No due date')).toBeNull()
  })
})

describe('OwedFilterBar', () => {
  it('searches and toggles customers, then clears', () => {
    const onChange = vi.fn()
    const parties = [{ key: 'a', label: 'Royal Group' }, { key: 'b', label: 'Batory Foods' }]
    const { rerender } = render(<OwedFilterBar partyLabel="Customer" parties={parties} divisions={[]} filter={EMPTY_OWED_FILTER} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Customer: All' }))
    fireEvent.change(screen.getByLabelText('Search customer'), { target: { value: 'bat' } })
    expect(screen.queryByText('Royal Group')).toBeNull()
    fireEvent.click(screen.getByLabelText('Batory Foods'))
    expect(onChange).toHaveBeenLastCalledWith({ parties: ['b'], divisions: [], due: null })

    rerender(<OwedFilterBar partyLabel="Customer" parties={parties} divisions={[]} filter={{ parties: ['b'], divisions: [], due: 'past' }} onChange={onChange} />)
    expect(screen.getByRole('button', { name: 'Customer: Batory Foods' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clear owed filters' }))
    expect(onChange).toHaveBeenLastCalledWith({ parties: [], divisions: [], due: null })
  })
})
