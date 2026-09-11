import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  instantlyFetch,
  paginateItems,
  chunkLeads,
  accountDailySends,
  accountDailySendsRange,
  type InstantlyAccount,
} from './instantly'
import {
  makeReplyId,
  textToHtml,
  daysToReach,
  accountIsOk,
  senderAllowed,
  maxPerMailbox,
  JOBSDONE_MIN_RESERVE_PER_MAILBOX,
  JOBSDONE_PEAK_WINDOW_DAYS,
  DEFAULT_PER_MAILBOX_PER_DAY,
  jobsDonePeakReserve,
  normalizeAccount,
  emailToReply,
  computeCapacity,
  handler,
  type CapacityInputAccount,
} from './handler'
import { headerValue } from '../carrier-blast-webhook/handler'

const mockDdbSend = vi.hoisted(() => vi.fn())
const mockLambdaSend = vi.hoisted(() => vi.fn())

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: function DynamoDBClient() {
    return {}
  },
}))

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: function () {
      return { send: mockDdbSend }
    },
  },
  ScanCommand: function (cmd: unknown) {
    return cmd
  },
  GetCommand: function (cmd: unknown) {
    return cmd
  },
  PutCommand: function (cmd: unknown) {
    return cmd
  },
  UpdateCommand: function (cmd: unknown) {
    return cmd
  },
}))

vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: function LambdaClient() {
    return { send: mockLambdaSend }
  },
  InvokeCommand: function (cmd: unknown) {
    return cmd
  },
}))

vi.mock('@aws-sdk/credential-provider-node', () => ({
  defaultProvider: vi.fn(() => async () => ({
    accessKeyId: 'test',
    secretAccessKey: 'test',
    sessionToken: 'test',
  })),
}))

vi.mock('@aws-crypto/sha256-js', () => ({
  Sha256: class Sha256 {},
}))

vi.mock('@smithy/protocol-http', () => ({
  HttpRequest: class HttpRequest {
    constructor(public options: Record<string, unknown>) {}
  },
}))

vi.mock('@smithy/signature-v4', () => ({
  SignatureV4: class SignatureV4 {
    async sign(req: unknown) {
      return req
    }
  },
}))

beforeEach(() => {
  vi.stubEnv('INSTANTLY_API_KEY', 'test-api-key')
  vi.stubEnv('CONTACT_TABLE', 'CarrierContact')
  vi.stubEnv('CAMPAIGN_TABLE', 'CarrierCampaign')
  vi.stubEnv('REPLY_TABLE', 'CarrierReply')
  vi.stubEnv('CAPACITY_SNAPSHOT_TABLE', 'CarrierCapacitySnapshot')
  vi.stubEnv('JOBSDONE_GRAPHQL_URL', 'https://jobsdone.example.com/graphql')
  vi.stubEnv('AWS_REGION', 'us-east-1')
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
    expect(accountIsOk({ ...okAccount, daily_limit: JOBSDONE_MIN_RESERVE_PER_MAILBOX })).toBe(false)
    expect(accountIsOk({ ...okAccount, daily_limit: JOBSDONE_MIN_RESERVE_PER_MAILBOX + 1 })).toBe(true)
  })
})

