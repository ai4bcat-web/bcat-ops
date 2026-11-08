import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CrmFakeDb } from '../_shared/crmFakeDb'
import type { Db } from '../_shared/crmStore'
import type { DashChatResult, DashRunResult, DashboardRecord, DashboardSpec } from '../../../src/lib/dashboards/types'
import { MODEL_OUT_SCHEMA } from '../../../src/lib/dashboards/modelSchema'
import { dispatch, type AppSyncIdentity } from './actions'
import { DASHBOARD_ACTION_NAMES, DASHBOARD_AUTHZ, type DashDeps } from './dashboardActions'
import type { ModelPort, ModelRequest } from './dashModel'
import type { CustomerNameRow, DashSource } from './dashSources'
import { CONFLICT_ERROR, summaryOf, type DashStore, type StoredDashboard } from './dashStore'

const SENTINEL = /zzsentinel|777777/i

const ident = (username: string, groups: string[]): AppSyncIdentity => ({
  username, sub: username, claims: { email: `${username}@bcatcorp.com`, 'cognito:groups': groups },
})
const admin = ident('boss', ['ADMIN', 'page-tms'])
const pub = ident('pub', ['page-tms', 'claim-DASHBOARDS_CREATE', 'claim-DASHBOARDS_PUBLISH_COMPANY'])
const repa = ident('repa', ['page-tms', 'claim-DASHBOARDS_CREATE'])
const repb = ident('repb', ['page-tms', 'claim-DASHBOARDS_CREATE'])
const plain = ident('plain', ['page-tms'])
const nopage = ident('nopage', ['page-customers', 'claim-DASHBOARDS_CREATE'])
const acct = ident('acct', ['page-tms', 'role-AR_AP'])

const customers: CustomerNameRow[] = [
  { id: 'c1', name: 'Alpha Freight', accountOwnerIds: ['repa'] },
  { id: 'c2', name: 'Team Beta', teamKey: 'EAST' },
  { id: 'c3', name: 'ZZSENTINEL Hidden Co', accountOwnerIds: ['other'] },
  { id: 'c4', name: 'Beta Ambiguous', accountOwnerIds: ['repa'] },
]
const AMOUNT: Record<string, number> = { c1: 1_000, c2: 2_000, c3: 777_777_777, c4: 40 }

function makeSource(): DashSource {
  return {
    customers: async () => customers,
    teams: async () => [{ key: 'EAST', name: 'East', memberIds: ['repb'], active: true }],
    staff: async () => ['repa', 'repb', 'pub', 'boss'].map((id) => ({ id, name: `Name ${id}`, email: `${id}@bcatcorp.com` })),
    divisions: async () => [
      { code: 'IVAN', name: 'Ivan Cartage', brand: 'Ivan Cartage', parentId: null },
      { code: 'IVAN_BOX', name: 'Ivan Box Truck', brand: 'Ivan Cartage', parentId: 'IVAN' },
      { code: 'BCAT', name: 'BCAT Logistics', brand: null, parentId: null },
      { code: 'BEST_A', name: 'Best Auto East', brand: null, parentId: null },
      { code: 'BEST_B', name: 'Best Auto West', brand: null, parentId: null },
    ],
    samples: async () =>
      customers.map((c, i) => ({
        shipmentId: `s${i}`, date: '2026-11-10', revenueCents: AMOUNT[c.id], costCents: 0, profitCents: AMOUNT[c.id],
        customerId: c.id, customerName: c.name, revDivision: 'BCAT', mode: 'FTL',
      })),
    shipments: async () => [],
    openInvoices: async () => [],
    quotes: async () => [],
  }
}

function makeStore(): DashStore {
  const rows = new Map<string, StoredDashboard>()
  return {
    index: async () => [...rows.values()].filter((r) => !r.archivedAt).map(summaryOf),
    get: async (id) => (rows.has(id) ? structuredClone(rows.get(id)!) : null),
    async commit(rec, expected) {
      const cur = rows.get(rec.id)
      if (expected === null ? cur !== undefined : cur?.version !== expected) throw new Error(CONFLICT_ERROR)
      rows.set(rec.id, structuredClone(rec))
    },
  }
}

