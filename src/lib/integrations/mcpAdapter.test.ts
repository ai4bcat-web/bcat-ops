import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyMcpUpdate,
  clearMcpTokenCache,
  listCarrierChanges,
  listCompletedPackets,
  listMonitoredCarriers,
  lookupMcpCarrier,
  mapPacketStatus,
  mapRiskStanding,
  mcpAdapter,
  mcpCarrierPatch,
  mergeInsurancePolicies,
  normalizeMcpCarrier,
  sendSetupPacket,
  validateMcpCredentials,
} from './mcpAdapter'
import { healthFrom } from './health'
import { mcpPacketStanding } from '../mcpPacket'

// Fake credentials only. Nothing here ever reaches the network: fetch is always a mock.
const CREDS = { username: 'fake-user', password: 'fake-pass-123' }
const NOW = '2026-11-03T12:00:00.000Z'
const NOW_MS = Date.parse(NOW)

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

/** A fetch that answers /token itself and hands every other URL to `api`. */
function mcpFetch(api: Handler, token: () => Response = () => json({ access_token: 'tok-1', expires_in: 3600 })) {
  return vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input))
    if (url.pathname === '/token') return token()
    return api(url, init)
  })
}

const asFetch = (f: ReturnType<typeof mcpFetch>) => f as unknown as typeof fetch
const calls = (f: ReturnType<typeof mcpFetch>, path: string) => f.mock.calls.filter(([u]) => new URL(String(u)).pathname === path)
const instant = { sleep: vi.fn(async () => undefined), now: () => NOW_MS }

beforeEach(() => {
  clearMcpTokenCache()
  instant.sleep.mockClear()
})

/** A GetCarrierData body in the DTO shape the published swagger describes. */
const carrierData = (over: Record<string, unknown> = {}) => ({
  DOTNumber: 12345,
  MCNumber: 'MC123456',
  LegalName: 'Haul Bros LLC',
  CarrierCustomerPacketStatuses: [{ CarrierPacketStatus: 'Completed', CustomerID: 7 }],
  CarrierCustomerAgreements: [
    { SignatureDate: '2026-10-01T15:00:00', OnCurrentCustomerAgreement: true, IsActive: true },
    { SignatureDate: '2026-10-20T09:30:00', OnCurrentCustomerAgreement: true, IsActive: true },
  ],
  AssureAdvantage: [
    {
      CarrierDetails: {
        Safety: { rating: 'Satisfactory' },
        Authority: { commonAuthority: 'A', contractAuthority: 'N', brokerAuthority: 'N' },
        RiskAssessmentDetails: { TotalPoints: 35, OverallRating: 'Pass', ReviewState: '' },
        CertData: {
          Certificate: [
            {
              Coverage: [
                { type: 'Cargo', expirationDate: '2027-01-01', coverageLimit: '$100,000' },
                { type: 'Auto Liability', expirationDate: '2027-06-30', coverageLimit: '1000000' },
              ],
            },
          ],
        },
      },
    },
  ],
  ...over,
})

