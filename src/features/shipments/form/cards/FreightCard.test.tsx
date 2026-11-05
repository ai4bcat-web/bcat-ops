// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { FreightCard } from './FreightCard'
import { renderCard } from './cardTestKit'

describe('FreightCard', () => {
  it('toggles the same flag keys the checkbox grid did, and only the clicked one', () => {
    const host = renderCard(FreightCard)
    fireEvent.click(screen.getByTestId('f-shipping-flag-hazmat'))
    fireEvent.click(screen.getByTestId('f-shipping-flag-hot'))
    fireEvent.click(screen.getByTestId('f-shipping-flag-hot'))
    const flags = host.current!.getValues().ship.flags
    expect(Object.entries(flags).filter(([, on]) => on).map(([k]) => k)).toEqual(['hazmat'])
  })

  it('reveals Temp / Tarps / Pallet sub-fields only while the chip is on, and clears them when it goes off', () => {
    const host = renderCard(FreightCard)
    expect(screen.queryByTestId('f-shipping-tempMin')).toBeNull()
    fireEvent.click(screen.getByTestId('f-shipping-tempControl'))
    fireEvent.change(screen.getByTestId('f-shipping-tempMin'), { target: { value: '-10' } })
    expect(host.current!.getValues().ship.temp).toMatchObject({ on: true, min: '-10' })
    fireEvent.click(screen.getByTestId('f-shipping-tarps'))
    fireEvent.change(screen.getByTestId('f-shipping-tarpSize'), { target: { value: '8 ft' } })
    expect(host.current!.getValues().ship.tarps).toEqual({ on: true, size: '8 ft' })
    fireEvent.click(screen.getByTestId('f-shipping-tempControl'))
    fireEvent.click(screen.getByTestId('f-shipping-tarps'))
    expect(screen.queryByTestId('f-shipping-tempMin')).toBeNull()
    expect(host.current!.getValues().ship.temp).toEqual({ on: false, unit: 'F', min: '', max: '', preCool: '' })
    expect(host.current!.getValues().ship.tarps).toEqual({ on: false, size: '' })
  })

  it('treats Liftgate / Inside as Yes or N/A, and keeps TONU disabled while creating', () => {
    const host = renderCard(FreightCard)
    fireEvent.click(screen.getByTestId('f-shipping-liftgate'))
    expect(host.current!.getValues().ship.liftgate).toBe(true)
    fireEvent.click(screen.getByTestId('f-shipping-liftgate'))
    expect(host.current!.getValues().ship.liftgate).toBeNull()
    expect((screen.getByTestId('f-shipping-flag-tonu') as HTMLInputElement).disabled).toBe(true)
  })

  it('Calculate totals sums the picks into Pieces and Weight; Customer Ref edits the customer ref', () => {
    const host = renderCard(FreightCard, {
      seed: (v) => ({ ...v, stops: [{ ...v.stops[0], pieces: '3', weightLbs: '1000' }, { ...v.stops[1] }] }),
    })
    fireEvent.click(screen.getByTestId('f-shipping-calculateTotals'))
    expect(host.current!.getValues().ship).toMatchObject({ pieces: '3', weightLbs: '1000' })
    expect(screen.getByTestId('f-shipping-hint').textContent).toBe('1 pick counted')
    fireEvent.change(screen.getByTestId('f-freight-customerRef'), { target: { value: 'PO-77' } })
    expect(host.current!.getValues().customer.refNo).toBe('PO-77')
  })
})