describe('maxPerMailbox', () => {
  it('leaves the JobsDone OS reserve untouched', () => {
    expect(maxPerMailbox({ daily_limit: 40 })).toBe(40 - JOBSDONE_MIN_RESERVE_PER_MAILBOX)
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

// ── Peak-demand reserve helper ──────────────────────────────────────────────

describe('jobsDonePeakReserve', () => {
  it('uses the observed peak when it is above the floor and below the daily limit', () => {
    expect(jobsDonePeakReserve({
      history: { '2026-09-10': 27, '2026-09-09': 4 },
      dailyLimit: 40,
      minReserve: JOBSDONE_MIN_RESERVE_PER_MAILBOX,
    })).toBe(27)
  })

  it('falls back to the floor when the observed peak is lower', () => {
    expect(jobsDonePeakReserve({
      history: { '2026-09-10': 8 },
      dailyLimit: 40,
      minReserve: JOBSDONE_MIN_RESERVE_PER_MAILBOX,
    })).toBe(JOBSDONE_MIN_RESERVE_PER_MAILBOX)
  })

  it('never reserves more than the mailbox daily limit', () => {
    expect(jobsDonePeakReserve({
      history: { '2026-09-10': 45 },
      dailyLimit: 40,
      minReserve: JOBSDONE_MIN_RESERVE_PER_MAILBOX,
    })).toBe(40)
  })

  it('uses the floor when history is empty', () => {
    expect(jobsDonePeakReserve({
      history: {},
      dailyLimit: 40,
      minReserve: JOBSDONE_MIN_RESERVE_PER_MAILBOX,
    })).toBe(JOBSDONE_MIN_RESERVE_PER_MAILBOX)
  })

  it('excludes today from the peak calculation', () => {
    expect(jobsDonePeakReserve({
      history: { '2026-09-11': 35, '2026-09-10': 27 },
      dailyLimit: 40,
      minReserve: JOBSDONE_MIN_RESERVE_PER_MAILBOX,
      today: '2026-09-11',
    })).toBe(27)
  })
})

// ── Range daily-send analytics chunking ─────────────────────────────────────

describe('accountDailySendsRange', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('chunks >15 emails and returns a nested date map', async () => {
    const emails = Array.from({ length: 18 }, (_, i) => `mbox${i}@gojobsdone.com`)
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        text: async () => '',
        json: async () =>
          emails.slice(0, 15).map((email) => ({
            date: '2026-09-10',
            email_account: email,
            sent: 2,
          })),
      } as Response)
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        text: async () => '',
        json: async () =>
          emails.slice(15).map((email) => ({
            date: '2026-09-09',
            email_account: email,
            sent: 3,
          })),
      } as Response)
    vi.stubGlobal('fetch', fetchMock)

    const result = await accountDailySendsRange(emails, '2026-09-09', '2026-09-10')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result['mbox0@gojobsdone.com']).toEqual({ '2026-09-10': 2 })
    expect(result['mbox15@gojobsdone.com']).toEqual({ '2026-09-09': 3 })
  })

  it('throws when every chunk fails', async () => {
    const emails = Array.from({ length: 18 }, (_, i) => `mbox${i}@gojobsdone.com`)
    const fetchMock = vi.fn().mockResolvedValue({
      status: 500,
      ok: false,
      text: async () => 'server error',
    } as Response)
    vi.stubGlobal('fetch', fetchMock)

    const promise = accountDailySendsRange(emails, '2026-09-09', '2026-09-10')
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

  it('holds the JobsDone reserve unconditionally regardless of reachability or shared clients', () => {
    const withShared = computeCapacity({
      accounts,
      sentToday: {},
      reservePerMailbox: JOBSDONE_MIN_RESERVE_PER_MAILBOX,
      claimedMailboxes: [],
    })
    expect(withShared.reservedForJobsDone).toBe(JOBSDONE_MIN_RESERVE_PER_MAILBOX * 2)
    expect(withShared.availableToday).toBe((40 - JOBSDONE_MIN_RESERVE_PER_MAILBOX) * 2)

    const unreachable = computeCapacity({
      accounts,
      sentToday: {},
      reservePerMailbox: JOBSDONE_MIN_RESERVE_PER_MAILBOX,
      claimedMailboxes: [],
    })
    expect(unreachable.reservedForJobsDone).toBe(JOBSDONE_MIN_RESERVE_PER_MAILBOX * 2)
    expect(unreachable.availableToday).toBe((40 - JOBSDONE_MIN_RESERVE_PER_MAILBOX) * 2)
  })

  it('never releases the reserve when reachable with no active shared clients', () => {
    const result = computeCapacity({
      accounts,
      sentToday: {},
      reservePerMailbox: JOBSDONE_MIN_RESERVE_PER_MAILBOX,
      claimedMailboxes: [],
    })
    expect(result.reservedForJobsDone).toBe(JOBSDONE_MIN_RESERVE_PER_MAILBOX * 2)
    expect(result.availableToday).toBe((40 - JOBSDONE_MIN_RESERVE_PER_MAILBOX) * 2)
  })

  it('never returns negative availability for a mailbox already at or over its limit', () => {
    const result = computeCapacity({
      accounts: [{ email: 'a@gojobsdone.com', dailyLimit: 40 }],
      sentToday: { 'a@gojobsdone.com': 40 },
      reservePerMailbox: JOBSDONE_MIN_RESERVE_PER_MAILBOX,
      claimedMailboxes: [],
    })
    expect(result.perMailbox[0].available).toBe(0)
    expect(result.availableToday).toBe(0)

    const over = computeCapacity({
      accounts: [{ email: 'a@gojobsdone.com', dailyLimit: 40 }],
      sentToday: { 'a@gojobsdone.com': 50 },
      reservePerMailbox: JOBSDONE_MIN_RESERVE_PER_MAILBOX,
      claimedMailboxes: [],
    })
    expect(over.perMailbox[0].available).toBe(0)
    expect(over.availableToday).toBe(0)
  })

  // Correction 1 sanity checks
  it('gives 15 leftover when jobsDone uses 4 of a 25 reserve and carriers have sent 0', () => {
    const result = computeCapacity({
      accounts: [{ email: 'm@gojobsdone.com', dailyLimit: 40 }],
      sentToday: { 'm@gojobsdone.com': 4 },
      reservePerMailbox: JOBSDONE_MIN_RESERVE_PER_MAILBOX,
      claimedMailboxes: [],
    })
    expect(result.perMailbox[0].available).toBe(15)
    expect(result.carrierSentToday).toBe(0)
  })

  it('gives 0 availability after carriers send the 15 leftover', () => {
    const result = computeCapacity({
      accounts: [{ email: 'm@gojobsdone.com', dailyLimit: 40 }],
      sentToday: { 'm@gojobsdone.com': 19 }, // 4 JobsDone + 15 carrier
      reservePerMailbox: JOBSDONE_MIN_RESERVE_PER_MAILBOX,
      claimedMailboxes: [],
      carrierSent: { 'm@gojobsdone.com': 15 },
    })
    expect(result.perMailbox[0].carrierSent).toBe(15)
    expect(result.perMailbox[0].available).toBe(0)
  })

  it('gives 10 availability when JobsDone ramps past the reserve to 30 sends', () => {
    const result = computeCapacity({
      accounts: [{ email: 'm@gojobsdone.com', dailyLimit: 40 }],
      sentToday: { 'm@gojobsdone.com': 30 },
      reservePerMailbox: JOBSDONE_MIN_RESERVE_PER_MAILBOX,
      claimedMailboxes: [],
    })
    expect(result.perMailbox[0].available).toBe(10)
  })

  it('never goes negative when jobsDone sends have consumed the whole daily limit', () => {
    const result = computeCapacity({
      accounts: [{ email: 'm@gojobsdone.com', dailyLimit: 40 }],
      sentToday: { 'm@gojobsdone.com': 40 },
      reservePerMailbox: JOBSDONE_MIN_RESERVE_PER_MAILBOX,
      claimedMailboxes: [],
    })
    expect(result.perMailbox[0].available).toBe(0)
    expect(result.availableToday).toBe(0)
  })

  it('computes carrier sends separately from JobsDone sends', () => {
    const result = computeCapacity({
      accounts: [{ email: 'a@gojobsdone.com', dailyLimit: 40 }],
      sentToday: { 'a@gojobsdone.com': 20 }, // 8 JobsDone + 12 carrier
      reservePerMailbox: JOBSDONE_MIN_RESERVE_PER_MAILBOX,
      claimedMailboxes: [],
      carrierSent: { 'a@gojobsdone.com': 12 },
    })
    expect(result.perMailbox[0].sentToday).toBe(20)
    expect(result.perMailbox[0].carrierSent).toBe(12)
    expect(result.carrierSentToday).toBe(12)
    expect(result.perMailbox[0].available).toBe(40 - Math.max(25, 8) - 12)
  })

  it('computes partially-consumed mailbox availability', () => {
    const result = computeCapacity({
      accounts: [{ email: 'a@gojobsdone.com', dailyLimit: 40 }],
      sentToday: { 'a@gojobsdone.com': 4 },
      reservePerMailbox: JOBSDONE_MIN_RESERVE_PER_MAILBOX,
      claimedMailboxes: [],
    })
    // 40 - max(25,4) = 35; the 4 JobsDone sends are inside the reserve.
    expect(result.availableToday).toBe(40 - JOBSDONE_MIN_RESERVE_PER_MAILBOX)
    expect(result.perMailbox[0]).toEqual({
      email: 'a@gojobsdone.com',
      dailyLimit: 40,
      sentToday: 4,
      carrierSent: 0,
      reserved: JOBSDONE_MIN_RESERVE_PER_MAILBOX,
      available: 40 - JOBSDONE_MIN_RESERVE_PER_MAILBOX,
      peakObserved: 0,
    })
    expect(result.reserveBasis).toBe('static-floor')
    expect(result.windowDays).toBe(JOBSDONE_PEAK_WINDOW_DAYS)
  })

  it('reserves a dedicated/claimed mailbox at its full daily limit', () => {
    const result = computeCapacity({
      accounts: [{ email: 'dedicated@gojobsdone.com', dailyLimit: 40 }],
      sentToday: {},
      reservePerMailbox: JOBSDONE_MIN_RESERVE_PER_MAILBOX,
      claimedMailboxes: ['dedicated@gojobsdone.com'],
    })
    expect(result.reservedForJobsDone).toBe(40)
    expect(result.availableToday).toBe(0)
  })

  it('uses measured peak reserve when history is provided', () => {
    const result = computeCapacity({
      accounts: [{ email: 'a@gojobsdone.com', dailyLimit: 40 }],
      sentToday: { 'a@gojobsdone.com': 4 },
      reservePerMailbox: JOBSDONE_MIN_RESERVE_PER_MAILBOX,
      claimedMailboxes: [],
      history: { 'a@gojobsdone.com': { '2026-09-10': 27, '2026-09-09': 8 } },
      today: '2026-09-11',
    })
    expect(result.perMailbox[0].reserved).toBe(27)
    expect(result.perMailbox[0].peakObserved).toBe(27)
    // reserve 27 > jobsDoneSent 4, so availability = 40 - 27 = 13
    expect(result.availableToday).toBe(40 - 27)
    expect(result.reserveBasis).toBe('measured-peak')
    expect(result.peakPerMailbox).toBe(27)
  })

  it('falls back to the floor when the measured peak is below it', () => {
    const result = computeCapacity({
      accounts: [{ email: 'a@gojobsdone.com', dailyLimit: 40 }],
      sentToday: {},
      reservePerMailbox: JOBSDONE_MIN_RESERVE_PER_MAILBOX,
      claimedMailboxes: [],
      history: { 'a@gojobsdone.com': { '2026-09-10': 8 } },
      today: '2026-09-11',
    })
    expect(result.perMailbox[0].reserved).toBe(JOBSDONE_MIN_RESERVE_PER_MAILBOX)
    expect(result.perMailbox[0].peakObserved).toBe(8)
    expect(result.reserveBasis).toBe('measured-peak')
  })

  it('caps the reserve at the mailbox daily limit and never goes negative', () => {
    const result = computeCapacity({
      accounts: [{ email: 'a@gojobsdone.com', dailyLimit: 40 }],
      sentToday: {},
      reservePerMailbox: JOBSDONE_MIN_RESERVE_PER_MAILBOX,
      claimedMailboxes: [],
      history: { 'a@gojobsdone.com': { '2026-09-10': 45 } },
      today: '2026-09-11',
    })
    expect(result.perMailbox[0].reserved).toBe(40)
    expect(result.perMailbox[0].available).toBe(0)
    expect(result.availableToday).toBe(0)
  })

  it('uses the static floor when history is empty', () => {
    const result = computeCapacity({
      accounts: [{ email: 'a@gojobsdone.com', dailyLimit: 40 }],
      sentToday: {},
      reservePerMailbox: JOBSDONE_MIN_RESERVE_PER_MAILBOX,
      claimedMailboxes: [],
      history: {},
      today: '2026-09-11',
    })
    expect(result.perMailbox[0].reserved).toBe(JOBSDONE_MIN_RESERVE_PER_MAILBOX)
    expect(result.reserveBasis).toBe('static-floor')
  })

  it('excludes today from the measured peak', () => {
    const result = computeCapacity({
      accounts: [{ email: 'a@gojobsdone.com', dailyLimit: 40 }],
      sentToday: { 'a@gojobsdone.com': 30 },
      reservePerMailbox: JOBSDONE_MIN_RESERVE_PER_MAILBOX,
      claimedMailboxes: [],
      history: { 'a@gojobsdone.com': { '2026-09-11': 35, '2026-09-10': 12 } },
      today: '2026-09-11',
    })
    expect(result.perMailbox[0].peakObserved).toBe(12)
    expect(result.perMailbox[0].reserved).toBe(JOBSDONE_MIN_RESERVE_PER_MAILBOX)
  })
})

