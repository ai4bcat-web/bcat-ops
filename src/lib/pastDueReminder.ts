/**
 * Past-due reminder: the short e-mail that asks a customer when they will pay the invoices below
 * (Ryne, 2026-11-17). Customer-facing: it carries only what the customer was billed and still owes.
 * Nothing here has cost, carrier pay or margin, and no rate confirmation is ever attached.
 *
 * Pure and import-light: the finance Lambda bundles this file by relative path.
 */
import { daysLate } from './arAging'
import { isFactoredInvoice } from './agingStatement'
import { invoicePoNumber } from './invoiceIdentity'
import { esc } from './emailChrome'
import type { InvoiceRecord } from '../types/tms'

/** Always copied, as on the aging report. */
export const PAST_DUE_REMINDER_ALWAYS_CC = 'billing@bcatcorp.com'

/** A second reminder inside this many days asks for a second click. */
export const PAST_DUE_REMINDER_COOLDOWN_DAYS = 3

export const PAST_DUE_REMINDER_QUESTION = 'Can you please advise when payment will be made?'

export interface PastDueRow {
  invoiceId: string
  invoiceNumber: string
  pro: string
  po: string | null
  invoiceDate: string
  dueAt: string
  totalCents: number
  balanceCents: number
  daysPastDue: number
}

const OPEN: Record<string, true> = { ISSUED: true, PARTIAL: true }

/** Open, owing, past its due date, and billed to the customer (OTR collects factored invoices). */
export function pastDueReason(
  inv: Pick<InvoiceRecord, 'status' | 'balanceCents' | 'dueAt' | 'factored' | 'factoringItemId'>,
  asOf: string,
): string | null {
  if (!OPEN[inv.status]) return 'Only an open invoice can be chased'
  if (!(inv.balanceCents > 0)) return 'Nothing is owed on this invoice'
  if (isFactoredInvoice(inv)) return 'OTR collects factored invoices; the customer is never asked'
  if (daysLate(inv.dueAt, asOf) <= 0) return 'Not past due yet'
  return null
}

export function isPastDueReminderEligible(inv: Parameters<typeof pastDueReason>[0], asOf: string): boolean {
  return pastDueReason(inv, asOf) == null
}

export function pastDueRows(invoices: InvoiceRecord[], asOf: string): PastDueRow[] {
  return invoices
    .filter((inv) => isPastDueReminderEligible(inv, asOf))
    .map((inv) => ({
      invoiceId: inv.id,
      invoiceNumber: inv.number,
      pro: inv.shipmentNumber || inv.number,
      po: invoicePoNumber(inv.references),
      invoiceDate: inv.invoiceDate,
      dueAt: inv.dueAt,
      totalCents: inv.totalCents,
      balanceCents: inv.balanceCents,
      daysPastDue: daysLate(inv.dueAt, asOf),
    }))
    .sort((a, b) => b.daysPastDue - a.daysPastDue || a.invoiceNumber.localeCompare(b.invoiceNumber))
}

function usDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  return m ? `${m[2]}/${m[3]}/${m[1]}` : iso
}

function money(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`
}

/** Ryne's sentence: one invoice names its days; several point at the table. */
export function pastDueSentence(rows: Pick<PastDueRow, 'daysPastDue'>[]): string {
  if (rows.length === 1) {
    const d = rows[0].daysPastDue
    return `Hi, the invoice below is ${d} day${d === 1 ? '' : 's'} past due. ${PAST_DUE_REMINDER_QUESTION}`
  }
  return `Hi, the invoices below are past due, by the number of days shown for each. ${PAST_DUE_REMINDER_QUESTION}`
}

export function pastDueReminderEmail(input: { customerName: string; asOf: string; companyName: string; rows: PastDueRow[] }): {
  subject: string
  body: string
  htmlBody: string
  totalCents: number
} {
  const { rows } = input
  const totalCents = rows.reduce((sum, r) => sum + r.balanceCents, 0)
  const sentence = pastDueSentence(rows)
  const subject = rows.length === 1
    ? `Past due — invoice ${rows[0].invoiceNumber} — ${input.customerName} — ${input.companyName}`
    : `Past due invoices — ${input.customerName} — ${usDate(input.asOf)} — ${input.companyName}`

  const lines = rows.map((r) => [
    `Invoice ${r.invoiceNumber}`,
    `PRO ${r.pro}`,
    r.po ? `PO ${r.po}` : null,
    `invoiced ${usDate(r.invoiceDate)}`,
    `due ${usDate(r.dueAt)}`,
    `amount ${money(r.totalCents)}`,
    `balance ${money(r.balanceCents)}`,
    `${r.daysPastDue} day${r.daysPastDue === 1 ? '' : 's'} past due`,
  ].filter(Boolean).join(' · '))
  const body = [sentence, '', ...lines, '', `Total past due: ${money(totalCents)}`].join('\n')

  const th = 'style="text-align:left;padding:6px 10px;border-bottom:2px solid #999;font-weight:600"'
  const thr = 'style="text-align:right;padding:6px 10px;border-bottom:2px solid #999;font-weight:600"'
  const td = 'style="padding:6px 10px;border-bottom:1px solid #ddd"'
  const tdr = 'style="padding:6px 10px;border-bottom:1px solid #ddd;text-align:right"'
  const head = `<tr><th ${th}>Invoice #</th><th ${th}>PRO</th><th ${th}>PO / Ref</th><th ${th}>Invoice date</th><th ${th}>Due date</th><th ${thr}>Amount</th><th ${thr}>Balance</th><th ${thr}>Days past due</th></tr>`
  const trs = rows.map((r) =>
    `<tr><td ${td}>${esc(r.invoiceNumber)}</td><td ${td}>${esc(r.pro)}</td><td ${td}>${esc(r.po ?? '')}</td><td ${td}>${usDate(r.invoiceDate)}</td><td ${td}>${usDate(r.dueAt)}</td><td ${tdr}>${money(r.totalCents)}</td><td ${tdr}>${money(r.balanceCents)}</td><td ${tdr}>${r.daysPastDue}</td></tr>`).join('')
  const foot = `<tr><td ${td} colspan="6"><strong>Total past due</strong></td><td ${tdr}><strong>${money(totalCents)}</strong></td><td ${td}></td></tr>`
  const htmlBody = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222"><p>${esc(sentence)}</p><table style="border-collapse:collapse;font-size:13px">${head}${trs}${foot}</table></div>`
  return { subject, body, htmlBody, totalCents }
}

/** True when the reminder went out inside the cooldown, as of `asOf` (YYYY-MM-DD). */
export function remindedRecently(sentAt: string | null | undefined, asOf: string): boolean {
  if (!sentAt) return false
  const sent = Date.parse(sentAt.slice(0, 10))
  const now = Date.parse(asOf.slice(0, 10))
  if (Number.isNaN(sent) || Number.isNaN(now)) return false
  return (now - sent) / 86_400_000 < PAST_DUE_REMINDER_COOLDOWN_DAYS
}
