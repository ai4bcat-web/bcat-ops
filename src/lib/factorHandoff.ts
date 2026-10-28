/**
 * Send to Factor — turning an issued invoice into an OTR queue row.
 *
 * The factoring queue has exactly one way in today: the Aljex invoice e-mail the intake
 * parses into a `FactoringItem`, whose id IS the PRO. `manageOtr submit` then resolves
 * that PRO back to a Load and sends what the office typed on the row. None of that
 * changes here. This module builds the SAME row from an invoice we issued ourselves, so
 * submit cannot tell the two apart: `id` is the load's `aljexId` — which for a
 * shipment-born load is its load number — and every one of the eleven OTR fields is
 * prefilled on `otrManualFields`, where a human can still correct it.
 *
 * Prefilling from the invoice rather than from the load is deliberate. The invoice is the
 * document a person reviewed and sent to the broker; the load is working data that moves
 * until the day it is billed. The amount, the date, the PO and the cities on the queue row
 * are therefore the ones on the bill the customer already has.
 *
 * Money: `InvoiceRecord.totalCents` is CENTS; OTR's InvoiceAmount is DOLLARS, as a string
 * with two decimals. The conversion is `rateCentsToDollars` in ./otrInvoice and nowhere
 * else.
 */
// Relative, not `@/` — the tmsFinanceActions Lambda bundles this file by path for its
// SEND_TO_FACTOR action, and the alias does not exist in the function build.
import { normalizeZip, rateCentsToDollars, splitCityState } from './otrInvoice'
import type { OtrRequiredField } from './otrInvoice'
import type { FactoringItem, Stop } from '../types'
import type {
  CustomerRecord,
  InvoiceRecord,
  OrderRecord,
  ShipmentRecord,
} from '../types/tms'

/**
 * The slice of a Load this module needs. `aljexId` is the PRO: a shipment-born load
 * carries its load number there, which is what the broker and OTR both quote.
 */
export interface FactorLoadSlice {
  id: string
  aljexId?: string | null
  shipmentId?: string | null
}

export interface FactoringRowInput {
  invoice: InvoiceRecord
  order: OrderRecord
  load: FactorLoadSlice
  /** The order's stops, in any order; sequence decides first pickup and last delivery. */
  stops?: Stop[] | null
  customer: CustomerRecord
  /** Who pressed Send to Factor. Stands in for the intake e-mail's sender. */
  caller: string
  /** ISO timestamp for `receivedAt` / `createdAt` / `updatedAt`. */
  now: string
}

export interface FactorRefusalInput {
  invoice: InvoiceRecord
  order: OrderRecord
  shipment: ShipmentRecord
  customer: CustomerRecord
  load?: FactorLoadSlice | null
  /** A queue row already on this PRO, when one exists. */
  existingRow?: FactoringItem | null
  /**
   * The factor's remit-to name from org settings, when one is configured. Supplied,
   * the invoice's own remit-to must match it.
   */
  factorRemitToName?: string | null
}

/** A trimmed non-empty string, or undefined. An empty OTR field is worse than no field. */
function text(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t ? t : undefined
}

/** Two letters, uppercased — OTR rejects anything else, so send nothing instead. */
function state(v: unknown): string | undefined {
  const s = text(v)
  if (!s) return undefined
  return /^[A-Za-z]{2}$/.test(s) ? s.toUpperCase() : undefined
}

/** City · state · ZIP for one end of the run, from the stop's booked address. */
interface Place {
  city?: string
  state?: string
  zip?: string
}

/**
 * Where a stop is.
 *
 * The address snapshot is the detailed source; `Stop.city` is the display string and
 * sometimes carries the state appended ("MESA, AZ"), which `splitCityState` recovers.
 */
function placeOf(stop: Stop | undefined): Place {
  if (!stop) return {}
  const label = splitCityState(stop.city)
  return {
    city: text(stop.address?.city) ?? label.city,
    state: state(stop.address?.state) ?? label.state,
    zip: normalizeZip(stop.address?.zip),
  }
}

/** Stops of one type, in route order. */
function ordered(stops: Stop[] | null | undefined, type: Stop['type']): Stop[] {
  return (stops ?? [])
    .filter((s) => s.type === type)
    .slice()
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
}

/**
 * The PO number as the invoice states it.
 *
 * Only a reference the customer may see counts: an INTERNAL one is ours, never the
 * broker's, and sending it as their PO would put a number they do not recognise on a
 * bill they are being asked to pay.
 */
export function invoicePoNumber(invoice: InvoiceRecord): string | undefined {
  for (const ref of invoice.references ?? []) {
    if (text(ref.code)?.toUpperCase() !== 'PO') continue
    if (ref.visibility !== 'CUSTOMER' && ref.visibility !== 'ALL') continue
    const value = text(ref.value)
    if (value) return value
  }
  return undefined
}

/**
 * The eleven OTR fields, read off the issued invoice.
 *
 * Every value is a string, because `FactoringItem.otrManualFields` is
 * `Record<string, string>` and the office edits them as text. A field we cannot fill is
 * OMITTED rather than written empty: `assembleOtrInvoice` reports a missing field as a
 * gap to fill in, while an empty string would read as a value and be submitted.
 */
