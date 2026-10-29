// @vitest-environment jsdom
/**
 * The picker's contract with the board: the catalog is searchable and grouped, the
 * chosen list reorders by drag (and by button), pins land first in the applied order,
 * and widths ride along inside their 60–600 bounds.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { ColumnsPickerDialog, type ColumnsPickerResult } from './ColumnsPickerDialog'

const BASE = {
  columns: ['status', 'proNumber', 'customerName'],
  widths: { status: 150 },
  pinned: [] as string[],
}

let applied: ColumnsPickerResult | null
let saved: (ColumnsPickerResult & { name: string; shared: boolean }) | null

function renderPicker(overrides: Partial<Parameters<typeof ColumnsPickerDialog>[0]> = {}) {
  applied = null
  saved = null
  render(
    <ColumnsPickerDialog
      open
      onOpenChange={vi.fn()}
      columns={BASE.columns}
      widths={BASE.widths}
      pinned={BASE.pinned}
      onApply={(next) => {
        applied = next
      }}
      onSaveTemplate={(next) => {
        saved = next
      }}
      {...overrides}
    />,
  )
}

/** The draggable row of one chosen column, by its label. */
function chosenRow(label: string): HTMLElement {
  const text = screen.getByText(label, { selector: 'span.truncate' })
  const row = text.closest('[draggable="true"]')
  if (!row) throw new Error(`no draggable row for ${label}`)
  return row as HTMLElement
}

function applyAndGet(): ColumnsPickerResult {
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
  if (!applied) throw new Error('onApply was not called')
  return applied
}

beforeEach(() => {
  applied = null
  saved = null
})

describe('ColumnsPickerDialog', () => {
  it('groups the catalog by source and filters across label and key', () => {
    renderPicker()
    // Group headers render in the catalog order.
    for (const group of ['Shipment', 'Order', 'Load', 'Carrier leg', 'Customer', 'Carrier', 'Computed']) {
      expect(screen.getByText(group, { selector: '.tms-board-section-title' })).toBeInTheDocument()
    }

    fireEvent.change(screen.getByRole('textbox', { name: 'Search columns' }), { target: { value: 'mc' } })
    expect(screen.getByRole('checkbox', { name: 'Carrier MC' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Customer MC' })).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: 'Status' })).not.toBeInTheDocument()

    fireEvent.change(screen.getByRole('textbox', { name: 'Search columns' }), { target: { value: 'ratecononfile' } })
    expect(screen.getByRole('checkbox', { name: 'Rate Con On File' })).toBeInTheDocument()
  })

  it('adds a checked column to the board list and removes an unchecked one', () => {
    renderPicker()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Carrier MC' }))
    expect(chosenRow('Carrier MC')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Status' }))
    expect(screen.queryByText('Status', { selector: 'span.truncate' })).not.toBeInTheDocument()

    const result = applyAndGet()
    expect(result.columns).toEqual(['proNumber', 'customerName', 'carrierMc'])
  })

  it('reorders by drag and emits the new order on Apply', () => {
    renderPicker()
    fireEvent.dragStart(chosenRow('Status'))
    fireEvent.dragOver(chosenRow('Customer'))
    fireEvent.drop(chosenRow('Customer'))

    const result = applyAndGet()
    expect(result.columns).toEqual(['proNumber', 'customerName', 'status'])
  })

  it('keeps the up/down buttons as the keyboard reorder path', () => {
    renderPicker()
    fireEvent.click(screen.getByRole('button', { name: 'Move PRO # up' }))
    const result = applyAndGet()
    expect(result.columns).toEqual(['proNumber', 'status', 'customerName'])
  })

  it('sorts pinned columns to the front of the applied order', () => {
    renderPicker()
    fireEvent.click(screen.getByRole('button', { name: 'Pin Customer' }))
    fireEvent.dragStart(chosenRow('Status'))
    fireEvent.dragOver(chosenRow('Customer'))
    fireEvent.drop(chosenRow('Customer'))

    const result = applyAndGet()
    // The drag moved Status last, but the pin beats the manual order.
    expect(result.columns).toEqual(['customerName', 'proNumber', 'status'])
    expect(result.pinned).toEqual(['customerName'])
  })

  it('unpins on a second click', () => {
    renderPicker({ pinned: ['status'] })
    fireEvent.click(screen.getByRole('button', { name: 'Unpin Status' }))
    const result = applyAndGet()
    expect(result.pinned).toEqual([])
    expect(result.columns).toEqual(['status', 'proNumber', 'customerName'])
  })

  it('clamps widths to 60–600 px and carries them into the payload', () => {
    renderPicker()
    const widthOfStatus = screen.getByRole('spinbutton', { name: 'Width of Status' })
    expect(widthOfStatus).toHaveValue(150)

    fireEvent.change(widthOfStatus, { target: { value: '30' } })
    expect(widthOfStatus).toHaveValue(60)
    fireEvent.change(widthOfStatus, { target: { value: '9999' } })
    expect(widthOfStatus).toHaveValue(600)

    const result = applyAndGet()
    expect(result.widths.status).toBe(600)
    // Untouched columns carry the catalog's default width.
    expect(result.widths.proNumber).toBe(120)
    expect(result.widths.customerName).toBe(180)
  })

  it('saves a template with the same columns, widths and pins plus name and shared', () => {
    renderPicker()
    fireEvent.click(screen.getByRole('button', { name: 'Pin PRO #' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Template name' }), { target: { value: 'Dispatch desk' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Shared' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save as template' }))

    if (!saved) throw new Error('onSaveTemplate was not called')
    expect(saved.name).toBe('Dispatch desk')
    expect(saved.shared).toBe(true)
    expect(saved.columns).toEqual(['proNumber', 'status', 'customerName'])
    expect(saved.pinned).toEqual(['proNumber'])
    expect(saved.widths.status).toBe(150)
  })

  it('offers Apply only when no template saver is wired', () => {
    renderPicker({ onSaveTemplate: undefined })
    expect(screen.queryByRole('button', { name: 'Save as template' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeInTheDocument()
  })
})
