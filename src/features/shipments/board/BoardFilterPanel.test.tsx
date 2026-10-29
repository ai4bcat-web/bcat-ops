// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import {
  BoardFilterPanel,
  type BoardFilterPanelProps,
} from './BoardFilterPanel'
import type { BoardFilterSet, BoardDetailDef } from './types'

const EMPTY_SET: BoardFilterSet = {
  statuses: [],
  details: {},
  dates: {},
}

const DETAIL_DEFS: BoardDetailDef[] = [
  {
    key: 'customer',
    label: 'Customer',
    options: [
      { value: 'c1', label: 'Acme', count: 3 },
      { value: 'c2', label: 'Beta', count: 1 },
    ],
  },
]

function renderPanel(props: Partial<BoardFilterPanelProps> = {}) {
  return render(
    <BoardFilterPanel
      collapsed={false}
      onToggleCollapse={vi.fn()}
      viewName="Active Shipments"
      filterSets={[{ id: 'fs1', name: 'Active Shipments' }]}
      activeFilterSetId="fs1"
      filterSetDirty={false}
      onSelectFilterSet={vi.fn()}
      onCreateFilterSet={vi.fn()}
      onUpdateFilterSet={vi.fn()}
      onRevertFilterSet={vi.fn()}
      onDeleteFilterSet={vi.fn()}
      columnTemplates={[{ id: 'ct1', name: 'RYNE' }]}
      activeColumnTemplateId="ct1"
      onSelectColumnTemplate={vi.fn()}
      onManageColumnTemplates={vi.fn()}
      statuses={[
        'OPEN',
        'COVERED',
        'DISPATCHED',
        'ARRIVED',
        'DEPARTED',
        'DELIVERED',
        'HOLD',
        'RESERVED',
      ]}
      statusCounts={{
        OPEN: 5,
        COVERED: 4,
        DISPATCHED: 3,
        ARRIVED: 2,
        DEPARTED: 1,
        DELIVERED: 6,
        HOLD: 0,
        RESERVED: 0,
        VOIDED: 0,
      }}
      selectedStatuses={['OPEN', 'COVERED']}
      onToggleStatus={vi.fn()}
      detailDefs={DETAIL_DEFS}
      detailFilters={{}}
      onDetailChange={vi.fn()}
      onDetailExcludeChange={vi.fn()}
      dateFilters={EMPTY_SET.dates}
      onDateChange={vi.fn()}
      flags={undefined}
      onFlagChange={vi.fn()}
      onClearFilters={vi.fn()}
      onResetFilters={vi.fn()}
      activeFilterCount={2}
      recentStorageKey="tms-panel-test"
      {...props}
    />,
  )
}

