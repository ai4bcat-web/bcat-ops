import { describe, it, expect, vi } from 'vitest'
import { validateProvider } from './integrationValidate'
import { descriptorOf } from '../../../src/lib/integrations/registry'
import { healthFrom } from '../../../src/lib/integrations/health'

const gmail = descriptorOf('GMAIL_REP_OAUTH')!
const CREDS = { clientId: 'cid-123', clientSecret: 'csecret-456' }

function fetchAnswering(status: number, body: string) {
  return vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch
}

describe('GOOGLE_OAUTH_CLIENT validation', () => {
  it('reads invalid_grant as a client Google knows', async () => {
    const out = await validateProvider(gmail, CREDS, fetchAnswering(400, '{"error":"invalid_grant"}'))
    expect(healthFrom(out, 'now').status).toBe('OK')
  })

  it('reads invalid_client as wrong credentials', async () => {
    const out = await validateProvider(gmail, CREDS, fetchAnswering(401, '{"error":"invalid_client"}'))
    expect(healthFrom(out, 'now').status).toBe('INVALID_CREDENTIALS')
  })

  it('never claims OK for an answer it does not understand', async () => {
    const out = await validateProvider(gmail, CREDS, fetchAnswering(400, '{"error":"redirect_uri_mismatch"}'))
    expect(healthFrom(out, 'now').status).toBe('UNABLE_TO_VERIFY')
  })

  it('makes no call without both keys', async () => {
    const f = fetchAnswering(200, '{}')
    const out = await validateProvider(gmail, { clientId: 'cid-123' }, f)
    expect(f).not.toHaveBeenCalled()
    expect(out.reason).toBe('NO_CREDENTIALS')
  })
})

describe('SQUARE_LOCATIONS validation', () => {
  const square = descriptorOf('SQUARE')!
  const SANDBOX = { sandboxAccessToken: 'sandbox-token-1', sandboxLocationId: 'LOC1' }

  it('asks the sandbox host with the sandbox token and says OK when the saved location is one of its own', async () => {
    const f = vi.fn(async () => new Response('{"locations":[{"id":"LOC1"}]}', { status: 200 })) as unknown as typeof fetch
    const out = await validateProvider(square, SANDBOX, f)
    expect(healthFrom(out, 'now').status).toBe('OK')
    const [url, init] = (f as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]
    expect(url).toBe('https://connect.squareupsandbox.com/v2/locations')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sandbox-token-1')
  })

  it('refuses a token that sees locations but not the saved one', async () => {
    const f = fetchAnswering(200, '{"locations":[{"id":"OTHER"}]}')
    const out = await validateProvider(square, SANDBOX, f)
    expect(healthFrom(out, 'now').status).not.toBe('OK')
  })

  it('reads a 401 as wrong credentials and never repeats the token in the message', async () => {
    const out = await validateProvider(square, SANDBOX, fetchAnswering(401, '{"errors":[{"detail":"bad token sandbox-token-1"}]}'))
    expect(healthFrom(out, 'now').status).toBe('INVALID_CREDENTIALS')
    expect(JSON.stringify(out)).not.toContain('sandbox-token-1')
  })

  it('checks production too when its token is set, against the production host', async () => {
    const f = vi.fn(async () => new Response('{"locations":[{"id":"LOC1"},{"id":"PROD1"}]}', { status: 200 })) as unknown as typeof fetch
    await validateProvider(square, { ...SANDBOX, productionAccessToken: 'prod-token-1', productionLocationId: 'PROD1' }, f)
    const urls = (f as unknown as { mock: { calls: Array<[string]> } }).mock.calls.map((c) => c[0])
    expect(urls).toEqual(['https://connect.squareupsandbox.com/v2/locations', 'https://connect.squareup.com/v2/locations'])
  })

  it('still checks production when the sandbox location is wrong, and names each environment in the message', async () => {
    const f = vi.fn(async (url: string) =>
      new Response(String(url).includes('sandbox') ? '{"locations":[{"id":"SBX-OTHER"}]}' : '{"locations":[{"id":"PROD1"}]}', { status: 200 })) as unknown as typeof fetch
    const out = await validateProvider(square, { ...SANDBOX, productionAccessToken: 'prod-token-1', productionLocationId: 'PROD1' }, f)
    expect((f as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(2)
    expect(healthFrom(out, 'now').status).not.toBe('OK')
    expect(out.message).toContain('Sandbox: Square accepted the token, but the saved location ID is not one of its locations.')
    expect(out.message).toContain('Production: OK')
    expect(JSON.stringify(out)).not.toContain('prod-token-1')
  })

  it('reports a bad production token while the sandbox passes', async () => {
    const f = vi.fn(async (url: string) =>
      String(url).includes('sandbox') ? new Response('{"locations":[{"id":"LOC1"}]}', { status: 200 }) : new Response('{"errors":[{"detail":"bad prod-token-1"}]}', { status: 401 })) as unknown as typeof fetch
    const out = await validateProvider(square, { ...SANDBOX, productionAccessToken: 'prod-token-1', productionLocationId: 'PROD1' }, f)
    expect(healthFrom(out, 'now').status).toBe('INVALID_CREDENTIALS')
    expect(out.message).toContain('Sandbox: OK')
    expect(out.message).toContain('Production:')
    expect(JSON.stringify(out)).not.toContain('prod-token-1')
  })

  it('makes no call with no token', async () => {
    const f = fetchAnswering(200, '{}')
    const out = await validateProvider(square, {}, f)
    expect(f).not.toHaveBeenCalled()
    expect(out.reason).toBe('NO_CREDENTIALS')
  })
})
