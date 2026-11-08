import { describe, it, expect } from 'vitest'
import { isDerivedPro, normalizePro } from './proNumber'

describe('normalizePro', () => {
  it('strips the padding the live table stores', () => {
    expect(normalizePro('14452  ')).toBe('14452')
  })

  it('reads a PRO a driver typed with a label', () => {
    expect(normalizePro('PRO #13364')).toBe('13364')
    expect(normalizePro('pro 13364')).toBe('13364')
  })

  it('ignores punctuation and case so one load has one key', () => {
    expect(normalizePro('a-2847391')).toBe(normalizePro('A 2847391'))
  })

  it('treats the N/A sentinel as no PRO at all', () => {
    expect(normalizePro('N/A')).toBeNull()
    expect(normalizePro('n/a')).toBeNull()
  })

  it('refuses anything too short to be a real PRO', () => {
    // A stray "12" in a note must never match a load.
    expect(normalizePro('12')).toBeNull()
    expect(normalizePro('')).toBeNull()
    expect(normalizePro(null)).toBeNull()
  })
})

describe('isDerivedPro', () => {
  it('recognises the shape the counter issues, raw or as a claim key', () => {
    expect(isDerivedPro('S000123-1', 'S')).toBe(true)
    expect(isDerivedPro('s000123-12', 'S')).toBe(true)
    expect(isDerivedPro('S0001231', 'S')).toBe(true)
    expect(isDerivedPro('PRO S000123-2', 'S')).toBe(true)
  })
  it('follows a dashed prefix the way the claim key does', () => {
    expect(isDerivedPro('BC-000123-1', 'BC-')).toBe(true)
    expect(isDerivedPro('BC0001231', 'BC-')).toBe(true)
  })
  it('leaves numeric Aljex PROs and ordinary strings alone', () => {
    expect(isDerivedPro('14547', 'S')).toBe(false)
    expect(isDerivedPro('900123', 'S')).toBe(false)
    expect(isDerivedPro('S123', 'S')).toBe(false)
    expect(isDerivedPro('X000123-1', 'S')).toBe(false)
  })
})
