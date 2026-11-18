/**
 * Where Ivan's own trucks go empty, from the schedule alone (Ryne 2026-11-18).
 *
 * The rule is the SCHEDULED one: a driver is empty after the last stop of the load they are
 * on, in that stop's city, at that stop's time (the time it actually left when it has, else
 * its appointment). There is no live ETA in here: a stop the driver has not marked departed
 * past its appointment shows as `late`, and it is still "empty at the appointment".
 *
 * Own fleet means Ivan's drivers: not owner operators, not box trucks, not the brokered
 * pseudo-drivers. A driver's own stops decide, not the load's (a load can be split between
 * two drivers), and a driver on two overlapping loads is busy until the later one ends.
 *
 * Each gap between one block of work and the next is one row. A gap of a few hours or less is
 * a `BACK_TO_BACK` row (the next load is already booked, nothing is idle); anything longer is
 * `IDLE`, with the idle days up to the next booked pickup, or up to the end of the window when
 * nothing is booked (`openEnded`). Open loads that could fill an idle gap come from loads
 * with nobody on them, ranked by how far the truck would have to run empty to the pickup.
 *
 * Pure: the page supplies drivers, loads, equipment and the clock.
 */
import type { Driver, Load, Stop } from '@/types'
import type { Equipment } from '@/types/equipment'
import { getStops } from '@/lib/stops'
import { driverGroupOf } from '@/lib/driverFilter'
import { driverOwnershipKind } from '@/lib/driverOwnership'
import { isLoadVoided } from '@/lib/shipmentVoid'
import { stopPlace } from '@/lib/stopPlace'
import { isUntimedAppt } from '@/lib/apptOrder'
import { chicagoDateStr } from '@/lib/date'
import { CITY_COORDS } from '@/lib/cityCoords'
import { STATE_CENTROIDS } from '@/lib/integrations/rateView'
import { milesBetween, lanePlace } from '@/lib/laneMatch'
import { laneLabel } from '@/lib/driverJourney'
import { trailerOnDriver } from './driverWhereabouts'

/** Windows the page offers, in days. */
export const EMPTY_HORIZONS = [2, 7, 14] as const
export type EmptyHorizon = (typeof EMPTY_HORIZONS)[number]

/** A next load that starts this soon after the last one ends leaves nothing idle. */
export const BACK_TO_BACK_HOURS = 4
/** How far after a truck is empty an open pickup is still worth offering. */
export const OPEN_LOAD_WINDOW_DAYS = 3
/** A truck that was emptied longer ago than this is not "just delivered", it is off the schedule. */
export const RECENT_EMPTY_DAYS = 3
/** Great-circle miles are short of the road; the same 15% the rate estimate adds. */
export const ROAD_FACTOR = 1.15
/** An empty run longer than this (road miles) is flagged. */
export const LONG_DEADHEAD_MILES = 150
/** An empty run up to this (road miles) is a short one: the map draws it green. */
export const SHORT_DEADHEAD_MILES = 75
/** Offered per truck. */
export const MAX_MATCHES = 3

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** Divisions an own truck can take an open load from. Brokerage and car shipping are not theirs. */
const OWN_FLEET_DIVISIONS = new Set(['ASSETS', 'LOCAL', ''])

export interface EmptyPoint {
  /** "Kenosha, WI", or null when the stop has no city. */
  place: string | null
  lat: number | null
  lng: number | null
  /** The position is the middle of the state, not the city. */
  approx: boolean
}

export interface OpenLoadMatch {
  loadId: string
  /** The shipment the load belongs to, for the link; null on a load that predates the shipment layer. */
  shipmentId: string | null
  pro: string
  lane: string
  pickupPlace: string | null
  /** Where the pickup is on the map; lat and lng are null when the stop cannot be placed. */
  pickupPoint: EmptyPoint
  pickupAt: number
  pickupTimeKnown: boolean
  customer: string | null
  /** Cents; null when the viewer may not see money. */
  rateCents: number | null
  /** Road miles from where the truck is empty to the pickup; null when either end cannot be placed. */
  deadheadMiles: number | null
  approx: boolean
  longDeadhead: boolean
}

