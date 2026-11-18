/**
 * Archive the AP payments that were paid outside BCAT Ops (Ryne 2026-11-18): hide them from the Paid and Payments
 * views, keep the rows, keep every bill PAID. The rules live in `src/lib/apArchive.ts`; this is the Lambda around
 * them: read the book, run the plan, and (unless it is a dry run) write `archivedAt` on the rows in small guarded
 * steps.
 *
 * The book is read through the indexes this Lambda already holds a grant on (bills by month, payments by carrier):
 * there is no Scan grant on these tables, and none is added for a one-time cleanup.
 *
 * Re-runnable: archived rows are skipped, a bill's decision counts a payment that is already archived as archivable,
 * and every write is conditional on the row being unchanged since it was read. `limit` caps the writes per call so
 * a call stays inside the Lambda's 60 seconds; `remaining` says how many are left.
 */
import { UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { marshall } from '@aws-sdk/util-dynamodb'
import { assertString, optionalInteger, optionalString, type Caller } from '../_shared/actionInputs'
import { archiveReason, planApArchive, type ArchiveBill, type ArchivePayment } from '../../../src/lib/apArchive'
import { VERIFY_PAYMENT_PROS } from '../../../src/lib/verifyPaymentPros'
import {
  AP_PAYMENT_TABLE_NAME,
  CARRIER_BILL_TABLE_NAME,
  dynamo,
  nowIso,
  queryIndex,
  writeAudit,
  type Row,
} from './store'

const IDX_BILLS_BY_MONTH = 'carrierBillsByBillMonthAndRecordedAt'
const IDX_PAYMENTS_BY_CARRIER = 'apPaymentsByCarrierIdAndPaidAt'
/** The oldest bill month AP holds (the Aljex carry-over reaches back to here). */
const FIRST_BILL_MONTH = '2024-01'
const DEFAULT_WRITES_PER_CALL = 400
const MAX_WRITES_PER_CALL = 1500
const CONCURRENCY = 20
/** Stop starting writes this far into the call so the response still gets out inside the Lambda's 60 seconds. */
const WRITE_DEADLINE_MS = 40_000

const isDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value)

function monthsFrom(first: string, throughIso: string): string[] {
  const [fy, fm] = first.split('-').map(Number)
  const [ty, tm] = throughIso.slice(0, 7).split('-').map(Number)
  const out: string[] = []
  for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m += 1) {
    if (m > 12) { y += 1; m = 1 }
    out.push(`${y}-${String(m).padStart(2, '0')}`)
  }
  return out
}

/** Run `task` over `items` with at most `limit` in flight. */
async function pool<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next
        next += 1
        results[i] = await task(items[i])
      }
    }),
  )
  return results
}

interface Book {
  bills: Row[]
  payments: Row[]
}

/** Every bill ever recorded and every money row of every carrier that has a bill. */
async function readBook(): Promise<Book> {
  const months = monthsFrom(FIRST_BILL_MONTH, nowIso())
  const billGroups = await pool(months, CONCURRENCY, (month) => queryIndex(CARRIER_BILL_TABLE_NAME, IDX_BILLS_BY_MONTH, 'billMonth', month))
  const bills = billGroups.flat()
  const carrierIds = [...new Set(bills.map((b) => String(b.carrierId ?? '')).filter(Boolean))]
  const paymentGroups = await pool(carrierIds, CONCURRENCY, (carrierId) => queryIndex(AP_PAYMENT_TABLE_NAME, IDX_PAYMENTS_BY_CARRIER, 'carrierId', carrierId))
  return { bills, payments: paymentGroups.flat() }
}

const toPayment = (row: Row): ArchivePayment => row as unknown as ArchivePayment
const toBill = (row: Row): ArchiveBill => row as unknown as ArchiveBill

async function markArchived(table: string, row: Row, caller: Caller, reason: string, at: string): Promise<'WRITTEN' | 'SKIPPED'> {
  try {
    await dynamo.send(
      new UpdateItemCommand({
        TableName: table,
        Key: marshall({ id: String(row.id) }),
        UpdateExpression: 'SET #a = :a, #b = :b, #r = :r',
        // Only if nobody archived it and nobody changed it since it was read: updatedAt and version are left alone
        // so no later write is refused for it.
        ConditionExpression: 'attribute_exists(id) AND attribute_not_exists(#a) AND updatedAt = :u',
        ExpressionAttributeNames: { '#a': 'archivedAt', '#b': 'archivedBy', '#r': 'archivedReason' },
        ExpressionAttributeValues: marshall({ ':a': at, ':b': caller.email, ':r': reason, ':u': String(row.updatedAt) }),
      }),
    )
    return 'WRITTEN'
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return 'SKIPPED'
    throw err
  }
}

const dollars = (rows: Row[]) => Math.round(rows.reduce((sum, r) => sum + Number(r.amountCents ?? 0), 0)) / 100

/**
 * ARCHIVE_AP_PAYMENTS_THROUGH: `{ cutoff: 'YYYY-MM-DD', dryRun?: boolean (default true), limit?: number }`.
 * Admin only (see handler). A dry run writes nothing and returns the plan's counts, dollars and the rows it keeps.
 */
