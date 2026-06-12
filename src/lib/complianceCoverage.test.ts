import { describe, it, expect } from 'vitest'
import {
  findEmploymentGaps,
  employmentMeetsCoverage,
  earliestEmploymentStart,
} from './schemas'

const ASOF = '2026-06-12'

describe('findEmploymentGaps', () => {
  it('returns no gaps for contiguous employment', () => {
    const gaps = findEmploymentGaps(
      [
        { fromDate: '2023-01-01', toDate: '2024-06-01' },
        { fromDate: '2024-06-10', toDate: null }, // present, 9-day handoff (< 30d)
      ],
      { asOf: ASOF },
    )
    expect(gaps).toHaveLength(0)
  })

  it('flags a gap > 30 days between jobs', () => {
    const gaps = findEmploymentGaps(
      [
        { fromDate: '2023-01-01', toDate: '2024-01-01' },
        { fromDate: '2024-04-01', toDate: ASOF }, // 91-day gap
      ],
      { asOf: ASOF },
    )
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject({ fromDate: '2024-01-01', toDate: '2024-04-01' })
    expect(gaps[0].days).toBeGreaterThan(30)
  })

  it('flags a trailing gap after the most recent job ends', () => {
    const gaps = findEmploymentGaps([{ fromDate: '2020-01-01', toDate: '2026-01-01' }], {
      asOf: ASOF,
    })
    expect(gaps).toHaveLength(1)
    expect(gaps[0].toDate).toBe(ASOF)
  })

  it('ignores overlapping intervals when computing gaps', () => {
    const gaps = findEmploymentGaps(
      [
        { fromDate: '2022-01-01', toDate: '2025-01-01' },
        { fromDate: '2023-01-01', toDate: ASOF }, // overlaps the first
      ],
      { asOf: ASOF },
    )
    expect(gaps).toHaveLength(0)
  })
})

describe('employmentMeetsCoverage', () => {
  it('passes when the earliest start reaches back the required years', () => {
    expect(
      employmentMeetsCoverage([{ fromDate: '2022-06-01' }], 3, ASOF),
    ).toBe(true)
  })

  it('fails when history is too recent', () => {
    expect(
      employmentMeetsCoverage([{ fromDate: '2025-01-01' }], 3, ASOF),
    ).toBe(false)
  })

  it('requires 10 years for CDL holders', () => {
    expect(employmentMeetsCoverage([{ fromDate: '2018-01-01' }], 10, ASOF)).toBe(false)
    expect(employmentMeetsCoverage([{ fromDate: '2015-01-01' }], 10, ASOF)).toBe(true)
  })
})

describe('earliestEmploymentStart', () => {
  it('returns the earliest fromDate', () => {
    expect(
      earliestEmploymentStart([{ fromDate: '2024-01-01' }, { fromDate: '2021-05-01' }]),
    ).toBe('2021-05-01')
  })
  it('returns null for empty history', () => {
    expect(earliestEmploymentStart([])).toBeNull()
  })
})
