import { describe, it, expect } from 'vitest'
import {
  allowsAutoRequests, autoRequestBlock, channelsAllowedBy, effectiveTrackingPrefs, parseTrackingPrefs, trackingConfirmed, trackingModeNotSet,
  TRACKING_CONFIRMATION_STARTS_AT, validateTrackingPrefsOverride,
} from './trackingPrefs'

describe('effectiveTrackingPrefs', () => {
  const customer = { trackingMode: 'MANUAL', trackingMethod: 'EMAIL', driverSmsTarget: 'WORK_ONLY' }

  it('lets the shipment override win per key independently', () => {
    const p = effectiveTrackingPrefs({ shipment: { trackingPrefs: { mode: 'AGENT' } }, customer })
    expect(p).toMatchObject({ mode: 'AGENT', method: 'EMAIL', driverSms: 'WORK_ONLY' })
    expect(p.source).toEqual({ mode: 'SHIPMENT', method: 'CUSTOMER', driverSms: 'CUSTOMER' })
  })

  it('reads the override from a JSON string as AppSync returns it', () => {
    expect(effectiveTrackingPrefs({ shipment: { trackingPrefs: '{"method":"SMS"}' }, customer }).method).toBe('SMS')
  })

  it('ignores garbage overrides and unknown enum values', () => {
    for (const bad of ['not json', 42, [], { mode: 'ROBOT', extra: 1 }, '{"driverSms":"x"}']) {
      expect(effectiveTrackingPrefs({ shipment: { trackingPrefs: bad }, customer })).toMatchObject({ mode: 'MANUAL', method: 'EMAIL' })
    }
  })

  it('a legacy customer with no choice is null/null/default and allows automatic requests', () => {
    const p = effectiveTrackingPrefs({ shipment: null, customer: { trackingMode: null } })
    expect(p).toMatchObject({ mode: null, method: null, driverSms: 'WORK_THEN_PERSONAL' })
    expect(p.source).toEqual({ mode: 'DEFAULT', method: 'DEFAULT', driverSms: 'DEFAULT' })
    expect(allowsAutoRequests(p)).toBe(true)
  })

  it('MANUAL blocks automatic requests; AGENT does not', () => {
    expect(allowsAutoRequests(effectiveTrackingPrefs({ customer }))).toBe(false)
    expect(allowsAutoRequests(effectiveTrackingPrefs({ customer: { trackingMode: 'AGENT' } }))).toBe(true)
  })
})

describe('channelsAllowedBy', () => {
  it('intersects the plan channels with the method and can empty them', () => {
    expect(channelsAllowedBy('EMAIL', ['SMS', 'EMAIL', 'VOICE'])).toEqual(['EMAIL'])
    expect(channelsAllowedBy('SMS', ['SMS', 'EMAIL'])).toEqual(['SMS'])
    expect(channelsAllowedBy('SMS', ['EMAIL'])).toEqual([])
    expect(channelsAllowedBy('BOTH', ['SMS', 'EMAIL'])).toEqual(['SMS', 'EMAIL'])
    expect(channelsAllowedBy(null, ['SMS', 'EMAIL'])).toEqual(['SMS', 'EMAIL'])
  })
})

describe('validateTrackingPrefsOverride / parseTrackingPrefs', () => {
  it('refuses a bad enum or key, and treats empty as a clear', () => {
    expect(() => validateTrackingPrefsOverride({ mode: 'ROBOT' })).toThrow(/mode must be one of/)
    expect(() => validateTrackingPrefsOverride({ flavor: 'x' })).toThrow(/Unknown tracking preference/)
    expect(() => validateTrackingPrefsOverride('x')).toThrow()
    expect(validateTrackingPrefsOverride(null)).toBeNull()
    expect(validateTrackingPrefsOverride({ mode: null })).toBeNull()
    expect(validateTrackingPrefsOverride({ method: 'BOTH' })).toEqual({ method: 'BOTH' })
  })

  it('parse yields null when nothing usable remains', () => {
    expect(parseTrackingPrefs({})).toBeNull()
    expect(parseTrackingPrefs(null)).toBeNull()
  })
})

