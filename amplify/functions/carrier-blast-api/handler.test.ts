import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  instantlyFetch,
  paginateItems,
  chunkLeads,
  accountDailySends,
  type InstantlyAccount,
} from './instantly'
import {
  makeReplyId,
  textToHtml,
  daysToReach,
  accountIsOk,
  senderAllowed,
  maxPerMailbox,
  JOBSDONE_RESERVE_PER_MAILBOX,
  DEFAULT_PER_MAILBOX_PER_DAY,
  normalizeAccount,
  emailToReply,
  computeCapacity,
  type CapacityInputAccount,
} from './handler'
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

describe('senderAllowed', () => {
  it('permits warmed jobsdone sending domains', () => {
    expect(senderAllowed('rynebandolik@gojobsdone.com')).toBe(true)
    expect(senderAllowed('ryneb@jobsdonelabs.com')).toBe(true)
  })

  it('NEVER permits a cowtown mailbox — every real cowtown address in the workspace', () => {
    for (const email of [
      'aidensmith@cowtownshipments.com',
      'aidensmith@haulcowtown.com',
      'aidensmith@cowtownfreight.com',
      'aidensmith@cowtowntrucking.com',
      'aidensmith@cowtowntruck.com',
      'aidensmith@cowtownorders.com',
      'aidensmith@cowtownflatbed.com',
      'aidensmith@cowtownlgx.com',
      'aidensmith@cowtownfr8.com',
      'aidensmith@cowtowncarrier.com',
      'aiden@cowtownlgx.com',
      'aiden@cowtowntruck.com',
      'aiden@cowtownfreight.com',
      'aiden@cowtowncarrier.com',
      'aiden@cowtownflatbed.com',
      'aiden@cowtownshipments.com',
      'aiden@cowtowntrucking.com',
      'aiden@cowtownorders.com',
      'aiden@cowtownfr8.com',
      'aiden@haulcowtown.com',
    ]) {
      expect(senderAllowed(email), email).toBe(false)
    }
  })

  it('never permits sidekickmlo or any other unrelated mailbox', () => {
    expect(senderAllowed('charles@sidekickmlo.com')).toBe(false)
    expect(senderAllowed('dennis@bcatcorp.com')).toBe(false)
  })

  it('denies cowtown even if the address also contains jobsdone', () => {
    // The denylist must win over the allowlist, so loosening the allowlist can never leak.
    expect(senderAllowed('jobsdone@cowtownfreight.com')).toBe(false)
    expect(senderAllowed('COWTOWN@GOJOBSDONE.COM')).toBe(false)
  })

  it('keeps a denied mailbox unusable even when it is otherwise perfectly healthy', () => {
    // A cowtown account with status 1, warmup on, score 100 and headroom still cannot send.
    expect(accountIsOk({
      email: 'aiden@cowtowntrucking.com',
      status: 1, warmup_status: 1, daily_limit: 40,
      stat_warmup_score: 100, provider_code: 2, setup_pending: false,
    })).toBe(false)
  })
})

// ── Account normalization ───────────────────────────────────────────────────

describe('accountIsOk', () => {
  const okAccount: InstantlyAccount = {
    email: 'rynebandolik@gojobsdone.com',
    status: 1,
    warmup_status: 1,
    daily_limit: 40,
    stat_warmup_score: 100,
    provider_code: 2,
    setup_pending: false,
  }

  it('accepts a jobsdone mailbox that is active, warmed, and has allowance left', () => {
    expect(accountIsOk(okAccount)).toBe(true)
  })

  it('rejects paused, unwarmed, or still-setting-up mailboxes', () => {
    expect(accountIsOk({ ...okAccount, status: 2 })).toBe(false)
    expect(accountIsOk({ ...okAccount, status: -3 })).toBe(false)
    expect(accountIsOk({ ...okAccount, warmup_status: 0 })).toBe(false)
    expect(accountIsOk({ ...okAccount, setup_pending: true })).toBe(false)
  })

  it('rejects a warmup score below 90', () => {
    expect(accountIsOk({ ...okAccount, stat_warmup_score: 89 })).toBe(false)
    expect(accountIsOk({ ...okAccount, stat_warmup_score: 90 })).toBe(true)
    expect(accountIsOk({ ...okAccount, stat_warmup_score: null })).toBe(false)
  })

  it('rejects mailboxes outside the jobsdone allowlist', () => {
    // Shared workspace also holds cowtown/sidekick mailboxes — never send carrier blasts from them.
    expect(accountIsOk({ ...okAccount, email: 'aiden@cowtowntrucking.com' })).toBe(false)
    expect(accountIsOk({ ...okAccount, email: 'charles@sidekickmlo.com' })).toBe(false)
  })

  it('rejects a mailbox whose whole allowance is inside the JobsDone OS reserve', () => {
    // 25/day is reserved for the engine, so a 25/day mailbox has nothing to spare.
    expect(accountIsOk({ ...okAccount, daily_limit: JOBSDONE_RESERVE_PER_MAILBOX })).toBe(false)
    expect(accountIsOk({ ...okAccount, daily_limit: JOBSDONE_RESERVE_PER_MAILBOX + 1 })).toBe(true)
  })
})

