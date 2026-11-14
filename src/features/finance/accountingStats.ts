/**
 * The per-tab cards on Receivable and Payable (Ryne 2026-11-14): what each tab holds, where its
 * money sits, and who it is with. Pure: the pages pass the rows they already show, so a card
 * always agrees with the table under it. Due buckets come from `summarizeOwed` and days to pay
 * from `@/lib/daysToPay`, the same definitions the filters and the Paid tab use.
 */
import type { ArQueueRow } from '@/features/ar/arQueue'
import type { FactorReadiness } from '@/features/ar/useFactorReadiness'
import { summarizeOwed, type OwedSummary } from '@/features/ar/owedFilters'
import { averageDaysToPay, settlementOf, type InvoicePaymentLine } from '@/lib/daysToPay'
import { CAR_SHIPPING_DIVISION } from '@/lib/carShipper'
import type { BillFactsIndex } from '@/features/ap/apQueue'
import type { FinanceReviewShipment } from '@/lib/apiClient'
import type { ApPaymentMethod, ApPaymentRecord, CarrierBillRecord, InvoiceRecord, LaneRateSampleRecord } from '@/types/tms'

export interface Money { count: number; cents: number }
export interface PartyMoney extends Money { id: string; name: string }

const DAY_MS = 86_400_000
const dayNum = (iso: string | null | undefined): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '')
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS : null
}
const daysSince = (iso: string | null | undefined, asOf: string): number | null => {
  const from = dayNum(iso)
  const to = dayNum(asOf)
  return from == null || to == null ? null : Math.max(0, to - from)
}
const mean1 = (xs: number[]): number | null => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null)

/** The biggest open balances by party, largest first. */
export function topParties<T>(items: readonly T[], of: (item: T) => { id: string | null | undefined; name: string | null | undefined; cents: number }, limit = 5): PartyMoney[] {
  const byId = new Map<string, PartyMoney>()
  for (const item of items) {
    const { id, name, cents } = of(item)
    if (!id || !(cents > 0)) continue
    const p = byId.get(id) ?? { id, name: name || id, count: 0, cents: 0 }
    p.count += 1
    p.cents += cents
    byId.set(id, p)
  }
  return [...byId.values()].sort((a, b) => b.cents - a.cents).slice(0, limit)
}

// ── Receivable ──────────────────────────────────────────────────────────────

export interface ArReadyStats {
  total: Money
  /** Factor-billed rows the readiness check passed / failed; null until readiness has answered. */
  factorReady: number | null
  factorMissing: number | null
  /** Days the oldest row has waited since it was moved to billing (or delivered). */
  oldestDays: number | null
}

export function arReadyStats(rows: readonly ArQueueRow[], readiness: ReadonlyMap<string, FactorReadiness>, asOf: string): ArReadyStats {
  let ready = 0
  let missing = 0
  let answered = 0
  let oldest: number | null = null
  for (const row of rows) {
    const r = readiness.get(row.key)
    if (r) {
      answered += 1
      if (r.factorBilled) { if (r.ready) ready += 1; else missing += 1 }
    }
    const d = daysSince(row.releasedAt ?? row.deliveredAt, asOf)
    if (d != null && (oldest == null || d > oldest)) oldest = d
  }
  return {
    total: { count: rows.length, cents: rows.reduce((s, r) => s + r.amountCents, 0) },
    factorReady: answered ? ready : null,
    factorMissing: answered ? missing : null,
    oldestDays: oldest,
  }
}

export interface ArInvoicedStats {
  owed: OwedSummary
  partial: Money
  top: PartyMoney[]
}

export function arInvoicedStats(rows: readonly ArQueueRow[], asOf: string): ArInvoicedStats {
  const partialRows = rows.filter((r) => r.shortPaid)
  return {
    owed: summarizeOwed(rows, asOf),
    partial: { count: partialRows.length, cents: partialRows.reduce((s, r) => s + r.balanceCents, 0) },
    top: topParties(rows, (r) => ({ id: r.customerId, name: r.customerName, cents: r.balanceCents })),
  }
}