export async function archiveApPaymentsThrough(input: Row, caller: Caller): Promise<Row> {
  const cutoff = assertString(input.cutoff, 'cutoff')
  if (!isDay(cutoff)) throw new Error('cutoff must be a date like 2026-11-12')
  const dryRun = input.dryRun !== false
  const limit = Math.min(Math.max(optionalInteger(input.limit, { min: 1, max: MAX_WRITES_PER_CALL, label: 'limit' }) ?? DEFAULT_WRITES_PER_CALL, 1), MAX_WRITES_PER_CALL)
  const reason = archiveReason(cutoff)
  const started = Date.now()

  const book = await readBook()
  const plan = planApArchive({
    payments: book.payments.map(toPayment),
    bills: book.bills.map(toBill),
    cutoff,
    verifyPros: new Set(VERIFY_PAYMENT_PROS),
  })
  const paymentRows = new Map(book.payments.map((p) => [String(p.id), p]))
  const billRows = new Map(book.bills.map((b) => [String(b.id), b]))
  const toArchivePayments = plan.paymentIds.map((id) => paymentRows.get(id)!).filter(Boolean)
  const toArchiveBills = plan.billIds.map((id) => billRows.get(id)!).filter(Boolean)

  const summary = {
    cutoff,
    reason,
    dryRun,
    paymentsToArchive: toArchivePayments.length,
    paymentsByKind: toArchivePayments.reduce<Record<string, number>>((acc, p) => { acc[String(p.kind)] = (acc[String(p.kind)] ?? 0) + 1; return acc }, {}),
    paymentDollars: dollars(toArchivePayments),
    billsToArchive: toArchiveBills.length,
    billNetDollars: Math.round(toArchiveBills.reduce((sum, b) => sum + Number(b.netCents ?? 0), 0)) / 100,
    keptPayments: plan.keptPayments.length,
    keptPaymentReasons: plan.keptPayments.reduce<Record<string, number>>((acc, k) => { acc[k.why] = (acc[k.why] ?? 0) + 1; return acc }, {}),
    keptBills: plan.keptBills.map((k) => ({ pro: String(billRows.get(k.id)?.shipmentNumber ?? k.id), why: k.why })),
    alreadyArchivedPayments: plan.alreadyArchivedPayments,
    alreadyArchivedBills: plan.alreadyArchivedBills,
    booksRead: { bills: book.bills.length, payments: book.payments.length },
  }
  if (dryRun) return { ...summary, written: 0, remaining: toArchivePayments.length + toArchiveBills.length }

  // Payments first, then the bills they settled; a stop in the middle leaves bills visible rather than payment-less.
  const at = nowIso()
  const queue: { table: string; row: Row }[] = [
    ...toArchivePayments.map((row) => ({ table: AP_PAYMENT_TABLE_NAME, row })),
    ...toArchiveBills.map((row) => ({ table: CARRIER_BILL_TABLE_NAME, row })),
  ]
  const batch = queue.slice(0, limit)
  let written = 0
  let skipped = 0
  await pool(batch, CONCURRENCY, async ({ table, row }) => {
    if (Date.now() - started > WRITE_DEADLINE_MS) return
    const outcome = await markArchived(table, row, caller, reason, at)
    if (outcome === 'WRITTEN') written += 1
    else skipped += 1
  })
  const remaining = queue.length - written - skipped
  await writeAudit('ApPaymentArchive', cutoff, 'ARCHIVE_AP_PAYMENTS_THROUGH', caller, {
    cutoff, reason, written, skipped, remaining, paymentsPlanned: toArchivePayments.length, billsPlanned: toArchiveBills.length,
  })
  return { ...summary, written, skipped, remaining }
}

/**
 * UNARCHIVE_AP_PAYMENTS: `{ reason?: string (default: every archived row), dryRun?: boolean (default true), limit?: number }`.
 * Takes `archivedAt` back off payments and bills archived by this feature, nothing else.
 */
export async function unarchiveApPayments(input: Row, caller: Caller): Promise<Row> {
  const dryRun = input.dryRun !== false
  const limit = Math.min(Math.max(optionalInteger(input.limit, { min: 1, max: MAX_WRITES_PER_CALL, label: 'limit' }) ?? DEFAULT_WRITES_PER_CALL, 1), MAX_WRITES_PER_CALL)
  const reasonFilter = optionalString(input.reason, 200)
  const started = Date.now()

  const book = await readBook()
  const match = (row: Row) => Boolean(row.archivedAt) && (!reasonFilter || row.archivedReason === reasonFilter)
  const queue: { table: string; row: Row }[] = [
    ...book.bills.filter(match).map((row) => ({ table: CARRIER_BILL_TABLE_NAME, row })),
    ...book.payments.filter(match).map((row) => ({ table: AP_PAYMENT_TABLE_NAME, row })),
  ]
  const summary = { dryRun, reason: reasonFilter ?? null, payments: queue.filter((q) => q.table === AP_PAYMENT_TABLE_NAME).length, bills: queue.filter((q) => q.table === CARRIER_BILL_TABLE_NAME).length }
  if (dryRun) return { ...summary, written: 0, remaining: queue.length }

  let written = 0
  let skipped = 0
  await pool(queue.slice(0, limit), CONCURRENCY, async ({ table, row }) => {
    if (Date.now() - started > WRITE_DEADLINE_MS) return
    try {
      await dynamo.send(
        new UpdateItemCommand({
          TableName: table,
          Key: marshall({ id: String(row.id) }),
          UpdateExpression: 'REMOVE #a, #b, #r',
          ConditionExpression: 'attribute_exists(id) AND attribute_exists(#a) AND updatedAt = :u',
          ExpressionAttributeNames: { '#a': 'archivedAt', '#b': 'archivedBy', '#r': 'archivedReason' },
          ExpressionAttributeValues: marshall({ ':u': String(row.updatedAt) }),
        }),
      )
      written += 1
    } catch (err) {
      if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err
      skipped += 1
    }
  })
  const remaining = queue.length - written - skipped
  await writeAudit('ApPaymentArchive', 'unarchive', 'UNARCHIVE_AP_PAYMENTS', caller, { reason: reasonFilter ?? null, written, skipped, remaining })
  return { ...summary, written, skipped, remaining }
}
