import { describe, it, expect } from 'vitest'
import { normalizePro } from './proNumber'

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
