import { describe, it, expect } from 'vitest'
import {
  commissionReport,
  monthsBetween,
  pipelineCounts,
  profitReport,
  quoteFunnel,
  reportCsv,
} from './reporting'
import type { CommissionRecord, LaneRateSampleRecord, ReportRow } from '../types/tms'

const NOW = '2026-03-01T12:00:00.000Z'

let seq = 0
const sample = (over: Partial<LaneRateSampleRecord>): LaneRateSampleRecord => {
  seq += 1
  const date = over.date ?? '2026-01-10'
  return {
    id: `lrs:load-${seq}`,
    laneKey: 'CHICAGO|IL>DANVILLE|IL',
    loadId: `load-${seq}`,
    shipmentId: `ship-${seq}`,
    source: 'LOAD',
    sampledAt: NOW,
    version: 1,
    customerId: 'cust-1',
    customerName: 'Batory',
    carrierId: 'car-1',
    carrierName: 'Zippy LLC',
    assignmentKind: 'CARRIER',
    divisionKey: 'BCAT',
    revenueCents: 100_000,
    costCents: 80_000,
    miles: 500,
    ...over,
    date,
    sampleMonth: over.sampleMonth ?? date.slice(0, 7),
  }
}

/** Two reps, two customers, one own-asset leg, one excluded load, one out of window. */
const fleet = (): LaneRateSampleRecord[] => [
  sample({ date: '2026-01-10', customerRepId: 'rep-a', carrierRepId: 'rep-x' }),
  sample({
    date: '2026-02-05',
    customerRepId: 'rep-a',
    carrierRepId: 'rep-y',
    customerId: 'cust-2',
    customerName: 'Acme',
    carrierId: 'car-2',
    carrierName: 'Haulers Inc',
    revenueCents: 200_000,
    costCents: 150_000,
    profitCents: 50_000,
    miles: 1_000,
  }),
  sample({
    date: '2026-02-20',
    customerRepId: 'rep-b',
    assignmentKind: 'OWN_ASSET',
    carrierId: null,
    carrierName: null,
    revenueCents: 50_000,
    costCents: 0,
    miles: 100,
  }),
  sample({ date: '2026-02-11', customerRepId: 'rep-a', excluded: true, revenueCents: 900_000 }),
  sample({ date: '2025-12-30', customerRepId: 'rep-a', revenueCents: 700_000 }),
]

const WINDOW = { from: '2026-01', to: '2026-02' } as const

describe('monthsBetween', () => {
  it('lists every month inclusive, across a year roll', () => {
    expect(monthsBetween('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02'])
  })

  it('accepts full dates and keeps their months', () => {
    expect(monthsBetween('2026-01-31', '2026-03-01')).toEqual(['2026-01', '2026-02', '2026-03'])
  })

  it('is a single month when both ends are the same month', () => {
    expect(monthsBetween('2026-02-01', '2026-02-28')).toEqual(['2026-02'])
  })

  it('has no months when the range runs backwards or cannot be read', () => {
    expect(monthsBetween('2026-03', '2026-01')).toEqual([])
    expect(monthsBetween('not-a-month', '2026-01')).toEqual([])
    expect(monthsBetween('2026-01', '2026-13')).toEqual([])
  })

  it('caps a runaway range at five years', () => {
    const months = monthsBetween('2000-01', '2030-01')
    expect(months).toHaveLength(60)
    expect(months[0]).toBe('2000-01')
    expect(months[59]).toBe('2004-12')
  })
})

