import { describe, it, expect } from 'vitest'
import { aljexCodeItems, referenceLabel, shipmentFlagLabels } from './aljexDisplay'

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
