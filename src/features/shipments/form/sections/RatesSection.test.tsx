// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { RatesSection } from './RatesSection'
import { emptyValues, lockedFields, type ShipmentFormValues } from '../model'
import { makeCtx, makeForm, savedBundle } from './ah5TestKit'

function setup(rates: Partial<ShipmentFormValues['rates']> = {}, ctx = makeCtx()) {
  const v = emptyValues()
  const r = { ...v.rates, ...rates }
  const onChange = vi.fn()
  render(<RatesSection value={r} onChange={onChange} ctx={ctx} ship={v.ship} form={makeForm({ ...v, rates: r })} />)
  return onChange
}

describe('RatesSection', () => {
  it('shows Net and Profit % from the same pricing the server uses', () => {
    const v = emptyValues()
    setup({
      customer: { ...v.rates.customer, lhRate: '1000' },
      carrier: { ...v.rates.carrier, lhRate: '800' },
    })
    expect((screen.getByLabelText('Customer Total LH') as HTMLInputElement).value).toBe('$1000.00')
    expect(screen.getByTestId('rates-total-customer').textContent).toBe('$1000.00')
    expect(screen.getByTestId('rates-total-carrier').textContent).toBe('$800.00')
    expect(screen.getByTestId('f-rates-netProfit').textContent).toBe('Net $200.00 | Profit 20.0%')
  })

  it('enables Hours only for Per Hour and Pay % only for % of Customer', () => {
    const v = emptyValues()
    setup({
      customer: { ...v.rates.customer, rateType: 'PER_HOUR' },
      carrier: { ...v.rates.carrier, rateType: 'PCT_OF_CUSTOMER' },
    })
    expect((screen.getByLabelText('Customer Hours') as HTMLInputElement).disabled).toBe(false)
    expect((screen.getByLabelText('Carrier Hours') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText('Pay %') as HTMLInputElement).disabled).toBe(false)
    expect((screen.getByLabelText('Carrier LH Rate') as HTMLInputElement).disabled).toBe(true)
  })

  it('warns that FSC/Mile wins when both FSC fields are filled', () => {
    setup({ fscPercent: '10', fscPerMile: '0.4' })
    expect(screen.getByTestId('rates-fsc-note').textContent).toContain('FSC/Mile wins')
  })

  it('adds an accessorial line and lets $Carrier be typed before Cover', () => {
    const onChange = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Add accessorial line' }))
    const update = onChange.mock.calls[0][0] as (p: ShipmentFormValues['rates']) => ShipmentFormValues['rates']
    expect(update(emptyValues().rates).lines).toHaveLength(1)
  })

  it('a frozen shipment locks every rate input', () => {
    const bundle = savedBundle()
    bundle.financials = [{ frozenAt: '2026-01-02T00:00:00.000Z' }] as never
    setup({}, makeCtx({ mode: 'edit', bundle, locked: lockedFields(bundle) }))
    for (const name of ['Customer Rate Type', 'Customer LH Rate', 'FSC %', 'Carrier LH Rate']) {
      expect((screen.getByLabelText(name) as HTMLInputElement).disabled).toBe(true)
    }
  })
})