export interface ArPaidStats {
  collected: Money
  ach: Money
  check: Money
  other: Money
  avgDaysToPay: number | null
  /** Customers by their average days to pay over the rows shown; needs at least one measured invoice. */
  fastest: { name: string; days: number } | null
  slowest: { name: string; days: number } | null
}

export function arPaidStats(rows: readonly ArQueueRow[], linesByInvoice: ReadonlyMap<string, InvoicePaymentLine[]>): ArPaidStats {
  const ach: Money = { count: 0, cents: 0 }
  const check: Money = { count: 0, cents: 0 }
  const other: Money = { count: 0, cents: 0 }
  const settlements = []
  const byCustomer = new Map<string, { name: string; days: number[] }>()
  for (const row of rows) {
    if (!row.invoice) continue
    const s = settlementOf(row.invoice, linesByInvoice.get(row.invoice.id))
    settlements.push(s)
    const bucket = s.method === 'ACH' ? ach : s.method === 'CHECK' ? check : other
    bucket.count += 1
    bucket.cents += row.amountCents
    if (s.daysToPay != null && row.customerId) {
      const c = byCustomer.get(row.customerId) ?? { name: row.customerName, days: [] }
      c.days.push(s.daysToPay)
      byCustomer.set(row.customerId, c)
    }
  }
  const ranked = [...byCustomer.values()]
    .map((c) => ({ name: c.name, days: mean1(c.days) ?? 0 }))
    .sort((a, b) => a.days - b.days || a.name.localeCompare(b.name))
  return {
    collected: { count: rows.length, cents: rows.reduce((s, r) => s + r.amountCents, 0) },
    ach,
    check,
    other,
    avgDaysToPay: averageDaysToPay(settlements).averageDays,
    fastest: ranked[0] ?? null,
    slowest: ranked.length > 1 ? ranked[ranked.length - 1] : null,
  }
}

// ── Needs review (both sides) ───────────────────────────────────────────────

export type ReviewReasonKey = 'rate' | 'payTo' | 'carrier' | 'delivered' | 'duplicate' | 'conflict' | 'revenue' | 'other'

export const REVIEW_REASON_LABEL: Record<ReviewReasonKey, string> = {
  rate: 'Missing customer rate',
  payTo: 'Missing carrier pay-to',
  carrier: 'No carrier',
  delivered: 'Missing delivered date',
  duplicate: 'Possible duplicate',
  conflict: 'Sheet vs system conflict',
  revenue: 'No customer revenue',
  other: 'Other',
}

/** The kinds of problem a review reason names; a reason can name more than one. */
export function reviewReasonKeys(reason: string | null | undefined): ReviewReasonKey[] {
  const r = (reason ?? '').toLowerCase()
  const out: ReviewReasonKey[] = []
  if (/customer rate|\$0 rate|0 rate/.test(r)) out.push('rate')
  if (/pay-?to/.test(r)) out.push('payTo')
  if (/no carrier(?! pay-?to)/.test(r)) out.push('carrier')
  if (/delivered date/.test(r)) out.push('delivered')
  if (/duplicate/.test(r)) out.push('duplicate')
  if (/conflict|sheet .*system|system .*sheet/.test(r)) out.push('conflict')
  if (/no customer revenue/.test(r)) out.push('revenue')
  return out.length ? out : ['other']
}

export function reviewReasonCounts(rows: readonly FinanceReviewShipment[]): { key: ReviewReasonKey; count: number }[] {
  const counts = new Map<ReviewReasonKey, number>()
  for (const row of rows) for (const k of reviewReasonKeys(row.financeReviewReason)) counts.set(k, (counts.get(k) ?? 0) + 1)
  return (Object.keys(REVIEW_REASON_LABEL) as ReviewReasonKey[])
    .filter((k) => counts.has(k))
    .map((k) => ({ key: k, count: counts.get(k) ?? 0 }))
}

// ── Payable ─────────────────────────────────────────────────────────────────

export interface ApExpectedStats {
  total: Money
  /** Bills whose shipment is flagged in Needs review. */
  needsFix: Money
  oldestDays: number | null
}

