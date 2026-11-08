/**
 * The directory lists are cached for a minute. That is only safe because every write by this tab
 * clears them: a save followed by a cached read must not show the pre-save row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AP_INBOX_ACTIONS } from '@/lib/apInbox/actions'

const graphqlMock = vi.fn()
vi.mock('aws-amplify/data', () => ({ generateClient: () => ({ graphql: graphqlMock }) }))
vi.mock('aws-amplify/storage', () => ({ uploadData: vi.fn(), getUrl: vi.fn(), remove: vi.fn() }))

const { listCarriers, listUserProfiles, listCustomers, deleteDriver, setUserTeams, listDriverPaySettings, listExpenseTypes, listShipmentIdsByMonths } = await import('./apiClient')
const { invalidateLists } = await import('./listCache')

let carriers: { id: string; name: string }[]
let profiles: { id: string }[]
let customers: { id: string; status?: string; active?: boolean }[]

beforeEach(() => {
  invalidateLists()
  graphqlMock.mockReset()
  carriers = [{ id: 'c1', name: 'Before' }]
  profiles = [{ id: 'p1' }]
  customers = [{ id: 'k1', status: 'ACTIVE' }, { id: 'k2', active: false }]
  graphqlMock.mockImplementation(async ({ query }: { query: string }) => {
    if (query.includes('listCarriers')) return { data: { listCarriers: { items: carriers.map((c) => ({ ...c })), nextToken: null } } }
    if (query.includes('listUserProfiles')) return { data: { listUserProfiles: { items: profiles, nextToken: null } } }
    if (query.includes('listDriverPaySettings')) return { data: { listDriverPaySettings: { items: [{ id: 'ps1' }] } } }
    if (query.includes('listExpenseTypes')) return { data: { listExpenseTypes: { items: [{ id: 'et1' }] } } }
    if (query.includes('listCustomers')) return { data: { listCustomers: { items: customers, nextToken: null } } }
    return { data: {} }
  })
})

const reads = (name: string) => graphqlMock.mock.calls.filter(([a]) => String(a.query).includes(name)).length

describe('cached directory lists', () => {
  it('serve a second read from the cache, one request in flight for concurrent callers', async () => {
    await Promise.all([listCarriers(), listCarriers()])
    await listCarriers()
    expect(reads('listCarriers')).toBe(1)
  })

  it('a mutation clears them, so the next read sees the saved row', async () => {
    expect((await listCarriers())[0].name).toBe('Before')
    carriers = [{ id: 'c1', name: 'After' }]
    expect((await listCarriers())[0].name).toBe('Before') // still cached: a plain query does not clear it
    await deleteDriver('d1') // any mutation
    expect((await listCarriers())[0].name).toBe('After')
  })

  it('a query does not clear the cache', async () => {
    await listCarriers()
    await listUserProfiles()
    expect(reads('listCarriers')).toBe(1)
    expect(reads('listUserProfiles')).toBe(1)
  })

  it('a ManageUsers write (a query operation) refreshes the profile list; a read does not', async () => {
    await listUserProfiles()
    await graphqlMock({ query: 'query ManageUsers($action: String!) { manageUsers(action: $action) }', variables: { action: 'list' } })
    await listUserProfiles()
    expect(reads('listUserProfiles')).toBe(1)
    await setUserTeams('u', ['t'])
    await listUserProfiles()
    expect(reads('listUserProfiles')).toBe(2)
  })

  it('one fetch of customers serves both the active and the archived view', async () => {
    const active = await listCustomers()
    const all = await listCustomers({ includeArchived: true })
    expect(reads('listCustomers')).toBe(1)
    expect(active.map((c) => c.id)).toEqual(['k1'])
    expect(all.map((c) => c.id)).toEqual(['k1', 'k2'])
  })

  it('hands each caller its own array so a sort cannot reorder the cache', async () => {
    customers = [{ id: 'b', status: 'ACTIVE' }, { id: 'a', status: 'ACTIVE' }]
    const first = await listCustomers({ includeArchived: true })
    first.sort((x, y) => x.id.localeCompare(y.id))
    expect((await listCustomers({ includeArchived: true })).map((c) => c.id)).toEqual(['b', 'a'])
  })
})

describe('shared whole-table side lists', () => {
  it('seven mounted hooks cost one request, and a write by this tab drops it', async () => {
    await Promise.all(Array.from({ length: 7 }, () => listDriverPaySettings()))
    await Promise.all(Array.from({ length: 4 }, () => listExpenseTypes()))
    expect(reads('listDriverPaySettings')).toBe(1)
    expect(reads('listExpenseTypes')).toBe(1)
    await deleteDriver('d1')
    await listDriverPaySettings()
    expect(reads('listDriverPaySettings')).toBe(2)
  })
})

describe('window shipment ids', () => {
  it('drop voided shipments server-side by default and keep them when asked', async () => {
    graphqlMock.mockImplementation(async () => ({ data: { listShipmentByPickupMonthAndPickupAppt: { items: [{ id: 's1' }], nextToken: null } } }))
    await listShipmentIdsByMonths(['2026-11'])
    const filtered = graphqlMock.mock.calls.at(-1)![0]
    expect(filtered.query).toContain('filter: $filter')
    expect(filtered.variables.filter).toEqual({ voidedAt: { attributeExists: false } })
    await listShipmentIdsByMonths(['2026-11'], { includeVoided: true })
    const all = graphqlMock.mock.calls.at(-1)![0]
    expect(all.query).not.toContain('filter')
  })
})

describe('read-only router calls', () => {
  it('do not clear the cache, but a write action on the same router does', async () => {
    const { financeAction } = await import('./apiClient')
    await listCarriers()
    graphqlMock.mockImplementationOnce(async () => ({ data: { tmsFinanceActions: '{}' } }))
    await financeAction('PREVIEW_INVOICE', {})
    await listCarriers()
    expect(reads('listCarriers')).toBe(1)
    graphqlMock.mockImplementationOnce(async () => ({ data: { tmsFinanceActions: '{}' } }))
    await financeAction('GENERATE_INVOICE', {})
    await listCarriers()
    expect(reads('listCarriers')).toBe(2)
  })
})

describe('router action classification (every known action)', () => {
  const READS = [
    'SPOT_COUNT', 'SPOT_STATUS', 'SPOT_LIST_REQUESTS', 'SPOT_GET_REQUEST', 'CS_STATUS',
  ]
  const WRITES = [
    'SPOT_OAUTH_START', 'SPOT_OAUTH_FINISH', 'SPOT_CONNECT_SIMULATED', 'SPOT_DISCONNECT', 'SPOT_SET_PAUSED', 'SPOT_PURGE_MINE',
    'SPOT_SAVE_MY_SETTINGS', 'SPOT_POLL_NOW', 'SPOT_ADD_MANUAL', 'SPOT_UPDATE_FIELDS', 'SPOT_SET_CUSTOMER', 'SPOT_SUGGEST_RESPONSE',
    'SPOT_LOG_COPIED', 'SPOT_MARK_SENT', 'SPOT_DISMISS', 'SPOT_MARK_OUTCOME', 'SPOT_SAVE_SETTINGS', 'SPOT_ADMIN_DISCONNECT',
    'SPOT_SIM_INJECT', 'SPOT_SIM_RESET', 'SPOT_SIM_PURGE_TEST',
    'CS_POLL_NOW', 'CS_SAVE_SETTINGS', 'CS_OAUTH_START', 'CS_OAUTH_FINISH', 'CS_DISCONNECT', 'CS_SET_PAUSED',
    'CS_VOICE_ROTATE_SECRET', 'CS_CONNECT_SIMULATED', 'CS_SIM_INJECT_MAIL', 'CS_SIM_INJECT_CALL', 'CS_SIM_RESET', 'CS_SIM_PURGE_TEST',
  ]
  const CRM_READS = ['CRM_GET_ACCOUNT', 'CRM_LIST_ACCOUNTS', 'CRM_LIST_FOLLOWUPS',
    'PREVIEW_DASHBOARD_CHAT', 'PREVIEW_DASHBOARD', 'LIST_DASHBOARDS', 'GET_DASHBOARD', 'GET_DASHBOARD_OPTIONS']
  const CRM_WRITES = ['CRM_ADD_ACTIVITY', 'CRM_ADD_TASK', 'CRM_COMPLETE_TASK', 'CRM_SET_NEXT_STEP', 'CRM_UPSERT_CONTACT', 'CRM_CLAIM_DOMAIN', 'CRM_ASSIGN_OWNER', 'CRM_BACKFILL', 'SAVE_DASHBOARD', 'ARCHIVE_DASHBOARD']

  it.each([
    ...READS.map((a) => ['spot', a, true] as const),
    ...WRITES.map((a) => ['spot', a, false] as const),
    ...CRM_READS.map((a) => ['crm', a, true] as const),
    ...CRM_WRITES.map((a) => ['crm', a, false] as const),
    // Step AG: the router's own table says which actions are reads; the browser's regex must agree.
    ...Object.entries(AP_INBOX_ACTIONS).map(([a, meta]) => ['ap', a, meta.read] as const),
  ])('%s %s: read=%s', async (router, action, isRead) => {
    const { spotAction, crmAction, apInboxAction } = await import('./apiClient')
    await listCarriers()
    const field = router === 'spot' ? 'tmsSpotActions' : router === 'crm' ? 'tmsCrmActions' : 'tmsApInboxActions'
    graphqlMock.mockImplementationOnce(async () => ({ data: { [field]: '{}' } }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (router === 'spot' ? spotAction(action as any, {}) : router === 'crm' ? crmAction(action as any, {}) : apInboxAction(action as any, {}))
    await listCarriers()
    expect(reads('listCarriers')).toBe(isRead ? 1 : 2)
  })
})
