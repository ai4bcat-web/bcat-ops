/**
 * Invoicing a load by hand — the path for a broker OTR will not buy.
 *
 * OTR's broker check can answer "No Buy": they know the broker and will not factor its
 * paper. That invoice still has to go out, just not through OTR. These are the three
 * things that have to happen for it, in order, each ticked by the person who did it so
 * the row says where it stands. The list is shared by the queue page and the Lambda so
 * both agree on what "done" means.
 */
import type { ManualInvoiceSteps } from '../types'

export type ManualStepId = keyof ManualInvoiceSteps

export const MANUAL_STEPS: ReadonlyArray<{ id: ManualStepId; label: string; detail: string }> = [
  {
    id: 'billToUpdated',
    label: 'Update the bill-to in Aljex',
    detail: 'Set the bill-to on the load to the broker’s actual AP email address.',
  },
  {
    id: 'pdfExported',
    label: 'Export the invoice PDF',
    detail: 'The invoice with the rate confirmation and the POD, as one PDF.',
  },
  {
    id: 'emailed',
    label: 'Email the PDF to the AP contact',
    detail: 'To the AP email address, cc invoices@bcatcorp.com.',
  },
]

export const MANUAL_INVOICE_CC = 'invoices@bcatcorp.com'

export const MANUAL_STEP_IDS: ReadonlyArray<ManualStepId> = MANUAL_STEPS.map((s) => s.id)

export function isManualStepId(v: unknown): v is ManualStepId {
  return typeof v === 'string' && (MANUAL_STEP_IDS as readonly string[]).includes(v)
}

export interface ManualProgress {
  done: number
  total: number
  complete: boolean
}

/** How far along the row is. Complete only when every step carries a mark. */
export function manualProgress(steps: ManualInvoiceSteps | null | undefined): ManualProgress {
  const done = MANUAL_STEP_IDS.filter((id) => !!steps?.[id]).length
  return { done, total: MANUAL_STEP_IDS.length, complete: done === MANUAL_STEP_IDS.length }
}

/** The steps with one ticked or cleared. Pure, so the Lambda and the page can agree. */
export function withManualStep(
  steps: ManualInvoiceSteps | null | undefined,
  id: ManualStepId,
  done: boolean,
  mark: { at: string; by: string },
): ManualInvoiceSteps {
  return { ...(steps ?? {}), [id]: done ? mark : null }
}
