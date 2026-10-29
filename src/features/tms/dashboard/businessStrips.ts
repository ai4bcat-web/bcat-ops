/**
 * The KPI strip arithmetic for `/tms/dashboard`.
 *
 * One strip per top-level ownership division, built from the ownership taxonomy rather
 * than a hard-coded list, so an admin-added business appears without a code change.
 * Assets lists its direct children as subdivisions because the taxonomy says it has them.
 *
 * The function is pure: it takes the raw window `useBrokerageDashboard` returned, applies
 * the same filter row the charts use, and segments the result by top-level division and
 * by subdivision. A metric the underlying data cannot support is `null`; it is never
 * printed as a zero standing in for "unknown".
 */
import { applyFilters, indexOf, loadRow, pricedSamples, sampleRow } from '@/lib/dashboardCharts'
import { MOVEMENT_STATUSES } from '@/lib/brokerageCharts'
import { divisionTree, topLevelOf } from '@/lib/ownership'
import type { DataIndex } from '@/lib/dashboardCharts'
import type { OwnershipDivisionRecord } from '@/types/tms'
import type { DashboardData, DashboardFilters, LoadSummaryRecord } from './types'

export interface BusinessStripSubdivision {
  code: string
  name: string
  brand: string | null
  shipmentsByStatus: Record<string, number>
  revenueCents: number | null
  profitCents: number | null
  marginBps: number | null
  arOpenCents: number | null
  apOpenCents: number | null
  trackedCount: number | null
  podNeededCount: number | null
}

export interface BusinessStrip {
  code: string
  name: string
  brand: string | null
  subdivisions: BusinessStripSubdivision[]
  shipmentsByStatus: Record<string, number>
  revenueCents: number | null
  profitCents: number | null
  marginBps: number | null
  arOpenCents: number | null
  apOpenCents: number | null
  trackedCount: number | null
  podNeededCount: number | null
}

const TRACKED_STATUS: Record<string, true> = Object.fromEntries(
  MOVEMENT_STATUSES.map((status) => [status, true]),
)

function countByStatus(shipments: { status: string }[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const { status } of shipments) {
    counts[status] = (counts[status] ?? 0) + 1
  }
  return counts
}

type DivisionInput = Pick<OwnershipDivisionRecord, 'id' | 'code' | 'name' | 'brand' | 'parentId' | 'sortOrder' | 'active'>

function podMissing(
  shipmentId: string,
  sampleByShipmentId: Map<string, DashboardData['samples'][number]>,
  index: DataIndex,
): boolean {
  const sample = sampleByShipmentId.get(shipmentId)
  if (sample) return !sample.podReceivedAt
  const order = index.orderByShipmentId.get(shipmentId)
  return (order?.docsMissing ?? []).includes('POD')
}

function stripValues(
  shipments: { status: string }[],
  samples: { revenueCents?: number | null; profitCents?: number | null }[],
  loads: Pick<LoadSummaryRecord, 'status'>[],
  openInvoices: { balanceCents: number }[],
  openBills: { balanceCents: number }[],
  podNeeded: number,
): Omit<BusinessStripSubdivision, 'code' | 'name' | 'brand'> {
  const hasShipments = shipments.length > 0
  const hasSamples = samples.length > 0
  const hasLoads = loads.length > 0
  const hasInvoices = openInvoices.length > 0
  const hasBills = openBills.length > 0

  const revenueCents = hasSamples
    ? samples.reduce((sum, sample) => sum + (sample.revenueCents ?? 0), 0)
    : null
  const profitCents = hasSamples
    ? samples.reduce((sum, sample) => sum + (sample.profitCents ?? 0), 0)
    : null
  const marginBps = revenueCents != null && revenueCents > 0 && profitCents != null
    ? Math.round((profitCents / revenueCents) * 10000)
    : null

  return {
    shipmentsByStatus: hasShipments ? countByStatus(shipments) : {},
    revenueCents,
    profitCents,
    marginBps,
    arOpenCents: hasInvoices
      ? openInvoices.reduce((sum, invoice) => sum + (invoice.balanceCents ?? 0), 0)
      : null,
    apOpenCents: hasBills
      ? openBills.reduce((sum, bill) => sum + (bill.balanceCents ?? 0), 0)
      : null,
    trackedCount: hasLoads
      ? loads.filter((load) => load.status != null && TRACKED_STATUS[load.status]).length
      : null,
    podNeededCount: hasShipments ? podNeeded : null,
  }
}

/**
 * Build one KPI strip per active top-level ownership division.
 *
 * `divisions` should be the full ownership taxonomy (top-level and children), because
 * subdivisions are resolved through `topLevelOf`. When the API has not returned divisions
 * yet, callers should pass `SEED_DIVISIONS`.
 */