describe('auth token flow', () => {
  it('posts grant_type=password to /token and sends the bearer on the API call', async () => {
    const f = mcpFetch(() => json(carrierData()))
    await lookupMcpCarrier({ dotNumber: '12345' }, CREDS, asFetch(f), instant)

    const [, tokenInit] = calls(f, '/token')[0]!
    expect(tokenInit?.method).toBe('POST')
    const form = new URLSearchParams(String(tokenInit?.body))
    expect(form.get('grant_type')).toBe('password')
    expect(form.get('username')).toBe(CREDS.username)
    const [, apiInit] = calls(f, '/api/v1/Carrier/GetCarrierData')[0]!
    expect((apiInit?.headers as Record<string, string>).Authorization).toBe('Bearer tok-1')
    expect(apiInit?.method).toBe('POST')
  })

  it('reuses the cached token until it expires, then fetches a new one', async () => {
    let clock = NOW_MS
    const opts = { sleep: instant.sleep, now: () => clock }
    const f = mcpFetch(() => json(carrierData()), () => json({ access_token: `tok-${f.mock.calls.length}`, expires_in: 600 }))

    await lookupMcpCarrier({ dotNumber: '1' }, CREDS, asFetch(f), opts)
    await lookupMcpCarrier({ dotNumber: '2' }, CREDS, asFetch(f), opts)
    expect(calls(f, '/token')).toHaveLength(1)

    clock += 9 * 60_000 // 600s lifetime minus the 60s skew has passed
    await lookupMcpCarrier({ dotNumber: '3' }, CREDS, asFetch(f), opts)
    expect(calls(f, '/token')).toHaveLength(2)
  })

  it('refreshes the token once on a 401 and retries the call', async () => {
    let first = true
    const f = mcpFetch(
      (_u, init) => {
        const auth = (init.headers as Record<string, string>).Authorization
        if (first) {
          first = false
          return json({}, 401)
        }
        expect(auth).toBe('Bearer tok-2')
        return json(carrierData())
      },
      (() => {
        let n = 0
        return () => json({ access_token: `tok-${++n}`, expires_in: 3600 })
      })(),
    )
    const found = await lookupMcpCarrier({ dotNumber: '12345' }, CREDS, asFetch(f), instant)
    expect(found?.status).toBe('ACCEPTABLE')
    expect(calls(f, '/token')).toHaveLength(2)
  })

  it('never leaks the credentials into an error message', async () => {
    const f = mcpFetch(() => json({}), () => json({ error: `invalid_grant for ${CREDS.password}` }, 400))
    const err = await lookupMcpCarrier({ dotNumber: '1' }, CREDS, asFetch(f), instant).catch((e: Error) => e)
    expect(String((err as Error).message)).not.toContain(CREDS.password)
    expect(String((err as Error).message)).not.toContain(CREDS.username)
  })
})

describe('validate state machine', () => {
  const run = async (creds: Record<string, string>, f: ReturnType<typeof mcpFetch>) =>
    healthFrom(await validateMcpCredentials(creds, asFetch(f), instant), NOW)

  it('is STUB-side (no call) without credentials', async () => {
    const f = mcpFetch(() => json({}))
    const health = await run({ username: '', password: '' }, f)
    expect(health).toMatchObject({ status: 'UNABLE_TO_VERIFY', reason: 'NO_CREDENTIALS' })
    expect(f).not.toHaveBeenCalled()
  })

  it('makes no call with neutered credentials', async () => {
    const f = mcpFetch(() => json({}))
    const health = await run({ username: 'disabled-on-dev', password: 'disabled-on-dev' }, f)
    expect(health.reason).toBe('NEUTERED_ON_DEV')
    expect(f).not.toHaveBeenCalled()
  })

  it('token 200 → OK', async () => {
    const f = mcpFetch(() => json({}))
    expect(await run(CREDS, f)).toMatchObject({ status: 'OK', reason: 'OK' })
  })

  it.each([400, 401, 403])('token %i → INVALID_CREDENTIALS, with a message that carries no secret', async (status) => {
    const f = mcpFetch(() => json({}), () => json({ error: 'invalid_grant', error_description: CREDS.password }, status))
    const health = await run(CREDS, f)
    expect(health).toMatchObject({ status: 'INVALID_CREDENTIALS', reason: 'INVALID_CREDENTIALS' })
    expect(health.detail).toContain('rejected')
    expect(JSON.stringify(health)).not.toContain(CREDS.password)
    expect(JSON.stringify(health)).not.toContain(CREDS.username)
  })

  it('any other answer → UNABLE_TO_VERIFY with the HTTP code only, and no retry', async () => {
    const f = mcpFetch(() => json({}), () => json({ message: CREDS.password }, 503))
    const health = await run(CREDS, f)
    expect(health).toMatchObject({ status: 'UNABLE_TO_VERIFY', reason: 'PROVIDER_UNREACHABLE', detail: 'HTTP 503' })
    expect(calls(f, '/token')).toHaveLength(1)
  })

  it('a network failure → UNABLE_TO_VERIFY', async () => {
    const f = vi.fn(async () => {
      throw new Error(`socket hang up ${CREDS.password}`)
    })
    const health = healthFrom(await validateMcpCredentials(CREDS, f as unknown as typeof fetch, instant), NOW)
    expect(health.status).toBe('UNABLE_TO_VERIFY')
    expect(health.detail).not.toContain(CREDS.password)
  })

  it('validate always proves the password itself instead of trusting the cached token', async () => {
    const f = mcpFetch(() => json(carrierData()))
    await lookupMcpCarrier({ dotNumber: '1' }, CREDS, asFetch(f), instant)
    await validateMcpCredentials(CREDS, asFetch(f), instant)
    expect(calls(f, '/token')).toHaveLength(2)
  })

  it('the adapter validate() is the same state machine', async () => {
    const f = mcpFetch(() => json({}))
    const health = await mcpAdapter(CREDS, asFetch(f), instant).validate({ provider: 'MYCARRIERPACKETS', credentials: CREDS, settings: {}, now: NOW })
    expect(health.status).toBe('OK')
  })
})

