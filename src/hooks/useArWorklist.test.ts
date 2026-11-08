// @vitest-environment jsdom
/**
 * The AR worklist joins an order's AR rung to its shipment, and Step R added the one
 * verdict a cached order cannot carry: a voided shipment's order is out of the tab.
 * `voidedAt` is the R marker and a pre-R `deletedAt` is the same thing, so a row whose
 * shipment carries either never reaches the worklist.
 */
import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { OrderRecord, ShipmentRecord } from '@/types/tms'
import { useArWorklist } from './useArWorklist'

const { data } = vi.hoisted(() => ({
  data: { orders: [] as OrderRecord[], shipments: [] as ShipmentRecord[], fullOrderReads: [] as string[][] },
}))

vi.mock('@/lib/apiClient', () => ({
  listOrdersByArStatus: async () => data.orders,
  listDocsNeededOrdersNarrow: async () => data.orders.filter((o) => o.arStatus === 'DOCS_NEEDED'),
  listOrdersByShipmentIds: async (ids: readonly string[]) => {
    data.fullOrderReads.push([...ids])
    return data.orders.filter((o) => ids.includes(o.shipmentId as string))
  },
}))

// The by-id reader: only the asked-for shipments come back, as a Map.
vi.mock('@/lib/boardData', () => ({
  getShipmentsByIds: async (ids: readonly string[]) =>
    new Map(data.shipments.filter((s) => ids.includes(s.id)).map((s) => [s.id, s])),
}))

const shipment = (id: string, patch: Partial<ShipmentRecord> = {}): ShipmentRecord => ({
  id,
  number: id,
  status: 'DELIVERED',
  customerId: 'cust-1',
  customerName: 'Batory Foods',
  mode: 'FTL',
  source: 'MANUAL',
  deliveredAt: '2026-10-05T12:00:00.000Z',
  createdBy: 'ops@bcat.test',
  updatedBy: 'ops@bcat.test',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-05T12:00:00.000Z',
  ...patch,
})

const order = (id: string, shipmentId: string, patch: Partial<OrderRecord> = {}): OrderRecord => ({
  id,
  shipmentId,
  customerId: 'cust-1',
  customerName: 'Batory Foods',
  mode: 'FTL',
  revenueCents: 250_000,
  arStatus: 'UNBILLED',
  createdBy: 'ops@bcat.test',
  updatedBy: 'ops@bcat.test',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-05T12:00:00.000Z',
  ...patch,
})

async function rowsFor() {
  const { result } = renderHook(() => useArWorklist('UNBILLED'))
  await waitFor(() => expect(result.current.loading).toBe(false))
  return result.current.rows
}

describe('useArWorklist', () => {
  it('drops the order of a shipment that was voided', async () => {
    data.orders = [order('o-void', 's-void')]
    data.shipments = [shipment('s-void', { voidedAt: '2026-10-06T00:00:00.000Z' })]
    expect(await rowsFor()).toEqual([])
  })

  it('drops the order of a pre-R soft delete, which is a void too', async () => {
    data.orders = [order('o-del', 's-del')]
    data.shipments = [shipment('s-del', { deletedAt: '2026-10-06T00:00:00.000Z' })]
    expect(await rowsFor()).toEqual([])
  })

  it('keeps a live delivered order', async () => {
    data.orders = [order('o-live', 's-live')]
    data.shipments = [shipment('s-live')]
    const rows = await rowsFor()
    expect(rows.map((r) => r.orderId)).toEqual(['o-live'])
    expect(rows[0].reasons).toEqual([])
  })

  it('DOCS_NEEDED reads full orders only for live shipments, and still drops the voided ones', async () => {
    data.fullOrderReads = []
    data.orders = [
      order('o-live', 's-live', { arStatus: 'DOCS_NEEDED' }),
      order('o-void', 's-void', { arStatus: 'DOCS_NEEDED' }),
      order('o-other', 's-live', { arStatus: 'UNBILLED' }),
    ]
    data.shipments = [shipment('s-live'), shipment('s-void', { voidedAt: '2026-10-06T00:00:00.000Z' })]
    const { result } = renderHook(() => useArWorklist('DOCS_NEEDED'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.rows.map((r) => r.orderId)).toEqual(['o-live'])
    expect(data.fullOrderReads).toEqual([['s-live']])
  })
})
