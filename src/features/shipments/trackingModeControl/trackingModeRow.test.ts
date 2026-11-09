import { describe, expect, it } from 'vitest'
import { TRACKING_SET_PATH, isCoveredAndLive } from './trackingModeRow'

describe('tracking mode chip rows', () => {
  it('only a covered, live load qualifies', () => {
    expect(isCoveredAndLive({ assignmentType: 'CARRIER', status: 'BOOKED' })).toBe(true)
    expect(isCoveredAndLive({ assignmentType: 'OWN_ASSET', status: 'IN_TRANSIT' })).toBe(true)
    expect(isCoveredAndLive({ assignmentType: 'NEED_TO_COVER', status: 'OPEN' })).toBe(false)
    expect(isCoveredAndLive({ assignmentType: 'CARRIER', status: 'DELIVERED' })).toBe(false)
    expect(isCoveredAndLive({ assignmentType: 'CARRIER', status: 'BOOKED', voidedAt: '2026-11-01T00:00:00Z' })).toBe(false)
    expect(isCoveredAndLive({ assignmentType: null, status: 'BOOKED' })).toBe(false)
  })
  it('links to the shipment edit form focused on tracking', () => {
    expect(TRACKING_SET_PATH('shp-1')).toBe('/tms/shipments/shp-1/edit?focus=tracking')
  })
})

import { isCoveredAndLive as coveredLive } from './trackingModeRow'
describe('Ivan Cartage loads need no tracking link', () => {
  it('are never "covered and live" for the chip, brokerage and car shipping are', () => {
    expect(coveredLive({ assignmentType: 'CARRIER', status: 'BOOKED', revDivision: 'ASSETS' })).toBe(false)
    expect(coveredLive({ assignmentType: 'CARRIER', status: 'BOOKED', revDivision: 'BROKERAGE' })).toBe(true)
    expect(coveredLive({ assignmentType: 'CARRIER', status: 'BOOKED', revDivision: 'CAR_SHIPPING' })).toBe(true)
  })
})
