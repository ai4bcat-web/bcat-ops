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

function yearStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
}

function yearEnd(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), 11, 31))
}

/** Every day in [startDate, endDate] inclusive (each day's start == end). */
function daysInRange(startDate: string, endDate: string): Array<{ start: string; end: string }> {
  const days: Array<{ start: string; end: string }> = []
  const cursor = new Date(startDate + 'T12:00:00Z')
  const last = new Date(endDate + 'T12:00:00Z')
  while (cursor <= last) {
    const iso = toIso(cursor)
    days.push({ start: iso, end: iso })
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return days
}

/** All Jan-1 year-starts covering [startDate, endDate] inclusive. */
function yearsInRange(startDate: string, endDate: string): Array<{ start: string; end: string }> {
  const years: Array<{ start: string; end: string }> = []
  let y = new Date(startDate + 'T12:00:00Z').getUTCFullYear()
  const lastY = new Date(endDate + 'T12:00:00Z').getUTCFullYear()
  while (y <= lastY) {
    const d = new Date(Date.UTC(y, 6, 1))
    years.push({ start: toIso(yearStart(d)), end: toIso(yearEnd(d)) })
    y++
  }
  return years
}

/** Run async tasks with a bounded concurrency (keeps us under the Motive rate
 *  limit and the Lambda timeout during large backfills). */
async function runPooled<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let i = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++
      await worker(items[idx])
    }
  })
  await Promise.all(runners)
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
      // Skip trucks on a non-Motive ELD (own device, or Blue Ink Tech) — they are
      // synced elsewhere, not by Motive.
      const eld = item.eldSource ? String(item.eldSource) : ''
      if (eld === 'manual' || eld === 'blueink') continue
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

type PeriodType = 'DAY' | 'WEEK' | 'MONTH' | 'YEAR'

interface Period {
  start: string
  end:   string
  type:  PeriodType
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
  mode:           'backfill'
  startDate:      string         // YYYY-MM-DD
  endDate:        string         // YYYY-MM-DD
  granularities?: PeriodType[]   // default: all four
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
    const want = new Set<PeriodType>(event.granularities ?? ['DAY', 'WEEK', 'MONTH', 'YEAR'])
    const gens: Array<[PeriodType, (s: string, e: string) => Array<{ start: string; end: string }>]> = [
      ['DAY',   daysInRange],
      ['WEEK',  weeksInRange],
      ['MONTH', monthsInRange],
      ['YEAR',  yearsInRange],
    ]
    periods = gens
      .filter(([t]) => want.has(t))
      .flatMap(([t, gen]) => gen(startDate, endDate).map((p) => ({ ...p, type: t })))
    console.log(`[motive-mileage-sync] backfill ${startDate}–${endDate}: ${periods.length} periods (${[...want].join(',')})`)
  } else {
    // Daily cron: re-sync the last 7 DAY rows (IFTA data lags a day or two, so
    // syncing only "today" leaves the Day view perpetually empty — re-pulling the
    // recent days lets lagged miles populate), plus week/month/year to-date.
    const now   = new Date()
    const today = toIso(now)
    const weekAgo = toIso(new Date(now.getTime() - 6 * 86_400_000))
    periods = [
      ...daysInRange(weekAgo, today).map((d) => ({ ...d, type: 'DAY' as const })),
      { start: toIso(weekMonday(now)), end: today, type: 'WEEK'  },
      { start: toIso(monthStart(now)), end: today, type: 'MONTH' },
      { start: toIso(yearStart(now)),  end: today, type: 'YEAR'  },
    ]
    console.log(`[motive-mileage-sync] daily sync: last 7 days + week/month/year through ${today}`)
  }

  // Bounded concurrency across (truck × period) so big backfills stay under the timeout.
  const jobs = trucks.flatMap((truck) => periods.map((period) => ({ truck, period })))
  await runPooled(jobs, 5, ({ truck, period }) => syncTruck(truck, [period]))

  console.log(`[motive-mileage-sync] complete — ${jobs.length} (truck × period) writes`)
}
