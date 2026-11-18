/**
 * Which AP payments and bills are "paid outside BCAT Ops" (Ryne 2026-11-18).
 *
 * Everything paid on or before the cut-off (a Chicago calendar day) happened before the system was live: the Aljex
 * carry-over, the AR/AP sheet and the manual entries that mirror them. Those payment rows are archived (hidden from the
 * Paid and Payments views, kept in the table, reversible) and the bills they settled stay PAID with a $0 balance, so Open
 * AP, Aging, Selected and Expected do not move.
 *
 * What is NOT archived, on purpose:
 *  - a bill on the static "Verify payment" list (Aljex says paid, Ryne has not paid it) and every payment that touches
 *    one: they still need a person, so the whole group stays visible;
 *  - a payment that is reversed, or that reverses another, and anything linked to one by a credit application;
 *  - a payment applied to a bill that is still open (a partly paid bill keeps the payments behind its balance);
 *  - a credit memo that still has money left to spend;
 *  - reversal rows themselves.
 * A bill is archived only if it is PAID, was paid on or before the cut-off (its `paidAt` day, else its bill date, the
 * way the Paid tab files it), is not on the verify list, and every payment that settled it is archived too.
 *
 * Pure: the Lambda reads the book and writes the plan; the tests and the dry run read the same function.
 */
import { chicagoDateStr } from './date'
import { proKey } from './verifyPayment'

export interface ArchivePayment {
  id: string
  kind: string
  paidAt: string
  amountCents?: number | null
  unappliedCents?: number | null
  loadCarrierId?: string | null
  applications?: { billId: string; amountCents?: number }[] | null
  creditApplications?: { paymentId: string; amountCents?: number }[] | null
  reversesPaymentId?: string | null
  reversedByPaymentId?: string | null
  archivedAt?: string | null
}

export interface ArchiveBill {
  id: string
  status: string
  paidAt?: string | null
  billDate: string
  shipmentNumber?: string | null
  loadCarrierId?: string | null
  archivedAt?: string | null
}

export interface ArchivePlan {
  cutoff: string
  /** Payments and credit memos to archive now (not already archived). */
  paymentIds: string[]
  /** PAID bills to archive now (not already archived). */
  billIds: string[]
  /** Payments that stay visible and why. */
  keptPayments: { id: string; why: 'VERIFY_GROUP' | 'REVERSAL_LINK' | 'OPEN_BILL' | 'LIVE_CREDIT' | 'REVERSAL_ROW' }[]
  /** PAID bills on or before the cut-off that stay visible and why. */
  keptBills: { id: string; why: 'VERIFY' | 'PAYMENT_KEPT' }[]
  /** Payments already archived (a re-run counts them as archivable when it decides on a bill). */
  alreadyArchivedPayments: number
  alreadyArchivedBills: number
}

export function archiveReason(cutoff: string): string {
  return `Paid outside BCAT Ops (on or before ${cutoff})`
}

/** The day a bill was settled on the Chicago calendar, the Paid tab's rule: `paidAt`, else the bill date. */
export function billPaidDay(bill: Pick<ArchiveBill, 'paidAt' | 'billDate'>): string {
  return bill.paidAt ? chicagoDateStr(bill.paidAt) : bill.billDate.slice(0, 10)
}

