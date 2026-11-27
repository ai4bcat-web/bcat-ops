import { describe, expect, it, vi } from 'vitest'
import { runSquareApi, squareCallAllowed, type SquareApiDeps } from './squareApi'

const TOKEN = 'sandbox-token-SECRET-1'
const CREDS = { sandboxAccessToken: TOKEN, sandboxLocationId: 'LOC-SB', productionAccessToken: 'prod-token-SECRET', productionLocationId: 'LOC-PR' }

function deps(over: { settings?: Record<string, unknown>; creds?: Record<string, string> | null; fetchImpl?: SquareApiDeps['fetchImpl'] } = {}): SquareApiDeps {
  return {
    getIntegrationRow: async () => ({ id: 'SQUARE', settings: { environment: 'SANDBOX', autoShipperInvoicing: true, ...over.settings } }),
    readCredentials: async () => (over.creds === undefined ? CREDS : over.creds),
    fetchImpl: over.fetchImpl,
  }
}

describe('CONTEXT', () => {
  it('answers the environment, location and switches, and never the token', async () => {
    const out = await runSquareApi({ op: 'CONTEXT' }, deps({ settings: { acceptCashApp: true } }))
    expect(out).toEqual({ connected: true, environment: 'SANDBOX', locationId: 'LOC-SB', enabled: true, methods: { bankTransfer: false, cashApp: true } })
    expect(JSON.stringify(out)).not.toContain('SECRET')
  })

  it('follows the active environment', async () => {
    const out = await runSquareApi({ op: 'CONTEXT' }, deps({ settings: { environment: 'PRODUCTION' } }))
    expect(out).toMatchObject({ connected: true, environment: 'PRODUCTION', locationId: 'LOC-PR' })
  })

  it('says what is missing instead of throwing', async () => {
    expect(await runSquareApi({ op: 'CONTEXT' }, deps({ creds: null }))).toMatchObject({ connected: false, environment: 'SANDBOX' })
    expect(String((await runSquareApi({ op: 'CONTEXT' }, deps({ creds: { sandboxAccessToken: TOKEN } }))).reason)).toMatch(/location ID/)
    expect(String((await runSquareApi({ op: 'CONTEXT' }, deps({ settings: { environment: 'PRODUCTION' }, creds: { sandboxAccessToken: TOKEN, sandboxLocationId: 'L' } }))).reason)).toMatch(/not connected for PRODUCTION/)
  })
})

describe('CALL', () => {
  it('reaches only the allowed Square endpoints', () => {
    for (const [m, p] of [['POST', '/v2/customers'], ['POST', '/v2/orders'], ['GET', '/v2/orders/ORD1'], ['POST', '/v2/invoices'], ['GET', '/v2/invoices/INV1'], ['DELETE', '/v2/invoices/INV1?version=3'], ['POST', '/v2/invoices/INV1/publish'], ['POST', '/v2/invoices/INV1/cancel']]) {
      expect(squareCallAllowed(m, p)).toBe(true)
    }
    for (const [m, p] of [['GET', '/v2/payments'], ['POST', '/v2/refunds'], ['DELETE', '/v2/customers/C1'], ['GET', '/v2/locations'], ['GET', '/v2/invoices/../payments'], ['POST', '/v2/invoices/INV1/publish?x=1'], ['PUT', '/v2/orders']]) {
      expect(squareCallAllowed(m, p)).toBe(false)
    }
  })

  it('sends the bearer token to the sandbox host and hands back only the status and body', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ customer: { id: 'C1' } }), { status: 200 }))
    const out = await runSquareApi({ op: 'CALL', method: 'POST', path: '/v2/customers', body: { given_name: 'Pat' } }, deps({ fetchImpl }))
    expect(out).toEqual({ status: 200, json: { customer: { id: 'C1' } } })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://connect.squareupsandbox.com/v2/customers')
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('uses the production host and token only when the environment says production', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    await runSquareApi({ op: 'CALL', method: 'GET', path: '/v2/orders/O1' }, deps({ settings: { environment: 'PRODUCTION' }, fetchImpl }))
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://connect.squareup.com/v2/orders/O1')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer prod-token-SECRET')
  })

  it('scrubs the token out of anything Square says, and out of a network failure', async () => {
    const echo = vi.fn(async () => new Response(JSON.stringify({ errors: [{ code: 'UNAUTHORIZED', detail: `bad token ${TOKEN}` }] }), { status: 401 }))
    const refused = await runSquareApi({ op: 'CALL', method: 'POST', path: '/v2/orders', body: {} }, deps({ fetchImpl: echo }))
    expect(refused.status).toBe(401)
    expect(JSON.stringify(refused)).not.toContain(TOKEN)
    const down = vi.fn(async () => { throw new Error(`socket hang up ${TOKEN}`) })
    const failed = await runSquareApi({ op: 'CALL', method: 'GET', path: '/v2/orders/O1' }, deps({ fetchImpl: down }))
    expect(failed.status).toBe(0)
    expect(JSON.stringify(failed)).not.toContain(TOKEN)
  })

  it('refuses a disallowed call, a body with carrier pay in it, and a call with nothing connected, without calling Square', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    await expect(runSquareApi({ op: 'CALL', method: 'GET', path: '/v2/payments' }, deps({ fetchImpl }))).rejects.toThrow(/not an allowed Square call/)
    await expect(runSquareApi({ op: 'CALL', method: 'POST', path: '/v2/orders', body: { order: { carrierPayCents: 5 } } }, deps({ fetchImpl }))).rejects.toThrow(/carrier pay, cost and margin/)
    await expect(runSquareApi({ op: 'CALL', method: 'POST', path: '/v2/orders', body: {} }, deps({ creds: null, fetchImpl }))).rejects.toThrow(/not connected for SANDBOX/)
    await expect(runSquareApi({ op: 'NOPE' }, deps({ fetchImpl }))).rejects.toThrow(/unknown op/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
