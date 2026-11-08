// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

const batchGet = vi.hoisted(() => vi.fn())
vi.mock('@/lib/aliasBatch', () => ({ batchGet }))

import { isUsableRow, readRollupRows, windowFromRows, type RawRollupRow } from './dashboardRollupClient'

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
    const old = (m: string) => row(`M:${m}`, 60 * 24 * 20)
    const history = [old('2026-07'), old('2026-08'), old('2026-09'), row('L:CURRENT', 2)]
    expect(windowFromRows(history, '2026-08-01', '2026-08-31', NOW)).not.toBeNull()
    expect(windowFromRows([...history, row('M:2026-10', 45), row('M:2026-11', 2)], '2026-10-01', '2026-10-31', NOW)).toBeNull()
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

  it('a window with one empty-source history month is not trusted, even though history age does not matter', () => {
    const old = (m: string, extra: Partial<RawRollupRow> = {}) => row(`M:${m}`, 60 * 24 * 20, extra)
    const history = [old('2026-07'), old('2026-08', { sourceCounts: { shipments: 0 } }), old('2026-09'), row('L:CURRENT', 2)]
    expect(windowFromRows(history, '2026-08-01', '2026-08-31', NOW)).toBeNull()
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
