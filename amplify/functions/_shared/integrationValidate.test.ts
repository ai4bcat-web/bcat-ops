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
