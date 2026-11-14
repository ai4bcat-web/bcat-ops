// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { DenseGrid, type DenseGridProps } from './DenseGrid'
import type { DenseColumn } from './denseGridModel'

interface Row { id: string; pro: string; customer: string; amount: string; status: string; city: string }

const columns: DenseColumn<Row>[] = [
  { key: 'pick', header: '', text: () => '', fixed: true },
  { key: 'pro', header: 'PRO', text: (r) => r.pro },
  { key: 'city', header: 'City', text: (r) => r.city },
  { key: 'customer', header: 'Customer', text: (r) => r.customer },
  { key: 'amount', header: 'Amount', text: (r) => r.amount },
  { key: 'status', header: 'Status', text: (r) => r.status },
  { key: 'actions', header: '', text: () => '', fixed: true },
]

const rows: Row[] = [
  { id: 'a', pro: '20057', customer: 'IFF', amount: '$2,100.00', status: 'Sent', city: 'Worley' },
  { id: 'b', pro: '20058', customer: 'WHIMSY', amount: '$1,500.00', status: 'Paid', city: 'Chicago' },
]

function setWidth(phone: boolean) {
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches: phone, media: q, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia
}

function grid(over: Partial<DenseGridProps<Row>> = {}) {
  const props: DenseGridProps<Row> = {
    columns, rows, rowKey: (r) => r.id, density: 'compact', userWidths: {}, sort: null, onSort: vi.fn(),
    filters: {}, onFilterChange: vi.fn(), recentKey: 'test', 'aria-label': 'Invoices',
    renderCell: (r, k) => (k === 'actions' ? <button type="button">Mark paid {r.pro}</button> : k === 'pick' ? <input type="checkbox" aria-label={`Pick ${r.pro}`} /> : columns.find((c) => c.key === k)?.text(r)),
    cardLayout: { title: 'pro', party: 'customer', amount: 'amount', pills: ['status'] },
    ...over,
  }
  return render(<DenseGrid<Row> {...props} />)
}

const original = window.matchMedia
beforeEach(() => setWidth(true))
afterEach(() => { cleanup(); window.matchMedia = original })

describe('DenseGrid on a phone', () => {
  it('draws each row as a card: key fields on top, the rest as details, actions at the bottom', () => {
    grid()
    expect(screen.queryByRole('table')).toBeNull()
    const cards = within(screen.getByRole('list', { name: 'Invoices' })).getAllByRole('listitem')
    expect(cards).toHaveLength(2)
    const first = cards[0]
    expect(first.querySelector('.tms-dg-card-title')).toHaveTextContent('20057')
    expect(first.querySelector('.tms-dg-card-party')).toHaveTextContent('IFF')
    expect(first.querySelector('.tms-dg-card-amount')).toHaveTextContent('$2,100.00')
    expect(first.querySelector('.tms-dg-card-pills')).toHaveTextContent('Sent')
    expect(within(first).getByText('City').nextSibling).toHaveTextContent('Worley')
    expect(within(first).getByRole('button', { name: 'Mark paid 20057' })).toBeInTheDocument()
    // The page's own tick box (a header-less leading column) sits on the left, not among the actions.
    expect(first.querySelector('.tms-dg-card-lead')).toContainElement(within(first).getByLabelText('Pick 20057'))
  })

  it('a tap opens the row; ticking or pressing a button does not', () => {
    const onRowClick = vi.fn()
    const onToggle = vi.fn()
    grid({ onRowClick, selectable: true, selectedIds: new Set(), onToggle })
    const card = within(screen.getByRole('list')).getAllByRole('listitem')[1]
    fireEvent.click(within(card).getByLabelText('Select row b'))
    expect(onToggle).toHaveBeenCalledWith('b')
    fireEvent.click(within(card).getByRole('button', { name: 'Mark paid 20058' }))
    expect(onRowClick).not.toHaveBeenCalled()
    fireEvent.click(card.querySelector('.tms-dg-card-party') as HTMLElement)
    expect(onRowClick).toHaveBeenCalledWith(rows[1])
  })

  it('keeps the table on a wider screen, or when the page opts out', () => {
    setWidth(false)
    grid()
    expect(screen.getByRole('table')).toBeInTheDocument()
    cleanup()
    setWidth(true)
    grid({ cardLayout: false })
    expect(screen.getByRole('table')).toBeInTheDocument()
  })
})
