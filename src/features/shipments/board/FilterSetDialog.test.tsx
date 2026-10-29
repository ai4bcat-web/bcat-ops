// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { FilterSetDialog } from './FilterSetDialog'

const COLUMNS = [
  { key: 'status', header: 'Status', selected: true },
  { key: 'pro', header: 'PRO #', selected: false },
]

describe('FilterSetDialog', () => {
  it('edits name and shared flag and saves', () => {
    const onNameChange = vi.fn()
    const onSharedChange = vi.fn()
    const onSave = vi.fn()
    render(
      <FilterSetDialog
        open
        onOpenChange={vi.fn()}
        mode="create"
        name=""
        onNameChange={onNameChange}
        columns={COLUMNS}
        onToggleColumn={vi.fn()}
        onMoveColumn={vi.fn()}
        shared={false}
        onSharedChange={onSharedChange}
        canDelete={false}
        onDelete={vi.fn()}
        onSave={onSave}
      />
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'My queue' } })
    expect(onNameChange).toHaveBeenCalledWith('My queue')
    fireEvent.click(screen.getByRole('checkbox', { name: /Shared with everyone/i }))
    expect(onSharedChange).toHaveBeenCalledWith(true)
  })

  it('confirms before delete', () => {
    const onDelete = vi.fn()
    render(
      <FilterSetDialog
        open
        onOpenChange={vi.fn()}
        mode="edit"
        name="Active Shipments"
        onNameChange={vi.fn()}
        columns={COLUMNS}
        onToggleColumn={vi.fn()}
        onMoveColumn={vi.fn()}
        shared
        onSharedChange={vi.fn()}
        canDelete
        onDelete={onDelete}
        onSave={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Confirm$/i }))
    expect(onDelete).toHaveBeenCalled()
  })
})
