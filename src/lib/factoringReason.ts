/**
 * Why a row is in the Factoring queue, in plain English (Ryne 2026-11-16: "put more information on why these
 * are rejected, I have no idea what these are").
 *
 * One answer per row, whatever tab it is on: an OTR rejection says what OTR said; a row that was pulled out of the
 * queue to be invoiced by hand says so (and that OTR did not reject it); an e-mail that never matched a customer says that.
 * Pure on purpose: the page passes in the customer name, the linked invoice and the missing OTR fields.
 */
import type { FactoringItem } from '@/types'
import { isOwnFailure, otrRejectionDetails, otrRejectionReason } from './otrRejection'
import { otrStatusMeta } from './otrInvoiceStatus'

export type FactoringReasonKind =
  | 'OTR_NO_BUY'
  | 'OTR_DEAD'
  | 'OTR_REFUSED'
  | 'OTR_UNREACHABLE'
  | 'PULLED_MANUAL'
  | 'INVOICED_MANUALLY'
  | 'ARCHIVED'
  | 'NEED_TO_FACTOR'
  | 'WAITING'
  | 'FACTORED'

export const FACTORING_REASON_LABEL: Record<FactoringReasonKind, string> = {
  OTR_NO_BUY: 'OTR will not buy',
  OTR_DEAD: 'OTR: Dead',
  OTR_REFUSED: 'OTR refused',
  OTR_UNREACHABLE: 'Could not reach OTR',
  PULLED_MANUAL: 'Pulled to invoice manually',
  INVOICED_MANUALLY: 'Invoiced manually',
  ARCHIVED: 'Archived',
  NEED_TO_FACTOR: 'Not submitted yet',
  WAITING: 'Waiting on OTR',
  FACTORED: 'Approved by OTR',
}

export interface FactoringReasonInvoice {
  id: string
  number: string
  customerName?: string | null
  totalCents?: number | null
  factored?: boolean | null
}

export interface FactoringReasonContext {
  /** The customer the row resolved to, or empty/null when it never matched one. */
  customerName?: string | null
  /** The invoice linked to this queue row, when it is still open. */
  invoice?: FactoringReasonInvoice | null
  /** Labels of the OTR fields still missing on the row. */
  missingFields?: readonly string[]
}

export interface FactoringReason {
  kind: FactoringReasonKind
  /** The one sentence for the row. */
  short: string
  /** The rest: source e-mail, customer, missing OTR fields, the linked invoice. */
  lines: string[]
  /** A conflict the office has to decide, e.g. the invoice says factored but the queue says manual. */
  warning: string | null
  tone: 'red' | 'orange' | 'blue' | 'green' | 'gray'
}

const CT = 'America/Chicago'

function shortDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: CT })
}

