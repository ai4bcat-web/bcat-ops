import { describe, expect, it, vi } from 'vitest'
import { McpApiError } from './mcpAdapter'
import { normalizeMcpProfile, mapProfileToCarrier, matchCarrier, buildCarrierIndex, mcKey } from './mcpProfile'
import type { McpProfile } from './mcpProfile'
import { addCarrierFromMcp, newPullState, pullOneCarrier, runBackfillSlice, runChangesPoll } from './mcpPull'
import type { McpPullDeps } from './mcpPull'
import { SYNTHETIC_EIN, SYNTHETIC_SSN } from '@/test/syntheticTaxIds'

type Row = Record<string, unknown>
const NOW = Date.parse('2026-11-03T12:00:00Z')

// Synthetic carriers only: no real names, numbers or accounts.
const body = (over: Row = {}): Row => ({
  DOTNumber: 7000001,
  MCNumber: 'MC900001',
  LegalName: 'Zephyr Test Freight LLC',
  DBAName: 'Zephyr Test',
  Phone: '555-0100',
  Email: 'Office@Zephyr.Example',
  Address1: '1 Test Way', City: 'Testville', State: 'TX', Zipcode: '75001',
  CarrierCustomerPacketStatuses: [{ CarrierPacketStatus: 'Completed' }],
  CarrierCustomerAgreements: [{ SignatureDate: '2026-10-20T09:30:00', OnCurrentCustomerAgreement: true }],
  CarrierW9Forms: [{ EIN: SYNTHETIC_EIN, SSN: SYNTHETIC_SSN, IsActive: true }],
  CarrierOperationalDetail: { TotalPowerUnits: 12 },
  CarrierDispatchers: [{ DispatcherName: 'Dee Patch', Email: 'Dee@Zephyr.Example', PhoneNumber: '555-0101' }],
  ClaimsContactName: 'Clay Mz', ClaimsContactEmail: 'claims@zephyr.example',
  CarrierBank: { CarrierBankName: 'Test Bank', CarrierBankAccountName: 'Zephyr', CarrierBankAccountNumber: '000011112222', CarrierBankRoutingNumber: '999988887777' },
  CarrierRemit: { CarrierRemitEmail: 'ap@zephyr.example', CarrierRemitAddress1: '2 Remit Rd', CarrierRemitCity: 'Testville', CarrierRemitStateProvince: 'TX', CarrierRemitZipCode: '75001' },
  AssureAdvantage: [{ CarrierDetails: {
    Safety: { rating: 'Satisfactory', ratingDate: '2025-05-01' },
    Authority: { commonAuthority: 'A', authGrantDate: '2019-03-02' },
    RiskAssessmentDetails: { TotalPoints: 20, OverallRating: 'Pass', ReviewState: '' },
    CertData: { Certificate: [{ Coverage: [
      { insurerName: 'Fake Mutual', policyNumber: 'P-1', type: 'Cargo', expirationDate: '2027-01-01', coverageLimit: '100000' },
      { type: 'Auto Liability', expirationDate: '2027-06-30', coverageLimit: '1000000' },
    ] }] },
  } }],
  ...over,
})
const profile = (over: Row = {}): McpProfile => normalizeMcpProfile(body(over), {}, NOW)!

