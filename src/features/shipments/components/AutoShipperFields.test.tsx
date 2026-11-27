// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { AutoShipperFields } from './AutoShipperFields'
import { EMPTY_AUTO_SHIPPER, autoShipperPayload, type AutoShipperForm } from '../autoShipperForm'
import { normalizeCarShipping } from '@/lib/squareInvoicing'

function Harness() {
  const [value, setValue] = useState<AutoShipperForm>(EMPTY_AUTO_SHIPPER)
  return (
    <>
      <AutoShipperFields value={value} onChange={setValue} />
      <output data-testid="payload">{JSON.stringify(autoShipperPayload(value))}</output>
    </>
  )
}

describe('AutoShipperFields', () => {
  it('asks for the payer and the vehicle, and says nothing is sent until Send invoice', () => {
    render(<Harness />)
    for (const label of ['Payer name', 'Payer e-mail', 'Payer phone', 'Vehicle year', 'Vehicle make', 'Vehicle model']) {
      expect(screen.getByLabelText(label)).toBeInTheDocument()
    }
    expect(screen.getByTestId('auto-shipper-fields')).toHaveTextContent('Nothing is sent to the payer until someone clicks Send invoice')
  })

  it('what is typed becomes a payload that passes the shared validation', () => {
    render(<Harness />)
    fireEvent.change(screen.getByLabelText('Payer name'), { target: { value: 'Pat Example' } })
    fireEvent.change(screen.getByLabelText('Payer e-mail'), { target: { value: 'pat@example.com' } })
    fireEvent.change(screen.getByLabelText('Payer phone'), { target: { value: '8475550100' } })
    fireEvent.change(screen.getByLabelText('Vehicle year'), { target: { value: '2018' } })
    fireEvent.change(screen.getByLabelText('Vehicle make'), { target: { value: 'Honda' } })
    fireEvent.change(screen.getByLabelText('Vehicle model'), { target: { value: 'Civic' } })
    const payload = JSON.parse(screen.getByTestId('payload').textContent ?? '{}')
    expect(normalizeCarShipping(payload).ok).toBe(true)
  })

  it('an empty form is refused with the first thing missing', () => {
    const r = normalizeCarShipping(autoShipperPayload(EMPTY_AUTO_SHIPPER))
    expect(r.ok).toBe(false)
  })
})
