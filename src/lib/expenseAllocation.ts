/**
 * Expense allocation / aggregation engine.
 *
 * Pure function — takes pre-fetched data arrays and computes per-truck,
 * per-category expense totals for any date range.
 *
 * Design:
 *  • Fuel amounts come from FuelTransaction (source of truth for diesel/DEF).
 *  • All other costs come from ExpenseRecord.
 *  • SPLIT_EVEN records: amount divided by number of trucks in the allocation.
 *  • DIRECT records: full amount attributed to directTruckId.
 *  • Period filtering: records with periodMonth are matched by month-range;
 *    records with transactionDate are matched by exact date-range.
 */

export type ExpenseCategory =
  | 'FUEL'
  | 'INSURANCE'
  | 'FINANCING'
  | 'LEASE'
  | 'MAINTENANCE'
  | 'PERMITS'
  | 'TOLLS'
  | 'OTHER'

export interface TruckExpenseSummary {
  fuel:        number
  insurance:   number
  financing:   number
  lease:       number
  maintenance: number
  permits:     number
  tolls:       number
  other:       number
  total:       number
}

export interface AllocationRecord {
  id:               string
  expenseTypeId:    string
  allocationMethod: 'DIRECT' | 'SPLIT_EVEN'
  truckIds:         string[]
}

export interface ExpenseTypeRecord {
  id:       string
  category: ExpenseCategory
}

export interface ExpenseRecordInput {
  expenseTypeId:   string
  allocationId:    string | null | undefined
  amount:          number
  periodMonth:     string | null | undefined  // "2026-05"
  transactionDate: string | null | undefined  // "2026-05-19"
  directTruckId:   string | null | undefined
}

export interface FuelTxInput {
  truckId:         string | null | undefined
  transactionDate: string
  amount:          number
  itemCategory:    string  // only 'FUEL' rows are included in fuel totals
}

export interface RecurringInput {
  expenseTypeId: string
  allocationId:  string | null | undefined
  monthlyAmount: number
  startMonth:    string                 // "2026-05" (or "2026-5")
  endMonth:      string | null | undefined
  active:        boolean
}

export interface ExpenseCalcOptions {
  /**
   * Prorate a monthly (periodMonth) record to the portion of its month that overlaps
   * [startDate, endDate], by calendar days. A $300/mo cost viewed over a 7-day week in
   * a 30-day month counts $70. Full-month and multi-month ranges are unaffected
   * (factor = 1 per fully-covered month). One-off (transactionDate) records are never
   * prorated. Default false → legacy "full monthly amount when the month is in range".
   */
  prorateMonthly?: boolean
}

function emptyTruckSummary(): TruckExpenseSummary {
  return { fuel: 0, insurance: 0, financing: 0, lease: 0, maintenance: 0, permits: 0, tolls: 0, other: 0, total: 0 }
}

/** Inclusive day count between two YYYY-MM-DD dates (UTC). */
function inclusiveDays(start: string, end: string): number {
  const s = Date.UTC(+start.slice(0, 4), +start.slice(5, 7) - 1, +start.slice(8, 10))
  const e = Date.UTC(+end.slice(0, 4), +end.slice(5, 7) - 1, +end.slice(8, 10))
  return Math.floor((e - s) / 86_400_000) + 1
}

/** Fraction of `periodMonth` (YYYY-MM) covered by [startDate, endDate], by days (0..1). */
function monthProrationFactor(periodMonth: string, startDate: string, endDate: string): number {
  const y = +periodMonth.slice(0, 4)
  const m = +periodMonth.slice(5, 7)                       // 1-based
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const mStart = `${periodMonth}-01`
  const mEnd   = `${periodMonth}-${String(daysInMonth).padStart(2, '0')}`
  const oStart = startDate > mStart ? startDate : mStart
  const oEnd   = endDate   < mEnd   ? endDate   : mEnd
  if (oStart > oEnd) return 0
  return inclusiveDays(oStart, oEnd) / daysInMonth
}

/**
 * Expand RecurringExpense templates into virtual ExpenseRecord rows — one per month
 * overlapping [startDate, endDate]. RecurringExpense rows are not stored as
 * ExpenseRecords, so they must be projected before aggregation. (Mirrors the logic the
 * Expenses Overview used inline, now shared so every view agrees.)
 */