export function planApArchive(input: {
  payments: readonly ArchivePayment[]
  bills: readonly ArchiveBill[]
  /** 'YYYY-MM-DD', inclusive, on the Chicago calendar. */
  cutoff: string
  verifyPros: ReadonlySet<string>
}): ArchivePlan {
  const { payments, bills, cutoff, verifyPros } = input
  const billById = new Map(bills.map((b) => [b.id, b]))
  const paymentById = new Map(payments.map((p) => [p.id, p]))
  const billsByLoadCarrier = new Map<string, string[]>()
  for (const b of bills) {
    if (!b.loadCarrierId) continue
    const list = billsByLoadCarrier.get(b.loadCarrierId) ?? []
    list.push(b.id)
    billsByLoadCarrier.set(b.loadCarrierId, list)
  }
  const verifyBills = new Set(bills.filter((b) => b.status !== 'VOID' && verifyPros.has(proKey(b.shipmentNumber))).map((b) => b.id))

  /** Every bill a money row settles: its applications, plus every bill of its leg for a credit raised against a leg. */
  const billsOf = (p: ArchivePayment): Set<string> => {
    const ids = new Set<string>((p.applications ?? []).map((a) => a.billId))
    if (p.loadCarrierId) for (const id of billsByLoadCarrier.get(p.loadCarrierId) ?? []) ids.add(id)
    return ids
  }

  const why = new Map<string, ArchivePlan['keptPayments'][number]['why']>()
  const keep = (id: string, reason: ArchivePlan['keptPayments'][number]['why']) => { if (!why.has(id)) why.set(id, reason) }
  for (const p of payments) {
    if (p.kind === 'REVERSAL') { keep(p.id, 'REVERSAL_ROW'); continue }
    const settled = billsOf(p)
    if ([...settled].some((id) => verifyBills.has(id))) keep(p.id, 'VERIFY_GROUP')
    if ([...settled].some((id) => { const b = billById.get(id); return b && b.status !== 'PAID' && b.status !== 'VOID' })) keep(p.id, 'OPEN_BILL')
    if (p.reversesPaymentId || p.reversedByPaymentId) keep(p.id, 'REVERSAL_LINK')
    if (p.kind === 'CREDIT_MEMO' && (p.unappliedCents ?? 0) > 0) keep(p.id, 'LIVE_CREDIT')
  }
  // A payment linked to a kept one (credit application or reversal) is kept with it, to a fixpoint.
  const links = new Map<string, Set<string>>()
  const link = (a: string, b: string) => {
    if (!links.has(a)) links.set(a, new Set())
    if (!links.has(b)) links.set(b, new Set())
    links.get(a)!.add(b)
    links.get(b)!.add(a)
  }
  for (const p of payments) {
    for (const c of p.creditApplications ?? []) link(p.id, c.paymentId)
    if (p.reversesPaymentId) link(p.id, p.reversesPaymentId)
    if (p.reversedByPaymentId) link(p.id, p.reversedByPaymentId)
  }
  const queue = [...why.keys()].filter((id) => why.get(id) !== 'REVERSAL_ROW')
  while (queue.length > 0) {
    const id = queue.pop()!
    const reason = why.get(id)!
    for (const next of links.get(id) ?? []) {
      if (why.has(next)) continue
      why.set(next, reason === 'VERIFY_GROUP' ? 'VERIFY_GROUP' : 'REVERSAL_LINK')
      queue.push(next)
    }
  }

  const eligible = (p: ArchivePayment) => !why.has(p.id) && chicagoDateStr(p.paidAt) <= cutoff
  const archivable = new Set<string>()
  let alreadyArchivedPayments = 0
  for (const p of payments) {
    if (p.archivedAt) { alreadyArchivedPayments += 1; archivable.add(p.id); continue }
    if (eligible(p)) archivable.add(p.id)
  }

  // Every payment that settled each bill, to decide the bill.
  const refs = new Map<string, string[]>()
  for (const p of payments) for (const id of billsOf(p)) {
    const list = refs.get(id) ?? []
    list.push(p.id)
    refs.set(id, list)
  }
  const billIds: string[] = []
  const keptBills: ArchivePlan['keptBills'] = []
  let alreadyArchivedBills = 0
  for (const b of bills) {
    if (b.status !== 'PAID') continue
    if (b.archivedAt) { alreadyArchivedBills += 1; continue }
    if (billPaidDay(b) > cutoff) continue
    if (verifyBills.has(b.id)) { keptBills.push({ id: b.id, why: 'VERIFY' }); continue }
    if ((refs.get(b.id) ?? []).some((id) => !archivable.has(id))) { keptBills.push({ id: b.id, why: 'PAYMENT_KEPT' }); continue }
    billIds.push(b.id)
  }

  return {
    cutoff,
    paymentIds: payments.filter((p) => !p.archivedAt && eligible(p)).map((p) => p.id),
    billIds,
    keptPayments: [...why.entries()]
      .filter(([id]) => { const p = paymentById.get(id); return p ? !p.archivedAt && (p.kind === 'REVERSAL' || chicagoDateStr(p.paidAt) <= cutoff) : false })
      .map(([id, reason]) => ({ id, why: reason })),
    keptBills,
    alreadyArchivedPayments,
    alreadyArchivedBills,
  }
}