describe('profitReport', () => {
  it('groups by rep, labelling through the staff directory', () => {
    const report = profitReport(fleet(), {
      ...WINDOW,
      groupBy: 'REP',
      staffNames: { 'rep-a': 'Ada Lane' },
    })
    expect(report.rows.map((r) => [r.key, r.label, r.loads])).toEqual([
      ['rep-a', 'Ada Lane', 2],
      ['rep-b', 'rep-b', 1],
    ])
  })

  it('sums each group and leaves the totals equal to the rows', () => {
    const report = profitReport(fleet(), { ...WINDOW, groupBy: 'REP' })
    const ada = report.rows.find((r) => r.key === 'rep-a')
    expect(ada).toMatchObject({
      loads: 2,
      revenueCents: 300_000,
      costCents: 230_000,
      profitCents: 70_000,
      miles: 1_500,
      ownFleet: 0,
    })
    expect(ada?.marginBps).toBe(2333)
    expect(ada?.rpmCents).toBe(200)
    expect(ada?.cpmCents).toBe(153)

    const sum = (pick: (row: ReportRow) => number) => report.rows.reduce((t, r) => t + pick(r), 0)
    expect(report.totals).toMatchObject({
      key: 'TOTAL',
      label: 'Total',
      loads: sum((r) => r.loads),
      revenueCents: sum((r) => r.revenueCents),
      costCents: sum((r) => r.costCents),
      profitCents: sum((r) => r.profitCents),
      miles: sum((r) => r.miles),
      ownFleet: sum((r) => r.ownFleet),
    })
  })

  it('skips excluded samples and says how many', () => {
    const report = profitReport(fleet(), { ...WINDOW, groupBy: 'REP' })
    expect(report.excluded).toBe(1)
    expect(report.totals.loads).toBe(3)
    expect(report.totals.revenueCents).toBe(350_000)
  })

  it('ignores samples outside the window, month ends included', () => {
    const january = profitReport(fleet(), { from: '2026-01', to: '2026-01', groupBy: 'REP' })
    expect(january.totals.loads).toBe(1)

    const toTheDay = profitReport(fleet(), { from: '2026-02-05', to: '2026-02-19', groupBy: 'REP' })
    expect(toTheDay.totals.loads).toBe(1)
    expect(toTheDay.totals.revenueCents).toBe(200_000)
  })

  it('counts own-asset legs in revenue and flags them as own fleet', () => {
    const report = profitReport(fleet(), { ...WINDOW, groupBy: 'CARRIER' })
    const own = report.rows.find((r) => r.key === 'OWN_FLEET')
    expect(own).toMatchObject({ label: 'Own fleet', loads: 1, revenueCents: 50_000, ownFleet: 1 })
    // Ranked by profit: the own-asset leg ties Haulers at 50_000 and sorts by label.
    expect(report.rows.map((r) => r.key)).toEqual(['car-2', 'OWN_FLEET', 'car-1'])
    expect(report.totals.ownFleet).toBe(1)
  })

  it('groups by customer on the id and labels with the name', () => {
    const report = profitReport(fleet(), { ...WINDOW, groupBy: 'CUSTOMER' })
    expect(report.rows.map((r) => [r.key, r.label, r.loads])).toEqual([
      ['cust-1', 'Batory', 2],
      ['cust-2', 'Acme', 1],
    ])
  })

  it('groups by month in calendar order, not by profit', () => {
    const report = profitReport(fleet(), { ...WINDOW, groupBy: 'MONTH' })
    expect(report.rows.map((r) => r.key)).toEqual(['2026-01', '2026-02'])
    expect(report.rows[1].loads).toBe(2)
  })

  it('falls back to the sample date when a month was never stamped', () => {
    const report = profitReport([sample({ date: '2026-02-09', sampleMonth: null })], {
      ...WINDOW,
      groupBy: 'MONTH',
    })
    expect(report.rows.map((r) => r.key)).toEqual(['2026-02'])
  })

  it('files a missing group value under Unassigned', () => {
    const report = profitReport([sample({ date: '2026-01-05', teamKey: null })], {
      ...WINDOW,
      groupBy: 'TEAM',
    })
    expect(report.rows[0]).toMatchObject({ key: '', label: 'Unassigned', loads: 1 })
  })

  it('derives profit only when the sample does not carry one', () => {
    const report = profitReport(
      [
        sample({ date: '2026-01-05', revenueCents: 100_000, costCents: 90_000 }),
        sample({ date: '2026-01-06', revenueCents: 100_000, costCents: 90_000, profitCents: 1_000 }),
      ],
      { ...WINDOW, groupBy: 'DIVISION' },
    )
    expect(report.rows[0].profitCents).toBe(11_000)
  })

  it('reports no margin rather than NaN when there is no revenue', () => {
    const report = profitReport([sample({ date: '2026-01-05', revenueCents: 0, costCents: 0 })], {
      ...WINDOW,
      groupBy: 'DIVISION',
    })
    expect(report.rows[0].marginBps).toBeNull()
    expect(report.totals.marginBps).toBeNull()
    expect(report.rows[0].profitCents).toBe(0)
  })

  it('reports no rate per mile rather than Infinity when there is no mileage', () => {
    const report = profitReport([sample({ date: '2026-01-05', miles: null })], {
      ...WINDOW,
      groupBy: 'DIVISION',
    })
    expect(report.rows[0].miles).toBe(0)
    expect(report.rows[0].rpmCents).toBeNull()
    expect(report.rows[0].cpmCents).toBeNull()
    expect(report.totals.rpmCents).toBeNull()
  })

  it('rounds a negative margin away from zero', () => {
    const report = profitReport(
      [sample({ date: '2026-01-05', revenueCents: 100_000, costCents: 100_005, profitCents: null })],
      { ...WINDOW, groupBy: 'DIVISION' },
    )
    expect(report.rows[0].profitCents).toBe(-5)
    expect(report.rows[0].marginBps).toBe(-1)
  })

  it('narrows to the filtered customer', () => {
    const report = profitReport(fleet(), {
      ...WINDOW,
      groupBy: 'REP',
      filters: { customerId: 'cust-2' },
    })
    expect(report.totals.loads).toBe(1)
    expect(report.rows.map((r) => r.key)).toEqual(['rep-a'])
  })

  it('matches a rep filter on either side of the load', () => {
    const asCustomerRep = profitReport(fleet(), {
      ...WINDOW,
      groupBy: 'CUSTOMER',
      filters: { repId: 'rep-b' },
    })
    expect(asCustomerRep.totals.loads).toBe(1)

    const asCarrierRep = profitReport(fleet(), {
      ...WINDOW,
      groupBy: 'CUSTOMER',
      filters: { repId: 'rep-y' },
    })
    expect(asCarrierRep.totals.loads).toBe(1)
    expect(asCarrierRep.totals.revenueCents).toBe(200_000)

    const nobody = profitReport(fleet(), { ...WINDOW, groupBy: 'CUSTOMER', filters: { repId: 'rep-z' } })
    expect(nobody.rows).toEqual([])
    expect(nobody.totals.loads).toBe(0)
  })

  it('applies every filter that is set, and ignores the ones that are not', () => {
    const base = fleet()
    expect(
      profitReport(base, {
        ...WINDOW,
        groupBy: 'CUSTOMER',
        filters: { divisionKey: 'BCAT', repId: 'rep-a', customerId: 'cust-2' },
      }).totals.loads,
    ).toBe(1)
    expect(
      profitReport(base, {
        ...WINDOW,
        groupBy: 'CUSTOMER',
        filters: { divisionKey: 'OTHER', repId: 'rep-a' },
      }).totals.loads,
    ).toBe(0)
    expect(
      profitReport(base, { ...WINDOW, groupBy: 'CUSTOMER', filters: { divisionKey: null, mode: null } })
        .totals.loads,
    ).toBe(3)
  })

  it('is an empty report, never a NaN one, when nothing is in scope', () => {
    const report = profitReport([], { ...WINDOW, groupBy: 'REP' })
    expect(report.rows).toEqual([])
    expect(report.totals).toMatchObject({
      loads: 0,
      revenueCents: 0,
      profitCents: 0,
      marginBps: null,
      rpmCents: null,
      cpmCents: null,
    })
  })
})

