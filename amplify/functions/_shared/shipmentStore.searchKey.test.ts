import { describe, it, expect } from 'vitest'
import { buildSearchKey } from './shipmentStore'

describe('buildSearchKey', () => {
  it("includes the load's Customer Ref and pickup #, so a shipment whose order has no references is found by them (14934)", () => {
    const key = buildSearchKey(
      { number: '14934', customerName: 'COWTOWN EXPRESS LOGISTICS LLC' },
      [{ references: [] }],
      [{ tmsId: '0359403', pickupNumber: '34485', stops: '[]' }],
    )
    expect(key.split(' ')).toEqual(expect.arrayContaining(['14934', '0359403', '34485']))
  })

  it('skips N/A and does not repeat a value the references already hold', () => {
    const key = buildSearchKey(
      { number: '20041', customerName: 'BEDROCK' },
      [{ references: [{ code: 'PO', value: '132630885' }] }],
      [{ tmsId: '132630885', pickupNumber: 'N/A', stops: '[]' }],
    )
    expect(key.split(' ').filter((t) => t === '132630885')).toHaveLength(1)
    expect(key).not.toContain('n/a')
  })
})
