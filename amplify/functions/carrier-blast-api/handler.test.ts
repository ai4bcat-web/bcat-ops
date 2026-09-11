import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { instantlyFetch, paginateItems, chunkLeads } from './instantly'
import {
  makeReplyId,
  textToHtml,
  daysToReach,
  accountIsOk,
  normalizeAccount,
  emailToReply,
} from './handler'
import { type InstantlyAccount } from './instantly'
import { headerValue } from '../carrier-blast-webhook/handler'

beforeEach(() => {
  vi.stubEnv('INSTANTLY_API_KEY', 'test-api-key')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ── Lead chunking ───────────────────────────────────────────────────────────

describe('chunkLeads', () => {
  it('splits arrays into chunks of the given size', () => {
    const leads = Array.from({ length: 2500 }, (_, i) => ({ email: `lead${i}@x.com` }))
    const chunks = chunkLeads(leads, 1000)
    expect(chunks).toHaveLength(3)
    expect(chunks[0]).toHaveLength(1000)
    expect(chunks[1]).toHaveLength(1000)
    expect(chunks[2]).toHaveLength(500)
  })

  it('returns one chunk when the array is smaller than the size', () => {
    const chunks = chunkLeads([{ email: 'a@x.com' }], 1000)
    expect(chunks).toHaveLength(1)
  })
})

// ── Plain-text → HTML ───────────────────────────────────────────────────────

describe('textToHtml', () => {
  it('escapes HTML and converts newlines to <br/>', () => {
    expect(textToHtml('Hello <world>\nLine 2')).toBe('Hello &lt;world&gt;<br/>Line 2')
  })

  it('returns an empty string for empty input', () => {
    expect(textToHtml('')).toBe('')
  })
})

// ── Days-to-complete math ───────────────────────────────────────────────────

describe('daysToReach', () => {
  it('returns null for invalid inputs', () => {
    expect(daysToReach(0, 100)).toBeNull()
    expect(daysToReach(100, 0)).toBeNull()
    expect(daysToReach(-5, 100)).toBeNull()
  })

  it('ceils active contacts over daily capacity', () => {
    expect(daysToReach(100, 25)).toBe(4)
    expect(daysToReach(101, 25)).toBe(5)
    expect(daysToReach(50, 50)).toBe(1)
  })
})

// ── Reply identity / event mapping ──────────────────────────────────────────

describe('makeReplyId', () => {
  it('prefixes the Instantly email id', () => {
    expect(makeReplyId('abc-123')).toBe('instantly:abc-123')
  })
})

describe('emailToReply', () => {
  it('maps an Instantly email to a CarrierReply with deterministic id and links', () => {
    const email = {
      id: 'email-1',
      timestamp_email: '2026-09-11T10:00:00.000Z',
      subject: 'Re: Rates',
      from_address_email: 'Carrier@Example.COM ',
      eaccount: 'sender@bcatcorp.com',
      campaign_id: 'instantly-camp-1',
      body: { text: 'Yes we can cover it', html: '<p>Yes</p>' },
      content_preview: 'Yes we can cover it',
      thread_id: 'thread-1',
      is_auto_reply: 1,
    }

    const campaignMap = {
      'instantly-camp-1': { id: 'camp-1', lane: 'IL_IA' as const },
    }
    const contactMap = { 'IL_IA:carrier@example.com': 'contact-1' }

    const reply = emailToReply(email as Parameters<typeof emailToReply>[0], campaignMap, contactMap)

    expect(reply.id).toBe('instantly:email-1')
    expect(reply.instantlyEmailId).toBe('email-1')
    expect(reply.campaignId).toBe('camp-1')
    expect(reply.lane).toBe('IL_IA')
    expect(reply.contactId).toBe('contact-1')
    expect(reply.fromEmail).toBe('carrier@example.com')
    expect(reply.toAccount).toBe('sender@bcatcorp.com')
    expect(reply.isAutoReply).toBe(true)
    expect(reply.status).toBe('open')
    expect(reply.receivedAt).toBe('2026-09-11T10:00:00.000Z')
  })
})

// ── Account normalization ───────────────────────────────────────────────────

describe('accountIsOk', () => {
  it('returns true only for active, warmed-up, fully-set-up accounts', () => {
    const okAccount: InstantlyAccount = {
      email: 'a@b.com',
      status: 1,
      warmup_status: 1,
      daily_limit: 40,
      stat_warmup_score: 95,
      provider_code: 2,
      setup_pending: false,
    }
    expect(accountIsOk(okAccount)).toBe(true)
    expect(accountIsOk({ ...okAccount, status: 2 })).toBe(false)
    expect(accountIsOk({ ...okAccount, warmup_status: 0 })).toBe(false)
    expect(accountIsOk({ ...okAccount, setup_pending: true })).toBe(false)
  })
})

describe('normalizeAccount', () => {
  it('maps Instantly fields to the frontend shape', () => {
    const normalized = normalizeAccount({
      email: 'a@b.com',
      status: 1,
      warmup_status: 1,
      daily_limit: 40,
      stat_warmup_score: 95,
      provider_code: 2,
      setup_pending: false,
    })
    expect(normalized).toEqual({
      email: 'a@b.com',
      status: 1,
      warmupStatus: 1,
      dailyLimit: 40,
      warmupScore: 95,
      provider: 2,
      ok: true,
    })
  })
})

// ── Webhook secret header parsing ───────────────────────────────────────────

describe('headerValue', () => {
  it('reads a single header value', () => {
    expect(headerValue({ 'x-bcat-secret': 'abc' }, 'x-bcat-secret')).toBe('abc')
  })

  it('reads the first value when the header is an array', () => {
    expect(headerValue({ 'x-bcat-secret': ['abc', 'def'] }, 'x-bcat-secret')).toBe('abc')
  })

  it('is case-insensitive', () => {
    expect(headerValue({ 'X-BCAT-SECRET': 'abc' }, 'x-bcat-secret')).toBe('abc')
  })

  it('returns undefined for a missing header', () => {
    expect(headerValue({}, 'x-bcat-secret')).toBeUndefined()
  })
})

// ── Instantly client fetch behavior ─────────────────────────────────────────

describe('instantlyFetch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('retries on 429 and returns the successful response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        status: 429,
        ok: false,
        text: async () => 'rate limited',
      } as Response)
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        text: async () => '',
        json: async () => ({ ok: true }),
      } as Response)
    vi.stubGlobal('fetch', fetchMock)

    const promise = instantlyFetch<{ ok: boolean }>('/api/v2/test')
    await vi.advanceTimersByTimeAsync(5000)
    const result = await promise
    expect(result).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('throws immediately on 401 without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 401,
      ok: false,
      text: async () => 'unauthorized',
    } as Response)
    vi.stubGlobal('fetch', fetchMock)

    await expect(instantlyFetch('/api/v2/test')).rejects.toThrow('401')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('paginateItems', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('follows next_starting_after until exhausted', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        text: async () => '',
        json: async () => ({ items: [{ email: 'a@b.com' }], next_starting_after: 'cursor-1' }),
      } as Response)
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        text: async () => '',
        json: async () => ({ items: [{ email: 'c@d.com' }] }),
      } as Response)
    vi.stubGlobal('fetch', fetchMock)

    const items = await paginateItems<{ email: string }>('/api/v2/accounts', { limit: 100 })
    expect(items).toEqual([{ email: 'a@b.com' }, { email: 'c@d.com' }])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
