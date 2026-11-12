// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ArSummaryStrip } from './ArSummaryStrip'
import { divisionRows } from './arDivisionRows'
import type { ArDivisionSlice, ArSummary } from './arSummary'

const slice = (over: Partial<ArDivisionSlice>): ArDivisionSlice => ({
  key: 'BROKERAGE', label: 'BCAT Logistics', cents: 0, division: 'BROKERAGE', divisionLabel: 'BCAT Logistics', subLabel: null, count: 1, ...over,
})

const summary = (byDivision: ArDivisionSlice[]): ArSummary => ({
  pendingOtrCents: 300_00, pendingOtrCount: 2,
  pendingShippersCents: 700_00, pendingShippersCount: 3,
  lateCents: 100_00, lateCount: 1,
  otrDaysToPay: 4.1, shipperDaysToPay: 33.8,
  byDivision,
})

describe('divisionRows', () => {
  it('groups sub-divisions under their division with a subtotal and shares of the total', () => {
    const rows = divisionRows([
      slice({ key: 'BROKERAGE', cents: 600_00 }),
      slice({ key: 'ASSETS/LOCAL', division: 'ASSETS', divisionLabel: 'Ivan Cartage', subLabel: 'Local drivers', cents: 300_00 }),
      slice({ key: 'ASSETS/BOX_TRUCK', division: 'ASSETS', divisionLabel: 'Ivan Cartage', subLabel: 'Box trucks', cents: 100_00 }),
    ], 1000_00)
    expect(rows.map((r) => [r.label, r.value, r.kind ?? 'row', r.share])).toEqual([
      ['BCAT Logistics', '$600.00', 'row', 0.6],
      ['Ivan Cartage', '$400.00', 'group', 0.4],
      ['Local drivers', '$300.00', 'sub', 0.3],
      ['Box trucks', '$100.00', 'sub', 0.1],
    ])
    // No division-only slice for Ivan Cartage: its group row cannot filter.
    expect(rows[1].readOnly).toBe(true)
  })
})

describe('ArSummaryStrip', () => {
  it('renders stat cards and filters by a division row', () => {
    const onDivision = vi.fn()
    render(<div className="tms-shell"><ArSummaryStrip summary={summary([slice({ cents: 1000_00 })])} division={null} onDivision={onDivision} /></div>)
    expect(screen.getByText('Pending with OTR')).toBeTruthy()
    expect(screen.getByText('2 invoices')).toBeTruthy()
    expect(screen.getByText('4.1 d')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /BCAT Logistics/ }))
    expect(onDivision).toHaveBeenCalledWith('BROKERAGE')
  })
})
