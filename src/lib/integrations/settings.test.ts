import { describe, it, expect } from 'vitest'
import { defaultSettingsOf, validateProviderSettings } from './settings'
import { descriptorOf } from './registry'

const dat = descriptorOf('DAT')!
const macropoint = descriptorOf('MACROPOINT')!
const mcp = descriptorOf('MYCARRIERPACKETS')!
const truckstop = descriptorOf('TRUCKSTOP')!
const qbo = descriptorOf('QUICKBOOKS_ONLINE')!

describe('defaultSettingsOf', () => {
  it('gives a provider the behaviour card it can be saved with before any credential exists', () => {
    expect(validateProviderSettings(dat, defaultSettingsOf(dat))).toMatchObject({ ok: true })
    expect(defaultSettingsOf(truckstop)).toEqual({})
  })

  it('starts an opaque mapping field as an empty object, not as missing', () => {
    expect(defaultSettingsOf(qbo).mappings).toEqual({})
  })
})

describe('validateProviderSettings', () => {
  it('refuses a setting the provider does not have', () => {
    const result = validateProviderSettings(dat, { ratecastPlus: true })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.errors[0]).toContain('ratecastPlus')
  })

  it('takes an opaque mapping object whole and refuses anything that is not one', () => {
    const mappings = { USD: { ar: '41', ap: '62' }, chargeCodes: { FUEL: { itemId: '9', nested: { ok: true } } } }
    const result = validateProviderSettings(qbo, { mappings })
    expect(result).toMatchObject({ ok: true })
    expect(result.ok === true && result.value.mappings).toEqual(mappings)

    expect(validateProviderSettings(qbo, { mappings: [] })).toMatchObject({ ok: false })
    expect(validateProviderSettings(qbo, { mappings: 'AR=41' })).toMatchObject({ ok: false })
  })

  it('keeps DAT’s refresh interval at 15 minutes or more, in steps of five', () => {
    expect(validateProviderSettings(dat, { refreshIntervalMin: 15 })).toMatchObject({ ok: true })
    expect(validateProviderSettings(dat, { refreshIntervalMin: 20 })).toMatchObject({ ok: true })
    expect(validateProviderSettings(dat, { refreshIntervalMin: 17 })).toMatchObject({ ok: false })
    expect(validateProviderSettings(dat, { refreshIntervalMin: 10 })).toMatchObject({ ok: false })
  })

  it('keeps MacroPoint’s interval and duration inside what MacroPoint accepts', () => {
    expect(validateProviderSettings(macropoint, { trackingIntervalMin: 5, trackingDurationHours: 336 })).toMatchObject({
      ok: true,
    })
    expect(validateProviderSettings(macropoint, { trackingIntervalMin: 4 })).toMatchObject({ ok: false })
    expect(validateProviderSettings(macropoint, { trackingIntervalMin: 241 })).toMatchObject({ ok: false })
    expect(validateProviderSettings(macropoint, { trackingDurationHours: 0 })).toMatchObject({ ok: false })
    expect(validateProviderSettings(macropoint, { trackingDurationHours: 337 })).toMatchObject({ ok: false })
  })

  it('keeps the risk-point ceiling a whole number', () => {
    expect(validateProviderSettings(mcp, { maxRiskAssessmentPoints: 8000 })).toMatchObject({ ok: true })
    expect(validateProviderSettings(mcp, { maxRiskAssessmentPoints: 8000.5 })).toMatchObject({ ok: false })
  })

  it('refuses a select value nobody offered', () => {
    expect(validateProviderSettings(dat, { loadboardContactMethod: 'fax' })).toMatchObject({ ok: false })
    expect(validateProviderSettings(dat, { loadboardContactMethod: 'email' })).toMatchObject({ ok: true })
  })

  it('refuses a value of the wrong type', () => {
    expect(validateProviderSettings(dat, { contributeRates: 'yes' })).toMatchObject({ ok: false })
    expect(validateProviderSettings(dat, { refreshIntervalMin: '20' })).toMatchObject({ ok: false })
  })

  it('returns the whole card: what was sent, over the declared defaults', () => {
    const result = validateProviderSettings(dat, { contributeRates: false, refreshIntervalMin: 30 })
    expect(result).toEqual({
      ok: true,
      value: {
        loadboardContactMethod: 'primary-phone',
        contributeRates: false,
        ratecast: false,
        marketConditionsIndex: false,
        loadTruckRatio: false,
        refreshIntervalMin: 30,
      },
    })
  })
})