describe('capacity is scoped to the selected mailboxes', () => {
  // Regression: capacity was measured over the whole 61-mailbox pool while the campaign
  // only sent from the selected mailboxes, so a 2-mailbox selection could borrow the
  // other 59 mailboxes' headroom and overdraw the two it actually used.
  const mk = (email: string) => ({ email, dailyLimit: 40, ok: true })
  const pool = [mk('a@gojobsdone.com'), mk('b@gojobsdone.com'), mk('c@gojobsdone.com'), mk('d@gojobsdone.com')]
  const sentToday = {
    'a@gojobsdone.com': 4, 'b@gojobsdone.com': 4,
    'c@gojobsdone.com': 0, 'd@gojobsdone.com': 0,
  }
  const opts = { sentToday, reservePerMailbox: 25, claimedMailboxes: [] }

  it('reports only the selected mailboxes headroom, not the pool total', () => {
    const selected = pool.slice(0, 2)
    const scoped = computeCapacity({ ...opts, accounts: selected })
    // each selected mailbox: 40 - max(25 reserve, 4 JobsDone sent) = 15 -> 30 total
    expect(scoped.availableToday).toBe(30)

    const poolWide = computeCapacity({ ...opts, accounts: pool })
    expect(poolWide.availableToday).toBe(60)
    expect(scoped.availableToday).toBeLessThan(poolWide.availableToday)
  })

  it('binds the campaign limit so two mailboxes cannot send the pool-wide figure', () => {
    const selected = pool.slice(0, 2)
    const scoped = computeCapacity({ ...opts, accounts: selected })
    const perMailbox = 15
    const requested = perMailbox * selected.length // 30
    // The cap must bite: 30 available, not the 30 the selection would otherwise allow.
    expect(Math.min(requested, scoped.availableToday)).toBe(30)
  })

  it('measures peak reserve only over the selected mailboxes', () => {
    const history = {
      'a@gojobsdone.com': { '2026-09-10': 30 },
      'b@gojobsdone.com': { '2026-09-10': 30 },
      'c@gojobsdone.com': { '2026-09-10': 30 },
      'd@gojobsdone.com': { '2026-09-10': 30 },
    }
    const selected = pool.slice(0, 2)
    const scoped = computeCapacity({ ...opts, accounts: selected, history, today: '2026-09-11' })
    expect(scoped.reservedForJobsDone).toBe(30 * 2)
    expect(scoped.peakPerMailbox).toBe(30)

    const poolWide = computeCapacity({ ...opts, accounts: pool, history, today: '2026-09-11' })
    expect(poolWide.reservedForJobsDone).toBe(30 * 4)
    expect(scoped.reservedForJobsDone).toBeLessThan(poolWide.reservedForJobsDone)
  })
})

