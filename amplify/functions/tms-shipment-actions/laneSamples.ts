/**
 * Lane history — one delivered load, priced, keyed by lane.
 *
 * `LaneRateSample` is the only thing the Historical Rates panel reads, and this
 * module is its only writer. The row's id is `lrs:<loadId>`, so every write is an
 * overwrite: a re-price or an AP charge edit refreshes the lane's memory of that
 * load rather than doubling it.
 *
 * Nothing here may ever fail the action that triggered it. A load delivered, a
 * shipment re-priced, a carrier TONU'd — those are facts about freight, and a
 * statistics row that could not be written is not a reason to refuse one. Every
 * entry point catches, logs and returns.
 */
import { PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { marshall } from '@aws-sdk/util-dynamodb'

import {
  IDX_CARRIERS_BY_SHIPMENT,
  IDX_DOCUMENTS_BY_SHIPMENT,
  marshallRow,
  nowIso,
  numberOrNull,
  readStops,
  type Row,
} from '../_shared/shipmentStore'
import { laneSampleFor } from '../../../src/lib/laneKey'
import { MOVEMENT_RANK } from '../../../src/lib/shipmentStatus'
import type { LoadWorkflowStatus } from '../../../src/types/tms'
import type { QuoteDeps } from './quotes'

/** Amplify's derived index name for the load's tracking log, oldest row first. */
const IDX_CHECK_CALLS_BY_LOAD = 'loadCheckCallsByLoadIdAndAt'
/** The exceptions queue is granted to this router but not carried on `QuoteDeps`. */
const LOAD_CHECK_CALL_TABLE_NAME = process.env.LOAD_CHECK_CALL_TABLE_NAME ?? ''

/**
 * Step R. A position report the truck sent us, as opposed to a dispatcher typing
 * one in: "time to first ping" is a measure of the tracking link and the driver
 * app, and a phone call written down is not one of those. `MOTIVE` is listed for
 * the Step J integration that will write it; nothing emits it yet.
 */
const AUTOMATIC_PING_SOURCES: Record<string, true> = { LINK: true, DRIVER_APP: true, MOTIVE: true }
/** The two row types that carry a position rather than an event. */
const PING_TYPES: Record<string, true> = { TRACKING_PING: true, LOCATION_UPDATE: true }
/** `TmsSettings.checkCallGraceMinutes` — how late a check call may be and still count. */
const DEFAULT_CHECK_CALL_GRACE_MINUTES = 15

/** The tracking facts the dashboard's historical cards are computed from. */
interface TrackingFacts {
  firstPingAt: string | null
  checkCallsDue: number
  checkCallsMet: number
}

/**
 * Compliance, read off the log rather than cached anywhere.
 *
 * Every row that armed a reminder is one check call that came due; it was met when
 * a later row landed by the deadline plus the org's grace. The rows are the truth,
 * so a reminder edited, snoozed or cleared re-counts the same way on every refresh.
 */
function trackingFactsOf(rows: Row[], graceMinutes: number): TrackingFacts {
  const ordered = [...rows].sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')))
  const graceMs = graceMinutes * 60_000
  let firstPingAt: string | null = null
  let checkCallsDue = 0
  let checkCallsMet = 0

  for (const row of ordered) {
    const at = typeof row.at === 'string' ? row.at : ''
    if (
      firstPingAt == null
      && at
      && PING_TYPES[String(row.type ?? '')]
      && AUTOMATIC_PING_SOURCES[String(row.source ?? '')]
    ) {
      firstPingAt = at
    }
    const due = typeof row.nextCheckCallAt === 'string' ? row.nextCheckCallAt : ''
    if (!due) continue
    checkCallsDue++
    const deadline = Date.parse(due) + graceMs
    if (Number.isNaN(deadline)) continue
    const met = ordered.some((other) => {
      if (other === row) return false
      const otherAt = typeof other.at === 'string' ? Date.parse(other.at) : NaN
      return !Number.isNaN(otherAt) && otherAt > Date.parse(at) && otherAt <= deadline
    })
    if (met) checkCallsMet++
  }
  return { firstPingAt, checkCallsDue, checkCallsMet }
}

/**
 * When the POD actually arrived: the earliest active one filed against this load.
 * A portal upload still waiting for review is not a POD we have, which is the same
 * rule the release gate applies.
 */
function podReceivedAtOf(documents: Row[], loadId: string): string | null {
  let earliest: string | null = null
  for (const doc of documents) {
    if (doc.type !== 'POD' || doc.status !== 'ACTIVE') continue
    if (doc.reviewStatus === 'PENDING' || doc.reviewStatus === 'REJECTED') continue
    const docLoadId = typeof doc.loadId === 'string' ? doc.loadId : ''
    if (docLoadId && docLoadId !== loadId) continue
    const at = typeof doc.uploadedAt === 'string' ? doc.uploadedAt : (typeof doc.createdAt === 'string' ? doc.createdAt : '')
    if (at && (earliest == null || at < earliest)) earliest = at
  }
  return earliest
}

/** A sample is only taken once the freight is off the truck. */
export function isDeliveredOrLater(status: unknown): boolean {
  const value = String(status ?? '')
  return value in MOVEMENT_RANK && MOVEMENT_RANK[value as LoadWorkflowStatus] >= MOVEMENT_RANK.DELIVERED
}

/**
 * Drop the fields a sample has no value for.
 *
 * `laneKey3` is the hash key of `laneRateSamplesByLaneKey3AndDate`, and a load
 * whose stops carry no ZIPs has none — a NULL there is `Type mismatch for Index
 * Key` and the whole Put is refused, which this module's catch-all would then
 * swallow, leaving the lane with no history at all. The backfill script compacts
 * its items for the same reason (`scripts/backfillLaneSamples.mjs:405`).
 */
function compact(item: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(item)) {
    if (value != null) out[key] = value
  }
  return out
}

