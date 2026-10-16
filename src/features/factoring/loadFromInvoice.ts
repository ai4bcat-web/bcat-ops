import type { Load } from '@/types'
import type { OtrReadiness } from '@/lib/otrInvoice'

/**
 * A load built from a factoring row whose PRO was never entered in BCAT Ops.
 *
 * The Aljex invoice email names the PRO, and the row's prepared fields (typed by staff or
 * read off the rate confirmation) carry the PO, amount, lanes and invoice date. That is
 * enough to give the POD and the rate confirmation a load to attach to, so the row can be
 * submitted to OTR like any other. Drivers stay empty — nobody in the app ran it.
 */
export function loadFromFactoringItem(
  item: { proNumber: string; customerId?: string | null },
  readiness: OtrReadiness | null,
  staffEmail: string,
  nowIso: string,
): Omit<Load, 'id' | 'createdAt' | 'updatedAt'> {
  const p = readiness?.payload ?? {}
  const str = (v: unknown) => (v == null ? '' : String(v).trim())
  const place = (city: unknown, state: unknown) => [str(city), str(state)].filter(Boolean).join(', ') || undefined
  const amount = Number(p.InvoiceAmount)
  // A date-only appointment is stored at local midnight and reads as "time pending".
  const day = /^\d{4}-\d{2}-\d{2}$/.test(str(p.InvoiceDate)) ? str(p.InvoiceDate) : nowIso.slice(0, 10)
  const appt = new Date(`${day}T00:00:00-05:00`).toISOString()
  return {
    aljexId: item.proNumber,
    tmsId: str(p.PoNumber),
    pickupNumber: '',
    pickupAppt: appt,
    pickupApptType: 'fcfs',
    deliveryAppt: appt,
    deliveryApptType: 'fcfs',
    originCity: place(p.FromCity, p.FromState),
    destinationCity: place(p.ToCity, p.ToState),
    pickupDriverId: null,
    deliveryDriverId: null,
    readyToInvoice: true,
    rate: Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : null,
    customer: readiness?.customerName?.trim() || null,
    customerId: item.customerId ?? null,
    notes: `Created from the factoring queue (invoice email for PRO ${item.proNumber}); no driver recorded.`,
    createdBy: staffEmail,
    updatedBy: staffEmail,
  }
}
