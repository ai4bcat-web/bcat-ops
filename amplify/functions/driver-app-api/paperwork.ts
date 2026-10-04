/**
 * Ivan paperwork: a driver's week of deliveries, with no money on it.
 *
 * The owner operators' page is a settlement — it exists to explain a check. Ivan's own
 * drivers are employees dispatched off the calendar; their page exists so they can see
 * what they are hauling this week and send the paperwork for it. That difference is the
 * whole design:
 *
 *   - No rate, and no field from which a rate can be reconstructed. Not hidden in the UI
 *     but absent from the payload, because a driver with the browser's network tab open is
 *     still not supposed to see what the load pays.
 *   - No deductions, no gross, no check. There is no settlement to show.
 *   - Every other detail of the load, which is what makes the page worth opening: who it
 *     is for, where it goes, when it is due, what is still missing.
 *
 * Pure: loads and rows in, rows out. The handler does the I/O.
 */
import { getStops } from '../../../src/lib/stops'
import { driverIsOnLoad } from '../../../src/lib/driverJourney'
import type { Load, Stop } from '../../../src/types'

/** Enough of a load to describe it to the driver hauling it. */
export interface PaperworkLoadLike {
  id: string
  aljexId?: string | null
  tmsId?: string | null
  customer?: string | null
  miles?: number | null
  pickupAppt?: string | null
  deliveryAppt?: string | null
  pickupDriverId?: string | null
  deliveryDriverId?: string | null
  originCity?: string | null
  originState?: string | null
  destinationCity?: string | null
  destinationState?: string | null
  originName?: string | null
  destinationName?: string | null
  trailerNumber?: string | null
  commodity?: string | null
  weight?: number | null
  pieces?: number | null
  notes?: string | null
  stops?: unknown
  status?: string | null
}

export interface PaperworkStop {
  type: string
  name: string | null
  city: string | null
  state: string | null
  appt: string | null
}

export type PodLegibility = 'OK' | 'LOW' | 'UNREADABLE' | 'UNKNOWN'

export interface PaperworkPod {
  present: boolean
  pages: number
  /** Worst legibility across the pages — one bad page makes the POD bad. */
  legibility: PodLegibility
  notes: string | null
}

export interface PaperworkTimes {
  timeIn: string | null
  timeOut: string | null
  notes: string | null
  /** Hours between in and out, or null when either is missing. */
  hours: number | null
  /** True once the gap is worth billing. The app asks for times past this. */
  billable: boolean
}

export interface PaperworkLoad {
  id: string
  /** What the driver and the office both call it — the PRO. */
  reference: string
  customer: string | null
  deliveryAppt: string | null
  pickupAppt: string | null
  origin: string | null
  destination: string | null
  miles: number | null
  trailerNumber: string | null
  commodity: string | null
  weight: number | null
  pieces: number | null
  notes: string | null
  status: string | null
  stops: PaperworkStop[]
  pod: PaperworkPod
  pickupTimes: PaperworkTimes
  deliveryTimes: PaperworkTimes
}

export interface PaperworkWeek {
  weekStart: string
  loadCount: number
  podsMissing: number
  podsIllegible: number
}

/** Detention starts after two free hours, which is what the app prompts on. */
export const DETENTION_FREE_HOURS = 2

/** A row as stored by DriverLoadTime. */
export interface LoadTimeRow {
  loadId: string
  driverId: string
  leg: string
  timeIn?: string | null
  timeOut?: string | null
  notes?: string | null
}

/** A POD page as stored by DriverSubmissionDoc, plus its submission's load linkage. */
export interface PodDocRow {
  loadId?: string | null
  referenceNumber?: string | null
  kind?: string | null
  legibility?: string | null
  legibilityNotes?: string | null
}

/*
 * Whose load this is comes from driverJourney — the one definition the dispatch board, the
 * driver's current-load card and this page all read, so they cannot disagree about it.
 */
export function driverIsOnPaperworkLoad(load: PaperworkLoadLike, driverId: string): boolean {
  return driverIsOnLoad(load as unknown as Load, driverId)
}

/** PRO first, then the TMS id — the same precedence the rest of the app uses. */
export function referenceOf(load: PaperworkLoadLike): string {
  return (load.aljexId ?? '').trim() || (load.tmsId ?? '').trim() || load.id
}

