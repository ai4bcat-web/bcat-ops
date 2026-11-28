/**
 * A DynamoDB scan page stops at 1 MB, so the fuel list has to follow nextToken, and "is this
 * fill already stored" has to compare against every row — a filtered query with limit 1 only
 * ever looked at one arbitrary row (limit applies before the filter).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const graphqlMock = vi.fn()
vi.mock('aws-amplify/data', () => ({ generateClient: () => ({ graphql: graphqlMock }) }))
vi.mock('aws-amplify/storage', () => ({ uploadData: vi.fn(), getUrl: vi.fn(), remove: vi.fn() }))

const { listFuelTransactions, loadStoredFuelKeys } = await import('./apiClient')
const { invalidateLists } = await import('./listCache')

const tx = (id: string, over: Record<string, unknown> = {}) => ({
  id, transactionDate: '2026-11-05', cardNumber: '00031', fuelType: 'ULSD', amount: 723.73, quantity: 113.1, ...over,
})

beforeEach(() => {
  invalidateLists()
  graphqlMock.mockReset()
  graphqlMock.mockImplementation(async ({ variables }: { variables: { nextToken?: string | null } }) => {
    if (!variables?.nextToken) return { data: { listFuelTransactions: { items: [tx('a'), tx('b', { amount: 10 })], nextToken: 'page2' } } }
    return { data: { listFuelTransactions: { items: [tx('c', { amount: 20 })], nextToken: null } } }
  })
})

describe('fuel transaction reads', () => {
  it('follows nextToken so rows past the first page are not lost', async () => {
    const all = await listFuelTransactions()
    expect(all.map((t) => t.id)).toEqual(['a', 'b', 'c'])
    expect(graphqlMock).toHaveBeenCalledTimes(2)
  })

  it('stored keys cover every page and normalise the card, so a re-upload of any stored fill is skipped', async () => {
    const keys = await loadStoredFuelKeys()
    expect(keys.has('2026-11-05|31|ULSD|20|113.1')).toBe(true)
    expect(keys.has('2026-11-05|31|ULSD|723.73|113.1')).toBe(true)
    expect(keys.has('2026-11-05|31|ULSD|99|113.1')).toBe(false)
  })
})