export function expandRecurringToRecords(
  recurring: RecurringInput[],
  startDate: string,
  endDate: string,
): ExpenseRecordInput[] {
  const startMonth = startDate.slice(0, 7)
  const endMonth   = endDate.slice(0, 7)
  const pad = (mm: string) => mm.replace(/^(\d{4})-(\d)$/, '$1-0$2')
  const out: ExpenseRecordInput[] = []
  for (const r of recurring) {
    if (!r.active) continue
    const rStart = pad(r.startMonth)
    const rEnd   = r.endMonth ? pad(r.endMonth) : null
    let month = rStart > startMonth ? rStart : startMonth
    const hi   = rEnd && rEnd < endMonth ? rEnd : endMonth
    while (month <= hi) {
      out.push({
        expenseTypeId:   r.expenseTypeId,
        allocationId:    r.allocationId,
        amount:          r.monthlyAmount,
        periodMonth:     month,
        transactionDate: null,
        directTruckId:   null,
      })
      const [y, m] = month.split('-').map(Number)
      month = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
    }
  }
  return out
}

/**
 * Compute per-truck expense totals for [startDate, endDate] inclusive (YYYY-MM-DD).
 *
 * Returns only trucks that have at least one expense in range.
 */
export function getExpensesByTruck(
  startDate: string,
  endDate: string,
  fuelTxs: FuelTxInput[],
  expenseRecords: ExpenseRecordInput[],
  allocations: AllocationRecord[],
  expenseTypes: ExpenseTypeRecord[],
  opts: ExpenseCalcOptions = {},
): Record<string, TruckExpenseSummary> {
  const result: Record<string, TruckExpenseSummary> = {}

  function getOrInit(truckId: string): TruckExpenseSummary {
    if (!result[truckId]) result[truckId] = emptyTruckSummary()
    return result[truckId]
  }

  function add(truckId: string, category: ExpenseCategory, amount: number) {
    const r = getOrInit(truckId)
    const key = category.toLowerCase() as keyof Omit<TruckExpenseSummary, 'total'>
    r[key] += amount
    r.total += amount
  }

  // ── Fuel: from FuelTransaction ──────────────────────────────────────────────
  for (const tx of fuelTxs) {
    if (!tx.truckId) continue
    if (tx.itemCategory !== 'FUEL') continue
    if (tx.transactionDate < startDate || tx.transactionDate > endDate) continue
    add(tx.truckId, 'FUEL', tx.amount)
  }

  // ── All other costs: from ExpenseRecord ────────────────────────────────────
  const typeMap  = new Map(expenseTypes.map((t) => [t.id, t]))
  const allocMap = new Map(allocations.map((a) => [a.id, a]))

  const startMonth = startDate.slice(0, 7)  // "2026-05"
  const endMonth   = endDate.slice(0, 7)

  for (const rec of expenseRecords) {
    // Date-range filter: periodMonth OR transactionDate must fall in range
    const inRange =
      (rec.periodMonth   && rec.periodMonth >= startMonth && rec.periodMonth <= endMonth) ||
      (rec.transactionDate && rec.transactionDate >= startDate && rec.transactionDate <= endDate)
    if (!inRange) continue

    const expType = typeMap.get(rec.expenseTypeId)
    if (!expType) continue
    const category = expType.category

    // Prorate monthly costs (periodMonth, no specific transactionDate) to the range.
    const matchedByMonth = !!(rec.periodMonth && rec.periodMonth >= startMonth && rec.periodMonth <= endMonth)
    const factor = opts.prorateMonthly && matchedByMonth && !rec.transactionDate
      ? monthProrationFactor(rec.periodMonth!, startDate, endDate)
      : 1
    const amount = rec.amount * factor

    if (rec.directTruckId) {
      // DIRECT — full amount to one truck
      add(rec.directTruckId, category, amount)
    } else if (rec.allocationId) {
      // SPLIT_EVEN — divide equally among allocation's trucks
      const alloc = allocMap.get(rec.allocationId)
      if (!alloc || alloc.truckIds.length === 0) continue
      const share = amount / alloc.truckIds.length
      for (const truckId of alloc.truckIds) {
        add(truckId, category, share)
      }
    }
  }

  return result
}

/**
 * One per-truck expense aggregation that EVERY view shares: fuel + manual/auto
 * ExpenseRecords + projected RecurringExpense templates, with monthly costs prorated
 * to the date range. Use this so the Expenses Overview and the profitability view never
 * diverge (same insurance, loans, fuel, etc.).
 */
export function getFleetExpenses(
  startDate: string,
  endDate: string,
  input: {
    fuelTxs:        FuelTxInput[]
    records:        ExpenseRecordInput[]
    recurring:      RecurringInput[]
    allocations:    AllocationRecord[]
    expenseTypes:   ExpenseTypeRecord[]
  },
  opts: ExpenseCalcOptions = { prorateMonthly: true },
): Record<string, TruckExpenseSummary> {
  const expanded = expandRecurringToRecords(input.recurring, startDate, endDate)
  return getExpensesByTruck(
    startDate, endDate,
    input.fuelTxs,
    [...input.records, ...expanded],
    input.allocations,
    input.expenseTypes,
    opts,
  )
}
