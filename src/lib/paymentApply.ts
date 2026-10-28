/**
 * The arithmetic behind every posted cash row: what a payment may be applied to, what
 * an invoice looks like afterwards, and what a reversal is allowed to take back.
 *
 * Pure and total. The Lambda runs this first and refuses on `ok === false` before it
 * opens a transaction; the Receive-payment dialog runs the same function on every
 * keystroke, so the dialog's arithmetic and the ledger's arithmetic cannot disagree.
 * Every amount is integer cents — a non-integer or a negative is an error, never a
 * value to round.
 *
 * Relative imports, not `@/`: tms-finance-actions bundles this file by path and the
 * alias does not exist in the function build.
 */
import type {
  ArPaymentKind,
  ArPaymentRecord,
  CreditApplication,
  InvoiceStatus,
  PaymentApplication,
} from '../types/tms'

/** What the planner needs to know about one invoice. */
export interface PlanInvoice {
  id: string
  customerId: string
  status: InvoiceStatus
  totalCents: number
  paidCents: number
  writtenOffCents: number
  balanceCents: number
  number?: string | null
}

/** An earlier row with money left on it: an unspent credit memo or an overpayment. */
export interface PlanCredit {
  id: string
  customerId: string
  kind: ArPaymentKind
  unappliedCents: number
  reference?: string | null
  /** Set once a REVERSAL has taken this row back. Its money no longer exists. */
  reversed?: boolean
}

export interface PaymentPlanInput {
  kind: ArPaymentKind
  customerId: string
  amountCents: number
  applications: PaymentApplication[]
  creditApplications: CreditApplication[]
  invoices: PlanInvoice[]
  credits: PlanCredit[]
}

/** One invoice as it will stand after the row posts. */
export interface PlannedInvoice {
  id: string
  /** What this row puts against it. */
  appliedCents: number
  paidCents: number
  writtenOffCents: number
  balanceCents: number
  status: InvoiceStatus
  /** The balance reached zero here, so the order moves to PAID and `arOpen` is removed. */
  becamePaid: boolean
}

/** One earlier row as it will stand after this one spends part of it. */
export interface PlannedCredit {
  id: string
  usedCents: number
  unappliedAfterCents: number
}

export interface PaymentPlan {
  ok: boolean
  /** Every refusal, so the dialog can show them all at once rather than one per attempt. */
  errors: string[]
  /** Put against invoices, from cash and credits together. */
  appliedCents: number
  fromCreditsCents: number
  /** Cash left over — kept on the row as customer credit. */
  unappliedCents: number
  invoices: PlannedInvoice[]
  credits: PlannedCredit[]
}

const MAX_APPLICATIONS = 40
const MAX_CREDIT_USES = 10

