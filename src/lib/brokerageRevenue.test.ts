// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { computeMonth, dirtyKeysForRecord, repKeyOf, type MonthPayload, type MonthSource, type RepSplit, type RollupRow, type SampleLite, type ShipmentLite } from './dashboardRollup'
import {
  inDivision, isBrokerageScope, monthChange, monthRows, monthRowsFromRep, monthsBetween, repMonthMatrix, repRows, tieOut, totalsOf, trailingMonths, NO_REP_LABEL,
} from './brokerageRevenue'

const DIVISIONS = [
  { code: 'BROKERAGE', parentId: null },
  { code: 'BROKERAGE_SPOT', parentId: 'BROKERAGE' },
  { code: 'ASSETS', parentId: null },
  { code: 'OWNER_OPERATOR', parentId: 'ASSETS' },
]
const NAMES = { byId: new Map([['ryne@bcatcorp.com', 'Ryne B'], ['grp-ivan', 'Ivan Cartage'], ['grp-bcat', 'BCAT']]) }

const ship = (id: string, over: Partial<ShipmentLite> = {}): ShipmentLite => ({ id, status: 'DELIVERED', pickupAppt: '2026-10-05T12:00:00Z', revDivision: 'BROKERAGE', ...over })
const sample = (shipmentId: string, date: string, rev: number, cost: number, over: Partial<SampleLite> = {}): SampleLite => ({
  shipmentId, date, revenueCents: rev, costCents: cost, profitCents: rev - cost, ...over,
})

interface Computed { row: RollupRow<MonthPayload>; rep: { month: string; rep: RepSplit } }
async function payload(month: string, shipments: ShipmentLite[], samples: SampleLite[]): Promise<Computed> {
  const src: MonthSource = {
    shipments: async () => shipments.filter((s) => s.pickupAppt?.startsWith(month)),
    loadsOf: async () => [],
    deliveredOrders: async () => [],
    samples: async () => samples.filter((s) => s.date.startsWith(month)),
    shipmentsByIds: async (ids) => shipments.filter((s) => ids.includes(s.id)),
  }
  const rep: RepSplit = {}
  const row = { id: `M:${month}`, schemaVersion: 1, computedAt: '2026-11-09T00:00:00Z', payload: await computeMonth(src, month, rep) }
  return { row, rep: { month, rep } }
}

describe('brokerage scope', () => {
  it('is the Brokerage division and anything under it, nothing else', () => {
    expect(isBrokerageScope('BROKERAGE|', DIVISIONS)).toBe(true)
    expect(isBrokerageScope('|BROKERAGE_SPOT', DIVISIONS)).toBe(true)
    expect(isBrokerageScope('ASSETS|OWNER_OPERATOR', DIVISIONS)).toBe(false)
    expect(isBrokerageScope('CAR_SHIPPING|', DIVISIONS)).toBe(false)
    expect(isBrokerageScope('|', DIVISIONS)).toBe(false)
  })
})