describe('reportCsv', () => {
  it('writes the group column, the money and the totals line', () => {
    const report = profitReport(fleet(), { ...WINDOW, groupBy: 'CUSTOMER' })
    const lines = reportCsv(report.rows, report.totals, 'Customer').split('\n')
    expect(lines[0]).toBe(
      '"Customer","Loads","Revenue","Cost","Profit","Margin %","Miles","RPM","CPM","Own fleet"',
    )
    expect(lines).toHaveLength(4)
    expect(lines[1]).toBe('"Batory","2","1500.00","800.00","700.00","46.7","600","2.50","1.33","1"')
    expect(lines[2]).toBe('"Acme","1","2000.00","1500.00","500.00","25.0","1000","2.00","1.50","0"')
    expect(lines[3]).toBe('"Total","3","3500.00","2300.00","1200.00","34.3","1600","2.19","1.44","1"')
  })

  it('quotes a name carrying a comma and doubles an embedded quote', () => {
    const report = profitReport(
      [sample({ date: '2026-01-05', customerId: 'cust-9', customerName: 'Zippy, "Fast" LLC' })],
      { ...WINDOW, groupBy: 'CUSTOMER' },
    )
    const line = reportCsv(report.rows, report.totals, 'Customer').split('\n')[1]
    expect(line.startsWith('"Zippy, ""Fast"" LLC",')).toBe(true)
    expect(line.split(',')).toHaveLength(11)
  })

  it('leaves an undefined margin and rate per mile empty rather than zero', () => {
    const report = profitReport([sample({ date: '2026-01-05', revenueCents: 0, costCents: 0, miles: 0 })], {
      ...WINDOW,
      groupBy: 'CUSTOMER',
    })
    expect(reportCsv(report.rows, report.totals, 'Customer').split('\n')[1]).toBe(
      '"Batory","1","0.00","0.00","0.00","","0","","","0"',
    )
  })
})

