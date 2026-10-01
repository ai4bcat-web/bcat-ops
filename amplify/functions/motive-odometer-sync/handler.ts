/**
 * motive-odometer-sync Lambda
 *
 * Two EventBridge crons drive one weekly odometer ledger, keyed by
 * (truckId, date) in TruckOdometerDay:
 *
 *   openWeek  — Sunday 06:00 UTC. Records each Motive truck's odometer at the
 *               start of the new Central day, which is the week's opening read.
 *   closeDay  — every day 06:00 UTC, targeting the PREVIOUS America/Chicago
 *               calendar day. Records that day's end odometer, computes miles as
 *               end − previous reading (never negative), and pulls Motive's
 *               daily driving fuel to derive MPG.
 *
 * Why 06:00 UTC and "previous Central day":
 *   EventBridge cron is always UTC and does not follow US daylight saving, so a
 *   single expression cannot land on 23:59 Chicago all year. 06:00 UTC is 00:00
 *   CST (winter) / 01:00 CDT (summer) — after midnight either way — so the run
 *   is unambiguously *after* the Central day it closes. The day being closed is
 *   therefore the previous Central date, which makes the reading the day's end
 *   rather than the next day's start. (05:00 UTC would be 23:00 CST in winter
 *   and 00:00 CDT in summer; 06:00 keeps the date mapping identical in both.)
 *
 * Motive API key lives ONLY in process.env.MOTIVE_API_KEY (Amplify Secret).
 * Never logged or committed.
 *
 * Idempotent: TruckOdometerDay is keyed (truckId, date), so re-running a day
 * overwrites rather than duplicates. A day Motive never reported is simply left
 * absent — a visible gap, never an invented figure.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  ScanCommand,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb'
import { fetchVehicleOdometers, fetchVehicleUtilization, type MotiveOdometer } from './motiveClient'

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}))

const EQUIPMENT_TABLE          = process.env.EQUIPMENT_TABLE_NAME!
const TRUCK_ODOMETER_DAY_TABLE = process.env.TRUCK_ODOMETER_DAY_TABLE_NAME!
const MOTIVE_API_KEY           = process.env.MOTIVE_API_KEY!

// ── Date helpers (all dates are YYYY-MM-DD calendar strings) ───────────────────

/** America/Chicago calendar date for a UTC instant, YYYY-MM-DD. */
function centralDate(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(iso))
}

/** The day before a YYYY-MM-DD date. */
function previousDate(date: string): string {
  const d = new Date(date + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/** Sunday that opens the week containing `date` (weeks run Sun–Sat). */
function weekStartFor(date: string): string {
  const d = new Date(date + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() - d.getUTCDay())   // getUTCDay: 0 = Sunday
  return d.toISOString().slice(0, 10)
}

// ── Equipment mapping (mirrors motive-mileage-sync) ────────────────────────────

interface SyncTarget {
  truckId:         string
  unitNumber:      string
  motiveNumber:    string
  motiveVehicleId: number
}

/**
 * Map of Motive vehicle number → Equipment (trucks only). A truck reports under
 * Equipment.motiveVehicleNumber when set (ELD carried over from a retired truck),
 * else its unitNumber. Inactive trucks never claim a Motive vehicle, and trucks
 * on a non-Motive ELD (manual / Blue Ink Tech) are synced elsewhere.
 */
async function fetchEquipmentByMotiveNumber(): Promise<Map<string, { id: string; unitNumber: string; override: boolean }>> {
  const map = new Map<string, { id: string; unitNumber: string; override: boolean }>()
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
      if (item.active === false) continue
      const eld = item.eldSource ? String(item.eldSource) : ''
      if (eld === 'manual' || eld === 'blueink') continue
      if (!item.unitNumber || !item.id) continue
      const override = item.motiveVehicleNumber ? String(item.motiveVehicleNumber) : null
      const key = override ?? String(item.unitNumber)
      if (!override && map.get(key)?.override) continue
      map.set(key, { id: String(item.id), unitNumber: String(item.unitNumber), override: override != null })
    }
    token = result.LastEvaluatedKey
  } while (token)
  return map
}

