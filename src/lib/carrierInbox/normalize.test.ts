import { describe, expect, it } from 'vitest'
import { normalizeIdentityNumber, normalizeInboundExtraction, normalizePhoneE164, type RawInboundModelOutput } from './normalize'

const ctx = { receivedAt: '2026-11-04T15:00:00Z', senderEmail: 'dispatch@carrier.example.invalid', authOk: true, boardProvider: null }
const raw = (over: RawInboundModelOutput = {}): RawInboundModelOutput => ({
  kind: 'OFFER', confidence: 'high', reason: 'r', loadRefs: [], rateDollars: 1850, mcNumber: 'MC 123456', ...over,
})

describe('identity numbers', () => {
  it('extracts digits and drops leading zeros', () => {
    expect(normalizeIdentityNumber('MC-0123456')).toBe('123456')
    expect(normalizeIdentityNumber('MC# 0123456')).toBe('123456')
    expect(normalizeIdentityNumber('USDOT 7654321')).toBe('7654321')
    expect(normalizeIdentityNumber('123456')).toBe('123456')
  })
  it('drops what cannot be an MC/DOT', () => {
    expect(normalizeIdentityNumber('MC 123456789')).toBeNull()
    expect(normalizeIdentityNumber('MC 12')).toBeNull()
    expect(normalizeIdentityNumber('pending')).toBeNull()
    expect(normalizeIdentityNumber('')).toBeNull()
  })
})

describe('phone', () => {
  it('normalizes to E.164', () => {
    expect(normalizePhoneE164('(312) 555-0143')).toBe('+13125550143')
    expect(normalizePhoneE164('1-312-555-0143')).toBe('+13125550143')
    expect(normalizePhoneE164('+44 20 7946 0958')).toBe('+442079460958')
    expect(normalizePhoneE164('555-0143')).toBeNull()
  })
})

describe('rate rules', () => {
  it('keeps a valid total as integer cents', () => {
    const x = normalizeInboundExtraction(raw({ rateDollars: 1850.5 }), ctx)
    expect(x.rateCents).toBe(185_050)
    expect(x.kind).toBe('OFFER')
  })
  it('flags an out-of-range rate and demotes the offer to an inquiry', () => {
    for (const dollars of [5, 90_000]) {
      const x = normalizeInboundExtraction(raw({ rateDollars: dollars }), ctx)
      expect(x.rateCents).toBeNull()
      expect(x.flags).toContain('RATE_INVALID')
      expect(x.kind).toBe('INTEREST')
    }
  })
  it('treats the -1 sentinel as no price, without a RATE_INVALID flag', () => {
    const x = normalizeInboundExtraction(raw({ rateDollars: -1 }), ctx)
    expect(x.rateCents).toBeNull()
    expect(x.flags).not.toContain('RATE_INVALID')
    expect(x.kind).toBe('INTEREST')
  })
  it('never turns a per-mile price into a total', () => {
    const x = normalizeInboundExtraction(raw({ rateDollars: null, ratePerMileDollars: 2.15 }), ctx)
    expect(x.rateCents).toBeNull()
    expect(x.ratePerMileCents).toBe(215)
    expect(x.kind).toBe('INTEREST')
  })
  it('flags an outlier against the posting rate but keeps the offer', () => {
    const low = normalizeInboundExtraction(raw({ rateDollars: 300 }), { ...ctx, postingRateCents: 200_000 })
    expect(low.flags).toContain('RATE_OUTLIER')
    expect(low.kind).toBe('OFFER')
    const fine = normalizeInboundExtraction(raw({ rateDollars: 1900 }), { ...ctx, postingRateCents: 200_000 })
    expect(fine.flags).not.toContain('RATE_OUTLIER')
  })
})

describe('fields and flags', () => {
  it('normalizes refs, state, equipment, date, carrier', () => {
    const x = normalizeInboundExtraction(
      raw({
        loadRefs: ['PRO #zz-1001', 'zz1001', 'ab'], originCity: 'Joliet', originState: 'Illinois', destCity: 'Fort Wayne', destState: 'in',
        equipment: 'Dry Van 53', pickupDate: '2026-11-06', contactPhone: '312.555.0143', contactEmail: 'A@B.COM', notes: 'see https://x.test/a now',
      }),
      ctx,
    )
    expect(x.loadRefs).toEqual(['ZZ1001'])
    expect(x.origin).toEqual({ city: 'Joliet', state: 'IL' })
    expect(x.destination).toEqual({ city: 'Fort Wayne', state: 'IN' })
    expect(x.equipment).toBe('VAN')
    expect(x.pickupDate).toBe('2026-11-06')
    expect(x.carrier).toMatchObject({ mc: '123456', phone: '+13125550143', email: 'a@b.com' })
    expect(x.notes).toBe('see now')
  })
  it('rejects a pickup date before the mail date', () => {
    expect(normalizeInboundExtraction(raw({ pickupDate: '2026-01-01' }), ctx).pickupDate).toBeNull()
  })
  it('an unknown kind is never stored; an unknown confidence is low', () => {
    const x = normalizeInboundExtraction(raw({ kind: 'maybe', confidence: 'sure' }), ctx)
    expect(x.kind).toBe('NOT_RELEVANT')
    expect(x.confidence).toBe('low')
  })
  it('computes identity flags itself', () => {
    const x = normalizeInboundExtraction(
      raw({ mcNumber: null }),
      { ...ctx, senderEmail: 'someone@gmail.com', authOk: false },
    )
    expect(x.flags).toEqual(expect.arrayContaining(['NO_MC', 'SENDER_UNVERIFIED', 'FREEMAIL_SENDER', 'NO_LOAD_REF']))
    const board = normalizeInboundExtraction(raw({ loadRefs: ['ZZ1001'] }), { ...ctx, boardProvider: 'DAT', senderEmail: 'bids@dat.com' })
    expect(board.flags).toContain('BOARD_RELAY')
    expect(board.flags).not.toContain('NO_LOAD_REF')
    // A board relay's From address is not the carrier's.
    expect(board.carrier.email).toBeNull()
  })
  it('falls back to the sender address for the carrier e-mail', () => {
    expect(normalizeInboundExtraction(raw(), ctx).carrier.email).toBe('dispatch@carrier.example.invalid')
  })
})
