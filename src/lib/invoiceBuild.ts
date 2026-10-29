/**
 * Invoicing — everything that decides what one bill says, before anything is written.
 *
 * Three rules shape this file:
 *
 * 1. **An invoice is a snapshot, not a view.** Every function here takes the rows as
 *    they are now and returns plain data; the Lambda freezes that data onto the
 *    `Invoice` row at issue and never re-derives it. A mistake is voided and
 *    re-issued, never edited.
 * 2. **An invoice is customer-facing.** `invoiceData` carries no cost, no carrier
 *    pay, no margin and no INTERNAL reference. That is a hard rule, not a default:
 *    the file this builds is e-mailed to the people who are being billed.
 * 3. **Money is integer cents.** Nothing here divides, and the only place a decimal
 *    point appears is a message a human reads.
 *
 * Imports are relative: the `tmsFinanceActions` Lambda bundles this file by path and
 * the `@/` alias does not exist in the function build.
 */
import { canEmailTo, DOCUMENT_TYPE_LABELS, normalizeRequiredDocTypes, requiredDocTypesFor } from './shipmentDocuments'
import { isShipmentVoided } from './shipmentVoid'
import type {
  Address,
  BillToParty,
  CustomerRecord,
  Division,
  DocGateResult,
  InvoiceBillTo,
  InvoiceLine,
  InvoiceRecord,
  LoadChargeRecord,
  OrderRecord,
  OrderReference,
  RemitTo,
  RequiredReference,
  ShipmentDocumentRecord,
  ShipmentLoad,
  ShipmentRecord,
  TmsSettings,
} from '../types/tms'
import type { Stop } from '../types'

/** `{prefix}` is the division's `invoicePrefix`, `{n:6}` the zero-padded counter. */
export const DEFAULT_INVOICE_NUMBER_FORMAT = '{prefix}{n:6}'

/** Net terms when nobody — bill-to, customer or org — has said otherwise. */
export const DEFAULT_PAYMENT_TERMS_DAYS = 30

/** What goes on the invoice when `invoiceAttachTypes` has never been set. */
export const DEFAULT_INVOICE_ATTACH_TYPES = ['POD', 'BOL']

const INVOICE_NUMBER_FORMAT_MESSAGE = 'The invoice number format needs an {n} token'

/** `{n}` / `{n:1}`…`{n:12}`, `{prefix}` and `{yyyy}`. Anything else is left alone. */
const TOKEN = /\{(prefix|yyyy|n)(?::(\d{1,2}))?\}/g

/**
 * The pad width of an `{n}` token: 0 for a bare `{n}`, K for `{n:K}` in range, null
 * when the token is not a usable counter. Shared by the renderer and the refusal so
 * a format either works in both or is rejected by both.
 */
function counterWidth(pad: string | undefined): number | null {
  if (pad === undefined) return 0
  const width = Number(pad)
  return Number.isInteger(width) && width >= 1 && width <= 12 ? width : null
}

/**
 * Render one invoice number. An unknown token is printed verbatim rather than
 * silently dropped, so a typo in the settings card shows up on the preview instead
 * of quietly numbering a year of invoices wrong.
 */
export function formatInvoiceNumber(
  format: string,
  args: { prefix: string; n: number; date: string },
): string {
  return format.replace(TOKEN, (match, token: string, pad?: string) => {
    if (token === 'prefix') return pad === undefined ? args.prefix : match
    if (token === 'yyyy') return pad === undefined ? args.date.slice(0, 4) : match
    const width = counterWidth(pad)
    return width === null ? match : String(Math.trunc(args.n)).padStart(width, '0')
  })
}

/**
 * A format with no counter would hand every invoice the same number. Both the
 * settings card and `GENERATE_INVOICE` refuse through this, so they refuse alike.
 */
export function invoiceNumberFormatError(format: string): string | null {
  const hasCounter = format
    .replace(TOKEN, (match, token: string, pad?: string) =>
      token === 'n' && counterWidth(pad) !== null ? '\u0000' : match,
    )
    .includes('\u0000')
  return hasCounter ? null : INVOICE_NUMBER_FORMAT_MESSAGE
}

function positiveDays(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return null
  return value
}

/**
 * The bill-to wins over the customer, which wins over the org default. A zero or a
 * blank at any level is not an answer — it falls through to the next one, so a
 * half-filled bill-to never bills on terms nobody chose.
 */
