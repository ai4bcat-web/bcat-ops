// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { computeLegacyMonth, deliveryDay, LEGACY_SCHEMA_VERSION, reduceLegacy, type LegacyLoadLite, type LegacyMonthSource } from './dashboardRollupLegacy'
import { loadsByFleet, revenueByFleet, type FleetDriver } from './revenueByFleet'

const drivers = [
  { id: 'ivan', fleetGroup: 'COMPANY', driverType: 'COMPANY' },
  { id: 'oo', fleetGroup: 'AMAZON', driverType: 'OWNER_OPERATOR' },
  { id: 'box', fleetGroup: 'BOX_TRUCK', driverType: 'COMPANY' },
  { id: 'brk', type: 'broker' },
] as unknown as FleetDriver[]

/**
 * Loads delivered across the UTC month edges and picked up in the month before, the way Finances counts them: on the
 * first ten characters of `deliveryAppt`. Some are voided, some have no delivery date at all.
 */
function fixture(): LegacyLoadLite[] {
  const deliveries = [
    '2026-09-30T23:30:00Z', // Sep 30 (the day prefix, not Chicago)
    '2026-10-01T03:00:00Z', // Oct 1
    '2026-10-12T15:00:00Z',
    '2026-10-31T23:30:00Z', // Oct 31
    '2026-11-01T04:30:00Z', // Nov 1
    '2026-11-20',           // a bare date
    null,                   // no delivery date: in no month
  ]
  const pairs: Array<[string | null, string | null]> = [['ivan', 'ivan'], ['oo', null], [null, 'box'], ['brk', 'ivan'], [null, 'brk'], [null, null], ['ivan', 'oo']]
  const loads: LegacyLoadLite[] = []
  for (let i = 0; i < 35; i++) {
    const [p, d] = pairs[i % pairs.length]!
    loads.push({
      id: `l${i}`,
      shipmentId: `s${i}`,
      pickupAppt: '2026-09-15T15:00:00Z',
      deliveryAppt: deliveries[i % deliveries.length],
      pickupDriverId: p,
      deliveryDriverId: d,
      rate: i % 4 === 0 ? null : 100_000 + i,
      voidedAt: i % 11 === 0 ? 'v' : null,
    })
  }
  return loads
}

function source(loads: LegacyLoadLite[]): LegacyMonthSource {
  return { loadsDeliveredIn: async (month) => loads.filter((l) => (l.deliveryAppt ?? '').startsWith(month)) }
}

/** The Finances arithmetic over the same loads: delivery day in range, voided and undated loads out, delivery driver. */
function reference(loads: LegacyLoadLite[], from: string, to: string, prevFrom: string, prevTo: string) {
  const live = loads.filter((l) => !l.voidedAt && deliveryDay(l.deliveryAppt) !== '')
  const within = (a: string, b: string) => live.filter((l) => { const day = deliveryDay(l.deliveryAppt); return day >= a && day <= b })
  const current = within(from, to)
  const previous = within(prevFrom, prevTo)
  const sum = (ls: LegacyLoadLite[]) => ls.reduce((s, l) => s + (l.rate ?? 0), 0)
  const connected = current.some((l) => (l.rate ?? 0) > 0)
  const connectedPrev = previous.some((l) => (l.rate ?? 0) > 0)
  const isBroker = (l: LegacyLoadLite) => l.deliveryDriverId === 'brk'
  const loadsOf = (ls: LegacyLoadLite[]) => ls.map((l) => ({ pickupDriverId: l.pickupDriverId ?? undefined, deliveryDriverId: l.deliveryDriverId ?? undefined, rate: l.rate ?? undefined }))
  return {
    totalLoads: current.length,
    totalLoadsDelta: current.length - previous.length,
    loadsSplit: loadsByFleet(loadsOf(current), drivers, 'delivery'),
    revenue: sum(current),
    revenueSplit: revenueByFleet(loadsOf(current), drivers, 'delivery'),
    revenueDelta: connected || connectedPrev ? sum(current) - sum(previous) : 0,
    revenueConnected: connected,
    brokerLoads: current.filter(isBroker).length,
    brokerLoadsDelta: current.filter(isBroker).length - previous.filter(isBroker).length,
    brokerRevenue: sum(current.filter(isBroker)),
    brokerRevenueDelta: sum(current.filter(isBroker)) - sum(previous.filter(isBroker)),
  }
}

