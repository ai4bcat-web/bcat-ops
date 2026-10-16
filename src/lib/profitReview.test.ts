import { describe, it, expect } from 'vitest'
import {
  monthMetrics, pickBaseline, deltasVsBaseline, fuelSplit, findings,
  projectProfit, breakEvenRatePerMile, rateLadder, type ReviewMonthInput,
} from './profitReview'

function month(over: Partial<ReviewMonthInput> & { key: string }): ReviewMonthInput {
  return {
    label: over.key, daysInMonth: 30, daysElapsed: 30,
    revenue: 80000, fuel: 18000, driverPay: 22700, maintenance: 11400, insurance: 6600, fixed: 9900,
    miles: 23000, loads: 138, gallons: 3400,
    trucks: [], customers: [], unitMaintenance: [],
    ...over,
  }
}

describe('monthMetrics', () => {
  it('derives net, margin and per-mile economics', () => {
    const m = monthMetrics(month({ key: '2026-08' }))
    expect(m.net).toBe(80000 - 18000 - 22700 - 11400 - 6600 - 9900)
    expect(m.margin).toBeCloseTo(m.net / 80000, 6)
    expect(m.revPerMile).toBeCloseTo(80000 / 23000, 6)
    expect(m.costPerMile).toBeCloseTo(68600 / 23000, 6)
    expect(m.variableCostPerMile).toBeCloseTo((18000 + 22700 + 11400) / 23000, 6)
    expect(m.pricePerGallon).toBeCloseTo(18000 / 3400, 6)
    expect(m.payShare).toBeCloseTo(22700 / 80000, 6)
    expect(m.isPartial).toBe(false)
    expect(m.proratedNet).toBe(m.net)
  })

  it('prorates insurance and fixed costs for a partial month', () => {
    const m = monthMetrics(month({ key: '2026-10', daysInMonth: 31, daysElapsed: 15, revenue: 48562, fuel: 12635, driverPay: 11651, maintenance: 6898, insurance: 6608, fixed: 10063 }))
    expect(m.isPartial).toBe(true)
    expect(m.net).toBeCloseTo(707, 0)
    expect(m.proratedNet).toBeCloseTo(48562 - 12635 - 11651 - 6898 - (6608 + 10063) * (15 / 31), 0)
  })

  it('does not prorate again when the costs are already month to date', () => {
    const m = monthMetrics(month({ key: '2026-10', daysInMonth: 31, daysElapsed: 15, revenue: 45128, insurance: 3198, fixed: 4870, costsToDate: true }))
    expect(m.isPartial).toBe(true)
    expect(m.proratedNet).toBe(m.net)
  })

  it('returns null ratios when miles, loads or gallons are zero', () => {
    const m = monthMetrics(month({ key: 'x', miles: 0, loads: 0, gallons: 0 }))
    expect(m.revPerMile).toBeNull(); expect(m.costPerLoad).toBeNull(); expect(m.pricePerGallon).toBeNull(); expect(m.mpg).toBeNull()
  })

  it('computes mpg from Motive gallons burned, only over trucks reporting both', () => {
    const m = monthMetrics(month({ key: 'x', trucks: [
      { unitNumber: '530', bucket: 'IVAN_LOCAL', revenue: 0, miles: 5000, fuel: 5000, gallons: 1100, motiveGallons: 1000, motiveMiles: 5000 },
      { unitNumber: '3114', bucket: 'IVAN_LOCAL', revenue: 0, miles: 0, fuel: 0, gallons: 0, motiveGallons: 0, motiveMiles: 0 },
    ] }))
    expect(m.mpg).toBe(5)
  })
})

describe('pickBaseline', () => {
  it('chooses the finished month with the highest net and ignores the partial month', () => {
    const months = [
      month({ key: '2026-07', revenue: 74953, maintenance: 17021 }),
      month({ key: '2026-08' }),
      month({ key: '2026-09', revenue: 84601, fuel: 23466, driverPay: 29370, maintenance: 14803 }),
      month({ key: '2026-10', daysElapsed: 15, revenue: 200000, fuel: 0, driverPay: 0, maintenance: 0 }),
    ]
    expect(pickBaseline(months)?.key).toBe('2026-08')
    expect(pickBaseline([])).toBeNull()
    // A month that predates the expense data never wins, however good it looks.
    expect(pickBaseline([...months, month({ key: '2026-05', revenue: 300000, fixed: 0, incomplete: true })])?.key).toBe('2026-08')
  })
})

describe('deltasVsBaseline', () => {
  it('signs every line by its effect on profit', () => {
    const base = month({ key: '2026-08' })
    const sep = month({ key: '2026-09', revenue: 84736, fuel: 23348, driverPay: 29337, maintenance: 14767, insurance: 6387 })
    const d = Object.fromEntries(deltasVsBaseline(sep, base).map((x) => [x.key, x.effect]))
    expect(d.revenue).toBe(4736)
    expect(d.fuel).toBe(-5348)
    expect(d.driverPay).toBe(-6637)
    expect(d.maintenance).toBe(-3367)
    expect(d.insurance).toBe(213)
    expect(d.fixed).toBe(0)
    expect(d.net).toBe(4736 - 5348 - 6637 - 3367 + 213)
  })
})

describe('fuelSplit', () => {
  it('splits a fuel change into price and volume effects that sum to the total', () => {
    const base = month({ key: 'a', fuel: 18118, gallons: 3413 })
    const m = month({ key: 'b', fuel: 23466, gallons: 3806 })
    const s = fuelSplit(m, base)!
    expect(s.total).toBe(23466 - 18118)
    expect(s.priceEffect + s.volumeEffect).toBeCloseTo(s.total, 0)
    expect(s.priceEffect).toBeGreaterThan(s.volumeEffect)
  })
})