describe('BoardFilterPanel', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('renders the status checkboxes with counts', () => {
    renderPanel()
    expect(screen.getByRole('checkbox', { name: /Open 5/i })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /Covered 4/i })).toBeInTheDocument()
  })

  it('raises the status key when a status checkbox is toggled', () => {
    const onToggleStatus = vi.fn()
    renderPanel({ onToggleStatus })
    fireEvent.click(screen.getByRole('checkbox', { name: /Dispatched 3/i }))
    expect(onToggleStatus).toHaveBeenCalledWith('DISPATCHED')
  })

  it('shows active filter count on the reopen handle when collapsed', () => {
    renderPanel({ collapsed: true, activeFilterCount: 3 })
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('calls onToggleCollapse when the collapse button is clicked', () => {
    const onToggleCollapse = vi.fn()
    renderPanel({ onToggleCollapse })
    fireEvent.click(screen.getByRole('button', { name: /collapse filters/i }))
    expect(onToggleCollapse).toHaveBeenCalled()
  })

  it('renders the view selector with the active view', () => {
    renderPanel({ viewName: 'Active Shipments', activeFilterSetId: 'fs1' })
    expect(screen.getByText('View')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: /View/i })).toHaveValue('fs1')
  })

  it('shows an unsaved changes marker when dirty', () => {
    renderPanel({ filterSetDirty: true })
    expect(screen.getByText(/Unsaved changes/i)).toBeInTheDocument()
  })

  it('disables Save unless dirty and a view is active', () => {
    const onUpdateFilterSet = vi.fn()
    const { rerender } = renderPanel({ onUpdateFilterSet, filterSetDirty: false, activeFilterSetId: 'fs1' })
    expect(screen.getByRole('button', { name: /Save$/i })).toBeDisabled()

    rerender(
      <BoardFilterPanel
        {...{
          collapsed: false,
          onToggleCollapse: vi.fn(),
          viewName: 'Active Shipments',
          filterSets: [{ id: 'fs1', name: 'Active Shipments' }],
          activeFilterSetId: 'fs1',
          filterSetDirty: true,
          onSelectFilterSet: vi.fn(),
          onCreateFilterSet: vi.fn(),
          onUpdateFilterSet,
          onRevertFilterSet: vi.fn(),
          onDeleteFilterSet: vi.fn(),
          columnTemplates: [{ id: 'ct1', name: 'RYNE' }],
          activeColumnTemplateId: 'ct1',
          onSelectColumnTemplate: vi.fn(),
          onManageColumnTemplates: vi.fn(),
          statuses: ['OPEN', 'COVERED', 'DISPATCHED', 'ARRIVED', 'DEPARTED', 'DELIVERED', 'HOLD', 'RESERVED'],
          statusCounts: { OPEN: 5, COVERED: 4, DISPATCHED: 3, ARRIVED: 2, DEPARTED: 1, DELIVERED: 6, HOLD: 0, RESERVED: 0, VOIDED: 0 },
          selectedStatuses: ['OPEN', 'COVERED'],
          onToggleStatus: vi.fn(),
          detailDefs: DETAIL_DEFS,
          detailFilters: {},
          onDetailChange: vi.fn(),
          onDetailExcludeChange: vi.fn(),
          dateFilters: EMPTY_SET.dates,
          onDateChange: vi.fn(),
          flags: undefined,
          onFlagChange: vi.fn(),
          onClearFilters: vi.fn(),
          onResetFilters: vi.fn(),
          activeFilterCount: 2,
          recentStorageKey: 'tms-panel-test',
        }}
      />,
    )
    expect(screen.getByRole('button', { name: /Save$/i })).toBeEnabled()
  })

  it('disables Revert and Delete when no view is active', () => {
    renderPanel({ activeFilterSetId: null })
    expect(screen.getByRole('button', { name: /Revert/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Delete/i })).toBeDisabled()
  })

  it('hides the column templates section when columnTemplates is undefined', () => {
    renderPanel({ columnTemplates: undefined })
    expect(screen.queryByText('Column Templates')).not.toBeInTheDocument()
  })

  it('raises exclude: true when a detail Exclude checkbox is toggled', () => {
    const onDetailExcludeChange = vi.fn()
    renderPanel({ onDetailExcludeChange })
    fireEvent.click(screen.getByRole('checkbox', { name: /Exclude/i }))
    expect(onDetailExcludeChange).toHaveBeenCalledWith('customer', true)
  })

  it('raises detail values when a tag is picked', () => {
    const onDetailChange = vi.fn()
    renderPanel({ onDetailChange })
    const input = screen.getByPlaceholderText('Type to search…')
    fireEvent.change(input, { target: { value: 'ac' } })
    fireEvent.click(screen.getByRole('option', { name: /Acme/i }))
    expect(onDetailChange).toHaveBeenCalledWith('customer', ['c1'])
  })

  it('swaps date inputs when Fixed is changed to Range', () => {
    const onDateChange = vi.fn()
    renderPanel({
      dateFilters: {
        ship: { mode: 'FIXED', date: '2026-10-29' },
      },
      onDateChange,
    })
    fireEvent.click(screen.getByRole('radio', { name: /Range ship/i }))
    expect(onDateChange).toHaveBeenCalledWith('ship', {
      mode: 'RANGE',
      from: null,
      to: null,
    })
  })

  it('renders the tracking and paperwork flag checkboxes', () => {
    renderPanel()
    expect(screen.getByRole('checkbox', { name: /Check call due/i })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /Check call overdue/i })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /Open exceptions/i })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /Missing documents/i })).toBeInTheDocument()
  })

  it('raises a flag key when a tracking/paperwork checkbox is toggled', () => {
    const onFlagChange = vi.fn()
    renderPanel({ onFlagChange })
    fireEvent.click(screen.getByRole('checkbox', { name: /Missing documents/i }))
    expect(onFlagChange).toHaveBeenCalledWith('docsMissing', true)
  })

  it('shows a checked flag checkbox from the filter set', () => {
    renderPanel({ flags: { checkCallOverdue: true } })
    expect(screen.getByRole('checkbox', { name: /Check call overdue/i })).toBeChecked()
  })
})
