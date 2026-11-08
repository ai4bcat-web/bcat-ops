// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useZipAutofill } from './useZipAutofill'

afterEach(cleanup)

function Form({ initial }: { initial?: { city: string; state: string } }) {
  const [v, setV] = useState({ zip: '', city: initial?.city ?? '', state: initial?.state ?? '' })
  useZipAutofill(v.zip, v.city, v.state, (f) => setV((p) => ({ ...p, ...(f.city && !p.city.trim() ? { city: f.city } : {}), ...(f.state && !p.state.trim() ? { state: f.state } : {}) })))
  const input = (k: 'zip' | 'city' | 'state') => <input aria-label={k} value={v[k]} onChange={(e) => setV((p) => ({ ...p, [k]: e.target.value }))} />
  return <div>{input('zip')}{input('city')}{input('state')}</div>
}
const val = (n: string) => (screen.getByLabelText(n) as HTMLInputElement).value
const type = (n: string, v: string) => fireEvent.change(screen.getByLabelText(n), { target: { value: v } })

describe('useZipAutofill', () => {
  it('fills city and state when a full zip is typed, and they stay editable', async () => {
    render(<Form />)
    type('zip', '60435')
    await waitFor(() => expect(val('city')).toBe('Joliet'))
    expect(val('state')).toBe('IL')
    type('city', 'Rockdale')
    expect(val('city')).toBe('Rockdale')
  })

  it('does not overwrite typed city or state', async () => {
    render(<Form initial={{ city: 'Plainfield', state: '' }} />)
    type('zip', '60435')
    await waitFor(() => expect(val('state')).toBe('IL'))
    expect(val('city')).toBe('Plainfield')
  })

  it('leaves the fields alone for a short, unknown or foreign zip', async () => {
    render(<Form />)
    for (const z of ['6043', '00000', 'K1A 0B1']) type('zip', z)
    await new Promise((r) => setTimeout(r, 50))
    expect(val('city')).toBe('')
    expect(val('state')).toBe('')
  })

  it('does not bring the autofill back after the city is cleared', async () => {
    render(<Form />)
    type('zip', '60435')
    await waitFor(() => expect(val('city')).toBe('Joliet'))
    type('city', '')
    await new Promise((r) => setTimeout(r, 50))
    expect(val('city')).toBe('')
  })
})
