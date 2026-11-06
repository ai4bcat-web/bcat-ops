/**
 * Where a load is in its delivery, as ONE pure answer (header-strip timeline, Shipments board
 * "Delivery" column). Five checkpoints on one line: On site (pickup), Departed, In transit, On site
 * (delivery), Delivered. A plain pickup + delivery load shows no stop caption; three or more stops
 * show "Stop n of m". The truck sits at the CURRENT phase of the CURRENT stop.
 *
 * Evidence, in order: delivered (status / deliveredAt) -> the stop's own `arrivedAt` / `departedAt`
 * -> the shipment status as a fallback for loads nobody stamped stops on. Nothing is inferred from an
 * appointment. Lateness reads the stop's appointment window (exact / range; FCFS and TBD have none)
 * and its ETA; an exception is an open incident. Limits (documented, not guessed): no geofence
 * derivation (no existing helper offers one), and a board row only carries the stop events the board
 * projection already reads.
 *
 * Relative imports only: shared by the UI and anything that bundles `src/lib`.
 */
import type { ShipmentStatus } from '../types/tms'

export type DeliveryPhase =
  | 'DRAFT' | 'NOT_COVERED' | 'NOT_DISPATCHED' | 'EN_ROUTE_PICKUP'
  | 'AT_PICKUP' | 'DEPARTED' | 'IN_TRANSIT' | 'AT_DELIVERY' | 'DELIVERED' | 'VOIDED'

export type CheckpointKey = 'AT_PICKUP' | 'DEPARTED' | 'IN_TRANSIT' | 'AT_DELIVERY' | 'DELIVERED'

export const CHECKPOINTS: readonly { key: CheckpointKey; label: string }[] = [
  { key: 'AT_PICKUP', label: 'On site (pickup)' },
  { key: 'DEPARTED', label: 'Departed' },
  { key: 'IN_TRANSIT', label: 'In transit' },
  { key: 'AT_DELIVERY', label: 'On site (delivery)' },
  { key: 'DELIVERED', label: 'Delivered' },
]

export const PHASE_LABEL: Record<DeliveryPhase, string> = {
  DRAFT: 'Draft',
  NOT_COVERED: 'Not dispatched',
  NOT_DISPATCHED: 'Not dispatched',
  EN_ROUTE_PICKUP: 'Heading to pickup',
  AT_PICKUP: 'On site (pickup)',
  DEPARTED: 'Departed',
  IN_TRANSIT: 'In transit',
  AT_DELIVERY: 'On site (delivery)',
  DELIVERED: 'Delivered',
  VOIDED: 'Voided',
}

export type PhaseTone = 'grey' | 'green' | 'amber' | 'red'

export interface PhaseStop {
  type: 'pickup' | 'delivery'
  arrivedAt?: string | null
  departedAt?: string | null
  appt?: string | null
  apptEnd?: string | null
  apptType?: 'exact' | 'range' | 'fcfs' | 'tbd' | null
  etaAt?: string | null
  name?: string | null
}

export interface PhaseInput {
  /** The create page: no shipment row yet. */
  create?: boolean
  voided?: boolean
  status?: ShipmentStatus | null
  /** A carrier or own asset is assigned. */
  covered: boolean
  deliveredAt?: string | null
  /** In route order. */
  stops: readonly PhaseStop[]
  /** Latest position the load reported, if any. */
  lastFix?: { at: string; place?: string | null } | null
  openIncidents?: number | null
  /** Minutes the current ETA is past the appointment, when tracking computed it. */
  etaLateMinutes?: number | null
  nowMs: number
}

export interface CheckpointState {
  key: CheckpointKey
  label: string
  reached: boolean
  at: string | null
}

export interface PhaseResult {
  phase: DeliveryPhase
  label: string
  /** Checkpoints reached, 0..5. */
  reachedCount: number
  /** 0-based current stop and the stop count (1 when stops are unknown). */
  stopIndex: number
  stopCount: number
  /** "Stop 2 of 4" for a multi-stop load; "Not dispatched" / "Draft" for the parked states; else ''. */
  caption: string
  tone: PhaseTone
  late: boolean
  /** Why the truck is amber (late versus the appointment, ETA past it, or an open exception). */
  reason: string | null
  checkpoints: CheckpointState[]
  /** Where the truck is drawn: 0 = parked left of the first checkpoint, 0.5 = between 1 and 2 ... 4 = on the last. */
  truckAt: number
  /** The last position and when, for the truck's hover. */
  lastFix: { at: string; place: string | null } | null
  /** role=img text: "In transit, stop 2 of 4". */
  summary: string
}

