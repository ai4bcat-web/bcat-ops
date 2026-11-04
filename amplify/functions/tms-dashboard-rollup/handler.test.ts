import { describe, expect, it, vi } from 'vitest'
import { marshall } from '@aws-sdk/util-dynamodb'
import { ROLLUP_SCHEMA_VERSION, type MonthPayload } from '../../../src/lib/dashboardRollup'
import {
  addMonths,
  MAX_PAYLOAD_BYTES,
  MIN_RECOMPUTE_INTERVAL_MS,
  monthsDescending,
  processStream,
  recomputeKey,
  runBackfill,
  runSweep,
  type Computes,
  type RollupDeps,
} from './handler'
import type { RollupRow, RollupSource, RollupStore } from './store'

/** In-memory DashboardRollup table with the same conditional semantics as the real one. */
function fakeStore(initial: RollupRow[] = []): RollupStore & { rows: Map<string, RollupRow>; beforeCompute?: () => void } {
  const rows = new Map(initial.map((r) => [r.id, r]))
  return {
    rows,
    get: async (id) => rows.get(id),
    scanAll: async () => [...rows.values()],
    put: async (row) => void rows.set(row.id, row),
    markDirty: async (rowId, at) => {
      rows.set(`D:${rowId}`, { id: `D:${rowId}`, kind: 'D', periodKey: rowId, dirtyAt: at, version: 1 })
    },
    clearDirty: async (rowId, seen) => {
      if (rows.get(`D:${rowId}`)?.dirtyAt !== seen) return false
      rows.delete(`D:${rowId}`)
      return true
    },
    acquireLease: async (rowId, nowSec, ttl) => {
      const held = rows.get(`K:${rowId}`)
      if (held && (held.leaseUntil ?? 0) >= nowSec) return false
      rows.set(`K:${rowId}`, { id: `K:${rowId}`, kind: 'K', periodKey: rowId, leaseUntil: nowSec + ttl, version: 1 })
      return true
    },
    releaseLease: async (rowId) => void rows.delete(`K:${rowId}`),
  }
}

const NOW = new Date('2026-11-04T15:00:00.000Z')

function monthPayload(month: string, n = 1): MonthPayload {
  return { v: 1, month, ship: { [`${month}-03`]: { 'BROKERAGE|': { st: { DELIVERED: n }, ld: n, trk: 0, pod: 0 } } }, fin: {} }
}

function harness(opts: { store?: ReturnType<typeof fakeStore>; computes?: Partial<Computes>; now?: () => Date } = {}) {
  const store = opts.store ?? fakeStore()
  const computes: Computes = {
    month: vi.fn(async (_s, month) => monthPayload(month)),
    live: vi.fn(async () => ({ v: 1 as const, ar: { '|': { n: 1, c: 100 } }, ap: {} })),
    legacy: vi.fn(async () => ({ v: 1 as const, days: {} })),
    ...opts.computes,
  }
  const deps: RollupDeps = {
    store,
    source: {} as RollupSource,
    computes,
    tableByName: { 'Shipment-tbl': 'Shipment', 'Invoice-tbl': 'Invoice', 'Load-tbl': 'Load' },
    now: opts.now ?? (() => NOW),
  }
  return { store, computes, deps }
}

const streamRecord = (table: string, seq: string, oldImage: Record<string, unknown> | undefined, newImage: Record<string, unknown> | undefined) => ({
  eventSourceARN: `arn:aws:dynamodb:us-east-1:111:table/${table}/stream/2026-11-04T00:00:00.000`,
  dynamodb: {
    SequenceNumber: seq,
    ...(oldImage ? { OldImage: marshall(oldImage) } : {}),
    ...(newImage ? { NewImage: marshall(newImage) } : {}),
  },
})