describe('lookup mapping', () => {
  it('maps a completed packet and its risk assessment to our vocabulary and Carrier fields', () => {
    const mapped = normalizeMcpCarrier(carrierData(), { mcNumber: 'MC-123456' }, NOW_MS)
    expect(mapped).toMatchObject({
      mcNumber: 'MC-123456', // echoes the row's own spelling so the row is found again
      dotNumber: '12345',
      status: 'ACCEPTABLE',
      reviewStatus: 'ACCEPTABLE',
      riskAssessmentPoints: 35,
      safetyRating: 'SATISFACTORY',
      authorityStatus: 'ACTIVE',
      packetCompletedAt: '2026-10-20T09:30:00.000Z',
    })
    expect(mapped?.insurance?.cargo).toMatchObject({ limitCents: 10_000_000, active: true })
    expect(mapped?.insurance?.liability).toMatchObject({ limitCents: 100_000_000, active: true })
  })

  it('marks lapsed coverage inactive', () => {
    const mapped = normalizeMcpCarrier(carrierData(), {}, Date.parse('2027-03-01T00:00:00Z'))
    expect(mapped?.insurance?.cargo?.active).toBe(false)
    expect(mapped?.insurance?.liability?.active).toBe(true)
  })

  it('treats a carrier with no packet as NOT_INVITED, an invited one as INVITED', () => {
    const bare = { DOTNumber: 9, LegalName: 'Bare Inc' }
    expect(normalizeMcpCarrier(bare, {}, NOW_MS)).toMatchObject({ status: 'NOT_INVITED' })
    const invited = { ...bare, AssureAdvantage: [{ CarrierDetails: { LatestInvitation: { InvitationSentDate: '2026-10-30T00:00:00' } } }] }
    expect(normalizeMcpCarrier(invited, {}, NOW_MS)?.status).toBe('INVITED')
  })

  it('returns null for an unknown carrier (empty preview, or only a Message)', () => {
    expect(normalizeMcpCarrier([], {}, NOW_MS)).toBeNull()
    expect(normalizeMcpCarrier({ Message: 'Carrier not found' }, {}, NOW_MS)).toBeNull()
  })

  it('looks up by DOT and docket, falls back to PreviewCarrier when GetCarrierData knows nothing', async () => {
    const f = mcpFetch((url) =>
      url.pathname.endsWith('GetCarrierData')
        ? json({ Message: 'not found' })
        : json([{ DotNumber: 12345, DocketNumber: 'MC123456', CompanyName: 'Haul Bros', RiskAssessmentDetails: { TotalPoints: 5, OverallRating: 'Pass' } }]),
    )
    const found = await lookupMcpCarrier({ mcNumber: 'MC-123456', dotNumber: '12345' }, CREDS, asFetch(f), instant)

    const q = new URL(String(calls(f, '/api/v1/Carrier/GetCarrierData')[0]![0])).searchParams
    expect(q.get('DOTNumber')).toBe('12345')
    expect(q.get('DocketNumber')).toBe('MC123456')
    expect(calls(f, '/api/v1/Carrier/PreviewCarrier')).toHaveLength(1)
    // Not completed (no packet), so it is NOT_INVITED even though a risk score exists.
    expect(found).toMatchObject({ status: 'NOT_INVITED', riskAssessmentPoints: 5 })
    expect(found?.reviewStatus).toBeUndefined()
  })

  it('lists completed packets in a window (guide 2.1.1)', async () => {
    const f = mcpFetch(() => json([{ DOTNumber: 12345, DocketNumber: 'MC123456', LegalName: 'Haul Bros', CompletedDate: '2026-11-02T10:00:00' }]))
    const rows = await listCompletedPackets({ from: new Date('2026-11-01T00:00:00Z'), to: new Date('2026-11-03T00:00:00Z') }, CREDS, asFetch(f), instant)
    const q = new URL(String(calls(f, '/api/v1/Carrier/CompletedPackets')[0]![0])).searchParams
    expect(q.get('fromDate')).toBe('2026-11-01T00:00:00')
    expect(q.get('toDate')).toBe('2026-11-03T00:00:00')
    expect(rows).toEqual([{ dotNumber: '12345', docketNumber: 'MC123456', legalName: 'Haul Bros', completedAt: '2026-11-02T10:00:00.000Z' }])
  })
})

