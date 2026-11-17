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
import { invoiceEmailSubject, invoiceReferenceLine } from './invoiceIdentity'
import type {
  ApPaymentRecord,
  CarrierBillRecord,
  CarrierContactRecord,
  CarrierPaymentMethodRecord,
  CarrierRecord,
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

/**
 * The body of every invoice e-mail, word for word. The PDF is the bill; the body says where
 * remittance goes and that replies are not read. It is fixed on purpose: no per-company
 * template, balance line or greeting is added to it.
 */
export const INVOICE_EMAIL_BODY = [
  'Your report is attached to this email.',
  '',
  'Please send remittance to billing@bcatcorp.com or provide any questions and',
  'a representative will assist you.',
  '',
  'Please do not reply directly to this email.',
  '',
  'Thank you,',
  '',
  'BCAT Logistics & IVAN Cartage',
].join('\n')

/** The covering note for one issued invoice. Must carry `{number}`. Kept for the settings validator; the e-mail body is `INVOICE_EMAIL_BODY`. */
export const DEFAULT_INVOICE_EMAIL_TEMPLATE =
  'Invoice {number} for shipment {shipment} is attached.'

/** The covering note when one customer is sent several invoices at once. */
export const DEFAULT_INVOICE_BATCH_TEMPLATE =
  'Please find {invoices} attached — {total} due in total.'

/** The covering note for one AP payment. Must carry `{reference}`. */
export const DEFAULT_REMITTANCE_EMAIL_TEMPLATE =
  'Payment {reference} for {total} has been sent. The bills it covers are listed below.'

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

/**
 * A remittance that cannot name the payment is not one we can send: the reference is
 * the only thing the carrier's AP clerk can match the deposit against.
 */
export function templateHasReference(template: string | null | undefined): boolean {
  return typeof template === 'string' && template.includes('{reference}')
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
  /** The order's PO number, printed beside the PRO above the fixed body. */
  po?: string | null
  /** Who the invoice comes from: 'BCAT Logistics Corporation' or 'IVAN Cartage Co' (`invoiceCompanyName`). */
  companyName?: string | null
}

/**
 * The e-mail for one invoice: the subject names the invoice, the body is the fixed `INVOICE_EMAIL_BODY`.
 * The balance and due date live on the attached PDF, not in the message.
 */
export function renderInvoiceEmail(input: InvoiceEmailInput): { subject: string; body: string } {
  const pro = input.invoice.shipmentNumber || input.invoice.number
  return {
    subject: invoiceEmailSubject(pro, input.companyName || 'BCAT Logistics Corporation', input.po),
    // The reference line is the only thing added above Ryne's fixed wording.
    body: `${invoiceReferenceLine(pro, input.po)}\n\n${INVOICE_EMAIL_BODY}`,
  }
}

export interface InvoiceBatchEmailInput {
  customerName?: string | null
  contactName?: string | null
  template?: string | null
  brokerName: string
}

/**
 * One e-mail for several invoices of the same customer and bill-to — the
 * PER_BILL_TO half of a batch run. The subject counts them and totals what is still
 * owed; the body is the same fixed `INVOICE_EMAIL_BODY` as a single invoice.
 */
export function renderInvoiceBatchEmail(
  invoices: InvoiceEmailInvoice[],
  input: InvoiceBatchEmailInput,
): { subject: string; body: string } {
  const totalCents = invoices.reduce((sum, invoice) => sum + invoice.balanceCents, 0)
  const counted = `${invoices.length} ${invoices.length === 1 ? 'invoice' : 'invoices'}`
  return {
    subject: `${counted} · $${formatCents(totalCents)} · ${input.brokerName}`,
    body: INVOICE_EMAIL_BODY,
  }
}

/** What a remittance has to say about each bill it settles. */
export type RemittanceEmailBill = Pick<
  CarrierBillRecord,
  'id' | 'billNumber' | 'shipmentNumber' | 'loadNumber' | 'netCents'
>

export interface RemittanceEmailInput {
  payment: Pick<ApPaymentRecord, 'id' | 'reference' | 'paidAt' | 'method' | 'amountCents' | 'applications'>
  bills: RemittanceEmailBill[]
  carrierName?: string | null
  template?: string | null
  brokerName: string
}

/**
 * The covering note for one payment. It goes to the carrier or their factor, so it
 * carries the reference, the date, the amount and the bills it settles — and nothing
 * else. No customer rate, no margin, no internal note, no bank detail.
 *
 * The amount is stated whatever the template says, for the same reason the invoice
 * e-mail states the balance: nobody should have to open an attachment to learn what
 * was sent. Per-bill amounts come from the payment's own allocations where it names
 * the bill, so a part-payment reads as what was actually sent rather than as the net.
 */
export function renderRemittanceEmail(input: RemittanceEmailInput): { subject: string; body: string } {
  const payment = input.payment
  const reference = payment.reference?.trim() || payment.id
  const date = payment.paidAt.slice(0, 10)
  const total = `$${formatCents(payment.amountCents)}`
  const subject = `Remittance ${reference} · ${input.brokerName}`
  const template = templateHasReference(input.template)
    ? (input.template as string)
    : DEFAULT_REMITTANCE_EMAIL_TEMPLATE

  const appliedById: Record<string, number> = {}
  for (const application of payment.applications ?? []) {
    appliedById[application.billId] = (appliedById[application.billId] ?? 0) + application.amountCents
  }

  const lines: string[] = []
  lines.push('Hello,')
  lines.push('')
  lines.push(
    applyTemplate(template, {
      reference,
      carrier: input.carrierName ?? '',
      total,
      date,
      method: payment.method ?? '',
      count: String(input.bills.length),
      bills: `${input.bills.length} ${input.bills.length === 1 ? 'bill' : 'bills'}`,
      broker: input.brokerName,
    }),
  )

  if (input.bills.length > 0) {
    lines.push('')
    for (const bill of input.bills) {
      const parts = [bill.billNumber || bill.loadNumber || bill.shipmentNumber || bill.id]
      if (bill.shipmentNumber) parts.push(`shipment ${bill.shipmentNumber}`)
      parts.push(`$${formatCents(appliedById[bill.id] ?? bill.netCents)}`)
      lines.push(`  • ${parts.join(' — ')}`)
    }
  }

  lines.push('')
  lines.push(`Amount sent: ${total}`)
  if (payment.method) lines.push(`Method: ${payment.method}`)
  lines.push(`Sent ${date}.`)
  lines.push('')
  lines.push(input.brokerName)

  return { subject, body: lines.join('\n').slice(0, MAX_NOTICE_BODY_CHARS) }
}

/** Ryne's fixed opening line for the remittance that goes out when payments are marked paid. */
export const AUTO_REMITTANCE_INTRO = 'Please find remittance for the below shipments attached:'

export interface RemittanceTableInput {
  payment: Pick<ApPaymentRecord, 'id' | 'reference' | 'paidAt' | 'amountCents' | 'applications'>
  bills: Pick<CarrierBillRecord, 'id' | 'billNumber' | 'billDate' | 'shipmentNumber' | 'loadNumber' | 'netCents'>[]
  brokerName: string
}

export interface RemittanceTableRow {
  pro: string
  invoiceNumber: string
  invoiceDate: string
  amountCents: number
}

/** One line per bill the payment settled: PRO, the carrier's invoice number and date, and what was paid on it. */
export function remittanceTableRows(input: RemittanceTableInput): { rows: RemittanceTableRow[]; totalCents: number } {
  const byId = new Map(input.bills.map((bill) => [bill.id, bill]))
  const paid: Record<string, number> = {}
  for (const application of input.payment.applications ?? []) {
    paid[application.billId] = (paid[application.billId] ?? 0) + application.amountCents
  }
  const rows: RemittanceTableRow[] = []
  let totalCents = 0
  for (const [billId, amountCents] of Object.entries(paid)) {
    const bill = byId.get(billId)
    rows.push({
      pro: bill?.shipmentNumber || bill?.loadNumber || '',
      invoiceNumber: bill?.billNumber ?? '',
      invoiceDate: bill?.billDate ?? '',
      amountCents,
    })
    totalCents += amountCents
  }
  return { rows, totalCents }
}

function htmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * The remittance e-mail sent when a payment is marked paid: the fixed opening line, then a table of what
 * was paid. The PDF advice rides along as the attachment. Carrier-facing, so only what was paid to them:
 * no customer rate, no margin.
 */
export function renderRemittanceTableEmail(input: RemittanceTableInput): { subject: string; body: string; html: string } {
  const { rows, totalCents } = remittanceTableRows(input)
  const reference = input.payment.reference?.trim() || input.payment.id
  const subject = `Remittance ${reference} · ${input.brokerName}`
  const money = (cents: number) => `$${formatCents(cents)}`
  const headers = ['PRO #', 'Carrier invoice #', 'Invoice date', 'Amount paid']
  const cells = rows.map((r) => [r.pro || '—', r.invoiceNumber || '—', r.invoiceDate || '—', money(r.amountCents)])
  const totalRow = ['Total', '', '', money(totalCents)]
  const widths = headers.map((h, i) => Math.max(h.length, ...[...cells, totalRow].map((row) => row[i].length)))
  const pad = (row: string[]) => row.map((cell, i) => (i === 3 ? cell.padStart(widths[i]) : cell.padEnd(widths[i]))).join('  ')
  const body = [
    AUTO_REMITTANCE_INTRO,
    '',
    pad(headers),
    widths.map((w) => '-'.repeat(w)).join('  '),
    ...cells.map(pad),
    widths.map((w) => '-'.repeat(w)).join('  '),
    pad(totalRow),
    '',
    input.brokerName,
  ].join('\n').slice(0, MAX_NOTICE_BODY_CHARS)

  const td = (text: string, right = false, bold = false) =>
    `<td style="padding:6px 12px;border-bottom:1px solid #ddd;${right ? 'text-align:right;' : ''}${bold ? 'font-weight:bold;' : ''}">${htmlEscape(text)}</td>`
  const th = (text: string, right = false) =>
    `<th style="padding:6px 12px;border-bottom:2px solid #333;text-align:${right ? 'right' : 'left'};">${htmlEscape(text)}</th>`
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;">` +
    `<p>${htmlEscape(AUTO_REMITTANCE_INTRO)}</p>` +
    `<table style="border-collapse:collapse;"><thead><tr>${headers.map((h, i) => th(h, i === 3)).join('')}</tr></thead><tbody>` +
    cells.map((row) => `<tr>${row.map((c, i) => td(c, i === 3)).join('')}</tr>`).join('') +
    `<tr>${totalRow.map((c, i) => td(c, i === 3, true)).join('')}</tr></tbody></table>` +
    `<p>${htmlEscape(input.brokerName)}</p></div>`
  return { subject, body, html }
}

/**
 * Where a remittance is sent, in the order a cheque would follow the money: the payee
 * address on the payment method the bill was paid under, then the carrier's accounting
 * people, then whatever single address the carrier record carries.
 *
 * One rung only — a factor's remit address is not improved by also copying the
 * carrier's dispatcher. Empty is a normal answer, and an honest one: a caller that
 * gets nothing back must say so rather than send to an empty address.
 */
export function remittanceRecipients(
  carrier: Pick<CarrierRecord, 'email'> | null | undefined,
  contacts: CarrierContactRecord[] | null | undefined,
  method: Pick<CarrierPaymentMethodRecord, 'payeeEmail'> | null | undefined,
): string[] {
  const payee = (method?.payeeEmail ?? '').trim()
  if (payee.includes('@')) return [payee]

  const accounting: string[] = []
  for (const contact of contacts ?? []) {
    if (contact.active === false) continue
    if (!(contact.types ?? []).includes('ACCOUNTING')) continue
    const email = (contact.email ?? '').trim()
    if (!email.includes('@') || accounting.includes(email)) continue
    accounting.push(email)
  }
  if (accounting.length > 0) return accounting

  const fallback = (carrier?.email ?? '').trim()
  return fallback.includes('@') ? [fallback] : []
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
