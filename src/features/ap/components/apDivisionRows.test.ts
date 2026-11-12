import { describe, expect, it } from 'vitest'
import { apDivisionRows } from './apDivisionRows'

describe('apDivisionRows', () => {
  it('lists each division with its sub-divisions indented beneath it, shares of open AP', () => {
    const name = (c: string | null) => ({ BROKERAGE: 'BCAT Logistics', ASSETS: 'Ivan Cartage', LOCAL: 'Local drivers' } as Record<string, string>)[c ?? ''] ?? '—'
    const rows = apDivisionRows([
      { key: 'ASSETS', division: 'ASSETS', subdivision: null, count: 2, cents: 400_00 },
      { key: 'ASSETS/LOCAL', division: 'ASSETS', subdivision: 'LOCAL', count: 2, cents: 400_00 },
      { key: 'BROKERAGE', division: 'BROKERAGE', subdivision: null, count: 3, cents: 600_00 },
    ], name, 1000_00)
    expect(rows.map((r) => [r.key, r.label, r.kind, r.share])).toEqual([
      ['BROKERAGE', 'BCAT Logistics', 'row', 0.6],
      ['ASSETS', 'Ivan Cartage', 'group', 0.4],
      ['ASSETS/LOCAL', 'Local drivers', 'sub', 0.4],
    ])
  })
})
