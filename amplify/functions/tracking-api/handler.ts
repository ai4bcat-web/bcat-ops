/**
 * tracking-api — the page behind a truck's permanent tracking link.
 *
 * GET /t/<code> → where the truck is right now (last Motive fix), who is driving it, and
 * the load under way with its ETA. The code lives on the Equipment record
 * (trackingCode); regenerating it kills every copy of the old link. No phone numbers, no
 * rates, nothing about other trucks.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb'
import { currentLoadForDriver, laneLabel } from '../../../src/lib/driverJourney'
import { pendingDeliveryEta } from '../../../src/lib/stopEvents'
import type { Load } from '../../../src/types'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const EQUIPMENT_TABLE = process.env.EQUIPMENT_TABLE_NAME!
const TRUCK_LOCATION_TABLE = process.env.TRUCK_LOCATION_TABLE_NAME!
const DRIVER_TABLE = process.env.DRIVER_TABLE_NAME!
const LOAD_TABLE = process.env.LOAD_TABLE_NAME!

interface FnUrlEvent { rawPath?: string; requestContext?: { http?: { method?: string } } }

function reply(status: number, body: unknown) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) }
}

export interface TrackingView {
  unit: string
  driver: string | null
  position: { lat: number; lon: number; description: string | null; locatedAt: string } | null
  load: { pro: string | null; lane: string; eta: { at: string; basis: 'motive' | 'appt' } | null } | null
  generatedAt: string
}

async function truckByCode(code: string): Promise<Record<string, unknown> | null> {
  let token: Record<string, unknown> | undefined
  do {
    const r = await ddb.send(new ScanCommand({
      TableName: EQUIPMENT_TABLE,
      FilterExpression: 'trackingCode = :c AND #t = :truck',
      ExpressionAttributeNames: { '#t': 'type' },
      ExpressionAttributeValues: { ':c': code, ':truck': 'truck' },
      ProjectionExpression: 'id, unitNumber, assignedDriverId, active',
      ExclusiveStartKey: token as Record<string, never> | undefined,
    }))
    const hit = (r.Items ?? [])[0]
    if (hit) return hit
    token = r.LastEvaluatedKey
  } while (token)
  return null
}

async function driverFor(truck: Record<string, unknown>): Promise<{ id: string; name: string } | null> {
  const direct = typeof truck.assignedDriverId === 'string' ? truck.assignedDriverId : ''
  if (direct) {
    const r = await ddb.send(new GetCommand({ TableName: DRIVER_TABLE, Key: { id: direct }, ProjectionExpression: 'id, #n', ExpressionAttributeNames: { '#n': 'name' } }))
    if (r.Item?.name) return { id: direct, name: String(r.Item.name) }
  }
  // The driver side of the assignment, when the equipment side is behind.
  const r = await ddb.send(new ScanCommand({
    TableName: DRIVER_TABLE,
    FilterExpression: 'assignedTruckId = :t',
    ExpressionAttributeValues: { ':t': truck.id },
    ProjectionExpression: 'id, #n',
    ExpressionAttributeNames: { '#n': 'name' },
  }))
  const d = (r.Items ?? [])[0]
  return d?.name ? { id: String(d.id), name: String(d.name) } : null
}

async function loadsFor(driverId: string, since: string): Promise<Load[]> {
  const out: Load[] = []
  let token: Record<string, unknown> | undefined
  do {
    const r = await ddb.send(new ScanCommand({
      TableName: LOAD_TABLE,
      FilterExpression: '(deliveryDriverId = :d OR pickupDriverId = :d) AND deliveryAppt >= :since',
      ExpressionAttributeValues: { ':d': driverId, ':since': since },
      ProjectionExpression: 'id, aljexId, pickupDriverId, deliveryDriverId, pickupAppt, deliveryAppt, originCity, destinationCity, stops, truckId',
      ExclusiveStartKey: token as Record<string, never> | undefined,
    }))
    out.push(...((r.Items ?? []) as Load[]))
    token = r.LastEvaluatedKey
  } while (token)
  return out
}

export const handler = async (event: FnUrlEvent) => {
  const method = event.requestContext?.http?.method ?? 'GET'
  if (method === 'OPTIONS') return reply(200, { ok: true })
  if (method !== 'GET') return reply(405, { error: 'GET only' })
  const m = /^\/t\/([A-Za-z0-9]{6,32})\/?$/.exec(event.rawPath ?? '')
  if (!m) return reply(404, { error: 'Not found' })

  const truck = await truckByCode(m[1])
  if (!truck || truck.active === false) return reply(404, { error: 'This tracking link is no longer active' })
  const truckId = String(truck.id)
  const now = Date.now()

  const [loc, driver] = await Promise.all([
    ddb.send(new GetCommand({ TableName: TRUCK_LOCATION_TABLE, Key: { truckId }, ProjectionExpression: 'lat, lon, description, locatedAt' })).then((r) => r.Item ?? null),
    driverFor(truck),
  ])

  let load: TrackingView['load'] = null
  if (driver) {
    const since = new Date(now - 3 * 86_400_000).toISOString().slice(0, 10)
    const current = currentLoadForDriver(await loadsFor(driver.id, since), driver.id, now)
    if (current) {
      const eta = pendingDeliveryEta(current)
      load = { pro: (current.aljexId ?? '').trim() || null, lane: laneLabel(current), eta: eta ? { at: eta.etaAt, basis: eta.basis } : null }
    }
  }

  const view: TrackingView = {
    unit: String(truck.unitNumber ?? ''),
    driver: driver?.name ?? null,
    position: loc && typeof loc.lat === 'number' && typeof loc.lon === 'number'
      ? { lat: loc.lat, lon: loc.lon, description: typeof loc.description === 'string' ? loc.description : null, locatedAt: String(loc.locatedAt) }
      : null,
    load,
    generatedAt: new Date(now).toISOString(),
  }
  return reply(200, view)
}
