import { describe, expect, it } from 'vitest'
import { autoSendDecision, chicagoDay, senderAuthPasses, type AutoSendContext } from './autoSend'
import { normalizeExtraction } from './normalize'
import { DEFAULT_REP_SETTINGS, DEFAULT_SPOT_SETTINGS, resolveRepSettings, resolveSpotSettings, validateRepSettings, validateSpotSettings } from './settings'
import type { AutoSendReason, SpotSuggestion } from './types'

const normalized = normalizeExtraction(
  {
    kind: 'QUOTE_REQUEST',
    confidence: 'high',
    reason: 'r',
    stops: [
      { type: 'PICKUP', city: 'Chicago', state: 'IL' },
      { type: 'DELIVERY', city: 'Dallas', state: 'TX' },
    ],
    pickupDate: '2026-11-06',
    equipment: 'dry van',
    weightLbs: 38000,
    mode: 'FTL',
    accessorials: [],
  },
  { mailDate: '2026-11-04' },
)

const goodSuggestion: SpotSuggestion = {
  basis: 'DAT_LIVE', stub: false, suggestedCents: 250_000, lowCents: null, avgCents: null, highCents: null,
  perMileCents: null, reports: 20, days: 7, targetBps: 2000, floorBps: 1000, targetSource: 'ORG',
  floorSellCents: 222_000, marginAtSuggested: 2000, belowFloor: false, miles: 800, sampleCount: 0,
  confidence: 'GOOD', notes: [], label: 'DAT RateView · live',
}

function ctx(over: Partial<AutoSendContext> = {}): AutoSendContext {
  return {
    settings: { ...DEFAULT_SPOT_SETTINGS, allowAutoSend: true },
    repSettings: { ...DEFAULT_REP_SETTINGS, autoSend: true },
    devStack: false,
    repId: 'rep1',
    customer: { status: 'ACTIVE', accountOwnerIds: ['rep1'], defaultSalesRepId: null },
    matchHow: 'EMAIL',
    customerAutoReply: true,
    extraction: normalized.extraction,
    fieldMeta: normalized.fieldMeta,
    suggestion: goodSuggestion,
    senderAuthOk: true,
    threadHasOutbound: false,
    replyTo: 'dana@zz-acme.test',
    hasQuoteOrDraft: false,
    autoSentTodayRep: 0,
    autoSentTodayCustomer: 0,
    ...over,
  }
}

describe('autoSendDecision', () => {
  it('allows when every gate holds', () => {
    expect(autoSendDecision(ctx())).toEqual({ allow: true, reasons: [] })
  })

  it('is off by default at org and rep level', () => {
    const d = autoSendDecision(ctx({ settings: DEFAULT_SPOT_SETTINGS, repSettings: DEFAULT_REP_SETTINGS }))
    expect(d.allow).toBe(false)
    expect(d.reasons).toEqual(expect.arrayContaining(['ORG_OFF', 'REP_OFF']))
  })

  const flips: Array<[AutoSendReason, () => Partial<AutoSendContext>]> = [
    ['ORG_OFF', () => ({ settings: { ...DEFAULT_SPOT_SETTINGS, allowAutoSend: false } })],
    ['REP_OFF', () => ({ repSettings: { ...DEFAULT_REP_SETTINGS, autoSend: false } })],
    ['NO_CUSTOMER', () => ({ customer: null })],
    ['MATCH_NOT_EXACT', () => ({ matchHow: 'DOMAIN' })],
    ['CUSTOMER_NOT_ACTIVE', () => ({ customer: { status: 'QUALIFIED', accountOwnerIds: ['rep1'], defaultSalesRepId: null } })],
    ['NOT_OWNER', () => ({ customer: { status: 'ACTIVE', accountOwnerIds: ['rep2'], defaultSalesRepId: 'rep3' } })],
    ['CUSTOMER_OPT_OUT', () => ({ customerAutoReply: false })],
    ['FIELD_NOT_HIGH', () => ({ fieldMeta: { ...normalized.fieldMeta, origin: { source: 'MODEL', confidence: 'low' } } })],
    ['MODE_NOT_FTL', () => ({ extraction: { ...normalized.extraction, mode: 'LTL' } })],
    ['ACCESSORIALS', () => ({ extraction: { ...normalized.extraction, accessorials: ['LIFTGATE'] } })],
    ['SPECIAL_HANDLING', () => ({ extraction: { ...normalized.extraction, hazmat: 'YES' } })],
    ['PRICE_STUB', () => ({ suggestion: { ...goodSuggestion, basis: 'STUB', stub: true } })],
    ['PRICE_THIN', () => ({ suggestion: { ...goodSuggestion, basis: 'HISTORY', sampleCount: 4 } })],
    ['BELOW_FLOOR', () => ({ suggestion: { ...goodSuggestion, belowFloor: true } })],
    ['SENDER_AUTH', () => ({ senderAuthOk: false })],
    ['THREAD_NOT_NEW', () => ({ threadHasOutbound: true })],
    ['NO_RECIPIENT', () => ({ replyTo: null })],
    ['DUPLICATE', () => ({ hasQuoteOrDraft: true })],
    ['CAP_REP', () => ({ autoSentTodayRep: 25 })],
    ['CAP_CUSTOMER', () => ({ autoSentTodayCustomer: 5 })],
    ['DEV_STACK', () => ({ devStack: true })],
  ]
  for (const [reason, flip] of flips) {
    it(`flipping only the ${reason} gate blocks with exactly that reason`, () => {
      expect(autoSendDecision(ctx(flip()))).toEqual({ allow: false, reasons: [reason] })
    })
  }

  it('allows HISTORY at the minimum sample count and blocks a missing suggestion', () => {
    expect(autoSendDecision(ctx({ suggestion: { ...goodSuggestion, basis: 'HISTORY', sampleCount: 5 } })).allow).toBe(true)
    expect(autoSendDecision(ctx({ suggestion: null })).reasons).toEqual(['PRICE_STUB'])
  })

  it('treats a weight over 45,000 lb as special handling', () => {
    const heavy = { ...normalized.extraction, weightLbs: 46_000 }
    expect(autoSendDecision(ctx({ extraction: heavy })).reasons).toEqual(['SPECIAL_HANDLING'])
  })

  it('on the dev stack still reports every other failing gate', () => {
    const d = autoSendDecision(ctx({ devStack: true, matchHow: 'NONE', customerAutoReply: false }))
    expect(d.reasons).toEqual(['MATCH_NOT_EXACT', 'CUSTOMER_OPT_OUT', 'DEV_STACK'])
  })
})

