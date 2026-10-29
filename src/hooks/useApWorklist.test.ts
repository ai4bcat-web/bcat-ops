// @vitest-environment jsdom
/**
 * The AP worklist joins an assignment's AP rung to its shipment, and Step R added the
 * one verdict a cached assignment cannot carry: a voided shipment's leg is out of the
 * tab. `voidedAt` is the R marker and a pre-R `deletedAt` is the same thing, so a row
 * whose shipment carries either never reaches the worklist.
 */
import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { LoadCarrierRecord, ShipmentRecord } from '@/types/tms'
import { useApWorklist } from './useApWorklist'

const { data } = vi.hoisted(() => ({
  data: { assignments: [] as LoadCarrierRecord[], shipments: [] as ShipmentRecord[] },
}))

vi.mock('@/lib/apiClient', () => ({
  listOpenApAssignments: async () => data.assignments,
  listShipments: async () => data.shipments,
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

const assignment = (id: string, shipmentId: string, patch: Partial<LoadCarrierRecord> = {}): LoadCarrierRecord => ({
  id,
  loadId: `ld-${id}`,
  shipmentId,
  kind: 'CARRIER',
  status: 'ACTIVE',
  apStatus: 'IN_REVIEW',
  costCents: 180_000,
  rateConStatus: 'SIGNED',
  createdBy: 'ops@bcat.test',
  updatedBy: 'ops@bcat.test',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-05T12:00:00.000Z',
  ...patch,
})

async function rowsFor() {
  const { result } = renderHook(() => useApWorklist('IN_REVIEW'))
  await waitFor(() => expect(result.current.loading).toBe(false))
  return result.current.rows
}

describe('useApWorklist', () => {
  it('drops the leg of a shipment that was voided', async () => {
    data.assignments = [assignment('lc-void', 's-void')]
    data.shipments = [shipment('s-void', { voidedAt: '2026-10-06T00:00:00.000Z' })]
    expect(await rowsFor()).toEqual([])
  })

  it('drops the leg of a pre-R soft delete, which is a void too', async () => {
    data.assignments = [assignment('lc-del', 's-del')]
    data.shipments = [shipment('s-del', { deletedAt: '2026-10-06T00:00:00.000Z' })]
    expect(await rowsFor()).toEqual([])
  })

  it('keeps a live leg awaiting review', async () => {
    data.assignments = [assignment('lc-live', 's-live')]
    data.shipments = [shipment('s-live')]
    const rows = await rowsFor()
    expect(rows.map((r) => r.loadCarrierId)).toEqual(['lc-live'])
    expect(rows[0].reasons).toEqual([])
  })
})
