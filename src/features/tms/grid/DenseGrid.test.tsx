// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, renderHook, screen, act, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { DenseGrid, type DenseGridProps } from './DenseGrid'
import type { DenseColumn } from './denseGridModel'
import { densePrefsKey, useDenseGridPrefs } from './useDenseGridPrefs'

interface Row {
  id: string
  name: string
  city: string
}

const columns: DenseColumn<Row>[] = [
  { key: 'name', header: 'Name', text: (r) => r.name },
  { key: 'city', header: 'City', text: (r) => r.city, filter: 'multi' },
  { key: 'extra', header: 'Extra', text: () => 'x', filter: false },
]

const make = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, name: `Row ${i}`, city: i % 2 ? 'Austin' : 'Boise' }))

function grid(over: Partial<DenseGridProps<Row>> = {}) {
  const props: DenseGridProps<Row> = {
    columns,
    rows: make(3),
    rowKey: (r) => r.id,
    density: 'compact',
    userWidths: {},
    sort: null,
    onSort: vi.fn(),
    filters: {},
    onFilterChange: vi.fn(),
    onReorder: vi.fn(),
    onResize: vi.fn(),
    recentKey: 'test',
    'aria-label': 'Test grid',
    ...over,
  }
  return { props, ...render(<DenseGrid<Row> {...props} />) }
}

afterEach(() => {
  cleanup()
  localStorage.clear()
})

const bodyRows = () => document.querySelectorAll('tbody tr:not(.tms-dg-spacer)')