describe('chicagoDay', () => {
  it('rolls the day over at Chicago midnight, not UTC', () => {
    expect(chicagoDay('2026-11-04T05:59:00Z')).toBe('2026-11-03') // 23:59 CST
    expect(chicagoDay('2026-11-04T06:00:00Z')).toBe('2026-11-04') // 00:00 CST
    expect(chicagoDay('2026-07-04T04:59:00Z')).toBe('2026-07-03') // CDT
  })
})

describe('senderAuthPasses', () => {
  const pass = 'mx; spf=pass smtp.mailfrom=zz-acme.test; dkim=pass header.d=zz-acme.test'
  it('needs SPF and DKIM pass aligned with the sender domain', () => {
    expect(senderAuthPasses({ 'authentication-results': pass }, 'a@zz-acme.test')).toBe(true)
    expect(senderAuthPasses({ 'authentication-results': pass }, 'a@mail.zz-acme.test')).toBe(true)
    expect(senderAuthPasses({ 'authentication-results': pass }, 'a@other.test')).toBe(false)
    expect(senderAuthPasses({ 'authentication-results': pass.replace('dkim=pass', 'dkim=fail') }, 'a@zz-acme.test')).toBe(false)
    expect(senderAuthPasses({ 'authentication-results': 'mx; dkim=pass header.d=zz-acme.test' }, 'a@zz-acme.test')).toBe(false)
    expect(senderAuthPasses({}, 'a@zz-acme.test')).toBe(false)
  })
})

describe('settings', () => {
  it('defaults auto-send off and fills gaps', () => {
    expect(resolveRepSettings(null).autoSend).toBe(false)
    expect(resolveSpotSettings(null).allowAutoSend).toBe(false)
    expect(resolveSpotSettings({ id: 'default', retentionDays: 30, modelCallsPerRepPerDay: -5 })).toMatchObject({ retentionDays: 30, modelCallsPerRepPerDay: 100 })
  })

  it('rejects out-of-range or mistyped patches and clamps stored junk', () => {
    expect(validateSpotSettings({ retentionDays: 0 }).ok).toBe(false)
    expect(validateSpotSettings({ allowAutoSend: 'yes' }).ok).toBe(false)
    expect(validateSpotSettings({ retentionDays: 30 })).toEqual({ ok: true, value: { retentionDays: 30 } })
    expect(validateRepSettings({ lookbackDays: 30 }).ok).toBe(false)
    expect(validateRepSettings({ signature: 'x'.repeat(401) }).ok).toBe(false)
    expect(validateRepSettings({ watchLabel: '  ' })).toEqual({ ok: true, value: { watchLabel: null } })
    expect(resolveRepSettings({ lookbackDays: 99, signature: 5 }).lookbackDays).toBe(2)
  })
})
