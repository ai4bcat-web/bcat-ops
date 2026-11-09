import { describe, expect, it } from 'vitest'
import { resolveTeamLayout, TEAM_DEFAULT_COLUMN_TEMPLATE_ID } from './teamColumnLayout'

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

  it('uses the defaults when every saved column is retired', () => {
    expect(resolveTeamLayout([row({ columns: ['gone'] })], VALID, DEFAULTS).columns).toEqual(DEFAULTS)
  })
})