describe('normalizeMcpProfile', () => {
  it('maps the profile fields and keeps no secret', () => {
    const p = profile()
    expect(p).toMatchObject({
      legalName: 'Zephyr Test Freight LLC', phone: '555-0100', email: 'office@zephyr.example', taxId: SYNTHETIC_EIN, powerUnits: 12,
      address: { street: '1 Test Way', city: 'Testville', state: 'TX', zip: '75001' }, packetKnown: true,
    })
    expect(p.payment).toEqual({
      method: 'ACH', recipientType: 'CARRIER', bankName: 'Test Bank', accountName: 'Zephyr', accountLast4: '2222', routingLast4: '7777',
      payeeEmail: 'ap@zephyr.example', remitToAddress: { street: '2 Remit Rd', city: 'Testville', state: 'TX', zip: '75001' },
    })
    expect(JSON.stringify(p)).not.toContain(SYNTHETIC_SSN)
    expect(JSON.stringify(p)).not.toMatch(/000011112222|999988887777/)
    expect(p.contacts).toEqual([
      { name: 'Dee Patch', email: 'dee@zephyr.example', phone: '555-0101', types: ['DISPATCH'] },
      { name: 'Clay Mz', email: 'claims@zephyr.example', types: ['CLAIMS'] },
    ])
  })

  it('a factored carrier is paid through its factor', () => {
    const p = profile({ CarrierBank: undefined, FactoringRemit: { FactoringCompanyName: 'Fake Factor Co', FactoringRemitEmail: 'pay@factor.example', FactoringRemitAddress: '9 Factor St', FactoringRemitCity: 'Elsewhere', FactoringRemitStateProvince: 'OH', FactoringRemitZipcode: '44000' } })
    expect(p.payment).toMatchObject({ recipientType: 'FACTOR', method: 'CHECK', factorName: 'Fake Factor Co', payeeEmail: 'pay@factor.example', factorAddress: { street: '9 Factor St' } })
  })

  it('a changes-feed item has no packet, so it can never reset mcpStatus', () => {
    const item = normalizeMcpProfile({ dotNumber: 7000001, docketNumber: 'MC900001', Identity: { legalName: 'Zephyr Test Freight LLC' }, RiskAssessmentDetails: { TotalPoints: 90, OverallRating: 'Fail' } }, {}, NOW)!
    expect(item.packetKnown).toBe(false)
    const { patch } = mapProfileToCarrier({ id: 'c', mcpStatus: 'ACCEPTABLE', mcpRiskScore: 20 }, item)
    expect(patch).not.toHaveProperty('mcpStatus')
    expect(patch).toMatchObject({ mcpRiskScore: 90 })
  })
})

describe('mapProfileToCarrier', () => {
  it('MCP wins over hand-typed values and records filled vs overwrote; the tax id never rides the patch', () => {
    const existing: Row = { id: 'c1', name: 'zephyr test freight', phone: '000', insurancePolicies: [{ id: 'm', type: 'CARGO', expiresAt: '2020-01-01T00:00:00.000Z', active: false }, { id: 'o', type: 'OTHER' }] }
    const { patch, changes } = mapProfileToCarrier(existing, profile())
    expect(patch).toMatchObject({ name: 'Zephyr Test Freight LLC', phone: '555-0100', mcpStatus: 'ACCEPTABLE', mcpReviewStatus: 'ACCEPTABLE', mcpRiskScore: 20, safetyRating: 'SATISFACTORY', authorityStatus: 'ACTIVE', mcpPacketCompletedAt: '2026-10-20T09:30:00.000Z' })
    expect(JSON.stringify([patch, changes])).not.toContain(SYNTHETIC_EIN)
    expect(patch).not.toHaveProperty('einNumber')
    const policies = patch.insurancePolicies as Row[]
    expect(policies.find((p) => p.type === 'CARGO')).toMatchObject({ id: 'm', limitCents: 10_000_000, company: 'Fake Mutual', policyNumber: 'P-1', active: true })
    expect(policies.find((p) => p.type === 'OTHER')).toBeDefined()
    expect(changes.phone).toMatchObject({ before: '000', kind: 'OVERWROTE' })
    expect(changes).not.toHaveProperty('einNumber')
  })

  it('is empty when the row already says what MCP says', () => {
    const first = mapProfileToCarrier({ id: 'c1' }, profile())
    expect(mapProfileToCarrier({ id: 'c1', ...first.patch }, profile()).patch).toEqual({})
  })
})

