// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { TmsListPage } from './TmsListPage'
import type { ColumnDef } from './TmsTable'

interface Row {
  id: string
  status: string
}

const COLUMNS: Array<ColumnDef<Row>> = [
  { key: 'id', header: 'Shipment ID', render: (r) => r.id },
  { key: 'status', header: 'Status', render: (r) => r.status },
]

const ROWS: Row[] = [
  { id: 'BCAT1001', status: 'BOOKED' },
  { id: 'BCAT1002', status: 'DELIVERED' },
]

describe('TmsListPage', () => {
  it('shows the MVMNT empty state and clears the filters from it', () => {
    const onClearFilters = vi.fn()
    render(
      <TmsListPage<Row>
        title="Shipments"
        columns={COLUMNS}
        rows={[]}
        rowKey={(r) => r.id}
        onClearFilters={onClearFilters}
      />
    )

    expect(screen.getByText('No items found using these filters.')).toBeInTheDocument()
    expect(screen.getByText('Please try again using a different query.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Click here to clear all filters/ }))
    expect(onClearFilters).toHaveBeenCalledTimes(1)
  })

  it('keeps the column headers visible while empty', () => {
    render(<TmsListPage<Row> title="Shipments" columns={COLUMNS} rows={[]} rowKey={(r) => r.id} />)
    expect(screen.getByRole('columnheader', { name: 'Shipment ID' })).toBeInTheDocument()
  })

  it('counts the page in the footer', () => {
    render(
      <TmsListPage<Row>
        title="Shipments"
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(r) => r.id}
        page={{ from: 1, to: 20, total: 45, pageSize: 20 }}
      />
    )
    // The counts are bolded, so the sentence spans several text nodes.
    const footer = screen.getByText((_text, el) => el?.classList.contains('tms-footer-count') ?? false)
    expect(footer).toHaveTextContent('Showing 1 – 20 of 45 items')
  })

  it('shows quick tabs with their counts and reports the pick', () => {
    const onSelect = vi.fn()
    render(
      <TmsListPage<Row>
        title="Shipments"
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(r) => r.id}
        quickTabs={{
          tabs: [
            { key: 'open', label: "Today's Open", count: 7 },
            { key: 'booked', label: 'Booked', count: 12 },
          ],
          active: 'open',
          onSelect,
        }}
      />
    )

    expect(screen.getByRole('tab', { name: /Today's Open/ })).toHaveTextContent("Today's Open7")
    expect(screen.getByRole('tab', { name: /Today's Open/ })).toHaveClass('tms-active')
    fireEvent.click(screen.getByRole('tab', { name: /Booked/ }))
    expect(onSelect).toHaveBeenCalledWith('booked')
  })

  it('opens the row that was clicked', () => {
    const onRowClick = vi.fn()
    render(
      <TmsListPage<Row> title="Shipments" columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} onRowClick={onRowClick} />
    )
    fireEvent.click(screen.getByText('BCAT1002'))
    expect(onRowClick).toHaveBeenCalledWith(ROWS[1])
  })

  it('drives search and the field picker from the filter row', () => {
    const onChange = vi.fn()
    const onAddFilter = vi.fn()
    render(
      <TmsListPage<Row>
        title="Shipments"
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(r) => r.id}
        search={{ value: '', onChange }}
        onAddFilter={onAddFilter}
        fieldsLabel="13 Fields"
        filterChips={[
          { key: 'customer', label: 'Customer is' },
          { key: 'ar', label: 'AR Status is not', value: 'Unbilled, Unpaid, Paid, Canceled' },
        ]}
      />
    )

    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'BCAT' } })
    expect(onChange).toHaveBeenCalledWith('BCAT')

    // A chip with a value reads as a full sentence; an unset one is just the phrase.
    expect(screen.getByText('Customer is')).toHaveClass('tms-chip')
    expect(screen.getByText('AR Status is not Unbilled, Unpaid, Paid, Canceled')).toHaveClass('tms-chip-set')

    fireEvent.click(screen.getByText('13 Fields'))
    fireEvent.click(screen.getByRole('button', { name: /Filter/ }))
    expect(onAddFilter).toHaveBeenCalledTimes(1)
  })
})