describe('recomputeKey', () => {
  it('is idempotent: recomputing twice gives the same payload and counts the version up', async () => {
    const { store, deps } = harness()
    expect(await recomputeKey(deps, 'M:2026-11', { respectMinInterval: false })).toBe('written')
    const first = store.rows.get('M:2026-11')!
    expect(await recomputeKey(deps, 'M:2026-11', { respectMinInterval: false })).toBe('written')
    const second = store.rows.get('M:2026-11')!
    expect(second.payload).toBe(first.payload)
    expect(first.schemaVersion).toBe(ROLLUP_SCHEMA_VERSION)
    expect([first.version, second.version]).toEqual([1, 2])
    expect(typeof first.payload).toBe('string') // AWSJSON travels as a string
    expect([...store.rows.keys()].some((k) => k.startsWith('K:'))).toBe(false) // lease released
  })

  it('keeps the dirty marker when a write lands between the read and the clear', async () => {
    const store = fakeStore()
    await store.markDirty('M:2026-11', '2026-11-04T14:59:00.000Z')
    const { deps } = harness({
      store,
      computes: {
        month: async (_s, month) => {
          await store.markDirty('M:2026-11', '2026-11-04T14:59:50.000Z') // a stream write during the recompute
          return monthPayload(month)
        },
      },
    })
    await recomputeKey(deps, 'M:2026-11', { respectMinInterval: false })
    expect(store.rows.get('D:M:2026-11')?.dirtyAt).toBe('2026-11-04T14:59:50.000Z')
    expect(store.rows.has('M:2026-11')).toBe(true)
  })

  it('clears the marker when nothing touched it during the recompute', async () => {
    const store = fakeStore()
    await store.markDirty('M:2026-11', '2026-11-04T14:59:00.000Z')
    const { deps } = harness({ store })
    await recomputeKey(deps, 'M:2026-11', { respectMinInterval: false })
    expect(store.rows.has('D:M:2026-11')).toBe(false)
  })

  it('skips a key whose lease another invocation holds, leaving it dirty', async () => {
    const store = fakeStore()
    await store.markDirty('M:2026-11', '2026-11-04T14:59:00.000Z')
    await store.acquireLease('M:2026-11', Math.floor(NOW.getTime() / 1000), 120)
    const { deps, computes } = harness({ store })
    expect(await recomputeKey(deps, 'M:2026-11', { respectMinInterval: false })).toBe('leased')
    expect(computes.month).not.toHaveBeenCalled()
    expect(store.rows.has('D:M:2026-11')).toBe(true)
  })

  it('takes over an expired lease', async () => {
    const store = fakeStore()
    await store.acquireLease('M:2026-11', Math.floor(NOW.getTime() / 1000) - 500, 120)
    const { deps } = harness({ store })
    expect(await recomputeKey(deps, 'M:2026-11', { respectMinInterval: false })).toBe('written')
  })

  it('does not write a payload above the cap and leaves a marker the client reads as unusable', async () => {
    const store = fakeStore([{ id: 'M:2026-11', kind: 'M', periodKey: '2026-11', schemaVersion: 1, payload: '{"old":true}', computedAt: '2026-11-01T00:00:00.000Z', version: 4 }])
    const big = { ...monthPayload('2026-11'), pad: 'x'.repeat(MAX_PAYLOAD_BYTES) } as MonthPayload
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { deps } = harness({ store, computes: { month: async () => big } })
    expect(await recomputeKey(deps, 'M:2026-11', { respectMinInterval: false })).toBe('too-large')
    const row = store.rows.get('M:2026-11')!
    expect(row.payload).toBeNull()
    expect(JSON.parse(row.sourceCounts as string)).toMatchObject({ tooLarge: true })
    expect(err.mock.calls.some((c) => String(c[0]).startsWith('ROLLUP_TOO_LARGE M:2026-11'))).toBe(true)
    err.mockRestore()
  })

  it('throttles a stream recompute of a row refreshed under 30 s ago, but not a sweep', async () => {
    const fresh = new Date(NOW.getTime() - (MIN_RECOMPUTE_INTERVAL_MS - 5_000)).toISOString()
    const store = fakeStore([{ id: 'M:2026-11', kind: 'M', periodKey: '2026-11', schemaVersion: 1, payload: '{}', computedAt: fresh, version: 1 }])
    const { deps } = harness({ store })
    expect(await recomputeKey(deps, 'M:2026-11', { respectMinInterval: true })).toBe('throttled')
    expect(await recomputeKey(deps, 'M:2026-11', { respectMinInterval: false })).toBe('written')
  })
})

