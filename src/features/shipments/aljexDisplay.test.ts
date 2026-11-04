import { describe, it, expect } from 'vitest'
import { aljexCodeItems, referenceLabel, shipmentFlagLabels, shippingRequirementRows } from './aljexDisplay'

describe('aljexDisplay', () => {
  it('labels Aljex reference codes, preferring a stored label and falling back to the raw code', () => {
    expect(referenceLabel({ code: 'QUOTE_NUMBER' })).toBe('Quote #')
    expect(referenceLabel({ code: 'ADDITIONAL_REF_3' })).toBe('Additional ref 3')
    expect(referenceLabel({ code: 'QUOTE_NUMBER', label: 'Their quote' })).toBe('Their quote')
    expect(referenceLabel({ code: 'PO' })).toBe('PO')
  })

  it('lists only the flags that are set; an explicit zero pallet count still shows', () => {
    expect(shipmentFlagLabels(false, { team: false, hazmat: null })).toEqual([])
    expect(shipmentFlagLabels(true, { hazmat: true, customsBond: 'CB1', palletsIn: 0, palletsOut: 4 }))
      .toEqual(['OSD', 'Hazmat', 'Customs bond CB1', 'Pallets in 0', 'Pallets out 4'])
  })

  it('shows only the Aljex codes that exist', () => {
    expect(aljexCodeItems({ salesRepCode: 'JD', createdByCode: null, serviceRepCode: '', dispatcherCode: '010' }))
      .toEqual([{ label: 'Aljex sales rep', value: 'JD' }, { label: 'Aljex dispatcher', value: '010' }])
  })
})

describe('Step AH display', () => {
  it('badges the typed Aljex flags the form writes', () => {
    expect(shipmentFlagLabels(null, { fsma: true, noBroker: true, highRisk: true, inside: false, labor: null })).toEqual(['FSMA', 'No broker', 'High risk'])
  })

  it('lists only the form extras that are set, in Aljex words, with the temperature unit it was typed in', () => {
    expect(shippingRequirementRows(undefined)).toEqual([])
    expect(shippingRequirementRows({ v: 1 })).toEqual([])
    expect(shippingRequirementRows({
      v: 1,
      ship: { truckMiles: 0, freightClass: '70', temp: { unit: 'C', min: 2, max: 4 } },
      customer: { hours: '8-4', emails: ['a@example.invalid', 'b@example.invalid'] },
    })).toEqual([
      { label: 'Truck miles', value: '0' },
      { label: 'Freight class', value: '70' },
      { label: 'Temperature', value: '2°C – 4°C' },
      { label: 'Customer hours', value: '8-4' },
      { label: 'Customer e-mails', value: '2' },
    ])
  })
})
