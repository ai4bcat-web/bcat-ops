// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

const batchGet = vi.hoisted(() => vi.fn())
vi.mock('@/lib/aliasBatch', () => ({ batchGet }))

import { isUsableRow, readRollupRows, rollupIdsFor, windowFromRows, type RawRollupRow } from './dashboardRollupClient'

const NOW = Date.parse('2026-11-15T12:00:00Z')
const row = (id: string, ageMin: number, extra: Partial<RawRollupRow> = {}): RawRollupRow => ({
  id, kind: id[0]!, periodKey: id.slice(2), schemaVersion: 1,
  payload: id.startsWith('M:') ? { v: 1, month: id.slice(2), ship: {}, fin: {} } : { v: 1, ar: {}, ap: {} },
  computedAt: new Date(NOW - ageMin * 60_000).toISOString(), ...extra,
})

describe('windowFromRows', () => {
  const rows = [row('M:2026-10', 2), row('M:2026-11', 2), row('L:CURRENT', 2)]

  it('accepts a window whose padded next month has no row yet (the future is empty)', () => {
    expect(windowFromRows(rows, '2026-11-01', '2026-11-30', NOW)?.months.map((m) => m.id)).toEqual(['M:2026-10', 'M:2026-11'])
  })

  it('rejects a missing past month, the padding month included', () => {
    expect(windowFromRows(rows.filter((r) => r.id !== 'M:2026-10'), '2026-11-01', '2026-11-30', NOW)).toBeNull()
  })

  it('trusts history months of any age but not a stale current or previous month', () => {
    const later = Date.parse('2027-01-20T12:00:00Z') // October and November are history by now
    const aged = (id: string, ageMin: number) => row(id, ageMin, { computedAt: new Date(later - ageMin * 60_000).toISOString() })
    const history = [aged('M:2026-10', 60 * 24 * 40), aged('M:2026-11', 60 * 24 * 40), aged('L:CURRENT', 2)]
    expect(windowFromRows(history, '2026-10-01', '2026-10-31', later)).not.toBeNull()
    // In mid-November, October is the previous month: a 45-minute-old row is not trusted.
    expect(windowFromRows([row('M:2026-10', 45), row('M:2026-11', 2), row('L:CURRENT', 2)], '2026-10-01', '2026-10-31', NOW)).toBeNull()
  })

  it('rejects an old live row and an unknown schema', () => {
    expect(windowFromRows([rows[0]!, rows[1]!, row('L:CURRENT', 31)], '2026-11-01', '2026-11-30', NOW)).toBeNull()
    expect(windowFromRows([rows[0]!, row('M:2026-11', 2, { schemaVersion: 2 }), rows[2]!], '2026-11-01', '2026-11-30', NOW)).toBeNull()
  })
})

describe('isUsableRow and empty sources', () => {
  it('a row computed from an empty source is unusable; absent or non-empty counts stay usable', () => {
    expect(isUsableRow(row('M:2026-11', 2, { sourceCounts: { shipments: 0, samples: 0, loads: 0 } }), NOW)).toBe(false)
    expect(isUsableRow(row('M:2026-11', 2), NOW)).toBe(true)
    expect(isUsableRow(row('M:2026-11', 2, { sourceCounts: { shipments: 2, samples: 0, loads: 0 } }), NOW)).toBe(true)
  })

  it('a window with one empty-source month from October on is not trusted (the November 8 guard stays)', () => {
    const history = [row('M:2026-10', 2, { sourceCounts: { shipments: 0 } }), row('M:2026-11', 2), row('L:CURRENT', 2)]
    expect(windowFromRows(history, '2026-10-01', '2026-11-30', NOW)).toBeNull()
  })
})

describe('the data start (2026-10)', () => {
  const rows = [row('M:2026-10', 2), row('M:2026-11', 2), row('L:CURRENT', 2)]

  it('never requires a month before October, the padding month under October included', () => {
    expect(windowFromRows(rows, '2026-10-01', '2026-11-30', NOW)?.months.map((m) => m.id)).toEqual(['M:2026-10', 'M:2026-11'])
  })

  it('a range that reaches back before October reads only October on: the old months neither block it nor appear', () => {
    expect(windowFromRows(rows, '2025-11-01', '2026-11-30', NOW)?.months.map((m) => m.id)).toEqual(['M:2026-10', 'M:2026-11'])
  })

  it('a range wholly before October has no window (the exact path answers it)', () => {
    expect(windowFromRows(rows, '2026-03-01', '2026-06-30', NOW)).toBeNull()
  })

  it('a missing October (a month inside the data) still blocks the window', () => {
    expect(windowFromRows(rows.filter((r) => r.id !== 'M:2026-10'), '2025-11-01', '2026-11-30', NOW)).toBeNull()
  })

  it('asks the store only for months from October on', () => {
    expect(rollupIdsFor('2025-11-01', '2026-11-30')).toEqual(['M:2026-10', 'M:2026-11', 'M:2026-12', 'L:CURRENT'])
  })
})

describe('readRollupRows', () => {
  it('asks for sourceCounts and parses the AWSJSON string, so an empty-source row reads as unusable', async () => {
    batchGet.mockResolvedValueOnce(new Map([['M:2026-11', { id: 'M:2026-11', kind: 'M', periodKey: '2026-11', schemaVersion: 1, payload: '{"v":1}', computedAt: new Date(NOW).toISOString(), sourceCounts: '{"shipments":0}' }]]))
    const rows = await readRollupRows(['M:2026-11']).fresh
    expect(batchGet.mock.calls[0]![0].fields).toContain('sourceCounts')
    expect(rows[0]!.sourceCounts).toEqual({ shipments: 0 })
    expect(isUsableRow(rows[0]!, NOW)).toBe(false)
  })
})
