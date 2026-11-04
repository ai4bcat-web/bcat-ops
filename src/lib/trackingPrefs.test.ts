import { describe, it, expect } from 'vitest'
import {
  allowsAutoRequests, channelsAllowedBy, effectiveTrackingPrefs, parseTrackingPrefs, validateTrackingPrefsOverride,
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
