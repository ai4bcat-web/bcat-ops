// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { BatchTaskDialog } from './BatchTaskDialog'

interface Row { id: string; label: string }

const ROWS: Row[] = [
  { id: 'a', label: 'BCAT-001' },
  { id: 'b', label: 'BCAT-002' },
]

const ACTIONS = [
  { key: 'release', label: 'Release to accounting' },
  { key: 'export', label: 'Export selected' },
]

describe('BatchTaskDialog', () => {
  it('selects an action and raises onRun', () => {
    const onSelectAction = vi.fn()
    const onRun = vi.fn()
    render(
      <BatchTaskDialog<Row>
        open
        onOpenChange={vi.fn()}
        selectedRows={ROWS}
        rowLabel={(r) => r.label}
        rowKey={(r) => r.id}
        actions={ACTIONS}
        selectedAction=""
        onSelectAction={onSelectAction}
        onRun={onRun}
      />
    )
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'release' } })
    expect(onSelectAction).toHaveBeenCalledWith('release')
  })

  it('shows per-row results', () => {
    render(
      <BatchTaskDialog<Row>
        open
        onOpenChange={vi.fn()}
        selectedRows={ROWS}
        rowLabel={(r) => r.label}
        rowKey={(r) => r.id}
        actions={ACTIONS}
        selectedAction="release"
        onSelectAction={vi.fn()}
        onRun={vi.fn()}
        results={[
          { rowId: 'a', rowLabel: 'BCAT-001', success: true },
          { rowId: 'b', rowLabel: 'BCAT-002', success: false, message: 'Gate not met' },
        ]}
      />
    )
    expect(screen.getByText('BCAT-001')).toBeInTheDocument()
    expect(screen.getByText('BCAT-002')).toBeInTheDocument()
    expect(screen.getByText('Gate not met')).toBeInTheDocument()
  })

  it('disables run until an action is selected', () => {
    render(
      <BatchTaskDialog<Row>
        open
        onOpenChange={vi.fn()}
        selectedRows={ROWS}
        rowLabel={(r) => r.label}
        rowKey={(r) => r.id}
        actions={ACTIONS}
        selectedAction=""
        onSelectAction={vi.fn()}
        onRun={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: /^Run$/i })).toBeDisabled()
  })
})
