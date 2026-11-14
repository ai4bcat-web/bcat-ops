/**
 * How an invoice names itself to the customer (Ryne, 2026-11-12): the PRO # and the PO # lead,
 * the subject says which company it comes from, and the attachment is called
 * `Invoice <PRO> <PO>.pdf`. Customer-facing: nothing here may carry cost, carrier pay or margin.
 *
 * Pure and import-light: the finance Lambda bundles this file by relative path.
 */
import { invoiceBrandingFor } from './invoiceBranding'
import { customerRefOf } from './customerRef'

interface ReferenceLike {
  code: string
  value: string
  level?: string | null
  visibility?: string | null
}

/** The PO the invoice states: the customer-visible PO reference, else the Customer Ref reference (see customerRef.ts). */
export function invoicePoNumber(references: readonly ReferenceLike[] | null | undefined): string | null {
  return customerRefOf(references)
}

/** The company the invoice comes from, as the subject names it. */
export function invoiceCompanyName(revDivision: string | null | undefined, revSubdivision?: string | null): string {
  return invoiceBrandingFor(revDivision, revSubdivision).key === 'IVAN' ? 'IVAN Cartage Co' : 'BCAT Logistics Corporation'
}

/** `Invoice for Pro # 20027 Attached from BCAT Logistics Corporation`. */
export function invoiceEmailSubject(pro: string, companyName: string): string {
  return `Invoice for Pro # ${pro} Attached from ${companyName}`
}

/** `PRO # 20027 · PO # FR-113188-3` (or just the PRO when there is no PO). */
export function invoiceReferenceLine(pro: string, po: string | null | undefined): string {
  return po ? `PRO # ${pro} · PO # ${po}` : `PRO # ${pro}`
}

/** Characters no mail client or file system should see in an attachment name. */
function safePart(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
}

/** `Invoice 20027 FR-113188-3.pdf`, or `Invoice 20027.pdf` without a PO. */
export function invoiceAttachmentName(pro: string, po: string | null | undefined): string {
  const parts = ['Invoice', safePart(pro) || 'invoice', po ? safePart(po) : ''].filter(Boolean)
  return `${parts.join(' ')}.pdf`
}
