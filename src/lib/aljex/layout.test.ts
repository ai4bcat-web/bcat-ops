import { describe, expect, it } from 'vitest'
import {
  ALJEX_HEADERS_V1,
  buildLayout,
  detectLayout,
  GROUP_COUNTS,
  LAYOUT_V1,
  LAYOUT_V1_ID,
  SCALAR_SPECS,
  UnknownLayoutError,
} from './layout'
// The profiler builder's dictionary (the other twin). Any drift between the two fails here.
import { SCALAR_SPECS as MJS_SPECS, groupColumns, scalarColumns } from '../../../scripts/lib/aljexColumns.mjs'
import { mapAljexRow } from './mapRow'

describe('layout parity with scripts/lib/aljexColumns.mjs', () => {
  const headers = [...ALJEX_HEADERS_V1]

  it('has the 486 export columns', () => {
    expect(headers).toHaveLength(486)
  })

  it('mirrors the scalar dictionary exactly', () => {
    expect(SCALAR_SPECS.map((s) => [...s])).toEqual(MJS_SPECS.map((s: readonly string[]) => [...s]))
  })

  it('discovers the same scalar column indexes', () => {
    const { byKey } = scalarColumns(headers)
    expect(LAYOUT_V1.scalar).toEqual(byKey)
  })

  it('discovers the same repeated-group indexes and counts', () => {
    const g = groupColumns(headers)
    const strip = (arr: Array<{ ordinal: number; fields: object }>) => arr.map(({ ordinal, fields }) => ({ ordinal, fields }))
    expect(LAYOUT_V1.stops).toEqual(strip(g.stops))
    expect(LAYOUT_V1.charges).toEqual(strip(g.charges))
    expect(LAYOUT_V1.accessorials).toEqual(strip(g.accessorials))
    expect(LAYOUT_V1.customerPayments).toEqual(strip(g.customerPayments))
    expect(LAYOUT_V1.projectedExpenses).toEqual(strip(g.projectedExpenses))
    expect(LAYOUT_V1.paidExpenses).toEqual(strip(g.paidExpenses))
    expect(LAYOUT_V1.commissions).toEqual(strip(g.commissions))
    expect(LAYOUT_V1.additionalRefs).toEqual(g.additionalRefs.map((a: { start: number }) => a.start))
    expect(LAYOUT_V1.stops).toHaveLength(GROUP_COUNTS.stops)
    expect(LAYOUT_V1.charges).toHaveLength(GROUP_COUNTS.charges)
    expect(LAYOUT_V1.accessorials).toHaveLength(GROUP_COUNTS.accessorials)
    expect(LAYOUT_V1.customerPayments).toHaveLength(GROUP_COUNTS.customerPayments)
    expect(LAYOUT_V1.projectedExpenses).toHaveLength(GROUP_COUNTS.projectedExpenses)
    expect(LAYOUT_V1.paidExpenses).toHaveLength(GROUP_COUNTS.paidExpenses)
    expect(LAYOUT_V1.commissions).toHaveLength(GROUP_COUNTS.commissions)
    expect(LAYOUT_V1.additionalRefs).toHaveLength(GROUP_COUNTS.additionalRefs)
  })

  it('puts the documented columns where the plan says (1-based 2, 14, 53, 123, 195, 291, 425, 427)', () => {
    const s = LAYOUT_V1.scalar
    expect([s.proNo, s.dispatchStatus, s.lhRevenue, s.invoiceAmount, s.driverName, s.carrierMc].map((i) => i + 1)).toEqual([2, 14, 53, 123, 425, 427])
    expect(LAYOUT_V1.stops[0].fields.marker + 1).toBe(195)
    expect(LAYOUT_V1.charges[0].fields.code + 1).toBe(291)
  })
})

describe('detectLayout', () => {
  it('recognises the known header row', () => {
    expect(detectLayout(ALJEX_HEADERS_V1).id).toBe(LAYOUT_V1_ID)
  })
  it('refuses a different column count', () => {
    expect(() => detectLayout(ALJEX_HEADERS_V1.slice(0, 485))).toThrow(UnknownLayoutError)
    expect(() => detectLayout([...ALJEX_HEADERS_V1, 'New Column'])).toThrow(UnknownLayoutError)
  })
  it('refuses a renamed sentinel column even when the count matches', () => {
    for (const index of [1, 13, 122, 290, 426]) {
      const h = [...ALJEX_HEADERS_V1]
      h[index] = 'Renamed'
      expect(() => detectLayout(h)).toThrow(UnknownLayoutError)
    }
  })
  it('tolerates case/punctuation differences in a sentinel header', () => {
    const h = [...ALJEX_HEADERS_V1]
    h[1] = 'PRO #'
    expect(detectLayout(h).id).toBe(LAYOUT_V1_ID)
  })
  it('buildLayout refuses a header row that lacks a required column', () => {
    const h = ALJEX_HEADERS_V1.map((x) => (x === 'Bal Due' ? 'Balance' : x))
    expect(() => buildLayout(h, 'x')).toThrow(/missing columns.*balDue/)
  })
})

describe('positional extraction never reads a duplicated header by name', () => {
  it('maps each repeated Name/City/Code/Description/Rate cell from its own position', () => {
    const cells = new Array(486).fill('')
    const mark = (i: number) => `v${i}`
    for (let i = 0; i < 486; i++) cells[i] = mark(i)
    // numeric/money/date columns must hold parseable values for the check below
    const row = mapAljexRow(
      cells.map((v, i) => (/^(Weight|Rate|Extension)$/.test(ALJEX_HEADERS_V1[i]) ? '1.00' : v)),
      LAYOUT_V1,
      { rowNumber: 1 },
    )
    // stop blocks: every block's Name is its own column, in order
    const blocks = LAYOUT_V1.stops
    expect(blocks).toHaveLength(12)
    const all = [row.customer.name, row.billTo.name]
    expect(all).toEqual([mark(LAYOUT_V1.scalar.customerName), mark(LAYOUT_V1.scalar.billToName)])
    expect(new Set(blocks.map((b) => b.fields.name)).size).toBe(12)
    // charge descriptions come from the 21 distinct Description columns
    expect(row.charges.map((c) => c.description)).toEqual(LAYOUT_V1.charges.map((c) => mark(c.fields.description)))
    expect(row.charges.map((c) => c.code)).toEqual(LAYOUT_V1.charges.map((c) => mark(c.fields.code)))
    // the pickup/consignee scalars are not the stop-block `City`
    expect(row.stops[0].city).toBe(mark(LAYOUT_V1.scalar.pickupCity))
    expect(row.stops[row.stops.length - 1].city).toBe(mark(LAYOUT_V1.scalar.consigneeCity))
  })
})
