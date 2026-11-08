import { describe, expect, it } from 'vitest'
import { QUERY_CATALOG, QUERY_IDS, catalogPromptText, parseParams } from './catalog'
import { dashboardAccess } from './access'
import { MODEL_OUT_SCHEMA, buildSpecFromModel, type ModelOut } from './modelSchema'
import { SPEC_LIMITS, autoLayout, parseSpec } from './spec'
import { resolveWindow } from './windows'

const example = () => ({
  v: 1,
  title: 'Ivan Cartage — revenue by customer, this quarter',
  description: 'Revenue and open AR',
  scope: { kind: 'TEAM', teamKeys: ['EAST'] },
  filters: { window: { preset: 'THIS_QUARTER' }, divisions: ['BOX_TRUCK'], customerIds: [], repIds: [], modes: [] },
  widgets: [
    { id: 'w1', type: 'KPI', title: 'Revenue', size: 'S', query: { id: 'fin.summary', params: { metrics: ['revenue', 'profit', 'margin'] } } },
    { id: 'w2', type: 'BAR', title: 'Revenue by customer', size: 'L', query: { id: 'fin.byGroup', params: { metric: 'revenue', groupBy: 'CUSTOMER', limit: 12 } } },
    { id: 'w3', type: 'TABLE', title: 'Open AR by customer', size: 'L', query: { id: 'ar.byCustomer', params: { limit: 12 } } },
  ],
})

const issuesOf = (raw: unknown): string => {
  const r = parseSpec(raw)
  return r.ok ? '' : r.issues.join(' | ')
}

describe('parseSpec', () => {
  it('accepts the example and fills param defaults', () => {
    const r = parseSpec({ ...example(), widgets: [{ id: 'w1', type: 'BAR', title: 'x', size: 'M', query: { id: 'fin.byGroup', params: {} } }] })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.spec.widgets[0].query.params).toEqual({ metric: 'revenue', groupBy: 'CUSTOMER', limit: 12 })
    expect(parseSpec(example()).ok).toBe(true)
  })

  it('rejects an unknown query, extra param, bad enum, out-of-range limit and wrong widget type', () => {
    const w = (query: unknown, type = 'BAR') => ({ ...example(), widgets: [{ id: 'w1', type, title: 't', size: 'M', query }] })
    expect(issuesOf(w({ id: 'drop.table', params: {} }))).toMatch(/unknown query/)
    expect(issuesOf(w({ id: 'fin.byGroup', params: { sql: 'select 1' } }))).toMatch(/"sql" is not a parameter/)
    expect(issuesOf(w({ id: 'fin.byGroup', params: { groupBy: 'TABLE' } }))).toMatch(/groupBy must be one of/)
    expect(issuesOf(w({ id: 'fin.byGroup', params: { limit: 26 } }))).toMatch(/limit/)
    expect(issuesOf(w({ id: 'fin.summary', params: {} }, 'PIE'))).toMatch(/cannot be drawn as PIE/)
  })

  it('rejects unknown keys at every level', () => {
    expect(issuesOf({ ...example(), extra: 1 })).toMatch(/unexpected field "extra"/)
    const s = example()
    ;(s.widgets[0] as Record<string, unknown>).sql = 'x'
    expect(issuesOf(s)).toMatch(/unexpected field "sql"/)
  })

  it('rejects more than 12 widgets, duplicate ids and control characters', () => {
    const w = (i: number) => ({ id: `w${i}`, type: 'LIST', title: 't', size: 'M', query: { id: 'ship.recent', params: {} } })
    expect(issuesOf({ ...example(), widgets: Array.from({ length: SPEC_LIMITS.maxWidgets + 1 }, (_, i) => w(i + 1)) })).toMatch(/1-12 widgets/)
    expect(issuesOf({ ...example(), widgets: [w(1), w(1)] })).toMatch(/used twice/)
    expect(issuesOf({ ...example(), title: 'a\u0000b' })).toMatch(/control characters/)
  })

  it('rejects a window longer than the strictest widget allows', () => {
    const s = { ...example(), widgets: [{ id: 'w1', type: 'LIST', title: 'r', size: 'F', query: { id: 'ship.recent', params: {} } }] }
    expect(issuesOf({ ...s, filters: { ...s.filters, window: { preset: 'YEAR_TO_DATE' } } })).toMatch(/at most 4 months/)
    expect(issuesOf({ ...s, filters: { ...s.filters, window: { preset: 'CUSTOM', from: '2026-01-01', to: '2026-09-30' } } })).toMatch(/at most 4 months/)
    expect(issuesOf({ ...s, filters: { ...s.filters, window: { preset: 'CUSTOM', from: '2026-07-01', to: '2026-09-30' } } })).toBe('')
    // AR has no window, so any window is fine for it.
    const ar = { ...s, widgets: [{ ...s.widgets[0], type: 'TABLE', query: { id: 'ar.aging', params: {} } }] }
    expect(issuesOf({ ...ar, filters: { ...s.filters, window: { preset: 'YEAR_TO_DATE' } } })).toBe('')
  })

  it('rejects bad custom windows and bad scopes', () => {
    const f = (window: unknown) => ({ ...example(), filters: { ...example().filters, window } })
    expect(issuesOf(f({ preset: 'CUSTOM', from: '2026-03-01', to: '2026-02-01' }))).toMatch(/not be after/)
    expect(issuesOf(f({ preset: 'CUSTOM', from: '2025-01-01', to: '2026-12-31' }))).toMatch(/400 days/)
    expect(issuesOf(f({ preset: 'CUSTOM', from: '2026-02-31', to: '2026-03-01' }))).toMatch(/real dates/)
    expect(issuesOf({ ...example(), scope: { kind: 'USERS', userIds: [] } })).toMatch(/userIds/)
    expect(issuesOf({ ...example(), scope: { kind: 'USERS', userIds: Array(26).fill('u') } })).toMatch(/userIds/)
    expect(issuesOf({ ...example(), scope: { kind: 'ALL' } })).toMatch(/scope.kind/)
    expect(issuesOf({ ...example(), scope: { kind: 'COMPANY', userIds: ['x'] } })).toMatch(/unexpected field/)
    expect(issuesOf({ ...example(), filters: { ...example().filters, modes: ['SPACESHIP'] } })).toMatch(/not a shipment mode/)
  })
})