export interface NextLoad {
  loadId: string
  shipmentId: string | null
  pro: string
  lane: string
  place: string | null
  startAt: number
  timeKnown: boolean
}

export interface EmptyTruckRow {
  key: string
  driverId: string
  driverName: string
  truck: string | null
  trailer: string | null
  /** The load that ends the block of work. */
  endLoad: { id: string; shipmentId: string | null; pro: string; lane: string }
  emptyAt: number
  /** The end stop has a real time, not only a day. */
  timeKnown: boolean
  /** `emptyAt` is already past (delivered, or the stop is past its appointment). */
  alreadyEmpty: boolean
  /** Past the appointment and the driver has not marked the stop departed. */
  late: boolean
  point: EmptyPoint
  /** Where the block of work started: its first stop. The map draws the run from here to `point`. */
  from: EmptyPoint
  kind: 'IDLE' | 'BACK_TO_BACK'
  next: NextLoad | null
  /** Days from empty to the next booked pickup; with nothing booked, to the end of the window. */
  idleDays: number
  openEnded: boolean
  /** Idle days times the daily value, cents; null for back-to-back rows, with no daily value set, or without money access. */
  idleValueCents: number | null
  matches: OpenLoadMatch[]
}

export interface EmptyTrucksSummary {
  trucks: number
  /** Idle rows whose truck is already empty (delivered, or past its appointment). */
  emptyNow: number
  idleTruckDays: number
  /** Distinct open loads offered to at least one idle truck. */
  openLoadsCovering: number
  /** Null until a daily value is set (and for viewers without money access). */
  valueCents: number | null
}

/** An open load an own truck could take, for the map's faint pickup markers. */
export interface EmptyOpenLoad {
  loadId: string
  pro: string
  lane: string
  point: EmptyPoint
  pickupAt: number
  pickupTimeKnown: boolean
}

export interface EmptyTrucksResult {
  rows: EmptyTruckRow[]
  summary: EmptyTrucksSummary
  horizonEnd: number
  /** Open loads picking up from now to a few days past the window, whether or not a truck was matched to them. */
  openLoads: EmptyOpenLoad[]
}

export interface EmptyTrucksInput {
  drivers: readonly Driver[]
  loads: readonly Load[]
  equipment: readonly Equipment[]
  now: number
  horizonDays: number
  /** Cents per idle truck-day; null/undefined = not set. */
  dailyValueCents?: number | null
  /** Customer rates and the dollar value only go to people who may see money. */
  canSeeMoney: boolean
}

/** Own fleet: Ivan's drivers on the active roster. Owner operators, box trucks and the brokered placeholders are not. */
export function isOwnFleetDriver(driver: Pick<Driver, 'active' | 'type' | 'fleetGroup' | 'driverType'>): boolean {
  if (driver.active === false) return false
  if (driver.type === 'broker') return false
  if (driverGroupOf(driver) !== 'IVAN') return false
  return driverOwnershipKind(driver) !== 'BOX_TRUCK'
}

/** The Chicago day at 5 PM, as a point in time: where a stop with a day and no time is counted. */
function endOfWorkDay(iso: string): number {
  const day = chicagoDateStr(iso)
  // 23:00 UTC is 5 PM in winter and 6 PM in summer in Chicago: close enough for "that evening".
  return Date.parse(`${day}T23:00:00Z`)
}

/** The Chicago day at 8 AM: where a pickup with a day and no time is counted. */
function startOfWorkDay(iso: string): number {
  const day = chicagoDateStr(iso)
  return Date.parse(`${day}T14:00:00Z`)
}

const parse = (iso: string | null | undefined): number | null => {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : t
}

/** When the stop is expected to be finished: the time it left, else its appointment (a day-only stop counts as that evening). */
function stopEnd(stop: Stop): { at: number; known: boolean; departed: boolean } | null {
  const left = parse(stop.departedAt)
  if (left != null) return { at: left, known: true, departed: true }
  const appt = parse(stop.appt)
  if (appt == null) return null
  if (isUntimedAppt(stop)) return { at: endOfWorkDay(stop.appt), known: false, departed: false }
  // A stop with a window ends when the window does.
  const windowEnd = parse(stop.apptEnd)
  return { at: windowEnd != null && windowEnd > appt ? windowEnd : appt, known: true, departed: false }
}