export function apExpectedStats(bills: readonly CarrierBillRecord[], flagged: { has(shipmentId: string): boolean }, asOf: string): ApExpectedStats {
  const fix = bills.filter((b) => flagged.has(b.shipmentId))
  let oldest: number | null = null
  for (const b of bills) {
    const d = daysSince(b.recordedAt, asOf)
    if (d != null && (oldest == null || d > oldest)) oldest = d
  }
  const sum = (bs: readonly CarrierBillRecord[]): Money => ({ count: bs.length, cents: bs.reduce((s, b) => s + b.balanceCents, 0) })
  return { total: sum(bills), needsFix: sum(fix), oldestDays: oldest }
}

export interface ApAgingStats {
  owed: OwedSummary
  top: PartyMoney[]
}

export function apAgingStats(bills: readonly CarrierBillRecord[], asOf: string): ApAgingStats {
  return {
    owed: summarizeOwed(bills, asOf),
    top: topParties(bills, (b) => ({ id: b.carrierId, name: b.carrierName, cents: b.balanceCents })),
  }
}

export interface ApPaidStats {
  paid: Money
  ach: Money
  check: Money
  /** Other methods, or a bill with no payment row (marked paid by import). */
  other: Money
  /** Delivery → paid, in days: car shipping (2-day target) and everything else. */
  carAvgDays: number | null
  carCount: number
  otherAvgDays: number | null
  otherCount: number
}

export function apPaidStats(bills: readonly CarrierBillRecord[], facts: BillFactsIndex, lines: ReadonlyMap<string, BillPaymentLine> = new Map()): ApPaidStats {
  const car: number[] = []
  const other: number[] = []
  const ach: Money = { count: 0, cents: 0 }
  const check: Money = { count: 0, cents: 0 }
  const otherMethod: Money = { count: 0, cents: 0 }
  for (const b of bills) {
    const m = lines.get(b.id)?.method
    const bucket = m === 'ACH' ? ach : m === 'CHECK' ? check : otherMethod
    bucket.count += 1
    bucket.cents += b.paidCents || b.netCents || 0
    const f = facts.get(b.shipmentId)
    const from = dayNum(f?.deliveredAt)
    const to = dayNum(b.paidAt)
    if (from == null || to == null || to < from) continue
    const d = to - from
    if (f?.revDivision === CAR_SHIPPING_DIVISION || b.divisionKey?.startsWith(CAR_SHIPPING_DIVISION)) car.push(d)
    else other.push(d)
  }
  return {
    paid: { count: bills.length, cents: bills.reduce((s, b) => s + (b.paidCents || b.netCents || 0), 0) },
    ach,
    check,
    other: otherMethod,
    carAvgDays: mean1(car),
    carCount: car.length,
    otherAvgDays: mean1(other),
    otherCount: other.length,
  }
}

// ── Profit check (both pages) ───────────────────────────────────────────────

export interface ProfitCheck {
  loads: number
  revenueCents: number
  costCents: number
  profitCents: number
  /** Basis points; null with no revenue (no margin is a different fact from zero margin). */
  marginBps: number | null
  negative: { shipmentNumber: string; profitCents: number }[]
}

/** Month-to-date margin from the lane samples (one per load), excluded samples left out. */
export function profitCheck(samples: readonly LaneRateSampleRecord[]): ProfitCheck {
  let revenueCents = 0
  let costCents = 0
  let loads = 0
  const negative: ProfitCheck['negative'] = []
  const seen = new Set<string>()
  for (const s of samples) {
    if (s.excluded || seen.has(s.loadId)) continue
    seen.add(s.loadId)
    loads += 1
    const rev = s.revenueCents ?? 0
    const cost = s.costCents ?? 0
    revenueCents += rev
    costCents += cost
    const profit = s.profitCents ?? rev - cost
    if (profit < 0) negative.push({ shipmentNumber: s.shipmentNumber ?? s.shipmentId, profitCents: profit })
  }
  const profitCents = revenueCents - costCents
  negative.sort((a, b) => a.profitCents - b.profitCents)
  return { loads, revenueCents, costCents, profitCents, marginBps: revenueCents ? Math.round((profitCents * 10_000) / revenueCents) : null, negative }
}

// ── Billing mismatches (profit check) ───────────────────────────────────────

