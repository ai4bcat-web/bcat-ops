// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { ColumnTemplateDialog } from './ColumnTemplateDialog'

const COLUMNS = [
  { key: 'status', header: 'Status', selected: true },
  { key: 'pro', header: 'PRO #', selected: true },
  { key: 'equip', header: 'Equip', selected: false },
]

describe('ColumnTemplateDialog', () => {
  it('edits the name and shared flag', () => {
    const onNameChange = vi.fn()
    const onSharedChange = vi.fn()
    render(
      <ColumnTemplateDialog
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
        onSave={vi.fn()}
      />
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Dispatch' } })
    expect(onNameChange).toHaveBeenCalledWith('Dispatch')
    fireEvent.click(screen.getByRole('checkbox', { name: /Shared with everyone/i }))
    expect(onSharedChange).toHaveBeenCalledWith(true)
  })

  it('toggles and reorders columns', () => {
    const onToggleColumn = vi.fn()
    const onMoveColumn = vi.fn()
    render(
      <ColumnTemplateDialog
        open
        onOpenChange={vi.fn()}
        mode="edit"
        name="RYNE"
        onNameChange={vi.fn()}
        columns={COLUMNS}
        onToggleColumn={onToggleColumn}
        onMoveColumn={onMoveColumn}
        shared={false}
        onSharedChange={vi.fn()}
        canDelete
        onDelete={vi.fn()}
        onSave={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('checkbox', { name: /Equip/i }))
    expect(onToggleColumn).toHaveBeenCalledWith('equip')
    fireEvent.click(screen.getByRole('button', { name: /Move PRO # up/i }))
    expect(onMoveColumn).toHaveBeenCalledWith('pro', 'up')
  })

  it('confirms before delete', () => {
    const onDelete = vi.fn()
    render(
      <ColumnTemplateDialog
        open
        onOpenChange={vi.fn()}
        mode="edit"
        name="RYNE"
        onNameChange={vi.fn()}
        columns={COLUMNS}
        onToggleColumn={vi.fn()}
        onMoveColumn={vi.fn()}
        shared={false}
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
