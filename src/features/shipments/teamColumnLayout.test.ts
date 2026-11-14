import { describe, expect, it } from 'vitest'
import { fitColumnWidths, resolveListLayout, resolveTeamLayout, TEAM_DEFAULT_COLUMN_TEMPLATE_ID, teamTemplateIdFor } from './teamColumnLayout'

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

describe('resolveTeamLayout introduced columns', () => {
  const valid = ['status', 'invoiceStatus', 'proNumber']
  const intro = [{ key: 'invoiceStatus', after: 'status', since: '2026-11-14T12:00:00.000Z' }]
  const saved = (over: Record<string, unknown>) => ({ id: TEAM_DEFAULT_COLUMN_TEMPLATE_ID, columns: ['status', 'proNumber'], widths: null, pinned: ['status', 'proNumber'], ...over }) as never

  it('puts a new column right after its anchor, pinned with it, in a layout saved before it shipped', () => {
    const layout = resolveTeamLayout([saved({ updatedAt: '2026-11-10T00:00:00.000Z' })], valid, valid, [], intro)
    expect(layout.columns).toEqual(['status', 'invoiceStatus', 'proNumber'])
    expect(layout.pinned).toEqual(['status', 'invoiceStatus', 'proNumber'])
  })

  it('leaves a layout saved since alone, so an admin can hide the column', () => {
    const layout = resolveTeamLayout([saved({ updatedAt: '2026-11-15T00:00:00.000Z' })], valid, valid, [], intro)
    expect(layout.columns).toEqual(['status', 'proNumber'])
  })

  it('skips a layout that does not show the anchor', () => {
    const layout = resolveTeamLayout([saved({ columns: ['proNumber'], pinned: null, updatedAt: '2026-11-10T00:00:00.000Z' })], valid, valid, [], intro)
    expect(layout.columns).toEqual(['proNumber'])
  })
})

describe('resolveListLayout (per-list team layouts)', () => {
  const VALID = ['status', 'invoiceStatus', 'factorInfo', 'proNumber', 'customerName']
  const DEFAULTS = ['status', 'invoiceStatus', 'proNumber', 'customerName']
  const INTRODUCED = [{ key: 'invoiceStatus', after: 'status', since: '2026-11-14T07:00:00.000Z' }]
  // The one layout saved before the lists split, from before Invoice Status existed.
  const legacyAll = { id: TEAM_DEFAULT_COLUMN_TEMPLATE_ID, columns: ['status', 'proNumber', 'customerName'], widths: { proNumber: 90 }, pinned: ['status'], updatedAt: '2026-11-11T21:33:13.939Z' }

  it('defaults: All shows Invoice Status right after Status, Active hides it, Voided follows All', () => {
    expect(resolveListLayout('all', [], VALID, DEFAULTS).columns).toEqual(['status', 'invoiceStatus', 'proNumber', 'customerName'])
    expect(resolveListLayout('active', [], VALID, DEFAULTS).columns).toEqual(['status', 'proNumber', 'customerName'])
    expect(resolveListLayout('voided', [], VALID, DEFAULTS).columns).toEqual(['status', 'invoiceStatus', 'proNumber', 'customerName'])
  })

  it('migrates the saved layout: every list starts from it, All gains Invoice Status, Active does not', () => {
    const all = resolveListLayout('all', [legacyAll], VALID, DEFAULTS, ['status'], INTRODUCED)
    const active = resolveListLayout('active', [legacyAll], VALID, DEFAULTS, ['status'], INTRODUCED)
    expect(all).toEqual({ columns: ['status', 'invoiceStatus', 'proNumber', 'customerName'], widths: { proNumber: 90 }, pinned: ['status', 'invoiceStatus'] })
    expect(active).toEqual({ columns: ['status', 'proNumber', 'customerName'], widths: { proNumber: 90 }, pinned: ['status'] })
  })

  it('once a list has its own saved row, that row wins: the migration does not run again', () => {
    const activeOwn = { id: teamTemplateIdFor('active'), columns: ['status', 'invoiceStatus', 'proNumber'], widths: {}, pinned: [], updatedAt: '2026-11-15T00:00:00.000Z' }
    expect(resolveListLayout('active', [legacyAll, activeOwn], VALID, DEFAULTS, ['status'], INTRODUCED).columns).toEqual(['status', 'invoiceStatus', 'proNumber'])
  })

  it('an edit saved for one list lands only on that list', () => {
    const activeOwn = { id: teamTemplateIdFor('active'), columns: ['customerName', 'status'], widths: {}, pinned: [], updatedAt: '2026-11-15T00:00:00.000Z' }
    const templates = [legacyAll, activeOwn]
    expect(resolveListLayout('active', templates, VALID, DEFAULTS, ['status'], INTRODUCED).columns).toEqual(['customerName', 'status'])
    expect(resolveListLayout('all', templates, VALID, DEFAULTS, ['status'], INTRODUCED).columns).toEqual(['status', 'invoiceStatus', 'proNumber', 'customerName'])
    expect(resolveListLayout('voided', templates, VALID, DEFAULTS, ['status'], INTRODUCED).columns).toEqual(['status', 'invoiceStatus', 'proNumber', 'customerName'])
  })

  it('keeps All on the original template id and gives Active and Voided their own', () => {
    expect(teamTemplateIdFor('all')).toBe(TEAM_DEFAULT_COLUMN_TEMPLATE_ID)
    expect(teamTemplateIdFor('active')).toBe('shipments-team-default-active')
    expect(teamTemplateIdFor('voided')).toBe('shipments-team-default-voided')
  })
})
