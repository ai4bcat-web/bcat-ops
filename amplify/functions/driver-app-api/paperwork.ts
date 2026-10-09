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
import {
  assessEld, SHORT_HAUL_AIR_MILES, WORK_REPORTING_LOCATION, type EldStatus,
} from '../../../src/lib/eldRadius'
import { isOvernightLoad } from '../../../src/lib/overnightLoads'
import { chicagoDateStr } from '../../../src/lib/date'

/** Enough of a load to describe it to the driver hauling it. */
/*
 * The ELD question is answered from the stop CITIES, never from load.miles.
 *
 * miles is a routed road distance; the rule is air miles. A 160-road-mile run can sit well
 * inside a 150-air-mile circle, and reading the road figure would demand logs for days that
 * are exempt. See src/lib/eldRadius.ts.
 */
function assessLoadEld(stops: PaperworkStop[], load: PaperworkLoadLike): PaperworkEld {
  const cities = [
    ...stops.map((s) => (s.city && s.state ? `${s.city}, ${s.state}` : s.city)),
    place(load.originCity, load.originState, null),
    place(load.destinationCity, load.destinationState, null),
  ]
  const a = assessEld(cities)
  const label =
    a.status === 'REQUIRED'
      ? `ELD logs required — ${a.farthestCity} is ${a.farthestMiles} air miles from ${WORK_REPORTING_LOCATION.name}`
      : a.status === 'UNKNOWN'
        ? `Check whether ELD logs are required — ${a.unplaceable.length ? `could not locate ${a.unplaceable.join(', ')}` : 'no stop location on file'}`
        : `No ELD logs required — stays within ${SHORT_HAUL_AIR_MILES} air miles of ${WORK_REPORTING_LOCATION.name}`
  return {
    status: a.status,
    required: a.status === 'REQUIRED',
    farthestMiles: a.farthestMiles,
    farthestCity: a.farthestCity,
    label,
  }
}

export interface PaperworkLoadLike {
  id: string
  aljexId?: string | null
  tmsId?: string | null
  pickupNumber?: string | null
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
  /** CENTS, as stored on the Load. */
  rate?: number | null
  commodity?: string | null
  weight?: number | null
  pieces?: number | null
  notes?: string | null
  stops?: unknown
  status?: string | null
}

export interface PaperworkStop {
  /** The stop's own id — what a detention flag is keyed on. */
  id: string
  type: string
  sequence: number
  name: string | null
  /** Street line, when the stop or its directory location carries one. */
  street: string | null
  city: string | null
  state: string | null
  zip: string | null
  appt: string | null
  /** exact / range / fcfs / tbd — so the app never prints 12:00 AM for "no time yet". */
  apptType: string | null
  apptEnd: string | null
  /** The Chicago calendar day of the appointment, YYYY-MM-DD; what "today" is judged on. */
  date: string | null
  /**
   * The driver flagged detention at this stop: they were there two hours or more past
   * the appointment. The in/out times live on the BOL, not here — see DETENTION_FREE_HOURS.
   */
  detention: boolean
  /** Is this stop the viewing driver's to work? Their own, or the only driver on the load. */
  yours: boolean
  /** The directory record behind the stop, when it is linked: what the office knows and what drivers said. */
  location: PaperworkStopLocation | null
  /** Facility events the driver reported from the app. See src/lib/stopEvents.ts. */
  arrivedAt: string | null
  departedAt: string | null
  /** Expected arrival, once the pickup has been departed; null until then or when unknown. */
  etaAt: string | null
  etaBasis: 'motive' | 'appt' | null
}

export interface PaperworkStopLocation {
  id: string
  hours: string | null
  dockNotes: string | null
  notes: string | null
  driverNotes: Array<{ at: string; by: string; text: string }>
}

export type PodLegibility = 'OK' | 'LOW' | 'UNREADABLE' | 'UNKNOWN'

export interface PaperworkPod {
  present: boolean
  pages: number
  /** Worst legibility across the pages — one bad page makes the POD bad. */
  legibility: PodLegibility
  notes: string | null
}

export interface PaperworkLoad {
  id: string
  /** What the driver and the office both call it — the PRO. */
  reference: string
  /** The customer's PO — the "TMS ID / PO" field on the load. */
  poNumber: string | null
  /** The pickup number the shipper issued. */
  pickupNumber: string | null
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
  eld: PaperworkEld
  /** An over-the-road run — to or from Iowa. See src/lib/overnight.ts. */
  overnight: boolean
  /*
   * The rate, in CENTS, and ONLY on an over-the-road run.
   *
   * This is the one deliberate exception to the rule that this payload carries no money.
   * Everything else here exists so an Ivan driver cannot be shown a rate they are not
   * settled on; OTR runs are paid differently and the office wants the driver to see what
   * the load earned. Null on every local load, and the field is only populated when
   * overnight is true — so a bug that mislabels a local run still cannot leak its rate.
   */
  rateCents: number | null
}

/**
 * Whether the day's run needs records of duty status, by the 150 air-mile rule.
 *
 * Shown on the load so a driver knows BEFORE they roll, not after. UNKNOWN means a stop
 * could not be placed on the map — it is never quietly treated as exempt, because the
 * dangerous error here is telling someone they need no logs for a run that left the radius.
 */
