import { describe, expect, it } from 'vitest'
import { applyCustomerDefaults, emptyValues, valuesFromBundle } from './model'
import { applyShipmentType, typeForDivisionChange } from './shipmentType'

describe('applyShipmentType', () => {
  it('stores the key, derives the stored mode and fills default equipment and chips', () => {
    const v = applyShipmentType(emptyValues(), 'REEFER')
    expect(v).toMatchObject({ shipmentType: 'REEFER', mode: 'FTL' })
    expect(v.ship.equipmentType).toBe('Reefer')
    expect(v.ship.temp.on).toBe(true)
    expect(applyShipmentType(emptyValues(), 'HAZMAT').ship.flags.hazmat).toBe(true)
    expect(applyShipmentType(emptyValues(), 'AIR').mode).toBe('AIR')
  })

  it('never overwrites equipment a person typed or a chip that is already on', () => {
    const base = emptyValues()
    base.ship.equipmentType = 'Dry Van'
    base.ship.temp = { ...base.ship.temp, on: true, min: '30', max: '40' }
    const v = applyShipmentType(base, 'REEFER')
    expect(v.ship.equipmentType).toBe('Dry Van')
    expect(v.ship.temp).toMatchObject({ on: true, min: '30', max: '40' })
  })

  it('does not switch chips off when another type is picked', () => {
    const v = applyShipmentType(applyShipmentType(emptyValues(), 'HAZMAT'), 'FTL')
    expect(v.ship.flags.hazmat).toBe(true)
  })
})

describe('typeForDivisionChange', () => {
  const withDivision = (v: ReturnType<typeof emptyValues>, code: string) => ({ ...v, ship: { ...v.ship, revDivision: code } })

  it('swaps in the new division default while the old default is still in place', () => {
    const v = emptyValues()
    expect(typeForDivisionChange(v, withDivision(v, 'CAR_SHIPPING')).shipmentType).toBe('AUTO_OPEN')
    expect(typeForDivisionChange(v, withDivision(v, 'OWNER_OPERATOR')).shipmentType).toBe('POWER_ONLY')
    expect(typeForDivisionChange(v, withDivision(v, 'BROKERAGE')).shipmentType).toBe('FTL')
  })

  it('keeps a type the user picked', () => {
    const v = applyShipmentType(emptyValues(), 'LTL')
    expect(typeForDivisionChange(v, withDivision(v, 'CAR_SHIPPING')).shipmentType).toBe('LTL')
  })

  it('a customer default division brings the division default type with it', () => {
    const v = applyCustomerDefaults(emptyValues(), { id: 'c', name: 'Auto Co', defaultDivisionKey: 'CAR_SHIPPING' } as never)
    expect(v).toMatchObject({ shipmentType: 'AUTO_OPEN' })
    expect(v.ship.equipmentType).toBe('Auto carrier')
  })
})

describe('valuesFromBundle shipment type', () => {
  const bundle = (mode: string, form?: object) => ({
    shipment: { id: 's', number: 'S1', status: 'DRAFT', mode }, loads: [], loadCarriers: [], charges: [], financials: [], documents: [],
    orders: [{ id: 'o', specialRequirements: form ? { form: { v: 1, ...form } } : null }],
  }) as never

  it('reads the stored key, else derives the type from the stored mode', () => {
    expect(valuesFromBundle(bundle('FTL', { shipmentType: 'HOT_SHOT' })).shipmentType).toBe('HOT_SHOT')
    expect(valuesFromBundle(bundle('LTL')).shipmentType).toBe('LTL')
    expect(valuesFromBundle(bundle('OCEAN')).shipmentType).toBe('OCEAN_FCL')
    expect(valuesFromBundle(bundle('FTL', { shipmentType: 'bogus' })).shipmentType).toBe('FTL')
  })
})