describe('pipelineCounts', () => {
  it('counts each rung, busiest first and ties alphabetical', () => {
    expect(
      pipelineCounts([
        { status: 'BOOKED' },
        { status: 'SOURCING' },
        { status: 'BOOKED' },
        { status: 'DELIVERED' },
        { status: 'SOURCING' },
        { status: null },
      ]),
    ).toEqual([
      { status: 'BOOKED', count: 2 },
      { status: 'SOURCING', count: 2 },
      { status: '', count: 1 },
      { status: 'DELIVERED', count: 1 },
    ])
  })

  it('counts nothing as nothing', () => {
    expect(pipelineCounts([])).toEqual([])
  })
})

describe('quoteFunnel', () => {
  it('splits sent quotes into won, lost and still out', () => {
    const funnel = quoteFunnel([
      { status: 'WON', sentAt: '2026-02-01T00:00:00.000Z', amountCents: 120_000 },
      { status: 'WON', sentAt: '2026-02-02T00:00:00.000Z', amountCents: 80_000 },
      { status: 'LOST', sentAt: '2026-02-03T00:00:00.000Z' },
      { status: 'PASS', sentAt: '2026-02-04T00:00:00.000Z' },
      { status: 'SENT', sentAt: '2026-02-05T00:00:00.000Z' },
      { status: 'DRAFT', sentAt: null },
    ])
    expect(funnel).toMatchObject({ sent: 5, won: 2, lost: 2, open: 1, wonCents: 200_000 })
    expect(funnel.winRateBps).toBe(5_000)
  })

  it('has no win rate until something is decided', () => {
    const funnel = quoteFunnel([{ status: 'SENT', sentAt: '2026-02-05T00:00:00.000Z' }])
    expect(funnel.winRateBps).toBeNull()
    expect(funnel.medianHoursToReply).toBeNull()
    expect(funnel.open).toBe(1)
  })

  it('rounds the win rate half away from zero', () => {
    const funnel = quoteFunnel([
      { status: 'WON', sentAt: '2026-02-01T00:00:00.000Z' },
      { status: 'LOST', sentAt: '2026-02-01T00:00:00.000Z' },
      { status: 'LOST', sentAt: '2026-02-01T00:00:00.000Z' },
    ])
    expect(funnel.winRateBps).toBe(3_333)
  })

  it('medians the reply time of the quotes that were answered', () => {
    const funnel = quoteFunnel([
      { status: 'WON', sentAt: '2026-02-01T00:00:00.000Z', respondedAt: '2026-02-01T02:00:00.000Z' },
      { status: 'LOST', sentAt: '2026-02-01T00:00:00.000Z', respondedAt: '2026-02-01T05:00:00.000Z' },
      { status: 'LOST', sentAt: '2026-02-01T00:00:00.000Z', respondedAt: '2026-02-01T20:00:00.000Z' },
      { status: 'SENT', sentAt: '2026-02-01T00:00:00.000Z' },
    ])
    expect(funnel.medianHoursToReply).toBe(5)
  })

  it('averages the two middles and reports one decimal', () => {
    const funnel = quoteFunnel([
      { status: 'WON', sentAt: '2026-02-01T00:00:00.000Z', respondedAt: '2026-02-01T02:00:00.000Z' },
      { status: 'WON', sentAt: '2026-02-01T00:00:00.000Z', respondedAt: '2026-02-01T05:15:00.000Z' },
    ])
    expect(funnel.medianHoursToReply).toBe(3.6)
  })

  it('counts nothing as an empty funnel', () => {
    expect(quoteFunnel([])).toEqual({
      sent: 0,
      won: 0,
      lost: 0,
      open: 0,
      winRateBps: null,
      medianHoursToReply: null,
      wonCents: 0,
    })
  })
})

