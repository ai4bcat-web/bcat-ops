import { describe, expect, it } from 'vitest'
import {
  buildReviewCard, matchDirectoryCarrier, mergeReviewCards, parseSearch, riskTone, stubReviewCard, validateInviteEmail,
} from './mcpReview'

const NOW = Date.parse('2026-11-03T12:00:00Z')

// Synthetic carrier in the shapes the swagger documents. Not a real carrier.
const preview = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  DotNumber: 7000001,
  DocketNumber: 'MC900001',
  CompanyName: 'Zephyr Test Freight LLC',
  DBAName: 'Zephyr Test',
  Street: '1 Test Way', City: 'Testville', State: 'TX', ZipCode: '75001', Phone: '555-0100',
  Status: 'ACTIVE', StatusDate: '2020-02-01T00:00:00',
  PossibleFraud: 'No', DoubleBrokering: 'No',
  IncidentReports: { TotalIncidentReports: 2, TotalIncidentReportsWithFraud: 1 },
  IsMonitored: true, IsBlocked: false,
  RiskAssessment: { Overall: 'Moderate' },
  RiskAssessmentDetails: {
    TotalPoints: 450, OverallRating: 'Moderate', ReviewState: 'Reviewed',
    Insurance: { TotalPoints: 300, OverallRating: 'Moderate', Infractions: [{ Description: 'Cargo limit below $100,000', Points: 300 }] },
    Safety: { TotalPoints: 0, OverallRating: 'Pass', Infractions: [] },
    ReviewDetails: { ReviewUser: 'analyst', ReviewDate: '2026-10-01T00:00:00', ReviewReason: 'Fleet size' },
  },
  CertData: { Status: 'OK', Noncoop: false, Certificates: [{ Coverages: [
    { InsurerName: 'Fake Mutual', Type: 'Cargo', PolicyNumber: 'P-1', ExpirationDate: '2027-01-01T00:00:00', CoverageLimit: '$100,000' },
    { InsurerName: 'Fake Mutual', Type: 'Auto Liability', PolicyNumber: 'P-2', ExpirationDate: '2026-06-30T00:00:00', CoverageLimit: '1000000' },
    { InsurerName: 'Old Co', Type: 'General Liability', ExpirationDate: '2027-02-02T00:00:00', CancellationDate: '2026-09-01T00:00:00' },
  ] }] },
  Emails: [{ EmailType: 1, Description: 'Dispatch', Email: 'Dispatch@Zephyr.Example' }],
  ...over,
})

const data = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  DOTNumber: 7000001,
  MCNumber: 'MC900001',
  LegalName: 'Zephyr Test Freight LLC',
  CarrierCustomerPacketStatuses: [{ CarrierPacketStatus: 'Completed' }],
  CarrierCustomerAgreements: [{ SignatureDate: '2026-10-20T09:30:00', OnCurrentCustomerAgreement: true }],
  OnCurrentCustomerAgreement: true,
  CarrierOperationalDetail: { TotalPowerUnits: 12, NumberOfTractors: 12, NumberOfVans: 10, CDLEmployedDrivers: 14 },
  CarrierELDProvider: { ProviderName: 'Fake ELD' },
  CarrierLane: { Texas: true, Ohio: true, Maine: false },
  CarrierCargoHauled: { GeneralFreight: true, FreshProduce: false, BuildingMaterials: true },
  CarrierMode: { Truckload: true },
  CarrierDispatchers: [{ DispatcherName: 'Dee Patch', Email: 'dee@zephyr.example', PhoneNumber: '555-0101' }],
  AssureAdvantage: [{ CarrierDetails: {
    Authority: { authGrantDate: '2019-03-02T00:00:00', commonAuthority: 'A', contractAuthority: 'A', brokerAuthority: 'N' },
    Safety: { rating: 'Satisfactory', ratingDate: '2025-05-01T00:00:00' },
    LatestInvitation: { InvitationSentDate: '2026-10-10T08:00:00', InvitationRecipient: 'ops@zephyr.example' },
  } }],
  ...over,
})

