/**
 * OTR's sign-in now and then answers 400 {"error":"Login Failed"} for valid credentials.
 * 14937 (2026-11-16) reached OTR, then its POD upload signed in again and got that answer;
 * the user's next click always worked. Production uses one host for invoices and documents,
 * so the upload reuses the invoice token, and a Login Failed sign-in is retried once.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OtrClient, OTR_DOC_TYPE, OtrError, isTransientLoginFailure } from './otrClient'

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a])
const V2 = 'https://otr.test/carrier-tms/2'

function client(authAnswers: Array<() => Response>, opts: { uploadBaseUrl?: string } = {}) {
  const calls: string[] = []
  let auth = 0
  const fetchImpl = vi.fn(async (url: unknown) => {
    const href = String(url)
    calls.push(href)
    if (href.endsWith('/auth/token')) {
      const next = authAnswers[Math.min(auth, authAnswers.length - 1)]
      auth++
      return next()
    }
    return new Response(JSON.stringify({ message: 'ok', invoiceId: '26152964' }), { status: 200 })
  })
  const c = new OtrClient({
    baseUrl: V2,
    uploadBaseUrl: opts.uploadBaseUrl,
    clientDot: '547328',
    subscriptionKey: 'k',
    username: 'u',
    password: 'p',
    loginRetryDelayMs: 0,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  })
  return { c, calls }
}

const ok = () => new Response(JSON.stringify({ access_token: 'tok', expires_in: 7200 }), { status: 200 })
const loginFailed = () => new Response('{"error":"Login Failed"}', { status: 400 })

async function uploadTwo(c: OtrClient) {
  await c.uploadDocument({ invoiceId: '26152964', docType: OTR_DOC_TYPE.POD, fileName: 'POD-14937.pdf', contentType: 'application/pdf', file: PDF })
  await c.uploadDocument({ invoiceId: '26152964', docType: OTR_DOC_TYPE.RATE_CONFIRMATION, fileName: 'RateCon-14937.pdf', contentType: 'application/pdf', file: PDF })
}

describe('OTR sign-in', () => {
  it('signs in once for every document when invoices and uploads share a host', async () => {
    const { c, calls } = client([ok], { uploadBaseUrl: V2 })
    await uploadTwo(c)
    expect(calls.filter((u) => u.endsWith('/auth/token'))).toHaveLength(1)
  })

  it('retries a Login Failed sign-in once and the upload goes through', async () => {
    const { c, calls } = client([loginFailed, ok], { uploadBaseUrl: V2 })
    await uploadTwo(c)
    expect(calls.filter((u) => u.endsWith('/auth/token'))).toHaveLength(2)
    expect(calls.filter((u) => u.endsWith('/file-upload'))).toHaveLength(2)
  })

  it('gives up after the one retry', async () => {
    const { c } = client([loginFailed, loginFailed], { uploadBaseUrl: V2 })
    await expect(uploadTwo(c)).rejects.toThrow(/OTR auth failed \(400\)/)
  })

  it('does not retry other auth failures', async () => {
    const { c, calls } = client([() => new Response('{"error":"bad key"}', { status: 401 })], { uploadBaseUrl: V2 })
    await expect(uploadTwo(c)).rejects.toThrow(/OTR auth failed \(401\)/)
    expect(calls.filter((u) => u.endsWith('/auth/token'))).toHaveLength(1)
  })

  it('recognises only the Login Failed 400', () => {
    expect(isTransientLoginFailure(new OtrError('x', 400, '{"error":"Login Failed"}'))).toBe(true)
    expect(isTransientLoginFailure(new OtrError('x', 400, '{"error":"bad"}'))).toBe(false)
    expect(isTransientLoginFailure(new OtrError('x', 401, 'Login Failed'))).toBe(false)
  })
})