const spec = (scope: DashboardSpec['scope'], title = 'Revenue'): DashboardSpec => ({
  v: 1, title, scope,
  filters: { window: { preset: 'THIS_MONTH' }, divisions: [], customerIds: [], repIds: [], modes: [] },
  widgets: [{ id: 'w1', type: 'KPI', title: 'Revenue', size: 'M', query: { id: 'fin.summary', params: { metrics: ['revenue', 'count'] } } }],
})

let nextModel: (req: ModelRequest) => Promise<string>
const model: ModelPort = { complete: (req) => nextModel(req) }
const modelOut = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    reply: 'Here you go.', ready: true, questions: [], title: 'Revenue', description: '', window: 'THIS_MONTH', from: '', to: '',
    divisionNames: [], customerNames: [], repNames: [], modes: [],
    widgets: [{ type: 'KPI', title: 'Revenue', queryId: 'fin.summary', metric: '', metrics: ['revenue'], groupBy: '', grain: '', sort: '', limit: 0, size: 'M' }],
    ...over,
  })

let db: Db
let deps: DashDeps
let idSeq = 0
const call = <T = unknown>(who: AppSyncIdentity, action: string, input: unknown = {}) => dispatch(action, input, who, db, deps) as Promise<T>
const revenueOf = async (who: AppSyncIdentity, input: unknown) => {
  const r = await call<DashRunResult>(who, 'PREVIEW_DASHBOARD', input)
  const first = r.results[0]!
  return first.ok ? first.series.kpis?.map((k) => k.value) : first.error
}

afterEach(() => vi.useRealTimers())

beforeEach(() => {
  db = new CrmFakeDb()
  idSeq = 0
  deps = { source: makeSource(), store: makeStore(), model, nowMs: () => Date.parse('2026-11-15T12:00:00Z'), newId: () => `d${++idSeq}` }
  nextModel = async () => modelOut()
})

describe('authorization table', () => {
  it('every dashboard action is routed and refuses a caller without the door', async () => {
    for (const action of DASHBOARD_ACTION_NAMES) {
      await expect(call(nopage, action, {}), action).rejects.toThrow(/Forbidden/)
      await expect(call(ident('x', ['role-DRIVER']), action, {}), action).rejects.toThrow(/Forbidden/)
    }
  })

  it('actions flagged create refuse a caller with page-tms but no claim; creators and ADMIN pass the gate', async () => {
    for (const action of DASHBOARD_ACTION_NAMES.filter((a) => DASHBOARD_AUTHZ[a].create)) {
      await expect(call(plain, action, {}), action).rejects.toThrow(/Create dashboards permission/)
    }
    await expect(call(repa, 'SAVE_DASHBOARD', { spec: spec({ kind: 'ME' }) })).resolves.toBeTruthy()
    await expect(call(admin, 'SAVE_DASHBOARD', { spec: spec({ kind: 'COMPANY' }) })).resolves.toBeTruthy()
  })

  it('an unsaved spec runs only for creators; the built-in Overview and saved dashboards need only the door', async () => {
    await expect(call(plain, 'PREVIEW_DASHBOARD', { spec: spec({ kind: 'ME' }) })).rejects.toThrow(/Forbidden/)
    await expect(call(plain, 'PREVIEW_DASHBOARD', { builtin: 'OVERVIEW' })).resolves.toMatchObject({ visibility: { viewAll: false } })
  })

  it('refuses a COMPANY save without publishCompany and accepts it with', async () => {
    await expect(call(repa, 'SAVE_DASHBOARD', { spec: spec({ kind: 'COMPANY' }) })).rejects.toThrow(/Publish company/)
    const saved = await call<DashboardRecord>(pub, 'SAVE_DASHBOARD', { spec: spec({ kind: 'COMPANY' }) })
    expect(saved).toMatchObject({ scope: 'COMPANY', ownerId: 'pub', version: 1 })
  })
})

