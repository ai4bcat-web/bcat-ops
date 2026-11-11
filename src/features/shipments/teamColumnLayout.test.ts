import { describe, expect, it } from 'vitest'
import { fitColumnWidths, resolveTeamLayout, TEAM_DEFAULT_COLUMN_TEMPLATE_ID } from './teamColumnLayout'

const VALID = ['proNumber', 'status', 'originCity']
const DEFAULTS = ['proNumber', 'status']
const row = (over: Record<string, unknown>) => ({ id: TEAM_DEFAULT_COLUMN_TEMPLATE_ID, columns: ['status'], widths: null, pinned: null, ...over }) as never

describe('resolveTeamLayout', () => {
  it('falls back to the default columns without a team default row', () => {
    expect(resolveTeamLayout([], VALID, DEFAULTS)).toEqual({ columns: DEFAULTS, widths: {}, pinned: [] })
    expect(resolveTeamLayout([row({ id: 'someone-elses' })], VALID, DEFAULTS).columns).toEqual(DEFAULTS)
  })

  it('drops retired column ids, duplicates, and widths/pins that point at hidden columns', () => {
    const layout = resolveTeamLayout(
      [row({ columns: ['originCity', 'gone', 'proNumber', 'originCity'], widths: { originCity: 140, gone: 90, status: 80, proNumber: -1 }, pinned: ['proNumber', 'status'] })],
      VALID,
      DEFAULTS,
    )
    expect(layout).toEqual({ columns: ['originCity', 'proNumber'], widths: { originCity: 140 }, pinned: ['proNumber'] })
  })

  it('the frozen columns are the pins that were saved, in their order; a layout saved with none starts from the built-in frozen set', () => {
    const frozen = ['status', 'proNumber']
    expect(resolveTeamLayout([], VALID, DEFAULTS, frozen).pinned).toEqual(['proNumber', 'status'].filter((k) => DEFAULTS.includes(k) && frozen.includes(k)))
    const custom = resolveTeamLayout([row({ columns: ['originCity', 'proNumber', 'status'], pinned: ['originCity', 'status'] })], VALID, DEFAULTS, frozen)
    expect(custom.pinned).toEqual(['originCity', 'status'])
    const old = resolveTeamLayout([row({ columns: ['originCity', 'proNumber', 'status'], pinned: [] })], VALID, DEFAULTS, frozen)
    expect(old.pinned).toEqual(['proNumber', 'status'])
  })

  it('uses the defaults when every saved column is retired', () => {
    expect(resolveTeamLayout([row({ columns: ['gone'] })], VALID, DEFAULTS).columns).toEqual(DEFAULTS)
  })
})

describe('fitColumnWidths', () => {
  it('sizes each column to its longest value or header, clamped', () => {
    const rows = [{ a: 'x', b: 'a much longer value here' }, { a: 'xyz', b: 'short' }]
    const w = fitColumnWidths(
      [{ key: 'a', header: 'A', text: (r: typeof rows[0]) => r.a }, { key: 'b', header: 'B', text: (r: typeof rows[0]) => r.b }, { key: 'n', header: 'Notes', text: () => 'z'.repeat(500) }],
      rows,
    )
    expect(w.a).toBe(60) // 3 chars: below the minimum
    expect(w.b).toBe(Math.round('a much longer value here'.length * 7.5 + 36))
    expect(w.n).toBe(520) // capped
  })
})