const GRACE_MS = 15 * 60_000
/** After leaving a stop, the load counts as Departed until it has been on the road this long (or reports a newer fix). */
const DEPARTED_WINDOW_MS = 15 * 60_000

const at = (iso: string | null | undefined): number => {
  const t = Date.parse(iso ?? '')
  return Number.isFinite(t) ? t : NaN
}

/** The appointment window's close for an exact or range appointment; null for FCFS / TBD / none. */
function windowEnd(s: PhaseStop): number | null {
  if (s.apptType === 'fcfs' || s.apptType === 'tbd') return null
  const end = at(s.apptEnd)
  const start = at(s.appt)
  const t = Number.isFinite(end) ? end : start
  return Number.isFinite(t) ? t : null
}

type Evidence = { phase: DeliveryPhase; stop: number; fromStatus?: boolean }

/** The first stop the truck has not left; the last stop once all are done. */
function currentStop(stops: readonly PhaseStop[]): number {
  const i = stops.findIndex((s) => !s.departedAt)
  return i === -1 ? Math.max(0, stops.length - 1) : i
}

function fromStops(stops: readonly PhaseStop[], now: number, fix: PhaseInput['lastFix']): Evidence | null {
  if (stops.length === 0 || !stops.some((s) => s.arrivedAt || s.departedAt)) return null
  const i = currentStop(stops)
  const s = stops[i]!
  const prev = i > 0 ? stops[i - 1]! : null
  if (s.arrivedAt && !s.departedAt) return { phase: s.type === 'delivery' ? 'AT_DELIVERY' : 'AT_PICKUP', stop: i }
  if (s.departedAt) {
    // Every stop has departed: the last one just left.
    return { phase: s.type === 'delivery' && i === stops.length - 1 ? 'DELIVERED' : 'DEPARTED', stop: i }
  }
  if (prev?.departedAt) {
    const left = at(prev.departedAt)
    const fixNewer = fix != null && at(fix.at) > left
    return { phase: fixNewer || now - left >= DEPARTED_WINDOW_MS ? 'IN_TRANSIT' : 'DEPARTED', stop: i }
  }
  // Nothing at this stop yet and nothing before it departed: still heading to the first pickup.
  return { phase: 'EN_ROUTE_PICKUP', stop: i }
}

const STATUS_PHASE: Partial<Record<ShipmentStatus, DeliveryPhase>> = {
  DISPATCHED: 'EN_ROUTE_PICKUP',
  LOADING: 'AT_PICKUP',
  PICKED_UP: 'IN_TRANSIT',
  IN_TRANSIT: 'IN_TRANSIT',
  RECOVERED: 'IN_TRANSIT',
  ARRIVED_AT_DELIVERY_TERMINAL: 'AT_DELIVERY',
  OUT_FOR_DELIVERY: 'IN_TRANSIT',
  UNLOADING: 'AT_DELIVERY',
  DELIVERED: 'DELIVERED',
}

/** The truck stands on the checkpoint, or between two while moving; 0 = parked at the left end. */
const TRUCK_AT: Record<DeliveryPhase, number> = {
  DRAFT: 0, NOT_COVERED: 0, NOT_DISPATCHED: 0, EN_ROUTE_PICKUP: 0, AT_PICKUP: 0, DEPARTED: 1, IN_TRANSIT: 2,
  AT_DELIVERY: 3, DELIVERED: 4, VOIDED: 0,
}
const REACHED: Record<DeliveryPhase, number> = {
  DRAFT: 0, NOT_COVERED: 0, NOT_DISPATCHED: 0, EN_ROUTE_PICKUP: 0, AT_PICKUP: 1, DEPARTED: 2, IN_TRANSIT: 3,
  AT_DELIVERY: 4, DELIVERED: 5, VOIDED: 0,
}

function lateReason(phase: DeliveryPhase, stop: PhaseStop | undefined, now: number, etaLateMinutes: number | null | undefined): string | null {
  if (phase === 'DELIVERED' || !stop) return null
  const end = windowEnd(stop)
  const where = stop.type === 'delivery' ? 'delivery' : 'pickup'
  if (end !== null) {
    const arrived = at(stop.arrivedAt)
    if (Number.isFinite(arrived) && arrived > end + GRACE_MS) return `Arrived late for the ${where} appointment`
    const eta = at(stop.etaAt)
    if (!Number.isFinite(arrived)) {
      if (Number.isFinite(eta) && eta > end + GRACE_MS) return `ETA is after the ${where} appointment`
      if (now > end + GRACE_MS) return `Past the ${where} appointment and not on site`
    }
  }
  if ((etaLateMinutes ?? 0) > 15) return `ETA is ${Math.round(etaLateMinutes!)} min past the appointment`
  return null
}