describe('findings', () => {
  const base = month({ key: '2026-08', label: 'Aug 2026' })
  const sep = month({
    key: '2026-09', label: 'Sep 2026',
    revenue: 84601, fuel: 23466, driverPay: 29370, maintenance: 14803, insurance: 6395, miles: 26138, loads: 134, gallons: 3806,
    customers: [
      { name: 'BATORY FOODS', loads: 75, revenue: 57355 },
      { name: 'TRANSPORTATION ONE', loads: 10, revenue: 5450 },
      { name: 'TQL', loads: 6, revenue: 2800 },
      { name: 'ONE-OFF', loads: 1, revenue: 100 },
    ],
    trucks: [
      { unitNumber: '530', bucket: 'IVAN_LOCAL', revenue: 17004, miles: 4998, fuel: 5590, gallons: 878, motiveGallons: 870, motiveMiles: 4998 },
      { unitNumber: '685', bucket: 'IVAN_LOCAL', revenue: 19626, miles: 4054, fuel: 3701, gallons: 636, motiveGallons: 630, motiveMiles: 4054 },
      { unitNumber: '3890', bucket: 'BOX_TRUCK', revenue: 14695, miles: 6650, fuel: 3501, gallons: 551, motiveGallons: 540, motiveMiles: 6650 },
    ],
    unitMaintenance: [{ unitNumber: '530', amount: 7959, biggest: { description: 'Transmission', amount: 5178 } }],
  })

  it('raises pay share, rate floor, cheap customers, diesel price and maintenance findings, ranked by impact', () => {
    const f = findings([month({ key: '2026-06', label: 'Jun 2026', maintenance: 6544 }), month({ key: '2026-07', label: 'Jul 2026', maintenance: 17021 }), base, sep], base)
    const titles = f.map((x) => x.title)
    expect(titles.some((t) => t.startsWith('Hold driver pay'))).toBe(true)
    expect(titles.some((t) => t.startsWith('Set a rate floor'))).toBe(true)
    expect(titles.some((t) => t.startsWith('Reprice or drop fill freight'))).toBe(true)
    expect(titles.some((t) => t.includes('fuel surcharge'))).toBe(true)
    expect(titles.some((t) => t.startsWith('Budget maintenance'))).toBe(true)
    expect(titles.some((t) => t.startsWith('Check fuel economy on #530'))).toBe(true)
    for (let i = 1; i < f.length; i++) expect(f[i - 1].impact).toBeGreaterThanOrEqual(f[i].impact)
    const cheap = f.find((x) => x.title.startsWith('Reprice'))!
    expect(cheap.detail).toContain('TRANSPORTATION ONE')
    expect(cheap.detail).not.toContain('ONE-OFF')
    expect(cheap.detail).not.toContain('BATORY')
  })

  it('stays quiet on a healthy month and surfaces unattributed fuel when told', () => {
    const good = month({ key: '2026-06', label: 'Jun 2026', revenue: 90000, driverPay: 20000, maintenance: 6000 })
    expect(findings([good], good)).toEqual([])
    const f = findings([good], good, { unattributedFuel: { count: 68, amount: 15595 } })
    expect(f).toHaveLength(1)
    expect(f[0].title).toBe('Fuel purchases with no truck on file')
  })
})

describe('deadhead finding', () => {
  const good = month({ key: '2026-06', label: 'Jun 2026', revenue: 90000, driverPay: 20000, maintenance: 6000 })
  it('flags empty miles above the target and prices the excess at the variable cost', () => {
    const f = findings([good], good, { deadhead: { label: 'Jun 2026', loadedMiles: 12000, emptyMiles: 8000, variableCostPerMile: 2.5 } })
    expect(f).toHaveLength(1)
    expect(f[0].title).toContain('40% of miles ran empty')
    // 8,000 empty of 20,000 total; target 25% = 5,000; excess 3,000 miles × $2.50
    expect(f[0].impact).toBeCloseTo(7500, 6)
  })
  it('stays quiet at or under the target', () => {
    expect(findings([good], good, { deadhead: { label: 'Jun 2026', loadedMiles: 16000, emptyMiles: 4000, variableCostPerMile: 2.5 } })).toEqual([])
  })
})

describe('projections', () => {
  const p = { miles: 23000, fixedCost: 16500, variableCostPerMile: 2.25 }
  it('breaks even where revenue covers variable cost plus fixed cost spread over the miles', () => {
    const be = breakEvenRatePerMile(p)!
    expect(be).toBeCloseTo(2.25 + 16500 / 23000, 6)
    const [row] = projectProfit(p, [be])
    expect(row.net).toBeCloseTo(0, 6)
    expect(breakEvenRatePerMile({ ...p, miles: 0 })).toBeNull()
  })
  it('projects net and margin across a ladder of rates', () => {
    const rows = projectProfit(p, rateLadder(2.5, 3.5, 0.5))
    expect(rows.map((r) => r.ratePerMile)).toEqual([2.5, 3, 3.5])
    expect(rows[1].revenue).toBe(69000)
    expect(rows[1].net).toBe(69000 - 2.25 * 23000 - 16500)
    expect(rows[2].net).toBeGreaterThan(rows[1].net)
  })
  it('rateLadder is inclusive and rounds to cents', () => {
    expect(rateLadder(2.5, 3.25, 0.25)).toEqual([2.5, 2.75, 3, 3.25])
  })
})