function targetsFor(vehicles: MotiveOdometer[], equipmentByMotive: Map<string, { id: string; unitNumber: string }>): SyncTarget[] {
  return vehicles.map((v) => {
    const eq = equipmentByMotive.get(v.number)
    return {
      truckId:         eq?.id ?? `motive:${v.number}`,
      unitNumber:      eq?.unitNumber ?? v.number,
      motiveNumber:    v.number,
      motiveVehicleId: v.vehicleId,
    }
  })
}

// ── DynamoDB I/O ───────────────────────────────────────────────────────────────

interface OdometerRow {
  startOdometer?: number | null
  endOdometer?:   number | null
}

async function getOdometerRow(truckId: string, date: string): Promise<OdometerRow | null> {
  const result = await dynamo.send(new GetCommand({
    TableName: TRUCK_ODOMETER_DAY_TABLE,
    Key:       { truckId, date },
  }))
  return (result.Item as OdometerRow | undefined) ?? null
}

// Amplify's default number fields are nullable; a DynamoDB NULL attribute would
// read back as null fine, but omitting the key keeps the item shape identical to
// what the generated resolvers write.
function compact(item: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(item)) {
    if (v !== null && v !== undefined) out[k] = v
  }
  return out
}

async function putOdometerRow(input: {
  truckId:        string
  unitNumber:     string
  date:           string
  weekStart:      string
  startOdometer?: number | null
  endOdometer?:   number | null
  miles?:         number | null
  fuelGallons?:   number | null
  mpg?:           number | null
}): Promise<void> {
  const now = new Date().toISOString()
  // The table's identifier is ['truckId', 'date'], so those two attributes ARE
  // the primary key — no synthesized composite sort key to add (unlike models
  // with three or more identifier fields).
  await dynamo.send(new PutCommand({
    TableName: TRUCK_ODOMETER_DAY_TABLE,
    Item: compact({
      truckId:       input.truckId,
      date:          input.date,
      unitNumber:    input.unitNumber,
      weekStart:     input.weekStart,
      startOdometer: input.startOdometer ?? null,
      endOdometer:   input.endOdometer ?? null,
      miles:         input.miles ?? null,
      fuelGallons:   input.fuelGallons ?? null,
      mpg:           input.mpg ?? null,
      source:        'motive',
      syncedAt:      now,
      createdAt:     now,
      updatedAt:     now,
    }),
  }))
}

/** Index odometer/fuel rows by both Motive vehicle id and fleet number so a
 *  number-only match still resolves. */
function byKey<T extends { vehicleId: number; number: string }>(rows: T[]): { byId: Map<number, T>; byNumber: Map<string, T> } {
  const byId = new Map<number, T>()
  const byNumber = new Map<string, T>()
  for (const row of rows) {
    if (row.vehicleId >= 0) byId.set(row.vehicleId, row)
    byNumber.set(row.number, row)
  }
  return { byId, byNumber }
}

// ── Modes ──────────────────────────────────────────────────────────────────────

async function openWeek(eventTimeIso: string): Promise<void> {
  // Fires Sunday 06:00 UTC ⇒ Sunday in Chicago. weekStart is that Sunday.
  const sunday = centralDate(eventTimeIso)
  const vehicles = await fetchVehicleOdometers(MOTIVE_API_KEY)
  if (vehicles.length === 0) {
    console.log('[odometer] no Motive vehicles — nothing to open')
    return
  }
  const targets = targetsFor(vehicles, await fetchEquipmentByMotiveNumber())
  const { byId, byNumber } = byKey(vehicles)

  let opened = 0
  for (const t of targets) {
    const o = byId.get(t.motiveVehicleId) ?? byNumber.get(t.motiveNumber)
    if (!o || o.odometer == null) {
      console.warn(`[odometer] open: no odometer for unit=${t.unitNumber}`)
      continue
    }
    await putOdometerRow({
      truckId:       t.truckId,
      unitNumber:    t.unitNumber,
      date:          sunday,
      weekStart:     sunday,
      startOdometer: o.odometer,
    })
    opened++
  }
  console.log(`[odometer] openWeek ${sunday}: ${opened}/${targets.length} truck(s) opened`)
}

/**
 * Fuel economy for one truck-day, or null when the day cannot honestly report one.
 * Zero miles against real driving fuel is a missing odometer reading, not a truck
 * that burned 46 gallons standing still — printing 0.0 MPG next to a day the
 * driver knows he drove is worse than printing nothing.
 */