const summaryOf = (label: string, caption: string, stopIndex: number, stopCount: number): string =>
  stopCount > 2 && caption.startsWith('Stop') ? `${label}, stop ${stopIndex + 1} of ${stopCount}` : caption && !caption.startsWith('Stop') ? caption : label

export function deliveryPhase(i: PhaseInput): PhaseResult {
  const stops = i.stops
  const stopCount = Math.max(1, stops.length)
  const checkpoints = (reached: number, current: PhaseStop | undefined, phase: DeliveryPhase): CheckpointState[] =>
    CHECKPOINTS.map((c, n) => ({
      key: c.key, label: c.label, reached: n < reached,
      // The stamp each checkpoint shows on hover comes from the current stop's own events.
      at: n >= reached ? null
        : c.key === 'AT_PICKUP' ? (stops.find((s) => s.type === 'pickup')?.arrivedAt ?? null)
        : c.key === 'DEPARTED' ? (stops.find((s) => s.type === 'pickup')?.departedAt ?? null)
        : c.key === 'AT_DELIVERY' ? ([...stops].reverse().find((s) => s.type === 'delivery')?.arrivedAt ?? current?.arrivedAt ?? null)
        : c.key === 'DELIVERED' ? (i.deliveredAt ?? [...stops].reverse().find((s) => s.type === 'delivery')?.departedAt ?? null)
        : (phase === 'IN_TRANSIT' ? (i.lastFix?.at ?? null) : null),
    }))
  const done = (phase: DeliveryPhase, stopIndex: number, caption: string, tone: PhaseTone, late: string | null): PhaseResult => {
    const label = PHASE_LABEL[phase]
    const cap = caption
    return {
      phase, label, reachedCount: REACHED[phase], stopIndex, stopCount, caption: cap, tone, late: late !== null, reason: late,
      checkpoints: checkpoints(REACHED[phase], stops[stopIndex], phase), truckAt: TRUCK_AT[phase],
      lastFix: i.lastFix ? { at: i.lastFix.at, place: i.lastFix.place ?? null } : null,
      summary: summaryOf(label, cap, stopIndex, stopCount),
    }
  }

  if (i.create) return done('DRAFT', 0, 'Draft', 'grey', null)
  if (i.voided) return done('VOIDED', 0, 'Voided', 'red', null)

  const delivered = i.status === 'DELIVERED' || Boolean(i.deliveredAt)
  const ev: Evidence | null = delivered
    ? { phase: 'DELIVERED', stop: Math.max(0, stops.length - 1) }
    : fromStops(stops, i.nowMs, i.lastFix ?? null)
    ?? (i.status && STATUS_PHASE[i.status] ? { phase: STATUS_PHASE[i.status]!, stop: 0, fromStatus: true } : null)

  if (!ev) {
    return i.covered ? done('NOT_DISPATCHED', 0, 'Not dispatched', 'grey', null) : done('NOT_COVERED', 0, 'Not dispatched', 'grey', null)
  }
  // Status alone cannot say WHICH stop: no stop caption without stop events.
  const stopCaption = stopCount > 2 && ev.phase !== 'DELIVERED' && !ev.fromStatus ? `Stop ${ev.stop + 1} of ${stopCount}` : ''
  const reason = (i.openIncidents ?? 0) > 0
    ? `Open exception (${i.openIncidents})`
    : lateReason(ev.phase, stops[ev.stop], i.nowMs, i.etaLateMinutes)
  const result = done(ev.phase, ev.stop, stopCaption, reason ? 'amber' : 'green', reason)
  return ev.fromStatus ? { ...result, stopCount: 1 } : result
}

/** Compact board text: "In transit · Stop 1/2". Parked states are just their caption. */
export function deliveryPhaseText(r: PhaseResult): string {
  if (r.phase === 'DRAFT' || r.phase === 'VOIDED' || r.phase === 'NOT_COVERED' || r.phase === 'NOT_DISPATCHED') return r.label
  return r.stopCount > 2 && r.phase !== 'DELIVERED' ? `${r.label} · Stop ${r.stopIndex + 1}/${r.stopCount}` : r.label
}
