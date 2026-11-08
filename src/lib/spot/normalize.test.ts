import { describe, expect, it } from 'vitest'
import { mapAccessorial, mapAccessorials } from './accessorials'
import { applyRepPatch, fieldStatusOf } from './fields'
import {
  normalizeEquipment,
  normalizeExtraction,
  normalizeIsoDate,
  normalizeState,
  normalizeWeight,
  normalizeZip,
  type RawSpotModelOutput,
} from './normalize'

const MAIL = '2026-11-04'

function raw(over: Partial<RawSpotModelOutput> = {}): RawSpotModelOutput {
  return {
    kind: 'QUOTE_REQUEST',
    confidence: 'high',
    reason: 'asks for a rate',
    stops: [
      { type: 'PICKUP', city: 'chicago', state: 'Illinois', zip: '60601', dateStr: '2026-11-06' },
      { type: 'DELIVERY', city: 'DALLAS', state: 'tx', zip: null },
    ],
    pickupDate: '2026-11-06',
    equipment: "53' dry van",
    weightLbs: 38000,
    mode: 'FTL',
    accessorials: [],
    lowConfidence: [],
    ...over,
  }
}

describe('validators', () => {
  it('maps state names, rejects non-states', () => {
    expect(normalizeState('Illinois')).toBe('IL')
    expect(normalizeState('tx')).toBe('TX')
    expect(normalizeState('Ontario')).toBe('ON')
    expect(normalizeState('ZZ')).toBeNull()
  })

  it('accepts 5 and 9 digit ZIPs only', () => {
    expect(normalizeZip('60601')).toBe('60601')
    expect(normalizeZip('606011234')).toBe('60601-1234')
    expect(normalizeZip('6060')).toBeNull()
  })

  it('bounds dates to mail date −1 day … +120 days and checks the calendar', () => {
    expect(normalizeIsoDate('2026-11-03', MAIL)).toBe('2026-11-03')
    expect(normalizeIsoDate('2026-11-02', MAIL)).toBeNull()
    expect(normalizeIsoDate('2027-03-04', MAIL)).toBe('2027-03-04')
    expect(normalizeIsoDate('2027-03-06', MAIL)).toBeNull()
    expect(normalizeIsoDate('2026-02-30', MAIL)).toBeNull()
  })

  it('parses weights like "42k" and rejects out-of-range', () => {
    expect(normalizeWeight('42k')).toBe(42000)
    expect(normalizeWeight('42,000 lbs')).toBe(42000)
    expect(normalizeWeight(80001)).toBeNull()
    expect(normalizeWeight(0)).toBeNull()
  })

  it('maps equipment aliases and length', () => {
    expect(normalizeEquipment("53' dry van")).toEqual({ code: 'VAN', lengthFt: 53 })
    expect(normalizeEquipment('Step deck')?.code).toBe('STEPDECK')
    expect(normalizeEquipment('power only')?.code).toBe('POWER_ONLY')
    expect(normalizeEquipment('unicycle')?.code).toBe('OTHER')
    expect(normalizeEquipment('')).toBeNull()
  })

  it('maps accessorial phrases to codes, keeps unknowns, de-duplicates', () => {
    expect(mapAccessorial('Lift gate needed')).toBe('LIFTGATE')
    expect(mapAccessorials(['liftgate', 'Liftgate', 'inside delivery', 'glitter bomb'])).toEqual([
      'LIFTGATE', 'INSIDE_DELIVERY', 'ACCESSORIAL:glitter bomb',
    ])
  })
})

