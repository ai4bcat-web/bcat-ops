// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { RatesSection } from './RatesSection'
import { emptyCarrierSlot, emptyValues, lockedFields, syncCarrierSlots, type ShipmentFormValues } from '../model'
import { makeCtx, makeForm, savedBundle } from './ah5TestKit'

function setup(rates: Partial<ShipmentFormValues['rates']> = {}, ctx = makeCtx()) {
  const v = emptyValues()
  const r = { ...v.rates, ...rates }
  const onChange = vi.fn()
  render(<RatesSection value={r} onChange={onChange} ctx={ctx} ship={v.ship} form={makeForm({ ...v, rates: r })} />)
  return onChange
}

describe('RatesSection', () => {
  it('prices the Total LH cells from the same pricing the server uses', () => {
    const v = emptyValues()
    setup({
      customer: { ...v.rates.customer, lhRate: '1000' },
      carrier: { ...v.rates.carrier, lhRate: '800' },
    })
    // Calculated totals are plain text, not input boxes.
    expect(screen.getByLabelText('Customer Total LH').tagName).toBe('OUTPUT')
    expect(screen.getByLabelText('Customer Total LH').textContent).toBe('$1000.00')
    expect(screen.getByLabelText('Carrier Total LH').tagName).toBe('OUTPUT')
    expect(screen.getByLabelText('Carrier Total LH').textContent).toBe('$800.00')
    expect(screen.queryByTestId('f-rates-netProfit')).toBeNull()
  })

  it('marks where the rate goes: LH boxes say "enter here" with a unit placeholder; blank totals read "—"', () => {
    const v = emptyValues()
    const onChange = setup({ carrier: { ...v.rates.carrier, rateType: 'PER_MILE' } })
    expect(screen.getByText('Carrier LH Rate — enter here')).toBeTruthy()
    expect(screen.getByText('Carrier Total LH — calculated')).toBeTruthy()
    expect((screen.getByLabelText('Carrier LH Rate') as HTMLInputElement).placeholder).toBe('$ per mile')
    expect((screen.getByLabelText('Customer LH Rate') as HTMLInputElement).placeholder).toBe('$0.00')
    expect(screen.getByLabelText('Carrier Total LH').textContent).toBe('—')
    fireEvent.change(screen.getByLabelText('Carrier LH Rate'), { target: { value: '2.50' } })
    expect(onChange).toHaveBeenCalled()
  })

  it('shows Hours only for Per Hour and Pay % only for % of Customer', () => {
    const v = emptyValues()
    setup({
      customer: { ...v.rates.customer, rateType: 'PER_HOUR' },
      carrier: { ...v.rates.carrier, rateType: 'PCT_OF_CUSTOMER' },
    })
    expect(screen.getByLabelText('Customer Hours')).toBeTruthy()
    expect(screen.queryByLabelText('Carrier Hours')).toBeNull()
    expect(screen.getByLabelText('Pay %')).toBeTruthy()
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

  it('one carrier: no Paid to select; two carriers: a rate row each and a Paid to select that disables $Carrier for no carrier', () => {
    const one = emptyValues()
    one.rates.lines = [{ id: '', carrierLineId: '', release: '', paidTo: '', code: 'LUMPER', label: '', carrierAmount: '', customerAmount: '10', note: '' }]
    const first = render(<RatesSection value={one.rates} onChange={vi.fn()} ctx={makeCtx()} ship={one.ship} form={makeForm(one)} carriers={one.carriers} />)
    expect(screen.queryByTestId('line-paidTo-0')).toBeNull()
    expect(screen.queryByTestId('rates-carrier-c1-rate')).toBeNull()
    first.unmount()

    const two = syncCarrierSlots(null, { ...one, carriers: [...one.carriers, { ...emptyCarrierSlot('c1'), carrierName: 'ZZ Second' }] })
    const update = vi.fn()
    const form = { ...makeForm(two), update }
    const onChange = vi.fn()
    render(<RatesSection value={two.rates} onChange={onChange} ctx={makeCtx()} ship={two.ship} form={form} carriers={two.carriers} />)
    expect(screen.getByTestId('rates-carrier-c0-rate')).toBeTruthy()
    expect(screen.getByTestId('rates-carrier-c1-rate')).toBeTruthy()
    const paid = screen.getByTestId('line-paidTo-0') as HTMLSelectElement
    expect(Array.from(paid.options).map((o) => o.text)).toEqual(['Carrier 1', 'ZZ Second', 'Not paid to a carrier'])
    expect(paid.value).toBe('NONE')
    expect((screen.getByLabelText('$Carrier 1') as HTMLInputElement).disabled).toBe(true)
    fireEvent.change(screen.getByTestId('rates-carrier-c1-lhRate'), { target: { value: '300' } })
    const next = (update.mock.calls[0][0] as (p: ShipmentFormValues) => ShipmentFormValues)(two)
    expect(next.carriers[1].rate.lhRate).toBe('300')
    expect(next.carriers[0].rate.lhRate).toBe('')
    fireEvent.change(paid, { target: { value: 'c1' } })
    const patch = (onChange.mock.calls[0][0] as (p: ShipmentFormValues['rates']) => ShipmentFormValues['rates'])(two.rates)
    expect(patch.lines[0].paidTo).toBe('c1')
  })

  it('one table with Pay carrier / Charge customer columns and running footer totals', () => {
    const v = emptyValues()
    v.rates.lines = [
      { id: '', carrierLineId: '', release: '', paidTo: '', code: 'LUMPER', label: '', carrierAmount: '40', customerAmount: '65', note: '' },
      { id: '', carrierLineId: '', release: '', paidTo: '', code: 'TONU', label: '', carrierAmount: '', customerAmount: '25', note: '' },
    ]
    v.rates.customer = { ...v.rates.customer, lhRate: '1000' }
    v.rates.carrier = { ...v.rates.carrier, lhRate: '800' }
    render(<RatesSection value={v.rates} onChange={vi.fn()} ctx={makeCtx()} ship={v.ship} form={makeForm(v)} carriers={v.carriers} />)
    expect(screen.getByTestId('rates-head-carrier').textContent).toBe('Pay carrier')
    expect(screen.getByTestId('rates-head-customer').textContent).toBe('Charge customer')
    expect(screen.getByTestId('rates-acc-subtotal-carrier').textContent).toBe('$40.00')
    expect(screen.getByTestId('rates-acc-subtotal-customer').textContent).toBe('$90.00')
    expect(screen.getByTestId('rates-total-carrier').textContent).toContain('Pay carrier total')
    expect(screen.getByTestId('rates-total-carrier').textContent).toContain('$840.00')
    expect(screen.getByTestId('rates-total-customer').textContent).toContain('Charge customer total')
    expect(screen.getByTestId('rates-total-customer').textContent).toContain('$1090.00')
  })

  it('removes a row', () => {
    const v = emptyValues()
    v.rates.lines = [
      { id: '', carrierLineId: '', release: '', paidTo: '', code: 'A', label: '', carrierAmount: '1', customerAmount: '2', note: '' },
      { id: '', carrierLineId: '', release: '', paidTo: '', code: 'B', label: '', carrierAmount: '3', customerAmount: '4', note: '' },
    ]
    const onChange = vi.fn()
    render(<RatesSection value={v.rates} onChange={onChange} ctx={makeCtx()} ship={v.ship} form={makeForm(v)} carriers={v.carriers} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove accessorial line 1' }))
    const next = (onChange.mock.calls[0][0] as (p: ShipmentFormValues['rates']) => ShipmentFormValues['rates'])(v.rates)
    expect(next.lines.map((l) => l.code)).toEqual(['B'])
  })

  it('typing a carrier and a customer amount edits both sides of the same row', () => {
    const v = emptyValues()
    v.rates.lines = [{ id: '', carrierLineId: '', release: '', paidTo: '', code: 'LUMPER', label: '', carrierAmount: '', customerAmount: '', note: '' }]
    const onChange = vi.fn()
    render(<RatesSection value={v.rates} onChange={onChange} ctx={makeCtx()} ship={v.ship} form={makeForm(v)} carriers={v.carriers} />)
    fireEvent.change(screen.getByLabelText('$Carrier 1'), { target: { value: '40' } })
    fireEvent.change(screen.getByLabelText('$Customer 1'), { target: { value: '65' } })
    const apply = (i: number) => (onChange.mock.calls[i][0] as (p: ShipmentFormValues['rates']) => ShipmentFormValues['rates'])(v.rates).lines[0]
    expect(apply(0).carrierAmount).toBe('40')
    expect(apply(1).customerAmount).toBe('65')
  })
})
