// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { SummaryRail } from './SummaryRail'
import type { FormIssue } from './sectionProps'

vi.mock('./ActivityBlock', () => ({ ActivityBlock: () => null }))
vi.mock('./ProgressBlock', () => ({ ProgressBlock: () => null }))
vi.mock('./RailInvoiceStatus', () => ({ RailInvoiceStatus: () => null }))
vi.mock('./RailTrackingBlock', () => ({ RailTrackingBlock: () => null }))
vi.mock('./RailOtrRejectedBlock', () => ({ RailOtrRejectedBlock: () => null }))
vi.mock('./RateHistoryRail', () => ({ RateHistoryRail: () => null }))
vi.mock('./cards/ratesSummary', () => ({ carrierBreakdown: () => [] }))

const issue = (over: Partial<FormIssue>): FormIssue => ({
  id: 'req:expense', section: 'rates', fieldKey: 'f-rates-carrierLhRate', label: 'Carrier cost / expense', message: 'Carrier cost / expense', severity: 'warn', ...over,
})

function renderRail(missing: FormIssue[], onFix?: (i: FormIssue) => void) {
  const focusField = vi.fn()
  const common = {
    values: { roles: {} }, update: vi.fn(), form: { focusField, getValues: () => ({}), update: vi.fn() },
    ctx: { directory: { carriers: [], staff: [] }, bundle: null, actions: {}, settings: null, busy: false, locked: { voided: false } },
  } as never
  const summary = { customerLine: '', laneLine: '', freightLine: '', money: { priced: false, netCents: 0, profitPct: 0, tone: 'green', customerTotalCents: 0, carrierTotalCents: 0, targetPct: 0, preview: { carriers: [] } } } as never
  render(
    <MemoryRouter>
      <SummaryRail common={common} summary={summary} rows={[]} attempted={false} Roles={() => null} RateHistory={() => null} missing={missing} onFix={onFix} />
    </MemoryRouter>,
  )
  return { focusField }
}

describe('SummaryRail — What\'s missing click-through', () => {
  it('clicking an item hands it to onFix', () => {
    const onFix = vi.fn()
    const i = issue({})
    renderRail([i], onFix)
    fireEvent.click(screen.getByTestId('rail-missing-req:expense'))
    expect(onFix).toHaveBeenCalledWith(i)
  })

  it('without onFix, it focuses the item\'s field', () => {
    const { focusField } = renderRail([issue({})])
    fireEvent.click(screen.getByTestId('rail-missing-req:expense'))
    expect(focusField).toHaveBeenCalledWith('f-rates-carrierLhRate')
  })

  it('every item shows a Fix → affordance and says it is clickable', () => {
    renderRail([issue({}), issue({ id: 'req:salesRep', label: 'Sales rep', fieldKey: 'f-roles-salesRepId' })])
    const chip = screen.getByTestId('rail-missing-req:expense')
    expect(chip.textContent).toContain('Fix →')
    expect(chip.getAttribute('title')).toContain('click to fix')
    expect(screen.getByTestId('rail-missing-req:salesRep')).toBeTruthy()
  })

  it('a customer item (editCustomer) is a button too, so it can open the dialog', () => {
    const onFix = vi.fn()
    renderRail([issue({ id: 'req:customer:CUSTOMER_AP_EMAIL', label: 'Customer has no AP e-mail', fieldKey: '', action: 'editCustomer' })], onFix)
    fireEvent.click(screen.getByTestId('rail-missing-req:customer:CUSTOMER_AP_EMAIL'))
    expect(onFix).toHaveBeenCalledWith(expect.objectContaining({ action: 'editCustomer' }))
  })
})
