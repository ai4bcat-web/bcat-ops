import { describe, expect, it } from 'vitest'
import { loadStatusText } from './loadStatusText'

describe('loadStatusText', () => {
  it('words the load status like the Active Shipments board', () => {
    expect(loadStatusText({ status: 'BOOKED', assignmentType: 'CARRIER' })).toBe('COVERED')
    expect(loadStatusText({ status: 'BOOKED', assignmentType: null })).toBe('OPEN')
    expect(loadStatusText({ status: 'LOADING' })).toBe('DISPATCHED')
    expect(loadStatusText({ status: 'IN_TRANSIT' })).toBe('DEPARTED')
    expect(loadStatusText({ status: 'OUT_FOR_DELIVERY' })).toBe('ARRIVED')
    expect(loadStatusText({ status: 'DELIVERED' })).toBe('DELIVERED')
    expect(loadStatusText({ status: 'CANCELED' })).toBe('CANCELED')
  })
  it('maps the load-only rungs and shows nothing for a legacy load', () => {
    expect(loadStatusText({ status: 'SOURCING' })).toBe('OPEN')
    expect(loadStatusText({ status: 'INVOICING' })).toBe('DELIVERED')
    expect(loadStatusText({ status: null })).toBe('')
    expect(loadStatusText({})).toBe('')
  })
})
