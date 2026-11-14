/**
 * A customer's aging statement: every open invoice, aged from its INVOICE date (0–30 / 31–60 /
 * 61–90 / 90+), and the e-mail that carries it (Ryne, 2026-11-12).
 *
 * Customer-facing: amounts are what the customer was billed, paid and still owes. Nothing here
 * — and nothing the PDF draws from it — carries cost, carrier pay or margin.
 *
 * Pure and import-light: the finance Lambda bundles this file by relative path.
 */
import { invoiceAgeBucket, daysSinceInvoice, AR_AGING_BUCKETS, AR_AGING_BUCKET_LABEL, type AgingBucket } from './arAging'
import { invoiceCompanyName, invoicePoNumber } from './invoiceIdentity'
import type { InvoiceRecord } from '../types/tms'

export type StatementBucket = (typeof AR_AGING_BUCKETS)[number]
export const STATEMENT_BUCKETS = AR_AGING_BUCKETS
export const STATEMENT_BUCKET_LABEL = AR_AGING_BUCKET_LABEL

export interface StatementRow {
  invoiceNumber: string
  pro: string
  po: string | null
  invoiceDate: string
  dueAt: string
  totalCents: number
  paidCents: number
  balanceCents: number
  days: number
  bucket: StatementBucket
}

export interface AgingStatement {
  customerName: string
  asOf: string
  companyName: string
  rows: StatementRow[]
  byBucket: Record<StatementBucket, number>
  totalCents: number
  /** Open factored invoices left off: OTR owns and collects those, so the customer is never asked. */
  factoredExcluded: number
}

/** The revenue division and subdivision behind an invoice, as the shipment carries them. */
export interface StatementShipmentLike {
  revDivision?: string | null
  revSubdivision?: string | null
}

const OPEN: Record<string, true> = { ISSUED: true, PARTIAL: true }

/** Billed through OTR: the customer pays the factor, so BCAT never asks them about it. */
export function isFactoredInvoice(inv: Pick<InvoiceRecord, 'factored' | 'factoringItemId'>): boolean {
  return Boolean(inv.factored || inv.factoringItemId)
}

export function buildAgingStatement(input: {
  customerName: string
  asOf: string
  invoices: InvoiceRecord[]
  shipmentsById: Map<string, StatementShipmentLike>
}): AgingStatement {
  const openAll = input.invoices.filter((inv) => OPEN[inv.status] && inv.balanceCents > 0)
  const open = openAll.filter((inv) => !isFactoredInvoice(inv))
  const rows: StatementRow[] = open
    .map((inv) => ({
      invoiceNumber: inv.number,
      pro: inv.shipmentNumber || inv.number,
      po: invoicePoNumber(inv.references),
      invoiceDate: inv.invoiceDate,
      dueAt: inv.dueAt,
      totalCents: inv.totalCents,
      paidCents: inv.paidCents + inv.writtenOffCents,
      balanceCents: inv.balanceCents,
      days: daysSinceInvoice(inv.invoiceDate, input.asOf) ?? 0,
      bucket: invoiceAgeBucket(inv.invoiceDate, input.asOf) as StatementBucket,
    }))
    .sort((a, b) => a.invoiceDate.localeCompare(b.invoiceDate) || a.invoiceNumber.localeCompare(b.invoiceNumber))
  const byBucket = { D1_30: 0, D31_60: 0, D61_90: 0, D91_PLUS: 0 } as Record<StatementBucket, number>
  let totalCents = 0
  for (const row of rows) {
    byBucket[row.bucket] += row.balanceCents
    totalCents += row.balanceCents
  }
  // One company name for the statement: Ivan Cartage only when every open invoice is an Ivan load.
  const names = new Set(open.map((inv) => {
    const shipment = input.shipmentsById.get(inv.shipmentId)
    return invoiceCompanyName(shipment?.revDivision, shipment?.revSubdivision)
  }))
  const companyName = names.size === 1 ? [...names][0] : 'BCAT Logistics Corporation'
  return { customerName: input.customerName, asOf: input.asOf, companyName, rows, byBucket, totalCents, factoredExcluded: openAll.length - open.length }
}

/** Ryne's wording, exactly. */
export const AGING_STATEMENT_EMAIL_BODY = 'Hi, please find your aging report attached. Please advise when payment will be issued.'

/** Always copied on a statement, beside the customer's own copy list. */
export const AGING_STATEMENT_ALWAYS_CC = 'billing@bcatcorp.com'

/** MM/DD/YYYY from YYYY-MM-DD. */
function usDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  return m ? `${m[2]}/${m[3]}/${m[1]}` : iso
}

export function agingStatementEmail(statement: Pick<AgingStatement, 'customerName' | 'asOf' | 'companyName'>): { subject: string; body: string } {
  return {
    subject: `Aging report — ${statement.customerName} — ${usDate(statement.asOf)} — ${statement.companyName}`,
    body: AGING_STATEMENT_EMAIL_BODY,
  }
}

/** `Aging report <Customer> <YYYY-MM-DD>.pdf`, safe for any mail client. */
export function agingStatementFilename(customerName: string, asOf: string): string {
  const safe = customerName.normalize('NFKD').replace(/[^\x20-\x7E]/g, '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim()
  return `Aging report ${safe || 'customer'} ${asOf.slice(0, 10)}.pdf`
}

export type { AgingBucket }
