/**
 * PAST_DUE_REMINDER — a short "when will you pay these?" e-mail to a customer about one or more
 * of its past-due invoices (Ryne, 2026-11-17).
 *
 * Preview (the default) reads and writes nothing: it returns exactly what would go out (To, CC,
 * subject, body, the table's rows) and whether a reminder already went out inside the cooldown.
 * Send delivers it through the same notice path every invoice uses, stamps
 * `pastDueReminderSentAt/To` on each invoice and writes an audit row per invoice. No PDF and no
 * rate confirmation is attached; nothing here has cost, carrier pay or margin.
 *
 * Every invoice in one call must belong to one customer; the client makes one call per customer.
 */
import { assertString, optionalBoolean, type Caller } from '../_shared/actionInputs'
import { deliverNotice } from '../_shared/shipmentNotices'
import { allApEmails } from '../../../src/lib/billingMethod'
import { invoiceCompanyName } from '../../../src/lib/invoiceIdentity'
import {
  PAST_DUE_REMINDER_ALWAYS_CC,
  PAST_DUE_REMINDER_COOLDOWN_DAYS,
  pastDueReason,
  pastDueReminderEmail,
  pastDueRows,
  remindedRecently,
} from '../../../src/lib/pastDueReminder'
import type { CustomerRecord, InvoiceRecord } from '../../../src/types/tms'
import {
  CUSTOMER_TABLE_NAME,
  FROM_ADDRESS,
  INVOICE_TABLE_NAME,
  SHIPMENT_NOTICE_TABLE_NAME,
  SHIPMENT_TABLE_NAME,
  dynamo,
  getById,
  nowIso,
  ses,
  transact,
  updateTx,
  writeAudit,
  type Row,
} from './store'

const MAX_INVOICES = 50
const MAX_ADDRESSES = 10
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/

function chicagoToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

/** An optional edited recipient list: trimmed, lower-cased, de-duplicated, every one a real address. */
function addressList(value: unknown, label: string): string[] | null {
  if (value == null) return null
  if (!Array.isArray(value)) throw new Error(`${label} must be a list of e-mail addresses`)
  const out: string[] = []
  for (const raw of value) {
    const email = String(raw ?? '').trim().toLowerCase()
    if (!email) continue
    if (!EMAIL_RE.test(email)) throw new Error(`${label}: "${email}" is not a valid e-mail address`)
    if (!out.includes(email)) out.push(email)
  }
  if (out.length > MAX_ADDRESSES) throw new Error(`${label}: at most ${MAX_ADDRESSES} addresses`)
  return out
}

export async function pastDueReminder(input: Row, caller: Caller): Promise<Row> {
  const send = input.send === true
  const confirmRecent = optionalBoolean(input.confirmRecent) === true
  const asOf = chicagoToday()
  const ids = Array.isArray(input.invoiceIds) ? [...new Set(input.invoiceIds.map((v) => assertString(v, 'invoiceIds[]')))] : []
  if (ids.length === 0) throw new Error('invoiceIds is required')
  if (ids.length > MAX_INVOICES) throw new Error(`At most ${MAX_INVOICES} invoices in one reminder`)

  const invoices: InvoiceRecord[] = []
  for (const id of ids) {
    const row = await getById(INVOICE_TABLE_NAME, id)
    if (!row) throw new Error(`Invoice not found: ${id}`)
    invoices.push(row as unknown as InvoiceRecord)
  }
  const customerIds = new Set(invoices.map((inv) => inv.customerId))
  if (customerIds.size !== 1) throw new Error('A reminder is for one customer at a time')
  const customerId = invoices[0].customerId

  const refused = invoices.map((inv) => ({ inv, why: pastDueReason(inv, asOf) })).filter((x) => x.why)
  if (refused.length > 0) {
    throw new Error(`Not past-due open invoices: ${refused.map((x) => `${x.inv.number} (${x.why})`).join('; ')}`)
  }

  const customerRow = await getById(CUSTOMER_TABLE_NAME, customerId)
  if (!customerRow) throw new Error(`Customer not found: ${customerId}`)
  const customer = customerRow as unknown as CustomerRecord
  const customerName = customer.name ?? customerId

  const rows = pastDueRows(invoices, asOf)
  const names = new Set<string>()
  for (const inv of invoices) {
    const shipment = await getById(SHIPMENT_TABLE_NAME, inv.shipmentId)
    names.add(invoiceCompanyName(shipment?.revDivision as string | null | undefined, shipment?.revSubdivision as string | null | undefined))
  }
  const companyName = names.size === 1 ? [...names][0] : 'BCAT Logistics Corporation'
  const { subject, body, htmlBody, totalCents } = pastDueReminderEmail({ customerName, asOf, companyName, rows })

  const defaultTo = allApEmails(customer)
  const to = addressList(input.to, 'To') ?? defaultTo
  const cc = (addressList(input.cc, 'CC') ?? [PAST_DUE_REMINDER_ALWAYS_CC, ...(customer.invoiceCopyEmails ?? [])])
    .map((e) => e.trim().toLowerCase())
    .filter((e, i, all) => e && all.indexOf(e) === i && !to.includes(e))

  const recent = invoices
    .filter((inv) => remindedRecently(inv.pastDueReminderSentAt, asOf))
    .map((inv) => ({ invoiceNumber: inv.number, sentAt: inv.pastDueReminderSentAt as string }))
  const summary = { customerId, customerName, count: rows.length, totalCents, companyName }

  if (!send) {
    return { preview: true, to, cc, defaultTo, subject, body, rows, recent, cooldownDays: PAST_DUE_REMINDER_COOLDOWN_DAYS, summary }
  }

  if (to.length === 0) throw new Error(`Missing invoice e-mail: ${customerName} has none on file; add one before sending a reminder`)
  if (recent.length > 0 && !confirmRecent) {
    throw new Error(`A reminder for ${recent.map((r) => r.invoiceNumber).join(', ')} went out in the last ${PAST_DUE_REMINDER_COOLDOWN_DAYS} days; confirm to send another`)
  }

  const now = nowIso()
  const delivered = await deliverNotice({
    db: dynamo,
    ses,
    tableName: SHIPMENT_NOTICE_TABLE_NAME,
    from: FROM_ADDRESS,
    htmlBody,
    draft: {
      id: `pdr:${customerId}:${now}`,
      shipmentId: invoices[0].shipmentId,
      kind: 'INVOICE',
      channel: 'EMAIL',
      to,
      cc,
      subject,
      body,
      attachments: [],
      createdBy: caller.email,
    },
  })
  if (delivered.status === 'SENT') {
    await transact(invoices.map((inv) => updateTx(INVOICE_TABLE_NAME, inv.id, {
      pastDueReminderSentAt: now,
      pastDueReminderSentTo: to.join(', '),
      updatedAt: now,
    })), 'past due reminder')
  }
  for (const inv of invoices) {
    await writeAudit('Invoice', inv.id, 'PAST_DUE_REMINDER_SENT', caller, { to, cc, subject, status: delivered.status, daysPastDue: rows.find((r) => r.invoiceId === inv.id)?.daysPastDue ?? null })
  }
  return {
    preview: false,
    emailStatus: delivered.status,
    emailError: delivered.error ?? null,
    to,
    cc,
    subject,
    body,
    sentAt: delivered.status === 'SENT' ? now : null,
    summary,
  }
}
