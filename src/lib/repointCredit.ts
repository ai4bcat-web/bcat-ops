/**
 * Pure credit-and-rebill arithmetic for re-pointing an invoiced shipment to a new
 * customer. The Lambda and the UI both import this so the numbers on screen are the
 * numbers that post, and the ledger never invents money.
 */

export interface RepointInvoiceInput {
  id: string
  number: string | null
  status: string
  totalCents: number
  paidCents: number
  writtenOffCents: number
  balanceCents: number
  factoringItemId?: string | null
  orderId?: string | null
}

export interface RepointInvoicePlan {
  invoiceId: string
  number: string | null
  creditCents: number
  appliedCents: number
  unappliedCents: number
  orderId: string | null
}

export interface RepointCreditPlan {
  entries: RepointInvoicePlan[]
  totalCreditCents: number
  totalAppliedCents: number
  totalUnappliedCents: number
  moneyApplied: boolean
  refusal: string | null
}

const REFUSAL_VOID = 'This shipment has a void invoice; it cannot be repointed'
const REFUSAL_WRITE_OFF = 'This shipment has an invoice with a write-off; reverse the write-off before repointing'
const REFUSAL_FACTORED = 'This shipment has a factored invoice; remove it from the factoring batch before repointing'

/**
 * Plan the credit memo(s) needed to move an invoiced shipment to a new customer.
 *
 * Rules are evaluated in order so the most fundamental blockers (void, write-off,
 * factored) surface first. For every non-void, non-draft invoice the credit memo is
 * for the invoice's full total; it applies to the open balance and the remainder
 * stays as unapplied credit on the original customer's account.
 */
export function planRepointCredit(invoices: readonly RepointInvoiceInput[]): RepointCreditPlan {
  if (invoices.some((inv) => inv.status === 'VOID')) {
    return { entries: [], totalCreditCents: 0, totalAppliedCents: 0, totalUnappliedCents: 0, moneyApplied: false, refusal: REFUSAL_VOID }
  }

  if (invoices.some((inv) => inv.writtenOffCents > 0)) {
    return { entries: [], totalCreditCents: 0, totalAppliedCents: 0, totalUnappliedCents: 0, moneyApplied: false, refusal: REFUSAL_WRITE_OFF }
  }

  if (invoices.some((inv) => inv.factoringItemId)) {
    return { entries: [], totalCreditCents: 0, totalAppliedCents: 0, totalUnappliedCents: 0, moneyApplied: false, refusal: REFUSAL_FACTORED }
  }

  const entries: RepointInvoicePlan[] = []
  let totalCreditCents = 0
  let totalAppliedCents = 0
  let totalUnappliedCents = 0
  let moneyApplied = false

  for (const inv of invoices) {
    // DRAFT invoices are not real receivables yet; VOID was filtered above.
    if (inv.status === 'DRAFT' || inv.status === 'VOID') continue
    if (inv.totalCents === 0) continue

    const creditCents = inv.totalCents
    const appliedCents = Math.max(0, Math.min(inv.balanceCents, inv.totalCents))
    const unappliedCents = creditCents - appliedCents

    entries.push({
      invoiceId: inv.id,
      number: inv.number ?? null,
      creditCents,
      appliedCents,
      unappliedCents,
      orderId: inv.orderId ?? null,
    })

    totalCreditCents += creditCents
    totalAppliedCents += appliedCents
    totalUnappliedCents += unappliedCents
    if (unappliedCents > 0) moneyApplied = true
  }

  return {
    entries,
    totalCreditCents,
    totalAppliedCents,
    totalUnappliedCents,
    moneyApplied,
    refusal: null,
  }
}