/** When the driver starts at the stop: the time they got there, else its appointment. */
function stopStart(stop: Stop): { at: number; known: boolean } | null {
  const arrived = parse(stop.arrivedAt)
  if (arrived != null) return { at: arrived, known: true }
  const appt = parse(stop.appt)
  if (appt == null) return null
  if (isUntimedAppt(stop)) return { at: startOfWorkDay(stop.appt), known: false }
  return { at: appt, known: true }
}

const proOf = (load: Load): string => load.aljexId?.trim() || load.loadNumber?.trim() || load.id.slice(0, 8)

function pointOfStop(stop: Stop | undefined): EmptyPoint {
  if (!stop) return { place: null, lat: null, lng: null, approx: false }
  const sp = stopPlace(stop)
  const city = sp.city?.trim() || null
  const state = sp.state?.trim().toUpperCase() || null
  const place = city && state ? `${city}, ${state}` : city ?? state
  const lat = stop.address?.lat
  const lng = stop.address?.lng
  if (typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng)) {
    return { place, lat, lng, approx: false }
  }
  if (city && state) {
    const hit = CITY_COORDS[`${city.toUpperCase().replace(/\s+/g, ' ')}, ${state}`]
    if (hit) return { place, lat: hit[0], lng: hit[1], approx: false }
  }
  if (state && STATE_CENTROIDS[state]) {
    const [clat, clng] = STATE_CENTROIDS[state]
    return { place, lat: clat, lng: clng, approx: true }
  }
  return { place, lat: null, lng: null, approx: false }
}

/** Road miles between two points: great-circle times the road factor; null when either has no position. */
export function roadMiles(a: Pick<EmptyPoint, 'lat' | 'lng'>, b: Pick<EmptyPoint, 'lat' | 'lng'>): number | null {
  const miles = milesBetween(lanePlace({ lat: a.lat, lon: a.lng }), lanePlace({ lat: b.lat, lon: b.lng }))
  return miles == null ? null : Math.round(miles * ROAD_FACTOR)
}

interface Block {
  start: number
  startKnown: boolean
  startLoad: Load
  startStop: Stop
  end: number
  endKnown: boolean
  endLoad: Load
  endStop: Stop
  departed: boolean
}

/** One driver's work as time-ordered blocks: overlapping loads are one block that ends with the later one. */
function blocksFor(driverId: string, loads: readonly Load[]): Block[] {
  const raw: Block[] = []
  for (const load of loads) {
    if (isLoadVoided(load) || load.status === 'CANCELED' || load.unscheduled) continue
    const stops = getStops(load)
    const mine = stops.filter((s) => s.driverId === driverId)
    if (!mine.length) continue
    const first = mine[0]
    const last = mine[mine.length - 1]
    const s = stopStart(first)
    // A load with no first time at all cannot be placed on the clock: leave it out.
    if (!s) continue
    // Time of the first stop's work, or the end of its own last stop when that is the only time on the load.
    const e = stopEnd(last)
    if (!e) continue
    raw.push({ start: s.at, startKnown: s.known, startLoad: load, startStop: first, end: Math.max(e.at, s.at), endKnown: e.known, endLoad: load, endStop: last, departed: e.departed })
  }
  raw.sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: Block[] = []
  for (const b of raw) {
    const prev = merged[merged.length - 1]
    if (prev && b.start < prev.end) {
      if (b.end > prev.end) {
        prev.end = b.end
        prev.endKnown = b.endKnown
        prev.endLoad = b.endLoad
        prev.endStop = b.endStop
        prev.departed = b.departed
      }
    } else merged.push({ ...b })
  }
  return merged
}

interface OpenLoad {
  load: Load
  pickup: Stop
  at: number
  known: boolean
  point: EmptyPoint
}

