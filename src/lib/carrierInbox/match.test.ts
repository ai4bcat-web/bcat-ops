import { describe, expect, it } from 'vitest'
import { normalizeInboundExtraction, type RawInboundModelOutput } from './normalize'
import { allRefsToResolve, candidateRefs } from './refs'
import { scoreMatches, type LedgerPosting, type LedgerShipment, type MatchLedger } from './match'

const CFG = { autoFileMinScore: 0.85, suggestMinScore: 0.5 }
const ship = (id: string, over: Partial<LedgerShipment> = {}): LedgerShipment => ({
  shipmentId: id, shipmentNumber: id.toUpperCase(), loadId: `load-${id}`, laneText: 'Joliet, IL → Fort Wayne, IN',
  pickupAppt: '2026-11-06T08:00:00Z', covered: false, voided: false, ...over,
})
const posting = (shipmentId: string, over: Partial<LedgerPosting> = {}): LedgerPosting => ({
  postingId: `post:${shipmentId}:DAT`, boardPostingId: null, shipmentId, loadId: `load-${shipmentId}`, shipmentNumber: null,
  originCity: 'Joliet', originState: 'IL', destinationCity: 'Fort Wayne', destinationState: 'IN',
  pickupAppt: '2026-11-06', equipmentType: 'VAN', rateCents: 170_000, ...over,
})
const ledger = (ids: string[], postings: LedgerPosting[] = [], over: Record<string, Partial<LedgerShipment>> = {}): MatchLedger => ({
  shipments: Object.fromEntries(ids.map((id) => [id, ship(id, over[id])])),
  postings,
})

const base: RawInboundModelOutput = { kind: 'OFFER', confidence: 'high', reason: 'r', rateDollars: 1650, mcNumber: '123456', loadRefs: [] }
function run(
  rawOver: RawInboundModelOutput,
  mail: { subject?: string | null; body?: string; to?: string[]; cc?: string[] },
  resolved: Record<string, string>,
  led: MatchLedger,
  replyShipmentIds: string[] = [],
) {
  const x = normalizeInboundExtraction({ ...base, ...rawOver }, {
    receivedAt: '2026-11-04T15:00:00Z', senderEmail: 'a@carrier.example.invalid', authOk: true, boardProvider: null,
  })
  const refs = candidateRefs(mail.subject ?? null, mail.body ?? '', mail.to ?? [], mail.cc ?? [])
  // The router resolves only what exists; here `resolved` plays ProClaim.
  const refToShipment = Object.fromEntries(allRefsToResolve(x, refs).filter((r) => resolved[r]).map((r) => [r, resolved[r]]))
  return scoreMatches(x, { refs, refToShipment, replyShipmentIds }, led, CFG)
}

describe('refs', () => {
  it('finds labeled, shaped and hashed references but not MC/DOT or phone numbers', () => {
    const r = candidateRefs('Re: Load ZZAL1001', 'Our MC 123456, DOT# 7654321. Call 312-555-0143. PRO# S000123-1 and ref #44551', [], [])
    expect(r.subject).toEqual(['ZZAL1001'])
    expect(r.body).toEqual(expect.arrayContaining(['S0001231', '44551']))
    expect(r.body).not.toContain('123456')
    expect(r.body).not.toContain('7654321')
  })
  it('reads per-load plus addresses and ignores tags without a digit', () => {
    const r = candidateRefs(null, '', ['Loads <loads+bids.zzal1001@example.invalid>', 'x+newsletter@y.com'], ['loads.bids.ZZAL2002@example.invalid'])
    expect(r.plus).toEqual(['ZZAL1001', 'ZZAL2002'])
  })
})