describe('month and rep aggregation', () => {
  const shipments = [
    ship('a'), ship('b', { salesRepId: 'ryne@bcatcorp.com' }), ship('c', { salesRepId: 'grp-ivan' }), ship('d', { salesRepCode: 'JANE DOE' }),
    ship('e', { revDivision: 'ASSETS', salesRepId: 'ryne@bcatcorp.com' }), ship('f', { voidedAt: '2026-10-10T00:00:00Z', salesRepId: 'ryne@bcatcorp.com' }),
    ship('g', { revDivision: null, revSubdivision: 'BROKERAGE_SPOT', salesRepId: 'grp-bcat' }),
  ]
  const samples = [
    sample('a', '2026-10-01', 100_000, 80_000),
    sample('b', '2026-10-02', 200_000, 150_000),
    sample('b', '2026-10-20', 50_000, 60_000, { salesRepId: 'ryne@bcatcorp.com' }),
    sample('c', '2026-10-15', 300_000, 270_000),
    sample('d', '2026-10-31', 120_000, 100_000),
    sample('e', '2026-10-05', 999_000, 1_000),
    sample('f', '2026-10-06', 777_000, 1_000),
    sample('g', '2026-10-07', 40_000, 30_000),
    sample('a', '2026-10-08', 5_000, 1_000, { excluded: true }),
    sample('a', '2026-11-02', 10_000, 4_000),
  ]

  it('adds the Brokerage rows per month: voided, excluded and other divisions are out', async () => {
    const rows = [await payload('2026-10', shipments, samples), await payload('2026-11', shipments, samples)].map((c) => c.row)
    const months = monthRows(rows, ['2026-09', '2026-10', '2026-11'], DIVISIONS)
    expect(months[0]).toMatchObject({ month: '2026-09', loads: 0, revenueCents: 0, marginBps: null })
    expect(months[1]).toMatchObject({ loads: 6, revenueCents: 810_000, expenseCents: 690_000, profitCents: 120_000, marginBps: 1481 })
    expect(months[2]).toMatchObject({ loads: 1, revenueCents: 10_000, expenseCents: 4_000, marginBps: 6000 })
    expect(totalsOf(months)).toMatchObject({ revenueCents: 820_000, expenseCents: 694_000, profitCents: 126_000 })
  })

  it('splits the same samples by rep, group reps and typed names as rows and "No sales rep" last, and ties to the month view', async () => {
    const both = [await payload('2026-10', shipments, samples), await payload('2026-11', shipments, samples)]
    const rows = both.map((c) => c.row)
    const months = ['2026-10', '2026-11']
    const byRep = repRows(both.map((c) => c.rep), months, DIVISIONS, NAMES)
    expect(byRep.map((r) => r.label)).toEqual(['Ryne B', 'Ivan Cartage', 'JANE DOE', 'BCAT', NO_REP_LABEL])
    const byLabel = Object.fromEntries(byRep.map((r) => [r.label, r]))
    expect(byLabel['Ryne B']).toMatchObject({ loads: 2, revenueCents: 250_000, expenseCents: 210_000, profitCents: 40_000, marginBps: 1600 })
    expect(byLabel['Ivan Cartage']).toMatchObject({ revenueCents: 300_000, profitCents: 30_000 })
    expect(byLabel[NO_REP_LABEL]).toMatchObject({ repKey: '', loads: 2, revenueCents: 110_000, expenseCents: 84_000 })
    const tie = tieOut(monthRows(rows, months, DIVISIONS), byRep)
    expect(tie).toEqual({ ok: true, revenueDiffCents: 0, expenseDiffCents: 0, loadsDiff: 0 })
  })

  it('keeps a "No sales rep" row even when every load has a rep, and a zero-revenue rep has no profit %', async () => {
    const only = [ship('x', { salesRepId: 'grp-bcat' })]
    const rows = [(await payload('2026-10', only, [sample('x', '2026-10-03', 0, 5_000)])).rep]
    const byRep = repRows(rows, ['2026-10'], DIVISIONS, NAMES)
    expect(byRep).toHaveLength(2)
    expect(byRep[1]).toMatchObject({ label: NO_REP_LABEL, loads: 0, revenueCents: 0, marginBps: null })
    expect(byRep[0]).toMatchObject({ label: 'BCAT', revenueCents: 0, profitCents: -5_000, marginBps: null })
  })

  it('counts every sample once in the rep split: its rep rows equal its day rows for any scope', async () => {
    const { row, rep } = await payload('2026-10', shipments, samples)
    const days = Object.values(row.payload.fin).flatMap((d) => Object.values(d)).reduce((a, f) => ({ n: a.n + f.n, rev: a.rev + f.rev, cost: a.cost + f.cost }), { n: 0, rev: 0, cost: 0 })
    const reps = Object.values(rep.rep).flatMap((d) => Object.values(d)).reduce((a, f) => ({ n: a.n + f.n, rev: a.rev + f.rev, cost: a.cost + f.cost }), { n: 0, rev: 0, cost: 0 })
    expect(reps).toEqual(days)
  })

  it('reports a rep difference when the rep rows do not add up to the month rows', () => {
    const base = { loads: 1, revenueCents: 100, expenseCents: 60, profitCents: 40, marginBps: 4000 }
    expect(tieOut([base], [{ ...base, revenueCents: 90 }]).ok).toBe(false)
  })

  it('sums the month view from the rep split alone, for a caller who may only see their own rep', async () => {
    const { rep } = await payload('2026-10', shipments, samples)
    const own = { month: rep.month, rep: Object.fromEntries(Object.entries(rep.rep).map(([scope, per]) => [scope, Object.fromEntries(Object.entries(per).filter(([k]) => k === 'i:ryne@bcatcorp.com'))])) }
    const [m] = monthRowsFromRep([own], ['2026-10'], DIVISIONS)
    expect(m).toMatchObject({ loads: 2, revenueCents: 250_000, expenseCents: 210_000 })
    expect(repRows([own], ['2026-10'], DIVISIONS, NAMES).map((r) => r.label)).toEqual(['Ryne B', NO_REP_LABEL])
  })
})

