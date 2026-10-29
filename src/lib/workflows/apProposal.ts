/**
 * Step K — reading an invoice e-mail into a bill proposal.
 *
 * Invariant 5: money becomes integer cents exactly once, here. Every downstream reader
 * of a proposal gets cents and never has to wonder whether somebody already rounded.
 *
 * `shipmentRefsIn` is deliberately conservative. A carrier invoice is full of numbers —
 * phone numbers, ZIPs, amounts — and a wrong reference attaches a bill to the wrong
 * load, so a run only reports a reference when the text says what it is.
 */
import { normalizePro } from '../proNumber'
import type { CarrierBillProposal, WorkflowConfidence, WorkflowDocumentRef } from '../../types/tms'

/**
 * Dollars to cents. Rejects a negative or non-finite amount rather than guessing: a
 * credit is not a bill, and `NaN` cents would flow all the way into carrier pay.
 */
export function centsFromDollars(v: unknown): number | null {
  const n =
    typeof v === 'number'
      ? v
      : typeof v === 'string'
        ? Number(v.replace(/[$,\s]/g, ''))
        : Number.NaN
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n * 100)
}

/** `a@b.com` carries digits that are not references. */
const EMAIL_SHAPE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
/** `PRO 13364`, `pro#13364`, `PRO: 13364`. */
const PRO_LABEL = /\bpro\s*#?\s*:?\s*([A-Za-z0-9][A-Za-z0-9-]{2,})/gi
/** `S000123` — the shipment prefix plus its padded counter, or a backfilled `L12345`. */
const SHIPMENT_SHAPE = /\b([A-Za-z]{1,2}\d{5,8})\b/g
/** A reference only counts when the text says what it is. */
const LABELLED_REF =
  /\b(?:ref|reference|bol|b\/l|po|order|load|invoice|inv|trip|tms\s*id)\s*#?\s*:?\s*([A-Za-z0-9][A-Za-z0-9-]{2,})\b/gi

/** A bare 10- or 11-digit run is a phone number, not a reference. */
function phoneShaped(token: string): boolean {
  const digits = token.replace(/\D/g, '')
  return digits.length === token.length && (digits.length === 10 || digits.length === 11)
}

export function shipmentRefsIn(text: string): { pros: string[]; numbers: string[]; others: string[] } {
  const body = text.replace(EMAIL_SHAPE, ' ')

  const pros: string[] = []
  for (const hit of body.matchAll(PRO_LABEL)) {
    const pro = normalizePro(hit[1])
    if (pro && !pros.includes(pro)) pros.push(pro)
  }

  const numbers: string[] = []
  for (const hit of body.matchAll(SHIPMENT_SHAPE)) {
    const value = hit[1].toUpperCase()
    if (!phoneShaped(value) && !numbers.includes(value)) numbers.push(value)
  }

  const others: string[] = []
  for (const hit of body.matchAll(LABELLED_REF)) {
    const value = hit[1].toUpperCase()
    // `Invoice for PRO# 13364` would otherwise report "FOR". A reference has a number
    // in it; a bare word after the label is the rest of the sentence.
    if (!/\d/.test(value)) continue
    if (phoneShaped(value)) continue
    if (numbers.includes(value) || pros.includes(normalizePro(value) ?? '')) continue
    if (!others.includes(value)) others.push(value)
  }

  return { pros, numbers, others }
}

export function carrierBillFrom(
  x: {
    invoiceNumber?: string | null
    amountDollars?: unknown
    invoiceDate?: string | null
    dueDate?: string | null
    confidence?: WorkflowConfidence | null
  },
  match: {
    loadCarrierId?: string | null
    carrierId?: string | null
    carrierName?: string | null
    shipmentId?: string | null
    shipmentNumber?: string | null
  },
): CarrierBillProposal {
  return {
    kind: 'CARRIER_BILL',
    invoiceNumber: (x.invoiceNumber ?? '').trim() || null,
    amountCents: centsFromDollars(x.amountDollars),
    invoiceDate: (x.invoiceDate ?? '').trim() || null,
    dueDate: (x.dueDate ?? '').trim() || null,
    loadCarrierId: match.loadCarrierId ?? null,
    carrierId: match.carrierId ?? null,
    carrierName: match.carrierName ?? null,
    shipmentId: match.shipmentId ?? null,
    shipmentNumber: match.shipmentNumber ?? null,
    confidence: x.confidence ?? null,
  }
}

/** The pointer a run keeps to an attachment. The bytes never leave S3. */
export function documentFor(s3Key: string, name: string, contentType: string, size: number): WorkflowDocumentRef {
  return { s3Key, name, contentType, size }
}
