import { describe, expect, it } from 'vitest'
import {
  CARRIER_COLUMNS, SensitiveColumnsError, assertNoSensitiveHeaders, detectCarriersLayout, findSensitiveHeaders, parseCarrierRows, stripSensitiveColumns,
  type CarrierColumnKey,
} from './carriers'

// Synthetic rows only. CANARY values must never appear in any parsed output.
const SENSITIVE = ['Fed/SS #', 'Bank Account', 'Routing #', 'Account #']
const HEADERS = [...Object.values(CARRIER_COLUMNS), ...SENSITIVE]

function row(over: Partial<Record<CarrierColumnKey, string>> & { sens?: boolean } = {}): string[] {
  const base: Record<CarrierColumnKey, string> = {
    name: 'Blue Line Trucking', address: '9 Road', address2: '', city: 'Dayton', state: 'OH', zip: '45402', phone: '555-0111', fax: '', contact: 'Sam', payableTo: '',
    remitAddress: '', remitAddress2: '', remitCity: '', remitState: '', remitZip: '', remitZip4: '', phoneAccounting: '', isCarrier: 'Y', active: 'Y', mc: '700001',
    dot: '3000001', safetyRating: 'NONE', terms: '', quickPay: '', quickPayDays: '', quickPayPct: '', lastUpdate: '06/01/26', id: '900000001', factorId: '', ...over,
  }
  const sens = over.sens === false ? ['', '', '', ''] : ['CANARY-TAX', 'CANARY-BANK', 'CANARY-ROUTE', 'CANARY-ACCT']
  return [...(Object.keys(CARRIER_COLUMNS) as CarrierColumnKey[]).map((k) => base[k]), ...sens]
}

describe('carriers layout: sensitive columns', () => {
  it('finds the three sensitive headers and the wizard path refuses them', () => {
    expect(findSensitiveHeaders(HEADERS)).toEqual(['Fed/SS #', 'Bank Account', 'Routing #'])
    expect(() => assertNoSensitiveHeaders(HEADERS)).toThrow(SensitiveColumnsError)
    expect(() => assertNoSensitiveHeaders(Object.values(CARRIER_COLUMNS))).not.toThrow()
  })

  it('reports only counts of rows having each and copies no value anywhere', () => {
    const parsed = parseCarrierRows(HEADERS, [row(), row({ id: '900000002', mc: '700002', dot: '3000002', sens: false })])
    expect(parsed.counts.sensitiveRows).toEqual({ fedSs: 1, bankAccount: 1, routing: 1, accountNo: 1 })
    expect(JSON.stringify(parsed)).not.toContain('CANARY')
  })

  it('stripSensitiveColumns removes the columns and their values', () => {
    const stripped = stripSensitiveColumns(HEADERS, [row()])
    expect(stripped.headers).toEqual(Object.values(CARRIER_COLUMNS))
    expect(JSON.stringify(stripped)).not.toContain('CANARY')
    expect(parseCarrierRows(stripped.headers, stripped.rows).carriers).toHaveLength(1)
  })
})

describe('carriers layout: identity and merge', () => {
  it('detects the layout and reports missing columns', () => {
    expect(detectCarriersLayout(HEADERS).matches).toBe(true)
    expect(detectCarriersLayout(HEADERS.filter((h) => h !== 'MC #')).missing).toEqual(['MC #'])
  })

  it('merges rows that share an MC (or DOT) and keeps the other Aljex Carrier IDs as aliases', () => {
    const parsed = parseCarrierRows(HEADERS, [
      row({ id: '900000010', mc: '0700010', dot: '3000010', name: 'Alpha Freight', lastUpdate: '01/01/25' }),
      row({ id: '900000011', mc: '700010', dot: '', name: 'Alpha Freight Inc', lastUpdate: '05/05/26' }),
      row({ id: '900000012', mc: '', dot: '3000010', name: 'Alpha F', lastUpdate: '01/01/20' }),
    ])
    expect(parsed.carriers).toHaveLength(1)
    expect(parsed.carriers[0].id).toBe('900000011')
    expect(parsed.carriers[0].aliases).toEqual(['900000010', '900000012'])
    expect(parsed.carriers[0].dot).toBe('3000010')
    expect(parsed.mergeGroups).toEqual([{ id: '900000011', aliases: ['900000010', '900000012'], by: 'MC+DOT' }])
    expect(parsed.counts.rowsMerged).toBe(2)
  })

  it('never merges on name alone: same name, different MC/DOT stays two carriers and is only reported', () => {
    const parsed = parseCarrierRows(HEADERS, [row({ id: '900000020', mc: '700020', dot: '3000020' }), row({ id: '900000021', mc: '700021', dot: '3000021' })])
    expect(parsed.carriers).toHaveLength(2)
    expect(parsed.counts.sameNameDifferentCarrier).toBe(1)
  })

  it('rows without MC and DOT never merge with each other', () => {
    const parsed = parseCarrierRows(HEADERS, [row({ id: '900000030', mc: '', dot: '' }), row({ id: '900000031', mc: '', dot: '' })])
    expect(parsed.carriers).toHaveLength(2)
  })

  it('an inactive row merged with an active one yields an active carrier; all-inactive stays inactive', () => {
    const parsed = parseCarrierRows(HEADERS, [
      row({ id: '900000040', mc: '700040', active: 'N' }), row({ id: '900000041', mc: '700040', active: 'Y', lastUpdate: '01/01/20' }),
      row({ id: '900000042', mc: '700042', dot: '3000042', active: 'N' }),
    ])
    expect(parsed.carriers.map((c) => [c.id, c.active])).toEqual([['900000041', true], ['900000042', false]])
    expect(parsed.counts.inactive).toBe(1)
  })
})

describe('carriers layout: fields', () => {
  it('skips non-carrier vendors, counts factor ids, keeps quick pay only when flagged, rejects repeated ids', () => {
    const parsed = parseCarrierRows(HEADERS, [
      row({ id: '900000050', mc: '700050', dot: '3000050', factorId: '123456789', quickPay: 'Y', quickPayDays: '10', quickPayPct: '2.00', terms: '30' }),
      row({ id: '900000051', mc: '700051', dot: '3000051', quickPay: '', quickPayDays: '10', quickPayPct: '6.00' }),
      row({ id: '900000052', mc: '', dot: '', isCarrier: 'N' }),
      row({ id: '900000050', mc: '700099' }),
    ])
    expect(parsed.carriers).toHaveLength(2)
    expect(parsed.carriers[0]).toMatchObject({ factorId: '123456789', termsDays: 30, quickPay: { eligible: true, days: 10, pct: '2.00' } })
    expect(parsed.carriers[1].quickPay).toEqual({ eligible: false, days: null, pct: '' })
    expect(parsed.counts).toMatchObject({ otherVendors: 1, withFactorId: 1, quickPay: 1, rejected: 1 })
  })
})
