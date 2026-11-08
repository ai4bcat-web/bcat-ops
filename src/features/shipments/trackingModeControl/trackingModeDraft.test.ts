import { describe, expect, it } from 'vitest'
import { baselineOf, canSave, writesFor, type TrackingDraft } from './trackingModeDraft'

const AFTER = '2026-11-07T00:00:00.000Z'
const customer = { trackingMode: 'AGENT', trackingMethod: 'SMS' } as never
const plan = { intervalHours: 4 }
const fresh = () => baselineOf({ createdAt: AFTER, trackerId: null }, customer, plan)

describe('baselineOf', () => {
  it('pre-selects the customer mode as an unconfirmed suggestion', () => {
    expect(fresh()).toMatchObject({ confirmed: false, suggested: true, draft: { mode: 'AGENT', method: 'SMS', cadenceHours: 4, trackerId: null } })
  })
  it('the load\'s own confirmed value wins and is no longer a suggestion', () => {
    const b = baselineOf({ createdAt: AFTER, trackerId: 'u1', trackingPrefs: { mode: 'MANUAL', confirmedAt: AFTER } }, customer, plan)
    expect(b).toMatchObject({ confirmed: true, suggested: false, draft: { mode: 'MANUAL', trackerId: 'u1' } })
  })
  it('a legacy shipment counts as confirmed', () => {
    expect(baselineOf({ createdAt: '2026-10-01T00:00:00.000Z' }, customer, plan).confirmed).toBe(true)
  })
  it('no customer suggestion and nothing pinned leaves the mode empty', () => {
    expect(baselineOf({ createdAt: AFTER }, null, plan).draft.mode).toBe('')
  })
})

describe('writesFor / canSave', () => {
  const d = (over: Partial<TrackingDraft> = {}): TrackingDraft => ({ ...fresh().draft, ...over })

  it('confirming the suggestion as-is still writes the confirmation, and only that', () => {
    expect(writesFor(d(), fresh())).toEqual({ prefs: { mode: 'AGENT', method: 'SMS', confirmed: true }, cadenceHours: null, trackerId: undefined })
    expect(canSave(d(), fresh())).toBe(true)
  })
  it('Manual and None drop method and cadence; cadence only goes out when it changed', () => {
    expect(writesFor(d({ mode: 'MANUAL', cadenceHours: 9 }), fresh())).toEqual({ prefs: { mode: 'MANUAL', confirmed: true }, cadenceHours: null, trackerId: undefined })
    expect(writesFor(d({ cadenceHours: 2 }), fresh()).cadenceHours).toBe(2)
  })
  it('an assignee change, including clearing it, is its own write', () => {
    expect(writesFor(d({ trackerId: 'u9' }), fresh()).trackerId).toBe('u9')
    const had = baselineOf({ createdAt: AFTER, trackerId: 'u1' }, customer, plan)
    expect(writesFor({ ...had.draft, trackerId: null }, had).trackerId).toBeNull()
  })
  it('cannot save without a mode, with a bad cadence, or when confirmed and unchanged', () => {
    expect(canSave(d({ mode: '' }), fresh())).toBe(false)
    expect(canSave(d({ cadenceHours: 0 }), fresh())).toBe(false)
    expect(canSave(d({ cadenceHours: 2.5 }), fresh())).toBe(false)
    const done = baselineOf({ createdAt: AFTER, trackingPrefs: { mode: 'AGENT', confirmedAt: AFTER } }, customer, plan)
    expect(canSave(done.draft, done)).toBe(false)
    expect(canSave({ ...done.draft, cadenceHours: 6 }, done)).toBe(true)
  })
})