export function otrFieldsFor(
  input: Pick<FactoringRowInput, 'invoice' | 'load' | 'stops' | 'customer'>,
): Record<string, string> {
  const { invoice, customer, stops } = input
  const from = placeOf(ordered(stops, 'pickup')[0])
  const deliveries = ordered(stops, 'delivery')
  const to = placeOf(deliveries[deliveries.length - 1])
  const amount = rateCentsToDollars(invoice.totalCents)

  const fields: Record<string, string> = {}
  const put = (field: OtrRequiredField, value: string | undefined) => {
    if (value) fields[field] = value
  }

  put('InvoiceNo', text(invoice.number))
  put('PoNumber', invoicePoNumber(invoice))
  put('BrokerMC', text(customer.mcNumber))
  // Dollars with two decimals, from cents. Never float arithmetic on the way in.
  put('InvoiceAmount', amount === undefined ? undefined : amount.toFixed(2))
  put('InvoiceDate', text(invoice.invoiceDate))
  put('FromCity', from.city)
  put('FromState', from.state)
  put('FromZip', from.zip)
  put('ToCity', to.city)
  put('ToState', to.state)
  put('ToZip', to.zip)
  return fields
}

/**
 * The queue row Send to Factor writes.
 *
 * Shaped exactly like an intake-written row so `manageOtr submit` needs no change: `id`
 * and `proNumber` are the load's PRO, and the three fields the intake fills from the
 * e-mail — subject, sender, message id — are filled from the invoice, the caller and a
 * `tms:` key that makes a second press idempotent at the Put.
 */
export function factoringRowFor(input: FactoringRowInput): FactoringItem {
  const { invoice, order, load, customer, caller, now } = input
  const pro = text(load.aljexId) ?? ''
  const shipmentNumber = text(invoice.shipmentNumber) ?? text(invoice.shipmentId) ?? ''

  return {
    id: pro,
    proNumber: pro,
    status: 'NEED_TO_FACTOR',
    subject: `Invoice ${invoice.number} · ${shipmentNumber}`,
    fromEmail: caller,
    receivedAt: now,
    messageId: `tms:${invoice.id}`,
    createdAt: now,
    updatedAt: now,
    loadId: load.id,
    customerId: customer.id,
    source: 'TMS',
    invoiceId: invoice.id,
    orderId: order.id,
    shipmentId: invoice.shipmentId,
    otrManualFields: otrFieldsFor(input),
  }
}

/**
 * Why this invoice cannot be sent to the factor, in one sentence, or null if it can.
 *
 * Each refusal names something a person can fix. They are checked in the order a person
 * would: the invoice itself first, then the broker it bills, then the freight, then the
 * queue — so the first answer is the most fundamental one, not whichever happens to be
 * cheapest to test.
 */
export function whyNotFactorable(input: FactorRefusalInput): string | null {
  const { invoice, order, shipment, customer, load, existingRow } = input

  if (invoice.status === 'VOID') {
    return `Invoice ${invoice.number} is void; re-issue it before sending it to the factor.`
  }
  if (invoice.status === 'PAID') {
    return `Invoice ${invoice.number} is already paid in full, so there is nothing to factor.`
  }
  if (text(order.invoiceId) && order.invoiceId !== invoice.id) {
    return `Invoice ${invoice.number} is not this order's current invoice (${order.invoiceId}).`
  }
  if (!text(customer.mcNumber)) {
    return `${customer.name} has no MC number on file, and OTR resolves the broker from its MC.`
  }
  if (shipment.status !== 'DELIVERED') {
    return `Shipment ${shipment.number} is ${shipment.status}, not DELIVERED; a factor buys a delivered load.`
  }
  if (!load) {
    return `Invoice ${invoice.number} has no load, so there is no PRO to factor it under.`
  }
  if (!text(load.aljexId)) {
    return `Load ${load.id} has no PRO number, which is the id OTR files the invoice under.`
  }
  if (existingRow && text(existingRow.otrInvoiceId)) {
    return `PRO ${existingRow.proNumber} was already submitted to OTR as invoice ${existingRow.otrInvoiceId}.`
  }
  // One queue row per PRO, and that row bills one invoice. Two orders on a shipment
  // whose loads carry no orderId both resolve to the same PRO; without this, the
  // second hand-off would silently repoint the row and leave the first invoice
  // marked factored against a row that now bills something else.
  if (existingRow && text(existingRow.invoiceId) && existingRow.invoiceId !== invoice.id) {
    return `PRO ${existingRow.proNumber} is already on the factoring queue for invoice ${existingRow.invoiceId}.`
  }
  // A factor buys a bill that tells the customer to pay the factor. If this one prints
  // our own remit-to, selling it sends the cash to the wrong account.
  if (input.factorRemitToName && text(invoice.remitTo?.name) !== input.factorRemitToName) {
    return `Invoice ${invoice.number} is addressed to pay ${invoice.remitTo?.name ?? 'us'}, not the factor; void and re-issue it with the factor's remit-to.`
  }
  return null
}