function dollars(cents: number | null | undefined): string {
  return cents == null ? '' : `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** "E-mail from Aljex (Nov 6)" for the Descartes/Aljex invoice robot, else "E-mail from <sender> (date)". */
function emailSource(item: Pick<FactoringItem, 'fromEmail' | 'receivedAt'>): string {
  const from = (item.fromEmail ?? '').trim()
  const who = /aljex|descartes/i.test(from) ? 'Aljex' : from
  const date = shortDate(item.receivedAt)
  return `Invoice e-mail${who ? ` from ${who}` : ''}${date ? ` (${date})` : ''}`
}

function detailLines(item: FactoringItem, ctx: FactoringReasonContext): string[] {
  const lines: string[] = []
  if (item.source !== 'TMS' && (item.fromEmail || item.subject)) {
    const date = shortDate(item.receivedAt)
    lines.push(`Source: e-mail from ${item.fromEmail || 'unknown sender'}${item.subject ? `, “${item.subject}”` : ''}${date ? `, received ${date}` : ''}.`)
  }
  const customer = (ctx.customerName ?? '').trim()
  lines.push(customer ? `Customer: ${customer}.` : 'Customer: not matched. Nobody has picked the customer this invoice bills.')
  if (ctx.missingFields && ctx.missingFields.length > 0) lines.push(`Missing for OTR: ${ctx.missingFields.join(', ')}.`)
  if (ctx.invoice) {
    const inv = ctx.invoice
    lines.push(`Invoice ${inv.number}${inv.customerName ? ` · ${inv.customerName}` : ''}${inv.totalCents != null ? ` · ${dollars(inv.totalCents)}` : ''} · ${inv.factored ? 'marked factored' : 'manual invoice'}.`)
  }
  return lines
}

export function factoringReasonOf(item: FactoringItem, ctx: FactoringReasonContext = {}): FactoringReason {
  const customer = (ctx.customerName ?? '').trim()
  const invoice = ctx.invoice ?? null
  const base = detailLines(item, ctx)
  const manualStatus = item.status === 'MANUAL_INVOICE' || item.status === 'INVOICED_MANUALLY'
  const warning = invoice?.factored === true && manualStatus
    ? 'Invoice says factored, queue says manual. Was this one actually factored through OTR, or invoiced by hand?'
    : null

  // 0. Archived rows were taken out of the queue by hand; say what OTR had said, if anything, but they are not an open rejection.
  if (item.status === 'ARCHIVED') {
    const earlier = otrRejectionReason(item)
    return {
      kind: 'ARCHIVED',
      short: earlier ? `Archived: taken out of the queue by hand. OTR had said: ${earlier}.` : 'Archived: taken out of the queue by hand. Nothing was deleted.',
      lines: base,
      warning,
      tone: 'gray',
    }
  }

  // 1. A real OTR rejection: say what OTR said.
  const details = otrRejectionDetails(item)
  if (details) {
    const noBuy = item.brokerCheckResult === 'NO_BUY' || item.manualReason === 'NO_BUY'
    const dead = otrStatusMeta(item.otrStatus)?.code === 4
    const kind: FactoringReasonKind = noBuy ? 'OTR_NO_BUY' : dead ? 'OTR_DEAD' : 'OTR_REFUSED'
    return { kind, short: details.headline, lines: [...details.lines, ...base], warning, tone: 'red' }
  }

  // 2. Our own failure to reach OTR is not OTR saying no.
  const error = typeof item.otrError === 'string' ? item.otrError.trim() : ''
  if (error && isOwnFailure(error) && item.status !== 'FACTORED') {
    return {
      kind: 'OTR_UNREACHABLE',
      short: `Could not reach OTR (${error}). This is not an OTR rejection; use Resend to OTR to try again.`,
      lines: base,
      warning,
      tone: 'orange',
    }
  }

  switch (item.status) {
    case 'MANUAL_INVOICE': {
      const unmatched = !customer
      const short = `Pulled from the OTR queue to invoice manually. Not rejected by OTR.${unmatched && item.source !== 'TMS' ? ` ${emailSource(item)} is not matched to a customer.` : ''}`
      const lines = [...base]
      if (item.manualReason === 'MANUAL') lines.push('It was moved here by a person, not by OTR’s broker check.')
      return { kind: 'PULLED_MANUAL', short, lines, warning, tone: 'orange' }
    }
    case 'INVOICED_MANUALLY':
      return { kind: 'INVOICED_MANUALLY', short: 'Invoiced manually: sent to the customer’s AP by hand.', lines: base, warning, tone: 'gray' }
    case 'NEED_TO_FACTOR':
      return { kind: 'NEED_TO_FACTOR', short: 'Not submitted to OTR yet.', lines: base, warning, tone: 'orange' }
    case 'FACTORED':
      return { kind: 'FACTORED', short: 'OTR approved this invoice.', lines: base, warning, tone: 'green' }
    case 'PENDING_WITH_OTR':
    default: {
      const meta = otrStatusMeta(item.otrStatus)
      return { kind: 'WAITING', short: `Submitted to OTR, waiting for approval${meta ? ` (OTR says ${meta.label})` : ''}.`, lines: base, warning, tone: 'blue' }
    }
  }
}
