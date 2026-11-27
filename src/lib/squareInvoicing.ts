/**
 * Auto shipper → Square invoicing (Ryne 2026-11-27).
 *
 * An auto-shipping shipment is invoiced through Square, not the standard template. The payer is a
 * different person or company on every shipment ("AUTO SHIPPER" is only the customer record the freight
 * sits under), so the shipment carries the payer, the vehicle and the Square ids itself in
 * `Shipment.carShipping`. This file is the pure half: validation of what the create form collects, the
 * request bodies sent to Square, and the status mapping. No network, no node:, no alias imports: the
 * finance Lambda bundles it by relative import and the browser imports it for the form.
 *
 * Nothing in a Square request may carry carrier pay, cost, margin or a rate confirmation. The bodies
 * below are built only from the payer, the price, the pickup date, the vehicle and the route, and
 * `squareBodyLeaks` is the guard a test (and the Lambda, before it sends) runs over every body.
 */

/** `Customer.invoiceChannel` value that routes a customer's shipments to Square. */
export const SQUARE_CHANNEL = 'SQUARE'

export function isSquareChannel(customer: { invoiceChannel?: string | null } | null | undefined): boolean {
  return customer?.invoiceChannel === SQUARE_CHANNEL
}

/** The one line item on every Square invoice (matches the invoice Ryne sends by hand today). */
export const SQUARE_LINE_TITLE = 'auto transport'

export type SquareEnvironment = 'SANDBOX' | 'PRODUCTION'

export function squareBaseUrl(environment: SquareEnvironment): string {
  return environment === 'PRODUCTION' ? 'https://connect.squareup.com' : 'https://connect.squareupsandbox.com'
}

/** Pinned so a Square API change never alters a request body under us. */
export const SQUARE_API_VERSION = '2024-10-17'

// ── What the shipment carries ───────────────────────────────────────────────

export interface CarShippingPayer {
  /** The person billed. For a company, the contact's name goes here and the company below. */
  name: string
  company?: string | null
  email: string
  phone: string
}

export interface CarShippingVehicle {
  year: string
  make: string
  model: string
  vin?: string | null
}

export type SquareInvoiceStatus =
  | 'DRAFT'
  | 'UNPAID'
  | 'SCHEDULED'
  | 'PARTIALLY_PAID'
  | 'PAID'
  | 'PARTIALLY_REFUNDED'
  | 'REFUNDED'
  | 'CANCELED'
  | 'FAILED'
  | 'PAYMENT_PENDING'

/** Where the Square side of this shipment stands. Each id is written the moment Square returns it, so a retry resumes. */
export interface CarShippingSquare {
  environment?: SquareEnvironment
  customerId?: string | null
  orderId?: string | null
  invoiceId?: string | null
  invoiceVersion?: number | null
  /** What Square last said. Absent until the draft exists. */
  status?: SquareInvoiceStatus | null
  publicUrl?: string | null
  /** The BCAT invoice written when the Square invoice was published. */
  bcatInvoiceId?: string | null
  /** The amount (cents) the draft was built for, so a price change is noticed. */
  amountCents?: number | null
  /** `<PRO>` or `<PRO>-2` after a reissue. */
  invoiceNumber?: string | null
  reissue?: number | null
  /** Bumped whenever the Square objects are rebuilt (a draft at a new price, a reissue) so each build gets fresh idempotency keys. */
  gen?: number | null
  lastSyncAt?: string | null
  lastEventId?: string | null
  lastError?: string | null
  lastErrorAt?: string | null
  /** A refund or a failed payment needs a person; set by the sync, cleared by a person. */
  reviewFlag?: string | null
}

export interface CarShippingData {
  payer: CarShippingPayer
  vehicle: CarShippingVehicle
  square?: CarShippingSquare
}

// ── Validation ──────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

export function digitsOnly(value: string): string {
  return value.replace(/\D/g, '')
}

