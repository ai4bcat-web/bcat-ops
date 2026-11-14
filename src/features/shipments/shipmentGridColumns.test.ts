import { describe, expect, it } from 'vitest'
import { defaultColumnWidth } from '@/features/tms/grid/denseGridModel'
import { ALJEX_COLUMN_KEYS } from './shipmentViews'
import { matchesColumnFilter } from '@/features/tms/grid/denseGridModel'
import { statusSortKey, ACTIONS_COLUMN, SHIPMENT_COLUMN_KEYS, SHIPMENT_DEFAULT_COLUMNS, SHIPMENT_GRID_COLUMNS } from './shipmentGridColumns'

/** The scroller at 1440 wide: the default set plus the Actions column must not scroll sideways. */
const SCROLLER_1440_PX = 1129

describe('Shipments default columns', () => {
  it('fit the 1440 scroller with PRO # sticky first, Actions included', () => {
    const byKey = new Map(SHIPMENT_GRID_COLUMNS.map((c) => [c.key, c]))
    const total =
      SHIPMENT_DEFAULT_COLUMNS.reduce((sum, key) => sum + defaultColumnWidth(byKey.get(key)!), 0) +
      defaultColumnWidth(ACTIONS_COLUMN)
    // Status, Invoice Status (2026-11-14), RC, POD, PRO # and Customer Ref # are the fixed columns, in that order (Ryne 2026-11-11).
    expect(SHIPMENT_DEFAULT_COLUMNS.slice(0, 6)).toEqual(['status', 'invoiceStatus', 'rateConPresent', 'podPresent', 'proNumber', 'customerReference'])
    expect(total).toBeLessThanOrEqual(SCROLLER_1440_PX)
  })

  it('are real columns that keep the Aljex board order', () => {
    for (const key of SHIPMENT_DEFAULT_COLUMNS) expect(SHIPMENT_COLUMN_KEYS).toContain(key)
    // The six fixed columns lead; everything after them keeps the Aljex order.
    const aljexOrder = ['proNumber', ...ALJEX_COLUMN_KEYS.filter((k) => k !== 'proNumber')]
    const positions = SHIPMENT_DEFAULT_COLUMNS.slice(6).map((k) => aljexOrder.indexOf(k))
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })
})

describe('Carrier column with several carriers', () => {
  it('filters on the second carrier and sorts by names', () => {
    const col = SHIPMENT_GRID_COLUMNS.find((c) => c.key === 'carrier')!
    const base = { id: '1', number: 'S1', status: 'OPEN', assignmentType: 'CARRIER', carrierName: 'Beta' } as never
    const multi = { ...(base as object), carriers: [{ name: 'Beta', apStatus: null, costCents: null }, { name: 'Alpha', apStatus: null, costCents: null }] } as never
    expect(col.text(multi)).toBe('2 carriers')
    expect(col.optionsOf!(multi).map((o) => o.value)).toEqual(['Beta', 'Alpha'])
    expect(matchesColumnFilter(multi, col, { values: ['Alpha'] })).toBe(true)
    expect(matchesColumnFilter(base, col, { values: ['Alpha'] })).toBe(false)
    expect(col.optionsOf!(base).map((o) => o.value)).toEqual(['Beta'])
    expect(col.sortValue!(multi)).toBe('Alpha, Beta')
  })
})

describe('Status sort', () => {
  const r = (over: Record<string, unknown>) => ({ status: 'BOOKED', assignmentType: null, pickupAppt: null, ...over }) as never
  it('puts OPEN loads first, soonest pickup first, then the rest by status', () => {
    const rows = [
      r({ id: 'covered', assignmentType: 'CARRIER' }),
      r({ id: 'open-later', pickupAppt: '2026-11-12T10:00:00.000Z' }),
      r({ id: 'open-today', pickupAppt: '2026-11-09T18:00:00.000Z' }),
    ] as Array<{ id: string }>
    const sorted = [...rows].sort((a, b) => statusSortKey(a as never).localeCompare(statusSortKey(b as never)))
    expect(sorted.map((x) => x.id)).toEqual(['open-today', 'open-later', 'covered'])
  })
})
