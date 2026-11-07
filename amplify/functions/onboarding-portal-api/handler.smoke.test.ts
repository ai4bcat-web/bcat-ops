import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { ddbSend } = vi.hoisted(() => {
  for (const k of [
    'INVITE_TABLE_NAME', 'SIGN_REQ_TABLE_NAME', 'DRIVER_TABLE_NAME', 'TASK_TABLE_NAME',
    'DOC_TABLE_NAME', 'APP_TABLE_NAME', 'AUDIT_TABLE_NAME', 'BUCKET_NAME',
  ]) delete process.env[k]
  return { ddbSend: vi.fn() }
})

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient {}
  return { DynamoDBClient }
})
vi.mock('@aws-sdk/lib-dynamodb', () => {
  class ScanCommand { __type = 'Scan'; input: unknown; constructor(input: unknown) { this.input = input } }
  class PutCommand { __type = 'Put'; input: unknown; constructor(input: unknown) { this.input = input } }
  class UpdateCommand { __type = 'Update'; input: unknown; constructor(input: unknown) { this.input = input } }
  const DynamoDBDocumentClient = { from: () => ({ send: ddbSend }) }
  return { DynamoDBDocumentClient, ScanCommand, PutCommand, UpdateCommand }
})
vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {}
  class PutObjectCommand { input: unknown; constructor(input: unknown) { this.input = input } }
  return { S3Client, PutObjectCommand }
})
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://s3.example.test/signed'),
}))

import { handler } from './handler'

interface Cmd {
  __type: string
  input: { TableName?: string; Key?: unknown; ExpressionAttributeValues?: Record<string, unknown> }
}

const post = (body: unknown) => ({
  body: typeof body === 'string' ? body : JSON.stringify(body),
  requestContext: { http: { method: 'POST', sourceIp: '203.0.113.7' } },
})

const parse = (res: { body: string }): unknown => JSON.parse(res.body)

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('onboarding-portal-api smoke (empty env)', () => {
  it('loads with an empty env and touches no AWS service at import', () => {
    expect(typeof handler).toBe('function')
    expect(ddbSend).not.toHaveBeenCalled()
  })

  it('answers a CORS preflight with 200 and no DB access', async () => {
    const res = await handler({ requestContext: { http: { method: 'OPTIONS' } } })
    expect(res.statusCode).toBe(200)
    expect(ddbSend).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON with 400 Bad JSON', async () => {
    const res = await handler(post('{not json'))
    expect(res.statusCode).toBe(400)
    expect(parse(res)).toEqual({ error: 'Bad JSON' })
    expect(ddbSend).not.toHaveBeenCalled()
  })

  it('rejects a request with no token with 400 Missing token, before any DB read', async () => {
    const res = await handler(post({ action: 'getOnboardingState' }))
    expect(res.statusCode).toBe(400)
    expect(parse(res)).toEqual({ error: 'Missing token' })
    expect(ddbSend).not.toHaveBeenCalled()
  })

  it('rejects an unknown token with 404 Invite not found', async () => {
    ddbSend.mockResolvedValue({ Items: [] })
    const res = await handler(post({ token: 'nope', action: 'getOnboardingState' }))
    expect(res.statusCode).toBe(404)
    expect(parse(res)).toEqual({ error: 'Invite not found' })
  })

  it('rejects a revoked invite with 410', async () => {
    ddbSend.mockResolvedValue({ Items: [{ id: 'i1', driverId: 'd1', token: 't', status: 'REVOKED', expiresAt: '2999-01-01T00:00:00Z' }] })
    const res = await handler(post({ token: 't', action: 'getOnboardingState' }))
    expect(res.statusCode).toBe(410)
    expect(parse(res)).toEqual({ error: 'This link is no longer active' })
  })

  it('rejects an expired invite with 410', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-01T00:00:00Z'))
    ddbSend.mockResolvedValue({ Items: [{ id: 'i1', driverId: 'd1', token: 't', status: 'SENT', expiresAt: '2026-01-01T00:00:00Z' }] })
    const res = await handler(post({ token: 't', action: 'getOnboardingState' }))
    expect(res.statusCode).toBe(410)
    expect(parse(res)).toEqual({ error: 'This link has expired' })
  })

  it('rejects a token over the request budget with 429', async () => {
    ddbSend.mockResolvedValue({ Items: [{ id: 'i1', driverId: 'd1', token: 't', status: 'OPENED', expiresAt: '2999-01-01T00:00:00Z', requestCount: 2001 }] })
    const res = await handler(post({ token: 't', action: 'getOnboardingState' }))
    expect(res.statusCode).toBe(429)
    expect(parse(res)).toEqual({ error: 'Too many requests' })
  })

  it('rejects an unknown action on a valid invite with 400', async () => {
    ddbSend.mockResolvedValue({ Items: [{ id: 'i1', driverId: 'd1', token: 't', status: 'OPENED', expiresAt: '2999-01-01T00:00:00Z' }] })
    const res = await handler(post({ token: 't', action: 'dropTables' }))
    expect(res.statusCode).toBe(400)
    expect(parse(res)).toEqual({ error: 'Unknown action: dropTables' })
  })

  it('returns 500 Internal error (no detail leaked) when the DB fails', async () => {
    ddbSend.mockRejectedValue(new Error('secret table detail'))
    const res = await handler(post({ token: 't', action: 'getOnboardingState' }))
    expect(res.statusCode).toBe(500)
    expect(parse(res)).toEqual({ error: 'Internal error' })
  })

  it('rejects a signGet with no token with 400 Missing token', async () => {
    const res = await handler(post({ action: 'signGet' }))
    expect(res.statusCode).toBe(400)
    expect(parse(res)).toEqual({ error: 'Missing token' })
  })
})