describe('processStream', () => {
  it('marks and recomputes the months a shipment status change touches, and ignores an irrelevant write', async () => {
    const { store, deps, computes } = harness()
    const base = { id: 's1', pickupAppt: '2026-11-03T10:00:00Z', pickupMonth: '2026-11', status: 'BOOKED' }
    const { response } = await processStream(deps, {
      Records: [
        streamRecord('Shipment-tbl', '1', base, { ...base, status: 'DELIVERED' }),
        streamRecord('Shipment-tbl', '2', base, { ...base, updatedAt: 'x', notes: 'n' }),
        streamRecord('Unrelated-tbl', '3', base, { ...base, status: 'DELIVERED' }),
      ],
    })
    expect(response.batchItemFailures).toEqual([])
    expect(store.rows.get('M:2026-11')?.payload).toBeTruthy()
    expect(computes.month).toHaveBeenCalledTimes(1)
    expect(computes.month).toHaveBeenCalledWith(expect.anything(), '2026-11')
  })

  it('an invoice leaving the open set refreshes the live row', async () => {
    const { store, deps, computes } = harness()
    await processStream(deps, {
      Records: [streamRecord('Invoice-tbl', '1', { id: 'i1', arOpen: 'OPEN', balanceCents: 500 }, { id: 'i1', balanceCents: 0 })],
    })
    expect(computes.live).toHaveBeenCalledTimes(1)
    expect(store.rows.get('L:CURRENT')?.kind).toBe('L')
  })

  it('reports only the poison record and still processes the rest of the batch', async () => {
    const { store, deps } = harness()
    const base = { id: 's1', pickupAppt: '2026-11-03T10:00:00Z', pickupMonth: '2026-11', status: 'BOOKED' }
    const poison = { ...streamRecord('Shipment-tbl', 'bad', base, base), dynamodb: { SequenceNumber: 'bad', NewImage: { x: { BOGUS: 1 } } } }
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { response } = await processStream(deps, {
      Records: [poison as never, streamRecord('Shipment-tbl', 'ok', base, { ...base, status: 'DELIVERED' })],
    })
    err.mockRestore()
    expect(response.batchItemFailures).toEqual([{ itemIdentifier: 'bad' }])
    expect(store.rows.has('M:2026-11')).toBe(true)
  })

  it('recomputes at most three months per invocation and leaves the rest marked for the sweep', async () => {
    const { store, deps, computes } = harness()
    const records = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09'].map((m, i) =>
      streamRecord('Shipment-tbl', String(i), { id: `s${i}`, pickupMonth: m, status: 'BOOKED', pickupAppt: `${m}-02` }, { id: `s${i}`, pickupMonth: m, status: 'DELIVERED', pickupAppt: `${m}-02` }),
    )
    await processStream(deps, { Records: records })
    const months = (computes.month as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1])
    expect(months).toEqual(['2026-09', '2026-08', '2026-07'])
    expect(store.rows.has('D:M:2026-05')).toBe(true)
    expect(store.rows.has('D:M:2026-09')).toBe(false)
  })

  it('a failed recompute keeps the marker and does not fail the batch', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { store, deps } = harness({ computes: { month: async () => { throw new Error('boom') } } })
    const base = { id: 's1', pickupAppt: '2026-11-03T10:00:00Z', pickupMonth: '2026-11', status: 'BOOKED' }
    const { response, summary } = await processStream(deps, { Records: [streamRecord('Shipment-tbl', '1', base, { ...base, status: 'DELIVERED' })] })
    err.mockRestore()
    expect(response.batchItemFailures).toEqual([])
    expect(summary.failed).toEqual([{ key: 'M:2026-11', error: 'boom' }])
    expect(store.rows.has('D:M:2026-11')).toBe(true)
    expect([...store.rows.keys()].some((k) => k.startsWith('K:'))).toBe(false)
  })
})

