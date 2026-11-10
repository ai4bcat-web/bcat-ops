// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { FreightCard } from './FreightCard'
import { renderCard } from './cardTestKit'

describe('FreightCard shipment type', () => {
  it('comes after Division, lists every type, and starts on the division default (Truckload)', () => {
    renderCard(FreightCard)
    const select = screen.getByTestId('f-shipping-shipmentType') as HTMLSelectElement
    expect(select.value).toBe('FTL')
    const first = document.querySelector('[data-testid="section-freight-body"] select, [data-testid="section-freight-body"] input')
    // Division is first, Shipment type second.
    expect(first).toBe(screen.getByTestId('f-shipping-revDivision'))
    expect(document.querySelectorAll('[data-testid="f-shipping-revDivision"]')).toHaveLength(1)
    const labels = Array.from(select.options).map((o) => o.textContent)
    expect(labels).toHaveLength(25)
    expect(labels).toEqual(expect.arrayContaining(['Truckload (FTL)', 'Auto transport (open)', 'Heavy haul / Oversize', 'Cross-border (Mexico)', 'Courier / Parcel', 'Other']))
  })

  it('picking a type sets the stored mode, default equipment and chips; typed equipment survives', () => {
    const host = renderCard(FreightCard)
    fireEvent.change(screen.getByTestId('f-shipping-shipmentType'), { target: { value: 'REEFER' } })
    expect(host.current!.getValues()).toMatchObject({ shipmentType: 'REEFER', mode: 'FTL' })
    expect(host.current!.getValues().ship.equipmentType).toBe('Reefer')
    expect(host.current!.getValues().ship.temp.on).toBe(true)
    fireEvent.change(screen.getByTestId('f-shipping-equipmentType'), { target: { value: 'My trailer' } })
    fireEvent.change(screen.getByTestId('f-shipping-shipmentType'), { target: { value: 'FLATBED_SPECIALIZED' } })
    expect(host.current!.getValues().ship.equipmentType).toBe('My trailer')
  })

  it('changing the revenue division swaps the type only while it is still the default', () => {
    const host = renderCard(FreightCard, { ctx: () => ({ divisions: [{ depth: 0, division: { id: 'd1', code: 'CAR_SHIPPING', name: 'Auto Shipping', active: true, parentId: null } }] as never }) })
    fireEvent.change(screen.getByTestId('f-shipping-revDivision'), { target: { value: 'CAR_SHIPPING' } })
    expect(host.current!.getValues().shipmentType).toBe('AUTO_OPEN')
  })
})

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

  it('Calculate totals sums the picks into Pieces and Weight; Customer ref is not in the card (it lives in the header strip)', () => {
    const host = renderCard(FreightCard, {
      seed: (v) => ({ ...v, stops: [{ ...v.stops[0], pieces: '3', weightLbs: '1000' }, { ...v.stops[1] }] }),
    })
    fireEvent.click(screen.getByTestId('f-shipping-calculateTotals'))
    expect(host.current!.getValues().ship).toMatchObject({ pieces: '3', weightLbs: '1000' })
    expect(screen.getByTestId('f-shipping-hint').textContent).toBe('1 pick counted')
    expect(screen.queryByTestId('f-freight-customerRef')).toBeNull()
    expect(screen.queryByTestId('f-customer-refNo')).toBeNull()
  })
})

describe('FreightCard two-column layout', () => {
  it('renders Load details and Quantities groups and keeps every field in one of them', () => {
    renderCard(FreightCard)
    const details = screen.getByTestId('f-shipping-col-details')
    const qty = screen.getByTestId('f-shipping-col-quantities')
    expect(screen.getByRole('group', { name: 'Load details' })).toBe(details)
    expect(screen.getByRole('group', { name: 'Quantities' })).toBe(qty)
    for (const id of ['revDivision', 'shipmentType', 'equipmentType', 'description']) expect(details.querySelector(`[data-testid="f-shipping-${id}"]`), id).not.toBeNull()
    for (const id of ['weightLbs', 'pieces', 'footage', 'freightClass', 'declaredValue']) expect(qty.querySelector(`[data-testid="f-shipping-${id}"]`), id).not.toBeNull()
    expect(screen.getByTestId('f-shipping-flags')).toBeTruthy()
  })
})
