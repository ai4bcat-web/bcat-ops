/**
 * The directory lists are cached for a minute. That is only safe because every write by this tab
 * clears them: a save followed by a cached read must not show the pre-save row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const graphqlMock = vi.fn()
vi.mock('aws-amplify/data', () => ({ generateClient: () => ({ graphql: graphqlMock }) }))
vi.mock('aws-amplify/storage', () => ({ uploadData: vi.fn(), getUrl: vi.fn(), remove: vi.fn() }))

const { listCarriers, listUserProfiles, listCustomers, deleteDriver, setUserTeams, listDriverPaySettings, listExpenseTypes } = await import('./apiClient')
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
