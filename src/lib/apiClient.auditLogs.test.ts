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

describe('listAuditLogsFor', () => {
  const indexRow = (id: string, entityType: string, entityId: string) => ({ id, entityType, entityId, action: 'X', user: 'u', changes: '{"y":2}', createdAt: '2026-11-03T00:00:00.000Z' })

  it('reads each (type, id) through the entity index in one aliased request and parses changes', async () => {
    graphqlMock.mockResolvedValue({ data: {
      a0: { items: [indexRow('1', 'Load', 'l1')], nextToken: null },
      a1: { items: [indexRow('2', 'Shipment', 's1')], nextToken: null },
    } })
    const { listAuditLogsFor } = await import('./apiClient')
    const rows = await listAuditLogsFor([{ entityType: 'Load', entityId: 'l1' }, { entityType: 'Shipment', entityId: 's1' }])
    expect(graphqlMock).toHaveBeenCalledTimes(1)
    expect(graphqlMock.mock.calls[0][0].query).toContain('listAuditLogByEntityTypeAndEntityId(entityType: $k0_0, entityId: { eq: $k0_1 }')
    expect(rows.map((r) => r.id)).toEqual(['1', '2'])
    expect(rows[0].changes).toEqual({ y: 2 })
  })

  it('falls back to the filtered scan when the backend has no entity index, keeping only the asked (type, id) pairs', async () => {
    vi.resetModules()
    graphqlMock.mockReset()
    graphqlMock
      .mockRejectedValueOnce({ errors: [{ message: 'Validation error: Cannot query field "listAuditLogByEntityTypeAndEntityId" on type "Query".' }] })
      .mockResolvedValueOnce({ data: { listAuditLogs: { items: [indexRow('1', 'Load', 'l1'), indexRow('2', 'Shipment', 'l1')], nextToken: null } } })
    const { listAuditLogsFor } = await import('./apiClient')
    const rows = await listAuditLogsFor([{ entityType: 'Load', entityId: 'l1' }])
    expect(rows.map((r) => r.id)).toEqual(['1'])
    // the missing index is remembered: the next call scans straight away
    graphqlMock.mockResolvedValueOnce({ data: { listAuditLogs: { items: [], nextToken: null } } })
    await listAuditLogsFor([{ entityType: 'Load', entityId: 'l2' }])
    expect(graphqlMock.mock.calls[2][0].query).toContain('listAuditLogs(')
  })

  it('rethrows an unrelated failure instead of silently scanning', async () => {
    vi.resetModules()
    graphqlMock.mockReset()
    graphqlMock.mockRejectedValueOnce({ errors: [{ message: 'Unauthorized' }] })
    const { listAuditLogsFor } = await import('./apiClient')
    const outcome = await listAuditLogsFor([{ entityType: 'Load', entityId: 'l1' }]).then(() => 'resolved', (e: unknown) => e)
    expect(outcome).toEqual({ errors: [{ message: 'Unauthorized' }] })
    expect(graphqlMock).toHaveBeenCalledTimes(1) // no fallback scan
  })
})