describe('matchCarrier', () => {
  const rows: Row[] = [
    { id: 'a', name: 'Alpha Haul Inc', mcNumber: 'MC-0123' },
    { id: 'b', name: 'Bravo Freight', dotNumber: '4567' },
    { id: 'c', name: 'Charlie Lines' },
    { id: 'd', name: 'Delta Express' },
    { id: 'e', name: 'Delta Express' },
  ]
  const idx = buildCarrierIndex(rows)
  const p = (mc: string, dot: string, name: string): McpProfile => ({ ...profile(), legalName: name, carrier: { ...profile().carrier, mcNumber: mc, dotNumber: dot } })

  it('matches MC (formatting-blind), then DOT, then a unique normalised name', () => {
    expect(mcKey('mc 0123')).toBe('MC123')
    expect(matchCarrier(idx, p('MC123', '1', 'x'))).toMatchObject({ by: 'MC', rows: [{ id: 'a' }] })
    expect(matchCarrier(idx, p('MC999', '4567', 'x'))).toMatchObject({ by: 'DOT', rows: [{ id: 'b' }] })
    expect(matchCarrier(idx, p('MC999', '1', 'Charlie Lines LLC'))).toMatchObject({ by: 'NAME', rows: [{ id: 'c' }] })
  })

  it('refuses an ambiguous name and an unknown carrier', () => {
    expect(matchCarrier(idx, p('MC999', '1', 'Delta Express'))).toBeNull()
    expect(matchCarrier(idx, p('MC999', '1', 'Nobody'))).toBeNull()
  })
})

/** In-memory tables behind McpPullDeps. */
function world(opts: { carriers?: Row[]; monitored?: Array<{ dotNumber?: string; docketNumber?: string }>; profiles?: Record<string, Row | null>; pageSize?: number } = {}) {
  const carriers = new Map((opts.carriers ?? []).map((r) => [String(r.id), { ...r }]))
  const taxIds = new Map<string, string>()
  const contacts: Row[] = []
  const payments: Row[] = []
  const audits: Array<{ entityId: string; action: string; changes: Record<string, unknown> }> = []
  const monitored = opts.monitored ?? []
  const pageSize = opts.pageSize ?? 2
  let n = 0
  let clock = NOW
  const deps: McpPullDeps = {
    loadCarriers: async () => [...carriers.values()].map((r) => ({ ...r })),
    writeCarrier: async (carrier, patch) => {
      const stored = carriers.get(String(carrier.id))!
      if (stored.updatedAt !== carrier.updatedAt) return 'CONFLICT'
      Object.assign(stored, patch, { updatedAt: `u${++n}` })
      return 'WRITTEN'
    },
    reloadCarrier: async (id) => (carriers.has(id) ? { ...carriers.get(id)! } : null),
    createCarrier: async (row) => { carriers.set(String(row.id), row) },
    loadContacts: async (id) => contacts.filter((c) => c.carrierId === id),
    putContact: async (r) => { contacts.push(r) },
    updateContact: async (id, patch) => { Object.assign(contacts.find((c) => c.id === id)!, patch) },
    loadPayments: async (id) => payments.filter((c) => c.carrierId === id),
    putPayment: async (r) => { payments.push(r) },
    updatePayment: async (id, patch) => { Object.assign(payments.find((c) => c.id === id)!, patch) },
    // The vault: keeps the value off the row, mirrors only the last four like the Lambda does.
    setTaxId: async (carrierId, value) => {
      if (taxIds.get(carrierId) === value) return 'UNCHANGED'
      taxIds.set(carrierId, value)
      const row = carriers.get(carrierId)
      if (row) row.taxIdLast4 = value.replace(/\D/g, '').slice(-4)
      return 'SET'
    },
    audit: async (a) => { audits.push(a) },
    listMonitored: async (page) => ({ entries: monitored.slice((page - 1) * pageSize, page * pageSize), totalPages: Math.max(1, Math.ceil(monitored.length / pageSize)) }),
    fetchProfile: async (ref) => {
      const raw = opts.profiles?.[ref.dotNumber ?? ref.mcNumber ?? '']
      return raw ? normalizeMcpProfile(raw, ref, NOW) : null
    },
    listChanges: async () => ({ profiles: [], totalPages: 1 }),
    listCompleted: async () => [],
    newId: () => `id${++n}`,
    sleep: vi.fn(async () => undefined),
    nowMs: () => clock,
  }
  return { deps, carriers, contacts, payments, audits, taxIds, tick: (ms: number) => { clock += ms } }
}

