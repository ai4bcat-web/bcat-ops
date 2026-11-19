// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { PayToWorklistDialog } from './PayToWorklistDialog'

const rows = [
  { carrierId: 'echo', carrierName: 'ECHO GLOBAL LOGISTIC', status: 'NEEDED' as const, bills: 1, cents: 240_000 },
  { carrierId: 'lama', carrierName: 'LAMA TRUCKING', status: 'CHOOSE' as const, bills: 3, cents: 105_000 },
]

describe('PayToWorklistDialog', () => {
  it('lists each carrier with what is missing, its open bills and the money waiting, in the order given', () => {
    render(<PayToWorklistDialog rows={rows} open onOpenChange={vi.fn()} onAdd={vi.fn()} />)
    expect(screen.getByText(/2 payees, 4 open bills, \$3,450\.00/)).toBeInTheDocument()
    const body = within(screen.getByRole('table', { name: 'Payees missing payment info' }))
    const lines = body.getAllByTestId('payto-worklist-row')
    expect(lines).toHaveLength(2)
    expect(within(lines[0]).getByText('ECHO GLOBAL LOGISTIC')).toBeInTheDocument()
    expect(within(lines[0]).getByText('Pay-to needed')).toBeInTheDocument()
    // The badge and the button both say it.
    expect(within(lines[1]).getAllByText('Choose pay-to')).toHaveLength(2)
    expect(within(lines[1]).getByText('$1,050.00')).toBeInTheDocument()
  })

  it('opens the editor for the carrier on its row', () => {
    const onAdd = vi.fn()
    render(<PayToWorklistDialog rows={rows} open onOpenChange={vi.fn()} onAdd={onAdd} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add pay-to for LAMA TRUCKING' }))
    expect(onAdd).toHaveBeenCalledWith(rows[1])
  })

  it('says Fix payment info for a payee that has a pay-to but lacks its bank info', () => {
    const onAdd = vi.fn()
    const bank = { carrierId: 'blue', carrierName: 'BLUE RIDGE', status: 'NO_BANK' as const, bills: 2, cents: 180_000 }
    render(<PayToWorklistDialog rows={[bank]} open onOpenChange={vi.fn()} onAdd={onAdd} />)
    expect(screen.getAllByText('No bank info').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Fix payment info for BLUE RIDGE' }))
    expect(onAdd).toHaveBeenCalledWith(bank)
  })

  it('says nothing is waiting once every payee has a pay-to', () => {
    render(<PayToWorklistDialog rows={[]} open onOpenChange={vi.fn()} onAdd={vi.fn()} />)
    expect(screen.getByText(/Every open bill has a payee with what it needs/)).toBeInTheDocument()
  })
})
