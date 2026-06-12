/**
 * motive-mileage-sync Lambda
 *
 * Invocation modes:
 *   EventBridge daily cron (2:05 AM UTC):
 *     Syncs the rolling 7-day window (Mon–Sun of current week) and current month
 *     for EVERY vehicle in Motive (no ownership filter). Each Motive vehicle is
 *     matched to an Equipment record by unit number when one exists; otherwise it
 *     is keyed by the Motive number so it is still tracked.
 *
 *   Manual / backfill:
 *     { "mode": "backfill", "startDate": "2026-01-01", "endDate": "2026-05-31" }
 *     Syncs weekly + monthly periods covering the given range.
 *
 * Motive API key lives ONLY in process.env.MOTIVE_API_KEY (Amplify Secret).
 * Never logged or committed.
 *
 * Idempotent: TruckMileage records use (truckId, periodStart, periodType) as
 * composite primary key, so re-syncing overwrites rather than duplicates.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  ScanCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb'
import { fetchVehicleMap, fetchMilesForVehicle } from './motiveClient'

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}))

const EQUIPMENT_TABLE      = process.env.EQUIPMENT_TABLE_NAME!
const TRUCK_MILEAGE_TABLE  = process.env.TRUCK_MILEAGE_TABLE_NAME!
const MOTIVE_API_KEY       = process.env.MOTIVE_API_KEY!

// ── Date helpers ──────────────────────────────────────────────────────────────

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** Returns the Monday (week start) of the week containing d. */
function weekMonday(d: Date): Date {
  const copy = new Date(d)
  const day = copy.getUTCDay()          // 0 = Sun
  const diff = day === 0 ? -6 : 1 - day // shift to Monday
  copy.setUTCDate(copy.getUTCDate() + diff)
  return copy
}

/** Returns the Sunday (week end) of the week containing d. */
function weekSunday(d: Date): Date {
  const mon = weekMonday(d)
  const sun = new Date(mon)
  sun.setUTCDate(mon.getUTCDate() + 6)
  return sun
}

function monthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
}

function monthEnd(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))
}

/** All Mondays covering [startDate, endDate] inclusive. */
function weeksInRange(startDate: string, endDate: string): Array<{ start: string; end: string }> {
  const weeks: Array<{ start: string; end: string }> = []
  const cursor = weekMonday(new Date(startDate + 'T12:00:00Z'))
  const last = new Date(endDate + 'T12:00:00Z')
  while (cursor <= last) {
    weeks.push({ start: toIso(cursor), end: toIso(weekSunday(cursor)) })
    cursor.setUTCDate(cursor.getUTCDate() + 7)
  }
  return weeks
}

/** All month-starts covering [startDate, endDate] inclusive. */
function monthsInRange(startDate: string, endDate: string): Array<{ start: string; end: string }> {
  const months: Array<{ start: string; end: string }> = []
  let cursor = monthStart(new Date(startDate + 'T12:00:00Z'))
  const last = new Date(endDate + 'T12:00:00Z')
  while (cursor <= last) {
    months.push({ start: toIso(cursor), end: toIso(monthEnd(cursor)) })
    const next = new Date(cursor)
    next.setUTCMonth(next.getUTCMonth() + 1)
    cursor = next
  }
  return months
}

// ── DynamoDB helpers ──────────────────────────────────────────────────────────

// A vehicle to sync miles for. truckId links to an Equipment record when the
// unit number matches one; otherwise it falls back to a Motive-keyed id so the
// vehicle is still tracked even if it isn't set up in the truck registry.
interface SyncTarget {
  truckId:         string
  unitNumber:      string
  motiveVehicleId: number
}

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

