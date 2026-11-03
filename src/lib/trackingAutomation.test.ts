import { describe, expect, it } from 'vitest'
import { DEFAULT_CHECK_CALL_PLAN, normalizeCheckCallPlan } from './checkCallPlan'
import {
  DEFAULT_AUTOMATION_POLICY,
  isQuietNow,
  isRateConSent,
  normalizeAutomationPatch,
  normalizeTrackingAutomation,
  quietEndsAtMs,
  renderTemplate,
  resolveAutomation,
  templateProblem,
  validateAutomationPatch,
  type QuietHours,
} from './trackingAutomation'

const CHI: QuietHours = { enabled: true, start: '21:00', end: '06:00', timezone: 'America/Chicago', channels: ['SMS'] }
const at = (iso: string) => Date.parse(iso)

describe('resolveAutomation precedence', () => {
  const settings = {
    defaultCheckCallPlan: { intervalHours: 6 },
    trackingAutomation: {
      global: { checkCallsAuto: true, podAuto: true, templates: { podSms: 'global pod', checkCallSms: 'global cc' } },
      divisions: {
        WEST: { policy: { podAuto: false, templates: { podSms: 'west pod' } }, plan: { intervalHours: 8 } },
        'WEST-NW': { policy: { checkCallsAuto: false } },
      },
    },
  }

  it('merges field by field: customer > subdivision > division > global > default', () => {
    const r = resolveAutomation({
      settings,
      customer: { trackingAutomation: { podAuto: true, templates: { checkCallSms: 'customer cc' } } },
      load: null,
      revDivision: 'WEST',
      revSubdivision: 'WEST-NW',
    })
    expect(r.policy.checkCallsAuto).toBe(false) // subdivision beats global
    expect(r.policySource.checkCallsAuto).toBe('DIVISION')
    expect(r.policy.podAuto).toBe(true) // customer beats division(false)
    expect(r.policySource.podAuto).toBe('CUSTOMER')
    expect(r.policy.templates.checkCallSms).toBe('customer cc')
    expect(r.policy.templates.podSms).toBe('west pod') // per key, not per object
    expect(r.policy.templates.podEmailBody).toBe('') // absent everywhere = built in
    expect(r.policy.podChannels).toEqual(DEFAULT_AUTOMATION_POLICY.podChannels)
    expect(r.policySource.podChannels).toBe('DEFAULT')
  })

  it('treats an empty-string template as built-in text, not as "inherit"', () => {
    const r = resolveAutomation({
      settings,
      customer: { trackingAutomation: { templates: { podSms: '' } } },
      load: null,
    })
    expect(r.policy.templates.podSms).toBe('')
  })

  it('replaces quiet hours as a whole object', () => {
    const r = resolveAutomation({
      settings: { trackingAutomation: { global: { quietHours: { enabled: true, start: '20:00', end: '05:00', timezone: 'America/New_York', channels: ['SMS', 'EMAIL'] } } } },
      customer: { trackingAutomation: { quietHours: { enabled: false } } },
      load: null,
    })
    // The customer layer only said enabled:false; everything else is that layer's defaults, not global's.
    expect(r.policy.quietHours.enabled).toBe(false)
    expect(r.policy.quietHours.start).toBe(DEFAULT_AUTOMATION_POLICY.quietHours.start)
    expect(r.policy.quietHours.timezone).toBe(DEFAULT_AUTOMATION_POLICY.quietHours.timezone)
  })

  it('reports the plan source: load, customer, division, org, default', () => {
    const plan = (h: number) => ({ intervalHours: h })
    const base = { settings, revDivision: 'WEST' }
    expect(resolveAutomation({ ...base, customer: null, load: { checkCallPlan: plan(1) } })).toMatchObject({ planSource: 'load' })
    expect(resolveAutomation({ ...base, customer: { checkCallPlan: plan(2) }, load: null })).toMatchObject({ planSource: 'customer' })
    expect(resolveAutomation({ ...base, customer: null, load: null })).toMatchObject({ planSource: 'division', plan: { intervalHours: 8 } })
    expect(resolveAutomation({ settings, customer: null, load: null, revDivision: 'EAST' })).toMatchObject({ planSource: 'org', plan: { intervalHours: 6 } })
    expect(resolveAutomation({ settings: null, customer: null, load: null })).toMatchObject({ planSource: 'default', plan: DEFAULT_CHECK_CALL_PLAN })
  })

  it('defaults everything off', () => {
    const r = resolveAutomation({ settings: null, customer: null, load: null })
    expect(r.policy.checkCallsAuto).toBe(false)
    expect(r.policy.podAuto).toBe(false)
  })

  it('survives stored junk and a division code like __proto__', () => {
    const r = resolveAutomation({
      settings: { trackingAutomation: '{"global":{"checkCallsAuto":"yes"},"divisions":{"__proto__":{"policy":{"podAuto":true}}}}' },
      customer: { trackingAutomation: 'not json' },
      load: null,
      revDivision: '__proto__',
    })
    expect(r.policy.checkCallsAuto).toBe(false)
    expect(r.policy.podAuto).toBe(false)
  })
})

