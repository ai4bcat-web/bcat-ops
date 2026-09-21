/**
 * motive-fault-sync Lambda
 *
 * Runs on an EventBridge cron. Each run:
 *   1. Fetches every open fault code from Motive in one paginated call.
 *   2. Builds a unitNumber → Equipment.id map (trucks only) so codes link to
 *      truck records where they exist.
 *   3. Upserts each open code into TruckFaultCode keyed by (truckId, faultId).
 *   4. Removes stale rows — any (truckId, faultId) no longer open in Motive is
 *      deleted. This pass runs even when Motive returns zero codes, so repaired
 *      trucks clear out.
 *
 * Motive API key lives ONLY in process.env.MOTIVE_API_KEY (Amplify Secret).
 * Never logged or committed.
 *
 * TruckFaultCode is keyed by (truckId, faultId), so re-syncing an open code is
 * idempotent and stale rows are the only way a repaired truck's code clears.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  ScanCommand,
  PutCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb'
import { fetchOpenFaultCodes } from './motiveClient'

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}))

const EQUIPMENT_TABLE        = process.env.EQUIPMENT_TABLE_NAME!
const TRUCK_FAULT_CODE_TABLE = process.env.TRUCK_FAULT_CODE_TABLE_NAME!
const MOTIVE_API_KEY         = process.env.MOTIVE_API_KEY!

/**
 * Map of Motive vehicle number → Equipment (trucks only). A truck reports under
 * Equipment.motiveVehicleNumber when set (ELD carried over from a retired truck),
 * else its unitNumber.
 *
 * Retired trucks stay in the map: their codes must keep pointing at the Equipment row
 * so the dashboard can tell "this truck is inactive" from "we have never heard of this
 * vehicle" — dropping them here would re-key the codes as `motive:<number>` and make a
 * retired truck look like an unknown one. An active claim always wins the key.
 */
type MotiveMatch = { id: string; unitNumber: string; override: boolean; active: boolean }

async function fetchEquipmentByMotiveNumber(): Promise<Map<string, MotiveMatch>> {
  const map = new Map<string, MotiveMatch>()
  let token: Record<string, unknown> | undefined
  do {
    const result = await dynamo.send(new ScanCommand({
      TableName:                 EQUIPMENT_TABLE,
      FilterExpression:          '#t = :truck',
      ExpressionAttributeNames:  { '#t': 'type' },
      ExpressionAttributeValues: { ':truck': 'truck' },
      ExclusiveStartKey:         token as Record<string, never> | undefined,
    }))
    // Precedence for one Motive number: explicit override, then an active truck, then a retired one.
    const rank = (over: boolean, active: boolean) => (over ? 2 : active ? 1 : 0)
    for (const item of result.Items ?? []) {
      if (!item.unitNumber || !item.id) continue
      const override = item.motiveVehicleNumber ? String(item.motiveVehicleNumber) : null
      const key = override ?? String(item.unitNumber)
      const active = item.active !== false
      const existing = map.get(key)
      if (existing && rank(existing.override, existing.active) >= rank(override != null, active)) continue
      map.set(key, { id: String(item.id), unitNumber: String(item.unitNumber), override: override != null, active })
    }
    token = result.LastEvaluatedKey
  } while (token)
  return map
}

export const handler = async (): Promise<void> => {
  console.log('[motive-fault-sync] start')

  if (!MOTIVE_API_KEY) throw new Error('MOTIVE_API_KEY secret not set')

  const faults = await fetchOpenFaultCodes(MOTIVE_API_KEY)
  console.log(`[motive-fault-sync] fetched ${faults.length} open fault code(s)`)

  // Link to a truck record by Motive number where possible (retired trucks included, so
  // the dashboard can hide them); no ownership filter.
  const equipmentByMotive = await fetchEquipmentByMotiveNumber()

  const now = new Date().toISOString()
  const activeKeys = new Set<string>()
  let written = 0

  for (const fault of faults) {
    // Match to an Equipment record when the Motive number lines up, else key by
    // the Motive number so the vehicle is still tracked.
    const eq = equipmentByMotive.get(fault.vehicleNumber)
    const truckId = eq?.id ?? `motive:${fault.vehicleNumber}`
    const unitNumber = eq?.unitNumber ?? fault.vehicleNumber

    activeKeys.add(`${truckId}#${fault.faultId}`)

    const item = {
      truckId,
      unitNumber,
      faultId: fault.faultId,
      code: fault.code,
      ...(fault.description && { description: fault.description }),
      ...(fault.sourceLabel && { sourceLabel: fault.sourceLabel }),
      ...(fault.fmiDescription && { fmiDescription: fault.fmiDescription }),
      ...(fault.faultType && { faultType: fault.faultType }),
      ...(typeof fault.occurrenceCount === 'number' && { occurrenceCount: fault.occurrenceCount }),
      ...(fault.firstObservedAt && { firstObservedAt: fault.firstObservedAt }),
      ...(fault.lastObservedAt && { lastObservedAt: fault.lastObservedAt }),
      ...(fault.vehicleMake && { vehicleMake: fault.vehicleMake }),
      ...(fault.vehicleModel && { vehicleModel: fault.vehicleModel }),
      ...(fault.network && { network: fault.network }),
      source: 'motive',
      syncedAt: now,
      createdAt: now,
      updatedAt: now,
    }

    try {
      await dynamo.send(new PutCommand({
        TableName: TRUCK_FAULT_CODE_TABLE,
        Item:      item,
      }))
      written++
      console.log(`[fault] truck=${unitNumber} faultId=${fault.faultId} code=${fault.code}`)
    } catch (err) {
      console.error(`[fault] failed truck=${unitNumber} faultId=${fault.faultId}:`, err)
    }
  }

  // Delete any row whose (truckId, faultId) is no longer open in Motive.
  // This must run even if Motive returned zero open codes (table becomes empty).
  let deleted = 0
  let token: Record<string, unknown> | undefined
  do {
    const result = await dynamo.send(new ScanCommand({
      TableName:         TRUCK_FAULT_CODE_TABLE,
      ProjectionExpression: 'truckId, faultId',
      ExclusiveStartKey: token as Record<string, never> | undefined,
    }))
    for (const item of result.Items ?? []) {
      const truckId = String(item.truckId ?? '')
      const faultId = String(item.faultId ?? '')
      if (!activeKeys.has(`${truckId}#${faultId}`)) {
        try {
          await dynamo.send(new DeleteCommand({
            TableName: TRUCK_FAULT_CODE_TABLE,
            Key:       { truckId, faultId },
          }))
          deleted++
        } catch (err) {
          console.error(`[fault] failed to delete stale truckId=${truckId} faultId=${faultId}:`, err)
        }
      }
    }
    token = result.LastEvaluatedKey
  } while (token)

  console.log(`[motive-fault-sync] complete — ${written} written, ${deleted} deleted`)
}