describe('buildReviewCard (response -> card model)', () => {
  it('maps PreviewCarrier: identity, FMCSA status, risk breakdown, insurance with live/expired/cancelled, approved e-mails', () => {
    const card = buildReviewCard([preview()], { dotNumber: '7000001' }, 'preview', NOW)!
    expect(card.source).toBe('LIVE')
    expect(card.identity).toMatchObject({ legalName: 'Zephyr Test Freight LLC', dbaName: 'Zephyr Test', mcNumber: 'MC900001', dotNumber: '7000001', phone: '555-0100', address: '1 Test Way, Testville, TX 75001' })
    expect(card.operating).toMatchObject({ status: 'ACTIVE', incidentReports: { total: 2, withFraud: 1 }, nonCooperative: false })
    expect(card.risk).toMatchObject({ totalPoints: 450, overallRating: 'Moderate', tone: 'amber', reviewState: 'Reviewed', review: { user: 'analyst', reason: 'Fleet size' } })
    expect(card.risk.categories.find((c) => c.key === 'insurance')).toMatchObject({ points: 300, tone: 'amber', infractions: ['Cargo limit below $100,000 (300 pts)'] })
    const byType = Object.fromEntries(card.insurance.map((r) => [r.type, r]))
    expect(byType['Cargo']).toMatchObject({ insurer: 'Fake Mutual', policyNumber: 'P-1', limitCents: 10_000_000, state: 'ACTIVE' })
    expect(byType['Auto Liability']).toMatchObject({ limitCents: 100_000_000, state: 'EXPIRED' })
    expect(byType['General Liability']).toMatchObject({ state: 'CANCELLED' })
    expect(card.approvedEmails).toEqual([{ email: 'dispatch@zephyr.example', description: 'Dispatch' }])
    expect(card.monitoring).toEqual({ monitored: true, blocked: false })
    expect(card.fetched).toEqual({ preview: true, data: false })
  })

  it('maps GetCarrierData: packet stage, authority timeline, contacts, equipment, lanes, cargo, last invitation', () => {
    const card = buildReviewCard(data(), {}, 'data', NOW)!
    expect(card.packet).toMatchObject({ status: 'PENDING_REVIEW', completed: true, onCurrentAgreement: true, invitedAt: '2026-10-10T08:00:00.000Z', invitedTo: 'ops@zephyr.example', rawStatuses: ['Completed'] })
    expect(card.operating).toMatchObject({ authorityStatus: 'ACTIVE', common: 'A', broker: 'N', safetyRating: 'Satisfactory' })
    expect(card.timeline.map((t) => t.label)).toEqual(['Authority granted', 'Safety rating: Satisfactory', 'Packet invitation sent', 'Packet completed'])
    expect(card.timeline.map((t) => t.at)).toEqual([...card.timeline.map((t) => t.at)].sort())
    expect(card.contacts).toEqual([{ name: 'Dee Patch', email: 'dee@zephyr.example', phone: '555-0101', types: ['DISPATCH'] }])
    expect(card.equipment).toMatchObject({ powerUnits: 12, tractors: 12, trailers: 10, drivers: 14, eld: 'Fake ELD', lanes: ['Texas', 'Ohio'], cargo: ['General Freight', 'Building Materials'], modes: ['Truckload'] })
  })

  it('returns null for a carrier MCP has never heard of', () => {
    expect(buildReviewCard([], {}, 'preview', NOW)).toBeNull()
    expect(buildReviewCard({ Message: 'No carrier found' }, {}, 'data', NOW)).toBeNull()
  })

  it('an unreadable risk rating is gray, never green; a packet-less carrier is NOT_INVITED', () => {
    expect(riskTone('???')).toBe('gray')
    expect(riskTone('Unacceptable')).toBe('red')
    expect(riskTone('Pass')).toBe('green')
    const card = buildReviewCard(preview({ RiskAssessmentDetails: undefined, RiskAssessment: undefined }), {}, 'preview', NOW)!
    expect(card.risk.tone).toBe('gray')
    expect(card.packet).toMatchObject({ status: 'NOT_INVITED', completed: false })
  })

  it('the full record wins over the preview, which fills what the record lacks', () => {
    const merged = mergeReviewCards(buildReviewCard(preview(), {}, 'preview', NOW), buildReviewCard(data(), {}, 'data', NOW))!
    expect(merged.fetched).toEqual({ preview: true, data: true })
    expect(merged.insurance).toHaveLength(3) // only the preview carried certificates
    expect(merged.risk.totalPoints).toBe(450)
    expect(merged.packet.status).toBe('PENDING_REVIEW')
    expect(merged.equipment.powerUnits).toBe(12)
    expect(merged.approvedEmails.map((e) => e.email)).toEqual(['dispatch@zephyr.example'])
    expect(merged.identity.mcNumber).toBe('MC900001')
  })

  it('carries no bank, tax id or SSN into the card', () => {
    const card = buildReviewCard(data({ CarrierW9Forms: [{ EIN: '12-3456789', SSN: '000-00-0000' }], CarrierBank: { CarrierBankAccountNumber: '000011112222', CarrierBankRoutingNumber: '999988887777' } }), {}, 'data', NOW)!
    expect(JSON.stringify(card)).not.toMatch(/000011112222|999988887777|12-3456789|000-00-0000/)
  })
})