async function upsertMileage(
  truckId:     string,
  unitNumber:  string,
  periodStart: string,
  periodType:  string,
  miles:       number,
) {
  const now = new Date().toISOString()
  await dynamo.send(new PutCommand({
    TableName: TRUCK_MILEAGE_TABLE,
    Item: {
      truckId,
      periodStart,
      periodType,
      // Amplify Gen 2 synthesizes a single composite sort key from the 2nd+ identifier
      // fields (joined by '#'). Writing directly to DynamoDB (not via AppSync) means we
      // must supply it ourselves, or the put is rejected with a missing-key error.
      'periodStart#periodType': `${periodStart}#${periodType}`,
      unitNumber,
      miles,
      source:    'motive',
      syncedAt:  now,
      createdAt: now,
      updatedAt: now,
    },
  }))
  console.log(`[mileage] upserted truck=${unitNumber} ${periodType} ${periodStart} → ${miles.toFixed(1)} mi`)
}

// ── Core sync ─────────────────────────────────────────────────────────────────

interface Period {
  start: string
  end:   string
  type:  'WEEK' | 'MONTH'
}

async function syncTruck(truck: SyncTarget, periods: Period[]): Promise<void> {
  for (const period of periods) {
    try {
      const miles = await fetchMilesForVehicle(MOTIVE_API_KEY, truck.motiveVehicleId, period.start, period.end)
      await upsertMileage(truck.truckId, truck.unitNumber, period.start, period.type, miles)
    } catch (err) {
      // Log and continue — one period failing shouldn't abort the whole sync
      console.error(`[mileage] failed truck=${truck.unitNumber} ${period.type} ${period.start}:`, err)
    }
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

interface BackfillEvent {
  mode:      'backfill'
  startDate: string   // YYYY-MM-DD
  endDate:   string   // YYYY-MM-DD
}

function isBackfillEvent(e: unknown): e is BackfillEvent {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as Record<string, unknown>).mode === 'backfill' &&
    typeof (e as Record<string, unknown>).startDate === 'string' &&
    typeof (e as Record<string, unknown>).endDate   === 'string'
  )
}

export const handler = async (event: Record<string, unknown> = {}): Promise<void> => {
  console.log('[motive-mileage-sync] start', JSON.stringify(event))

  if (!MOTIVE_API_KEY) throw new Error('MOTIVE_API_KEY secret not set')

  // Every vehicle in Motive is synced, regardless of ownership/config. Match each
  // to an Equipment record by unit number when possible (so mileage attributes to
  // the right truck for cost-per-mile); otherwise key it by the Motive number.
  const vehicleMap = await fetchVehicleMap(MOTIVE_API_KEY)
  if (vehicleMap.size === 0) {
    console.log('[motive-mileage-sync] no vehicles returned by Motive — nothing to sync')
    return
  }
  const equipmentByUnit = await fetchEquipmentByUnit()
  const trucks: SyncTarget[] = [...vehicleMap.values()].map((v) => ({
    truckId:         equipmentByUnit.get(v.number) ?? `motive:${v.number}`,
    unitNumber:      v.number,
    motiveVehicleId: v.id,
  }))
  console.log(`[motive-mileage-sync] syncing ${trucks.length} Motive vehicle(s) (${equipmentByUnit.size} matched to Equipment)`)

  // Determine periods to sync
  let periods: Period[]
  if (isBackfillEvent(event)) {
    const { startDate, endDate } = event
    const weekPeriods  = weeksInRange(startDate, endDate).map((w) => ({ ...w, type: 'WEEK'  as const }))
    const monthPeriods = monthsInRange(startDate, endDate).map((m) => ({ ...m, type: 'MONTH' as const }))
    periods = [...weekPeriods, ...monthPeriods]
    console.log(`[motive-mileage-sync] backfill ${startDate}–${endDate}: ${weekPeriods.length} weeks, ${monthPeriods.length} months`)
  } else {
    // Daily cron: current week (Mon to today) + current month (1st to today)
    const today = toIso(new Date())
    const mon   = toIso(weekMonday(new Date()))
    const m1    = toIso(monthStart(new Date()))
    periods = [
      { start: mon, end: today, type: 'WEEK'  },
      { start: m1,  end: today, type: 'MONTH' },
    ]
    console.log(`[motive-mileage-sync] daily sync: week ${mon}–${today}, month ${m1}–${today}`)
  }

  for (const truck of trucks) {
    await syncTruck(truck, periods)
  }

  console.log('[motive-mileage-sync] complete')
}