/** A US-style phone Square will take: 10 digits, or 11 with a leading 1. Returns E.164 or null. */
export function phoneToE164(value: string): string | null {
  const digits = digitsOnly(value)
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return null
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

export type CarShippingResult = { ok: true; value: CarShippingData } | { ok: false; error: string }

/**
 * The six things Ryne collects (name, email, phone, vehicle, addresses, price) minus the two the shipment
 * already holds (stops and rate): the payer and the vehicle. Used by the form before it saves and by the
 * Lambda before it writes, so the two can never disagree.
 */
export function normalizeCarShipping(input: unknown): CarShippingResult {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Auto shipper details are missing' }
  const raw = input as Record<string, unknown>
  const payerIn = (raw.payer ?? {}) as Record<string, unknown>
  const vehicleIn = (raw.vehicle ?? {}) as Record<string, unknown>

  const name = text(payerIn.name, 120)
  if (!name) return { ok: false, error: 'The payer needs a name' }
  const email = text(payerIn.email, 254).toLowerCase()
  if (!EMAIL_RE.test(email)) return { ok: false, error: 'The payer needs a valid e-mail address' }
  const phone = text(payerIn.phone, 40)
  if (!phoneToE164(phone)) return { ok: false, error: 'The payer needs a 10-digit phone number' }

  const year = text(vehicleIn.year, 4)
  const thisYear = new Date().getUTCFullYear()
  if (!/^\d{4}$/.test(year) || Number(year) < 1900 || Number(year) > thisYear + 2) {
    return { ok: false, error: 'The vehicle needs a 4-digit year' }
  }
  const make = text(vehicleIn.make, 60)
  if (!make) return { ok: false, error: 'The vehicle needs a make' }
  const model = text(vehicleIn.model, 60)
  if (!model) return { ok: false, error: 'The vehicle needs a model' }

  const company = text(payerIn.company, 120)
  const vin = text(vehicleIn.vin, 17).toUpperCase()
  return {
    ok: true,
    value: {
      payer: { name, ...(company ? { company } : {}), email, phone },
      vehicle: { year, make, model, ...(vin ? { vin } : {}) },
    },
  }
}

/** Merge what a form collected with what Square already holds for the shipment (the form never writes `square`). */
export function withSquareState(data: CarShippingData, square: CarShippingSquare | undefined): CarShippingData {
  return square ? { ...data, square } : data
}

// ── Square request bodies ───────────────────────────────────────────────────

export interface RouteEnds {
  /** "Chicago, IL" */
  pickup: string
  /** "Newton, IA" */
  delivery: string
}

/** "2018 Honda Civic · Chicago, IL → Newton, IA": the vehicle and the route go in the invoice description (Ryne 2026-11-27). */
export function invoiceDescription(vehicle: CarShippingVehicle, route: RouteEnds): string {
  const car = [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ')
  const path = [route.pickup, route.delivery].filter(Boolean).join(' → ')
  return [car, path].filter(Boolean).join(' · ').slice(0, 500)
}

/** `<PRO>` for the first invoice, `<PRO>-2` after a cancel and reissue (matches the BCAT invoice suffix rule). */
export function squareInvoiceNumber(pro: string, reissue: number | null | undefined): string {
  const n = reissue ?? 0
  return n > 0 ? `${pro}-${n + 1}` : pro
}

/** Idempotency keys derive from the shipment and the step, so a retried click can never make a second object. */
export function idempotencyKey(shipmentId: string, step: 'cust' | 'order' | 'inv' | 'pub' | 'cancel', gen = 0): string {
  return `${shipmentId}:${step}:${gen}`.slice(0, 192)
}

const MONEY_CURRENCY = 'USD'

export function squareCustomerBody(payer: CarShippingPayer, shipmentId: string, pro: string) {
  const parts = payer.name.trim().split(/\s+/)
  const given = parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0]
  const family = parts.length > 1 ? parts[parts.length - 1] : undefined
  return {
    idempotency_key: idempotencyKey(shipmentId, 'cust'),
    given_name: given,
    ...(family ? { family_name: family } : {}),
    ...(payer.company ? { company_name: payer.company } : {}),
    email_address: payer.email,
    phone_number: phoneToE164(payer.phone) ?? payer.phone,
    reference_id: pro.slice(0, 40),
  }
}

export function squareOrderBody(args: {
  locationId: string
  customerId: string
  pro: string
  shipmentId: string
  amountCents: number
  description: string
  /** The build generation (see `CarShippingSquare.gen`). */
  gen?: number
}) {
  return {
    idempotency_key: idempotencyKey(args.shipmentId, 'order', args.gen ?? 0),
    order: {
      location_id: args.locationId,
      customer_id: args.customerId,
      reference_id: args.pro.slice(0, 40),
      line_items: [
        {
          name: SQUARE_LINE_TITLE,
          quantity: '1',
          note: args.description,
          base_price_money: { amount: args.amountCents, currency: MONEY_CURRENCY },
        },
      ],
    },
  }
}

export interface AcceptedMethods {
  bankTransfer?: boolean
  cashApp?: boolean
}

export function squareInvoiceBody(args: {
  locationId: string
  orderId: string
  customerId: string
  invoiceNumber: string
  shipmentId: string
  /** YYYY-MM-DD: the pickup date. */
  serviceDate: string | null
  /** YYYY-MM-DD: the issue date, so the invoice is due on receipt. */
  dueDate: string
  description: string
  methods?: AcceptedMethods
  gen?: number
}) {
  return {
    idempotency_key: idempotencyKey(args.shipmentId, 'inv', args.gen ?? 0),
    invoice: {
      location_id: args.locationId,
      order_id: args.orderId,
      primary_recipient: { customer_id: args.customerId },
      invoice_number: args.invoiceNumber,
      title: `Invoice ${args.invoiceNumber}`,
      description: args.description,
      ...(args.serviceDate ? { sale_or_service_date: args.serviceDate } : {}),
      payment_requests: [{ request_type: 'BALANCE', due_date: args.dueDate }],
      delivery_method: 'EMAIL',
      // Card is always on. Bank transfer and Cash App only when the Square account has them and the setting says so.
      accepted_payment_methods: {
        card: true,
        bank_account: args.methods?.bankTransfer === true,
        cash_app_pay: args.methods?.cashApp === true,
      },
      store_payment_method_enabled: false,
    },
  }
}

const FORBIDDEN_KEY_RE = /carrier|margin|cost|payable|vendor|rate[_ ]?con|ratecon|driver|profit/i

/**
 * Keys and text that must never appear in anything sent to Square. Returns the first offending path, or null.
 * The invoice a customer opens shows exactly what this builds; carrier pay, cost and margin are never part of it.
 */
export function squareBodyLeaks(body: unknown, path = 'body'): string | null {
  if (body == null) return null
  // Values are the payer's and the shipment's own words (a company called Costco is fine); only the keys are policed.
  if (typeof body === 'string') return null
  if (Array.isArray(body)) {
    for (let i = 0; i < body.length; i++) {
      const hit = squareBodyLeaks(body[i], `${path}[${i}]`)
      if (hit) return hit
    }
    return null
  }
  if (typeof body === 'object') {
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (FORBIDDEN_KEY_RE.test(key)) return `${path}.${key}`
      const hit = squareBodyLeaks(value, `${path}.${key}`)
      if (hit) return hit
    }
  }
  return null
}