/** Loads nobody is on, in a division an own truck can take, with a pickup still ahead. */
function openLoadsOf(loads: readonly Load[], now: number): OpenLoad[] {
  const out: OpenLoad[] = []
  for (const load of loads) {
    if (isLoadVoided(load) || load.unscheduled) continue
    const status = load.status
    if (status && status !== 'SOURCING' && status !== 'BOOKED' && status !== 'PLANNED') continue
    if (load.assignmentType === 'CARRIER' || load.carrierName?.trim() || load.activeLoadCarrierId) continue
    if (!OWN_FLEET_DIVISIONS.has((load.revDivision ?? '').trim().toUpperCase())) continue
    if (load.pickupDriverId || load.deliveryDriverId) continue
    const stops = getStops(load)
    if (stops.some((s) => s.driverId)) continue
    const pickup = stops.find((s) => s.type === 'pickup') ?? stops[0]
    if (!pickup) continue
    const start = stopStart(pickup)
    if (!start || start.at < now - 6 * HOUR) continue
    out.push({ load, pickup, at: start.at, known: start.known, point: pointOfStop(pickup) })
  }
  return out
}

function matchesFor(point: EmptyPoint, from: number, until: number, open: readonly OpenLoad[], canSeeMoney: boolean): OpenLoadMatch[] {
  const cands = open.filter((o) => o.at >= from - HOUR && o.at <= until)
  const out: OpenLoadMatch[] = cands.map((o) => {
    const miles = roadMiles(point, o.point)
    const approx = point.approx || o.point.approx
    return {
      loadId: o.load.id,
      shipmentId: o.load.shipmentId ?? null,
      pro: proOf(o.load),
      lane: laneLabel(o.load),
      pickupPlace: o.point.place,
      pickupPoint: o.point,
      pickupAt: o.at,
      pickupTimeKnown: o.known,
      customer: o.load.customer?.trim() || null,
      rateCents: canSeeMoney && typeof o.load.rate === 'number' ? o.load.rate : null,
      deadheadMiles: miles,
      approx,
      longDeadhead: miles != null && miles > LONG_DEADHEAD_MILES,
    }
  })
  // Closest pickup first; a pickup that cannot be placed after every one that can.
  out.sort((a, b) => (a.deadheadMiles ?? Infinity) - (b.deadheadMiles ?? Infinity) || a.pickupAt - b.pickupAt)
  return out.slice(0, MAX_MATCHES)
}

