import { describe, expect, it } from 'vitest'
import { normalizeMc } from './mcNumber'

describe('normalizeMc', () => {
  it('strips the MC prefix, spaces, dashes and #', () => {
    for (const raw of ['MC 123456', 'mc#123456', 'MC-123456', 'MC123456', '123-456', ' 123456 ', '#123456']) {
      expect(normalizeMc(raw)).toEqual({ value: '123456', ok: true, warning: null })
    }
  })
  it('treats an empty field as no MC', () => {
    expect(normalizeMc('  ')).toEqual({ value: null, ok: true, warning: null })
    expect(normalizeMc(null)).toEqual({ value: null, ok: true, warning: null })
  })
  it('rejects text that is not digits', () => {
    expect(normalizeMc('MC ABC123').ok).toBe(false)
    expect(normalizeMc('12 3x').ok).toBe(false)
  })
  it('warns, but still accepts, a digits-only value of an unusual length', () => {
    expect(normalizeMc('12').warning).toMatch(/does not look like/)
    expect(normalizeMc('123456789').warning).toMatch(/does not look like/)
    expect(normalizeMc('1234567').warning).toBeNull()
  })
})