describe('DenseGrid', () => {
  it('mounts a bounded window of a long list and spaces out the rest', () => {
    grid({ rows: make(5000) })
    expect(bodyRows().length).toBeGreaterThan(0)
    expect(bodyRows().length).toBeLessThan(60)
    // The bottom spacer stands in for the unmounted rows at the compact 30px height.
    const spacer = document.querySelector('tr.tms-dg-spacer') as HTMLElement
    expect(parseInt(spacer.style.height, 10)).toBeGreaterThan(4000 * 30)
  })

  it('scrolling moves the mounted window', () => {
    grid({ rows: make(5000) })
    const scroll = document.querySelector('.tms-dg-scroll') as HTMLElement
    expect(screen.getByText('Row 0')).toBeInTheDocument()
    scroll.scrollTop = 30 * 2000
    fireEvent.scroll(scroll)
    expect(screen.queryByText('Row 0')).not.toBeInTheDocument()
    expect(screen.getByText('Row 2000')).toBeInTheDocument()
  })

  it('uses the density row height and keeps the header and first column sticky', () => {
    const { container } = grid({ density: 'comfortable', selectable: true, selectedIds: new Set(), onToggle: vi.fn(), onToggleAll: vi.fn() })
    expect(container.querySelector('.tms-dg')).toHaveAttribute('data-density', 'comfortable')
    expect((container.querySelector('.tms-dg') as HTMLElement).style.getPropertyValue('--dg-row-h')).toBe('40px')
    expect(screen.getByRole('columnheader', { name: /^Name/ })).toHaveClass('tms-dg-sticky')
    expect(screen.getByRole('columnheader', { name: /City/ })).not.toHaveClass('tms-dg-sticky')
    // The first data column sits right of the 30px checkbox column.
    expect((screen.getByRole('columnheader', { name: /^Name/ }) as HTMLElement).style.left).toBe('30px')
    expect(within(bodyRows()[0] as HTMLElement).getAllByRole('cell')[1]).toHaveClass('tms-dg-sticky')
  })

  it('pins as many leading columns as asked, each at the sum of the widths before it', () => {
    grid({ stickyCount: 2, userWidths: { name: 120 } })
    expect((screen.getByRole('columnheader', { name: /^Name/ }) as HTMLElement).style.left).toBe('0px')
    expect((screen.getByRole('columnheader', { name: /City/ }) as HTMLElement).style.left).toBe('120px')
  })

  it('click-to-sort on a header, and Filter opens only for filterable columns', () => {
    const { props } = grid()
    fireEvent.click(within(screen.getByRole('columnheader', { name: /^Name/ })).getByRole('button', { name: 'Name' }))
    expect(props.onSort).toHaveBeenCalledWith('name')
    expect(screen.getByRole('button', { name: 'Filter Name' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Filter Extra' })).not.toBeInTheDocument()
  })

  it('the filter popover narrows through onFilterChange and closes on Escape', () => {
    const { props } = grid()
    fireEvent.click(screen.getByRole('button', { name: 'Filter City' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'City: Austin' }))
    expect(props.onFilterChange).toHaveBeenCalledWith('city', { values: ['Austin'], exclude: undefined })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'City filter' })).not.toBeInTheDocument()
  })

  it('Select all takes every option a search leaves, and the long list is searchable', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, name: `Row ${i}`, city: `City ${i}` }))
    const { props } = grid({ rows })
    fireEvent.click(screen.getByRole('button', { name: 'Filter City' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Search City options' }), { target: { value: 'City 1' } })
    expect(screen.getAllByRole('checkbox', { name: /^City: / })).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: 'Select all City' }))
    const values = vi.mocked(props.onFilterChange).mock.calls[0][1]?.values ?? []
    expect(values).toHaveLength(3)
    expect(values.every((v) => v.startsWith('City 1'))).toBe(true)
  })

  it('a short list has no search box; the filter closes when the columns slide sideways', () => {
    grid()
    fireEvent.click(screen.getByRole('button', { name: 'Filter City' }))
    expect(screen.queryByRole('textbox', { name: /Search City/ })).not.toBeInTheDocument()
    const scroll = document.querySelector('.tms-dg-scroll') as HTMLElement
    scroll.scrollLeft = 120
    fireEvent.scroll(scroll)
    expect(screen.queryByRole('dialog', { name: 'City filter' })).not.toBeInTheDocument()
  })

  it('marks an active filter on its header button', () => {
    grid({ filters: { name: { text: 'row' } } })
    expect(screen.getByRole('button', { name: 'Filter Name' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Filter City' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('dragging a header onto another reorders, and a fixed column cannot move', () => {
    const { props } = grid({ columns: [...columns.slice(0, 2), { ...columns[2], fixed: true }] })
    const name = screen.getByRole('columnheader', { name: /^Name/ })
    const city = screen.getByRole('columnheader', { name: /City/ })
    fireEvent.dragStart(name)
    fireEvent.dragOver(city)
    fireEvent.drop(city)
    expect(props.onReorder).toHaveBeenCalledWith('name', 'city')
    expect(screen.getByRole('columnheader', { name: /Extra/ })).toHaveAttribute('draggable', 'false')
  })

  it('dragging a header edge resizes the column on release', () => {
    const { props } = grid({ userWidths: { name: 150 } })
    const handle = screen.getByRole('separator', { name: 'Resize Name' })
    fireEvent.mouseDown(handle, { clientX: 100 })
    fireEvent.mouseMove(document, { clientX: 160 })
    fireEvent.mouseUp(document)
    expect(props.onResize).toHaveBeenCalledWith('name', 210)
  })

  it('truncates with a tooltip: every cell carries its full text as the title', () => {
    grid({ rows: [{ id: 'r', name: 'A very long consignee name', city: 'Austin' }] })
    expect(screen.getByText('A very long consignee name').closest('td')).toHaveAttribute('title', 'A very long consignee name')
  })

  it('draws a header row wherever the group key changes', () => {
    const rows = [...make(4)].sort((a, b) => a.city.localeCompare(b.city))
    grid({ rows, groupKeyOf: (r) => r.city, renderGroupHeader: (key, shown) => `${key} (${shown.length})` })
    const groups = screen.getAllByTestId('dense-group')
    expect(groups.map((g) => g.getAttribute('data-group-key'))).toEqual(['Austin', 'Boise'])
    expect(groups[0]).toHaveTextContent('Austin (2)')
  })

  it('says why it is empty instead of drawing a bare table', () => {
    grid({ rows: [], empty: 'Nothing here' })
    expect(screen.getByText('Nothing here')).toBeInTheDocument()
  })
})

describe('useDenseGridPrefs', () => {
  const opts = {
    gridId: 'test',
    email: 'a@b.c',
    defaultColumns: ['name', 'city'],
    validKeys: ['name', 'city', 'extra'],
    defaultSort: { key: 'name', dir: 'asc' as const },
  }

  it('starts on the defaults: compact, summary closed', () => {
    const { result } = renderHook(() => useDenseGridPrefs(opts))
    expect(result.current.density).toBe('compact')
    expect(result.current.kpiOpen).toBe(false)
    expect(result.current.columns).toEqual(['name', 'city'])
  })

  it("restores one user's layout on a new mount, and another user starts fresh", () => {
    const first = renderHook(() => useDenseGridPrefs(opts))
    act(() => {
      first.result.current.setDensity('comfortable')
      first.result.current.setColumns(['city', 'name', 'extra'])
      first.result.current.setWidth('name', 222)
      first.result.current.setSort({ key: 'city', dir: 'desc' })
      first.result.current.setKpiOpen(true)
    })
    first.unmount()

    const again = renderHook(() => useDenseGridPrefs(opts))
    expect(again.result.current).toMatchObject({
      density: 'comfortable',
      columns: ['city', 'name', 'extra'],
      widths: { name: 222 },
      sort: { key: 'city', dir: 'desc' },
      kpiOpen: true,
    })
    const other = renderHook(() => useDenseGridPrefs({ ...opts, email: 'z@b.c' }))
    expect(other.result.current.density).toBe('compact')
    expect(localStorage.getItem(densePrefsKey('test', 'a@b.c'))).not.toBeNull()
  })

  it('drops stored columns that no longer exist and falls back to the defaults', () => {
    localStorage.setItem(densePrefsKey('test', 'a@b.c'), JSON.stringify({ columns: ['gone', 'city'] }))
    expect(renderHook(() => useDenseGridPrefs(opts)).result.current.columns).toEqual(['city'])
    localStorage.setItem(densePrefsKey('test', 'a@b.c'), JSON.stringify({ columns: ['gone'] }))
    expect(renderHook(() => useDenseGridPrefs(opts)).result.current.columns).toEqual(['name', 'city'])
  })

  it('survives a corrupted entry', () => {
    localStorage.setItem(densePrefsKey('test', 'a@b.c'), '{nope')
    expect(renderHook(() => useDenseGridPrefs(opts)).result.current.columns).toEqual(['name', 'city'])
  })

  it("keeps a dragged width as that user's default for that board, across a reload", () => {
    const first = renderHook(() => useDenseGridPrefs(opts))
    act(() => first.result.current.setWidth('name', 260))
    first.unmount()

    expect(renderHook(() => useDenseGridPrefs(opts)).result.current.widths).toEqual({ name: 260 })
    // Another user, and another board of the same user, keep their own defaults.
    expect(renderHook(() => useDenseGridPrefs({ ...opts, email: 'z@b.c' })).result.current.widths).toEqual({})
    expect(renderHook(() => useDenseGridPrefs({ ...opts, gridId: 'other' })).result.current.widths).toEqual({})
  })

  it('a template overrides only the widths it sets; the dialog replaces them all', () => {
    const { result } = renderHook(() => useDenseGridPrefs(opts))
    act(() => {
      result.current.setWidth('name', 260)
      result.current.setWidth('city', 140)
    })
    act(() => result.current.applyLayout({ columns: ['name', 'city'], widths: { city: 300 }, pinned: [] }))
    expect(result.current.widths).toEqual({ name: 260, city: 300 })

    act(() => result.current.applyLayout({ columns: ['name', 'city'], widths: {}, pinned: [], replaceWidths: true }))
    expect(result.current.widths).toEqual({})
  })
})
