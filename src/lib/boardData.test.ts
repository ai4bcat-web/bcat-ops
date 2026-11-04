import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { OrderRecord, ShipmentRecord } from '@/types/tms'
import { invalidateLists } from './listCache'

interface Db { shipments: ShipmentRecord[]; orders: OrderRecord[]; loads: { id: string; shipmentId: string }[]; carriers: { id: string; shipmentId: string }[] }
let db: Db
const calls = {
  batch: [] as { ids: string[]; narrow: boolean }[],
  month: [] as { month: string; includeVoided?: boolean }[],
  fullScan: 0,
}
let gateNarrow: Promise<void> | null = null

vi.mock('@/lib/apiClient', () => {
  const scan = () => { calls.fullScan++; throw new Error('full-table read') }
  return {
    listShipments: scan, listOrders: scan, listLoadSummaries: scan, listLoadCarriers: scan, listLoadFinancials: scan,
    listShipmentsByCustomer: scan, listShipmentsByMonth: scan, listShipmentsByStatus: scan,
    listShipmentsByStatusFiltered: async (status: string, o?: { includeVoided?: boolean }) =>
      db.shipments.filter((s) => s.status === status && s.id !== 'undated-draft' && (o?.includeVoided || !s.voidedAt)), // the status index sorts on pickupAppt: an undated row is not in it
    listShipmentsByMonthFiltered: async (month: string, o?: { includeVoided?: boolean }) => {
      calls.month.push({ month, includeVoided: o?.includeVoided })
      return db.shipments.filter((s) => s.pickupMonth === month && (o?.includeVoided || !s.voidedAt))
    },
    listDocsNeededOrdersNarrow: async () => db.orders
      .filter((o) => o.arStatus === 'DOCS_NEEDED')
      .map((o) => ({ id: o.id, shipmentId: o.shipmentId, arStatus: o.arStatus, readyToInvoiceAt: o.readyToInvoiceAt, invoiceId: o.invoiceId })),
    getShipmentsBatch: async (ids: string[], narrow: boolean) => {
      calls.batch.push({ ids: [...ids], narrow })
      if (narrow && gateNarrow) await gateNarrow
      const out = new Map<string, ShipmentRecord>()
      for (const s of db.shipments) {
        if (!ids.includes(s.id)) continue
        out.set(s.id, narrow ? ({ id: s.id, status: s.status, voidedAt: s.voidedAt, deletedAt: s.deletedAt } as ShipmentRecord) : s)
      }
      return out
    },
    listOrdersByShipmentIds: async (ids: string[]) => db.orders.filter((o) => ids.includes(o.shipmentId as string)),
    listLoadSummariesByShipmentIds: async (ids: string[]) => db.loads.filter((l) => ids.includes(l.shipmentId)),
    listLoadCarriersByShipmentIds: async (ids: string[]) => db.carriers.filter((l) => ids.includes(l.shipmentId)),
    listLoadFinancialsByLoadIds: async (ids: string[]) => ids.map((id) => ({ id })),
  }
})

const { loadBoardBundle, getShipmentsByIds, boardViewKey } = await import('./boardData')

const ship = (id: string, status: string, extra: Partial<ShipmentRecord> = {}) =>
  ({ id, status, pickupMonth: '2026-11', updatedAt: '2026-11-01', ...extra }) as unknown as ShipmentRecord
const order = (shipmentId: string, extra: Partial<OrderRecord> = {}) =>
  ({ id: `o-${shipmentId}`, shipmentId, arStatus: 'DOCS_NEEDED', ...extra }) as unknown as OrderRecord

function fixture(): Db {
  const shipments = [
    ship('open', 'IN_TRANSIT'),
    ship('draft', 'DRAFT', { pickupMonth: undefined }),
    ship('open-void', 'OPEN', { voidedAt: '2026-11-02' }),
    ship('open-released', 'IN_TRANSIT'), // non-terminal stays in the set whatever its order says
    ship('dlv-unreleased', 'DELIVERED', { pickupMonth: '2025-01' }),
    ship('dlv-released', 'DELIVERED'),
    ship('dlv-readyAt', 'DELIVERED'),
    ship('dlv-void', 'DELIVERED', { voidedAt: '2026-01-01' }),
    ship('dlv-deleted', 'DELIVERED', { deletedAt: '2026-01-01' }),
    ship('dlv-override', 'DELIVERED'), // arStatus UNBILLED = released
    ship('canceled', 'CANCELED'),
    ship('undated-draft', 'DRAFT', { pickupMonth: undefined }), // absent from the status index; only its DOCS_NEEDED order finds it
    ship('dlv-no-ar', 'DELIVERED'), // documented gap: an order with no arStatus at all
  ]
  const orders = [
    order('open'), order('draft'), order('open-void'), order('open-released', { arStatus: 'UNBILLED' } as Partial<OrderRecord>),
    order('dlv-unreleased'),
    order('dlv-released', { arStatus: 'UNPAID' } as Partial<OrderRecord>),
    order('dlv-readyAt', { readyToInvoiceAt: '2026-11-03' } as Partial<OrderRecord>),
    order('dlv-void'), order('dlv-deleted'),
    order('dlv-override', { arStatus: 'UNBILLED' } as Partial<OrderRecord>),
    order('canceled'), order('undated-draft'),
    order('dlv-no-ar', { arStatus: undefined }),
  ]
  const loads = shipments.map((s) => ({ id: `l-${s.id}`, shipmentId: s.id }))
  const carriers = shipments.map((s) => ({ id: `c-${s.id}`, shipmentId: s.id }))
  return { shipments, orders, loads, carriers }
}