let commissionSeq = 0
const commission = (over: Partial<CommissionRecord>): CommissionRecord => {
  commissionSeq += 1
  return {
    id: `com-${commissionSeq}`,
    orderId: `order-${commissionSeq}`,
    invoiceId: `inv-${commissionSeq}`,
    repId: 'rep-a',
    roleName: 'PRIMARY_ACCOUNT_OWNER',
    basisCents: 100_000,
    revenueCents: 100_000,
    costCents: 80_000,
    profitCents: 20_000,
    amountCents: 2_000,
    netCents: 2_000,
    triggerAt: NOW,
    commissionMonth: '2026-02',
    computedAt: NOW,
    createdBy: 'system',
    updatedBy: 'system',
    version: 1,
    ...over,
  }
}

describe('commissionReport', () => {
  it('groups by rep, biggest net first, and names through the directory', () => {
    const report = commissionReport(
      [
        commission({ repId: 'rep-a', netCents: 2_000, status: 'PAID' }),
        commission({ repId: 'rep-a', netCents: 1_500, status: 'FULLY_APPROVED' }),
        commission({ repId: 'rep-b', netCents: 9_000, status: 'UN_APPROVED', repName: 'Bo Ray' }),
      ],
      { 'rep-a': 'Ada Lane' },
    )
    expect(report.rows.map((r) => [r.repId, r.repName, r.count, r.netCents])).toEqual([
      ['rep-b', 'Bo Ray', 1, 9_000],
      ['rep-a', 'Ada Lane', 2, 3_500],
    ])
    expect(report.totals).toEqual({
      count: 3,
      amountCents: 6_000,
      netCents: 12_500,
      unapprovedCents: 9_000,
      paidCents: 2_000,
    })
  })

  it('buckets the net by rung: unapproved, countered, paid', () => {
    const report = commissionReport([
      commission({ netCents: 1_000, status: 'UN_APPROVED' }),
      commission({ netCents: 2_000, status: 'REP_COUNTERED' }),
      commission({ netCents: 4_000, status: 'MANAGER_COUNTERED' }),
      commission({ netCents: 8_000, status: 'MANAGER_APPROVED' }),
      commission({ netCents: 16_000, status: 'PAID' }),
    ])
    expect(report.rows[0]).toMatchObject({
      count: 5,
      netCents: 31_000,
      unapprovedCents: 7_000,
      paidCents: 16_000,
    })
  })

  it('drops a cancelled row from the money and from the count', () => {
    const report = commissionReport([
      commission({ netCents: 2_000, status: 'PAID' }),
      commission({ netCents: 5_000, status: 'CANCELLED' }),
    ])
    expect(report.rows[0]).toMatchObject({ count: 1, netCents: 2_000, paidCents: 2_000 })
    expect(report.totals.count).toBe(1)
  })

  it('leaves a rep out entirely when every row of theirs was cancelled', () => {
    const report = commissionReport([commission({ repId: 'rep-c', status: 'CANCELLED' })])
    expect(report.rows).toEqual([])
    expect(report.totals.count).toBe(0)
  })

  it('keeps the plan amount beside the net the override moved', () => {
    const report = commissionReport([
      commission({ amountCents: 2_000, netCents: 2_500, overrideCents: 2_500, status: 'FULLY_APPROVED' }),
    ])
    expect(report.rows[0]).toMatchObject({ amountCents: 2_000, netCents: 2_500 })
  })
})