// ── Capacity caching & launch live-recompute ───────────────────────────────

describe('capacity action caching', () => {
  const okAccount: InstantlyAccount = {
    email: 'a@gojobsdone.com',
    status: 1,
    warmup_status: 1,
    daily_limit: 40,
    stat_warmup_score: 100,
    provider_code: 2,
    setup_pending: false,
  }

  function makeResponse(body: unknown): Response {
    const text = JSON.stringify(body)
    return {
      status: 200,
      ok: true,
      text: async () => text,
      json: async () => body,
    } as Response
  }

  function makeSnapshot(overrides: Partial<{
    cachedAt: string
    stale: boolean
    availableToday: number
    sentToday: number
  }> = {}): Record<string, unknown> {
    const cachedAt = overrides.cachedAt ?? new Date().toISOString()
    const stale = overrides.stale ?? false
    const payload = {
      snapshotId: 'current',
      asOf: cachedAt,
      cachedAt,
      stale,
      date: '2026-09-11',
      mailboxes: 1,
      perMailboxLimit: 40,
      sentToday: overrides.sentToday ?? 0,
      carrierSentToday: 0,
      reservedForJobsDone: 25,
      availableToday: overrides.availableToday ?? 15,
      perMailbox: [{
        email: 'a@gojobsdone.com',
        dailyLimit: 40,
        sentToday: overrides.sentToday ?? 0,
        carrierSent: 0,
        reserved: 25,
        available: overrides.availableToday ?? 15,
        peakObserved: 0,
      }],
      reserveBasis: 'static-floor',
      peakPerMailbox: 0,
      windowDays: JOBSDONE_PEAK_WINDOW_DAYS,
      jobsDone: { reachable: true, sharedClientsActive: 0, source: 'unconditional-reserve' },
    }
    return { snapshotId: 'current', cachedAt, stale, data: JSON.stringify(payload) }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-09-11T12:00:00.000Z')
    mockDdbSend.mockReset()
    mockLambdaSend.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns a fresh cached snapshot without calling Instantly', async () => {
    const snapshot = makeSnapshot({ availableToday: 999 })
    mockDdbSend.mockImplementation((cmd: { TableName?: string; Key?: Record<string, unknown> }) => {
      if (cmd.TableName === 'CarrierCapacitySnapshot' && cmd.Key?.snapshotId === 'current') {
        return { Item: snapshot }
      }
      return {}
    })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const res = (await handler({ arguments: { action: 'capacity' } })) as Record<string, unknown>

    expect(res.ok).toBe(true)
    expect(res.availableToday).toBe(999)
    expect(res.stale).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('recomputes live when refresh=true even if cache is fresh', async () => {
    const snapshot = makeSnapshot({ availableToday: 999 })
    mockDdbSend.mockImplementation((cmd: { TableName?: string; Key?: Record<string, unknown> }) => {
      if (cmd.TableName === 'CarrierCapacitySnapshot' && cmd.Key?.snapshotId === 'current') {
        return { Item: snapshot }
      }
      if (cmd.TableName === 'CarrierCapacitySnapshot') {
        return { Items: [], LastEvaluatedKey: undefined }
      }
      return {}
    })

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/api/v2/accounts') && !url.includes('/analytics')) {
        return makeResponse({ items: [okAccount] })
      }
      if (url.includes('/api/v2/accounts/analytics/daily')) {
        return makeResponse([{ email_account: 'a@gojobsdone.com', date: '2026-09-11', sent: 4 }])
      }
      if (url.includes('/graphql')) {
        return makeResponse({ data: { listClients: { items: [] } } })
      }
      return makeResponse({})
    })
    vi.stubGlobal('fetch', fetchMock)

    const res = (await handler({
      arguments: { action: 'capacity', payload: { refresh: true } },
    })) as Record<string, unknown>

    expect(res.ok).toBe(true)
    expect(res.availableToday).toBe(15) // not the cached 999
    expect(res.stale).toBe(false)
    expect(fetchMock).toHaveBeenCalled()
    const accountFetch = fetchMock.mock.calls.find((c) =>
      typeof c[0] === 'string' && c[0].includes('/api/v2/accounts') && !c[0].includes('/analytics'),
    )
    expect(accountFetch).toBeTruthy()
  })

  it('falls back to stale snapshot when live recompute fails', async () => {
    const snapshot = makeSnapshot({ availableToday: 999, cachedAt: '2026-09-11T10:00:00.000Z', stale: false })
    mockDdbSend.mockImplementation((cmd: { TableName?: string; Key?: Record<string, unknown> }) => {
      if (cmd.TableName === 'CarrierCapacitySnapshot' && cmd.Key?.snapshotId === 'current') {
        return { Item: snapshot }
      }
      return {}
    })
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network down'))))

    const promise = handler({ arguments: { action: 'capacity' } })
    await vi.advanceTimersByTimeAsync(120000)
    const res = (await promise) as Record<string, unknown>

    expect(res.ok).toBe(true)
    expect(res.availableToday).toBe(999)
    expect(res.stale).toBe(true)
  })
})