describe('per-load confirmation (feedback 9)', () => {
  const before = '2026-11-01T00:00:00.000Z'
  const after = '2026-11-07T00:00:00.000Z'
  const agentCustomer = { trackingMode: 'AGENT', trackingMethod: 'BOTH' }

  it('a new load with only the customer suggestion is unconfirmed and automation must not auto-run', () => {
    const p = effectiveTrackingPrefs({ shipment: { createdAt: after }, customer: agentCustomer })
    expect(p).toMatchObject({ mode: 'AGENT', confirmed: false })
    expect(autoRequestBlock(p)).toBe('UNCONFIRMED')
    expect(allowsAutoRequests(p)).toBe(false)
  })

  it('confirming (confirmedAt) or pinning a mode on the load lets automation run', () => {
    expect(allowsAutoRequests(effectiveTrackingPrefs({ shipment: { createdAt: after, trackingPrefs: { confirmedAt: after, mode: 'AGENT' } }, customer: agentCustomer }))).toBe(true)
    expect(allowsAutoRequests(effectiveTrackingPrefs({ shipment: { createdAt: after, trackingPrefs: { mode: 'AGENT' } }, customer: agentCustomer }))).toBe(true)
  })

  it('the load value wins over the customer: NONE and MANUAL on the load block automation', () => {
    const none = effectiveTrackingPrefs({ shipment: { createdAt: after, trackingPrefs: { mode: 'NONE', confirmedAt: after } }, customer: agentCustomer })
    expect(none.mode).toBe('NONE')
    expect(autoRequestBlock(none)).toBe('NONE')
    expect(autoRequestBlock(effectiveTrackingPrefs({ shipment: { createdAt: after, trackingPrefs: { mode: 'MANUAL' } }, customer: agentCustomer }))).toBe('MANUAL')
  })

  it('legacy rows stay live: created before the cutoff, or with no createdAt, count as confirmed', () => {
    expect(TRACKING_CONFIRMATION_STARTS_AT > before).toBe(true)
    expect(effectiveTrackingPrefs({ shipment: { createdAt: before }, customer: agentCustomer }).confirmed).toBe(true)
    expect(effectiveTrackingPrefs({ shipment: {}, customer: agentCustomer }).confirmed).toBe(true)
    expect(allowsAutoRequests(effectiveTrackingPrefs({ shipment: { createdAt: before }, customer: agentCustomer }))).toBe(true)
  })

  it('"Tracking mode not set" needs a booked carrier and an unconfirmed load', () => {
    expect(trackingModeNotSet({ createdAt: after }, true)).toBe(true)
    expect(trackingModeNotSet({ createdAt: after }, false)).toBe(false)
    expect(trackingModeNotSet({ createdAt: before }, true)).toBe(false)
    expect(trackingConfirmed({ createdAt: after, trackingPrefs: { confirmedAt: after } })).toBe(true)
  })

  it('NONE is a load-level mode only: the customer default ignores it, and the server input takes `confirmed` but never confirmedAt', () => {
    expect(effectiveTrackingPrefs({ customer: { trackingMode: 'NONE' } }).mode).toBeNull()
    expect(validateTrackingPrefsOverride({ mode: 'NONE', confirmed: true })).toEqual({ mode: 'NONE', confirmed: true })
    expect(() => validateTrackingPrefsOverride({ confirmedAt: 'x' })).toThrow(/Unknown tracking preference/)
    expect(parseTrackingPrefs({ mode: 'AGENT', confirmedAt: 'x', confirmedBy: 'y' })).toEqual({ mode: 'AGENT', confirmedAt: 'x', confirmedBy: 'y' })
  })
})

describe('effectiveTrackingPrefs with a carrier override (Step AT)', () => {
  const customer = { trackingMode: 'AGENT', trackingMethod: 'EMAIL', driverSmsTarget: 'WORK_ONLY' }
  const shipment = { createdAt: '2026-11-07T00:00:00.000Z', trackingPrefs: { mode: 'MANUAL', method: 'BOTH', confirmedAt: '2026-11-07T00:00:00.000Z' } }

  it('carrier wins over shipment wins over customer, per key', () => {
    const p = effectiveTrackingPrefs({ shipment, customer, loadCarrier: { trackingPrefs: { method: 'SMS' } } })
    expect(p).toMatchObject({ mode: 'MANUAL', method: 'SMS', driverSms: 'WORK_ONLY' })
    expect(p.source).toEqual({ mode: 'SHIPMENT', method: 'CARRIER', driverSms: 'CUSTOMER' })
  })

  it('a carrier without an override, or no carrier, resolves exactly as the shipment did', () => {
    const base = effectiveTrackingPrefs({ shipment, customer })
    expect(effectiveTrackingPrefs({ shipment, customer, loadCarrier: {} })).toEqual(base)
    expect(effectiveTrackingPrefs({ shipment, customer, loadCarrier: { trackingPrefs: '{"bad":1}' } })).toEqual(base)
    expect(effectiveTrackingPrefs({ shipment, customer, loadCarrier: null })).toEqual(base)
  })

  it('confirmation: the carrier\'s own confirmedAt or pinned mode confirms; otherwise the shipment decides', () => {
    const fresh = { createdAt: '2026-11-07T00:00:00.000Z' }
    expect(effectiveTrackingPrefs({ shipment: fresh, customer }).confirmed).toBe(false)
    expect(effectiveTrackingPrefs({ shipment: fresh, customer, loadCarrier: { trackingPrefs: { confirmedAt: 't' } } }).confirmed).toBe(true)
    expect(effectiveTrackingPrefs({ shipment: fresh, customer, loadCarrier: { trackingPrefs: { mode: 'NONE' } } })).toMatchObject({ confirmed: true, mode: 'NONE' })
    expect(effectiveTrackingPrefs({ shipment: fresh, customer, loadCarrier: { trackingPrefs: { method: 'SMS' } } }).confirmed).toBe(false)
  })
})
