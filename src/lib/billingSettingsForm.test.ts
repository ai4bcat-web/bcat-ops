import { describe, it, expect } from 'vitest'
import {
  DEFAULT_ALJEX_CUTOFF_LOCAL, alwaysCopyForForm, chicagoLocalToIso, isoToChicagoLocal, parseEmailList,
} from './billingSettingsForm'

describe('parseEmailList', () => {
  it('splits on commas, semicolons and newlines, lowercases and dedupes', () => {
    expect(parseEmailList('A@x.com, b@x.com;\n a@X.com').emails).toEqual(['a@x.com', 'b@x.com'])
  })
  it('reports what is not an address', () => {
    expect(parseEmailList('ok@x.com nope').invalid).toEqual(['nope'])
  })
})

describe('alwaysCopyForForm', () => {
  it('shows the house default only when nothing was ever saved; a saved empty list stays empty', () => {
    expect(alwaysCopyForForm(undefined)).toBe('invoices@bcatcorp.com')
    expect(alwaysCopyForForm([])).toBe('')
  })
})

describe('Aljex cutoff time zone', () => {
  it('maps the default Chicago midnight (CST) to 06:00Z and back', () => {
    expect(chicagoLocalToIso(DEFAULT_ALJEX_CUTOFF_LOCAL)).toBe('2026-11-07T06:00:00.000Z')
    expect(isoToChicagoLocal('2026-11-07T06:00:00.000Z')).toBe(DEFAULT_ALJEX_CUTOFF_LOCAL)
  })
  it('uses the daylight offset in summer', () => {
    expect(chicagoLocalToIso('2026-07-01T00:00')).toBe('2026-07-01T05:00:00.000Z')
  })
  it('falls back to the default when unset and rejects impossible input', () => {
    expect(isoToChicagoLocal(null)).toBe(DEFAULT_ALJEX_CUTOFF_LOCAL)
    expect(chicagoLocalToIso('2026-02-30T00:00')).toBeNull()
    expect(chicagoLocalToIso('garbage')).toBeNull()
  })
})
