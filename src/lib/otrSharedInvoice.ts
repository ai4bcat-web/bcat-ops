/**
 * An OTR invoice id may belong to ONE factoring row, and never to a row that already used it.
 *
 * OTR matches a create on more than our invoice number, so it can hand back an invoice that is
 * really another PRO's, or one this very row sent before and OTR has since marked Dead or
 * Duplicate. Attaching a POD and rate confirmation to such an invoice files them on the wrong
 * paperwork, and the row then reads as submitted when it is not. This is the check the
 * otr-actions Lambda runs on every id OTR returns, before anything is written or uploaded.
 *
 * Pure on purpose: the Lambda hands it what it read, so the rule is tested without a database,
 * and the factoring review can show the same sentence.
 */
import type { OtrPriorInvoice } from '@/types'

export interface OtrInvoiceHolder {
  id: string
  proNumber?: string | null
  otrInvoiceId?: string | null
}

/** The prior-invoices list as stored: a JSON column, so it may arrive as text. */
export function priorInvoicesOf(raw: unknown): OtrPriorInvoice[] {
  let v: unknown = raw
  if (typeof v === 'string') {
    try { v = JSON.parse(v) } catch { return [] }
  }
  return Array.isArray(v) ? (v as OtrPriorInvoice[]) : []
}

export type SharedInvoiceVerdict =
  | { ok: true }
  | { ok: false; reason: 'prior' | 'shared'; message: string }

/**
 * @param itemId   this factoring row
 * @param pro      this row's PRO, for the sentence
 * @param invoiceId the OTR invoice id OTR just returned
 * @param priorInvoices this row's own history of replaced OTR invoices
 * @param holders  every OTHER factoring row that currently holds an OTR invoice id
 */
export function checkOtrInvoiceUnshared(
  itemId: string,
  pro: string | null | undefined,
  invoiceId: string | number,
  priorInvoices: unknown,
  holders: readonly OtrInvoiceHolder[],
): SharedInvoiceVerdict {
  const id = String(invoiceId).trim()
  const me = String(pro ?? '').trim() || itemId

  const before = priorInvoicesOf(priorInvoices).find((p) => String(p.otrInvoiceId ?? '').trim() === id)
  if (before) {
    const was = before.otrStatus != null && String(before.otrStatus).trim() ? ` (${String(before.otrStatus).trim()} at OTR)` : ''
    return {
      ok: false,
      reason: 'prior',
      message:
        `OTR gave back invoice ${id}, which ${me} already used before${was}. Nothing was attached. ` +
        `Ask OTR to void invoice ${id}, or change the invoice number.`,
    }
  }

  const other = holders.find((h) => h.id !== itemId && String(h.otrInvoiceId ?? '').trim() === id)
  if (other) {
    const them = String(other.proNumber ?? '').trim() || other.id
    return {
      ok: false,
      reason: 'shared',
      message:
        `OTR gave back invoice ${id}, which PRO ${them} already uses. Nothing was attached to ${me}. ` +
        `Ask OTR to void invoice ${id}, or change the invoice number.`,
    }
  }
  return { ok: true }
}