export interface PaperworkEld {
  status: EldStatus
  required: boolean
  /** Air miles to the farthest stop, from Pleasant Prairie. */
  farthestMiles: number | null
  farthestCity: string | null
  /** One line for the app to show — already phrased for a driver. */
  label: string
}

export interface PaperworkWeek {
  weekStart: string
  loadCount: number
  podsMissing: number
  podsIllegible: number
  /** Loads this week that leave the 150 air-mile radius, so logs are required. */
  eldRequired: number
  /** Over-the-road runs this week — to or from Iowa. */
  overnightCount: number
  /** What those runs earned, in CENTS. */
  overnightCents: number
}

/**
 * Detention starts two hours after the appointment time. The rule is stated to the driver
 * on every stop; the driver answers yes or no, and writes the in/out times on the BOL where
 * the customer signs for them. The app used to collect the clock itself (DriverLoadTime
 * timeIn/timeOut), which asked a driver to type at a dock what they had already written
 * on paper — dropped 8 Oct 2026 in favour of the one box.
 */
export const DETENTION_FREE_HOURS = 2

/** A row as stored by DriverLoadTime: one per stop the driver flagged. */
export interface LoadTimeRow {
  loadId: string
  driverId: string
  /** PICKUP / DELIVERY — the stop's type, for the office's benefit. */
  leg: string
  /** The stop this flag is for. */
  stopId?: string | null
  detention?: boolean | null
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

/**
 * Whose stop this is: the stop's own driver, the legacy pickup/delivery field for its
 * type, else the only driver on the load — the same reading delivererOf uses for the ETA.
 */
export function stopOwner(load: PaperworkLoadLike, stops: Stop[], stop: Stop): string | null {
  if (stop.driverId) return stop.driverId
  const legacy = stop.type === 'pickup' ? load.pickupDriverId : load.deliveryDriverId
  if (legacy) return legacy
  const drivers = new Set(stops.map((s) => s.driverId).filter((d): d is string => !!d))
  if (load.pickupDriverId) drivers.add(load.pickupDriverId)
  if (load.deliveryDriverId) drivers.add(load.deliveryDriverId)
  return drivers.size === 1 ? [...drivers][0] : null
}

/** Has the driver flagged detention at this stop? Absent row, or an unflagged one, is no. */
export function stopDetention(rows: LoadTimeRow[], stopId: string): boolean {
  return rows.some((r) => r.stopId === stopId && r.detention === true)
}

export function buildPaperworkLoad(
  load: PaperworkLoadLike,
  podDocs: PodDocRow[],
  flags: LoadTimeRow[],
  /** Who is looking: decides `yours` on each stop. Absent = nobody's. */
  viewerDriverId?: string | null,
): PaperworkLoad {
  const rawStops = getStops(load as unknown as Load) as Stop[]
  const stops: PaperworkStop[] = rawStops.map((s, i) => ({
    id: s.id,
    type: String(s.type ?? ''),
    sequence: typeof s.sequence === 'number' ? s.sequence : i,
    name: s.name?.trim() || null,
    street: s.address?.street?.trim() || null,
    // `city` on a stop is a display string ("Chicago, IL"); the address holds the parts.
    city: s.address?.city?.trim() || s.city?.trim() || null,
    state: s.address?.state?.trim() || null,
    zip: s.address?.zip?.trim() || null,
    appt: s.appt ?? null,
    apptType: s.apptType ?? null,
    apptEnd: s.apptEnd ?? null,
    date: s.appt ? chicagoDateStr(s.appt) || null : null,
    detention: stopDetention(flags, s.id),
    // Filled by the handler from the Location table; the pure builder knows only the id.
    location: null,
    yours: !!viewerDriverId && stopOwner(load, rawStops, s) === viewerDriverId,
    arrivedAt: s.arrivedAt ?? null,
    departedAt: s.departedAt ?? null,
    etaAt: s.etaAt ?? null,
    etaBasis: s.etaBasis ?? null,
  }))

  const pages = podDocs.filter((d) => (d.kind ?? '').toUpperCase() === 'POD')
  const legibility = worstLegibility(pages.map((d) => d.legibility))
  const notes = pages.map((d) => d.legibilityNotes?.trim()).find(Boolean) ?? null

  /*
   * Over-the-road is decided from the same places the ELD check uses, so the two cannot
   * disagree about where a load went. They answer different questions from the same facts.
   */
  const overnight = isOvernightLoad([
    ...stops.map((st) => (st.city && st.state ? `${st.city}, ${st.state}` : st.city)),
    place(load.originCity, load.originState, null),
    place(load.destinationCity, load.destinationState, null),
  ])

  return {
    id: load.id,
    reference: referenceOf(load),
    poNumber: load.tmsId?.trim() || null,
    pickupNumber: load.pickupNumber?.trim() || null,
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
    eld: assessLoadEld(stops, load),
    overnight,
    // Belt and braces: the rate is read only inside this branch, so a load that is not
    // over-the-road has no path by which its rate can reach the app at all.
    rateCents: overnight && typeof load.rate === 'number' ? load.rate : null,
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
    eldRequired: loads.filter((l) => l.eld.required).length,
    overnightCount: loads.filter((l) => l.overnight).length,
    /** What the week's OTR runs earned, in CENTS. Zero when there are none. */
    overnightCents: loads.reduce((n, l) => n + (l.rateCents ?? 0), 0),
  }
}