describe('status mapping table', () => {
  it.each([
    ['Not Invited', 'NOT_INVITED'],
    ['Invitation Sent', 'INVITED'],
    ['Pending', 'INVITED'],
    ['In Progress', 'IN_PROGRESS'],
    ['Incomplete', 'IN_PROGRESS'],
    ['Pending Review', 'PENDING_REVIEW'],
    ['Completed', 'COMPLETED'],
    ['Packet Received', 'COMPLETED'],
    ['gibberish', null],
    ['', null],
  ])('packet status %j → %s', (raw, want) => {
    expect(mapPacketStatus(raw)).toBe(want)
  })

  it.each([
    ['Pass', '', 'ACCEPTABLE'],
    ['Acceptable', 'None', 'ACCEPTABLE'],
    ['Moderate', '', 'MODERATE'],
    ['Medium', '', 'MODERATE'],
    ['Unacceptable', '', 'UNACCEPTABLE'],
    ['Fail', 'Reviewed', 'UNACCEPTABLE'],
    ['Unacceptable', 'Pending', 'UNACCEPTABLE_REVIEW'],
    ['Moderate', 'Review Requested', 'PENDING_REVIEW'],
    ['Review', '', 'PENDING_REVIEW'],
    ['', '', 'PENDING_REVIEW'],
  ])('risk %j / review %j → %s', (overall, review, want) => {
    expect(mapRiskStanding(overall, review)).toBe(want)
  })

  it('every status the mapper can produce keeps mcpPacketStanding semantics', () => {
    const completed = ['PENDING_REVIEW', 'ACCEPTABLE', 'MODERATE', 'UNACCEPTABLE', 'UNACCEPTABLE_REVIEW']
    const open = ['NOT_INVITED', 'INVITED', 'IN_PROGRESS']
    for (const status of completed) expect(mcpPacketStanding({ mcpStatus: status }).completed).toBe(true)
    for (const status of open) expect(mcpPacketStanding({ mcpStatus: status }).completed).toBe(false)
    // An unrecognised packet text is never turned into a completed status.
    const inFlight = normalizeMcpCarrier({ DOTNumber: 1, LegalName: 'X', CarrierCustomerPacketStatuses: [{ CarrierPacketStatus: 'mystery' }] }, {}, NOW_MS)
    expect(mcpPacketStanding({ mcpStatus: inFlight?.status }).completed).toBe(false)
  })
})

