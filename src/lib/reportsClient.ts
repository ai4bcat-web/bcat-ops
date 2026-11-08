// Relative, not `@/` — `src/lib` is also bundled by the reporting Lambdas, and the alias
// does not exist in a function build.
import {
  listCommissionsByMonth,
  listInvoicesByMonth,
  listLaneSamplesByMonth,
  listQuotesByMonth,
} from './apiClient'
import { monthsBetween } from './reporting'
import type {
  CommissionRecord,
  InvoiceRecord,
  LaneRateSampleRecord,
  QuoteRecord,
} from '../types/tms'

/**
 * The reads behind `/reports`, kept out of the page.
 *
 * Every reporting index is keyed by `'YYYY-MM'`, so a window is one read per month. Two
 * things follow, and they are the whole of this file:
 *
 * 1. A month is read once. Switching tabs, re-cutting the profit table by a different
 *    group-by or widening the window by one month re-reads only what it has never seen.
 *    The cache holds the in-flight promise, so two panels asking for the same month at
 *    the same instant still make one call.
 * 2. A month that fails is reported, not thrown. One index that is not deployed yet, or
 *    one read that was throttled, must not blank six panels: the surviving months are
 *    returned and the failed ones come back in `failedMonths` so the page can say which
 *    part of the window it is missing rather than quietly under-reporting the total.
 *
 * A rejected read is evicted from the cache, so a refresh retries it; a successful one is
 * kept for the life of the tab. `clearReportCache()` exists for tests and for the page's
 * refresh button, which is the one place somebody is explicitly asking for fresh rows.
 */

/** A month that could not be read, with the backend's own refusal. */
export interface FailedMonth {
  month: string
  message: string
}

export interface MonthlyRead<T> {
  rows: T[]
  /** Every month the window asked for, oldest first — including the ones that failed. */
  months: string[]
  /** Empty when the whole window was read. Non-empty means `rows` is incomplete. */
  failedMonths: FailedMonth[]
}

type MonthCache<T> = Map<string, Promise<T[]>>

const samplesCache: MonthCache<LaneRateSampleRecord> = new Map()
const quotesCache: MonthCache<QuoteRecord> = new Map()
const commissionsCache: MonthCache<CommissionRecord> = new Map()
const invoicesCache: MonthCache<InvoiceRecord> = new Map()

const ALL_CACHES = [samplesCache, quotesCache, commissionsCache, invoicesCache]

/** Drop every memoised month. The refresh button and the tests are the callers. */
export function clearReportCache(): void {
  for (const cache of ALL_CACHES) cache.clear()
}

/** The memoised read of one month. A rejection is evicted so the next ask retries it. */
function monthRows<T>(cache: MonthCache<T>, fetchMonth: (ym: string) => Promise<T[]>, ym: string): Promise<T[]> {
  const cached = cache.get(ym)
  if (cached) return cached
  const pending = fetchMonth(ym).catch((err: unknown) => {
    cache.delete(ym)
    throw err
  })
  cache.set(ym, pending)
  return pending
}

/**
 * Every month of `[from, to]`, in parallel, flattened. The months come back in window
 * order whatever order the reads settle in, so a table grouped by month cannot shuffle
 * between two loads of the same window.
 */
async function readWindow<T>(
  cache: MonthCache<T>,
  fetchMonth: (ym: string) => Promise<T[]>,
  from: string,
  to: string,
): Promise<MonthlyRead<T>> {
  const months = monthsBetween(from, to)
  const settled = await Promise.all(
    months.map((ym) =>
      monthRows(cache, fetchMonth, ym).then(
        (rows) => ({ ym, rows, error: null as string | null }),
        (err: unknown) => ({
          ym,
          rows: [] as T[],
          error: err instanceof Error && err.message ? err.message : 'That month could not be read',
        }),
      ),
    ),
  )
  const rows: T[] = []
  const failedMonths: FailedMonth[] = []
  for (const month of settled) {
    if (month.error) failedMonths.push({ month: month.ym, message: month.error })
    else rows.push(...month.rows)
  }
  return { rows, months, failedMonths }
}

/** The priced delivered loads of a window — everything the profit table is cut from. */
export function loadSamples(from: string, to: string): Promise<MonthlyRead<LaneRateSampleRecord>> {
  return readWindow(samplesCache, listLaneSamplesByMonth, from, to)
}

/** Every quote of a window, both sides; the funnel picks the side it reports on. */
export function loadQuotes(from: string, to: string): Promise<MonthlyRead<QuoteRecord>> {
  return readWindow(quotesCache, listQuotesByMonth, from, to)
}

/** Every commission triggered in a window, across reps. */
export function loadCommissions(from: string, to: string): Promise<MonthlyRead<CommissionRecord>> {
  return readWindow(commissionsCache, listCommissionsByMonth, from, to)
}

/** Invoices raised in a window — the paid ones carry days-to-pay. */
export function loadInvoices(from: string, to: string): Promise<MonthlyRead<InvoiceRecord>> {
  return readWindow(invoicesCache, listInvoicesByMonth, from, to)
}

export interface ReportBundle {
  samples: LaneRateSampleRecord[]
  months: string[]
  failedMonths: FailedMonth[]
}

/** What the profit panel opens on: the window's samples and which months are missing. */
export async function loadReportBundle(window: { from: string; to: string }): Promise<ReportBundle> {
  const { rows, months, failedMonths } = await loadSamples(window.from, window.to)
  return { samples: rows, months, failedMonths }
}