describe('visibility: scope decides who may open, never which rows', () => {
  it('one COMPANY dashboard shows each viewer their own totals; viewAll sees the union', async () => {
    const saved = await call<DashboardRecord>(pub, 'SAVE_DASHBOARD', { spec: spec({ kind: 'COMPANY' }) })
    const rev = (who: AppSyncIdentity) => revenueOf(who, { id: saved.id })
    expect(await rev(repa)).toEqual([1_040, 2]) // c1 + c4 (owned)
    expect(await rev(repb)).toEqual([2_000, 1]) // c2 via team EAST
    expect(await rev(plain)).toEqual([null, 0]) // sees nothing: no error
    expect(await rev(acct)).toEqual([1_000 + 2_000 + 777_777_777 + 40, 4])
    expect(await rev(admin)).toEqual([1_000 + 2_000 + 777_777_777 + 40, 4])
  })

  it('a non-viewAll Overview never carries a hidden row', async () => {
    const r = await call<DashRunResult>(repa, 'PREVIEW_DASHBOARD', { builtin: 'OVERVIEW' })
    expect(JSON.stringify(r)).not.toMatch(SENTINEL)
    expect(r.visibility).toMatchObject({ viewAll: false, ownedCustomers: 2 })
  })

  it('a hand-typed customer filter for a hidden customer returns nothing, same as an unknown id', async () => {
    const s = spec({ kind: 'ME' })
    s.filters.customerIds = ['c3']
    const hidden = await revenueOf(repa, { spec: s })
    s.filters.customerIds = ['nope']
    expect(hidden).toEqual(await revenueOf(repa, { spec: s }))
    expect(hidden).toEqual([null, 0])
  })

  it('a window override applies, and is validated', async () => {
    await expect(call(repa, 'PREVIEW_DASHBOARD', { spec: spec({ kind: 'ME' }), window: { preset: 'NEVER' } })).rejects.toThrow(/Invalid window/)
    const r = await call<DashRunResult>(repa, 'PREVIEW_DASHBOARD', { spec: spec({ kind: 'ME' }), window: { preset: 'LAST_MONTH' } })
    expect(r.resolved.months).toEqual(['2026-10'])
  })
})

