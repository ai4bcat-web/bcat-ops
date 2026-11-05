import { describe, expect, it } from 'vitest'
import { defaultColumnWidth } from '@/features/tms/grid/denseGridModel'
import { ALJEX_COLUMN_KEYS } from './shipmentViews'
import { ACTIONS_COLUMN, SHIPMENT_COLUMN_KEYS, SHIPMENT_DEFAULT_COLUMNS, SHIPMENT_GRID_COLUMNS } from './shipmentGridColumns'

/** The scroller at 1440 wide: the default set plus the Actions column must not scroll sideways. */
const SCROLLER_1440_PX = 1129

describe('Shipments default columns', () => {
  it('fit the 1440 scroller with PRO # sticky first, Actions included', () => {
    const byKey = new Map(SHIPMENT_GRID_COLUMNS.map((c) => [c.key, c]))
    const total =
      SHIPMENT_DEFAULT_COLUMNS.reduce((sum, key) => sum + defaultColumnWidth(byKey.get(key)!), 0) +
      defaultColumnWidth(ACTIONS_COLUMN)
    expect(SHIPMENT_DEFAULT_COLUMNS[0]).toBe('proNumber')
    expect(total).toBeLessThanOrEqual(SCROLLER_1440_PX)
  })

  it('are real columns that keep the Aljex board order', () => {
    for (const key of SHIPMENT_DEFAULT_COLUMNS) expect(SHIPMENT_COLUMN_KEYS).toContain(key)
    const aljexOrder = ['proNumber', ...ALJEX_COLUMN_KEYS.filter((k) => k !== 'proNumber')]
    const positions = SHIPMENT_DEFAULT_COLUMNS.map((k) => aljexOrder.indexOf(k))
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })
})
