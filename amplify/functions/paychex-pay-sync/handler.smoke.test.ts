import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { send } = vi.hoisted(() => {
  for (const k of ['PAYCHEX_CLIENT_ID', 'PAYCHEX_CLIENT_SECRET', 'PAYCHEX_COMPANY_ID', 'PAY_TABLE_NAME', 'PAYCHEX_API_BASE']) {
    delete process.env[k]
  }
  return { send: vi.fn() }
})

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient {}
  return { DynamoDBClient }
})
vi.mock('@aws-sdk/lib-dynamodb', () => {
  class PutCommand { input: unknown; constructor(input: unknown) { this.input = input } }
  return { DynamoDBDocumentClient: { from: () => ({ send }) }, PutCommand }
})

type Handler = () => Promise<Record<string, unknown>>

const fetchMock = vi.fn()
const ENV_KEYS = ['PAYCHEX_CLIENT_ID', 'PAYCHEX_CLIENT_SECRET', 'PAYCHEX_COMPANY_ID', 'PAY_TABLE_NAME', 'PAYCHEX_API_BASE']
const ENV = {
  PAYCHEX_CLIENT_ID: 'cid',
  PAYCHEX_CLIENT_SECRET: 'csecret',
  PAYCHEX_COMPANY_ID: 'CO1',
  PAY_TABLE_NAME: 'Pay-test',
  PAYCHEX_API_BASE: 'https://paychex.invalid',
}

async function loadHandler(env: Record<string, string> = {}): Promise<Handler> {
  for (const [k, v] of Object.entries(env)) process.env[k] = v
  vi.resetModules()
  const mod = await import('./handler')
  return mod.handler as unknown as Handler
}

const json = (body: unknown, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-03-15T10:00:00.000Z'))
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  send.mockResolvedValue({})
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const k of ENV_KEYS) delete process.env[k]
})

describe('paychex-pay-sync smoke', () => {
  it('loads with empty env and skips as not-configured without any network call', async () => {
    const handler = await loadHandler()
    expect(await handler()).toEqual({ ok: false, skipped: 'not-configured' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('throws the token status when authentication fails', async () => {
    const handler = await loadHandler(ENV)
    fetchMock.mockResolvedValueOnce(json({ error: 'bad' }, 401))
    await expect(handler()).rejects.toThrow(/^Paychex token 401:/)
    expect(send).not.toHaveBeenCalled()
  })

  it('throws when the token response has no access_token', async () => {
    const handler = await loadHandler(ENV)
    fetchMock.mockResolvedValueOnce(json({}))
    await expect(handler()).rejects.toThrow('Paychex token: no access_token in response')
  })

  it('writes nothing when there is no closed pay period', async () => {
    const handler = await loadHandler(ENV)
    fetchMock
      .mockResolvedValueOnce(json({ access_token: 't' }))
      .mockResolvedValueOnce(json({ content: [{ payPeriodId: 'P1', startDate: '2026-03-10', endDate: '2026-03-20' }] }))
    expect(await handler()).toEqual({ ok: true, written: 0 })
    expect(send).not.toHaveBeenCalled()
  })

  it('writes one combined record for the newest closed period using its period total', async () => {
    const handler = await loadHandler(ENV)
    fetchMock
      .mockResolvedValueOnce(json({ access_token: 'tok' }))
      .mockResolvedValueOnce(json({
        content: [
          { payPeriodId: 'P1', startDate: '2026-01-01', endDate: '2026-01-14', cashRequirement: '$100.00' },
          { payPeriodId: 'P2', startDate: '2026-02-01', endDate: '2026-02-14', cashRequirement: '$12,345.67' },
          { payPeriodId: 'P3', startDate: '2026-03-10', endDate: '2026-03-24', cashRequirement: 999 },
        ],
      }))
    const res = await handler()
    expect(res).toEqual({ ok: true, period: '2026-02-01–2026-02-14', total: 12345.67 })

    expect(send).toHaveBeenCalledTimes(1)
    const put = send.mock.calls[0][0] as { input: { TableName: string; Item: Record<string, unknown> } }
    expect(put.input.TableName).toBe('Pay-test')
    expect(put.input.Item).toMatchObject({
      id: 'paychex-combined-LOCAL-2026-02-01',
      __typename: 'DriverPayPeriod',
      driverId: 'fleet-combined:LOCAL',
      periodStart: '2026-02-01',
      periodEnd: '2026-02-14',
      grossPay: 12345.67,
      source: 'PAYCHEX',
    })

    const urls = fetchMock.mock.calls.map((c) => c[0] as string)
    expect(urls).toEqual([
      'https://paychex.invalid/auth/oauth/v2/token',
      'https://paychex.invalid/companies/CO1/payperiods',
    ])
  })

  it('falls back to summing check gross pay when the period has no total', async () => {
    const handler = await loadHandler(ENV)
    fetchMock
      .mockResolvedValueOnce(json({ access_token: 'tok' }))
      .mockResolvedValueOnce(json([{ id: 'P2', start: '2026-02-01', end: '2026-02-14' }]))
      .mockResolvedValueOnce(json({ content: [{ grossPay: 100.1 }, { gross: '200.2' }] }))
    const res = await handler()
    expect(res).toEqual({ ok: true, period: '2026-02-01–2026-02-14', total: 300.3 })
    expect((fetchMock.mock.calls[2][0] as string)).toBe('https://paychex.invalid/companies/CO1/payperiods/P2/checks')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('writes nothing when no positive total can be determined', async () => {
    const handler = await loadHandler(ENV)
    fetchMock
      .mockResolvedValueOnce(json({ access_token: 'tok' }))
      .mockResolvedValueOnce(json([{ id: 'P2', start: '2026-02-01', end: '2026-02-14' }]))
      .mockResolvedValueOnce(json({ content: [] }))
    expect(await handler()).toEqual({ ok: true, written: 0 })
    expect(send).not.toHaveBeenCalled()
  })
})
