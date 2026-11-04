import { describe, it, expect, vi } from 'vitest'
import { googlePort, stripHtml } from './googlePort'
import { buildAuthUrl, hasRequiredScopes, parseIdToken, redirectUriAllowed } from './oauth'
import { GmailApiError } from './errors'
import { simInject, simPurgeTest, simReset, simPort, type SimS3 } from './simPort'

const res = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })

describe('googlePort transport', () => {
  it('retries 429 twice then succeeds, and gives up after the third', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(res({}, 429))
      .mockResolvedValueOnce(res({}, 503))
      .mockResolvedValueOnce(res({ emailAddress: 'a@b.test', historyId: '7' }))
    const port = googlePort('u', { fetchImpl: f as unknown as typeof fetch, getToken: async () => 't', sleep: async () => undefined })
    expect((await port.profile()).historyId).toBe('7')
    expect(f).toHaveBeenCalledTimes(3)

    const bad = vi.fn(async () => res({}, 500))
    const p2 = googlePort('u', { fetchImpl: bad as unknown as typeof fetch, getToken: async () => 't', sleep: async () => undefined })
    await expect(p2.profile()).rejects.toBeInstanceOf(GmailApiError)
    expect(bad).toHaveBeenCalledTimes(3)
  })

  it('refreshes the token once on 401, not forever', async () => {
    let n = 0
    const getToken = vi.fn(async () => `t${++n}`)
    const f = vi.fn(async (_u: string, init?: RequestInit) =>
      (init?.headers as Record<string, string>).Authorization === 'Bearer t2' ? res({ emailAddress: 'a', historyId: '1' }) : res({}, 401))
    const port = googlePort('u', { fetchImpl: f as unknown as typeof fetch, getToken })
    await port.profile()
    expect(getToken).toHaveBeenCalledTimes(2)

    const always = vi.fn(async () => res({}, 401))
    await expect(googlePort('u', { fetchImpl: always as unknown as typeof fetch, getToken: async () => 't' }).profile()).rejects.toThrow(/401/)
    expect(always).toHaveBeenCalledTimes(2)
  })

  it('treats an expired history id as expired, not an error', async () => {
    const f = vi.fn(async () => res({}, 404))
    const port = googlePort('u', { fetchImpl: f as unknown as typeof fetch, getToken: async () => 't' })
    expect(await port.listSince('1', { label: null, max: 10 })).toEqual({ expired: true })
  })

  it('does not put a Gmail error body into the thrown message', async () => {
    const f = vi.fn(async () => new Response('secret mail text', { status: 400 }))
    const port = googlePort('u', { fetchImpl: f as unknown as typeof fetch, getToken: async () => 't' })
    await expect(port.getMetadata('m')).rejects.not.toThrow(/secret mail text/)
  })
})

describe('googlePort is read-only on the wire', () => {
  it('only ever issues GET requests, across every port method', async () => {
    const methods: string[] = []
    const f = vi.fn(async (_u: string, init?: RequestInit) => {
      methods.push(String(init?.method))
      return res({ emailAddress: 'a', historyId: '1', messages: [], history: [], labels: [], payload: { headers: [] }, id: 'm', threadId: 't' })
    })
    const port = googlePort('u', { fetchImpl: f as unknown as typeof fetch, getToken: async () => 't', sleep: async () => undefined })
    await port.profile()
    await port.listRecent({ lookbackDays: 1, label: 'x', max: 5 })
    await port.listSince('1', { label: null, max: 5 })
    await port.getMetadata('m')
    await port.getBody('m')
    await port.threadMessages('t')
    expect(methods.length).toBeGreaterThan(5)
    expect(new Set(methods)).toEqual(new Set(['GET']))
  })
})

describe('stripHtml', () => {
  it('drops scripts and tags, keeps text', () => {
    expect(stripHtml('<div>Need <b>van</b></div><script>evil()</script><p>Dallas&nbsp;to ATL</p>')).toBe('Need van\nDallas to ATL')
  })
})

describe('oauth helpers', () => {
  it('builds an offline, consent-forcing, own-domain auth URL', () => {
    const u = new URL(buildAuthUrl({ clientId: 'cid', redirectUri: 'https://app.test/tms/rates/spot/callback', state: 's1', loginHint: 'rep@bcatcorp.com', hd: 'bcatcorp.com' }))
    expect(u.searchParams.get('access_type')).toBe('offline')
    expect(u.searchParams.get('prompt')).toBe('consent')
    expect(u.searchParams.get('hd')).toBe('bcatcorp.com')
    expect(u.searchParams.get('scope')).toContain('gmail.readonly')
    expect(u.searchParams.get('state')).toBe('s1')
    // Read-only: no compose, send or modify scope is ever requested.
    expect(u.searchParams.get('scope')).not.toMatch(/compose|send|modify|gmail\.full|mail\.google\.com/)
  })

  it('only accepts the callback path on an allowed origin', () => {
    const origins = ['https://app.test/']
    expect(redirectUriAllowed('https://app.test/tms/rates/spot/callback', origins)).toBe(true)
    expect(redirectUriAllowed('https://evil.test/tms/rates/spot/callback', origins)).toBe(false)
    expect(redirectUriAllowed('https://app.test/other', origins)).toBe(false)
    expect(redirectUriAllowed('https://app.test/tms/rates/spot/callback?x=1', origins)).toBe(false)
  })

  it('requires the read-only Gmail scope and nothing more', () => {
    expect(hasRequiredScopes('openid email')).toBe(false)
    expect(hasRequiredScopes('openid email https://www.googleapis.com/auth/gmail.readonly')).toBe(true)
  })

  it('reads id-token claims lower-cased', () => {
    const p = Buffer.from(JSON.stringify({ email: 'Rep@BCATcorp.com', email_verified: true, hd: 'bcatcorp.com' })).toString('base64url')
    expect(parseIdToken(`h.${p}.s`)).toEqual({ email: 'rep@bcatcorp.com', emailVerified: true, hd: 'bcatcorp.com' })
  })
})

describe('sim store purge', () => {
  it('purgeTest removes only zz- ids; reset removes everything', async () => {
    const m = new Map<string, string>()
    const s3: SimS3 = {
      get: async (k) => m.get(k) ?? null,
      put: async (k, b) => void m.set(k, b),
      del: async (k) => void m.delete(k),
      list: async (p) => [...m.keys()].filter((k) => k.startsWith(p)),
    }
    await simInject('u', { id: 'zz-a', from: 'a@b.test', subject: 's', body: 'b' }, s3)
    await simInject('u', { id: 'real', from: 'a@b.test', subject: 's', body: 'b' }, s3)
    expect(await simPurgeTest('u', s3)).toEqual({ deleted: 1 })
    expect(await simPort('u', s3).listRecent({ lookbackDays: 1, label: null, max: 10 })).toEqual(['real'])
    expect(await simReset('u', s3)).toEqual({ deleted: 1 })
  })
})