const fleet = () => ({
  monitored: [{ dotNumber: '7000001', docketNumber: 'MC900001' }, { dotNumber: '7000002', docketNumber: 'MC900002' }, { dotNumber: '7000003', docketNumber: 'MC900003' }],
  profiles: {
    '7000001': body(),
    '7000002': body({ DOTNumber: 7000002, MCNumber: 'MC900002', LegalName: 'Quill Test Lines', Email: undefined, CarrierDispatchers: [], ClaimsContactName: undefined, ClaimsContactEmail: undefined }),
    '7000003': body({ DOTNumber: 7000003, MCNumber: 'MC900003', LegalName: 'Brand New Test Co' }),
  } as Record<string, Row>,
  carriers: [
    { id: 'c1', name: 'Zephyr Test Freight', mcNumber: 'MC-900001', dotNumber: '7000001', status: 'PENDING', updatedAt: 'u0' },
    { id: 'c2', name: 'Quill Test Lines', dotNumber: '7000002', status: 'PENDING', updatedAt: 'u0' },
    { id: 'c9', name: 'Ours Only Trucking', mcNumber: 'MC-111111', status: 'PENDING', updatedAt: 'u0' },
  ] as Row[],
})

describe('runBackfillSlice', () => {
  const start = () => newPullState('run-1', 'ryne@example.com', '2026-11-03T12:00:00.000Z')

  it('matches, creates, fills contacts and payment, audits, and reports unmatched both ways', async () => {
    const w = world(fleet())
    const state = await runBackfillSlice(w.deps, start(), { createUnmatched: true })

    expect(state).toMatchObject({ status: 'DONE', cursor: null, counts: { created: 1, updated: 2, unchanged: 0, errors: 0 }, unmatchedBcatCount: 1 })
    expect(state.unmatchedBcat).toEqual([{ id: 'c9', name: 'Ours Only Trucking', mc: 'MC111111', dot: undefined }])
    expect(w.carriers.get('c1')).toMatchObject({ mcpStatus: 'ACCEPTABLE', taxIdLast4: '0001', mcpSyncRunId: 'run-1', name: 'Zephyr Test Freight LLC' })
    expect(w.carriers.get('c1')).not.toHaveProperty('einNumber')
    expect([...w.taxIds.values()]).toEqual([SYNTHETIC_EIN, SYNTHETIC_EIN, SYNTHETIC_EIN])
    expect(w.carriers.get('c2')).toMatchObject({ dotNumber: '7000002', mcNumber: 'MC900002' }) // matched by DOT, MC filled in
    const created = [...w.carriers.values()].find((r) => r.name === 'Brand New Test Co')!
    // Packet complete + monitored (it came from the monitored list): MyCarrierPackets makes it ACTIVE.
    expect(created).toMatchObject({ status: 'ACTIVE', statusChangedBy: 'mcp-sync', createdBy: 'mcp-sync', mcpStatus: 'ACCEPTABLE' })
    expect(w.carriers.get('c1')).toMatchObject({ status: 'ACTIVE', statusChangedBy: 'mcp-sync' })

    expect(w.contacts.filter((c) => c.carrierId === 'c1').map((c) => c.name).sort()).toEqual(['Clay Mz', 'Dee Patch'])
    expect(w.contacts.find((c) => c.name === 'Dee Patch')).toMatchObject({ isPrimary: true, types: ['DISPATCH'] })
    expect(w.payments.find((p) => p.carrierId === 'c1')).toMatchObject({ source: 'MCP', isPreferred: true, accountLast4: '2222' })
    expect(JSON.stringify([...w.payments, ...w.audits, ...w.carriers.values()])).not.toMatch(/000011112222|999988887777|00-0000001|000000001/)

    const audit = w.audits.find((a) => a.entityId === 'c1')!
    expect(audit.action).toBe('MCP_PULL')
    expect(audit.changes).toMatchObject({ matchedBy: 'MC', taxId: 'SET', fields: { name: { before: 'Zephyr Test Freight', kind: 'OVERWROTE' } } })
    expect(w.audits.some((a) => a.action === 'MCP_CREATE')).toBe(true)
  })

  it('lists instead of creating when creation is off', async () => {
    const w = world(fleet())
    const state = await runBackfillSlice(w.deps, start(), { createUnmatched: false })
    expect(state.counts).toMatchObject({ created: 0, unmatchedMcp: 1 })
    expect(state.unmatchedMcp[0]).toMatchObject({ name: 'Brand New Test Co', reason: 'creation off' })
  })

  it('is idempotent: a second run over the same data changes nothing and audits nothing new', async () => {
    const w = world(fleet())
    await runBackfillSlice(w.deps, start(), { createUnmatched: true })
    const audits = w.audits.length
    const [contacts, payments] = [w.contacts.length, w.payments.length]
    const again = await runBackfillSlice(w.deps, newPullState('run-2', 'ryne@example.com', '2026-11-03T13:00:00.000Z'), { createUnmatched: true })
    expect(again.counts).toMatchObject({ created: 0, updated: 0, unchanged: 3, errors: 0 })
    expect(w.audits).toHaveLength(audits)
    expect(w.contacts).toHaveLength(contacts)
    expect(w.payments).toHaveLength(payments)
  })

  it('resumes from a cursor after a partial slice and finishes with the same totals', async () => {
    const w = world(fleet())
    const first = await runBackfillSlice(w.deps, start(), { createUnmatched: true, maxCarriers: 2 })
    expect(first).toMatchObject({ status: 'PARTIAL', cursor: { page: 2, index: 0 } })
    const second = await runBackfillSlice(w.deps, first, { createUnmatched: true, maxCarriers: 2 })
    expect(second).toMatchObject({ status: 'DONE', counts: { created: 1, updated: 2 }, unmatchedBcatCount: 1 })
  })

  it('stops partial on a rate limit and with ERROR on a rejected credential, keeping the position', async () => {
    const limited = world(fleet())
    limited.deps.fetchProfile = async () => { throw new McpApiError('429', 'RATE_LIMIT', 429) }
    const a = await runBackfillSlice(limited.deps, start(), { createUnmatched: true })
    expect(a).toMatchObject({ status: 'PARTIAL', cursor: { page: 1, index: 0 } })
    expect(a.lastError).toMatch(/rate limiting/)

    const denied = world(fleet())
    denied.deps.fetchProfile = async () => { throw new McpApiError('rejected', 'AUTH', 401) }
    expect((await runBackfillSlice(denied.deps, start(), { createUnmatched: true })).status).toBe('ERROR')
  })

  it('counts a carrier that fails and keeps going; a conflicting row is counted, not clobbered', async () => {
    const w = world(fleet())
    const fetch = w.deps.fetchProfile
    let n = 0
    w.deps.fetchProfile = async (ref) => { if (++n === 1) throw new Error('boom'); return fetch(ref) }
    const state = await runBackfillSlice(w.deps, start(), { createUnmatched: true })
    expect(state.counts.errors).toBe(1)
    expect(state.lastError).toBe('boom')
    expect(state.status).toBe('DONE')

    const c = world(fleet())
    c.deps.writeCarrier = async () => 'CONFLICT'
    const conflicted = await runBackfillSlice(c.deps, start(), { createUnmatched: false })
    expect(conflicted.counts.conflicts).toBe(2)
  })

  it('throttles between lookups', async () => {
    const w = world(fleet())
    await runBackfillSlice(w.deps, start(), { createUnmatched: true, minIntervalMs: 400 })
    expect(w.deps.sleep).toHaveBeenCalledWith(400)
  })
})

