import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ShipmentRecord } from '@/types/tms'

const calls = vi.hoisted(() => [] as Array<{ ids: string[]; narrow: boolean }>)
const table = vi.hoisted(() => ({ rows: [] as ShipmentRecord[] }))

// The by-id reader as the backend answers it: a narrow read carries only the identity and void
// markers, a full read the whole row; ids that do not exist are absent.
vi.mock('@/lib/boardData', () => ({
  getShipmentsByIds: async (ids: readonly string[], narrow = false) => {
    calls.push({ ids: [...ids], narrow })
    const out = new Map<string, ShipmentRecord>()
    for (const id of ids) {
      const row = table.rows.find((r) => r.id === id)
      if (!row) continue
      out.set(id, narrow
        ? ({ id: row.id, number: row.number, status: row.status, voidedAt: row.voidedAt, deletedAt: row.deletedAt } as ShipmentRecord)
        : row)
    }
    return out
  },
}))

// The by-id reader is the unit under test; the real client would build an Amplify client on import.
vi.mock('@/lib/apiClient', () => ({
  listDocsNeededOrdersNarrow: vi.fn(),
  listOrdersByShipmentIds: vi.fn(),
}))

import { loadWorklistShipments } from './worklistShipments'

const shipment = (id: string, patch: Partial<ShipmentRecord> = {}): ShipmentRecord => ({
  id, number: id, status: 'DELIVERED', customerId: 'c', customerName: 'C', mode: 'FTL', source: 'MANUAL',
  podFlaggedAt: `flag-${id}`, createdBy: 't', updatedBy: 't', createdAt: 'x', updatedAt: 'x', ...patch,
})

beforeEach(() => {
  calls.length = 0
  table.rows = [
    shipment('live-1'),
    shipment('live-2'),
    shipment('voided', { voidedAt: '2026-10-01T00:00:00Z' }),
    shipment('legacy-deleted', { deletedAt: '2026-09-01T00:00:00Z' }),
  ]
})

describe('loadWorklistShipments', () => {
  it('returns the same shipments, field for field, as reading the whole table would for those ids', async () => {
    const ids = ['live-1', 'voided', 'live-2', 'legacy-deleted', 'live-1', 'ghost']
    const got = await loadWorklistShipments(ids)
    const wanted = new Set(ids)
    const full = table.rows.filter((r) => wanted.has(r.id))
    const byId = (rows: ShipmentRecord[]) => new Map(rows.map((r) => [r.id, r]))
    // Live rows are complete (a worklist reads podFlaggedAt and more off them).
    for (const id of ['live-1', 'live-2']) expect(byId(got).get(id)).toEqual(byId(full).get(id))
    // Voided/deleted rows stay present so the worklist can drop their orders; only the markers are needed.
    expect(byId(got).get('voided')?.voidedAt).toBe('2026-10-01T00:00:00Z')
    expect(byId(got).get('legacy-deleted')?.deletedAt).toBe('2026-09-01T00:00:00Z')
    expect([...byId(got).keys()].sort()).toEqual(['legacy-deleted', 'live-1', 'live-2', 'voided'])
  })

  it('asks for full rows of the live shipments only, once per id', async () => {
    await loadWorklistShipments(['live-1', 'voided', 'live-1', 'live-2'])
    expect(calls).toEqual([
      { ids: ['live-1', 'voided', 'live-2'], narrow: true },
      { ids: ['live-1', 'live-2'], narrow: false },
    ])
  })

  it('reads nothing for an empty worklist', async () => {
    expect(await loadWorklistShipments([])).toEqual([])
    expect(calls).toEqual([])
  })
})