// ── Square → BCAT status ────────────────────────────────────────────────────

export type MirrorAction =
  /** No BCAT invoice yet (a draft). */
  | 'NONE'
  /** The BCAT invoice stands as ISSUED. */
  | 'OPEN'
  | 'PARTIAL'
  | 'PAID'
  /** Void the BCAT invoice if no money has been applied. */
  | 'VOID'
  /** A person must look: a refund, a failed charge. Never auto-reversed. */
  | 'REVIEW'

export function mirrorActionFor(status: SquareInvoiceStatus | string | null | undefined): MirrorAction {
  switch (status) {
    case 'UNPAID':
    case 'SCHEDULED':
    case 'PAYMENT_PENDING':
      return 'OPEN'
    case 'PARTIALLY_PAID':
      return 'PARTIAL'
    case 'PAID':
      return 'PAID'
    case 'CANCELED':
      return 'VOID'
    case 'FAILED':
    case 'PARTIALLY_REFUNDED':
    case 'REFUNDED':
      return 'REVIEW'
    default:
      return 'NONE'
  }
}

export function squareStatusLabel(status: SquareInvoiceStatus | string | null | undefined): string {
  switch (status) {
    case 'DRAFT': return 'Square draft'
    case 'UNPAID': return 'Sent · unpaid'
    case 'SCHEDULED': return 'Scheduled'
    case 'PARTIALLY_PAID': return 'Partly paid'
    case 'PAID': return 'Paid'
    case 'PARTIALLY_REFUNDED': return 'Partly refunded'
    case 'REFUNDED': return 'Refunded'
    case 'CANCELED': return 'Canceled'
    case 'FAILED': return 'Payment failed'
    case 'PAYMENT_PENDING': return 'Payment pending'
    default: return 'Square: not created'
  }
}

/** The one-line state the shipment's Square card leads with. */
export function squareCardState(square: CarShippingSquare | null | undefined): 'NOT_CREATED' | 'DRAFT' | 'SENT' | 'PAID' | 'CANCELED' | 'REVIEW' {
  if (!square?.invoiceId) return 'NOT_CREATED'
  if (square.reviewFlag) return 'REVIEW'
  switch (square.status) {
    case 'DRAFT': return 'DRAFT'
    case 'PAID': return 'PAID'
    case 'CANCELED': return 'CANCELED'
    case 'FAILED':
    case 'PARTIALLY_REFUNDED':
    case 'REFUNDED':
      return 'REVIEW'
    default: return 'SENT'
  }
}

/** Dollars-as-cents from the form's rate field. */
export function dollarsToCents(value: number): number {
  return Math.round(value * 100)
}

/** `2026-11-27T…` → `2026-11-27`. */
export function dateOnly(iso: string | null | undefined): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso ?? '')
  return m ? m[1] : null
}
