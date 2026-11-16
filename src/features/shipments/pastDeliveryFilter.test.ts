import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { facetOptions, filterRows } from '@/features/tms/grid/denseGridModel'
import { matchesFlag } from './boardChips'
import { PAST_DELIVERY_FILTER_VALUE, SHIPMENT_GRID_COLUMNS } from './shipmentGridColumns'
import type { ShipmentRow } from './shipmentViews'

// Noon Chicago on Nov 12, 2026.
const NOW = Date.parse('2026-11-12T18:00:00Z')
const row = (id: string, over: Partial<ShipmentRow>): ShipmentRow => ({ id, status: 'IN_TRANSIT', ...over }) as ShipmentRow
const statusCol = SHIPMENT_GRID_COLUMNS.find((c) => c.key === 'status')!

const rows = [
  row('late-open', { status: 'OPEN', deliveryAppt: '2026-11-05T14:00:00Z' }),
  row('late-moving', { deliveryAppt: '2026-11-10T14:00:00Z' }),
  row('on-time', { deliveryAppt: '2026-11-20T14:00:00Z' }),
  row('delivered', { status: 'DELIVERED', deliveryAppt: '2026-11-01T14:00:00Z' }),
]

describe('Status filter: Past delivery date', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => vi.useRealTimers())

  it('is offered with a count equal to the stats strip / chip predicate', () => {
    const facet = facetOptions(rows, statusCol).find((f) => f.value === PAST_DELIVERY_FILTER_VALUE)
    const flagged = rows.filter((r) => matchesFlag(r, 'pastDeliveryDate', NOW)).length
    expect(facet?.label).toBe('Past delivery date')
    expect(facet?.count).toBe(flagged)
    expect(flagged).toBe(2)
  })

  it('shows only late loads when ticked alone', () => {
    const out = filterRows(rows, [statusCol], { status: { values: [PAST_DELIVERY_FILTER_VALUE] } })
    expect(out.map((r) => r.id)).toEqual(['late-open', 'late-moving'])
  })

  it('combines with statuses as OR, and Exclude drops late loads', () => {
    const delivered = statusCol.optionsOf!(rows[3])[0].value
    const either = filterRows(rows, [statusCol], { status: { values: [PAST_DELIVERY_FILTER_VALUE, delivered] } })
    expect(either.map((r) => r.id)).toEqual(['late-open', 'late-moving', 'delivered'])
    const excluded = filterRows(rows, [statusCol], { status: { values: [PAST_DELIVERY_FILTER_VALUE], exclude: true } })
    expect(excluded.map((r) => r.id)).toEqual(['on-time', 'delivered'])
  })
})

describe('Past due (days) column', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => vi.useRealTimers())

  it('reads days past the delivery day, blank when not late, and sorts oldest first by value', async () => {
    const { pastDueDaysOf } = await import('./boardChips')
    const { pastDueDaysText } = await import('./shipmentViews')
    const col = SHIPMENT_GRID_COLUMNS.find((c) => c.key === 'pastDueDays')!
    expect(col).toBeTruthy()
    expect(pastDueDaysOf(rows[0], NOW)).toBe(7)
    expect(pastDueDaysOf(rows[2], NOW)).toBeNull()
    expect(pastDueDaysText(rows[0])).toBe('7')
    expect(pastDueDaysText(rows[3])).toBe('')
    const order = [...rows].sort((a, b) => Number(col.sortValue!(b)) - Number(col.sortValue!(a))).map((r) => r.id)
    expect(order.slice(0, 2)).toEqual(['late-open', 'late-moving'])
  })

  it('pastDeliveryOnly is true only for an included Past delivery date status filter', async () => {
    const { pastDeliveryOnly } = await import('./shipmentGridColumns')
    expect(pastDeliveryOnly({ values: [PAST_DELIVERY_FILTER_VALUE] })).toBe(true)
    expect(pastDeliveryOnly({ values: [PAST_DELIVERY_FILTER_VALUE], exclude: true })).toBe(false)
    expect(pastDeliveryOnly({ values: ['DELIVERED'] })).toBe(false)
    expect(pastDeliveryOnly(undefined)).toBe(false)
  })
})