describe('catalog', () => {
  it('has the 16 whitelisted queries, each with a default-valid param set', () => {
    expect(QUERY_IDS).toHaveLength(16)
    for (const id of QUERY_IDS) {
      expect(parseParams(id, {}).ok).toBe(true)
      expect(QUERY_CATALOG[id].types.length).toBeGreaterThan(0)
      expect(catalogPromptText()).toContain(id)
    }
  })
})

describe('windows', () => {
  it('resolves quarters and months on the UTC calendar', () => {
    const now = '2026-11-04T15:00:00Z'
    expect(resolveWindow({ preset: 'THIS_QUARTER' }, now)).toMatchObject({ from: '2026-10-01', to: '2026-12-31', months: ['2026-10', '2026-11', '2026-12'] })
    expect(resolveWindow({ preset: 'LAST_QUARTER' }, now)).toMatchObject({ from: '2026-07-01', to: '2026-09-30' })
    expect(resolveWindow({ preset: 'LAST_MONTH' }, '2026-01-10T00:00:00Z')).toMatchObject({ from: '2025-12-01', to: '2025-12-31' })
    expect(resolveWindow({ preset: 'LAST_30_DAYS' }, now)).toMatchObject({ from: '2026-10-06', to: '2026-11-04', months: ['2026-10', '2026-11'] })
    expect(resolveWindow({ preset: 'YEAR_TO_DATE' }, now).months).toHaveLength(11)
  })
})

describe('autoLayout', () => {
  it('is deterministic, packs KPIs first and wraps at 12 columns', () => {
    const ws = [
      { id: 'w1', type: 'BAR', size: 'L' },
      { id: 'w2', type: 'KPI', size: 'S' },
      { id: 'w3', type: 'KPI', size: 'S' },
      { id: 'w4', type: 'TABLE', size: 'M' },
    ] as const
    const a = autoLayout(ws)
    expect(a).toEqual(autoLayout(ws))
    expect(a).toEqual([
      { id: 'w2', row: 0, col: 0, span: 3 },
      { id: 'w3', row: 0, col: 3, span: 3 },
      { id: 'w1', row: 1, col: 0, span: 9 },
      { id: 'w4', row: 2, col: 0, span: 6 },
    ])
  })
})

