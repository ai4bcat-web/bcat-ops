/**
 * Delivery and milestone notices: who hears about a shipment moving, and what the
 * message actually says.
 *
 * Three rules shape this file:
 *
 * 1. **A notice is a row before it is an e-mail.** Every send writes a
 *    `ShipmentNotice` carrying the rendered subject and body, then tries SES and
 *    records what happened. On a stack where SES is denied the row still exists
 *    and can be copied out by hand, which is an honest outcome rather than a lie
 *    about a message nobody received.
 * 2. **Nothing goes out until somebody is switched on.** A customer only receives
 *    milestone e-mails when `visibilityPrefs.milestoneEmails` is true *and* a
 *    contact subscribed to that milestone. An empty recipient list is not an
 *    error; it is the normal state of a customer nobody has configured.
 * 3. **A milestone notice is customer-facing.** It carries no money, no margin, no
 *    internal reference and no carrier name unless the tracking link already shows
 *    the carrier.
 *
 * Imports are relative and type-only where they can be: the tracking and notifier
 * Lambdas bundle this file by path, so a `@/` alias would break the function build.
 */
import type {
  CustomerContact,
  CustomerNotification,
  CustomerRecord,
  InvoiceRecord,
  LoadWorkflowStatus,
  OrderReference,
  ShipmentDocumentType,
  ShipmentNoticeKind,
} from '../types/tms'
import { DOCUMENT_TYPE_LABELS } from './shipmentDocuments'
import { formatCents } from './tmsDirectory'

/**
 * Which load status transitions are worth telling a customer about. SOURCING,
 * BOOKED, PLANNED and DISPATCHED are our problem, not theirs; INVOICING and
 * CANCELED have their own conversations.
 */
export const MILESTONE_BY_LOAD_STATUS: Partial<Record<LoadWorkflowStatus, CustomerNotification>> = {
  LOADING: 'LOADING',
  PICKED_UP: 'PICKED_UP',
  IN_TRANSIT: 'IN_TRANSIT',
  OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  UNLOADING: 'UNLOADING',
  DELIVERED: 'DELIVERED',
}

export const MILESTONE_LABELS: Record<CustomerNotification, string> = {
  APPT_SCHEDULED: 'Appointment scheduled',
  LOADING: 'Loading',
  PICKED_UP: 'Picked up',
  IN_TRANSIT: 'In transit',
  OUT_FOR_DELIVERY: 'Out for delivery',
  UNLOADING: 'Unloading',
  DELIVERED: 'Delivered',
  INVOICE_SENT: 'Invoice sent',
}

export const DEFAULT_MILESTONE_TEMPLATE =
  'Shipment {number} is now {milestone}.\n\nTrack it here: {url}'

export const DEFAULT_POD_REQUEST_TEMPLATE =
  'Load {loadNumber} has delivered. Please send the paperwork listed below.\n\nUpload here: {url}'

/** The covering note for one issued invoice. Must carry `{number}`. */
export const DEFAULT_INVOICE_EMAIL_TEMPLATE =
  'Invoice {number} for shipment {shipment} is attached.'

/** The covering note when one customer is sent several invoices at once. */
export const DEFAULT_INVOICE_BATCH_TEMPLATE =
  'Please find {invoices} attached — {total} due in total.'

export const MAX_NOTICE_BODY_CHARS = 20000

/**
 * Who should hear about this milestone. Empty when the customer has not been
 * switched on, when nobody subscribed, or when every subscriber is inactive or has
 * no e-mail address.
 */
export function milestoneRecipients(
  customer: Pick<CustomerRecord, 'contacts' | 'visibilityPrefs'> | null | undefined,
  milestone: CustomerNotification,
): CustomerContact[] {
  if (!customer?.visibilityPrefs?.milestoneEmails) return []
  const contacts = customer.contacts ?? []
  return contacts.filter(
    (contact) =>
      contact.active !== false &&
      typeof contact.email === 'string' &&
      contact.email.includes('@') &&
      (contact.notifications ?? []).includes(milestone),
  )
}

/** The deterministic ids that make a stream retry or a second leg send nothing twice. */
export function noticeId(kind: ShipmentNoticeKind, scopeId: string, milestone?: CustomerNotification): string {
  if (kind === 'MILESTONE') return `ms:${scopeId}:${milestone ?? 'UNKNOWN'}`
  if (kind === 'POD_REQUEST') return `pod:${scopeId}`
  return `ntc-${scopeId}`
}

export interface NoticeStop {
  type: string
  name?: string | null
  city?: string | null
  state?: string | null
  appt?: string | null
  arrivedAt?: string | null
  departedAt?: string | null
}

function placeOf(stop: NoticeStop): string {
  const city = [stop.city, stop.state].filter(Boolean).join(', ')
  if (stop.name && city) return `${stop.name} — ${city}`
  return stop.name ?? city ?? 'TBD'
}

function applyTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match)
}

/** A template that cannot carry the link is not a template we can send. */
export function templateHasUrl(template: string | null | undefined): boolean {
  return typeof template === 'string' && template.includes('{url}')
}