describe('patch and merge', () => {
  it('maps carrier fields to a Carrier row patch', () => {
    expect(applyMcpUpdate({ mcNumber: 'MC-1', status: 'MODERATE', reviewStatus: 'MODERATE', riskAssessmentPoints: 25, safetyRating: 'CONDITIONAL', packetCompletedAt: NOW })).toEqual({
      mcpStatus: 'MODERATE',
      safetyRating: 'CONDITIONAL',
      mcpRiskScore: 25,
      mcpReviewStatus: 'MODERATE',
      mcpPacketCompletedAt: NOW,
    })
  })

  it('never moves a packet backwards, but lets a completed status change', () => {
    const thin = { mcNumber: 'MC-1', status: 'NOT_INVITED' as const }
    expect(applyMcpUpdate(thin, { mcpStatus: 'ACCEPTABLE' })).not.toHaveProperty('mcpStatus')
    expect(applyMcpUpdate(thin, { mcpStatus: 'INVITED' })).not.toHaveProperty('mcpStatus')
    expect(applyMcpUpdate({ mcNumber: 'MC-1', status: 'UNACCEPTABLE' }, { mcpStatus: 'ACCEPTABLE' })).toMatchObject({ mcpStatus: 'UNACCEPTABLE' })
  })

  it('mcpCarrierPatch is empty when nothing would change (idempotent)', () => {
    const mapped = normalizeMcpCarrier(carrierData(), { mcNumber: 'MC-123456' }, NOW_MS)!
    const first = mcpCarrierPatch({ id: 'c1', mcpStatus: 'INVITED' }, mapped)
    expect(first).toMatchObject({ mcpStatus: 'ACCEPTABLE', mcpRiskScore: 35 })
    expect(mcpCarrierPatch({ id: 'c1', mcpStatus: 'INVITED', ...first }, mapped)).toEqual({})
  })

  it('merges insurance preserving other policies and only the sides MCP sent', () => {
    const merged = mergeInsurancePolicies(
      [{ id: 'x', type: 'CARGO', expiresAt: '2024-01-01T00:00:00.000Z', active: true }, { id: 'y', type: 'WORKERS_COMP' }],
      { cargo: { expiresAt: '2099-12-31T00:00:00.000Z', active: true, limitCents: 100_000_00 } },
    )
    expect(merged).toHaveLength(2)
    expect(merged.find((p) => p.type === 'CARGO')).toMatchObject({ id: 'x', expiresAt: '2099-12-31T00:00:00.000Z', limitCents: 100_000_00 })
    expect(merged.find((p) => p.type === 'WORKERS_COMP')).toBeDefined()
  })
})

describe('rate-limit backoff', () => {
  it('retries a 429 honouring Retry-After, then succeeds', async () => {
    let n = 0
    const f = mcpFetch(() => (++n === 1 ? json({}, 429, { 'retry-after': '7' }) : json(carrierData())))
    const found = await lookupMcpCarrier({ dotNumber: '1' }, CREDS, asFetch(f), instant)
    expect(found?.status).toBe('ACCEPTABLE')
    expect(instant.sleep).toHaveBeenCalledWith(7000)
  })

  it('backs off exponentially on 503 and gives up after four attempts with a RATE_LIMIT/SERVER error', async () => {
    const f = mcpFetch(() => json({}, 503))
    const err = await lookupMcpCarrier({ dotNumber: '1' }, CREDS, asFetch(f), instant).catch((e: Error) => e)
    expect(calls(f, '/api/v1/Carrier/GetCarrierData')).toHaveLength(4)
    expect(instant.sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000, 4000])
    expect(err).toMatchObject({ kind: 'SERVER', status: 503 })
  })

  it('does not retry a client error', async () => {
    const f = mcpFetch(() => json({}, 400))
    await expect(lookupMcpCarrier({ dotNumber: '1' }, CREDS, asFetch(f), instant)).rejects.toMatchObject({ kind: 'CLIENT' })
    expect(instant.sleep).not.toHaveBeenCalled()
  })
})

