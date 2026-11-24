/**
 * The Tracking page's quick update (Ryne 2026-11-24): status, the stop clock and the POD
 * from the row, without opening the shipment.
 *
 * Nothing here writes. The dialog saves through the shipment form's own calls (UPDATE_STOP /
 * SET_TIMES for a time, SET_LOAD_STATUS for a status), so the server's rules, the audit entry
 * and the move to Load Review after the delivery are the form's.
 */
import { LOAD_WORKFLOW_STATUS_LABELS, nextLoadStatuses } from '@/lib/shipmentStatus'
import { stopTimesOf, type StopTimes } from '@/lib/stopActualTimes'
import type { Stop } from '@/types'
import type { LoadWorkflowStatus, ShipmentLoad, ShipmentMode } from '@/types/tms'

export type QuickTimeKind = 'arrivedAt' | 'departedAt'

export interface QuickTimeRow {
  /** `${stopId}:${kind}`, stable for test ids and React keys. */
  key: string
  loadId: string
  stopId: string
  kind: QuickTimeKind
  label: string
  /** Where the time is recorded: "Pickup", "Delivery 2 of 3". */
  where: string
  /** The saved ISO time, or null while it is still to come. */
  value: string | null
  /** The earlier time on the same stop the person must not go before. */
  after: string | null
}

const ordinal = (n: number, of: number): string => (of > 1 ? ` ${n} of ${of}` : '')

/**
 * The four times a tracker records, in route order: on site at pickup, departed pickup,
 * arrived at delivery, delivered. A second pickup or an interim delivery gets its own rows,
 * numbered; the last delivery's out time is Delivered (the same word the form uses).
 */
export function quickTimeRows(load: Pick<ShipmentLoad, 'id' | 'stops'>): QuickTimeRow[] {
  const times: StopTimes[] = stopTimesOf({ loads: [load] })
  const pickups = times.filter((t) => t.type === 'pickup')
  const deliveries = times.filter((t) => t.type === 'delivery')
  const rows: QuickTimeRow[] = []
  const add = (t: StopTimes, kind: QuickTimeKind, label: string, where: string) => {
    rows.push({
      key: `${t.stopId}:${kind}`,
      loadId: t.loadId,
      stopId: t.stopId,
      kind,
      label,
      where,
      value: kind === 'arrivedAt' ? t.arrivedAt : t.departedAt,
      after: kind === 'departedAt' ? t.arrivedAt : null,
    })
  }
  for (const t of times) {
    const group = t.type === 'pickup' ? pickups : deliveries
    const n = group.indexOf(t) + 1
    const where = `${t.type === 'pickup' ? 'Pickup' : 'Delivery'}${ordinal(n, group.length)}`
    if (t.type === 'pickup') {
      add(t, 'arrivedAt', 'On site at pickup', where)
      add(t, 'departedAt', 'Departed pickup', where)
    } else {
      add(t, 'arrivedAt', 'Arrived at delivery', where)
      add(t, 'departedAt', t.isFinalDelivery ? 'Delivered' : 'Departed delivery', where)
    }
  }
  return rows
}

/** The ISO time a "Now" press saves: the clock, never a stored value. */
export const nowIso = (now: number = Date.now()): string => new Date(now).toISOString()

/**
 * Why a time cannot be saved yet, or null. The server says the same in its own words; this
 * only keeps an obvious mistake from costing a round trip.
 */
export function timeProblem(row: Pick<QuickTimeRow, 'after'>, iso: string, now: number = Date.now()): string | null {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return 'Enter the date and time.'
  if (at > now + 5 * 60_000) return 'A time cannot be in the future.'
  if (row.after && at < Date.parse(row.after)) return 'That is before the time the truck arrived at this stop.'
  return null
}

export interface StatusOption { value: LoadWorkflowStatus; label: string }

/** The statuses a person may move this load to by hand (the ladder the server enforces). INVOICING is never set by hand. */
export function statusOptions(status: LoadWorkflowStatus | null | undefined, mode?: ShipmentMode | null): StatusOption[] {
  return nextLoadStatuses(status, mode)
    .filter((s) => s !== 'INVOICING')
    .map((s) => ({ value: s, label: LOAD_WORKFLOW_STATUS_LABELS[s] }))
}

export type { Stop }
