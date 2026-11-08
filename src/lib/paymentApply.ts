/**
 * The arithmetic behind every posted cash row: what a payment may be applied to, what
 * the document it settles looks like afterwards, and what a reversal is allowed to take
 * back.
 *
 * Pure and total. The Lambda runs this first and refuses on `ok === false` before it
 * opens a transaction; the Receive-payment dialog runs the same function on every
 * keystroke, so the dialog's arithmetic and the ledger's arithmetic cannot disagree.
 * Every amount is integer cents — a non-integer or a negative is an error, never a
 * value to round.
 *
 * One planner serves both sides of the ledger: AR applies cash to invoices owed by a
 * customer, AP applies cash to bills owed to a carrier, and the money moves identically
 * in both directions. Only the words differ, so the caller passes a `vocabulary` and
 * every refusal reads as the side it came from. `offsetCents` is the non-cash half of a
 * settlement — written off in AR, credited in AP.
 *
 * Relative imports, not `@/`: tms-finance-actions bundles this file by path and the
 * alias does not exist in the function build.
 */
import type {
  CreditApplication,
  InvoiceStatus,
} from '../types/tms'

/** Every kind of row that can sit in a cash ledger, on either side. */
export type LedgerKind = 'PAYMENT' | 'CREDIT_MEMO' | 'WRITE_OFF' | 'REVERSAL'

/** The nouns a refusal is written with. AP passes `{ party: 'carrier', document: 'bill' }`. */
export interface PlanVocabulary {
  party: string
  document: string
}

/** What the planner needs to know about one document it may settle. */
export interface PlanDocument {
  id: string
  partyId: string
  totalCents: number
  paidCents: number
  /** Settled other than by cash on this side: written off in AR, credited in AP. */
  offsetCents: number
  balanceCents: number
  /** A voided document takes no money, in either direction. */
  voided?: boolean
  number?: string | null
}

/** An earlier row with money left on it: an unspent credit memo or an overpayment. */
export interface PlanCredit {
  id: string
  partyId: string
  kind: LedgerKind
  unappliedCents: number
  reference?: string | null
  /** Set once a REVERSAL has taken this row back. Its money no longer exists. */
  reversed?: boolean
}

/** Money from this row put against one document. */
export interface PlanApplication {
  documentId: string
  amountCents: number
}

export interface PaymentPlanInput {
  kind: LedgerKind
  partyId: string
  amountCents: number
  applications: PlanApplication[]
  creditApplications: CreditApplication[]
  documents: PlanDocument[]
  credits: PlanCredit[]
  vocabulary?: PlanVocabulary
}

/** One document as it will stand after the row posts. */
export interface PlannedDocument {
  id: string
  /** What this row puts against it. */
  appliedCents: number
  paidCents: number
  offsetCents: number
  balanceCents: number
  /** Nothing is owed any more, however it got there. */
  settled: boolean
  /**
   * The balance reached zero HERE, so the order moves to PAID and the open-index key is
   * removed. Structural rather than a status comparison: a zero balance is PAID on both
   * sides of the ledger, so `settled && prior balance > 0` says exactly what
   * `status === 'PAID' && prior status !== 'PAID'` used to say in AR.
   */
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
  /** Put against documents, from cash and credits together. */
  appliedCents: number
  fromCreditsCents: number
  /** Cash left over — kept on the row as credit for the party. */
  unappliedCents: number
  documents: PlannedDocument[]
  credits: PlannedCredit[]
}

const MAX_APPLICATIONS = 40
const MAX_CREDIT_USES = 10

const DEFAULT_VOCABULARY: PlanVocabulary = { party: 'customer', document: 'invoice' }