describe('invitation', () => {
  it('is a STUB with no call when credentials are missing', async () => {
    const f = mcpFetch(() => json({}))
    const result = await sendSetupPacket({ email: 'a@b.co', carrierDot: '1' }, {}, asFetch(f))
    expect(result).toMatchObject({ mode: 'STUB', ok: false })
    expect(f).not.toHaveBeenCalled()
  })

  it('POSTs EmailPacketInvitation with the DOT, docket, email and optional MCP user', async () => {
    const f = mcpFetch(() => json({ ok: true }))
    const result = await sendSetupPacket({ email: 'dispatch@carrier.example', carrierMc: 'MC-123456', carrierDot: '12345', invitedBy: 'brenda' }, CREDS, asFetch(f), instant)
    expect(result).toMatchObject({ mode: 'LIVE', ok: true })
    const [url, init] = calls(f, '/api/v1/Carrier/EmailPacketInvitation')[0]!
    expect(init?.method).toBe('POST')
    const q = new URL(String(url)).searchParams
    expect(Object.fromEntries(q)).toEqual({ dotNumber: '12345', docketNumber: 'MC123456', carrierEmail: 'dispatch@carrier.example', username: 'brenda' })
  })

  it('refuses without a DOT: MCP invites by DOT', async () => {
    const f = mcpFetch(() => json({}))
    await expect(sendSetupPacket({ email: 'a@b.co', carrierMc: 'MC1' }, CREDS, asFetch(f), instant)).rejects.toThrow(/DOT number is required/)
    expect(f).not.toHaveBeenCalled()
  })
})

describe('monitoring feeds', () => {
  it('pages the monitored list and reads X-Pagination from the response header', async () => {
    const f = mcpFetch(() => json([{ DOTNumber: 7000001, DocketNumber: 'MC900001' }, { DOTNumber: 7000002 }], 200, { 'x-pagination': JSON.stringify({ pageNumber: 2, pageSize: 2, totalPages: 5, totalCount: 9 }) }))
    const out = await listMonitoredCarriers(2, 99_999, CREDS, asFetch(f), instant)
    expect(out).toEqual({ entries: [{ dotNumber: '7000001', docketNumber: 'MC900001' }, { dotNumber: '7000002', docketNumber: undefined }], totalPages: 5 })
    const q = new URL(String(calls(f, '/api/v1/Carrier/MonitoredCarriers')[0]![0])).searchParams
    expect(Object.fromEntries(q)).toEqual({ pageNumber: '2', pageSize: '5000' }) // the guide's maximum
  })

  it('reads CarriersChanges with the window and a capped page size', async () => {
    const f = mcpFetch(() => json({ CarrierList: [{ CarrierDetails: { dotNumber: 7000001 } }] }, 200, { 'x-pagination': JSON.stringify({ totalPages: 3 }) }))
    const out = await listCarrierChanges({ from: new Date('2026-11-03T10:00:00Z'), to: new Date('2026-11-03T11:00:00Z') }, 1, 9999, CREDS, asFetch(f), instant)
    expect(out.totalPages).toBe(3)
    expect(out.items).toHaveLength(1)
    const q = new URL(String(calls(f, '/api/v1/Carrier/CarriersChanges')[0]![0])).searchParams
    expect(Object.fromEntries(q)).toEqual({ fromDate: '2026-11-03T10:00:00', toDate: '2026-11-03T11:00:00', pageNumber: '1', pageSize: '500' })
  })
})
