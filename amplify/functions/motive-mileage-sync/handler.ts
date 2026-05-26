/**
 * motive-mileage-sync Lambda
 *
 * Invocation modes:
 *   EventBridge daily cron (2:05 AM UTC):
 *     Syncs the rolling 7-day window (Mon–Sun of current week) and current month
 *     for every COMPANY truck in TruckConfig.
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
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import { fetchVehicleMap, fetchMilesForVehicle } from './motiveClient'

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}))

const TRUCK_CONFIG_TABLE   = process.env.TRUCK_CONFIG_TABLE_NAME!
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
  let cursor = weekMonday(new Date(startDate + 'T12:00:00Z'))
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

interface TruckConfig {
  truckId:             string
  unitNumber:          string
  ownershipType?:      string
  motiveVehicleId?:    number
  motiveVehicleNumber?: string
}

async function listCompanyTrucks(): Promise<TruckConfig[]> {
  const result = await dynamo.send(new ScanCommand({
    TableName:        TRUCK_CONFIG_TABLE,
    FilterExpression: 'ownershipType = :ot',
    ExpressionAttributeValues: { ':ot': 'COMPANY' },
  }))
  return (result.Items ?? []) as TruckConfig[]
}

async function updateMotiveVehicleId(truckId: string, vehicleId: number, vehicleNumber: string) {
  await dynamo.send(new UpdateCommand({
    TableName: TRUCK_CONFIG_TABLE,
    Key: { truckId },
    UpdateExpression: 'SET motiveVehicleId = :vid, motiveVehicleNumber = :vnum, updatedAt = :ts',
    ExpressionAttributeValues: {
      ':vid':  vehicleId,
      ':vnum': vehicleNumber,
      ':ts':   new Date().toISOString(),
    },
  }))
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

async function syncTruck(
  truck:      TruckConfig,
  periods:    Period[],
  vehicleMap: Map<string, { id: number; number: string }>,
): Promise<void> {
  // Resolve Motive vehicle ID if not yet stored
  let vehicleId = truck.motiveVehicleId
  if (!vehicleId) {
    const v = vehicleMap.get(truck.unitNumber)
    if (!v) {
      console.warn(`[mileage] no Motive vehicle found for unit ${truck.unitNumber} — skipping`)
      return
    }
    vehicleId = v.id
    await updateMotiveVehicleId(truck.truckId, v.id, v.number)
    console.log(`[mileage] resolved Motive vehicle ID ${v.id} for unit ${truck.unitNumber}`)
  }

  for (const period of periods) {
    try {
      const miles = await fetchMilesForVehicle(MOTIVE_API_KEY, vehicleId, period.start, period.end)
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

  const trucks = await listCompanyTrucks()
  if (trucks.length === 0) {
    console.log('[motive-mileage-sync] no COMPANY trucks configured — nothing to sync')
    return
  }
  console.log(`[motive-mileage-sync] syncing ${trucks.length} COMPANY truck(s)`)

  // Build vehicle map once (avoids N API calls to look up IDs)
  const vehicleMap = await fetchVehicleMap(MOTIVE_API_KEY)
  console.log(`[motive-mileage-sync] fetched ${vehicleMap.size} Motive vehicles`)

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
    await syncTruck(truck, periods, vehicleMap)
  }

  console.log('[motive-mileage-sync] complete')
}