describe('runSweep', () => {
  const current = (id: string, schemaVersion = ROLLUP_SCHEMA_VERSION): RollupRow => ({ id, kind: id.split(':')[0]!, periodKey: id.split(':')[1]!, schemaVersion, payload: '{}', computedAt: '2026-11-04T14:00:00.000Z', version: 1 })

  it('always refreshes the live row, the previous / current / next month and dirty keys', async () => {
    const all: RollupRow[] = []
    for (const m of monthsDescending('2024-01', '2026-12')) all.push(current(`M:${m}`), current(`LG:${m}`))
    const store = fakeStore([...all, current('L:CURRENT')])
    await store.markDirty('M:2025-03', '2026-11-04T14:50:00.000Z')
    const { deps } = harness({ store })
    const summary = await runSweep(deps)
    expect(summary.written).toEqual(
      expect.arrayContaining(['L:CURRENT', 'M:2026-10', 'M:2026-11', 'M:2026-12', 'LG:2026-10', 'LG:2026-11', 'M:2025-03']),
    )
    expect(summary.written).not.toContain('M:2025-04')
    expect(store.rows.has('D:M:2025-03')).toBe(false)
  })

  it('backfills absent and old-schema months, newest first, within the time budget', async () => {
    const store = fakeStore([current('M:2026-05', 0)]) // old schema
    let t = NOW.getTime()
    const { deps } = harness({ store, now: () => new Date(t) })
    // Each recompute advances the clock 30 s; a 100 s budget with a 12 s reserve allows 3 keys.
    ;(deps.computes.month as ReturnType<typeof vi.fn>).mockImplementation(async (_s: unknown, m: string) => { t += 30_000; return monthPayload(m) })
    ;(deps.computes.live as ReturnType<typeof vi.fn>).mockImplementation(async () => { t += 30_000; return { v: 1, ar: {}, ap: {} } })
    const summary = await runSweep(deps, 100_000)
    expect(summary.written.length).toBe(3)
    expect(summary.written[0]).toBe('L:CURRENT')
    expect(summary.remaining.length).toBeGreaterThan(0)
    expect(summary.remaining).toContain('M:2026-05')
  })

  it('rewrites an old-schema month once the budget allows', async () => {
    const store = fakeStore([current('M:2026-05', 0)])
    const { deps } = harness({ store })
    await runSweep(deps)
    expect(store.rows.get('M:2026-05')?.schemaVersion).toBe(ROLLUP_SCHEMA_VERSION)
  })
})

describe('runBackfill', () => {
  it('force-recomputes every month in the range plus the live row', async () => {
    const { store, deps } = harness()
    const summary = await runBackfill(deps, { from: '2026-09', to: '2026-11' })
    expect(summary.written.sort()).toEqual(
      ['L:CURRENT', 'LG:2026-09', 'LG:2026-10', 'LG:2026-11', 'M:2026-09', 'M:2026-10', 'M:2026-11'].sort(),
    )
    expect(store.rows.has('M:2026-10')).toBe(true)
  })

  it('rejects a malformed or inverted range', async () => {
    const { deps } = harness()
    await expect(runBackfill(deps, { from: '2026-11', to: '2026-09' })).rejects.toThrow(/from <= to/)
    await expect(runBackfill(deps, { from: '2026-1', to: '2026-09' })).rejects.toThrow()
  })
})

describe('month arithmetic', () => {
  it('crosses year boundaries both ways', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01')
    expect(addMonths('2026-01', -1)).toBe('2025-12')
    expect(monthsDescending('2025-11', '2026-02')).toEqual(['2026-02', '2026-01', '2025-12', '2025-11'])
  })
})