export function invoiceTermsDays(
  customer: Pick<CustomerRecord, 'paymentTermsDays'> | null | undefined,
  billTo: Pick<BillToParty, 'paymentTermsDays'> | null | undefined,
  settings: Pick<TmsSettings, 'defaultPaymentTermsDays'> | null | undefined,
): number {
  return (
    positiveDays(billTo?.paymentTermsDays) ??
    positiveDays(customer?.paymentTermsDays) ??
    positiveDays(settings?.defaultPaymentTermsDays) ??
    DEFAULT_PAYMENT_TERMS_DAYS
  )
}

/**
 * `invoiceDate` + `termsDays`, in UTC. Local time would move a due date by a day for
 * anyone west of Greenwich on the last of a month, and AR is read in days.
 */
export function dueDateFor(invoiceDate: string, termsDays: number): string {
  const [y, m, d] = invoiceDate.slice(0, 10).split('-').map(Number)
  const days = Number.isFinite(termsDays) ? Math.trunc(termsDays) : 0
  const at = Date.UTC(y, m - 1, d + days)
  return new Date(at).toISOString().slice(0, 10)
}

export interface InvoiceLineResult {
  lines: InvoiceLine[]
  subtotalCents: number
}

/**
 * The order's customer-side charges, in the order the charges tab shows them. The
 * carrier side is not on the bill and never was: the customer is billed revenue, and
 * what we paid to move it is nobody's business but ours.
 */
export function invoiceLinesFor(
  charges: readonly LoadChargeRecord[],
  orderId: string,
): InvoiceLineResult {
  const mine = charges
    .filter((charge) => charge.side === 'CUSTOMER' && charge.orderId === orderId)
    .slice()
    .sort((a, b) => (a.sortOrder - b.sortOrder) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const lines: InvoiceLine[] = mine.map((charge) => ({
    chargeId: charge.id,
    loadId: charge.loadId ?? null,
    code: charge.code,
    label: charge.label ?? null,
    calculatedBy: charge.calculatedBy,
    rateCents: charge.rateCents,
    count: typeof charge.count === 'number' && Number.isFinite(charge.count) ? charge.count : 1,
    amountCents: charge.amountCents,
  }))

  let subtotalCents = 0
  for (const line of lines) subtotalCents += line.amountCents
  return { lines, subtotalCents }
}

/**
 * Which required references this order still lacks, as labels a dispatcher can read.
 * The rule is `tms-shipment-actions/handler.ts`'s `assertRequiredReferences`, as
 * data: a blank value is not a value, and a code needing two needs two. The list is
 * the customer's, or the org's when the customer has none — the same fallback the
 * order form reads (`useShipmentContext.ts`).
 */
export function missingRequiredReferences(
  customer: Pick<CustomerRecord, 'requiredReferences'> | null | undefined,
  settings: Pick<TmsSettings, 'defaultRequiredReferences'> | null | undefined,
  references: readonly OrderReference[] | null | undefined,
): string[] {
  const supplied = references ?? []
  const missing: string[] = []
  const required: RequiredReference[] =
    customer?.requiredReferences ?? settings?.defaultRequiredReferences ?? []
  for (const req of required) {
    const code = typeof req?.code === 'string' ? req.code : ''
    if (!code) continue
    const need = typeof req.countOnNewOrder === 'number' ? req.countOnNewOrder : 0
    if (need <= 0) continue
    const have = supplied.filter(
      (ref) => ref.code === code && typeof ref.value === 'string' && ref.value.trim().length > 0,
    ).length
    if (have < need) missing.push(typeof req.label === 'string' && req.label.trim() ? req.label.trim() : code)
  }
  return missing
}

/** `$1,234.56` — display only; the arithmetic above it is all integer cents. */
export function formatCents(cents: number): string {
  const negative = cents < 0
  const abs = Math.abs(Math.trunc(cents))
  const dollars = Math.floor(abs / 100)
  const remainder = abs - dollars * 100
  const grouped = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${negative ? '-' : ''}$${grouped}.${String(remainder).padStart(2, '0')}`
}

export interface InvoiceReadinessInput {
  order: Pick<OrderRecord, 'id' | 'arStatus' | 'revenueCents' | 'references'>
  shipment: Pick<ShipmentRecord, 'number' | 'status' | 'deletedAt' | 'voidedAt'> | null | undefined
  customer: Pick<CustomerRecord, 'requiredReferences' | 'factored' | 'name'> | null | undefined
  settings: Pick<TmsSettings, 'defaultRequiredReferences' | 'factorRemitTo'> | null | undefined
  charges: readonly LoadChargeRecord[]
  gate: Pick<DocGateResult, 'missing'> | null | undefined
}

export interface InvoiceReadiness {
  ready: boolean
  reasons: string[]
}

/**
 * Every reason this order cannot be billed, each a sentence somebody can act on.
 * Nothing short-circuits: a dispatcher who is told about the missing POD and then
 * about the missing PO on the next attempt has been made to work twice.
 */
export function invoiceReadiness(input: InvoiceReadinessInput): InvoiceReadiness {
  const { order, shipment, customer, settings, charges, gate } = input
  const reasons: string[] = []

  if (order.arStatus !== 'UNBILLED') {
    const status = order.arStatus ?? 'not set'
    reasons.push(`This order's AR status is ${status}; only an UNBILLED order can be invoiced.`)
  }

  const shipmentName = shipment?.number ? `Shipment ${shipment.number}` : 'This shipment'
  if (isShipmentVoided(shipment)) {
    reasons.push(`${shipmentName} is voided and cannot be invoiced.`)
  } else if (shipment?.status === 'CANCELED') {
    reasons.push(`${shipmentName} is canceled; it cannot be invoiced.`)
  }

  const revenueCents = typeof order.revenueCents === 'number' ? order.revenueCents : 0
  if (!(revenueCents > 0)) {
    reasons.push('This order has no revenue to bill; add the customer charges first.')
  }

  const { subtotalCents } = invoiceLinesFor(charges, order.id)
  if (subtotalCents !== revenueCents) {
    reasons.push(
      `The customer charge lines total ${formatCents(subtotalCents)} but the order's revenue is ${formatCents(revenueCents)}; recalculate the charges.`,
    )
  }

  for (const label of missingRequiredReferences(customer, settings, order.references)) {
    reasons.push(`${label} is a required reference and this order does not have one.`)
  }

  // The document gate itself is enforced by `evaluateReleaseGate` in the routers;
  // this repeats what it would refuse so the preview lists it with the rest. There
  // is no override: step R took the admin bypass out of every path.
  const missingDocs = gate?.missing ?? []
  if (missingDocs.length > 0) {
    const labels = missingDocs.map((type) => DOCUMENT_TYPE_LABELS[type] ?? type).join(', ')
    reasons.push(`Required documents are missing: ${labels}. Attach them before invoicing.`)
  }

  // A factored customer's bill has to tell them to pay the factor. With no factor
  // remit-to configured it would print our own address, and the customer would pay
  // money the factor has already advanced into the wrong account.
  if (customer?.factored === true && !trimmed(settings?.factorRemitTo?.name)) {
    reasons.push(
      `${customer.name ?? 'This customer'} is factored, but no factor remit-to is set up in AR settings; the invoice would tell them to pay us.`,
    )
  }

  return { ready: reasons.length === 0, reasons }
}

