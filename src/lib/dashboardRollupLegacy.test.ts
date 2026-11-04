// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { chicagoDay, computeLegacyMonth, reduceLegacy, type LegacyLoadLite, type LegacyMonthSource } from './dashboardRollupLegacy'
import { loadsByFleet, revenueByFleet, type FleetDriver } from './revenueByFleet'
import type { ShipmentLite } from './dashboardRollup'

const drivers = [
  { id: 'ivan', fleetGroup: 'COMPANY', driverType: 'COMPANY' },
  { id: 'oo', fleetGroup: 'AMAZON', driverType: 'OWNER_OPERATOR' },
  { id: 'box', fleetGroup: 'BOX_TRUCK', driverType: 'COMPANY' },
  { id: 'brk', type: 'broker' },
] as unknown as FleetDriver[]

interface Rows { shipments: ShipmentLite[]; loads: LegacyLoadLite[] }

function fixture(): Rows {
  const shipments: ShipmentLite[] = []
  const loads: LegacyLoadLite[] = []
  const pickups = [
    '2026-10-01T03:00:00Z', // Sep 30 22:00 Chicago: belongs to September
    '2026-10-01T05:30:00Z', // Oct 1 00:30 Chicago
    '2026-10-12T15:00:00Z',
    '2026-10-31T23:30:00Z', // Oct 31 18:30 Chicago
    '2026-11-01T04:30:00Z', // Oct 31 23:30 Chicago: still October
    '2026-11-01T06:30:00Z', // Nov 1 00:30 Chicago
  ]
  const pairs: Array<[string | null, string | null]> = [['ivan', 'ivan'], ['oo', null], [null, 'box'], ['brk', 'ivan'], [null, 'brk'], [null, null]]
  for (let i = 0; i < 30; i++) {
    const pickup = pickups[i % pickups.length]!
    const [p, d] = pairs[i % pairs.length]!
    shipments.push({ id: `s${i}`, pickupAppt: pickup, pickupMonth: pickup.slice(0, 7), voidedAt: i % 11 === 0 ? 'v' : null })
    loads.push({ id: `l${i}`, shipmentId: `s${i}`, pickupAppt: pickup, pickupDriverId: p, deliveryDriverId: d, rate: i % 4 === 0 ? null : 100_000 + i })
  }
  return { shipments, loads }
}

function source(rows: Rows): LegacyMonthSource {
  return {
    shipments: async (month) => rows.shipments.filter((s) => s.pickupMonth === month),
    loadsOf: async (ids) => rows.loads.filter((l) => ids.includes(l.shipmentId!)),
  }
}

/** The store arithmetic `useDashboardMetrics` ran, over loads whose Chicago day is in range. */
function reference(rows: Rows, from: string, to: string, prevFrom: string, prevTo: string) {
  const voided = new Set(rows.shipments.filter((s) => s.voidedAt).map((s) => s.id))
  const live = rows.loads.filter((l) => !voided.has(l.shipmentId!))
  const within = (a: string, b: string) => live.filter((l) => { const day = chicagoDay(l.pickupAppt!); return day >= a && day <= b })
  const current = within(from, to)
  const previous = within(prevFrom, prevTo)
  const sum = (ls: LegacyLoadLite[]) => ls.reduce((s, l) => s + (l.rate ?? 0), 0)
  const connected = current.some((l) => (l.rate ?? 0) > 0)
  const connectedPrev = previous.some((l) => (l.rate ?? 0) > 0)
  const broker = new Set(['brk'])
  const isBroker = (l: LegacyLoadLite) => (!!l.deliveryDriverId && broker.has(l.deliveryDriverId)) || (!!l.pickupDriverId && broker.has(l.pickupDriverId))
  const loadsOf = (ls: LegacyLoadLite[]) => ls.map((l) => ({ pickupDriverId: l.pickupDriverId ?? undefined, deliveryDriverId: l.deliveryDriverId ?? undefined, rate: l.rate ?? undefined }))
  return {
    totalLoads: current.length,
    totalLoadsDelta: current.length - previous.length,
    loadsSplit: loadsByFleet(loadsOf(current), drivers),
    revenue: sum(current),
    revenueSplit: revenueByFleet(loadsOf(current), drivers),
    revenueDelta: connected || connectedPrev ? sum(current) - sum(previous) : 0,
    revenueConnected: connected,
    brokerLoads: current.filter(isBroker).length,
    brokerLoadsDelta: current.filter(isBroker).length - previous.filter(isBroker).length,
    brokerRevenue: sum(current.filter(isBroker)),
    brokerRevenueDelta: sum(current.filter(isBroker)) - sum(previous.filter(isBroker)),
  }
}

describe('legacy rollup', () => {
  const rows = fixture()

  it('buckets by Chicago day: a 23:30 pickup stays on its own day and month', async () => {
    const oct = await computeLegacyMonth(source(rows), '2026-10')
    const sep = await computeLegacyMonth(source(rows), '2026-09')
    const nov = await computeLegacyMonth(source(rows), '2026-11')
    expect(Object.keys(oct.days).every((d) => d.startsWith('2026-10-'))).toBe(true)
    expect(Object.keys(sep.days)).toEqual(['2026-09-30'])
    expect(Object.keys(nov.days)).toEqual(['2026-11-01'])
    expect(Object.keys(oct.days)).toContain('2026-10-31')
  })

  for (const [name, from, to, prevFrom, prevTo] of [
    ['a month and the month before', '2026-10-01', '2026-10-31', '2026-09-01', '2026-09-30'],
    ['a day across the UTC edge', '2026-10-31', '2026-10-31', '2026-10-30', '2026-10-30'],
    ['two months', '2026-10-01', '2026-11-30', '2026-08-01', '2026-09-30'],
  ] as const) {
    it(`reduceLegacy equals the store arithmetic: ${name}`, async () => {
      const months = await Promise.all(['2026-09', '2026-10', '2026-11'].map((m) => computeLegacyMonth(source(rows), m)))
      expect(reduceLegacy(months, { from, to, prevFrom, prevTo }, drivers)).toEqual(reference(rows, from, to, prevFrom, prevTo))
    })
  }
})