describe('scoreMatches exact signals', () => {
  it('subject PRO => 0.90 AUTO', () => {
    const r = run({ loadRefs: ['ZZAL1001'] }, { subject: 'Load ZZAL1001', body: 'x' }, { ZZAL1001: 's1' }, ledger(['s1']))
    expect(r.decision).toBe('AUTO')
    expect(r.top).toMatchObject({ shipmentId: 's1', score: 0.9, how: 'LOAD_REF_SUBJECT' })
  })
  it('body-only PRO => 0.85 AUTO (threshold inclusive); the same mail at medium confidence is capped 0.84 => SUGGEST', () => {
    const body = 'We can haul load ZZAL1001 for $1,650'
    const high = run({}, { subject: 'Truck', body }, { ZZAL1001: 's1' }, ledger(['s1']))
    expect(high.top).toMatchObject({ score: 0.85, how: 'LOAD_REF_BODY' })
    expect(high.decision).toBe('AUTO')
    const medium = run({ confidence: 'medium' }, { subject: 'Truck', body }, { ZZAL1001: 's1' }, ledger(['s1']))
    expect(medium.top?.score).toBe(0.84)
    expect(medium.decision).toBe('SUGGEST')
  })
  it('low confidence falls below the suggestion floor => NONE', () => {
    const r = run({ confidence: 'low' }, { subject: 'Load ZZAL1001' }, { ZZAL1001: 's1' }, ledger(['s1']))
    expect(r.decision).toBe('NONE')
    expect(r.candidates).toEqual([])
  })
  it('two different resolvable loads => runner-up rule => SUGGEST with both listed', () => {
    const r = run({}, { subject: 'Load ZZAL1001', body: 'also load ZZAL2002' }, { ZZAL1001: 's1', ZZAL2002: 's2' }, ledger(['s1', 's2']))
    expect(r.decision).toBe('SUGGEST')
    expect(r.candidates.map((c) => c.shipmentId)).toEqual(['s1', 's2'])
  })
  it('a much weaker second load does not block auto-filing', () => {
    const r = run({}, { subject: 'Load ZZAL1001', body: 'cf load ZZAL2002' }, { ZZAL1001: 's1' }, ledger(['s1']))
    expect(r.decision).toBe('AUTO')
  })
  it('body PRO + posting reference on the same load => agreement bonus => 0.90 AUTO', () => {
    const led = ledger(['s1'], [posting('s1', { boardPostingId: 'DAT-77001' })])
    const r = run({ postingRef: 'DAT-77001' }, { subject: 'Truck', body: 'for load ZZAL1001 $1,650' }, { ZZAL1001: 's1' }, led)
    expect(r.top).toMatchObject({ score: 0.9, postingId: 'post:s1:DAT' })
    expect(r.top?.signals.map((s) => s.key).sort()).toEqual(['LOAD_REF_BODY', 'POSTING_REF'])
    expect(r.decision).toBe('AUTO')
  })
  it('a posting reference alone scores 0.85', () => {
    const led = ledger(['s1'], [posting('s1', { boardPostingId: 'DAT-77001' })])
    const r = run({ postingRef: 'dat 77001' }, { subject: 'Bid', body: 'x' }, {}, led)
    expect(r.top).toMatchObject({ score: 0.85, how: 'POSTING_REF' })
  })
  it('an unresolvable reference scores nothing', () => {
    const r = run({ loadRefs: ['ZZAL9999'] }, { subject: 'Load ZZAL9999', body: 'x' }, {}, ledger(['s1']))
    expect(r).toEqual({ candidates: [], decision: 'NONE', top: null })
  })
  it('plus-address and reply-thread => 0.95', () => {
    const plus = run({}, { subject: 'Bid', to: ['loads+bids.ZZAL1001@example.invalid'] }, { ZZAL1001: 's1' }, ledger(['s1']))
    expect(plus.top).toMatchObject({ score: 0.95, how: 'PLUS_ADDRESS' })
    const reply = run({}, { subject: 'Re: your quote' }, {}, ledger(['s1']), ['s1'])
    expect(reply.top).toMatchObject({ score: 0.95, how: 'REPLY_THREAD' })
    expect(reply.decision).toBe('AUTO')
  })
  it('a voided shipment is never a candidate; a covered one still matches (router decides COVERED_LATE)', () => {
    const voided = run({}, { subject: 'Load ZZAL1001' }, { ZZAL1001: 's1' }, ledger(['s1'], [], { s1: { voided: true } }))
    expect(voided.decision).toBe('NONE')
    const covered = run({}, { subject: 'Load ZZAL1001' }, { ZZAL1001: 's1' }, ledger(['s1'], [], { s1: { covered: true } }))
    expect(covered.decision).toBe('AUTO')
    expect(covered.top?.covered).toBe(true)
  })
  it('an INTEREST with an exact reference still matches (router files it thread-only)', () => {
    const r = run({ kind: 'INTEREST', rateDollars: null }, { subject: 'Load ZZAL1001' }, { ZZAL1001: 's1' }, ledger(['s1']))
    expect(r.decision).toBe('AUTO')
  })
})

describe('scoreMatches lane + date (fuzzy)', () => {
  const lane: RawInboundModelOutput = {
    originCity: 'Joliet', originState: 'IL', destCity: 'Fort Wayne', destState: 'IN', pickupDate: '2026-11-06', equipment: 'van', rateDollars: 1650,
  }
  it('a perfect fit is capped at 0.80 and never AUTO', () => {
    const r = run(lane, { subject: 'Truck' }, {}, ledger(['s1'], [posting('s1')]))
    expect(r.top).toMatchObject({ score: 0.8, how: 'LANE_DATE' })
    expect(r.decision).toBe('SUGGEST')
  })
  it('never AUTO even when the configured threshold equals the cap', () => {
    const x = normalizeInboundExtraction({ ...base, ...lane }, {
      receivedAt: '2026-11-04T15:00:00Z', senderEmail: null, authOk: true, boardProvider: null,
    })
    const r = scoreMatches(x, { refs: { subject: [], body: [], plus: [] }, refToShipment: {}, replyShipmentIds: [] },
      ledger(['s1'], [posting('s1')]), { autoFileMinScore: 0.8, suggestMinScore: 0.5 })
    expect(r.decision).toBe('SUGGEST')
  })
  it('lane only (no date/equipment/rate) = 0.70 => SUGGEST', () => {
    const r = run({ ...lane, pickupDate: null, equipment: null, rateDollars: 5000 }, { subject: 'Truck' }, {}, ledger(['s1'], [posting('s1')]))
    expect(r.top?.score).toBe(0.7)
    expect(r.decision).toBe('SUGGEST')
  })
  it('two postings on one lane are ambiguous: both listed, nothing auto', () => {
    const r = run(lane, { subject: 'Truck' }, {}, ledger(['s1', 's2'], [posting('s1'), posting('s2')]))
    expect(r.decision).toBe('SUGGEST')
    expect(r.candidates).toHaveLength(2)
  })
  it('a different destination does not match', () => {
    const r = run({ ...lane, destCity: 'Dallas', destState: 'TX' }, { subject: 'Truck' }, {}, ledger(['s1'], [posting('s1')]))
    expect(r.decision).toBe('NONE')
  })
  it('fuzzy does not run when an exact signal produced a candidate', () => {
    const r = run(lane, { subject: 'Load ZZAL1001' }, { ZZAL1001: 's1' }, ledger(['s1', 's2'], [posting('s2')]))
    expect(r.candidates.map((c) => c.shipmentId)).toEqual(['s1'])
  })
})