function trimmed(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text || null
}

/**
 * Where this invoice says to pay. A factored customer pays the factor — and only on
 * `factored === true`: null means nobody has decided, and money does not go to a
 * factor on a maybe.
 */
export function remitToFor(
  division: Pick<Division, 'name' | 'legalName' | 'remitToName' | 'remitToAddress' | 'remitToEmail'> | null | undefined,
  customer: Pick<CustomerRecord, 'factored'> | null | undefined,
  settings: Pick<TmsSettings, 'factorRemitTo'> | null | undefined,
): RemitTo {
  const factor = settings?.factorRemitTo
  if (customer?.factored === true && factor && trimmed(factor.name)) {
    return {
      name: factor.name.trim(),
      address: factor.address ?? null,
      email: trimmed(factor.email),
      noticeText: trimmed(factor.noticeText),
    }
  }
  return {
    name: trimmed(division?.remitToName) ?? trimmed(division?.legalName) ?? trimmed(division?.name) ?? '',
    address: division?.remitToAddress ?? null,
    email: trimmed(division?.remitToEmail),
    noticeText: null,
  }
}

function emailOf(value: string | null | undefined): string | null {
  const email = trimmed(value)
  return email && email.includes('@') ? email.toLowerCase() : null
}

function dedupe(emails: readonly (string | null)[]): string[] {
  const out: string[] = []
  for (const email of emails) {
    if (email && !out.includes(email)) out.push(email)
  }
  return out
}

/**
 * Who the invoice is addressed to. A bill-to with its own billing people is billed
 * through them; otherwise the customer's unassigned billing contacts; otherwise the
 * one address on the customer record. An empty list is a real answer — it means
 * nobody has told us where to send the bill.
 */