describe('runLaunchAction recomputes live capacity', () => {
  const okAccount: InstantlyAccount = {
    email: 'a@gojobsdone.com',
    status: 1,
    warmup_status: 1,
    daily_limit: 40,
    stat_warmup_score: 100,
    provider_code: 2,
    setup_pending: false,
  }

  function makeResponse(body: unknown): Response {
    const text = JSON.stringify(body)
    return {
      status: 200,
      ok: true,
      text: async () => text,
      json: async () => body,
    } as Response
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-09-11T12:00:00.000Z')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('calls Instantly account analytics on runLaunch even when a fresh snapshot exists', async () => {
    const cachedAt = '2026-09-11T12:00:00.000Z'
    const freshPayload = {
      snapshotId: 'current',
      asOf: cachedAt,
      cachedAt,
      stale: false,
      date: '2026-09-11',
      mailboxes: 1,
      perMailboxLimit: 40,
      sentToday: 0,
      carrierSentToday: 0,
      reservedForJobsDone: 25,
      availableToday: 999,
      perMailbox: [{
        email: 'a@gojobsdone.com',
        dailyLimit: 40,
        sentToday: 0,
        carrierSent: 0,
        reserved: 25,
        available: 999,
        peakObserved: 0,
      }],
      reserveBasis: 'static-floor',
      peakPerMailbox: 0,
      windowDays: JOBSDONE_PEAK_WINDOW_DAYS,
      jobsDone: { reachable: true, sharedClientsActive: 0, source: 'unconditional-reserve' },
    }
    const freshSnapshot = { snapshotId: 'current', cachedAt, stale: false, data: JSON.stringify(freshPayload) }

    mockDdbSend.mockImplementation((cmd: { TableName?: string; Key?: Record<string, unknown>; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown> }) => {
      if (cmd.TableName === 'CarrierCapacitySnapshot' && cmd.Key?.snapshotId === 'current') {
        return { Item: freshSnapshot }
      }
      if (cmd.TableName === 'CarrierCampaign') {
        if (cmd.Key?.id === 'camp-1') {
          return {
            Item: {
              id: 'camp-1',
              lane: 'IL_IA',
              name: 'Test',
              subject: 'Hi',
              bodyHtml: '<p>Hello</p>',
              senderAccounts: ['a@gojobsdone.com'],
              dailyLimit: 12,
              status: 'pushing',
              leadCount: 1,
              pushedCount: 0,
              sentCount: 0,
              openCount: 0,
              replyCount: 0,
              bounceCount: 0,
              unsubscribeCount: 0,
            },
          }
        }
        // Scan for sending/paused/completed campaigns used by carrier-sent attribution.
        return { Items: [], LastEvaluatedKey: undefined }
      }
      if (cmd.TableName === 'CarrierContact') {
        return {
          Items: [{
            id: 'c1',
            lane: 'IL_IA',
            email: 'carrier@x.com',
            firstName: null,
            lastName: null,
            company: null,
            status: 'active',
            source: null,
            addedBy: null,
            addedAt: '2026-09-11T12:00:00.000Z',
            lastCampaignId: null,
            lastSentAt: null,
            notes: null,
          }],
          LastEvaluatedKey: undefined,
        }
      }
      return {}
    })

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (url.includes('/api/v2/accounts') && !url.includes('/analytics')) {
        return makeResponse({ items: [okAccount] })
      }
      if (url.includes('/api/v2/accounts/analytics/daily')) {
        return makeResponse([{ email_account: 'a@gojobsdone.com', date: '2026-09-11', sent: 4 }])
      }
      if (url.includes('/graphql')) {
        return makeResponse({ data: { listClients: { items: [] } } })
      }
      if (url === '/api/v2/campaigns' && method === 'POST') {
        return makeResponse({ id: 'instantly-camp-1' })
      }
      if (url.includes('/api/v2/leads/add') && method === 'POST') {
        return makeResponse({ status: 'success', total_sent: 1 })
      }
      if (url.includes('/api/v2/campaigns/') && url.includes('/activate') && method === 'POST') {
        return makeResponse({ id: 'instantly-camp-1', status: 1 })
      }
      return makeResponse({})
    })
    vi.stubGlobal('fetch', fetchMock)

    const res = (await handler({ action: 'runLaunch', campaignId: 'camp-1' } as Record<string, unknown>)) as Record<string, unknown>

    expect(res.ok).toBe(true)
    const analyticsFetch = fetchMock.mock.calls.find((c) =>
      typeof c[0] === 'string' && c[0].includes('/api/v2/accounts/analytics/daily'),
    )
    expect(analyticsFetch).toBeTruthy()
  })
})