describe('rep keys', () => {
  it('prefers the sample rep id, then the shipment id, then the typed name, else none', () => {
    expect(repKeyOf({ salesRepId: 'a' }, { salesRepId: 'b', salesRepCode: 'X' })).toBe('i:a')
    expect(repKeyOf({}, { salesRepId: 'b', salesRepCode: 'X' })).toBe('i:b')
    expect(repKeyOf({}, { salesRepCode: ' X ' })).toBe('c:X')
    expect(repKeyOf({ salesRepId: '  ' }, undefined)).toBe('')
  })

  it('merges a rep that appears by profile id and by typed name into one row', async () => {
    const shipments = [ship('p', { salesRepId: 'ryne@bcatcorp.com' }), ship('q', { salesRepCode: 'ryne b' })]
    const rows = [(await payload('2026-10', shipments, [sample('p', '2026-10-02', 100, 50), sample('q', '2026-10-03', 100, 50)])).rep]
    const byRep = repRows(rows, ['2026-10'], DIVISIONS, NAMES)
    expect(byRep.filter((r) => r.repKey !== '')).toHaveLength(1)
    expect(byRep[0]).toMatchObject({ loads: 2, revenueCents: 200 })
  })
})

describe('month helpers', () => {
  it('lists months across a year boundary and trails 13 months ending now', () => {
    expect(monthsBetween('2026-11', '2027-02')).toEqual(['2026-11', '2026-12', '2027-01', '2027-02'])
    const t = trailingMonths('2026-11', 13)
    expect(t[0]).toBe('2025-11')
    expect(t).toHaveLength(13)
    expect(t[12]).toBe('2026-11')
  })
})

describe('rollup dirty keys for the rep split', () => {
  it('a rep change on a shipment dirties its pickup month and the next one (where its samples are booked)', () => {
    const before = { id: 's', pickupAppt: '2026-10-05T12:00:00Z', pickupMonth: '2026-10', salesRepCode: null }
    const after = { ...before, salesRepCode: 'JANE DOE' }
    expect(dirtyKeysForRecord('Shipment', before, after).sort()).toEqual(['LG:2026-10', 'M:2026-10', 'M:2026-11'])
  })
})

