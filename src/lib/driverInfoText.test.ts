import { describe, it, expect } from 'vitest'
import { driverInfoText } from './driverInfoText'

describe('driverInfoText', () => {
  it('lists every fact on its own line and leaves out what is not known', () => {
    expect(driverInfoText({ name: 'Lee Lara', phone: '(928) 246-9194', truck: '009', vin: '1FUJGLDR9CSBA3413', trailer: '5302', trackingUrl: 'https://m.gomotive.com/s/abc' }))
      .toBe('Driver: Lee Lara\nCell: (928) 246-9194\nTruck: 009\nVIN: 1FUJGLDR9CSBA3413\nTrailer: 5302\nTracking: https://m.gomotive.com/s/abc')
    expect(driverInfoText({ name: 'Zak Pace', truck: '3890' })).toBe('Driver: Zak Pace\nTruck: 3890')
  })
})

describe('driverInfoText company phone', () => {
  it('shows the company phone the driver carries instead of the personal cell', () => {
    expect(driverInfoText({ name: 'Jason', phone: '(779) 537-9141', companyPhone: '(312) 608-8970', truck: '89510' }))
      .toBe('Driver: Jason\nCompany phone: (312) 608-8970\nTruck: 89510')
    expect(driverInfoText({ name: 'Jason', phone: '(779) 537-9141' })).toBe('Driver: Jason\nCell: (779) 537-9141')
  })
})
