import { describe, expect, it } from 'vitest'
import {
  inShipmentList,
  inShipmentYear,
  monthsOfYear,
  shipmentYearOf,
  shipmentYears,
  isReleasedToInvoicing,
  parseShipmentList,
  shipmentListCounts,
  type ListRow,
} from './shipmentLists'
import type { ArStatus, ShipmentStatus } from '../types/tms'

const row = (patch: Partial<ListRow> = {}): ListRow => ({ status: 'BOOKED', ...patch })

describe('isReleasedToInvoicing', () => {
  it('is not released with no order data or DOCS_NEEDED', () => {
    expect(isReleasedToInvoicing(row())).toBe(false)
    expect(isReleasedToInvoicing(row({ arStatus: null }))).toBe(false)
    expect(isReleasedToInvoicing(row({ arStatus: 'DOCS_NEEDED' }))).toBe(false)
  })

  it.each(['UNBILLED', 'UNPAID', 'PAID', 'INVOICE_NOT_NEEDED', 'LEGACY'] as ArStatus[])(
    'is released at arStatus %s',
    (arStatus) => {
      expect(isReleasedToInvoicing(row({ arStatus }))).toBe(true)
    },
  )

  it('is released by the release stamp or an invoice id alone', () => {
    expect(isReleasedToInvoicing(row({ readyToInvoiceAt: '2026-10-01T00:00:00Z', arStatus: 'DOCS_NEEDED' }))).toBe(true)
    expect(isReleasedToInvoicing(row({ invoiceId: 'inv-1' }))).toBe(true)
  })
})

describe('inShipmentList', () => {
  it('keeps an unreleased DELIVERED shipment active (the collection backlog)', () => {
    expect(inShipmentList(row({ status: 'DELIVERED', arStatus: 'DOCS_NEEDED' }), 'active')).toBe(true)
  })

  it('moves a released shipment to All only', () => {
    const released = row({ status: 'DELIVERED', arStatus: 'UNBILLED' })
    expect(inShipmentList(released, 'active')).toBe(false)
    expect(inShipmentList(released, 'all')).toBe(true)
  })

  it('puts CANCELED in All and not Active', () => {
    const canceled = row({ status: 'CANCELED' })
    expect(inShipmentList(canceled, 'active')).toBe(false)
    expect(inShipmentList(canceled, 'all')).toBe(true)
  })

  it('Active is a subset of All for every generated row', () => {
    const statuses: ShipmentStatus[] = ['DRAFT', 'TENDER_PENDING', 'BOOKED', 'IN_TRANSIT', 'DELIVERED', 'CANCELED', 'ON_HOLD']
    const ars: Array<ArStatus | null> = [null, 'DOCS_NEEDED', 'UNBILLED', 'PAID', 'LEGACY']
    for (const status of statuses) {
      for (const arStatus of ars) {
        for (const invoiceId of [null, 'inv']) {
          const r = row({ status, arStatus, invoiceId })
          if (inShipmentList(r, 'active')) expect(inShipmentList(r, 'all')).toBe(true)
        }
      }
    }
  })
})

describe('shipmentListCounts', () => {
  it('excludes voided rows and matches the filter lengths', () => {
    const rows: ListRow[] = [
      row(),
      row({ status: 'DELIVERED', arStatus: 'DOCS_NEEDED' }),
      row({ status: 'DELIVERED', arStatus: 'PAID' }),
      row({ status: 'CANCELED' }),
      row({ voidedAt: '2026-10-01T00:00:00Z' }),
    ]
    const counts = shipmentListCounts(rows)
    const live = rows.filter((r) => !r.voidedAt)
    expect(counts.all).toBe(live.length)
    expect(counts.active).toBe(live.filter((r) => inShipmentList(r, 'active')).length)
    expect(counts).toEqual({ active: 2, all: 4 })
  })
})

describe('parseShipmentList', () => {
  it('falls back to active for anything but "all"', () => {
    expect(parseShipmentList('all')).toBe('all')
    expect(parseShipmentList('active')).toBe('active')
    expect(parseShipmentList('bogus')).toBe('active')
    expect(parseShipmentList(null)).toBe('active')
  })
})

describe('year facet', () => {
  it('dates a row by pickup month, then pickup appointment, then creation', () => {
    expect(shipmentYearOf(row({ pickupMonth: '2024-12', pickupAppt: '2025-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' }))).toBe(2024)
    expect(shipmentYearOf(row({ pickupAppt: '2025-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' }))).toBe(2025)
    expect(shipmentYearOf(row({ createdAt: '2026-01-01T00:00:00Z' }))).toBe(2026)
    expect(shipmentYearOf(row())).toBeNull()
  })

  it('narrows All to one year, never hides an undated row, and leaves Active alone', () => {
    const y24 = row({ pickupMonth: '2024-05' })
    const y26 = row({ pickupMonth: '2026-05' })
    expect(inShipmentList(y24, 'all', 2026)).toBe(false)
    expect(inShipmentList(y26, 'all', 2026)).toBe(true)
    expect(inShipmentList(y24, 'all', 'all')).toBe(true)
    expect(inShipmentYear(row(), 2026)).toBe(true)
    expect(inShipmentList(y24, 'active', 2026)).toBe(true)
  })

  it('lists years newest first and a year as twelve months', () => {
    expect(shipmentYears([row({ pickupMonth: '2024-01' }), row({ pickupMonth: '2026-01' }), row({ pickupMonth: '2024-07' }), row()])).toEqual([2026, 2024])
    expect(monthsOfYear(2026)).toHaveLength(12)
    expect(monthsOfYear(2026)[0]).toBe('2026-01')
    expect(monthsOfYear(2026)[11]).toBe('2026-12')
  })

  it('counts All inside the year while Active counts are year-free', () => {
    const rows = [
      row({ pickupMonth: '2026-01' }),
      row({ status: 'DELIVERED', arStatus: 'PAID', pickupMonth: '2026-02' }),
      row({ status: 'DELIVERED', arStatus: 'PAID', pickupMonth: '2024-02' }),
      row({ pickupMonth: '2024-03' }),
    ]
    expect(shipmentListCounts(rows, 2026)).toEqual({ active: 2, all: 2 })
    expect(shipmentListCounts(rows, 'all')).toEqual({ active: 2, all: 4 })
    expect(shipmentListCounts(rows)).toEqual({ active: 2, all: 4 })
  })
})