/** An invoice e-mail that cannot name the invoice is not one we can send. */
export function templateHasNumber(template: string | null | undefined): boolean {
  return typeof template === 'string' && template.includes('{number}')
}

export interface MilestoneEmailInput {
  milestone: CustomerNotification
  shipmentNumber: string
  customerName?: string | null
  contactName?: string | null
  stops: NoticeStop[]
  /** Customer-visible references only; the caller filters by visibility. */
  references?: Pick<OrderReference, 'code' | 'label' | 'value'>[] | null
  customerLinkUrl?: string | null
  /** Only when the customer link already names the carrier. */
  carrierName?: string | null
  deliveredAt?: string | null
  template?: string | null
  brokerName: string
}

/**
 * The milestone e-mail, plain text. No money, no margin, no internal notes — the
 * shape of this function is the whole of what a customer is told.
 */
export function renderMilestoneEmail(input: MilestoneEmailInput): { subject: string; body: string } {
  const label = MILESTONE_LABELS[input.milestone] ?? input.milestone
  const subject = `${input.shipmentNumber} — ${label}`
  const url = input.customerLinkUrl ?? ''
  const template = templateHasUrl(input.template) ? (input.template as string) : DEFAULT_MILESTONE_TEMPLATE

  const lines: string[] = []
  lines.push(input.contactName ? `${input.contactName},` : 'Hello,')
  lines.push('')
  lines.push(
    applyTemplate(template, {
      number: input.shipmentNumber,
      milestone: label.toLowerCase(),
      url,
      customer: input.customerName ?? '',
    }),
  )

  const pickup = input.stops.find((stop) => stop.type === 'pickup')
  const delivery = [...input.stops].reverse().find((stop) => stop.type === 'delivery')
  if (pickup || delivery) {
    lines.push('')
    if (pickup) lines.push(`Pickup: ${placeOf(pickup)}${pickup.appt ? ` — ${pickup.appt}` : ''}`)
    if (delivery) lines.push(`Delivery: ${placeOf(delivery)}${delivery.appt ? ` — ${delivery.appt}` : ''}`)
  }

  if (input.milestone === 'DELIVERED' && input.deliveredAt) {
    lines.push('')
    lines.push(`Delivered ${input.deliveredAt}.`)
  }

  const references = input.references ?? []
  if (references.length > 0) {
    lines.push('')
    for (const reference of references) {
      lines.push(`${reference.label ?? reference.code}: ${reference.value}`)
    }
  }

  if (input.carrierName) {
    lines.push('')
    lines.push(`Carrier: ${input.carrierName}`)
  }

  lines.push('')
  lines.push(input.brokerName)

  return { subject, body: lines.join('\n').slice(0, MAX_NOTICE_BODY_CHARS) }
}

export interface PodRequestEmailInput {
  loadNumber: string
  carrierName?: string | null
  contactName?: string | null
  stops: NoticeStop[]
  needed: ShipmentDocumentType[]
  uploadUrl: string
  expiresAt: string
  template?: string | null
  brokerName: string
  message?: string | null
}

/** What we ask a carrier for once their load has delivered. */
export function renderPodRequestEmail(input: PodRequestEmailInput): { subject: string; body: string } {
  const subject = `Paperwork needed — load ${input.loadNumber}`
  const template = templateHasUrl(input.template) ? (input.template as string) : DEFAULT_POD_REQUEST_TEMPLATE

  const lines: string[] = []
  lines.push(input.contactName ? `${input.contactName},` : 'Hello,')
  lines.push('')
  lines.push(
    applyTemplate(template, {
      loadNumber: input.loadNumber,
      carrier: input.carrierName ?? '',
      url: input.uploadUrl,
    }),
  )

  if (input.message) {
    lines.push('')
    lines.push(input.message)
  }

  if (input.needed.length > 0) {
    lines.push('')
    lines.push('We still need:')
    for (const type of input.needed) lines.push(`  • ${DOCUMENT_TYPE_LABELS[type] ?? type}`)
  }

  const delivery = [...input.stops].reverse().find((stop) => stop.type === 'delivery')
  if (delivery) {
    lines.push('')
    lines.push(`Delivery: ${placeOf(delivery)}`)
  }

  lines.push('')
  lines.push(`This upload link stops working on ${input.expiresAt}.`)
  lines.push('')
  lines.push(input.brokerName)

  return { subject, body: lines.join('\n').slice(0, MAX_NOTICE_BODY_CHARS) }
}

export interface DocumentsEmailInput {
  shipmentNumber: string
  documents: { name: string; type: ShipmentDocumentType }[]
  message?: string | null
  subject?: string | null
  senderName: string
  brokerName: string
}

/** The covering note when staff send documents out of the Documents tab. */
export function renderDocumentsEmail(input: DocumentsEmailInput): { subject: string; body: string } {
  const subject = input.subject?.trim() || `Documents — shipment ${input.shipmentNumber}`

  const lines: string[] = []
  lines.push('Hello,')
  lines.push('')
  lines.push(input.message?.trim() || `Attached are the documents for shipment ${input.shipmentNumber}.`)
  if (input.documents.length > 0) {
    lines.push('')
    for (const doc of input.documents) {
      lines.push(`  • ${DOCUMENT_TYPE_LABELS[doc.type] ?? doc.type} — ${doc.name}`)
    }
  }
  lines.push('')
  lines.push(input.senderName)
  lines.push(input.brokerName)

  return { subject, body: lines.join('\n').slice(0, MAX_NOTICE_BODY_CHARS) }
}

