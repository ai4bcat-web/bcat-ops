import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STEP_KEYS, STEP_CATALOG, STEP_VARIANTS, defaultSettings, resolveSteps, validateProgressSteps, validateStepList, withMissingSteps,
  type StepSetting,
} from './progressSteps'

const on = (key: string, label = ''): StepSetting => ({ key, label, enabled: true })

describe('catalog and defaults', () => {
  it('every default step is in the catalog and applies to its variant; keys are unique', () => {
    expect(new Set(STEP_CATALOG.map((c) => c.key)).size).toBe(STEP_CATALOG.length)
    for (const v of STEP_VARIANTS) {
      for (const key of DEFAULT_STEP_KEYS[v]) expect(STEP_CATALOG.find((c) => c.key === key)?.variants).toContain(v)
      expect(defaultSettings(v).every((s) => s.enabled)).toBe(true)
    }
  })
  it('the carrier default is the ladder that shipped before settings existed', () => {
    expect(DEFAULT_STEP_KEYS.CARRIER).toEqual(['created', 'covered', 'setup', 'rateConSent', 'rateConSigned', 'driverInfo', 'dispatched', 'delivered', 'loadReview', 'billed', 'paid'])
  })
  it('the driver variants use driver-app and Motive steps, never the carrier workflow ones', () => {
    expect(DEFAULT_STEP_KEYS.LOCAL_DRIVER).toContain('assetStarted')
    expect(DEFAULT_STEP_KEYS.LOCAL_DRIVER).not.toContain('assetLocated')
    expect(DEFAULT_STEP_KEYS.OWNER_OPERATOR).toContain('assetLocated')
    for (const v of ['LOCAL_DRIVER', 'OWNER_OPERATOR'] as const) expect(DEFAULT_STEP_KEYS[v]).not.toContain('rateConSent')
  })
})

describe('validateStepList', () => {
  it('accepts known keys, trims labels and falls back to the catalog name for a blank one', () => {
    const out = validateStepList([on('created', '  Entered  '), on('delivered', '')], 'x', 'CARRIER')
    expect(out).toEqual([{ key: 'created', label: 'Entered', enabled: true }, { key: 'delivered', label: 'Delivered', enabled: true }])
  })
  it.each([
    [[], /between 1 and/],
    [[on('nope')], /not a known step/],
    [[on('created'), on('created')], /listed twice/],
    [[on('assetLocated')], /does not apply/],
    [[{ key: 'created', label: 'x' }], /on\/off flag/],
    [[{ key: 'created', label: 'x'.repeat(61), enabled: true }], /over 60/],
    [[{ key: 'created', label: 'x', enabled: false }], /at least one step/],
    ['steps', /must be a list/],
  ])('refuses %j', (raw, message) => {
    expect(() => validateStepList(raw, 'x', 'CARRIER')).toThrow(message)
  })
})

describe('validateProgressSteps', () => {
  it('null or an empty object clears the setting', () => {
    expect(validateProgressSteps(null)).toBeNull()
    expect(validateProgressSteps({})).toBeNull()
  })
  it('checks every division, variant and list', () => {
    expect(validateProgressSteps({ ASSETS: { LOCAL_DRIVER: [on('created'), on('delivered')] } })).toEqual({ ASSETS: { LOCAL_DRIVER: [on('created', 'Created'), on('delivered', 'Delivered')] } })
    expect(() => validateProgressSteps([])).toThrow(/object/)
    expect(() => validateProgressSteps({ 'bad code!': {} })).toThrow(/division code/)
    expect(() => validateProgressSteps({ ASSETS: { PIGEON: [on('created')] } })).toThrow(/not a variant/)
    expect(() => validateProgressSteps({ ASSETS: { CARRIER: [on('assetLocated')] } })).toThrow(/does not apply/)
  })
})

describe('resolveSteps', () => {
  it('uses the built-in steps when nothing is saved', () => {
    expect(resolveSteps(null, 'ASSETS', 'LOCAL_DRIVER')).toEqual(defaultSettings('LOCAL_DRIVER'))
    expect(resolveSteps({}, 'BROKERAGE', 'CARRIER')).toEqual(defaultSettings('CARRIER'))
    expect(resolveSteps({ ASSETS: { CARRIER: [on('created')] } }, null, 'CARRIER')).toEqual(defaultSettings('CARRIER'))
  })
  it('uses the saved list for that division and variant only', () => {
    const config = { ASSETS: { LOCAL_DRIVER: [on('created'), on('delivered', 'Done')] } }
    expect(resolveSteps(config, 'ASSETS', 'LOCAL_DRIVER').map((s) => s.label)).toEqual(['Created', 'Done'])
    expect(resolveSteps(config, 'ASSETS', 'OWNER_OPERATOR')).toEqual(defaultSettings('OWNER_OPERATOR'))
    expect(resolveSteps(config, 'BROKERAGE', 'LOCAL_DRIVER')).toEqual(defaultSettings('LOCAL_DRIVER'))
  })
  it('ignores a saved list that no longer validates instead of half applying it', () => {
    expect(resolveSteps({ BROKERAGE: { CARRIER: [on('retired-step')] } }, 'BROKERAGE', 'CARRIER')).toEqual(defaultSettings('CARRIER'))
  })
})

describe('withMissingSteps', () => {
  it('appends the catalog steps the saved list left out, off, so the editor can offer them', () => {
    const out = withMissingSteps([on('created'), on('delivered')], 'CARRIER')
    expect(out.slice(0, 2).every((s) => s.enabled)).toBe(true)
    expect(out.slice(2).every((s) => !s.enabled)).toBe(true)
    expect(out.map((s) => s.key)).toContain('dispatched')
    expect(out.map((s) => s.key)).not.toContain('assetLocated')
  })
})
