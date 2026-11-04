/**
 * The audit log is a table scan that AppSync returns a page at a time. A read that stops at
 * the first page hands the History tab an arbitrary slice, so a recent audit row (a driver
 * change, a void) goes missing once the table is big.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const graphqlMock = vi.fn()
vi.mock('aws-amplify/data', () => ({ generateClient: () => ({ graphql: graphqlMock }) }))
vi.mock('aws-amplify/storage', () => ({ uploadData: vi.fn(), getUrl: vi.fn(), remove: vi.fn() }))

const { listAuditLogs } = await import('./apiClient')

const row = (id: string, entityId: string) => ({
  id, entityType: 'LOAD', entityId, action: 'CHANGE_ASSET_DRIVER', user: 'a@b.c', changes: '{"x":1}', createdAt: '2026-11-03T00:00:00.000Z',
})

beforeEach(() => graphqlMock.mockReset())

describe('listAuditLogs', () => {
  it('follows nextToken until the last page and parses each row', async () => {
    graphqlMock
      .mockResolvedValueOnce({ data: { listAuditLogs: { items: [row('1', 'e1')], nextToken: 'p2' } } })
      .mockResolvedValueOnce({ data: { listAuditLogs: { items: [row('2', 'e2')], nextToken: null } } })
    const rows = await listAuditLogs()
    expect(rows.map((r) => r.id)).toEqual(['1', '2'])
    expect(rows[0].changes).toEqual({ x: 1 })
    expect(graphqlMock.mock.calls[1][0].variables.nextToken).toBe('p2')
  })

  it('narrows to the given entity ids on the server', async () => {
    graphqlMock.mockResolvedValue({ data: { listAuditLogs: { items: [], nextToken: null } } })
    await listAuditLogs(['e1', 'e2'])
    expect(graphqlMock.mock.calls[0][0].variables.filter).toEqual({ or: [{ entityId: { eq: 'e1' } }, { entityId: { eq: 'e2' } }] })
  })
})