function place(city?: string | null, state?: string | null, name?: string | null): string | null {
  const where = [city?.trim(), state?.trim()].filter(Boolean).join(', ')
  const who = name?.trim()
  if (who && where) return `${who} (${where})`
  return who || where || null
}

/**
 * Worst legibility wins.
 *
 * A POD is one document even when it arrives as four photos, and it is only as usable as
 * its least readable page — a signature page nobody can read is not rescued by three
 * clean ones behind it.
 */
export function worstLegibility(values: Array<string | null | undefined>): PodLegibility {
  const order: PodLegibility[] = ['UNREADABLE', 'LOW', 'UNKNOWN', 'OK']
  for (const level of order) {
    if (values.some((v) => v === level)) return level
  }
  return 'UNKNOWN'
}

export function describeTimes(row: LoadTimeRow | undefined): PaperworkTimes {
  const timeIn = row?.timeIn?.trim() || null
  const timeOut = row?.timeOut?.trim() || null
  let hours: number | null = null
  if (timeIn && timeOut) {
    const a = Date.parse(`${timeIn}:00Z`)
    const b = Date.parse(`${timeOut}:00Z`)
    // Out before in means the driver crossed midnight; a negative gap is never the answer.
    if (Number.isFinite(a) && Number.isFinite(b)) {
      const raw = (b - a) / 3_600_000
      hours = Math.round((raw < 0 ? raw + 24 : raw) * 100) / 100
    }
  }
  return {
    timeIn,
    timeOut,
    notes: row?.notes?.trim() || null,
    hours,
    billable: hours !== null && hours > DETENTION_FREE_HOURS,
  }
}

export function buildPaperworkLoad(
  load: PaperworkLoadLike,
  podDocs: PodDocRow[],
  times: LoadTimeRow[],
): PaperworkLoad {
  const stops = (getStops(load as unknown as Load) as Stop[]).map((s) => ({
    type: String(s.type ?? ''),
    name: s.name?.trim() || null,
    // `city` on a stop is a display string ("Chicago, IL"); the address holds the parts.
    city: s.address?.city?.trim() || s.city?.trim() || null,
    state: s.address?.state?.trim() || null,
    appt: s.appt ?? null,
  }))

  const pages = podDocs.filter((d) => (d.kind ?? '').toUpperCase() === 'POD')
  const legibility = worstLegibility(pages.map((d) => d.legibility))
  const notes = pages.map((d) => d.legibilityNotes?.trim()).find(Boolean) ?? null

  const byLeg = (leg: string) => times.find((t) => t.leg === leg)

  return {
    id: load.id,
    reference: referenceOf(load),
    customer: load.customer?.trim() || null,
    deliveryAppt: load.deliveryAppt ?? null,
    pickupAppt: load.pickupAppt ?? null,
    origin: place(load.originCity, load.originState, load.originName),
    destination: place(load.destinationCity, load.destinationState, load.destinationName),
    miles: typeof load.miles === 'number' ? load.miles : null,
    trailerNumber: load.trailerNumber?.trim() || null,
    commodity: load.commodity?.trim() || null,
    weight: typeof load.weight === 'number' ? load.weight : null,
    pieces: typeof load.pieces === 'number' ? load.pieces : null,
    notes: load.notes?.trim() || null,
    status: load.status?.trim() || null,
    stops,
    pod: {
      present: pages.length > 0,
      pages: pages.length,
      legibility: pages.length ? legibility : 'UNKNOWN',
      notes: pages.length ? notes : null,
    },
    pickupTimes: describeTimes(byLeg('PICKUP')),
    deliveryTimes: describeTimes(byLeg('DELIVERY')),
  }
}

/** The week's headline counts, which are what the driver and the office both scan for. */
export function summarize(loads: PaperworkLoad[]): Omit<PaperworkWeek, 'weekStart'> {
  return {
    loadCount: loads.length,
    podsMissing: loads.filter((l) => !l.pod.present).length,
    podsIllegible: loads.filter(
      (l) => l.pod.present && (l.pod.legibility === 'LOW' || l.pod.legibility === 'UNREADABLE'),
    ).length,
  }
}