describe('audience: owner, COMPANY, sharedWith, ADMIN', () => {
  it('sharing to a user or a team changes who lists and opens it, and archived rows disappear', async () => {
    const mine = await call<DashboardRecord>(repa, 'SAVE_DASHBOARD', { spec: spec({ kind: 'USERS', userIds: ['repb'] }, 'For B') })
    const forTeam = await call<DashboardRecord>(repa, 'SAVE_DASHBOARD', { spec: spec({ kind: 'TEAM', teamKeys: ['east'] }, 'For East') })
    const solo = await call<DashboardRecord>(repa, 'SAVE_DASHBOARD', { spec: spec({ kind: 'ME' }, 'Solo') })
    const ids = async (who: AppSyncIdentity) => {
      const r = await call<{ company: { id: string }[]; mine: { id: string }[] }>(who, 'LIST_DASHBOARDS')
      return [...r.company, ...r.mine].map((s) => s.id).sort()
    }
    expect(await ids(repa)).toEqual([mine.id, forTeam.id, solo.id].sort())
    expect(await ids(repb)).toEqual([mine.id, forTeam.id].sort())
    expect(await ids(plain)).toEqual([])
    // Not-in-audience reads exactly like a missing id.
    await expect(call(plain, 'GET_DASHBOARD', { id: solo.id })).rejects.toThrow('Dashboard not found')
    await expect(call(plain, 'GET_DASHBOARD', { id: 'missing' })).rejects.toThrow('Dashboard not found')
    await expect(call(plain, 'PREVIEW_DASHBOARD', { id: solo.id })).rejects.toThrow('Dashboard not found')
    // Sharing changes the card, not the numbers: B opens A's dashboard and sees B's data.
    expect(await revenueOf(repb, { id: mine.id })).toEqual([2_000, 1])

    await call(repa, 'ARCHIVE_DASHBOARD', { id: solo.id, expectedVersion: solo.version })
    expect(await ids(repa)).toEqual([mine.id, forTeam.id].sort())
  })

  it('only the owner or an administrator may change or archive; versions guard concurrent edits', async () => {
    const rec = await call<DashboardRecord>(repa, 'SAVE_DASHBOARD', { spec: spec({ kind: 'USERS', userIds: ['repb'] }) })
    await expect(call(repb, 'SAVE_DASHBOARD', { id: rec.id, spec: spec({ kind: 'ME' }), expectedVersion: 1 })).rejects.toThrow(/only the owner/)
    await expect(call(repb, 'ARCHIVE_DASHBOARD', { id: rec.id, expectedVersion: 1 })).rejects.toThrow(/only the owner/)
    const edited = await call<DashboardRecord>(repa, 'SAVE_DASHBOARD', { id: rec.id, spec: spec({ kind: 'ME' }, 'Renamed'), expectedVersion: 1 })
    expect(edited).toMatchObject({ title: 'Renamed', version: 2, ownerId: 'repa' })
    await expect(call(repa, 'SAVE_DASHBOARD', { id: rec.id, spec: spec({ kind: 'ME' }), expectedVersion: 1 })).rejects.toThrow(/Conflict/)
    await expect(call(repa, 'SAVE_DASHBOARD', { id: rec.id, spec: spec({ kind: 'ME' }) })).rejects.toThrow(/expectedVersion/)
    expect((await call<{ canEdit: boolean }>(repa, 'GET_DASHBOARD', { id: rec.id })).canEdit).toBe(true)
    expect(await call(admin, 'ARCHIVE_DASHBOARD', { id: rec.id, expectedVersion: 2 })).toMatchObject({ id: rec.id })
  })

  it('a client cannot choose the owner; people and teams must exist and be active', async () => {
    const rec = await call<DashboardRecord>(repa, 'SAVE_DASHBOARD', { spec: spec({ kind: 'ME' }), ownerId: 'boss', createdBy: 'boss' })
    expect(rec).toMatchObject({ ownerId: 'repa', createdBy: 'repa' })
    await expect(call(repa, 'SAVE_DASHBOARD', { spec: spec({ kind: 'USERS', userIds: ['ghost'] }) })).rejects.toThrow(/not an active user/)
    await expect(call(repa, 'SAVE_DASHBOARD', { spec: spec({ kind: 'TEAM', teamKeys: ['WEST'] }) })).rejects.toThrow(/not an active team/)
  })

  it('a COMPANY dashboard cannot be edited or archived by an owner who lost publishCompany', async () => {
    const rec = await call<DashboardRecord>(pub, 'SAVE_DASHBOARD', { spec: spec({ kind: 'COMPANY' }) })
    const downgraded = ident('pub', ['page-tms', 'claim-DASHBOARDS_CREATE'])
    await expect(call(downgraded, 'ARCHIVE_DASHBOARD', { id: rec.id, expectedVersion: 1 })).rejects.toThrow(/Forbidden/)
    expect((await call<{ canEdit: boolean }>(downgraded, 'GET_DASHBOARD', { id: rec.id })).canEdit).toBe(false)
  })
})

describe('GET_DASHBOARD_OPTIONS', () => {
  it('exposes pickers and permissions but no customer or row data', async () => {
    const o = await call<Record<string, unknown>>(repa, 'GET_DASHBOARD_OPTIONS')
    expect(o).toMatchObject({ access: { create: true, publishCompany: false, viewAll: false }, teams: [{ key: 'EAST', name: 'East' }] })
    expect(JSON.stringify(o)).not.toMatch(/Alpha Freight|ZZSENTINEL/)
    expect((o.staff as { id: string; teamKeys: string[] }[]).find((s) => s.id === 'repb')?.teamKeys).toEqual(['EAST'])
  })
})

