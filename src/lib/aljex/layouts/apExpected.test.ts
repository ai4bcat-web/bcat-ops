import { describe, expect, it } from 'vitest'
import { parseApExpectedCsv } from './apExpected'
import { apExpectedCsv } from './apFilesFixture'

describe('AP_EXPECTED layout', () => {
  const rows = [
    { pro: '900101', cents: 40_000, ship: '10/26/26', carrierId: '900000001' },
    { pro: '900102', cents: 55_050, ship: '08/04/26' },
    { pro: '900103', cents: 40_000, ship: '06/13/25', carrierId: '900000001' }, // stale
    { pro: '900104', cents: 100_000, ship: '01/22/24' }, // stale, repeated below
    { pro: '900104', cents: 100_000, ship: '01/22/24' },
    { pro: '900105', cents: 12_345, ship: '11/05/26' },
    { pro: '900105', cents: 12_345, ship: '11/05/26' }, // repeated, not stale
  ]
  const p = parseApExpectedCsv(apExpectedCsv(rows), { cutoff: '2026-11-07' })

  it('drops every row shipped more than 12 months before the cutoff and only counts it', () => {
    expect(p.staleBefore).toBe('2025-11-07')
    expect(p.droppedStaleCount).toBe(3)
    expect(p.droppedStaleCents).toBe(40_000 + 200_000)
    expect(p.expected.map((e) => e.pro)).toEqual(['900101', '900102', '900105'])
  })

  it('keeps one row of a repeated PRO and reports the rest', () => {
    expect(p.duplicates.map((d) => d.pro)).toEqual(['900105'])
    expect(p.expectedCents).toBe(40_000 + 55_050 + 12_345)
  })

  it('reports a row with no Carrier ID', () => {
    expect(p.findings.filter((f) => f.code === 'AP_EXPECTED_NO_CARRIER_ID').map((f) => f.pro)).toEqual(['900102', '900105'])
  })
})