export interface MismatchRow {
  shipmentId: string
  shipmentNumber: string
  customerName: string
  carrierName: string
  invoiceNumber: string | null
  invoiceCents: number | null
  paidOn: string | null
  billCents: number
  billStatus: string
  billDueOrPaid: string | null
}

export interface BillingMismatches {
  /** The customer has paid the invoice in full and the carrier bill is still open. */
  customerPaidCarrierUnpaid: MismatchRow[]
  /** The carrier bill is paid and no live invoice exists for the shipment. */
  carrierPaidNotBilled: MismatchRow[]
}

const LIVE_INVOICE = (inv: { status: string }) => inv.status !== 'VOID'
const ymd10 = (iso: string | null | undefined) => (iso ?? '').slice(0, 10) || null

/**
 * The two ways the money on one load can be out of step. `invoices` should reach back far
 * enough to hold the invoice of any bill in `paidBills` (the loader reads a year).
 */
export function billingMismatches(input: {
  openInvoices: readonly InvoiceRecord[]
  invoices: readonly InvoiceRecord[]
  openBills: readonly CarrierBillRecord[]
  paidBills: readonly CarrierBillRecord[]
}): BillingMismatches {
  const byShipment = new Map<string, InvoiceRecord>()
  for (const inv of [...input.invoices, ...input.openInvoices]) {
    if (!LIVE_INVOICE(inv)) continue
    const cur = byShipment.get(inv.shipmentId)
    // A paid invoice wins over an older open one for the same load.
    if (!cur || (inv.status === 'PAID' && cur.status !== 'PAID')) byShipment.set(inv.shipmentId, inv)
  }
  const row = (b: CarrierBillRecord, inv: InvoiceRecord | undefined, when: string | null): MismatchRow => ({
    shipmentId: b.shipmentId,
    shipmentNumber: b.shipmentNumber ?? inv?.shipmentNumber ?? b.shipmentId,
    customerName: inv?.customerName ?? '',
    carrierName: b.carrierName ?? '',
    invoiceNumber: inv?.number ?? null,
    invoiceCents: inv?.totalCents ?? null,
    paidOn: ymd10(inv?.paidAt),
    billCents: b.status === 'PAID' ? (b.paidCents || b.netCents) : b.balanceCents,
    billStatus: b.datesPending ? 'Expected' : b.status,
    billDueOrPaid: when,
  })
  const customerPaidCarrierUnpaid: MismatchRow[] = []
  for (const b of input.openBills) {
    if (b.status === 'PAID' || b.status === 'VOID' || !(b.balanceCents > 0)) continue
    const inv = byShipment.get(b.shipmentId)
    if (inv?.status === 'PAID') customerPaidCarrierUnpaid.push(row(b, inv, ymd10(b.dueAt)))
  }
  const carrierPaidNotBilled: MismatchRow[] = []
  const seen = new Set<string>()
  for (const b of input.paidBills) {
    if (b.status !== 'PAID' || seen.has(b.id) || byShipment.has(b.shipmentId)) continue
    seen.add(b.id)
    carrierPaidNotBilled.push(row(b, undefined, ymd10(b.paidAt)))
  }
  const byPro = (a: MismatchRow, b: MismatchRow) => a.shipmentNumber.localeCompare(b.shipmentNumber)
  return { customerPaidCarrierUnpaid: customerPaidCarrierUnpaid.sort(byPro), carrierPaidNotBilled: carrierPaidNotBilled.sort(byPro) }
}

// ── AP payment method ───────────────────────────────────────────────────────

export interface BillPaymentLine { method: ApPaymentMethod | null; reference: string | null; paidAt: string }

/** The latest live payment applied to each bill: its method and check/ref #. */
export function billPaymentLines(payments: readonly ApPaymentRecord[]): Map<string, BillPaymentLine> {
  const out = new Map<string, BillPaymentLine>()
  for (const p of payments) {
    if (p.kind !== 'PAYMENT' || p.reversedByPaymentId) continue
    for (const a of p.applications ?? []) {
      if (!(a.amountCents > 0)) continue
      const cur = out.get(a.billId)
      if (!cur || p.paidAt > cur.paidAt) out.set(a.billId, { method: p.method ?? null, reference: p.reference ?? null, paidAt: p.paidAt })
    }
  }
  return out
}
