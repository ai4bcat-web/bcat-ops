import { describe, it, expect } from 'vitest'
import { startOfDay, endOfDay, format } from 'date-fns'
import { filterByDate, getWeeksInRange } from './fuelDateUtils'
import type { FuelTransaction } from '@/lib/apiClient'

// Use new Date(year, month0, day) everywhere — avoids UTC-midnight parsing that
// shifts local date in negative-offset timezones when date-only strings are used.

function makeTx(transactionDate: string): FuelTransaction {
  return {
    id: transactionDate,
    transactionDate,
    cardNumber: '00000',
    invoiceNumber: '0',
    unitNumber: '0',
    driverName: '',
    odometer: null,
    locationName: '',
    city: '',
    state: '',
    fees: 0,
    fuelType: 'ULSD',
    itemCategory: 'FUEL',
    pricePerUnit: 5,
    quantity: 10,
    amount: 50,
    currency: 'USD',
    sourceLineNumber: 1,
    truckId: null,
    createdAt: '',
    updatedAt: '',
  }
}

// ── filterByDate ───────────────────────────────────────────────────────────────

describe('filterByDate', () => {
  // local 2026-05-24 through 2026-05-26
  const start = startOfDay(new Date(2026, 4, 24))
  const end   = endOfDay(new Date(2026, 4, 26))

  it('includes a transaction on the start boundary date', () => {
    const result = filterByDate([makeTx('2026-05-24')], start, end)
    expect(result).toHaveLength(1)
    expect(result[0].transactionDate).toBe('2026-05-24')
  })

  it('includes a transaction on the end boundary date', () => {
    const result = filterByDate([makeTx('2026-05-26')], start, end)
    expect(result).toHaveLength(1)
    expect(result[0].transactionDate).toBe('2026-05-26')
  })

  it('excludes a transaction one day before start', () => {
    expect(filterByDate([makeTx('2026-05-23')], start, end)).toHaveLength(0)
  })

  it('excludes a transaction one day after end', () => {
    expect(filterByDate([makeTx('2026-05-27')], start, end)).toHaveLength(0)
  })

  it('filters a mixed list correctly', () => {
    const txs = ['2026-05-23', '2026-05-24', '2026-05-25', '2026-05-26', '2026-05-27'].map(makeTx)
    const result = filterByDate(txs, start, end)
    expect(result.map((t) => t.transactionDate)).toEqual(['2026-05-24', '2026-05-25', '2026-05-26'])
  })

  // T12:00:00 guards against UTC-midnight shifts in any US timezone (UTC-4 through UTC-10).
  // Without the noon suffix, new Date('2026-05-24') in UTC-10 becomes 2026-05-23 local,
  // causing the row to silently drop from the range.
  it('T12:00:00 parsing keeps 2026-05-24 inside a local 5/24 range regardless of timezone', () => {
    // Simulate what filterByDate does internally for a 5/24 transaction
    const d = new Date('2026-05-24T12:00:00')  // local noon — never near midnight boundary
    expect(d >= start && d <= end).toBe(true)
  })
})

// ── getWeeksInRange ────────────────────────────────────────────────────────────

describe('getWeeksInRange', () => {
  // Apr 26, 2026 and May 24, 2026 are both Sundays (28 days apart = 4 weeks).
  // The last-30-days range starting Apr 26 is the key production range.
  const start = startOfDay(new Date(2026, 3, 26))  // Apr 26 (month 3 = April, 0-indexed)
  const end   = endOfDay(new Date(2026, 4, 26))    // May 26

  it('Sunday 5/24 starts its own week bucket (not rolled into the prior 5/17 bucket)', () => {
    const weeks = getWeeksInRange(start, end)
    const bucketStarts = weeks.map((w) => format(w.wStart, 'yyyy-MM-dd'))
    expect(bucketStarts).toContain('2026-05-24')
    expect(bucketStarts).toContain('2026-05-17')
  })

  it('the 5/17 week bucket ends on 5/23 (Saturday)', () => {
    const weeks = getWeeksInRange(start, end)
    const bucket517 = weeks.find((w) => format(w.wStart, 'yyyy-MM-dd') === '2026-05-17')!
    expect(bucket517).toBeDefined()
    expect(format(bucket517.wEnd, 'yyyy-MM-dd')).toBe('2026-05-23')
  })

  it('a transaction dated 2026-05-24 (Sunday) falls in the 5/24 bucket, not 5/17', () => {
    const weeks  = getWeeksInRange(start, end)
    const d      = new Date('2026-05-24T12:00:00')
    const bucket = weeks.find((w) => d >= w.wStart && d <= w.wEnd)
    expect(bucket).toBeDefined()
    expect(format(bucket!.wStart, 'yyyy-MM-dd')).toBe('2026-05-24')
  })

  it('a transaction dated 2026-05-25 (Monday) falls in the 5/24 bucket', () => {
    const weeks  = getWeeksInRange(start, end)
    const d      = new Date('2026-05-25T12:00:00')
    const bucket = weeks.find((w) => d >= w.wStart && d <= w.wEnd)
    expect(bucket).toBeDefined()
    expect(format(bucket!.wStart, 'yyyy-MM-dd')).toBe('2026-05-24')
  })

  it('last-30 range produces 5 week buckets', () => {
    const weeks = getWeeksInRange(start, end)
    expect(weeks).toHaveLength(5)
  })

  it('first bucket label starts with "4/26" (Apr 26 is the range start and a Sunday)', () => {
    const weeks = getWeeksInRange(start, end)
    expect(weeks[0].label).toMatch(/^4\/26/)
  })

  it('last bucket label clips to "5/26" (range end) not "5/30" (week end)', () => {
    const weeks = getWeeksInRange(start, end)
    const last = weeks[weeks.length - 1]
    expect(last.label).toContain('5/26')
  })
})