describe('model schema', () => {
  const walk = (node: unknown, f: (n: Record<string, unknown>) => void): void => {
    if (Array.isArray(node)) node.forEach((n) => walk(n, f))
    else if (node && typeof node === 'object') {
      f(node as Record<string, unknown>)
      Object.values(node).forEach((n) => walk(n, f))
    }
  }

  it('is union-free, closed, and every property is required; query ids equal the catalog', () => {
    walk(MODEL_OUT_SCHEMA, (n) => {
      for (const banned of ['anyOf', 'oneOf', 'allOf', 'not']) expect(n).not.toHaveProperty(banned)
      if (n.type === 'object') {
        expect(n.additionalProperties).toBe(false)
        expect([...(n.required as string[])].sort()).toEqual(Object.keys(n.properties as object).sort())
      }
    })
    const widget = (MODEL_OUT_SCHEMA.properties.widgets.items.properties as { queryId: { enum: string[] } })
    expect([...widget.queryId.enum].sort()).toEqual([...QUERY_IDS].sort())
  })

  const out = (over: Partial<ModelOut> = {}): ModelOut => ({
    reply: '', ready: true, questions: [], title: 'T', description: '', window: '', from: '', to: '',
    divisionNames: [], customerNames: [], repNames: [], modes: [],
    widgets: [
      { type: 'KPI', title: 'Rev', queryId: 'fin.summary', metric: '', metrics: ['revenue'], groupBy: '', grain: '', sort: '', limit: 0, size: 'S' },
      { type: 'BAR', title: 'By cust', queryId: 'fin.byGroup', metric: 'profit', metrics: ['revenue'], groupBy: '', grain: 'WEEK', sort: '', limit: 0, size: 'L' },
      { type: 'TABLE', title: 'Evil', queryId: 'raw.sql', metric: '', metrics: [], groupBy: '', grain: '', sort: '', limit: 5, size: 'M' },
    ],
    ...over,
  })
  const ctx = { scope: { kind: 'ME' } as const, divisionCodes: ['BOX'], customerIds: ['c1'], repIds: [] }

  it('maps sentinels to absent keys, drops undeclared params and unknown queries, and validates', () => {
    const { raw, dropped } = buildSpecFromModel(out(), ctx)
    expect(dropped).toEqual(['Evil'])
    const r = parseSpec(raw)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.spec.filters.window).toEqual({ preset: 'THIS_MONTH' })
    expect(r.spec.filters.divisions).toEqual(['BOX'])
    expect(r.spec.widgets.map((w) => w.id)).toEqual(['w1', 'w2'])
    // metrics belongs to fin.summary only; metric to fin.byGroup only; grain is not a fin.byGroup param.
    expect(r.spec.widgets[0].query.params).toEqual({ metrics: ['revenue'] })
    expect(r.spec.widgets[1].query.params).toEqual({ metric: 'profit', groupBy: 'CUSTOMER', limit: 12 })
  })

  it('builds a CUSTOM window from from/to and lets invalid values reach parseSpec', () => {
    const { raw } = buildSpecFromModel(out({ from: '2026-10-01', to: '2026-10-31' }), ctx)
    expect((raw.filters as { window: unknown }).window).toEqual({ preset: 'CUSTOM', from: '2026-10-01', to: '2026-10-31' })
    const bad = buildSpecFromModel(out({ widgets: [{ ...out().widgets[1], groupBy: 'NOPE' }] }), ctx)
    expect(issuesOf(bad.raw)).toMatch(/groupBy must be one of/)
  })
})

describe('dashboardAccess', () => {
  it('gives owner and ADMIN everything, AR_AP viewAll only, MANAGER nothing, claims their own flag', () => {
    expect(dashboardAccess({ email: 'ryne@bcatcorp.com', groups: [] })).toEqual({ create: true, publishCompany: true, viewAll: true })
    expect(dashboardAccess({ email: 'a@x.test', groups: ['ADMIN'] })).toEqual({ create: true, publishCompany: true, viewAll: true })
    expect(dashboardAccess({ email: 'a@x.test', groups: ['role-AR_AP'] })).toEqual({ create: false, publishCompany: false, viewAll: true })
    expect(dashboardAccess({ email: 'a@x.test', groups: ['role-MANAGER', 'page-tms'] })).toEqual({ create: false, publishCompany: false, viewAll: false })
    expect(dashboardAccess({ email: 'a@x.test', groups: ['claim-DASHBOARDS_CREATE'] })).toEqual({ create: true, publishCompany: false, viewAll: false })
    expect(dashboardAccess({ email: 'a@x.test', groups: ['claim-DASHBOARDS_PUBLISH_COMPANY', 'claim-VIEW_ALL'] })).toEqual({ create: false, publishCompany: true, viewAll: true })
  })
})
