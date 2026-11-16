// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CityInput } from '@/features/tms/kit'
import { addressPickPatch, useAddressAutofill } from './useAddressAutofill'

afterEach(cleanup)

function Form({ initial, upper }: { initial?: Partial<{ zip: string; city: string; state: string }>; upper?: boolean }) {
  const [v, setV] = useState({ zip: '', city: '', state: '', ...initial })
  const { hint, pickCity } = useAddressAutofill({
    zip: v.zip, city: v.city, state: v.state, upper,
    apply: (p) => setV((prev) => ({ ...prev, ...p })),
  })
  return (
    <div>
      <CityInput aria-label="city" value={v.city} state={v.state} onChange={(city) => setV((p) => ({ ...p, city }))} onPick={pickCity} />
      <input aria-label="state" value={v.state} onChange={(e) => setV((p) => ({ ...p, state: e.target.value }))} />
      <input aria-label="zip" value={v.zip} onChange={(e) => setV((p) => ({ ...p, zip: e.target.value }))} />
      {hint && <p role="status">{hint}</p>}
    </div>
  )
}
const val = (n: string) => (screen.getByLabelText(n) as HTMLInputElement).value
const type = (n: string, v: string) => fireEvent.change(screen.getByLabelText(n), { target: { value: v } })

describe('useAddressAutofill', () => {
  it('a typed ZIP fills a blank city and state, in capitals for a load stop, and says so', async () => {
    render(<Form upper />)
    type('zip', '54622')
    await waitFor(() => expect(val('city')).toBe('COCHRANE'))
    expect(val('state')).toBe('WI')
    expect(screen.getByRole('status').textContent).toContain('54622')
  })

  it('a ZIP+4 typed without its dash fills too', async () => {
    render(<Form />)
    type('zip', '604351234')
    await waitFor(() => expect(val('city')).toBe('Joliet'))
  })

  it('a ZIP never overwrites a city or state that is already typed', async () => {
    render(<Form initial={{ city: 'Plainfield', state: '' }} />)
    type('zip', '60435')
    await waitFor(() => expect(val('state')).toBe('IL'))
    expect(val('city')).toBe('Plainfield')
  })

  it('a typed city offers places; picking one fills its state and ZIP', async () => {
    render(<Form upper />)
    type('city', 'Cochr')
    const option = await screen.findByRole('option', { name: /Cochrane, WI/ })
    fireEvent.mouseDown(option)
    await waitFor(() => expect(val('zip')).toBe('54622'))
    expect(val('state')).toBe('WI')
    expect(val('city')).toBe('COCHRANE')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('picking a city keeps a ZIP that is already typed', async () => {
    render(<Form initial={{ zip: '54601' }} />)
    type('city', 'Cochr')
    fireEvent.mouseDown(await screen.findByRole('option', { name: /Cochrane, WI/ }))
    await waitFor(() => expect(val('state')).toBe('WI'))
    expect(val('zip')).toBe('54601')
  })

  it('the arrow keys and Enter pick without the mouse, Escape closes', async () => {
    render(<Form />)
    type('city', 'Cochrane')
    await screen.findByRole('listbox')
    const input = screen.getByLabelText('city')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(val('state')).toBe('WI'))
    type('city', 'Cochran')
    await screen.findByRole('listbox')
    fireEvent.keyDown(screen.getByLabelText('city'), { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('addressPickPatch fills the ZIP only when blank', () => {
    const option = { city: 'Cochrane', state: 'WI', zip: '54622', zipCount: 1 }
    expect(addressPickPatch(option, '')).toEqual({ city: 'Cochrane', state: 'WI', zip: '54622' })
    expect(addressPickPatch(option, '54601', true)).toEqual({ city: 'COCHRANE', state: 'WI' })
  })
})