export function billingRecipients(
  customer: Pick<CustomerRecord, 'contacts' | 'billingEmail'> | null | undefined,
  billToId: string | null | undefined,
): string[] {
  const contacts = customer?.contacts ?? []
  const billing = contacts.filter((contact) => contact.active !== false && contact.types.includes('BILLING'))

  if (billToId) {
    const assigned = dedupe(billing.filter((c) => c.billToId === billToId).map((c) => emailOf(c.email)))
    if (assigned.length > 0) return assigned
  }

  const unassigned = dedupe(billing.filter((c) => !c.billToId).map((c) => emailOf(c.email)))
  if (unassigned.length > 0) return unassigned

  return dedupe([emailOf(customer?.billingEmail)])
}

/** Everyone who asked to hear that an invoice went out. The caller subtracts the To list. */
export function invoiceCcRecipients(
  customer: Pick<CustomerRecord, 'contacts'> | null | undefined,
): string[] {
  const contacts = customer?.contacts ?? []
  return dedupe(
    contacts
      .filter((contact) => contact.active !== false && (contact.notifications ?? []).includes('INVOICE_SENT'))
      .map((contact) => emailOf(contact.email)),
  )
}

/**
 * Which documents an invoice goes out with by default: the paperwork the customer
 * requires to pay, plus whatever the org always attaches. Only rows this customer
 * may actually receive — `canEmailTo` keeps PENDING, REJECTED, VOID and INTERNAL
 * files off the e-mail.
 */
export function defaultInvoiceAttachments(
  documents: readonly ShipmentDocumentRecord[],
  order: Pick<OrderRecord, 'id'> & { loadIds?: readonly string[] | null },
  customer: Pick<CustomerRecord, 'requiredDocsForInvoice'> | null | undefined,
  settings: Pick<TmsSettings, 'defaultRequiredDocs' | 'invoiceAttachTypes'> | null | undefined,
): string[] {
  const wanted = new Set(requiredDocTypesFor(customer, settings).types)
  const always = normalizeRequiredDocTypes(settings?.invoiceAttachTypes ?? DEFAULT_INVOICE_ATTACH_TYPES)
  for (const type of always.types) wanted.add(type)

  const loadIds = new Set(order.loadIds ?? [])
  const ids: string[] = []
  for (const doc of documents) {
    if (!wanted.has(doc.type)) continue
    if (!canEmailTo(doc, 'CUSTOMER')) continue
    const onOrder = doc.orderId === order.id
    const onLoad = doc.loadId != null && loadIds.has(doc.loadId)
    if (!onOrder && !onLoad) continue
    if (!ids.includes(doc.id)) ids.push(doc.id)
  }
  return ids
}

export interface InvoiceStop {
  kind: 'PICKUP' | 'DELIVERY'
  name?: string | null
  city?: string | null
  state?: string | null
  /** ISO UTC, as the stop stored it — the renderer decides how a date looks. */
  apptAt?: string | null
}

export interface InvoiceBroker {
  name: string
  legalName?: string | null
  mcNumber?: string | null
  dotNumber?: string | null
  address?: Address | null
  email?: string | null
}

/**
 * Everything the invoice PDF prints, and nothing else.
 *
 * There is no cost, no carrier pay, no margin and no INTERNAL reference on this type
 * by construction: `invoiceData` only ever reads the CUSTOMER side, and the renderer
 * cannot print a field it was never given.
 */
export interface InvoiceInput {
  broker: InvoiceBroker
  remitTo: RemitTo
  billTo: InvoiceBillTo
  number: string
  /** YYYY-MM-DD. */
  invoiceDate: string
  /** YYYY-MM-DD. */
  dueAt: string
  termsDays: number
  customerName?: string | null
  shipmentNumber?: string | null
  /** First pickup through last delivery. */
  stops: InvoiceStop[]
  /** CUSTOMER and ALL visibility only. */
  references: OrderReference[]
  lines: InvoiceLine[]
  subtotalCents: number
  totalCents: number
  factored: boolean
  /** The factor's assignment notice, when one applies. */
  factorNoticeText?: string | null
  termsText?: string | null
}

