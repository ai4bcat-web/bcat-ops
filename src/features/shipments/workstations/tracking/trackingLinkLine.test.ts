import { describe, expect, it } from 'vitest'
import { trackingLinkLine } from './trackingLinkLine'
import type { ShipmentRow } from '../../shipmentViews'

const row = (over: Partial<ShipmentRow> = {}) => ({
  id: 'shp-1', number: '14950', status: 'BOOKED', loadStatus: 'BOOKED', assignmentType: 'CARRIER', carrierName: 'Swift',
  pickupAppt: '2026-11-17T16:00:00.000Z', pickupApptType: 'exact', driverPhone: '+13125551267', ...over,
}) as unknown as ShipmentRow

describe('trackingLinkLine', () => {
  it('says when it auto-sends, only while the switch is on', () => {
    expect(trackingLinkLine(row(), '2026-11-17T12:00:00.000Z', true)).toBe('auto-sends at 9:00 AM')
    expect(trackingLinkLine(row(), '2026-11-17T12:00:00.000Z', false)).toBe('')
  })
  it('reports a link sent by hand', () => {
    expect(trackingLinkLine(row({ trackingStartedAt: '2026-11-17T16:02:00.000Z' }), '2026-11-17T17:00:00.000Z', true)).toBe('sent manually 10:02 AM')
  })
  it('stays blank for own trucks', () => {
    expect(trackingLinkLine(row({ assignmentType: 'OWN_ASSET' }), '2026-11-17T12:00:00.000Z', true)).toBe('')
  })
})