describe('STUB mode', () => {
  it('is a labelled fixture built by the same mapper, never a real carrier, for the number asked about', () => {
    const card = stubReviewCard({ mcNumber: 'MC274623' }, NOW)
    expect(card.source).toBe('STUB')
    expect(card.identity.legalName).toMatch(/stub fixture/i)
    expect(card.identity.mcNumber).toBe('MC274623')
    expect(card.risk).toMatchObject({ totalPoints: 450, tone: 'amber' })
    expect(card.insurance.length).toBeGreaterThan(0)
    expect(card.approvedEmails.length).toBeGreaterThan(0)
    expect(card.fetched).toEqual({ preview: true, data: true })
  })
})

describe('validateInviteEmail (the picker)', () => {
  const approved = [{ email: 'dispatch@zephyr.example' }]
  it('accepts an approved address and a typed one, trimmed and lower-cased, and says which is which', () => {
    expect(validateInviteEmail('  Dispatch@Zephyr.Example ', approved)).toEqual({ ok: true, email: 'dispatch@zephyr.example', approved: true })
    expect(validateInviteEmail('new@carrier.com', approved)).toEqual({ ok: true, email: 'new@carrier.com', approved: false })
  })
  it.each(['', '   ', 'nope', 'a@b', 'two@a.com, three@b.com', 'sp ace@x.com'])('refuses %j', (raw) => {
    const r = validateInviteEmail(raw, approved)
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
  })
})

describe('parseSearch', () => {
  it('reads MC, DOT and docket spellings; a bare number is an MC; anything else is a name', () => {
    expect(parseSearch('MC 274623')).toMatchObject({ kind: 'MC', mcNumber: 'MC274623' })
    expect(parseSearch('mc-0274623')).toMatchObject({ kind: 'MC', mcNumber: 'MC0274623' })
    expect(parseSearch('274623')).toEqual({ kind: 'MC', mcNumber: 'MC274623' })
    expect(parseSearch('DOT 1234567')).toEqual({ kind: 'DOT', dotNumber: '1234567' })
    expect(parseSearch('ff123')).toEqual({ kind: 'MC', mcNumber: 'FF123' })
    expect(parseSearch('Ivan Cartage')).toEqual({ kind: 'NAME', name: 'Ivan Cartage' })
    expect(parseSearch('  ')).toEqual({ kind: 'EMPTY' })
  })
})

describe('matchDirectoryCarrier ("Already in directory")', () => {
  const carriers = [
    { id: 'a', name: 'Alpha Haul Inc', mcNumber: 'MC-0123', mcpStatus: 'ACCEPTABLE' },
    { id: 'b', name: 'Bravo Freight', dotNumber: '4567' },
    { id: 'c', name: 'Charlie Lines' },
  ]
  const card = (identity: Record<string, string>) => ({ identity })
  it('matches MC (formatting-blind), then DOT, then a unique exact name', () => {
    expect(matchDirectoryCarrier(carriers, card({ mcNumber: 'MC123' }))).toMatchObject({ by: 'MC', carrier: { id: 'a', mcpStatus: 'ACCEPTABLE' } })
    expect(matchDirectoryCarrier(carriers, card({ mcNumber: 'MC999', dotNumber: '4567' }))).toMatchObject({ by: 'DOT', carrier: { id: 'b' } })
    expect(matchDirectoryCarrier(carriers, card({ legalName: 'Charlie Lines LLC' }))).toMatchObject({ by: 'NAME', carrier: { id: 'c' } })
  })
  it('is null for a carrier we do not have, and for a name two rows share', () => {
    expect(matchDirectoryCarrier(carriers, card({ mcNumber: 'MC555', dotNumber: '1', legalName: 'Nobody Trucking' }))).toBeNull()
    expect(matchDirectoryCarrier([...carriers, { id: 'd', name: 'Charlie Lines' }], card({ legalName: 'Charlie Lines' }))).toBeNull()
  })
})
