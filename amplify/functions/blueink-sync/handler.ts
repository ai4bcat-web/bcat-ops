/**
 * blueink-sync Lambda — Blue Ink Tech (BIT) ELD → dashboard.
 *
 * Writes into the SAME tables as the Motive sync so a BIT truck (unit 310, Roy
 * Workman) shows up identically on the map / miles widget / profitability:
 *   • TruckLocation + TruckLocationHistory  (source 'blueink')
 *   • TruckMileage                          (source 'blueink')
 * Each BIT vehicle is matched to an Equipment record by unit number; if none
 * exists it is keyed `blueink:<number>` so it is still tracked.
 *
 * Invocation modes:
 *   {}                       → location sync (frequent cron)
 *   { mode: 'mileage' }      → mileage sync: day/week/month/year through today
 *   { mode: 'backfill', startDate, endDate, granularities? } → backfill miles
 *
 * BLUE_INK_TECH_API_KEY lives ONLY in the Amplify secret — never logged/committed.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb'
import { fetchVehicles, fetchVehicleLocations, fetchMilesForVehicle } from './blueinkClient'

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}))

const EQUIPMENT_TABLE              = process.env.EQUIPMENT_TABLE_NAME!
const TRUCK_MILEAGE_TABLE          = process.env.TRUCK_MILEAGE_TABLE_NAME!
const TRUCK_LOCATION_TABLE         = process.env.TRUCK_LOCATION_TABLE_NAME!
const TRUCK_LOCATION_HISTORY_TABLE = process.env.TRUCK_LOCATION_HISTORY_TABLE_NAME!
const API_KEY                      = process.env.BLUE_INK_TECH_API_KEY!

// ── Date helpers (UTC, matching motive-mileage-sync) ───────────────────────────

function toIso(d: Date): string { return d.toISOString().slice(0, 10) }
function weekMonday(d: Date): Date {
  const c = new Date(d); const day = c.getUTCDay(); const diff = day === 0 ? -6 : 1 - day
  c.setUTCDate(c.getUTCDate() + diff); return c
}
function weekSunday(d: Date): Date { const m = weekMonday(d); const s = new Date(m); s.setUTCDate(m.getUTCDate() + 6); return s }
function monthStart(d: Date): Date { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)) }
function monthEnd(d: Date): Date { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)) }
function yearStart(d: Date): Date { return new Date(Date.UTC(d.getUTCFullYear(), 0, 1)) }
function yearEnd(d: Date): Date { return new Date(Date.UTC(d.getUTCFullYear(), 11, 31)) }

function daysInRange(start: string, end: string): Array<{ start: string; end: string }> {
  const out: Array<{ start: string; end: string }> = []
  const cur = new Date(start + 'T12:00:00Z'); const last = new Date(end + 'T12:00:00Z')
  while (cur <= last) { const iso = toIso(cur); out.push({ start: iso, end: iso }); cur.setUTCDate(cur.getUTCDate() + 1) }
  return out
}
function weeksInRange(start: string, end: string): Array<{ start: string; end: string }> {
  const out: Array<{ start: string; end: string }> = []
  const cur = weekMonday(new Date(start + 'T12:00:00Z')); const last = new Date(end + 'T12:00:00Z')
  while (cur <= last) { out.push({ start: toIso(cur), end: toIso(weekSunday(cur)) }); cur.setUTCDate(cur.getUTCDate() + 7) }
  return out
}
function monthsInRange(start: string, end: string): Array<{ start: string; end: string }> {
  const out: Array<{ start: string; end: string }> = []
  let cur = monthStart(new Date(start + 'T12:00:00Z')); const last = new Date(end + 'T12:00:00Z')
  while (cur <= last) { out.push({ start: toIso(cur), end: toIso(monthEnd(cur)) }); const n = new Date(cur); n.setUTCMonth(n.getUTCMonth() + 1); cur = n }
  return out
}
function yearsInRange(start: string, end: string): Array<{ start: string; end: string }> {
  const out: Array<{ start: string; end: string }> = []
  let y = new Date(start + 'T12:00:00Z').getUTCFullYear(); const lastY = new Date(end + 'T12:00:00Z').getUTCFullYear()
  while (y <= lastY) { const d = new Date(Date.UTC(y, 6, 1)); out.push({ start: toIso(yearStart(d)), end: toIso(yearEnd(d)) }); y++ }
  return out
}

// ── Equipment lookup ───────────────────────────────────────────────────────────

/** Map of Equipment unitNumber → Equipment.id (trucks only). */
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

function truckIdFor(unit: string, equipmentByUnit: Map<string, string>): string {
  return equipmentByUnit.get(unit) ?? `blueink:${unit}`
}

// ── Location sync ───────────────────────────────────────────────────────────────