export function dayMpg(miles: number | null, fuelGallons: number | null): number | null {
  if (miles == null || miles <= 0) return null
  if (fuelGallons == null || fuelGallons <= 0) return null
  return miles / fuelGallons
}

/**
 * Miles for the day, or null when there is nothing to measure against. A reading
 * that went backwards is a bad reading, not negative miles - an ECM swap or a
 * unit reassignment produces one, and a negative day would silently cancel out
 * real miles in the week total.
 */
export function dayMiles(previous: number | null, end: number): number | null {
  if (previous == null) return null
  return Math.max(0, end - previous)
}

/**
 * Gallons the truck actually burned: driving fuel plus the fuel it idled away.
 * Motive reports them separately and the day's driving number alone runs a few
 * percent optimistic against the pump, which is the figure a driver checks this
 * against. Units are US gallons - every row carries "metric_units": false,
 * because the request sends X-Metric-Units: false.
 */
export function dayFuelGallons(drivingFuel: number | null, idleFuel: number | null): number | null {
  if (drivingFuel == null && idleFuel == null) return null
  return (drivingFuel ?? 0) + (idleFuel ?? 0)
}


async function closeDay(eventTimeIso: string): Promise<void> {
  // Closes the previous Chicago calendar day — see the header comment.
  const targetDate = previousDate(centralDate(eventTimeIso))
  const weekStart  = weekStartFor(targetDate)
  const vehicles   = await fetchVehicleOdometers(MOTIVE_API_KEY)
  if (vehicles.length === 0) {
    console.log('[odometer] no Motive vehicles — nothing to close')
    return
  }
  const fuel = await fetchVehicleUtilization(MOTIVE_API_KEY, targetDate, targetDate)
  const targets = targetsFor(vehicles, await fetchEquipmentByMotiveNumber())
  const odometerByKey = byKey(vehicles)
  const fuelByKey     = byKey(fuel)

  let closed = 0
  for (const t of targets) {
    const o = odometerByKey.byId.get(t.motiveVehicleId) ?? odometerByKey.byNumber.get(t.motiveNumber)
    if (!o || o.odometer == null) {
      console.warn(`[odometer] close: no end odometer for unit=${t.unitNumber} ${targetDate}`)
      continue
    }
    const endOdometer = o.odometer
    // Previous reading is the prior day's end. When that row is absent (first
    // week of a fresh deploy, or a missed run) fall back to this day's opening
    // read so the week's first day still measures from the right point.
    const prevRow    = await getOdometerRow(t.truckId, previousDate(targetDate))
    const currentRow = await getOdometerRow(t.truckId, targetDate)
    const previous   = prevRow?.endOdometer ?? currentRow?.startOdometer ?? null
    const miles = dayMiles(previous, endOdometer)

    const f = fuelByKey.byId.get(t.motiveVehicleId) ?? fuelByKey.byNumber.get(t.motiveNumber)
    const fuelGallons = dayFuelGallons(f?.drivingFuel ?? null, f?.idleFuel ?? null)
    const mpg = dayMpg(miles, fuelGallons)

    await putOdometerRow({
      truckId:       t.truckId,
      unitNumber:    t.unitNumber,
      date:          targetDate,
      weekStart,
      startOdometer: previous,
      endOdometer,
      miles,
      fuelGallons,
      mpg,
    })
    closed++
  }
  console.log(`[odometer] closeDay ${targetDate}: ${closed}/${targets.length} truck(s) closed`)
}

// ── Handler ────────────────────────────────────────────────────────────────────

export const handler = async (event: Record<string, unknown> = {}): Promise<void> => {
  console.log('[motive-odometer-sync] start', JSON.stringify(event))
  if (!MOTIVE_API_KEY) throw new Error('MOTIVE_API_KEY secret not set')

  const mode      = typeof event.mode === 'string' ? event.mode : 'closeDay'
  const eventTime = typeof event.time === 'string' ? event.time : new Date().toISOString()

  if (mode === 'openWeek') {
    await openWeek(eventTime)
  } else if (mode === 'closeDay') {
    await closeDay(eventTime)
  } else {
    throw new Error(`unknown mode: ${mode}`)
  }
}
