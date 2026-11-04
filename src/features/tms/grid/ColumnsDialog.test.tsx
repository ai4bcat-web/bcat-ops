// @vitest-environment jsdom
/**
 * The shared Columns dialog's contract with a grid: the field list is grouped from the column
 * defs and searchable, "Select all in group" fills a section, the chosen list reorders and pins,
 * and widths ride along only once the person set them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { ColumnsDialog, type ColumnsDialogResult } from './ColumnsDialog'
import type { DenseColumn } from './denseGridModel'

interface Row {
  id: string
}

const col = (key: string, header: string, group: string, extra: Partial<DenseColumn<Row>> = {}): DenseColumn<Row> => ({
  key,
  header,
  group,
  text: () => '',
  ...extra,
})

const CATALOG: DenseColumn<Row>[] = [
  col('status', 'Status', 'Shipment'),
  col('pro', 'PRO #', 'Shipment'),
  col('customer', 'Customer', 'Shipment'),
  col('carrier', 'Carrier', 'Carrier'),
  col('carrierMc', 'Carrier MC', 'Carrier'),
  col('rate', 'Customer Rate', 'Financial'),
  col('actions', '', 'Shipment', { fixed: true, width: 40 }),
]

let applied: ColumnsDialogResult | null
let saved: (ColumnsDialogResult & { name: string; shared: boolean }) | null

function renderDialog(overrides: Partial<Parameters<typeof ColumnsDialog<Row>>[0]> = {}) {
  render(
    <ColumnsDialog<Row>
      open
      onOpenChange={vi.fn()}
      catalog={CATALOG}
      columns={['status', 'pro', 'customer']}
      widths={{ status: 150 }}
      pinned={[]}
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

function chosenRow(label: string): HTMLElement {
  const row = within(screen.getByTestId('cd-chosen')).getByText(label).closest('[draggable="true"]')
  if (!row) throw new Error(`no row for ${label}`)
  return row as HTMLElement
}

function chosenOrder(): string[] {
  return [...screen.getByTestId('cd-chosen').querySelectorAll('.tms-cd-name')].map((n) => n.textContent ?? '')
}

function apply(): ColumnsDialogResult {
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
  if (!applied) throw new Error('onApply was not called')
  return applied
}

beforeEach(() => {
  applied = null
  saved = null
})

describe('ColumnsDialog', () => {
  it('lists the fields under the groups the defs name, never the fixed columns', () => {
    renderDialog()
    const available = screen.getByTestId('cd-available')
    expect([...available.querySelectorAll('.tms-cd-group-name')].map((n) => n.textContent)).toEqual([
      'Shipment',
      'Carrier',
      'Financial',
    ])
    expect(within(available).getAllByRole('checkbox')).toHaveLength(6)
  })

  it('search filters the list and hides groups with no match', () => {
    renderDialog()
    fireEvent.change(screen.getByRole('textbox', { name: 'Search columns' }), { target: { value: 'carrier' } })
    const available = screen.getByTestId('cd-available')
    expect(within(available).getAllByRole('checkbox').map((c) => c.id)).toEqual(['tms-cd-carrier', 'tms-cd-carrierMc'])
    expect(screen.queryByRole('group', { name: 'Shipment' })).not.toBeInTheDocument()

    fireEvent.change(screen.getByRole('textbox', { name: 'Search columns' }), { target: { value: 'zzz' } })
    expect(screen.getByText('No columns match.')).toBeInTheDocument()
  })

  it('Select all in group adds only that group, and only what the search shows', () => {
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Select all in Carrier' }))
    expect(chosenOrder()).toEqual(['Status', 'PRO #', 'Customer', 'Carrier', 'Carrier MC'])

    fireEvent.change(screen.getByRole('textbox', { name: 'Search columns' }), { target: { value: 'rate' } })
    fireEvent.click(screen.getByRole('button', { name: 'Select all in Financial' }))
    expect(apply().columns).toEqual(['status', 'pro', 'customer', 'carrier', 'carrierMc', 'rate'])
  })

  it('Select all in a search-narrowed group leaves the unmatched fields out', () => {
    renderDialog()
    fireEvent.change(screen.getByRole('textbox', { name: 'Search columns' }), { target: { value: 'mc' } })
    fireEvent.click(screen.getByRole('button', { name: 'Select all in Carrier' }))
    expect(apply().columns).toEqual(['status', 'pro', 'customer', 'carrierMc'])
  })

  it('removing a column unpins it', () => {
    renderDialog({ pinned: ['status'] })
    fireEvent.click(screen.getByRole('button', { name: 'Remove Status' }))
    const result = apply()
    expect(result.columns).toEqual(['pro', 'customer'])
    expect(result.pinned).toEqual([])
  })

  it('reorders by drag and by the handle arrow keys', () => {
    renderDialog()
    fireEvent.dragStart(chosenRow('Status'))
    fireEvent.drop(chosenRow('Customer'))
    expect(chosenOrder()).toEqual(['PRO #', 'Customer', 'Status'])

    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder Status' }), { key: 'ArrowUp' })
    expect(apply().columns).toEqual(['pro', 'status', 'customer'])
  })

  it('sorts pinned columns to the front of the applied order', () => {
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Pin Customer' }))
    const result = apply()
    expect(result.columns).toEqual(['customer', 'status', 'pro'])
    expect(result.pinned).toEqual(['customer'])
  })

  it('shows the header-measured default for an untouched column and applies only widths the person set', () => {
    renderDialog()
    const status = screen.getByRole('spinbutton', { name: 'Width of Status' })
    const pro = screen.getByRole('spinbutton', { name: 'Width of PRO #' })
    expect(status).toHaveValue(150)
    expect(Number((pro as HTMLInputElement).value)).toBeGreaterThanOrEqual(72)

    fireEvent.change(pro, { target: { value: '30' } })
    fireEvent.blur(pro)
    expect(pro).toHaveValue(60)
    fireEvent.change(pro, { target: { value: '9999' } })
    fireEvent.blur(pro)
    expect(pro).toHaveValue(800)

    expect(apply().widths).toEqual({ status: 150, pro: 800 })
  })

  it('Reset widths drops every explicit width back to the defaults', () => {
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Reset widths' }))
    expect(Number((screen.getByRole('spinbutton', { name: 'Width of Status' }) as HTMLInputElement).value)).toBeLessThan(150)
    expect(apply().widths).toEqual({})
  })

  it('saves a template with columns, pins and only the widths set for chosen columns', () => {
    renderDialog({ widths: { status: 150, carrier: 200 } })
    fireEvent.click(screen.getByRole('button', { name: 'Pin PRO #' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Template name' }), { target: { value: 'Dispatch desk' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Shared' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save as template' }))

    expect(saved).toEqual({
      name: 'Dispatch desk',
      shared: true,
      columns: ['pro', 'status', 'customer'],
      pinned: ['pro'],
      widths: { status: 150 },
    })
  })

  it('offers Apply only when no template saver is wired', () => {
    renderDialog({ onSaveTemplate: undefined })
    expect(screen.queryByRole('button', { name: 'Save as template' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeInTheDocument()
  })
})
