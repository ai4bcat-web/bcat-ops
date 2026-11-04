import { describe, expect, it } from 'vitest'
import {
  FIXTURE_OWN_DOMAINS,
  FIXTURE_REP_EMAIL,
  SPOT_FIXTURES,
  fixtureById,
} from './fixtures'
import {
  blacklistFromSettings,
  prefilterStage1,
  prefilterStage2,
  scoreFreightSignals,
  stripQuotedHistory,
  type PrefilterContext,
} from './prefilter'

function ctxFor(over: Partial<PrefilterContext> = {}): PrefilterContext {
  return {
    repEmail: FIXTURE_REP_EMAIL,
    ownDomains: FIXTURE_OWN_DOMAINS,
    blacklist: { addresses: [], keywords: [] },
    watchLabel: null,
    knownSender: false,
    ...over,
  }
}

describe('corpus vs prefilters', () => {
  for (const f of SPOT_FIXTURES.filter((x) => !x.trackedThread)) {
    it(`${f.id} stops at stage ${f.expectStage}`, () => {
      const s1 = prefilterStage1(f.meta, ctxFor({ knownSender: Boolean(f.knownContact) }))
      if (f.expectStage === 1) {
        expect(s1.pass).toBe(false)
        return
      }
      expect(s1.pass).toBe(true)
      const s2 = prefilterStage2(stripQuotedHistory(f.body))
      expect(s2.pass).toBe(f.expectStage !== 2)
    })
  }

  it('has at least 24 synthetic fixtures across all three labels', () => {
    expect(SPOT_FIXTURES.length).toBeGreaterThanOrEqual(24)
    expect(new Set(SPOT_FIXTURES.map((f) => f.label))).toEqual(new Set(['REQUEST', 'FOLLOW_UP', 'NOT_REQUEST']))
  })
})

describe('stage 1 rules', () => {
  const base = fixtureById('req-van-clear')!.meta

  it('known-contact mail relaxes the freight-term test only', () => {
    const quiet = { ...base, subject: 'hello', snippet: 'see you soon' }
    expect(prefilterStage1(quiet, ctxFor()).pass).toBe(false)
    expect(prefilterStage1(quiet, ctxFor({ knownSender: true })).pass).toBe(true)
    const bulk = { ...quiet, headers: { ...quiet.headers, precedence: 'bulk' } }
    expect(prefilterStage1(bulk, ctxFor({ knownSender: true })).pass).toBe(false)
  })

  it('applies the org blacklist by address, @domain and keyword', () => {
    const hit = (blacklist: PrefilterContext['blacklist']) => prefilterStage1(base, ctxFor({ blacklist })).pass
    expect(hit({ addresses: ['dana@zz-acme.test'], keywords: [] })).toBe(false)
    expect(hit({ addresses: ['@zz-acme.test'], keywords: [] })).toBe(false)
    expect(hit({ addresses: [], keywords: ['chicago to dallas'] })).toBe(false)
    expect(hit({ addresses: ['other@zz-acme.test'], keywords: ['nope'] })).toBe(true)
  })

  it('honours the watch label', () => {
    expect(prefilterStage1(base, ctxFor({ watchLabel: 'Label_Quotes' })).pass).toBe(false)
    expect(prefilterStage1({ ...base, labelIds: ['INBOX', 'Label_Quotes'] }, ctxFor({ watchLabel: 'Label_Quotes' })).pass).toBe(true)
  })

  it('drops own-domain senders, the rep, no-reply senders and junk labels', () => {
    expect(prefilterStage1({ ...base, from: 'x <a@zz-bcat.test>' }, ctxFor()).pass).toBe(false)
    expect(prefilterStage1({ ...base, from: 'x <a@mail.zz-bcat.test>' }, ctxFor()).pass).toBe(false)
    expect(prefilterStage1({ ...base, from: 'no-reply@zz-acme.test' }, ctxFor()).pass).toBe(false)
    expect(prefilterStage1({ ...base, labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'] }, ctxFor()).pass).toBe(false)
    expect(prefilterStage1({ ...base, headers: { ...base.headers, 'auto-submitted': 'no' } }, ctxFor()).pass).toBe(true)
  })

  it('reads blacklist lists out of Integration settings JSON', () => {
    const lists = blacklistFromSettings([
      JSON.stringify({ blacklistAddresses: [' A@X.test '], blacklistKeywords: ['Promo'] }),
      { blacklistAddresses: ['@y.test'] },
      'not json',
      null,
    ])
    expect(lists).toEqual({ addresses: ['a@x.test', '@y.test'], keywords: ['promo'] })
  })
})

describe('stage 2', () => {
  it('strips quoted history so an old lane in a reply chain is not extracted', () => {
    const f = fixtureById('req-buried-history')!
    const stripped = stripQuotedHistory(f.body)
    expect(stripped).toContain('Phoenix, AZ')
    expect(stripped).not.toContain('Seattle')
    expect(stripped).not.toContain('older thread line')
  })

  it('strips Outlook header blocks, original-message rules and signatures but keeps a "From:" lane line', () => {
    expect(stripQuotedHistory('Rate please\n\nFrom: Bob\nSent: Monday\nTo: me\nSubject: old\nSeattle, WA')).toBe('Rate please')
    expect(stripQuotedHistory('Rate please\n-----Original Message-----\nSeattle, WA')).toBe('Rate please')
    expect(stripQuotedHistory('Rate please\n-- \nJane\nSeattle, WA')).toBe('Rate please')
    expect(stripQuotedHistory('From: Chicago, IL\nTo: Dallas, TX\nvan, 40,000 lbs, rate?')).toContain('Dallas, TX')
  })

  it('needs a lane signal even when everything else scores', () => {
    const text = 'Need a quote on a dry van, 40,000 lbs, pickup tomorrow'
    expect(scoreFreightSignals(text).laneSignals).toBe(0)
    expect(prefilterStage2(text).pass).toBe(false)
  })

  it('does not count invalid state codes or lone words as lanes', () => {
    expect(scoreFreightSignals('Hello, ZZ and Dear Sir, XX').laneSignals).toBe(0)
    expect(scoreFreightSignals('Chicago, IL to Dallas, TX').laneSignals).toBe(2)
  })
})