describe('runChangesPoll', () => {
  const done = () => ({ ...newPullState('run-1', 'u', '2026-11-03T11:00:00.000Z'), status: 'DONE' as const, cursor: null, changesFrom: '2026-11-03T11:00:00.000Z' })

  it('does nothing inside the 4-minute floor, then polls and applies insurance and risk changes', async () => {
    const w = world({ carriers: [{ id: 'c1', name: 'Zephyr Test Freight LLC', mcNumber: 'MC-900001', mcpStatus: 'ACCEPTABLE', updatedAt: 'u0', insurancePolicies: [{ id: 'm', type: 'CARGO', expiresAt: '2027-01-01T00:00:00.000Z', active: true }] }] })
    const lapsed = normalizeMcpProfile({ dotNumber: 7000001, docketNumber: 'MC900001', RiskAssessmentDetails: { TotalPoints: 95, OverallRating: 'Fail' }, CertData: { Certificate: [{ Coverage: [{ type: 'Cargo', expirationDate: '2026-11-01', cancellationDate: '2026-11-01' }] }] } }, {}, NOW)!
    w.deps.listChanges = vi.fn(async () => ({ profiles: [lapsed], totalPages: 1 }))

    const recent = { ...done(), lastChangesAt: new Date(NOW - 60_000).toISOString() }
    expect(await runChangesPoll(w.deps, recent, { createUnmatched: false })).toBe(recent)
    expect(w.deps.listChanges).not.toHaveBeenCalled()

    const polled = await runChangesPoll(w.deps, { ...done(), lastChangesAt: new Date(NOW - 5 * 60_000).toISOString() }, { createUnmatched: false })
    expect(polled.changesCounts).toMatchObject({ updated: 1, errors: 0 })
    expect(polled.changesFrom).toBe(new Date(NOW).toISOString())
    const row = w.carriers.get('c1')!
    expect(row.mcpRiskScore).toBe(95)
    // The gate reads these: a lapsed cargo policy blocks booking (effectiveCarrierStatus) and mcpStatus is untouched.
    expect((row.insurancePolicies as Row[])[0]).toMatchObject({ type: 'CARGO', active: false, expiresAt: '2026-11-01T00:00:00.000Z' })
    expect(row.mcpStatus).toBe('ACCEPTABLE')
  })

  it('pulls the full profile of a carrier whose packet just completed', async () => {
    const w = world({ carriers: [{ id: 'c1', name: 'Zephyr Test Freight LLC', mcNumber: 'MC-900001', updatedAt: 'u0' }], profiles: { '7000001': body() } })
    w.deps.listCompleted = async () => [{ dotNumber: '7000001', docketNumber: 'MC900001' }]
    await runChangesPoll(w.deps, { ...done(), lastChangesAt: new Date(NOW - 10 * 60_000).toISOString() }, { createUnmatched: false })
    expect(w.carriers.get('c1')).toMatchObject({ mcpStatus: 'ACCEPTABLE', taxIdLast4: '0001' })
    expect(w.payments).toHaveLength(1)
  })
})