describe('onboarding-portal-api smoke (configured)', () => {
  it('getOnboardingState returns the scoped driver view and marks the invite OPENED', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    vi.stubEnv('INVITE_TABLE_NAME', 'Invite-test')
    vi.stubEnv('DRIVER_TABLE_NAME', 'Driver-test')
    vi.stubEnv('TASK_TABLE_NAME', 'Task-test')
    vi.stubEnv('DOC_TABLE_NAME', 'Doc-test')
    vi.stubEnv('APP_TABLE_NAME', 'App-test')
    vi.stubEnv('AUDIT_TABLE_NAME', 'Audit-test')
    vi.resetModules()
    // Dynamic import: the handler reads its table names at module load, so it must be re-evaluated after stubbing env.
    const mod = await import('./handler')

    const tables: Record<string, Record<string, unknown>[]> = {
      'Invite-test': [{ id: 'i1', driverId: 'd1', email: 'jane@example.test', token: 'tok', status: 'SENT', expiresAt: '2026-02-01T00:00:00Z' }],
      'Driver-test': [{ id: 'd1', name: 'Jane Roe' }],
      'Task-test': [
        { id: 't1', phase: 1, required: true, driverVisible: true, status: 'COMPLETE', requirementKey: 'cdl', label: 'CDL', sortOrder: 1 },
        { id: 't2', phase: 1, required: true, driverVisible: true, status: 'NOT_STARTED', requirementKey: 'mvr', label: 'MVR', sortOrder: 2 },
      ],
      'Doc-test': [],
      'App-test': [],
    }
    ddbSend.mockImplementation(async (cmd: Cmd) => {
      if (cmd.__type === 'Scan') return { Items: tables[String(cmd.input.TableName)] ?? [] }
      return {}
    })

    const res = await mod.handler(post({ token: 'tok', action: 'getOnboardingState' }))
    expect(res.statusCode).toBe(200)
    expect(parse(res)).toMatchObject({
      firstName: 'Jane',
      progressPct: 50,
      currentPhase: 1,
      application: { status: 'DRAFT', draft: null },
    })

    const calls: Cmd[] = ddbSend.mock.calls.map((c: Cmd[]) => c[0])
    const update = calls.find((c) => c.__type === 'Update')
    expect(update?.input.TableName).toBe('Invite-test')
    expect(update?.input.Key).toEqual({ id: 'i1' })
    const values: Record<string, unknown> = update?.input.ExpressionAttributeValues ?? {}
    expect(Object.values(values)).toContain('OPENED')
  })
})
