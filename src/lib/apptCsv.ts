import { apptTimeLabel, formatDateShort } from './date'
import type { ApptQueueRow } from './apptQueue'

/**
 * CSV export for the Appts queue.
 *
 * Columns mirror the on-screen table so an exported section is recognisable as the thing
 * that was on screen — the point of the export is to hand a day's appointments to
 * someone who is going to sit and make phone calls (Booked rows included, marked as such).
 *
 * One row per shipment — pickup and delivery status together.
 */

export const APPT_CSV_HEADER = [
  'PU Status', 'Del Status', 'Pro #', 'PU #', 'Customer',
  'PU Location', 'Del Location', 'Appt date', 'Driver', 'Del Driver',
  'PU time', 'Delivery time',
] as const

/**
 * Quote every field.
 *
 * Always quoting (rather than only when a comma appears) means a customer name containing
 * a comma, a quote, or a newline can't shift the remaining columns one to the left —
 * which in a file someone is reading appointments off is a wrong-phone-number bug, not a
 * cosmetic one. Embedded quotes are doubled per RFC 4180.
 */
const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`

const STATUS_LABEL: Record<string, string> = { need: 'NEED', pending: 'Pending', move: 'MOVE' }

/** One CSV row per queue row (shipment), in the order given. */
export function apptRowsToCsv(
  rows: ApptQueueRow[],
  driverName: (id: string | null) => string,
): string {
  const lines = [APPT_CSV_HEADER.map(q).join(',')]
  for (const r of rows) {
    lines.push([
      r.pickupKind ? (STATUS_LABEL[r.pickupKind] ?? r.pickupKind) : 'Booked',
      r.deliveryKind ? (STATUS_LABEL[r.deliveryKind] ?? r.deliveryKind) : 'Booked',
      r.aljexId,
      r.pickupNumber,
      r.customer,
      r.location,
      r.deliveryLocation,
      r.appt ? formatDateShort(r.appt) : '',
      driverName(r.driverId),
      r.deliveryDriverId ? driverName(r.deliveryDriverId) : '',
      apptTimeLabel(r.pickup.appt, r.pickup.apptType, r.pickup.apptEnd),
      apptTimeLabel(r.delivery.appt, r.delivery.apptType, r.delivery.apptEnd),
    ].map(q).join(','))
  }
  return lines.join('\n')
}

/**
 * Filename for a section export, e.g. `appts-2026-08-19.csv`.
 * Undated sections get a stable name rather than `appts-.csv`.
 */
export function apptCsvFilename(sectionKey: string): string {
  return sectionKey ? `appts-${sectionKey}.csv` : 'appts-no-pickup-date.csv'
}