describe('quiet hours', () => {
  it('is quiet across midnight: 23:30 and 05:59 quiet, 06:00 not, 20:59 not', () => {
    // January: Chicago is UTC-6.
    expect(isQuietNow(CHI, 'SMS', at('2026-01-15T05:30:00Z'))).toBe(true) // 23:30 the day before
    expect(isQuietNow(CHI, 'SMS', at('2026-01-15T11:59:00Z'))).toBe(true) // 05:59
    expect(isQuietNow(CHI, 'SMS', at('2026-01-15T12:00:00Z'))).toBe(false) // 06:00
    expect(isQuietNow(CHI, 'SMS', at('2026-01-15T02:59:00Z'))).toBe(false) // 20:59
    expect(isQuietNow(CHI, 'SMS', at('2026-01-15T03:00:00Z'))).toBe(true) // 21:00
  })

  it('does not silence a channel outside `channels`, or when disabled', () => {
    expect(isQuietNow(CHI, 'EMAIL', at('2026-01-15T05:30:00Z'))).toBe(false)
    expect(isQuietNow({ ...CHI, enabled: false }, 'SMS', at('2026-01-15T05:30:00Z'))).toBe(false)
  })

  it('follows the local clock through the spring-forward and fall-back Sundays', () => {
    // 2026-03-08: Chicago jumps 02:00 CST -> 03:00 CDT. 21:00 CDT on the 8th = 02:00Z on the 9th.
    expect(isQuietNow(CHI, 'SMS', at('2026-03-09T01:59:00Z'))).toBe(false) // 20:59 CDT
    expect(isQuietNow(CHI, 'SMS', at('2026-03-09T02:00:00Z'))).toBe(true) // 21:00 CDT
    expect(isQuietNow(CHI, 'SMS', at('2026-03-08T10:59:00Z'))).toBe(true) // 05:59 CDT
    expect(isQuietNow(CHI, 'SMS', at('2026-03-08T11:00:00Z'))).toBe(false) // 06:00 CDT
    // 2026-11-01: back 02:00 CDT -> 01:00 CST. 06:00 CST = 12:00Z.
    expect(isQuietNow(CHI, 'SMS', at('2026-11-01T11:59:00Z'))).toBe(true)
    expect(isQuietNow(CHI, 'SMS', at('2026-11-01T12:00:00Z'))).toBe(false)
  })

  it('reads the window in the configured zone, not Chicago', () => {
    const tokyo: QuietHours = { ...CHI, timezone: 'Asia/Tokyo' } // UTC+9
    expect(isQuietNow(tokyo, 'SMS', at('2026-01-15T13:00:00Z'))).toBe(true) // 22:00 Tokyo
    expect(isQuietNow(tokyo, 'SMS', at('2026-01-15T05:30:00Z'))).toBe(false) // 14:30 Tokyo
  })

  it('quietEndsAtMs: the window end while quiet, null otherwise, across DST', () => {
    expect(quietEndsAtMs(CHI, at('2026-01-15T05:30:00Z'))).toBe(at('2026-01-15T12:00:00Z'))
    expect(quietEndsAtMs(CHI, at('2026-01-15T18:00:00Z'))).toBeNull()
    expect(quietEndsAtMs(CHI, at('2026-03-08T07:00:00Z'))).toBe(at('2026-03-08T11:00:00Z')) // ends 06:00 CDT
    expect(quietEndsAtMs(CHI, at('2026-11-01T06:30:00Z'))).toBe(at('2026-11-01T12:00:00Z')) // ends 06:00 CST
  })
})