describe('pullOneCarrier', () => {
  it('pulls one carrier by its own MC/DOT, and reports NO_PACKET for a stranger or a row with no identifiers', async () => {
    const w = world({ carriers: [{ id: 'c1', name: 'x', mcNumber: 'MC-900001', updatedAt: 'u0' }, { id: 'c2', name: 'y', updatedAt: 'u0' }, { id: 'c3', name: 'z', dotNumber: '123', updatedAt: 'u0' }], profiles: { 'MC-900001': body() } })
    expect(await pullOneCarrier(w.deps, 'c1', 'r')).toBe('SYNCED')
    expect(w.carriers.get('c1')).toMatchObject({ mcpStatus: 'ACCEPTABLE' })
    expect(await pullOneCarrier(w.deps, 'c2', 'r')).toBe('NO_PACKET')
    expect(await pullOneCarrier(w.deps, 'c3', 'r')).toBe('NO_PACKET')
    expect(await pullOneCarrier(w.deps, 'missing', 'r')).toBe('NO_PACKET')
  })
})

describe('addCarrierFromMcp (Find & Invite: Add to carriers)', () => {
  it('creates a row pre-filled from MCP (ACTIVE only because its packet is complete), with contacts, payment and an MCP_CREATE audit, and no secret anywhere', async () => {
    const w = world({ profiles: { '7000001': body() } })
    const out = await addCarrierFromMcp(w.deps, { dotNumber: '7000001', mcNumber: 'MC900001' }, 'run-add')
    expect(out.result).toBe('CREATED')
    const row = w.carriers.get(out.carrierId!)!
    expect(row).toMatchObject({
      name: 'Zephyr Test Freight LLC', dbaName: 'Zephyr Test', mcNumber: 'MC900001', dotNumber: '7000001', phone: '555-0100',
      status: 'ACTIVE', mcpStatus: 'ACCEPTABLE', safetyRating: 'SATISFACTORY', authorityStatus: 'ACTIVE', taxIdLast4: '0001',
    })
    expect(w.contacts.filter((c) => c.carrierId === out.carrierId)).toHaveLength(2)
    expect(w.audits).toHaveLength(1)
    expect(w.audits[0]).toMatchObject({ entityId: out.carrierId, action: 'MCP_CREATE', changes: { source: 'MYCARRIERPACKETS', matchedBy: 'CREATED', taxId: 'SET' } })
    expect(JSON.stringify([...w.payments, ...w.audits, row])).not.toMatch(/000011112222|999988887777|00-0000001|000000001/)
  })

  it('leaves a carrier that is already in the directory exactly as it is (matched on DOT when the MC differs)', async () => {
    const w = world({ carriers: [{ id: 'c1', name: 'Hand Typed Name', dotNumber: '7000001', phone: '000', updatedAt: 'u0' }], profiles: { '7000001': body() } })
    const out = await addCarrierFromMcp(w.deps, { dotNumber: '7000001' }, 'run-add')
    expect(out).toEqual({ result: 'EXISTS', carrierId: 'c1', matchedBy: 'DOT' })
    expect(w.carriers.get('c1')).toMatchObject({ name: 'Hand Typed Name', phone: '000' })
    expect(w.carriers.size).toBe(1)
    expect(w.audits).toEqual([])
  })

  it('creates nothing when MCP has no record, or no legal name to name the row by', async () => {
    const w = world({ profiles: { '7000001': body({ LegalName: undefined, CompanyName: undefined, AssureAdvantage: undefined }) } })
    expect((await addCarrierFromMcp(w.deps, { dotNumber: '404' }, 'r')).result).toBe('NO_MCP_RECORD')
    expect((await addCarrierFromMcp(w.deps, { dotNumber: '7000001' }, 'r')).result).toBe('NO_NAME')
    expect(w.carriers.size).toBe(0)
  })
})