/** What an invoice e-mail has to say about each bill it carries. */
export type InvoiceEmailInvoice = Pick<
  InvoiceRecord,
  'number' | 'shipmentNumber' | 'dueAt' | 'totalCents' | 'balanceCents'
>

export interface InvoiceEmailInput {
  invoice: InvoiceEmailInvoice
  customerName?: string | null
  contactName?: string | null
  template?: string | null
  brokerName: string
}

/**
 * The covering note for one invoice. The PDF is the bill, so the body stays short —
 * but the balance and the due date are stated here whatever the template says,
 * because a customer should never have to open an attachment to learn what is owed.
 *
 * `{total}` is the invoice total; the stated amount due is the balance, which is
 * the same number until a payment has been applied.
 */
export function renderInvoiceEmail(input: InvoiceEmailInput): { subject: string; body: string } {
  const invoice = input.invoice
  const subject = `Invoice ${invoice.number} · ${input.brokerName}`
  const template = templateHasNumber(input.template)
    ? (input.template as string)
    : DEFAULT_INVOICE_EMAIL_TEMPLATE

  const lines: string[] = []
  lines.push(input.contactName ? `${input.contactName},` : 'Hello,')
  lines.push('')
  lines.push(
    applyTemplate(template, {
      number: invoice.number,
      customer: input.customerName ?? '',
      contact: input.contactName ?? '',
      total: `$${formatCents(invoice.totalCents)}`,
      due: invoice.dueAt,
      shipment: invoice.shipmentNumber ?? '',
      broker: input.brokerName,
    }),
  )

  lines.push('')
  lines.push(`Amount due: $${formatCents(invoice.balanceCents)}`)
  lines.push(`Due ${invoice.dueAt}.`)
  lines.push('')
  lines.push(input.brokerName)

  return { subject, body: lines.join('\n').slice(0, MAX_NOTICE_BODY_CHARS) }
}

export interface InvoiceBatchEmailInput {
  customerName?: string | null
  contactName?: string | null
  template?: string | null
  brokerName: string
}

/**
 * One e-mail for several invoices of the same customer and bill-to — the
 * PER_BILL_TO half of a batch run.
 *
 * Every invoice is listed, so nothing is sent that the body does not name. The
 * total is what is still owed across the batch, not what was originally billed.
 * `{number}` joins the numbers, so the per-invoice template a stack has already
 * configured still reads correctly here.
 */
export function renderInvoiceBatchEmail(
  invoices: InvoiceEmailInvoice[],
  input: InvoiceBatchEmailInput,
): { subject: string; body: string } {
  const totalCents = invoices.reduce((sum, invoice) => sum + invoice.balanceCents, 0)
  const total = `$${formatCents(totalCents)}`
  const counted = `${invoices.length} ${invoices.length === 1 ? 'invoice' : 'invoices'}`
  const subject = `${counted} · ${total} · ${input.brokerName}`
  const template = input.template?.trim() || DEFAULT_INVOICE_BATCH_TEMPLATE

  const lines: string[] = []
  lines.push(input.contactName ? `${input.contactName},` : 'Hello,')
  lines.push('')
  lines.push(
    applyTemplate(template, {
      count: String(invoices.length),
      invoices: counted,
      number: invoices.map((invoice) => invoice.number).join(', '),
      customer: input.customerName ?? '',
      contact: input.contactName ?? '',
      total,
      broker: input.brokerName,
    }),
  )

  if (invoices.length > 0) {
    lines.push('')
    for (const invoice of invoices) {
      const parts = [invoice.number]
      if (invoice.shipmentNumber) parts.push(`shipment ${invoice.shipmentNumber}`)
      parts.push(`due ${invoice.dueAt}`)
      parts.push(`$${formatCents(invoice.balanceCents)}`)
      lines.push(`  • ${parts.join(' — ')}`)
    }
  }

  lines.push('')
  lines.push(`Total due: ${total}`)
  lines.push('')
  lines.push(input.brokerName)

  return { subject, body: lines.join('\n').slice(0, MAX_NOTICE_BODY_CHARS) }
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * When a carrier's upload link stops working: `days` after delivery, but never less
 * than a day from now — a link minted for a load that delivered three weeks ago
 * still has to be usable by the person reading the e-mail it arrived in.
 */
export function uploadLinkExpiry(
  deliveredAtIso: string | null | undefined,
  days: number,
  nowIso: string,
): string {
  const now = new Date(nowIso).getTime()
  const base = deliveredAtIso ? new Date(deliveredAtIso).getTime() : now
  const anchor = Number.isFinite(base) ? base : now
  const floor = now + DAY_MS
  return new Date(Math.max(anchor + days * DAY_MS, floor)).toISOString()
}