export interface InvoiceDataInput {
  invoice: Pick<
    InvoiceRecord,
    | 'number'
    | 'orderId'
    | 'invoiceDate'
    | 'dueAt'
    | 'termsDays'
    | 'termsText'
    | 'shipmentNumber'
    | 'customerName'
    | 'billTo'
    | 'remitTo'
    | 'lines'
    | 'references'
    | 'subtotalCents'
    | 'totalCents'
    | 'factored'
  >
  bundle: {
    shipment?: Pick<ShipmentRecord, 'number'> | null
    loads?: readonly Pick<ShipmentLoad, 'id' | 'orderId' | 'stops'>[] | null
  }
  customer?: Pick<CustomerRecord, 'name' | 'factored' | 'billingAddress' | 'billingEmail'> | null
  division?: Pick<Division, 'name' | 'legalName' | 'mcNumber' | 'dotNumber' | 'remitToName' | 'remitToAddress' | 'remitToEmail'> | null
  settings?: Pick<TmsSettings, 'factorRemitTo' | 'invoiceTerms'> | null
}

function cityStateOf(stop: Pick<Stop, 'city' | 'address'>): { city: string | null; state: string | null } {
  const city = trimmed(stop.address?.city)
  const state = trimmed(stop.address?.state)
  if (city || state) return { city, state }
  const combined = trimmed(stop.city)
  if (!combined) return { city: null, state: null }
  const [left, right] = combined.split(',')
  return { city: trimmed(left), state: trimmed(right) }
}

/**
 * The route as the bill states it: the first pickup through the last delivery, in
 * sequence. The legs between are the carrier's problem, not the customer's, so a
 * relay prints as one origin and one destination.
 */
function invoiceStops(input: InvoiceDataInput): InvoiceStop[] {
  const loads = (input.bundle.loads ?? []).filter(
    (load) => load.orderId == null || load.orderId === input.invoice.orderId,
  )
  const stops: Stop[] = []
  for (const load of loads) {
    for (const stop of load.stops ?? []) stops.push(stop)
  }
  stops.sort((a, b) => a.sequence - b.sequence)

  const first = stops.findIndex((stop) => stop.type === 'pickup')
  let last = -1
  for (let i = stops.length - 1; i >= 0; i -= 1) {
    if (stops[i].type === 'delivery') { last = i; break }
  }
  if (first < 0 || last < first) return []

  return stops.slice(first, last + 1).map((stop) => {
    const { city, state } = cityStateOf(stop)
    return {
      kind: stop.type === 'pickup' ? ('PICKUP' as const) : ('DELIVERY' as const),
      name: trimmed(stop.name),
      city,
      state,
      apptAt: trimmed(stop.appt),
    }
  })
}

/**
 * The render input for one issued invoice. Everything printable comes from the
 * invoice snapshot where there is one, so re-rendering a six-month-old PDF produces
 * the bill that was sent and not the order as it looks today.
 */
export function invoiceData(input: InvoiceDataInput): InvoiceInput {
  const { invoice, customer, division, settings } = input
  const factored = invoice.factored === true || customer?.factored === true
  const remitTo = invoice.remitTo ?? remitToFor(division, customer, settings)
  const billTo: InvoiceBillTo = invoice.billTo ?? {
    name: trimmed(customer?.name) ?? trimmed(invoice.customerName) ?? '',
    address: customer?.billingAddress ?? null,
    email: trimmed(customer?.billingEmail),
  }
  // The snapshot wins: a later edit to the org's terms must not change what a bill
  // already sent says it was issued on.
  const termsText = trimmed(invoice.termsText) ?? trimmed(settings?.invoiceTerms) ?? `Net ${invoice.termsDays}`

  return {
    broker: {
      name: trimmed(division?.name) ?? trimmed(division?.legalName) ?? '',
      legalName: trimmed(division?.legalName),
      mcNumber: trimmed(division?.mcNumber),
      dotNumber: trimmed(division?.dotNumber),
      address: division?.remitToAddress ?? null,
      email: trimmed(division?.remitToEmail),
    },
    remitTo,
    billTo,
    number: invoice.number,
    invoiceDate: invoice.invoiceDate,
    dueAt: invoice.dueAt,
    termsDays: invoice.termsDays,
    customerName: trimmed(invoice.customerName) ?? trimmed(customer?.name),
    shipmentNumber: trimmed(invoice.shipmentNumber) ?? trimmed(input.bundle.shipment?.number),
    stops: invoiceStops(input),
    // INTERNAL and CARRIER notes never reach a page the customer sees.
    references: (invoice.references ?? []).filter(
      (ref) => ref.visibility === 'CUSTOMER' || ref.visibility === 'ALL',
    ),
    lines: invoice.lines ?? [],
    subtotalCents: invoice.subtotalCents,
    totalCents: invoice.totalCents,
    factored,
    factorNoticeText: factored ? trimmed(remitTo.noticeText) : null,
    termsText,
  }
}