describe('legacy rollup (delivery basis)', () => {
  const loads = fixture()

  it('is schema 2: a stored v1 row (pickup days) is never read as delivery figures', () => {
    expect(LEGACY_SCHEMA_VERSION).toBe(2)
  })

  it('buckets by delivery day, the first ten characters of deliveryAppt, never by pickup or Chicago time', async () => {
    const oct = await computeLegacyMonth(source(loads), '2026-10')
    const sep = await computeLegacyMonth(source(loads), '2026-09')
    const nov = await computeLegacyMonth(source(loads), '2026-11')
    expect(Object.keys(oct.days).every((d) => d.startsWith('2026-10-'))).toBe(true)
    expect(Object.keys(sep.days)).toEqual(['2026-09-30'])
    expect(Object.keys(nov.days).sort()).toEqual(['2026-11-01', '2026-11-20'])
    expect(Object.keys(oct.days)).toContain('2026-10-31')
    // The loads were all picked up in September: none of October's days came from the pickup date.
    expect(Object.keys(oct.days)).not.toContain('2026-09-15')
  })

  it('drops voided loads and counts a load with no delivery date in no month', async () => {
    const months = await Promise.all(['2026-09', '2026-10', '2026-11'].map((m) => computeLegacyMonth(source(loads), m)))
    const counted = months.reduce((n, p) => n + Object.values(p.days).reduce((m, pairs) => m + Object.values(pairs).reduce((k, v) => k + v.n, 0), 0), 0)
    const expected = loads.filter((l) => !l.voidedAt && l.deliveryAppt).length
    expect(counted).toBe(expected)
    expect(expected).toBeLessThan(loads.length)
  })

  for (const [name, from, to, prevFrom, prevTo] of [
    ['a month and the month before', '2026-10-01', '2026-10-31', '2026-09-01', '2026-09-30'],
    ['a single day', '2026-10-31', '2026-10-31', '2026-10-30', '2026-10-30'],
    ['two months', '2026-10-01', '2026-11-30', '2026-08-01', '2026-09-30'],
  ] as const) {
    it(`reduceLegacy equals the Finances arithmetic: ${name}`, async () => {
      const months = await Promise.all(['2026-09', '2026-10', '2026-11'].map((m) => computeLegacyMonth(source(loads), m)))
      expect(reduceLegacy(months, { from, to, prevFrom, prevTo }, drivers)).toEqual(reference(loads, from, to, prevFrom, prevTo))
    })
  }

  it('attributes a load to its delivery driver only: no delivery driver is "no driver", whatever the pickup driver', async () => {
    const solo: LegacyLoadLite[] = [{ id: 'a', deliveryAppt: '2026-10-05', pickupDriverId: 'ivan', deliveryDriverId: null, rate: 50_000 }]
    const month = await computeLegacyMonth(source(solo), '2026-10')
    const kpis = reduceLegacy([month], { from: '2026-10-01', to: '2026-10-31', prevFrom: '2026-09-01', prevTo: '2026-09-30' }, drivers)
    const byBucket = Object.fromEntries(kpis.revenueSplit.byBucket.map((b) => [b.bucket, b.revenue]))
    expect(byBucket.UNASSIGNED).toBe(50_000)
    expect(byBucket.IVAN).toBe(0)
  })

  it('broker-covered means the DELIVERY driver is a broker', async () => {
    const solo: LegacyLoadLite[] = [
      { id: 'a', deliveryAppt: '2026-10-05', pickupDriverId: 'brk', deliveryDriverId: 'ivan', rate: 10_000 },
      { id: 'b', deliveryAppt: '2026-10-06', pickupDriverId: 'ivan', deliveryDriverId: 'brk', rate: 20_000 },
    ]
    const month = await computeLegacyMonth(source(solo), '2026-10')
    const kpis = reduceLegacy([month], { from: '2026-10-01', to: '2026-10-31', prevFrom: '2026-09-01', prevTo: '2026-09-30' }, drivers)
    expect(kpis.brokerLoads).toBe(1)
    expect(kpis.brokerRevenue).toBe(20_000)
  })
})
