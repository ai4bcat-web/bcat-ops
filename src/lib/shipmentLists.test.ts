import { describe, expect, it } from 'vitest'
import {
  inShipmentList,
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