function isCents(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function money(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`
}

function nameOf(doc: PlanDocument): string {
  return doc.number ?? doc.id
}

/**
 * The status an invoice carries for a given set of totals.
 *
 * A write-off settles an invoice exactly as cash does: `balance = total - paid - written
 * off`, and a zero balance is PAID however it got there. AR only — AP bills carry their
 * own status ladder, which has an approval rung this one does not.
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
 * Refuses rather than clamps: over-applying a document, spending more of a credit than
 * is left on it, reaching another party's credit, touching a voided or settled document,
 * and applying more than the cash plus the credits can cover are each an error with the
 * numbers in it. Cash left over after the applications is the row's own `unappliedCents`
 * — an overpayment is a credit, not a second model — but a credit may only be spent ON
 * a document, never converted into a fresh credit.
 */
export function planPayment(input: PaymentPlanInput): PaymentPlan {
  const vocab = input.vocabulary ?? DEFAULT_VOCABULARY
  // Sentence-leading form of the noun: "invoice" → "Invoice", "bill" → "Bill".
  const Doc = vocab.document.charAt(0).toUpperCase() + vocab.document.slice(1)
  const errors: string[] = []
  const byId: Record<string, PlanDocument> = {}
  for (const doc of input.documents) byId[doc.id] = doc
  const creditById: Record<string, PlanCredit> = {}
  for (const credit of input.credits) creditById[credit.id] = credit

  const amountCents = input.amountCents
  if (!isCents(amountCents) || amountCents < 0) {
    errors.push('The amount must be a whole number of cents, and cannot be negative')
  }

  if (input.applications.length > MAX_APPLICATIONS) {
    errors.push(`One payment covers at most ${MAX_APPLICATIONS} ${vocab.document}s; split it`)
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
    if (credit.partyId !== input.partyId) {
      errors.push(`Credit ${credit.reference ?? credit.id} belongs to another ${vocab.party}`)
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
  const documents: PlannedDocument[] = []
  const documentSeen: Record<string, true> = {}
  let appliedCents = 0
  for (const application of input.applications) {
    const doc = byId[application.documentId]
    if (!doc) {
      errors.push(`${Doc} ${application.documentId} was not found`)
      continue
    }
    if (documentSeen[application.documentId]) {
      errors.push(`${Doc} ${nameOf(doc)} is listed twice`)
      continue
    }
    documentSeen[application.documentId] = true
    if (!isCents(application.amountCents) || application.amountCents <= 0) {
      errors.push(`The amount applied to ${vocab.document} ${nameOf(doc)} must be a positive whole number of cents`)
      continue
    }
    if (doc.partyId !== input.partyId) {
      errors.push(`${Doc} ${nameOf(doc)} belongs to another ${vocab.party}`)
      continue
    }
    if (doc.voided) {
      errors.push(`${Doc} ${nameOf(doc)} is void and takes no payment`)
      continue
    }
    if (doc.balanceCents <= 0) {
      errors.push(`${Doc} ${nameOf(doc)} is already settled`)
      continue
    }
    if (application.amountCents > doc.balanceCents) {
      errors.push(
        `${Doc} ${nameOf(doc)} has ${money(doc.balanceCents)} outstanding; ${money(application.amountCents)} was applied`,
      )
      continue
    }

    const writeOff = input.kind === 'WRITE_OFF'
    const paidCents = doc.paidCents + (writeOff ? 0 : application.amountCents)
    const offsetCents = doc.offsetCents + (writeOff ? application.amountCents : 0)
    const balanceCents = doc.totalCents - paidCents - offsetCents
    const settled = balanceCents <= 0
    appliedCents += application.amountCents
    documents.push({
      id: doc.id,
      appliedCents: application.amountCents,
      paidCents,
      offsetCents,
      balanceCents,
      settled,
      becamePaid: settled && doc.balanceCents > 0,
    })
  }

  const fundsCents = (isCents(amountCents) && amountCents >= 0 ? amountCents : 0) + fromCreditsCents
  if (appliedCents > fundsCents) {
    errors.push(
      `${money(appliedCents)} was applied but only ${money(fundsCents)} is available`,
    )
  }
  // A credit is spent ON a document. Letting it fall through to `unappliedCents` would
  // move the same money from one credit row to another and lose its history.
  if (fromCreditsCents > appliedCents) {
    const an = /^[aeiou]/i.test(vocab.document) ? 'an' : 'a'
    errors.push(`A credit can only be spent on ${an} ${vocab.document}; reduce what you take from credits`)
  }

  if (input.kind === 'WRITE_OFF') {
    if (input.creditApplications.length > 0) errors.push('A write-off spends no credit')
    if (input.applications.length !== 1) errors.push(`A write-off clears exactly one ${vocab.document}`)
    if (isCents(amountCents) && amountCents !== appliedCents) {
      errors.push(`A write-off is applied in full to its ${vocab.document}`)
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
    documents,
    credits,
  }
}

/**
 * A write-off of part or all of one invoice, planned as a one-line application.
 *
 * AR only: AP settles a bill short with a credit memo against the carrier, which is a
 * row of its own rather than an adjustment to the bill.
 */
export function writeOffPlan(document: PlanDocument, amountCents: number): PaymentPlan {
  return planPayment({
    kind: 'WRITE_OFF',
    partyId: document.partyId,
    amountCents,
    applications: [{ documentId: document.id, amountCents }],
    creditApplications: [],
    documents: [document],
    credits: [],
  })
}

/**
 * What a reversal of `payment` would restore.
 *
 * Refused once any of it has moved on: a second reversal, a credit this row left behind
 * that a later payment has already spent, or a document whose figures no longer contain
 * what this row put on them. The remedy in every case is to reverse the later row first,
 * which is the whole point of keeping the ledger append-only.
 */
export function reversalPlan(
  payment: {
    id: string
    partyId: string
    kind: LedgerKind
    amountCents: number
    appliedCents: number
    unappliedCents: number
    applications: PlanApplication[]
    creditApplications: CreditApplication[]
    reversedByPaymentId?: string | null
  },
  documents: PlanDocument[],
  credits: PlanCredit[],
  vocabulary?: PlanVocabulary,
): PaymentPlan {
  const vocab = vocabulary ?? DEFAULT_VOCABULARY
  const Doc = vocab.document.charAt(0).toUpperCase() + vocab.document.slice(1)
  const errors: string[] = []
  const byId: Record<string, PlanDocument> = {}
  for (const doc of documents) byId[doc.id] = doc
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
      `${money(expectedUnapplied - payment.unappliedCents)} of this row has since been applied to another ${vocab.document}; reverse that payment first`,
    )
  }

  const plannedDocuments: PlannedDocument[] = []
  for (const application of applications) {
    const doc = byId[application.documentId]
    if (!doc) {
      errors.push(`${Doc} ${application.documentId} was not found`)
      continue
    }
    const writeOff = payment.kind === 'WRITE_OFF'
    const paidCents = doc.paidCents - (writeOff ? 0 : application.amountCents)
    const offsetCents = doc.offsetCents - (writeOff ? application.amountCents : 0)
    if (paidCents < 0 || offsetCents < 0) {
      errors.push(`${Doc} ${nameOf(doc)} no longer carries the ${money(application.amountCents)} this row put on it`)
      continue
    }
    if (doc.voided) {
      errors.push(`${Doc} ${nameOf(doc)} is void; there is nothing to restore`)
      continue
    }
    const balanceCents = doc.totalCents - paidCents - offsetCents
    plannedDocuments.push({
      id: doc.id,
      appliedCents: -application.amountCents,
      paidCents,
      offsetCents,
      balanceCents,
      settled: balanceCents <= 0,
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
    documents: plannedDocuments,
    credits: plannedCredits,
  }
}

/**
 * Where a cheque most likely goes: a document whose balance is exactly the amount,
 * otherwise the oldest-due documents until the money runs out.
 *
 * A suggestion the person confirms, never an application. The exact match comes first
 * because a party paying one document is the common case and oldest-first would
 * silently split it across two.
 */
export function suggestAllocation(
  amountCents: number,
  openDocuments: PlanDocument[],
  dueAtById: Record<string, string> = {},
): PlanApplication[] {
  if (!isCents(amountCents) || amountCents <= 0) return []
  const open = openDocuments.filter((doc) => !doc.voided && doc.balanceCents > 0)
  const exact = open.find((doc) => doc.balanceCents === amountCents)
  if (exact) return [{ documentId: exact.id, amountCents }]

  const oldestFirst = [...open].sort((a, b) => {
    const left = dueAtById[a.id] ?? ''
    const right = dueAtById[b.id] ?? ''
    if (left !== right) return left < right ? -1 : 1
    return a.id < b.id ? -1 : 1
  })

  const applications: PlanApplication[] = []
  let remaining = amountCents
  for (const doc of oldestFirst) {
    if (remaining <= 0) break
    const take = Math.min(remaining, doc.balanceCents)
    applications.push({ documentId: doc.id, amountCents: take })
    remaining -= take
  }
  return applications
}