/**
 * Write (or refresh) the sample for one load.
 *
 * `laneSampleFor` is the judge of whether there is a sample to take at all: it
 * returns null without a `LoadFinancials` row (there is nothing to learn from an
 * unpriced load), without a lane key, and before DELIVERED. Cost moves until the
 * carrier's bill is recorded and revenue until the invoice freezes, so this is
 * called again from every path that can still move either.
 */
export async function writeLaneSample(deps: QuoteDeps, loadId: string): Promise<void> {
  if (!deps.tables.laneSample || !loadId) return
  try {
    const load = await deps.getById(deps.tables.load, loadId)
    if (!load) return
    const shipmentId = String(load.shipmentId ?? '')
    const [financials, shipment] = await Promise.all([
      deps.getById(deps.tables.loadFinancials, loadId),
      shipmentId ? deps.getById(deps.tables.shipment, shipmentId) : Promise.resolve(null),
    ])
    if (!financials) return
    const orderId = String(load.orderId ?? '')
    const order = orderId ? await deps.getById(deps.tables.order, orderId) : null
    // Step I. The team the revenue belongs to is on the billed account, not on the
    // load, so the customer row is read for `teamKey` — the one field a sample
    // cannot derive from the freight itself.
    const customerId = String(order?.customerId ?? shipment?.customerId ?? '')
    const customer = customerId ? await deps.getById(deps.tables.customer, customerId) : null
    // The carrier whose money is on this load: the one on it now, or the TONU'd one
    // that is still owed. A bounced assignment took its charges with it.
    const assignments = shipmentId
      ? await deps.queryIndex(deps.tables.loadCarrier, IDX_CARRIERS_BY_SHIPMENT, 'shipmentId', shipmentId)
      : []
    const mine = assignments.filter((row) => String(row.loadId ?? '') === loadId)
    const loadCarrier = mine.find((row) => row.status === 'ACTIVE') ?? mine.find((row) => row.status === 'TONU') ?? null

    const sample = laneSampleFor(
      {
        load: { ...load, id: loadId, stops: readStops(load) } as never,
        financials: financials as never,
        order: order as never,
        loadCarrier: loadCarrier as never,
        shipment: shipment as never,
        customer: customer as never,
      },
      nowIso(),
    )
    if (!sample) return

    // Step R. The facts the Brokerage dashboard's tracking and POD cards are made
    // of. None of them is derivable from the money, so each is read from the row
    // that owns it: the tag and the rep from the mirrored Load, the tracking record
    // from the load's own log, and the POD from the shipment's document index.
    const settings = await deps.getSettings()
    const [checkCalls, documents] = await Promise.all([
      LOAD_CHECK_CALL_TABLE_NAME
        ? deps.queryIndex(LOAD_CHECK_CALL_TABLE_NAME, IDX_CHECK_CALLS_BY_LOAD, 'loadId', loadId)
        : Promise.resolve([] as Row[]),
      shipmentId && deps.store.tables.shipmentDocument
        ? deps.queryIndex(deps.store.tables.shipmentDocument, IDX_DOCUMENTS_BY_SHIPMENT, 'shipmentId', shipmentId)
        : Promise.resolve([] as Row[]),
    ])
    const tracking = trackingFactsOf(
      checkCalls,
      numberOrNull(settings?.checkCallGraceMinutes) ?? DEFAULT_CHECK_CALL_GRACE_MINUTES,
    )

    const existing = await deps.getById(deps.tables.laneSample, sample.id)
    const now = nowIso()
    await deps.db.send(
      new PutItemCommand({
        TableName: deps.tables.laneSample,
        Item: marshallRow(compact({
          ...sample,
          __typename: 'LaneRateSample',
          // The tag and the rep are the Load's mirrors of the Shipment's, so the
          // dashboard groups by division without reading a second table.
          revDivision: load.revDivision ?? shipment?.revDivision ?? null,
          revSubdivision: load.revSubdivision ?? shipment?.revSubdivision ?? null,
          salesRepId: load.salesRepId ?? shipment?.salesRepId ?? null,
          deliveredAt: load.deliveredAt ?? null,
          trackingProvider: load.trackingProvider ?? null,
          firstPingAt: tracking.firstPingAt,
          checkCallsDue: tracking.checkCallsDue,
          checkCallsMet: tracking.checkCallsMet,
          datPostedAt: shipment?.datPostedAt ?? null,
          // A stamp already on the row wins: `documents.ts` writes it the moment the
          // POD lands, and a refresh must never move the clock the dashboard times.
          podReceivedAt: (existing?.podReceivedAt as string | undefined) ?? podReceivedAtOf(documents, loadId),
          // An exclusion already recorded is a fact about the load, not about its
          // price: a later re-price must not quietly put it back in the averages.
          excluded: sample.excluded || existing?.excluded === true,
          version: (numberOrNull(existing?.version) ?? 0) + 1,
          createdAt: (existing?.createdAt as string | undefined) ?? now,
          updatedAt: now,
        })),
      }),
    )
  } catch (err) {
    console.warn('[tms-shipment-actions] lane sample write failed:', String(err))
  }
}

/**
 * Keep the row, stop counting it.
 *
 * A shipment canceled or a carrier TONU'd after delivery does not un-happen: the
 * history keeps what it recorded and the statistics skip it. Conditioned on the
 * sample existing, so a load that never produced one is left alone.
 */
export async function excludeLaneSample(deps: QuoteDeps, loadId: string): Promise<void> {
  if (!deps.tables.laneSample || !loadId) return
  try {
    await deps.db.send(
      new UpdateItemCommand({
        TableName: deps.tables.laneSample,
        Key: marshall({ id: `lrs:${loadId}` }),
        UpdateExpression: 'SET excluded = :true, updatedAt = :now',
        ConditionExpression: 'attribute_exists(id)',
        ExpressionAttributeValues: { ':true': { BOOL: true }, ':now': { S: nowIso() } },
      }),
    )
  } catch (err) {
    // No sample for this load is the ordinary case, not a failure.
    console.warn('[tms-shipment-actions] lane sample exclude skipped:', String(err))
  }
}

