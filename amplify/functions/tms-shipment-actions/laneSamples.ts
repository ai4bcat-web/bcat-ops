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
  marshallRow,
  nowIso,
  numberOrNull,
  readStops,
} from '../_shared/shipmentStore'
import { laneSampleFor } from '../../../src/lib/laneKey'
import { MOVEMENT_RANK } from '../../../src/lib/shipmentStatus'
import type { LoadWorkflowStatus } from '../../../src/types/tms'
import type { QuoteDeps } from './quotes'

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

    const existing = await deps.getById(deps.tables.laneSample, sample.id)
    const now = nowIso()
    await deps.db.send(
      new PutItemCommand({
        TableName: deps.tables.laneSample,
        Item: marshallRow(compact({
          ...sample,
          __typename: 'LaneRateSample',
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

