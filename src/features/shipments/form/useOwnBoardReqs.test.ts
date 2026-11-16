// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { ShipmentRow } from '../shipmentViews'

const h = vi.hoisted(() => ({ rows: [] as unknown[], refresh: vi.fn(async () => undefined), lastView: null as unknown }))
vi.mock('@/hooks/useShipments', () => ({
  useShipments: (view: unknown) => { h.lastView = view; return { shipments: h.rows, refresh: h.refresh } },
}))

import { useOwnBoardReqs } from './useOwnBoardReqs'

const SRC = { customers: [], orgDefault: null }
const row = (over: Partial<ShipmentRow>) => ({
  id: 's1', number: '1', status: 'DELIVERED', revDivision: 'BROKERAGE', salesRepId: 'rep-1', reference: 'PO-1',
  revenueCents: 100000, costCents: 80000, docsRequired: ['POD', 'RATE_CON'], docsMissing: [], docsPresent: ['POD', 'RATE_CON'], ...over,
}) as ShipmentRow

describe('useOwnBoardReqs (the editor rail reads its own board row)', () => {
  it('computes REQS from the shipment row, whatever opened the editor', () => {
    h.rows = [row({ salesRepId: null })]
    const { result } = renderHook(() => useOwnBoardReqs('s1', true, SRC, {}))
    expect(h.lastView).toEqual({ kind: 'ids', ids: ['s1'] })
    expect(result.current?.map((r) => r.key)).toEqual(['salesRep'])
  })

  it('re-reads the row after a save hands the editor a new bundle', () => {
    h.rows = [row({})]
    h.refresh.mockClear()
    const { rerender, result } = renderHook(({ b }) => useOwnBoardReqs('s1', true, SRC, b), { initialProps: { b: { v: 1 } as object } })
    expect(result.current).toEqual([])
    rerender({ b: { v: 2 } })
    expect(h.refresh).toHaveBeenCalledTimes(1)
  })

  it('reads nothing for a new (unsaved) shipment', () => {
    h.rows = []
    const { result } = renderHook(() => useOwnBoardReqs(undefined, false, SRC, null))
    expect(h.lastView).toEqual({ kind: 'ids', ids: [] })
    expect(result.current).toBeUndefined()
  })
})