describe('templates', () => {
  it('substitutes allow-listed names only and leaves unknown ones verbatim', () => {
    expect(renderTemplate('{proNumber} {foo} {carrier}', { proNumber: 'S-1', carrier: null })).toBe('S-1 {foo} ')
  })

  it('rejects unknown placeholders and over-long SMS text', () => {
    expect(templateProblem('Hello {driverName}', 'checkCallSms')).toBeNull()
    expect(templateProblem('Hello {nope}', 'checkCallSms')).toMatch(/\{nope\}/)
    expect(templateProblem('x'.repeat(1601), 'podSms')).toMatch(/1600/)
    expect(templateProblem('x'.repeat(1601), 'podEmailBody')).toBeNull()
  })
})

describe('validateAutomationPatch', () => {
  it('rejects bad times, unknown zones, empty channels on an enabled purpose and bad placeholders', () => {
    expect(() => validateAutomationPatch({ quietHours: { start: '25:00' } })).toThrow(/start/)
    expect(() => validateAutomationPatch({ quietHours: { timezone: 'Mars/Base' } })).toThrow(/time zone/i)
    expect(() => validateAutomationPatch({ podAuto: true, podChannels: [] })).toThrow(/channel/i)
    expect(() => validateAutomationPatch({ quietHours: { enabled: true, channels: [] } })).toThrow(/channel/i)
    expect(() => validateAutomationPatch({ templates: { podSms: 'hi {nope}' } })).toThrow(/\{nope\}/)
    expect(() => validateAutomationPatch({ templates: { bogus: 'x' } })).toThrow(/Unknown template/)
  })

  it('accepts an overnight window and returns only known keys', () => {
    const out = validateAutomationPatch({ checkCallsAuto: true, quietHours: { enabled: true, start: '22:00', end: '05:30', timezone: 'America/Denver', channels: ['SMS'] }, extra: 1 })
    expect(out).toEqual({ checkCallsAuto: true, quietHours: { enabled: true, start: '22:00', end: '05:30', timezone: 'America/Denver', channels: ['SMS'] } })
  })
})

describe('normalizers', () => {
  it('never throw on junk and cap the divisions list', () => {
    expect(normalizeAutomationPatch(42)).toEqual({})
    expect(normalizeTrackingAutomation('{{')).toEqual({ global: {}, divisions: {} })
    const many = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`D${i}`, { policy: { podAuto: true } }]))
    expect(Object.keys(normalizeTrackingAutomation({ divisions: many }).divisions)).toHaveLength(200)
  })

  it('normalizeCheckCallPlan ignores a stored requestPodOnDelivery', () => {
    const plan = normalizeCheckCallPlan({ intervalHours: 4, requestPodOnDelivery: false })
    expect(plan).not.toBeNull()
    expect('requestPodOnDelivery' in (plan as object)).toBe(false)
  })
})

describe('isRateConSent', () => {
  it('is true for SENT, OPENED and SIGNED only', () => {
    for (const s of ['SENT', 'OPENED', 'SIGNED']) expect(isRateConSent({ rateConStatus: s })).toBe(true)
    for (const s of ['NOT_SENT', 'DECLINED', 'VOIDED', 'EXPIRED']) expect(isRateConSent({ rateConStatus: s, rateConSentAt: '2026-01-01T00:00:00Z' })).toBe(false)
  })

  it('falls back to rateConSentAt when there is no status', () => {
    expect(isRateConSent({ rateConSentAt: '2026-01-01T00:00:00Z' })).toBe(true)
    expect(isRateConSent({})).toBe(false)
  })
})