describe('chat: the scope gate and failure behaviour', () => {
  const chat = (who: AppSyncIdentity, scope: unknown, extra: Record<string, unknown> = {}) =>
    call<DashChatResult>(who, 'PREVIEW_DASHBOARD_CHAT', { messages: [{ role: 'user', text: 'revenue this month' }], scope, draft: null, ...extra })

  it('R1/R2: with no scope the SCOPE question is present and spec is null even when the model built one; with a scope the spec comes back', async () => {
    const first = await chat(repa, null)
    expect(first.spec).toBeNull()
    expect(first.questions.map((q) => q.kind)).toContain('SCOPE')
    const second = await chat(repa, { kind: 'ME' })
    expect(second.spec).toMatchObject({ title: 'Revenue', scope: { kind: 'ME' } })
    expect(second.questions.some((q) => q.kind === 'SCOPE')).toBe(false)
  })

  it('a provider failure never throws and never loses the scope question', async () => {
    nextModel = async () => {
      throw new Error('credit balance is too low')
    }
    const r = await chat(repa, null)
    expect(r.modelError).toMatch(/credit balance/)
    expect(r.spec).toBeNull()
    expect(r.questions.map((q) => q.kind)).toContain('SCOPE')
    nextModel = async () => 'not json'
    expect((await chat(repa, { kind: 'ME' })).modelError).toMatch(/unreadable/)
  })

  it('aborts a slow model at 22 s and reports it instead of hanging', async () => {
    nextModel = (req) => new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(new Error('aborted'))))
    vi.useFakeTimers()
    try {
      const pending = chat(repa, { kind: 'ME' })
      await vi.advanceTimersByTimeAsync(22_000)
      expect((await pending).modelError).toMatch(/too long/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses COMPANY without publishCompany at the chat call', async () => {
    await expect(chat(repa, { kind: 'COMPANY' })).rejects.toThrow(/Publish company/)
    await expect(chat(plain, null)).rejects.toThrow(/Forbidden/)
  })

  it('R5: an ambiguous division becomes a clarifying question; unknown and not-visible customers read identically', async () => {
    nextModel = async () => modelOut({ divisionNames: ['Best Auto'] })
    const amb = await chat(repa, { kind: 'ME' })
    expect(amb.spec).toBeNull()
    expect(amb.questions.find((q) => q.kind === 'CLARIFY')?.choices).toEqual(['Best Auto East', 'Best Auto West'])

    nextModel = async () => modelOut({ customerNames: ['ZZSENTINEL Hidden Co'] })
    const hidden = await chat(repa, { kind: 'ME' })
    nextModel = async () => modelOut({ customerNames: ['No Such Customer'] })
    const missing = await chat(repa, { kind: 'ME' })
    expect(hidden.spec).toBeNull()
    expect(hidden.issues[0]!.replace(/"[^"]*"/, '"X"')).toBe(missing.issues[0]!.replace(/"[^"]*"/, '"X"'))
    expect(hidden.resolved.customers).toEqual([])
    // A viewAll creator can resolve it.
    nextModel = async () => modelOut({ customerNames: ['ZZSENTINEL Hidden Co'] })
    const seesAll = await chat(ident('vall', ['page-tms', 'claim-DASHBOARDS_CREATE', 'claim-VIEW_ALL']), { kind: 'ME' })
    expect(seesAll.resolved.customers).toEqual([{ id: 'c3', name: 'ZZSENTINEL Hidden Co' }])
  })

  it('a parent division covers its children (Ivan Cartage is one division, not four)', async () => {
    nextModel = async () => modelOut({ divisionNames: ['Ivan Cartage'] })
    const r = await chat(repa, { kind: 'ME' })
    expect(r.spec?.filters.divisions).toEqual(['IVAN'])
    expect(r.questions).toEqual([])
  })

  it('one repair call when the first spec is invalid; no spec when it is still invalid', async () => {
    let calls = 0
    const bad = modelOut({ widgets: [{ type: 'PIE', title: 'x', queryId: 'fin.summary', metric: '', metrics: ['revenue'], groupBy: '', grain: '', sort: '', limit: 0, size: 'M' }] })
    nextModel = async () => (++calls === 1 ? bad : modelOut())
    expect((await chat(repa, { kind: 'ME' })).spec).not.toBeNull()
    expect(calls).toBe(2)
    calls = 0
    nextModel = async () => (++calls, bad)
    const r = await chat(repa, { kind: 'ME' })
    expect(r.spec).toBeNull()
    expect(calls).toBe(2)
    expect(r.issues.join()).toMatch(/cannot be drawn as PIE/)
  })

  it('sends the model only the transcript, catalog and draft names, and the model schema is union-free', async () => {
    let seen: ModelRequest | undefined
    nextModel = async (req) => ((seen = req), modelOut())
    await chat(repa, { kind: 'ME' }, { draft: spec({ kind: 'ME' }) })
    expect(seen!.messages[0]!.role).toBe('user')
    expect(seen!.system).toMatch(/fin\.byGroup/)
    expect(JSON.stringify(seen!.messages)).not.toMatch(/ZZSENTINEL|Alpha Freight/)
    expect(JSON.stringify(MODEL_OUT_SCHEMA)).not.toMatch(/anyOf|oneOf|allOf/)
  })
})