export function buildBusinessStrips(
  data: DashboardData,
  filters: DashboardFilters,
  divisions: DivisionInput[],
): BusinessStrip[] {
  const tree = divisionTree(divisions)
  const topNodes = tree
    .filter((node) => node.division.active !== false && node.division.parentId == null)
    .sort((a, b) => (a.division.sortOrder ?? 0) - (b.division.sortOrder ?? 0))

  if (topNodes.length === 0) return []

  const filtered = applyFilters(data, filters)
  const index = indexOf(data)
  const sampleByShipmentId = new Map(
    filtered.samples.map((sample) => [sample.shipmentId, sample] as const),
  )

  // Pre-compute the top-level and subdivision bucket for every row we may count.
  const shipmentBuckets = new Map<string, { top: string | null; sub: string | null }>()
  for (const shipment of filtered.shipments) {
    const code = shipment.revSubdivision ?? shipment.revDivision ?? null
    shipmentBuckets.set(shipment.id, {
      top: code ? topLevelOf(divisions, code) : null,
      sub: code && topLevelOf(divisions, code) !== code ? code : null,
    })
  }

  const sampleBuckets = new Map<string, { top: string | null; sub: string | null }>()
  for (const sample of filtered.samples) {
    const row = sampleRow(sample, data)
    const code = row.revSubdivision ?? row.revDivision ?? null
    sampleBuckets.set(sample.id, {
      top: code ? topLevelOf(divisions, code) : null,
      sub: code && topLevelOf(divisions, code) !== code ? code : null,
    })
  }

  const loadBuckets = new Map<string, { top: string | null; sub: string | null }>()
  for (const load of filtered.loads) {
    const row = loadRow(load, data)
    const code = row.revSubdivision ?? row.revDivision ?? null
    loadBuckets.set(load.id, {
      top: code ? topLevelOf(divisions, code) : null,
      sub: code && topLevelOf(divisions, code) !== code ? code : null,
    })
  }

  const invoiceBuckets = new Map<string, { top: string | null; sub: string | null }>()
  for (const invoice of filtered.openInvoices) {
    const order = index.orderById.get(invoice.orderId)
    const shipment = order ? index.shipmentById.get(order.shipmentId) : undefined
    const code = shipment?.revSubdivision ?? shipment?.revDivision ?? null
    invoiceBuckets.set(invoice.id, {
      top: code ? topLevelOf(divisions, code) : null,
      sub: code && topLevelOf(divisions, code) !== code ? code : null,
    })
  }

  const billBuckets = new Map<string, { top: string | null; sub: string | null }>()
  for (const bill of filtered.openBills) {
    const load = index.loadById.get(bill.loadId)
    const code = load?.revSubdivision ?? load?.revDivision ?? null
    billBuckets.set(bill.id, {
      top: code ? topLevelOf(divisions, code) : null,
      sub: code && topLevelOf(divisions, code) !== code ? code : null,
    })
  }

  const podBuckets = new Map<string, { top: string | null; sub: string | null }>()
  for (const shipment of filtered.shipments) {
    if (shipment.status !== 'DELIVERED') continue
    if (!podMissing(shipment.id, sampleByShipmentId, index)) continue
    const bucket = shipmentBuckets.get(shipment.id)
    if (!bucket) continue
    podBuckets.set(shipment.id, bucket)
  }

  const result: BusinessStrip[] = []
  for (const node of topNodes) {
    const topCode = node.division.code
    const children = node.children
      .filter((child) => child.division.active !== false)
      .sort((a, b) => (a.division.sortOrder ?? 0) - (b.division.sortOrder ?? 0))
    const childCodeSet = new Set(children.map((child) => child.division.code))

    const topShipments = filtered.shipments.filter((s) => shipmentBuckets.get(s.id)?.top === topCode)
    const topSamples = pricedSamples(
      filtered.samples.filter((s) => sampleBuckets.get(s.id)?.top === topCode),
    )
    const topLoads = filtered.loads.filter((l) => loadBuckets.get(l.id)?.top === topCode)
    const topInvoices = filtered.openInvoices.filter((i) => invoiceBuckets.get(i.id)?.top === topCode)
    const topBills = filtered.openBills.filter((b) => billBuckets.get(b.id)?.top === topCode)
    const topPodNeeded = [...podBuckets.values()].filter((b) => b.top === topCode).length

    const values = stripValues(topShipments, topSamples, topLoads, topInvoices, topBills, topPodNeeded)

    const subdivisions: BusinessStripSubdivision[] = []
    for (const child of children) {
      const childCode = child.division.code

      const childShipments = filtered.shipments.filter((s) => {
        const bucket = shipmentBuckets.get(s.id)
        if (bucket?.top !== topCode) return false
        if (bucket.sub) return bucket.sub === childCode
        return childCodeSet.has(s.revDivision ?? '') && s.revDivision === childCode
      })

      const childSamples = pricedSamples(
        filtered.samples.filter((s) => {
          const bucket = sampleBuckets.get(s.id)
          if (bucket?.top !== topCode) return false
          if (bucket.sub) return bucket.sub === childCode
          return childCodeSet.has(s.revDivision ?? '') && s.revDivision === childCode
        }),
      )

      const childLoads = filtered.loads.filter((l) => {
        const bucket = loadBuckets.get(l.id)
        if (bucket?.top !== topCode) return false
        if (bucket.sub) return bucket.sub === childCode
        return childCodeSet.has(l.revDivision ?? '') && l.revDivision === childCode
      })

      const childInvoices = filtered.openInvoices.filter((i) => {
        const bucket = invoiceBuckets.get(i.id)
        return bucket?.top === topCode && bucket.sub === childCode
      })

      const childBills = filtered.openBills.filter((b) => {
        const bucket = billBuckets.get(b.id)
        return bucket?.top === topCode && bucket.sub === childCode
      })

      const childPodNeeded = [...podBuckets.entries()].filter(([, b]) => b.top === topCode && b.sub === childCode).length

      subdivisions.push({
        code: childCode,
        name: child.division.name,
        brand: child.division.brand ?? null,
        ...stripValues(childShipments, childSamples, childLoads, childInvoices, childBills, childPodNeeded),
      })
    }

    result.push({
      code: topCode,
      name: node.division.name,
      brand: node.division.brand ?? null,
      subdivisions,
      ...values,
    })
  }

  return result
}