describe('maxPerMailbox', () => {
  it('leaves the JobsDone OS reserve untouched', () => {
    expect(maxPerMailbox({ daily_limit: 40 })).toBe(40 - JOBSDONE_RESERVE_PER_MAILBOX)
    expect(maxPerMailbox({ daily_limit: 10 })).toBe(0)
    expect(maxPerMailbox({ daily_limit: null })).toBe(0)
  })

  it('keeps the default per-mailbox take within the leftover allowance', () => {
    // Guards against someone raising the default above what the reserve permits.
    expect(DEFAULT_PER_MAILBOX_PER_DAY).toBeLessThanOrEqual(maxPerMailbox({ daily_limit: 40 }))
  })
})

describe('normalizeAccount', () => {
  it('maps Instantly fields to the frontend shape', () => {
    const normalized = normalizeAccount({
      email: 'rynebandolik@gojobsdone.com',
      status: 1,
      warmup_status: 1,
      daily_limit: 40,
      stat_warmup_score: 100,
      provider_code: 2,
      setup_pending: false,
    })
    expect(normalized).toEqual({
      email: 'rynebandolik@gojobsdone.com',
      status: 1,
      warmupStatus: 1,
      dailyLimit: 40,
      warmupScore: 100,
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

// ── Live daily-send analytics chunking ──────────────────────────────────────

describe('accountDailySends', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('chunks >15 emails into multiple Instantly analytics fetches and merges sent counts', async () => {
    const emails = Array.from({ length: 18 }, (_, i) => `mbox${i}@gojobsdone.com`)
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        text: async () => '',
        json: async () =>
          emails.slice(0, 15).map((email, i) => ({
            date: '2026-09-11',
            email_account: email,
            sent: i + 1,
          })),
      } as Response)
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        text: async () => '',
        json: async () =>
          emails.slice(15).map((email, i) => ({
            date: '2026-09-11',
            email_account: email,
            sent: (i + 1) * 10,
          })),
      } as Response)
    vi.stubGlobal('fetch', fetchMock)

    const result = await accountDailySends(emails, '2026-09-11')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const urls = fetchMock.mock.calls.map((c) => c[0] as string)
    expect(urls[0]).toContain('mbox0%40gojobsdone.com')
    expect(urls[1]).toContain('mbox15%40gojobsdone.com')
    expect(result['mbox0@gojobsdone.com']).toBe(1)
    expect(result['mbox15@gojobsdone.com']).toBe(10)
    expect(result['mbox16@gojobsdone.com']).toBe(20)
    expect(result['mbox17@gojobsdone.com']).toBe(30)
    expect(Object.keys(result)).toHaveLength(18)
  })

  it('throws when every chunk fails so the caller can fall back', async () => {
    const emails = Array.from({ length: 18 }, (_, i) => `mbox${i}@gojobsdone.com`)
    const fetchMock = vi.fn().mockResolvedValue({
      status: 500,
      ok: false,
      text: async () => 'server error',
    } as Response)
    vi.stubGlobal('fetch', fetchMock)

    const promise = accountDailySends(emails, '2026-09-11')
    promise.catch(() => {})
    await vi.runAllTimersAsync()
    await expect(promise).rejects.toThrow('all')
  })
})

// ── Live capacity arithmetic ────────────────────────────────────────────────

describe('computeCapacity', () => {
  const accounts: CapacityInputAccount[] = [
    { email: 'a@gojobsdone.com', dailyLimit: 40 },
    { email: 'b@gojobsdone.com', dailyLimit: 40 },
  ]

  it('applies the JobsDone reserve when a shared client is active', () => {
    const result = computeCapacity({
      accounts,
      sentToday: {},
      reservePerMailbox: JOBSDONE_RESERVE_PER_MAILBOX,
      sharedClientsActive: 1,
      jobsDoneReachable: true,
      claimedMailboxes: [],
    })
    expect(result.mailboxes).toBe(2)
    expect(result.reservedForJobsDone).toBe(JOBSDONE_RESERVE_PER_MAILBOX * 2)
    expect(result.availableToday).toBe((40 - JOBSDONE_RESERVE_PER_MAILBOX) * 2)
  })

  it('applies the reserve as a fail-safe when JobsDone OS is unreachable', () => {
    const result = computeCapacity({
      accounts,
      sentToday: {},
      reservePerMailbox: JOBSDONE_RESERVE_PER_MAILBOX,
      sharedClientsActive: 0,
      jobsDoneReachable: false,
      claimedMailboxes: [],
    })
    expect(result.reservedForJobsDone).toBe(JOBSDONE_RESERVE_PER_MAILBOX * 2)
    expect(result.availableToday).toBe((40 - JOBSDONE_RESERVE_PER_MAILBOX) * 2)
  })

  it('drops the reserve to 0 when reachable and no shared clients are active', () => {
    const result = computeCapacity({
      accounts,
      sentToday: {},
      reservePerMailbox: JOBSDONE_RESERVE_PER_MAILBOX,
      sharedClientsActive: 0,
      jobsDoneReachable: true,
      claimedMailboxes: [],
    })
    expect(result.reservedForJobsDone).toBe(0)
    expect(result.availableToday).toBe(80)
  })

  it('never returns negative availability for a mailbox already at or over its limit', () => {
    const result = computeCapacity({
      accounts: [{ email: 'a@gojobsdone.com', dailyLimit: 40 }],
      sentToday: { 'a@gojobsdone.com': 40 },
      reservePerMailbox: JOBSDONE_RESERVE_PER_MAILBOX,
      sharedClientsActive: 1,
      jobsDoneReachable: true,
      claimedMailboxes: [],
    })
    expect(result.perMailbox[0].available).toBe(0)
    expect(result.availableToday).toBe(0)

    const over = computeCapacity({
      accounts: [{ email: 'a@gojobsdone.com', dailyLimit: 40 }],
      sentToday: { 'a@gojobsdone.com': 50 },
      reservePerMailbox: JOBSDONE_RESERVE_PER_MAILBOX,
      sharedClientsActive: 1,
      jobsDoneReachable: true,
      claimedMailboxes: [],
    })
    expect(over.perMailbox[0].available).toBe(0)
    expect(over.availableToday).toBe(0)
  })

  it('computes partially-consumed mailbox availability', () => {
    const result = computeCapacity({
      accounts: [{ email: 'a@gojobsdone.com', dailyLimit: 40 }],
      sentToday: { 'a@gojobsdone.com': 4 },
      reservePerMailbox: JOBSDONE_RESERVE_PER_MAILBOX,
      sharedClientsActive: 1,
      jobsDoneReachable: true,
      claimedMailboxes: [],
    })
    expect(result.availableToday).toBe(40 - 4 - JOBSDONE_RESERVE_PER_MAILBOX)
    expect(result.perMailbox[0]).toEqual({
      email: 'a@gojobsdone.com',
      dailyLimit: 40,
      sentToday: 4,
      reserved: JOBSDONE_RESERVE_PER_MAILBOX,
      available: 40 - 4 - JOBSDONE_RESERVE_PER_MAILBOX,
    })
  })

  it('reserves a claimed mailbox even when the client is in DEDICATED mode', () => {
    const result = computeCapacity({
      accounts: [{ email: 'dedicated@gojobsdone.com', dailyLimit: 40 }],
      sentToday: {},
      reservePerMailbox: JOBSDONE_RESERVE_PER_MAILBOX,
      sharedClientsActive: 0,
      jobsDoneReachable: true,
      claimedMailboxes: ['dedicated@gojobsdone.com'],
    })
    expect(result.reservedForJobsDone).toBe(JOBSDONE_RESERVE_PER_MAILBOX)
    expect(result.availableToday).toBe(40 - JOBSDONE_RESERVE_PER_MAILBOX)
  })
})