async function syncLocations(): Promise<void> {
  const locations = await fetchVehicleLocations(API_KEY)
  console.log(`[blueink-location] fetched ${locations.length} vehicle location(s)`)
  if (locations.length === 0) return

  const equipmentByUnit = await fetchEquipmentByUnit()
  const now = new Date().toISOString()
  let synced = 0

  for (const loc of locations) {
    const truckId = truckIdFor(loc.number, equipmentByUnit)
    const motion = loc.speed != null && loc.speed >= 1 ? 'MOVING' : 'STATIONARY'

    // Preserve motionSince across pings of the same state (for "moving/idle for X").
    let motionSince = loc.locatedAt
    try {
      const prev = await dynamo.send(new GetCommand({ TableName: TRUCK_LOCATION_TABLE, Key: { truckId } }))
      const prevItem = prev.Item as { motion?: string; motionSince?: string } | undefined
      if (prevItem?.motion === motion && prevItem.motionSince) motionSince = prevItem.motionSince
    } catch (err) {
      console.warn(`[blueink-location] could not read prior state for truck=${loc.number}:`, err)
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
      source:      'blueink',
      syncedAt:    now,
    }

    try {
      await dynamo.send(new PutCommand({
        TableName: TRUCK_LOCATION_TABLE,
        Item: { truckId, locatedAt: loc.locatedAt, ...base, createdAt: now, updatedAt: now },
      }))
      await dynamo.send(new PutCommand({
        TableName: TRUCK_LOCATION_HISTORY_TABLE,
        Item: { truckId, locatedAt: loc.locatedAt, ...base, createdAt: now, updatedAt: now },
      }))
      synced++
      console.log(`[blueink-location] truck=${loc.number} @ ${loc.lat.toFixed(5)},${loc.lon.toFixed(5)} (${loc.locatedAt})`)
    } catch (err) {
      console.error(`[blueink-location] failed truck=${loc.number}:`, err)
    }
  }
  console.log(`[blueink-location] complete — ${synced}/${locations.length} updated`)
}

// ── Mileage sync ─────────────────────────────────────────────────────────────────

type PeriodType = 'DAY' | 'WEEK' | 'MONTH' | 'YEAR'
interface Period { start: string; end: string; type: PeriodType }

async function upsertMileage(truckId: string, unitNumber: string, periodStart: string, periodType: string, miles: number) {
  const now = new Date().toISOString()
  await dynamo.send(new PutCommand({
    TableName: TRUCK_MILEAGE_TABLE,
    Item: {
      truckId,
      periodStart,
      periodType,
      // Amplify Gen 2 composite sort key (2nd+ identifier fields joined by '#') — must be
      // supplied explicitly when writing via the DynamoDB SDK rather than AppSync.
      'periodStart#periodType': `${periodStart}#${periodType}`,
      unitNumber,
      miles,
      source:    'blueink',
      syncedAt:  now,
      createdAt: now,
      updatedAt: now,
    },
  }))
  console.log(`[blueink-mileage] upserted truck=${unitNumber} ${periodType} ${periodStart} → ${miles.toFixed(1)} mi`)
}

async function syncMileage(periods: Period[]): Promise<void> {
  const vehicles = await fetchVehicles(API_KEY)
  if (vehicles.size === 0) { console.log('[blueink-mileage] no BIT vehicles — nothing to sync'); return }
  const equipmentByUnit = await fetchEquipmentByUnit()
  console.log(`[blueink-mileage] ${vehicles.size} BIT vehicle(s), ${periods.length} period(s)`)

  for (const v of vehicles.values()) {
    const truckId = truckIdFor(v.number, equipmentByUnit)
    for (const period of periods) {
      try {
        const miles = await fetchMilesForVehicle(API_KEY, v.id, period.start, period.end)
        await upsertMileage(truckId, v.number, period.start, period.type, miles)
      } catch (err) {
        console.error(`[blueink-mileage] failed truck=${v.number} ${period.type} ${period.start}:`, err)
      }
    }
  }
}

// ── Handler ──────────────────────────────────────────────────────────────────────

interface BackfillEvent { mode: 'backfill'; startDate: string; endDate: string; granularities?: PeriodType[] }
function isBackfill(e: unknown): e is BackfillEvent {
  const o = e as Record<string, unknown>
  return !!o && o.mode === 'backfill' && typeof o.startDate === 'string' && typeof o.endDate === 'string'
}

export const handler = async (event: Record<string, unknown> = {}): Promise<void> => {
  console.log('[blueink-sync] start', JSON.stringify(event))
  if (!API_KEY) throw new Error('BLUE_INK_TECH_API_KEY secret not set')

  if (isBackfill(event)) {
    const { startDate, endDate } = event
    const want = new Set<PeriodType>(event.granularities ?? ['DAY', 'WEEK', 'MONTH', 'YEAR'])
    const gens: Array<[PeriodType, (s: string, e: string) => Array<{ start: string; end: string }>]> = [
      ['DAY', daysInRange], ['WEEK', weeksInRange], ['MONTH', monthsInRange], ['YEAR', yearsInRange],
    ]
    const periods = gens.filter(([t]) => want.has(t)).flatMap(([t, gen]) => gen(startDate, endDate).map((p) => ({ ...p, type: t })))
    await syncMileage(periods)
    return
  }

  if (event.mode === 'mileage') {
    const now = new Date(); const today = toIso(now)
    await syncMileage([
      { start: today,                  end: today, type: 'DAY'   },
      { start: toIso(weekMonday(now)), end: today, type: 'WEEK'  },
      { start: toIso(monthStart(now)), end: today, type: 'MONTH' },
      { start: toIso(yearStart(now)),  end: today, type: 'YEAR'  },
    ])
    return
  }

  // Default: location sync (frequent cron).
  await syncLocations()
}
