import { describe, expect, it } from 'vitest'
import { dwellMinutes, findCustomerMatches, findLocationMatches, formatCents, normalizeAddress, normalizeName, parseCents } from './tmsDirectory'
import type { CustomerRecord, LocationRecord } from '@/types/tms'

const customer = (over: Partial<CustomerRecord>): CustomerRecord =>
  ({ id: 'c', name: 'X', createdAt: '', updatedAt: '', ...over })
const location = (over: Partial<LocationRecord>): LocationRecord =>
  ({ id: 'l', name: 'X', createdAt: '', updatedAt: '', ...over })
const FRESH = new Date(Date.now() + 86_400_000).toISOString()

describe('normalizeName', () => {
  it('drops punctuation, case, accents and trailing legal suffixes only', () => {
    expect(normalizeName('Batory Foods, Inc.')).toBe('batory foods')
    expect(normalizeName('  ACME  Ingredients LLC ')).toBe('acme ingredients')
    expect(normalizeName('Café Corp')).toBe('cafe')
    // A suffix inside the name is part of the name.
    expect(normalizeName('Inc Magazine Distribution')).toBe('inc magazine distribution')
  })
})

describe('normalizeAddress', () => {
  it('joins the postal parts and normalizes like a name', () => {
    expect(normalizeAddress({ street: '123 Main St.', city: 'Joliet', state: 'IL', zip: '60431' })).toBe('123 main st joliet il 60431')
    expect(normalizeAddress('123 MAIN ST, Joliet IL 60431')).toBe('123 main st joliet il 60431')
  })
})

describe('parseCents / formatCents — decimal strings, never floats', () => {
  it('parses dollars.cents exactly', () => {
    expect(parseCents('0.10')).toBe(10)
    expect(parseCents('1.1')).toBe(110)
    expect(parseCents('19.99')).toBe(1999)
    expect(parseCents('250000')).toBe(25_000_000)
    expect(parseCents('  ')).toBeNull()
  })
  it('refuses fractions of a cent, negatives and non-numbers', () => {
    expect(() => parseCents('1.999')).toThrow()
    expect(() => parseCents('-5')).toThrow()
    expect(() => parseCents('$5')).toThrow()
    expect(() => parseCents('1e3')).toThrow()
  })
  it('refuses amounts beyond the GraphQL Int range', () => {
    expect(parseCents('21474836.47')).toBe(2147483647)
    expect(() => parseCents('21474836.48')).toThrow()
  })
  it('formats integer cents round-trip', () => {
    expect(formatCents(1999)).toBe('19.99')
    expect(formatCents(5)).toBe('0.05')
    expect(formatCents(-250)).toBe('-2.50')
    expect(() => formatCents(1.5)).toThrow()
  })
})

describe('findCustomerMatches — suggestions to review, never auto-links', () => {
  const customers = [
    customer({ id: 'batory', name: 'Batory Foods, Inc.', aliases: ['BATORY'] }),
    customer({ id: 'acme', name: 'Acme Ingredients' }),
    customer({ id: 'gone', name: 'Batory Foods', active: false }),
    customer({ id: 'merged', name: 'Batory Foods', mergedIntoId: 'batory' }),
  ]
  it('ranks exact name or alias first and leaves archived/merged records out', () => {
    const matches = findCustomerMatches('batory', customers)
    expect(matches.map((m) => m.record.id)).toEqual(['batory'])
    expect(matches[0].score).toBe(1)
  })
  it('offers similar names below exact ones', () => {
    const matches = findCustomerMatches('Batory Foods Chicago', customers)
    expect(matches[0].record.id).toBe('batory')
    expect(matches[0].score).toBeLessThan(1)
    expect(findCustomerMatches('Zeta Freight', customers)).toEqual([])
  })
  it('finds a customer from the first typed word or prefix, below exact/overlap matches', () => {
    const smoke = customer({ id: 'smoke', name: 'Smoke Test Shipper LLC' })
    const all = [...customers, smoke]
    for (const typed of ['Smoke', 'smo', 'Smoke Ship']) {
      const m = findCustomerMatches(typed, all)
      expect(m.map((x) => x.record.id)).toEqual(['smoke'])
      expect(m[0].score).toBeGreaterThanOrEqual(0.4)
      expect(m[0].score).toBeLessThan(1)
    }
    // a word that prefixes nothing still yields nothing
    expect(findCustomerMatches('Smoke Zeta', all)).toEqual([])
  })
})

describe('findLocationMatches — 150 m rule needs fresh coordinates', () => {
  const dock = location({ id: 'dock', name: 'Oakley DC', city: 'Chicago, IL', lat: 41.8781, lng: -87.6298, geocodeExpiresAt: FRESH })
  it('flags a facility within 150 m even under another name', () => {
    const [m] = findLocationMatches({ name: 'Gate 4', lat: 41.8790, lng: -87.6298 }, [dock])
    expect(m.record.id).toBe('dock')
    expect(m.reason).toMatch(/within \d+ m/i)
  })
  it('does not use coordinates whose Google result has expired', () => {
    const stale = { ...dock, geocodeExpiresAt: '2000-01-01T00:00:00.000Z' }
    expect(findLocationMatches({ name: 'Gate 4', lat: 41.8790, lng: -87.6298 }, [stale])).toEqual([])
  })
  it('matches by name only inside the same city', () => {
    expect(findLocationMatches({ name: 'Oakley DC', city: 'Chicago, IL' }, [dock])[0].score).toBe(1)
    expect(findLocationMatches({ name: 'Oakley DC', city: 'Joliet, IL' }, [dock])).toEqual([])
  })
})

describe('dwellMinutes — actual events only', () => {
  it('needs both timestamps, in order', () => {
    expect(dwellMinutes({ arrivedAt: '2026-09-01T10:00:00Z', departedAt: '2026-09-01T11:30:00Z' })).toBe(90)
    expect(dwellMinutes({ arrivedAt: '2026-09-01T10:00:00Z' })).toBeNull()
    expect(dwellMinutes({ arrivedAt: '2026-09-01T12:00:00Z', departedAt: '2026-09-01T11:30:00Z' })).toBeNull()
  })
})
