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

function emptyTruckSummary(): TruckExpenseSummary {
  return { fuel: 0, insurance: 0, financing: 0, lease: 0, maintenance: 0, permits: 0, tolls: 0, other: 0, total: 0 }
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

    if (rec.directTruckId) {
      // DIRECT — full amount to one truck
      add(rec.directTruckId, category, rec.amount)
    } else if (rec.allocationId) {
      // SPLIT_EVEN — divide equally among allocation's trucks
      const alloc = allocMap.get(rec.allocationId)
      if (!alloc || alloc.truckIds.length === 0) continue
      const share = rec.amount / alloc.truckIds.length
      for (const truckId of alloc.truckIds) {
        add(truckId, category, share)
      }
    }
  }

  return result
}
