/**
 * motive-location-sync Lambda
 *
 * Runs on a 10-minute EventBridge cron. Each run:
 *   1. Fetches every vehicle's latest location from Motive in one paginated call.
 *   2. Builds a unitNumber → Equipment.id map (trucks only) so positions link to
 *      truck records where they exist. No ownership filter — ALL ELDs are tracked.
 *   3. For every Motive vehicle (matched or not):
 *        - upserts TruckLocation (current position — overwrites)
 *        - appends a TruckLocationHistory record (breadcrumb trail)
 *      Unmatched vehicles are keyed by `motive:<number>` so they still appear.
 *
 * Motive API key lives ONLY in process.env.MOTIVE_API_KEY (Amplify Secret).
 * Never logged or committed.
 *
 * TruckLocation is keyed by truckId so re-syncing overwrites the current fix.
 * TruckLocationHistory is keyed by (truckId, locatedAt) so re-running with the
 * same Motive fix is idempotent (no duplicate breadcrumbs).
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  ScanCommand,
  PutCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb'
import { fetchVehicleLocations } from './motiveClient'

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}))

const EQUIPMENT_TABLE      = process.env.EQUIPMENT_TABLE_NAME!
const TRUCK_LOCATION_TABLE = process.env.TRUCK_LOCATION_TABLE_NAME!
const TRUCK_LOCATION_HISTORY_TABLE = process.env.TRUCK_LOCATION_HISTORY_TABLE_NAME!
const MOTIVE_API_KEY       = process.env.MOTIVE_API_KEY!

/** Map of Equipment unitNumber → Equipment.id, for trucks only. */
async function fetchEquipmentByUnit(): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  let token: Record<string, unknown> | undefined
  do {
    const result = await dynamo.send(new ScanCommand({
      TableName:                 EQUIPMENT_TABLE,
      FilterExpression:          '#t = :truck',
      ExpressionAttributeNames:  { '#t': 'type' },
      ExpressionAttributeValues: { ':truck': 'truck' },
      ExclusiveStartKey:         token as Record<string, never> | undefined,
    }))
    for (const item of result.Items ?? []) {
      if (item.unitNumber && item.id) map.set(String(item.unitNumber), String(item.id))
    }
    token = result.LastEvaluatedKey
  } while (token)
  return map
}

export const handler = async (): Promise<void> => {
  console.log('[motive-location-sync] start')

  if (!MOTIVE_API_KEY) throw new Error('MOTIVE_API_KEY secret not set')

  const locations = await fetchVehicleLocations(MOTIVE_API_KEY)
  console.log(`[motive-location-sync] fetched ${locations.length} vehicle location(s)`)
  if (locations.length === 0) {
    console.log('[motive-location-sync] no vehicle locations returned by Motive — nothing to sync')
    return
  }

  // Link to truck records by unit number where possible; no ownership filter.
  const equipmentByUnit = await fetchEquipmentByUnit()

  const now = new Date().toISOString()
  let synced = 0

  for (const loc of locations) {
    // Match to an Equipment record when the unit number lines up, else key by
    // the Motive number so the vehicle is still tracked on the map.
    const truckId = equipmentByUnit.get(loc.number) ?? `motive:${loc.number}`

    // Moving vs. sitting, from the ping's speed (mph). >=1 mph avoids GPS jitter.
    const motion = loc.speed != null && loc.speed >= 1 ? 'MOVING' : 'STATIONARY'

    // Preserve the timestamp the truck entered its current motion state: read the
    // previous record and keep its motionSince if the state hasn't changed, so the
    // dashboard can show "moving/idle for X". On a state flip, reset to this fix.
    let motionSince = loc.locatedAt
    try {
      const prev = await dynamo.send(new GetCommand({
        TableName: TRUCK_LOCATION_TABLE,
        Key: { truckId },
      }))
      const prevItem = prev.Item as { motion?: string; motionSince?: string } | undefined
      if (prevItem?.motion === motion && prevItem.motionSince) {
        motionSince = prevItem.motionSince
      }
    } catch (err) {
      console.warn(`[location] could not read prior state for truck=${loc.number}:`, err)
    }

    const base = {
      unitNumber:  loc.number,
      lat:         loc.lat,
      lon:         loc.lon,
      bearing:     loc.bearing,
      speed:       loc.speed,
      description: loc.description,
      motion,
      motionSince,
      source:      'motive',
      syncedAt:    now,
    }

    try {
      // Current location — overwrites previous fix for this truck.
      await dynamo.send(new PutCommand({
        TableName: TRUCK_LOCATION_TABLE,
        Item: {
          truckId,
          locatedAt: loc.locatedAt,
          ...base,
          createdAt: now,
          updatedAt: now,
        },
      }))

      // Breadcrumb — idempotent on (truckId, locatedAt).
      await dynamo.send(new PutCommand({
        TableName: TRUCK_LOCATION_HISTORY_TABLE,
        Item: {
          truckId,
          locatedAt: loc.locatedAt,
          ...base,
          createdAt: now,
          updatedAt: now,
        },
      }))

      synced++
      console.log(`[location] truck=${loc.number} @ ${loc.lat.toFixed(5)},${loc.lon.toFixed(5)} (${loc.locatedAt})`)
    } catch (err) {
      console.error(`[location] failed truck=${loc.number}:`, err)
    }
  }

  console.log(`[motive-location-sync] complete — ${synced}/${locations.length} truck(s) updated (${equipmentByUnit.size} matched to Equipment)`)
}
