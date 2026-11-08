import { describe, expect, it } from 'vitest'
import type { QuoteRecord } from '@/types/tms'
import {
  coverageStateOf, coveredRows, needsCover, needsCoverCount, needsCoverRows, offersByShipment,
  type CarrierSalesRow,
} from './carrierSalesQueue'

function row(overrides: Partial<CarrierSalesRow> = {}): CarrierSalesRow {
  return {
    id: 's-1', number: 'S-1', status: 'BOOKED', equipmentType: null, customerRateCents: null,
    assignmentType: null, loadStatus: null, carrierName: null, carrierMc: null, mcpStatus: null,
    rateConStatus: null, rateConSentAt: null, rateConSignedAt: null, dispatchedAt: null,
    ...overrides,
  }
}

describe('coverageStateOf', () => {
  it('returns NEEDS_COVERAGE when there is no assignment', () => {
    expect(coverageStateOf({})).toBe('NEEDS_COVERAGE')
  })

  it('returns COVERED when a carrier is assigned but not signed or dispatched', () => {
    expect(coverageStateOf({ assignmentType: 'CARRIER', carrierId: 'c-1' })).toBe('COVERED')
  })

  it('returns RATE_CON_SIGNED when signed but not dispatched', () => {
    expect(
      coverageStateOf({ assignmentType: 'CARRIER', carrierId: 'c-1', rateConSignedAt: '2026-10-28T12:00:00Z' }),
    ).toBe('RATE_CON_SIGNED')
  })

  it('returns DISPATCHED when dispatched', () => {
    expect(
      coverageStateOf({ assignmentType: 'CARRIER', carrierId: 'c-1', dispatchedAt: '2026-10-28T08:00:00Z' }),
    ).toBe('DISPATCHED')
  })
})

describe('needsCover', () => {
  it('includes open, booked and planned loads with no assignment or a NEED_TO_COVER one', () => {
    for (const status of ['OPEN', 'BOOKED', 'PLANNED'] as const) {
      expect(needsCover(row({ status }))).toBe(true)
    }
    expect(needsCover(row({ assignmentType: 'NEED_TO_COVER' }))).toBe(true)
  })

  it('excludes drafts, tenders, holds, legacy, voided, canceled and building loads', () => {
    for (const status of ['DRAFT', 'TENDER_PENDING', 'TENDER_REJECTED', 'ON_HOLD', 'CANCELED', 'DISPATCHED'] as const) {
      expect(needsCover(row({ status }))).toBe(false)
    }
    expect(needsCover(row({ legacyImported: true }))).toBe(false)
    expect(needsCover(row({ voidedAt: '2026-10-01T00:00:00Z' }))).toBe(false)
    expect(needsCover(row({ buildState: 'BUILDING' }))).toBe(false)
  })

  it('excludes loads that already have a carrier or own asset', () => {
    expect(needsCover(row({ assignmentType: 'CARRIER' }))).toBe(false)
    expect(needsCover(row({ assignmentType: 'OWN_ASSET' }))).toBe(false)
  })

  it('count equals the length of the rows the tab draws', () => {
    const rows = [
      row({ id: 'a', number: 'A', pickupAppt: '2026-11-06T10:00:00Z' }),
      row({ id: 'b', number: 'B', pickupAppt: '2026-11-05T10:00:00Z' }),
      row({ id: 'c', number: 'C', status: 'DRAFT' }),
      row({ id: 'd', number: 'D', assignmentType: 'CARRIER' }),
      row({ id: 'e', number: 'E' }),
    ]
    expect(needsCoverCount(rows)).toBe(needsCoverRows(rows).length)
    expect(needsCoverRows(rows).map((r) => r.id)).toEqual(['b', 'a', 'e'])
  })
})

describe('coveredRows', () => {
  it('lists carrier-covered, not-yet-dispatched loads with unsigned rate cons first', () => {
    const rows = [
      row({ id: 'signed', number: 'A', assignmentType: 'CARRIER', rateConSignedAt: '2026-11-01T00:00:00Z' }),
      row({ id: 'unsigned', number: 'B', assignmentType: 'CARRIER' }),
      row({ id: 'dispatched', number: 'C', assignmentType: 'CARRIER', dispatchedAt: '2026-11-01T00:00:00Z' }),
      row({ id: 'placeholder', number: 'D', assignmentType: 'NEED_TO_COVER' }),
      row({ id: 'picked', number: 'E', assignmentType: 'CARRIER', status: 'PICKED_UP' }),
    ]
    expect(coveredRows(rows).map((r) => r.id)).toEqual(['unsigned', 'signed'])
  })
})

describe('offersByShipment', () => {
  it('counts only BUY offers per shipment', () => {
    const q = (o: Partial<QuoteRecord>) => ({ id: 'q', side: 'BUY', status: 'RECEIVED_REPLY', ...o }) as QuoteRecord
    const map = offersByShipment([
      q({ shipmentId: 's-1' }), q({ shipmentId: 's-1' }), q({ shipmentId: 's-2', side: 'SELL' }), q({ shipmentId: null }),
    ])
    expect(map.get('s-1')).toBe(2)
    expect(map.has('s-2')).toBe(false)
    expect(map.size).toBe(1)
  })
})