describe('normalizeExtraction', () => {
  it('produces a clean, priceable extraction with AUTO chips', () => {
    const n = normalizeExtraction(raw(), { mailDate: MAIL })
    expect(n.status).toBe('NEW')
    expect(n.missingFields).toEqual([])
    expect(n.extraction.stops[0]).toMatchObject({ city: 'Chicago', state: 'IL', zip: '60601' })
    expect(n.extraction.stops[1]).toMatchObject({ city: 'Dallas', state: 'TX' })
    expect(n.extraction.equipmentType).toBe('VAN')
    expect(n.extraction.lengthFt).toBe(53)
    for (const key of ['origin', 'destination', 'equipment', 'pickupDate']) {
      expect(fieldStatusOf(key, n.extraction, n.fieldMeta)).toBe('AUTO')
    }
  })

  it('flags an invalid state INVALID and the request NEEDS_INFO', () => {
    const n = normalizeExtraction(
      raw({ stops: [{ type: 'PICKUP', city: 'Chicago', state: 'ZZ' }, { type: 'DELIVERY', city: 'Dallas', state: 'TX' }] }),
      { mailDate: MAIL },
    )
    expect(fieldStatusOf('origin', n.extraction, n.fieldMeta)).toBe('INVALID')
    expect(n.missingFields).toContain('origin')
    expect(n.status).toBe('NEEDS_INFO')
  })

  it('treats a missing pickup date as MISSING and an out-of-window date as INVALID', () => {
    const missing = normalizeExtraction(raw({ pickupDate: null, stops: raw().stops!.map((s) => ({ ...s, dateStr: null })) }), { mailDate: MAIL })
    expect(fieldStatusOf('pickupDate', missing.extraction, missing.fieldMeta)).toBe('MISSING')
    const stale = normalizeExtraction(raw({ pickupDate: '2026-01-02' }), { mailDate: MAIL })
    expect(fieldStatusOf('pickupDate', stale.extraction, stale.fieldMeta)).toBe('INVALID')
    expect(stale.status).toBe('NEEDS_INFO')
  })

  it('marks fields the model doubted, defaults, and non-high overall confidence as LOW', () => {
    const doubted = normalizeExtraction(raw({ lowConfidence: ['equipment', 'weightLbs'] }), { mailDate: MAIL })
    expect(fieldStatusOf('equipment', doubted.extraction, doubted.fieldMeta)).toBe('LOW')
    expect(fieldStatusOf('weightLbs', doubted.extraction, doubted.fieldMeta)).toBe('LOW')
    const medium = normalizeExtraction(raw({ confidence: 'medium' }), { mailDate: MAIL })
    expect(fieldStatusOf('origin', medium.extraction, medium.fieldMeta)).toBe('LOW')
    expect(fieldStatusOf('weightLbs', medium.extraction, medium.fieldMeta)).toBe('AUTO')
    const defaulted = normalizeExtraction(raw({ equipment: 'van', lengthFt: null }), { mailDate: MAIL })
    expect(defaulted.extraction.lengthFt).toBe(53)
    expect(fieldStatusOf('lengthFt', defaulted.extraction, defaulted.fieldMeta)).toBe('LOW')
  })

  it('strips URLs and caps commodity/notes; hazmat accessorial implies hazmat', () => {
    const n = normalizeExtraction(
      raw({ commodity: `paper https://evil.test/x ${'y'.repeat(100)}`, notes: 'see www.evil.test now', accessorials: ['hazmat'] }),
      { mailDate: MAIL },
    )
    expect(n.extraction.commodity!.length).toBeLessThanOrEqual(60)
    expect(n.extraction.commodity).not.toContain('evil')
    expect(n.extraction.notes).not.toContain('evil')
    expect(n.extraction.hazmat).toBe('YES')
  })
})

describe('applyRepPatch', () => {
  it('confirms edited fields and flips NEEDS_INFO back to NEW', () => {
    const n = normalizeExtraction(raw({ pickupDate: null, stops: raw().stops!.map((s) => ({ ...s, dateStr: null })) }), { mailDate: MAIL })
    expect(n.status).toBe('NEEDS_INFO')
    const fixed = applyRepPatch(n.extraction, n.fieldMeta, { pickupDate: '2026-11-09' })
    expect(fixed.status).toBe('NEW')
    expect(fieldStatusOf('pickupDate', fixed.extraction, fixed.fieldMeta)).toBe('CONFIRMED')
    expect(fieldStatusOf('origin', fixed.extraction, fixed.fieldMeta)).toBe('AUTO')
  })

  it('rejects an invalid edit as INVALID instead of storing it', () => {
    const n = normalizeExtraction(raw(), { mailDate: MAIL })
    const bad = applyRepPatch(n.extraction, n.fieldMeta, { weightLbs: 999999 })
    expect(bad.extraction.weightLbs).toBeNull()
    expect(fieldStatusOf('weightLbs', bad.extraction, bad.fieldMeta)).toBe('INVALID')
    const badState = applyRepPatch(n.extraction, n.fieldMeta, {
      stops: [{ type: 'PICKUP', name: null, city: 'X', state: 'QQ', zip: null, dateStr: null, time: null }, n.extraction.stops[1]],
    })
    expect(badState.status).toBe('NEEDS_INFO')
  })

  it('does not mutate its inputs', () => {
    const n = normalizeExtraction(raw(), { mailDate: MAIL })
    const before = JSON.stringify(n)
    applyRepPatch(n.extraction, n.fieldMeta, { weightLbs: 1000, commodity: 'x' })
    expect(JSON.stringify(n)).toBe(before)
  })
})
