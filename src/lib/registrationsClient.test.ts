import { beforeEach, describe, expect, it, vi } from 'vitest'

const graphql = vi.hoisted(() => vi.fn())
vi.mock('aws-amplify/data', () => ({ generateClient: () => ({ graphql }) }))

import { invalidateLists } from './listCache'
import {
  SignupAuditNeedsScanError,
  dismissDriverSignup,
  listDriverSignupAudit,
  listDriverSignupAuditScan,
  signupAuditNeedsScan,
} from './registrationsClient'

const row = (id: string) => ({ id, entityType: 'DRIVER_SIGNUP', entityId: `${id}@x.com`, action: 'SIGNUP_REFUSED', user: 'u', changes: '{}', createdAt: '2026-11-01T00:00:00Z' })

beforeEach(() => {
  graphql.mockReset()
  invalidateLists()
})

describe('driver sign-up audit', () => {
  it('without the AuditLog index it refuses to scan on its own, and the explicit scan still finds the rows', async () => {
    graphql.mockRejectedValueOnce({ errors: [{ message: 'Cannot query field "listAuditLogByEntityTypeAndEntityId" on type "Query".' }] })
    await expect(listDriverSignupAudit()).rejects.toBeInstanceOf(SignupAuditNeedsScanError)
    expect(signupAuditNeedsScan()).toBe(true)
    // Remembered: no second request is spent finding out again.
    await expect(listDriverSignupAudit()).rejects.toBeInstanceOf(SignupAuditNeedsScanError)
    expect(graphql).toHaveBeenCalledTimes(1)

    // The scan filters AFTER each page, so an empty first page must not end the read.
    graphql
      .mockResolvedValueOnce({ data: { listAuditLogs: { items: [], nextToken: 't1' } } })
      .mockResolvedValueOnce({ data: { listAuditLogs: { items: [row('a')], nextToken: null } } })
    const rows = await listDriverSignupAuditScan()
    expect(rows.map((r) => r.id)).toEqual(['a'])
    expect(graphql).toHaveBeenCalledTimes(3)
  })

  it('a dismissal clears the cached scan so the next read sees it', async () => {
    graphql.mockResolvedValueOnce({ data: { listAuditLogs: { items: [row('a')], nextToken: null } } })
    expect(await listDriverSignupAuditScan()).toHaveLength(1)
    expect(await listDriverSignupAuditScan()).toHaveLength(1)
    expect(graphql).toHaveBeenCalledTimes(1)

    graphql.mockResolvedValueOnce({ data: { createAuditLog: { id: 'n' } } })
    await dismissDriverSignup('a@x.com', 'ops')
    graphql.mockResolvedValueOnce({ data: { listAuditLogs: { items: [row('a'), row('b')], nextToken: null } } })
    expect(await listDriverSignupAuditScan()).toHaveLength(2)
  })
})
