import { describe, it, expect } from 'vitest'
import type { ShipmentRecord } from '@/types/tms'
import { currentMonth, mergeShipmentSets, monthsCovering, OPEN_SHIPMENT_STATUSES } from './shipmentWindows'

describe('monthsCovering', () => {
  it('pads one month each side and crosses a year boundary', () => {
    expect(monthsCovering('2026-01-15', '2026-01-20')).toEqual(['2025-12', '2026-01', '2026-02'])
    expect(monthsCovering('2026-11-01', '2026-12-31')).toEqual(['2026-10', '2026-11', '2026-12', '2027-01'])
  })
  it('handles from === to without padding', () => {
    expect(monthsCovering('2026-11-30', '2026-11-01', 0)).toEqual(['2026-11'])
  })
  it('treats from > to as the swapped range', () => {
    expect(monthsCovering('2026-12-01', '2026-10-01', 0)).toEqual(['2026-10', '2026-11', '2026-12'])
  })
  it('returns [] for unparseable input rather than a bogus window', () => {
    expect(monthsCovering('', '2026-11-01')).toEqual([])
    expect(monthsCovering('2026-13-01', '2026-11-01')).toEqual([])
  })
})

describe('OPEN_SHIPMENT_STATUSES', () => {
  // The schema enum is the source of truth: a status added there without being classified
  // open/terminal here would silently fall out of the working set.
  it('is the ShipmentStatus enum minus DELIVERED and CANCELED', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('amplify/data/resource.ts', 'utf8')
    const start = src.indexOf("'DRAFT', 'TENDER_PENDING'")
    const block = src.slice(start, src.indexOf(']', start))
    const schemaEnum = [...block.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1])
    expect([...OPEN_SHIPMENT_STATUSES, 'DELIVERED', 'CANCELED'].sort()).toEqual([...schemaEnum].sort())
  })
})

describe('mergeShipmentSets', () => {
  const s = (id: string, updatedAt: string, status = 'OPEN') => ({ id, updatedAt, status }) as unknown as ShipmentRecord
  it('dedupes by id, newest updatedAt wins, later set wins ties', () => {
    const merged = mergeShipmentSets(
      [s('a', '2026-01-02', 'OLD'), s('b', '2026-01-01')],
      [s('a', '2026-01-01', 'OLDER'), s('b', '2026-01-01', 'TIE')],
    )
    expect(merged.find((r) => r.id === 'a')?.status).toBe('OLD')
    expect(merged.find((r) => r.id === 'b')?.status).toBe('TIE')
    expect(merged).toHaveLength(2)
  })
})

describe('currentMonth', () => {
  it('uses the UTC month (the pickupMonth key is the ISO string prefix)', () => {
    expect(currentMonth(new Date('2026-10-31T23:30:00Z'))).toBe('2026-10')
    expect(currentMonth(new Date('2026-11-01T00:30:00Z'))).toBe('2026-11')
  })
})
