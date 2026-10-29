// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { BoardGrid } from './BoardGrid'

interface Row { id: string; name: string; value: number }

const COLUMNS = [
  { key: 'name', header: 'Name', sortable: true },
  { key: 'value', header: 'Value', sortable: true },
]

const ROWS: Row[] = [
  { id: 'a', name: 'Alpha', value: 10 },
  { id: 'b', name: 'Beta', value: 20 },
  { id: 'c', name: 'Gamma', value: 30 },
]

function renderGrid(props: Partial<Parameters<typeof BoardGrid<Row>>[0]> = {}) {
  return render(
    <BoardGrid<Row>
      columns={COLUMNS}
      rows={ROWS}
      rowKey={(r) => r.id}
      selectedIds={[]}
      toneOf={() => 'open'}
      onToggle={vi.fn()}
      onToggleAll={vi.fn()}
      renderCell={(row, key) => String(row[key as keyof Row])}
      {...props}
    />
  )
}

describe('BoardGrid', () => {
  it('selects and clears every row via the master checkbox', () => {
    const onToggleAll = vi.fn()
    const { rerender } = renderGrid({ onToggleAll })
    fireEvent.click(screen.getByRole('checkbox', { name: /Select all rows/i }))
    expect(onToggleAll).toHaveBeenCalled()

    rerender(
      <BoardGrid<Row>
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(r) => r.id}
        selectedIds={['a', 'b', 'c']}
        toneOf={() => 'open'}
        onToggle={vi.fn()}
        onToggleAll={onToggleAll}
        renderCell={(row, key) => String(row[key as keyof Row])}
      />
    )
    expect(screen.getByRole('checkbox', { name: /Select all rows/i })).toBeChecked()
  })

  it('calls onToggle for a per-row checkbox', () => {
    const onToggle = vi.fn()
    renderGrid({ onToggle })
    fireEvent.click(screen.getByRole('checkbox', { name: /Select row b/i }))
    expect(onToggle).toHaveBeenCalledWith('b')
  })

  it('sets aria-sort on the sorted column', () => {
    renderGrid({ sort: { key: 'value', dir: 'desc' } })
    expect(screen.getByRole('columnheader', { name: /Value/i })).toHaveAttribute('aria-sort', 'descending')
    expect(screen.getByRole('columnheader', { name: /Name/i })).not.toHaveAttribute('aria-sort')
  })

  it('raises onSort when a sortable header is clicked', () => {
    const onSort = vi.fn()
    renderGrid({ onSort })
    fireEvent.click(screen.getByRole('columnheader', { name: /Name/i }))
    expect(onSort).toHaveBeenCalledWith('name')
  })

  it('applies data-tone to rows', () => {
    renderGrid({ toneOf: (row) => (row.id === 'a' ? 'delivered' : 'open') })
    expect(screen.getByRole('row', { name: /Alpha/i })).toHaveAttribute('data-tone', 'delivered')
  })

  it('calls row click handlers', () => {
    const onRowClick = vi.fn()
    const onRowDoubleClick = vi.fn()
    renderGrid({ onRowClick, onRowDoubleClick })
    fireEvent.click(screen.getByText('Beta'))
    fireEvent.doubleClick(screen.getByText('Beta'))
    expect(onRowClick).toHaveBeenCalledWith(ROWS[1])
    expect(onRowDoubleClick).toHaveBeenCalledWith(ROWS[1])
  })
})