describe('MCP drives Carrier.status through the pull (Step AM)', () => {
  const lapsedBody = () => body({
    AssureAdvantage: [{ CarrierDetails: {
      Safety: { rating: 'Satisfactory', ratingDate: '2025-05-01' },
      Authority: { commonAuthority: 'A', authGrantDate: '2019-03-02' },
      RiskAssessmentDetails: { TotalPoints: 20, OverallRating: 'Pass', ReviewState: '' },
      CertData: { Certificate: [{ Coverage: [{ insurerName: 'Fake Mutual', policyNumber: 'P-1', type: 'Cargo', expirationDate: '2026-10-01', coverageLimit: '100000' }] }] },
    } }],
  })

  it('activates a PENDING carrier whose packet is complete, audits the change and tells the ladder', async () => {
    const w = world({ carriers: [{ id: 'c1', name: 'Zephyr Test Freight', mcNumber: 'MC-900001', dotNumber: '7000001', status: 'PENDING', updatedAt: 'u0' }], profiles: { '7000001': body() } })
    const changed = vi.fn(async () => undefined)
    w.deps.carrierStatusChanged = changed
    expect(await pullOneCarrier(w.deps, 'c1', 'r1')).toBe('SYNCED')
    expect(w.carriers.get('c1')).toMatchObject({ status: 'ACTIVE', statusChangedBy: 'mcp-sync' })
    expect(changed).toHaveBeenCalledWith('c1', 'ACTIVE')
    expect(w.audits[0]!.changes).toMatchObject({ fields: { status: { before: 'PENDING', after: 'ACTIVE' } } })
  })

  it('flips an ACTIVE carrier INACTIVE when MCP reports its cargo insurance lapsed', async () => {
    const w = world({ carriers: [{ id: 'c1', name: 'Zephyr Test Freight', mcNumber: 'MC-900001', dotNumber: '7000001', status: 'ACTIVE', mcpStatus: 'ACCEPTABLE', updatedAt: 'u0' }], profiles: { '7000001': lapsedBody() } })
    expect(await pullOneCarrier(w.deps, 'c1', 'r1')).toBe('SYNCED')
    expect(w.carriers.get('c1')).toMatchObject({ status: 'INACTIVE', statusReason: 'EXPIRED_INSURANCE', statusChangedBy: 'mcp-sync' })
  })

  it('does not undo a person\'s DO_NOT_USE', async () => {
    const w = world({ carriers: [{ id: 'c1', name: 'Zephyr Test Freight', mcNumber: 'MC-900001', dotNumber: '7000001', status: 'DO_NOT_USE', updatedAt: 'u0' }], profiles: { '7000001': body() } })
    await pullOneCarrier(w.deps, 'c1', 'r1')
    expect(w.carriers.get('c1')!.status).toBe('DO_NOT_USE')
  })
})