function isCents(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function money(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`
}

function nameOf(invoice: PlanInvoice): string {
  return invoice.number ?? invoice.id
}

/**
 * The status an invoice carries for a given set of totals.
 *
 * A write-off settles an invoice exactly as cash does: `balance = total - paid - written
 * off`, and a zero balance is PAID however it got there.
 */
export function invoiceStatusAfter(
  totalCents: number,
  paidCents: number,
  writtenOffCents: number,
): InvoiceStatus {
  if (paidCents + writtenOffCents >= totalCents) return 'PAID'
  if (paidCents + writtenOffCents > 0) return 'PARTIAL'
  return 'ISSUED'
}

/**
 * Plan one posted row.
 *
 * Refuses rather than clamps: over-applying an invoice, spending more of a credit than
 * is left on it, reaching another customer's credit, touching a VOID or settled invoice,
 * and applying more than the cash plus the credits can cover are each an error with the
 * numbers in it. Cash left over after the applications is the row's own `unappliedCents`
 * — an overpayment is a credit, not a second model — but a credit may only be spent ON
 * an invoice, never converted into a fresh credit.
 */
export function planPayment(input: PaymentPlanInput): PaymentPlan {
  const errors: string[] = []
  const byId: Record<string, PlanInvoice> = {}
  for (const invoice of input.invoices) byId[invoice.id] = invoice
  const creditById: Record<string, PlanCredit> = {}
  for (const credit of input.credits) creditById[credit.id] = credit

  const amountCents = input.amountCents
  if (!isCents(amountCents) || amountCents < 0) {
    errors.push('The amount must be a whole number of cents, and cannot be negative')
  }

  if (input.applications.length > MAX_APPLICATIONS) {
    errors.push(`One payment covers at most ${MAX_APPLICATIONS} invoices; split it`)
  }
  if (input.creditApplications.length > MAX_CREDIT_USES) {
    errors.push(`One payment spends at most ${MAX_CREDIT_USES} credits; split it`)
  }

  // ── credits first: they are part of the funds the applications draw on ──
  const credits: PlannedCredit[] = []
  const creditSeen: Record<string, true> = {}
  let fromCreditsCents = 0
  for (const use of input.creditApplications) {
    const credit = creditById[use.paymentId]
    if (!credit) {
      errors.push(`Credit ${use.paymentId} was not found`)
      continue
    }
    if (creditSeen[use.paymentId]) {
      errors.push(`Credit ${credit.reference ?? credit.id} is listed twice`)
      continue
    }
    creditSeen[use.paymentId] = true
    if (!isCents(use.amountCents) || use.amountCents <= 0) {
      errors.push(`The amount taken from credit ${credit.reference ?? credit.id} must be a positive whole number of cents`)
      continue
    }
    if (credit.customerId !== input.customerId) {
      errors.push(`Credit ${credit.reference ?? credit.id} belongs to another customer`)
      continue
    }
    if (credit.kind === 'REVERSAL' || credit.kind === 'WRITE_OFF') {
      errors.push(`A ${credit.kind === 'REVERSAL' ? 'reversal' : 'write-off'} carries no credit to spend`)
      continue
    }
    if (credit.reversed) {
      errors.push(`Credit ${credit.reference ?? credit.id} has been reversed; its money no longer exists`)
      continue
    }
    if (use.amountCents > credit.unappliedCents) {
      errors.push(
        `Credit ${credit.reference ?? credit.id} has ${money(credit.unappliedCents)} left; ${money(use.amountCents)} was asked for`,
      )
      continue
    }
    fromCreditsCents += use.amountCents
    credits.push({
      id: credit.id,
      usedCents: use.amountCents,
      unappliedAfterCents: credit.unappliedCents - use.amountCents,
    })
  }

  // ── then the applications ──
  const invoices: PlannedInvoice[] = []
  const invoiceSeen: Record<string, true> = {}
  let appliedCents = 0
  for (const application of input.applications) {
    const invoice = byId[application.invoiceId]
    if (!invoice) {
      errors.push(`Invoice ${application.invoiceId} was not found`)
      continue
    }
    if (invoiceSeen[application.invoiceId]) {
      errors.push(`Invoice ${nameOf(invoice)} is listed twice`)
      continue
    }
    invoiceSeen[application.invoiceId] = true
    if (!isCents(application.amountCents) || application.amountCents <= 0) {
      errors.push(`The amount applied to invoice ${nameOf(invoice)} must be a positive whole number of cents`)
      continue
    }
    if (invoice.customerId !== input.customerId) {
      errors.push(`Invoice ${nameOf(invoice)} belongs to another customer`)
      continue
    }
    if (invoice.status === 'VOID') {
      errors.push(`Invoice ${nameOf(invoice)} is void and takes no payment`)
      continue
    }
    if (invoice.balanceCents <= 0) {
      errors.push(`Invoice ${nameOf(invoice)} is already settled`)
      continue
    }
    if (application.amountCents > invoice.balanceCents) {
      errors.push(
        `Invoice ${nameOf(invoice)} has ${money(invoice.balanceCents)} outstanding; ${money(application.amountCents)} was applied`,
      )
      continue
    }

    const writeOff = input.kind === 'WRITE_OFF'
    const paidCents = invoice.paidCents + (writeOff ? 0 : application.amountCents)
    const writtenOffCents = invoice.writtenOffCents + (writeOff ? application.amountCents : 0)
    const balanceCents = invoice.totalCents - paidCents - writtenOffCents
    const status = invoiceStatusAfter(invoice.totalCents, paidCents, writtenOffCents)
    appliedCents += application.amountCents
    invoices.push({
      id: invoice.id,
      appliedCents: application.amountCents,
      paidCents,
      writtenOffCents,
      balanceCents,
      status,
      becamePaid: status === 'PAID' && invoice.status !== 'PAID',
    })
  }

  const fundsCents = (isCents(amountCents) && amountCents >= 0 ? amountCents : 0) + fromCreditsCents
  if (appliedCents > fundsCents) {
    errors.push(
      `${money(appliedCents)} was applied but only ${money(fundsCents)} is available`,
    )
  }
  // A credit is spent ON an invoice. Letting it fall through to `unappliedCents` would
  // move the same money from one credit row to another and lose its history.
  if (fromCreditsCents > appliedCents) {
    errors.push('A credit can only be spent on an invoice; reduce what you take from credits')
  }

  if (input.kind === 'WRITE_OFF') {
    if (input.creditApplications.length > 0) errors.push('A write-off spends no credit')
    if (input.applications.length !== 1) errors.push('A write-off clears exactly one invoice')
    if (isCents(amountCents) && amountCents !== appliedCents) {
      errors.push('A write-off is applied in full to its invoice')
    }
  }

  if (input.kind === 'CREDIT_MEMO') {
    if (input.applications.length > 0 || input.creditApplications.length > 0) {
      errors.push('A credit memo is issued unapplied; spend it through a payment')
    }
    if (isCents(amountCents) && amountCents <= 0) errors.push('A credit memo needs an amount')
  }

  if (input.kind === 'PAYMENT' && amountCents === 0 && fromCreditsCents === 0) {
    errors.push('A payment of nothing with no credit applied does not post')
  }

  const unappliedCents = Math.max(0, fundsCents - appliedCents)
  return {
    ok: errors.length === 0,
    errors,
    appliedCents,
    fromCreditsCents,
    unappliedCents,
    invoices,
    credits,
  }
}

/** A write-off of part or all of one invoice, planned as a one-line application. */
export function writeOffPlan(invoice: PlanInvoice, amountCents: number): PaymentPlan {
  return planPayment({
    kind: 'WRITE_OFF',
    customerId: invoice.customerId,
    amountCents,
    applications: [{ invoiceId: invoice.id, amountCents }],
    creditApplications: [],
    invoices: [invoice],
    credits: [],
  })
}

/**
 * What a reversal of `payment` would restore.
 *
 * Refused once any of it has moved on: a second reversal, a credit this row left behind
 * that a later payment has already spent, or an invoice whose figures no longer contain
 * what this row put on them. The remedy in every case is to reverse the later row first,
 * which is the whole point of keeping the ledger append-only.
 */
export function reversalPlan(
  payment: Pick<
    ArPaymentRecord,
    'id' | 'customerId' | 'kind' | 'amountCents' | 'appliedCents' | 'unappliedCents' | 'applications' | 'creditApplications' | 'reversedByPaymentId'
  >,
  invoices: PlanInvoice[],
  credits: PlanCredit[],
): PaymentPlan {
  const errors: string[] = []
  const byId: Record<string, PlanInvoice> = {}
  for (const invoice of invoices) byId[invoice.id] = invoice
  const creditById: Record<string, PlanCredit> = {}
  for (const credit of credits) creditById[credit.id] = credit

  if (payment.kind === 'REVERSAL') errors.push('A reversal cannot itself be reversed')
  if (payment.reversedByPaymentId) errors.push('That row has already been reversed')

  const applications = payment.applications ?? []
  const creditApplications = payment.creditApplications ?? []
  const creditsUsedCents = creditApplications.reduce((sum, use) => sum + use.amountCents, 0)
  const expectedUnapplied = payment.amountCents + creditsUsedCents - payment.appliedCents
  if (payment.unappliedCents < expectedUnapplied) {
    errors.push(
      `${money(expectedUnapplied - payment.unappliedCents)} of this row has since been applied to another invoice; reverse that payment first`,
    )
  }

  const plannedInvoices: PlannedInvoice[] = []
  for (const application of applications) {
    const invoice = byId[application.invoiceId]
    if (!invoice) {
      errors.push(`Invoice ${application.invoiceId} was not found`)
      continue
    }
    const writeOff = payment.kind === 'WRITE_OFF'
    const paidCents = invoice.paidCents - (writeOff ? 0 : application.amountCents)
    const writtenOffCents = invoice.writtenOffCents - (writeOff ? application.amountCents : 0)
    if (paidCents < 0 || writtenOffCents < 0) {
      errors.push(`Invoice ${nameOf(invoice)} no longer carries the ${money(application.amountCents)} this row put on it`)
      continue
    }
    if (invoice.status === 'VOID') {
      errors.push(`Invoice ${nameOf(invoice)} is void; there is nothing to restore`)
      continue
    }
    const status = invoiceStatusAfter(invoice.totalCents, paidCents, writtenOffCents)
    plannedInvoices.push({
      id: invoice.id,
      appliedCents: -application.amountCents,
      paidCents,
      writtenOffCents,
      balanceCents: invoice.totalCents - paidCents - writtenOffCents,
      status,
      becamePaid: false,
    })
  }

  const plannedCredits: PlannedCredit[] = []
  for (const use of creditApplications) {
    const credit = creditById[use.paymentId]
    if (!credit) {
      errors.push(`Credit ${use.paymentId} was not found`)
      continue
    }
    plannedCredits.push({
      id: credit.id,
      usedCents: -use.amountCents,
      unappliedAfterCents: credit.unappliedCents + use.amountCents,
    })
  }

  return {
    ok: errors.length === 0,
    errors,
    appliedCents: -payment.appliedCents,
    fromCreditsCents: -creditsUsedCents,
    unappliedCents: 0,
    invoices: plannedInvoices,
    credits: plannedCredits,
  }
}

/**
 * Where a cheque most likely goes: an invoice whose balance is exactly the amount,
 * otherwise the oldest-due invoices until the money runs out.
 *
 * A suggestion the person confirms, never an application. The exact match comes first
 * because a customer paying one invoice is the common case and oldest-first would
 * silently split it across two.
 */
export function suggestAllocation(
  amountCents: number,
  openInvoices: PlanInvoice[],
  dueAtById: Record<string, string> = {},
): PaymentApplication[] {
  if (!isCents(amountCents) || amountCents <= 0) return []
  const open = openInvoices.filter((i) => i.status !== 'VOID' && i.balanceCents > 0)
  const exact = open.find((i) => i.balanceCents === amountCents)
  if (exact) return [{ invoiceId: exact.id, amountCents }]

  const oldestFirst = [...open].sort((a, b) => {
    const left = dueAtById[a.id] ?? ''
    const right = dueAtById[b.id] ?? ''
    if (left !== right) return left < right ? -1 : 1
    return a.id < b.id ? -1 : 1
  })

  const applications: PaymentApplication[] = []
  let remaining = amountCents
  for (const invoice of oldestFirst) {
    if (remaining <= 0) break
    const take = Math.min(remaining, invoice.balanceCents)
    applications.push({ invoiceId: invoice.id, amountCents: take })
    remaining -= take
  }
  return applications
}
