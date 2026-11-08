import type { CreateShipmentLoadBag } from '@/lib/apiClient'
import type { OtrReadiness } from '@/lib/otrInvoice'

/**
 * The leg of a shipment built from a factoring row whose PRO was never entered in BCAT Ops.
 *
 * The Aljex invoice email names the PRO, and the row's prepared fields (typed by staff or
 * read off the rate confirmation) carry the PO, amount, lanes and invoice date. That is
 * enough to give the POD and the rate confirmation a load to attach to, so the row can be
 * submitted to OTR like any other. Drivers stay empty — nobody in the app ran it.
 *
 * This is the `load` bag CREATE_SHIPMENT takes, not a Load row. Three differences follow
 * from that: `readyToInvoice` is gone, because the server refuses it outright and
 * honouring it would walk the freight straight past `evaluateReleaseGate`; the amount is
 * `rateCents`, which becomes a CUSTOMER LINEHAUL charge priced through the shipment rather
 * than a raw `Load.rate` that would leave a $0 order under a $X load; and the customer is
 * the caller's business, because only the caller knows whether the row resolved to a
 * record or only to typed text.
 */
export function loadFromFactoringItem(
  item: { proNumber: string },
  readiness: OtrReadiness | null,
  nowIso: string,
): CreateShipmentLoadBag {
  const p = readiness?.payload ?? {}
  const str = (v: unknown) => (v == null ? '' : String(v).trim())
  const place = (city: unknown, state: unknown) => [str(city), str(state)].filter(Boolean).join(', ') || undefined
  const amount = Number(p.InvoiceAmount)
  // A date-only appointment is stored at local midnight and reads as "time pending".
  const day = /^\d{4}-\d{2}-\d{2}$/.test(str(p.InvoiceDate)) ? str(p.InvoiceDate) : nowIso.slice(0, 10)
  const appt = new Date(`${day}T00:00:00-05:00`).toISOString()
  const cents = Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : undefined
  return {
    // The PO, which the driver API also reports as the pickup number. The server keeps
    // both as given and only falls back to the PRO when they are blank.
    tmsId: str(p.PoNumber) || undefined,
    pickupAppt: appt,
    pickupApptType: 'fcfs',
    deliveryAppt: appt,
    deliveryApptType: 'fcfs',
    originCity: place(p.FromCity, p.FromState),
    destinationCity: place(p.ToCity, p.ToState),
    pickupDriverId: null,
    deliveryDriverId: null,
    ...(cents != null ? { rateCents: cents } : {}),
    notes: `Created from the factoring queue (invoice email for PRO ${item.proNumber}); no driver recorded.`,
  }
}