/** The product's own definition of Active, applied to the full table (the reference model). */
function activeIds(d: Db): string[] {
  return d.shipments.filter((s) => {
    if (s.voidedAt || s.deletedAt || s.status === 'CANCELED') return false
    const o = d.orders.find((x) => x.shipmentId === s.id)
    const released = !!(o?.readyToInvoiceAt || o?.invoiceId || (o?.arStatus && o.arStatus !== 'DOCS_NEEDED'))
    return !released
  }).map((s) => s.id)
}

beforeEach(() => {
  invalidateLists()
  db = fixture()
  calls.batch = []; calls.month = []; calls.fullScan = 0
  gateNarrow = null
})

describe('loadBoardBundle working', () => {
  it('contains every Active row and joins each shipment\'s own orders, loads and carriers', async () => {
    const b = await loadBoardBundle({ kind: 'working' })
    const ids = new Set(b.shipments.map((s) => s.id))
    for (const id of activeIds(db).filter((x) => x !== 'dlv-no-ar')) expect(ids.has(id), id).toBe(true) // no-ar is the documented gap, next test
    expect(ids.has('dlv-unreleased')).toBe(true)
    expect(ids.has('undated-draft')).toBe(true)
    // voided / deleted / canceled / released-delivered rows are not fetched in full
    for (const id of ['open-void', 'dlv-void', 'dlv-deleted', 'canceled', 'dlv-released', 'dlv-readyAt', 'dlv-override']) {
      expect(ids.has(id), id).toBe(false)
    }
    expect(b.orders.map((o) => o.shipmentId).sort()).toEqual([...ids].filter((id) => db.orders.some((o) => o.shipmentId === id)).sort())
    expect(b.loads.map((l) => l.shipmentId).sort()).toEqual([...ids].sort())
    expect(b.loadFinancials).toHaveLength(b.loads.length)
    expect(calls.fullScan).toBe(0)
  })

  it('documents the one theoretical gap: a delivered shipment whose order has no arStatus is not in the set', async () => {
    const b = await loadBoardBundle({ kind: 'working' })
    expect(b.shipments.some((s) => s.id === 'dlv-no-ar')).toBe(false)
  })

  it('remembers voided/deleted ids so a second read does not ask for them again', async () => {
    await loadBoardBundle({ kind: 'working' })
    const firstNarrow = calls.batch.filter((c) => c.narrow).flatMap((c) => c.ids)
    expect(firstNarrow).toEqual(expect.arrayContaining(['dlv-void', 'dlv-deleted']))
    calls.batch = []
    await loadBoardBundle({ kind: 'working' }, { force: true })
    const secondNarrow = calls.batch.filter((c) => c.narrow).flatMap((c) => c.ids)
    expect(secondNarrow).not.toContain('dlv-void')
    expect(secondNarrow).not.toContain('dlv-deleted')
  })

  it('reports the joined open rows before the delivered backlog has been checked', async () => {
    let open!: () => void
    gateNarrow = new Promise<void>((r) => { open = r })
    const partials: string[][] = []
    const done = loadBoardBundle({ kind: 'working' }, { onPartial: (p) => partials.push(p.shipments.map((s) => s.id)) })
    await vi.waitFor(() => expect(partials).toHaveLength(1))
    expect(partials[0]).toContain('open')
    expect(partials[0]).not.toContain('dlv-unreleased')
    open()
    const full = await done
    expect(full.shipments.some((s) => s.id === 'dlv-unreleased')).toBe(true)
  })
})

describe('loadBoardBundle window', () => {
  it('does the same work whatever sits outside the window (10k vs 50k other shipments)', async () => {
    const run = async (extra: number) => {
      db = fixture()
      for (let i = 0; i < extra; i++) db.shipments.push(ship(`old${i}`, 'DELIVERED', { pickupMonth: '2020-01' }))
      invalidateLists()
      calls.month = []; calls.batch = []
      const b = await loadBoardBundle({ kind: 'window', months: ['2026-11'] })
      return { months: calls.month.length, batches: calls.batch.length, rows: b.shipments.length }
    }
    expect(await run(10_000)).toEqual(await run(50_000))
  })

  it('drops the void filter only when asked and keys the cache accordingly', async () => {
    const without = await loadBoardBundle({ kind: 'window', months: ['2026-11'] })
    const withVoided = await loadBoardBundle({ kind: 'window', months: ['2026-11'], includeVoided: true })
    expect(calls.month.map((c) => c.includeVoided)).toEqual([undefined, true])
    expect(withVoided.shipments.length).toBeGreaterThan(without.shipments.length)
    expect(boardViewKey({ kind: 'window', months: ['2026-11', '2026-10'] })).toBe(boardViewKey({ kind: 'window', months: ['2026-10', '2026-11'] }))
  })
})

describe('getShipmentsByIds', () => {
  it('serves a repeat from the memo, lets a full row answer a narrow ask, and refetches after a write', async () => {
    await getShipmentsByIds(['open', 'draft'], false)
    calls.batch = []
    const again = await getShipmentsByIds(['open', 'draft'], true)
    expect(calls.batch).toHaveLength(0)
    expect(again.size).toBe(2)
    invalidateLists()
    await getShipmentsByIds(['open'], true)
    expect(calls.batch).toHaveLength(1)
  })
})
