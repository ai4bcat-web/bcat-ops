// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { CustomerRecord, QuoteRecord, UserProfileRecord } from '@/types/tms'
import { emptyValues, type ShipmentFormValues } from '../model'
import type { FormCtx } from '../sectionProps'
import { RolesSection } from './RolesSection'
import { ValuesHost, type Host } from './SectionHost'
import { makeCtx, sliceChange } from './sectionTestKit'

const quotesMock = vi.fn()
vi.mock('@/hooks/useCustomerQuotes', () => ({ useCustomerQuotes: (id: string | null) => quotesMock(id) }))
vi.mock('@/hooks/useStaff', () => ({ useStaff: () => ({ staff: [], loading: false }) }))

const q = (id: string, status: string, quoteDate: string, amountCents: number) => ({ id, status, quoteDate, amountCents, side: 'SELL' }) as unknown as QuoteRecord

function setup(over: Partial<FormCtx> = {}, seed?: (v: ShipmentFormValues) => ShipmentFormValues) {
  const host: { current: Host | null } = { current: null }
  render(
    <ValuesHost onHost={(h) => { host.current = h }} initial={seed ? seed(emptyValues()) : undefined}>
      {(values, update, form) => (
        <RolesSection value={values.roles} onChange={sliceChange(update, 'roles')} ctx={makeCtx(over)} form={form} />
      )}
    </ValuesHost>,
  )
  return host
}
const CUSTOMER = { id: 'c1', name: 'Acme' } as unknown as CustomerRecord

describe('RolesSection', () => {
  it('offers only live quotes, newest first, for the shipment’s customer', () => {
    quotesMock.mockReturnValue({
      quotes: [q('q1', 'QUOTED', '2026-01-02', 150000), q('q2', 'LOST', '2026-03-01', 90000), q('q3', 'WON', '2026-02-01', 200000), q('q4', 'DRAFT', '2026-04-01', 1)],
    })
    setup({ customer: CUSTOMER })
    expect(quotesMock).toHaveBeenCalledWith('c1')
    const sel = screen.getByLabelText('Quote') as HTMLSelectElement
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(['', 'q3', 'q1'])
    fireEvent.change(sel, { target: { value: 'q3' } })
    expect(sel.value).toBe('q3')
  })

  it('has no quote choices before a customer is picked', () => {
    quotesMock.mockReturnValue({ quotes: [] })
    setup()
    expect(quotesMock).toHaveBeenCalledWith(null)
    expect((screen.getByLabelText('Quote') as HTMLSelectElement).disabled).toBe(true)
  })

  it('keeps an already-linked quote visible even when it is no longer open, and locks it when invoiced', () => {
    quotesMock.mockReturnValue({ quotes: [q('q9', 'LOST', '2026-01-01', 5000)] })
    setup(
      { customer: CUSTOMER, locked: { fields: { quote: 'The invoice snapshot owns this.' }, stops: {}, voided: false } },
      (v) => ({ ...v, roles: { ...v.roles, quoteId: 'q9' } }),
    )
    const sel = screen.getByLabelText('Quote') as HTMLSelectElement
    expect(sel.value).toBe('q9')
    expect(sel.disabled).toBe(true)
  })

  it('Dispatcher Actual is derived from who last moved the load and is read-only', () => {
    quotesMock.mockReturnValue({ quotes: [] })
    const staff = [{ id: 'u1', email: 'dee@example.invalid', name: 'Dee Dispatch', role: 'CARRIER_REP', status: 'ACTIVE' }] as unknown as UserProfileRecord[]
    setup({
      bundle: { loads: [{ statusChangedBy: 'u1' }], orders: [] } as unknown as FormCtx['bundle'],
      directory: { customers: [], locations: [], carriers: [], staff },
    })
    const actual = screen.getByLabelText('Dispatcher Actual') as HTMLInputElement
    expect(actual.readOnly).toBe(true)
    expect(actual.value).toContain('Dee')
  })

  it('Dispatcher Actual is blank on a new shipment', () => {
    quotesMock.mockReturnValue({ quotes: [] })
    setup()
    expect((screen.getByLabelText('Dispatcher Actual') as HTMLInputElement).value).toBe('')
  })

  it('stores Tariff and respects busy', () => {
    quotesMock.mockReturnValue({ quotes: [] })
    const host = setup()
    fireEvent.change(screen.getByLabelText('Tariff'), { target: { value: 'T-100' } })
    expect(host.current!.getValues().roles.tariff).toBe('T-100')
  })

  it('disables every field while a pipeline runs', () => {
    quotesMock.mockReturnValue({ quotes: [] })
    setup({ busy: true })
    expect((screen.getByLabelText('Tariff') as HTMLInputElement).disabled).toBe(true)
  })
})
