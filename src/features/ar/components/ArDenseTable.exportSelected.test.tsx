// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ArDenseTable, type ArGrid } from './ArDenseTable'

vi.mock('@/hooks/useAuth', () => ({ useAuthUser: () => ({ email: 'a@b.test' }) }))
const downloadCsv = vi.hoisted(() => vi.fn())
vi.mock('@/lib/directoryCsv', () => ({ downloadCsv }))

type R = { id: string; pro: string; customer: string }
const rows: R[] = [
  { id: 'a', pro: '14588', customer: 'AUTO SHIPPER' },
  { id: 'b', pro: '13029', customer: 'ROYAL' },
  { id: 'c', pro: '14458', customer: 'AUTO SHIPPER' },
]
const make = (ids: string[] | null): ArGrid<R> => ({
  gridId: 'ar-export-test', label: 'AR export', rowKey: (r) => r.id, empty: 'none', rows,
  columns: [
    { key: 'pro', header: 'PRO', text: (r) => r.pro },
    { key: 'customer', header: 'Customer', text: (r) => r.customer },
  ],
  renderCell: (r, key) => r[key as keyof R],
  selection: ids ? { ids, idOf: (r) => r.id, filename: 'ready-to-invoice-selected' } : undefined,
})

describe('ArDenseTable Export selected', () => {
  beforeEach(() => { downloadCsv.mockClear(); try { localStorage.clear() } catch { /* jsdom */ } })

  it('has no button when the view offers no selection', () => {
    render(<ArDenseTable<R> grid={make(null)} />)
    expect(screen.queryByTestId('ar-export-selected')).toBeNull()
  })

  it('is disabled with nothing ticked', () => {
    render(<ArDenseTable<R> grid={make([])} />)
    expect(screen.getByTestId('ar-export-selected')).toBeDisabled()
  })

  it('downloads only the ticked rows (across customers), in grid order, with the count on the button', () => {
    render(<ArDenseTable<R> grid={make(['c', 'b'])} />)
    const btn = screen.getByTestId('ar-export-selected')
    expect(btn).toHaveTextContent('Export selected (2)')
    fireEvent.click(btn)
    expect(downloadCsv).toHaveBeenCalledTimes(1)
    const [name, csv] = downloadCsv.mock.calls[0]
    expect(name).toMatch(/^ready-to-invoice-selected-\d{4}-\d{2}-\d{2}\.csv$/)
    expect(csv).toBe('PRO,Customer\r\n13029,ROYAL\r\n14458,AUTO SHIPPER')
  })
})