describe('rep by month matrix', () => {
  const f = (n: number, rev: number, cost: number) => ({ n, rev, cost, prof: rev - cost })
  const REP_MONTHS = [
    { month: '2026-10', rep: { 'BROKERAGE|': { 'i:ryne@bcatcorp.com': f(2, 200_000, 150_000), 'i:grp-ivan': f(1, 100_000, 90_000) }, 'ASSETS|': { 'i:ryne@bcatcorp.com': f(5, 900_000, 1) } } },
    { month: '2026-11', rep: { 'BROKERAGE|': { 'i:ryne@bcatcorp.com': f(3, 400_000, 300_000), '': f(1, 50_000, 60_000) }, 'CAR_SHIPPING|': { 'i:ryne@bcatcorp.com': f(1, 10_000, 5_000) } } },
  ]
  const MONTHS = ['2026-10', '2026-11']

  it('splits loads, revenue, expenses and profit by rep and month for one division, biggest profit first, no-rep last', () => {
    const m = repMonthMatrix(REP_MONTHS, MONTHS, DIVISIONS, NAMES, 'BROKERAGE')
    expect(m.reps.map((r) => r.label)).toEqual(['Ryne B', 'Ivan Cartage', NO_REP_LABEL])
    const ryne = m.reps[0]
    expect(ryne.byMonth.map((x) => [x.loads, x.revenueCents, x.expenseCents, x.profitCents])).toEqual([[2, 200_000, 150_000, 50_000], [3, 400_000, 300_000, 100_000]])
    expect(ryne.total).toMatchObject({ loads: 5, revenueCents: 600_000, expenseCents: 450_000, profitCents: 150_000, marginBps: 2500 })
    expect(m.totalsByMonth.map((x) => x.loads)).toEqual([3, 4])
    expect(m.grand).toMatchObject({ loads: 7, revenueCents: 750_000, profitCents: 150_000 })
  })

  it('re-cuts the same rows by division and drops reps with nothing in it', () => {
    const assets = repMonthMatrix(REP_MONTHS, MONTHS, DIVISIONS, NAMES, 'ASSETS')
    expect(assets.reps.map((r) => r.label)).toEqual(['Ryne B'])
    expect(assets.grand.loads).toBe(5)
    const all = repMonthMatrix(REP_MONTHS, MONTHS, DIVISIONS, NAMES, 'ALL')
    expect(all.grand.loads).toBe(7 + 5 + 1)
    expect(inDivision('CAR_SHIPPING|', DIVISIONS, 'CAR_SHIPPING')).toBe(true)
    expect(inDivision('|OWNER_OPERATOR', DIVISIONS, 'ASSETS')).toBe(false)
  })

  it('every month column of the Brokerage matrix equals the month view built from the same rows', () => {
    const m = repMonthMatrix(REP_MONTHS, MONTHS, DIVISIONS, NAMES, 'BROKERAGE')
    const monthView = monthRowsFromRep(REP_MONTHS, MONTHS, DIVISIONS)
    expect(tieOut(monthView, m.totalsByMonth).ok).toBe(true)
  })

  it('merges a rep known by profile id and by typed name, and ignores months outside the range', () => {
    const rows = [{ month: '2026-10', rep: { 'BROKERAGE|': { 'i:ryne@bcatcorp.com': f(1, 100, 50), 'c:Ryne B': f(1, 100, 50) } } }, { month: '2026-09', rep: { 'BROKERAGE|': { 'i:grp-ivan': f(9, 1, 1) } } }]
    const m = repMonthMatrix(rows, ['2026-10'], DIVISIONS, NAMES, 'BROKERAGE')
    expect(m.reps).toHaveLength(1)
    expect(m.reps[0].total.loads).toBe(2)
  })
})

describe('month over month change', () => {
  it('is a percent of the earlier month for money and a count for loads', () => {
    expect(monthChange(150, 100, 'money')).toEqual({ text: '+50%', dir: 'up' })
    expect(monthChange(50, 100, 'money')).toEqual({ text: '−50%', dir: 'down' })
    expect(monthChange(100, 100, 'money')).toEqual({ text: '0%', dir: 'flat' })
    expect(monthChange(7, 4, 'loads')).toEqual({ text: '+3', dir: 'up' })
    expect(monthChange(2, 5, 'loads')).toEqual({ text: '−3', dir: 'down' })
  })
  it('has nothing to compare against when the earlier month was zero or a loss', () => {
    expect(monthChange(100, 0, 'money')).toBeNull()
    expect(monthChange(100, -20, 'money')).toBeNull()
  })
})