export function computeEmptyTrucks(input: EmptyTrucksInput): EmptyTrucksResult {
  const { drivers, loads, equipment, now, horizonDays, canSeeMoney } = input
  const dailyValue = canSeeMoney && typeof input.dailyValueCents === 'number' && input.dailyValueCents > 0 ? input.dailyValueCents : null
  const horizonEnd = now + horizonDays * DAY
  const open = openLoadsOf(loads, now)
  const rows: EmptyTruckRow[] = []

  for (const driver of drivers) {
    if (!isOwnFleetDriver(driver)) continue
    const blocks = blocksFor(driver.id, loads)
    if (!blocks.length) continue
    const truckEq = driver.assignedTruckId ? equipment.find((e) => e.id === driver.assignedTruckId) : undefined
    const truck = truckEq ? String(truckEq.unitNumber) : null
    const trailer = trailerOnDriver(driver, loads, equipment)

    blocks.forEach((block, i) => {
      const next = blocks[i + 1] ?? null
      const emptyAt = block.end
      // Out of the window: too far ahead, or long gone.
      if (emptyAt > horizonEnd) return
      if (emptyAt < now - RECENT_EMPTY_DAYS * DAY) return
      // The gap already closed: the next load has started.
      if (next && next.start <= now) return
      const gapMs = next ? next.start - emptyAt : null
      const backToBack = gapMs != null && gapMs <= BACK_TO_BACK_HOURS * HOUR
      const idleMs = next ? Math.max(0, next.start - emptyAt) : Math.max(0, horizonEnd - emptyAt)
      const idleDays = Math.round((idleMs / DAY) * 10) / 10
      const point = pointOfStop(block.endStop)
      const kind: EmptyTruckRow['kind'] = backToBack ? 'BACK_TO_BACK' : 'IDLE'
      const until = next ? next.start : emptyAt + OPEN_LOAD_WINDOW_DAYS * DAY
      rows.push({
        key: `${driver.id}:${block.endLoad.id}`,
        driverId: driver.id,
        driverName: driver.name,
        truck,
        trailer,
        endLoad: { id: block.endLoad.id, shipmentId: block.endLoad.shipmentId ?? null, pro: proOf(block.endLoad), lane: laneLabel(block.endLoad) },
        emptyAt,
        timeKnown: block.endKnown,
        alreadyEmpty: emptyAt <= now,
        late: !block.departed && emptyAt < now,
        point,
        from: pointOfStop(block.startStop),
        kind,
        next: next ? {
          loadId: next.startLoad.id,
          shipmentId: next.startLoad.shipmentId ?? null,
          pro: proOf(next.startLoad),
          lane: laneLabel(next.startLoad),
          place: pointOfStop(next.startStop).place,
          startAt: next.start,
          timeKnown: next.startKnown,
        } : null,
        idleDays,
        openEnded: !next,
        idleValueCents: dailyValue != null && kind === 'IDLE' ? Math.round(idleDays * dailyValue) : null,
        matches: kind === 'IDLE' ? matchesFor(point, emptyAt, until, open, canSeeMoney) : [],
      })
    })
  }

  rows.sort((a, b) => a.emptyAt - b.emptyAt || (b.idleValueCents ?? 0) - (a.idleValueCents ?? 0) || a.driverName.localeCompare(b.driverName))

  const idle = rows.filter((r) => r.kind === 'IDLE')
  const summary: EmptyTrucksSummary = {
    trucks: new Set(idle.map((r) => r.driverId)).size,
    emptyNow: new Set(idle.filter((r) => r.alreadyEmpty).map((r) => r.driverId)).size,
    openLoadsCovering: new Set(idle.flatMap((r) => r.matches.map((m) => m.loadId))).size,
    idleTruckDays: Math.round(idle.reduce((n, r) => n + r.idleDays, 0) * 10) / 10,
    valueCents: dailyValue != null ? idle.reduce((n, r) => n + (r.idleValueCents ?? 0), 0) : null,
  }
  const openLoads: EmptyOpenLoad[] = open
    .filter((o) => o.at <= horizonEnd + OPEN_LOAD_WINDOW_DAYS * DAY)
    .map((o) => ({ loadId: o.load.id, pro: proOf(o.load), lane: laneLabel(o.load), point: o.point, pickupAt: o.at, pickupTimeKnown: o.known }))
    .sort((a, b) => a.pickupAt - b.pickupAt)
  return { rows, summary, horizonEnd, openLoads }
}

export type EmptyTone = 'now' | 'soon' | 'later'

/** How urgent a row is: red for a truck already empty, amber within a day, blue after. */
export function toneOf(row: Pick<EmptyTruckRow, 'alreadyEmpty' | 'emptyAt'>, now: number): EmptyTone {
  if (row.alreadyEmpty) return 'now'
  return row.emptyAt - now <= DAY ? 'soon' : 'later'
}

export type EmptyUrgency = 'now' | 'soon' | 'week' | 'beyond'

/** The map's pin colour: red for a truck already empty, amber within a day, blue within the week, gray after. */
export function urgencyOf(row: Pick<EmptyTruckRow, 'alreadyEmpty' | 'emptyAt'>, now: number): EmptyUrgency {
  if (row.alreadyEmpty) return 'now'
  const away = row.emptyAt - now
  if (away <= DAY) return 'soon'
  return away <= 7 * DAY ? 'week' : 'beyond'
}

export type DeadheadTier = 'short' | 'medium' | 'long' | 'unknown'

/** The map's colour for the empty run to an open load: green up to 75 road miles, amber to 150, red beyond. */
export function deadheadTier(miles: number | null | undefined): DeadheadTier {
  if (miles == null) return 'unknown'
  if (miles <= SHORT_DEADHEAD_MILES) return 'short'
  return miles <= LONG_DEADHEAD_MILES ? 'medium' : 'long'
}
