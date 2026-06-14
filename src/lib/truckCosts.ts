import {
  listExpenseTypes, createExpenseType, createAllocation, createRecurringExpense, updateRecurringExpense,
  type ExpenseCategory, type ExpenseTypeData, type TruckExpenseAllocationData, type RecurringExpenseData,
} from '@/lib/apiClient'

/**
 * Optional operating costs captured when a truck is created or edited. Loan is a
 * monthly payment; insurance/plates/other are entered PER YEAR and converted to a
 * monthly recurring amount. Each becomes a single-truck RecurringExpense, so it shows
 * up automatically in Expenses and Weekly Profitability (insurance, loan, etc.).
 */
export interface TruckCostInputs {
  loanMonthly?:     number | null   // $/month
  insuranceAnnual?: number | null   // $/year
  platesAnnual?:    number | null   // $/year
  otherLabel?:      string | null
  otherAnnual?:     number | null   // $/year
}

type CostCategory = 'FINANCING' | 'INSURANCE' | 'PERMITS' | 'OTHER'

/** A truck's currently-active per-truck recurring cost, for prefilling the edit form. */
export interface ExistingTruckCost {
  category:      CostCategory
  recurringId:   string
  typeName:      string
  monthlyAmount: number
}

// Canonical per-category expense types reused across trucks (one "Insurance" type,
// etc.); each truck gets its own single-truck allocation + recurring row.
const CANONICAL_NAME: Record<'FINANCING' | 'INSURANCE' | 'PERMITS', string> = {
  FINANCING: 'Truck Loan',
  INSURANCE: 'Insurance',
  PERMITS:   'Plates / Registration',
}

const round2 = (n: number) => Math.round(n * 100) / 100
const thisMonth = () => new Date().toISOString().slice(0, 7)   // "YYYY-MM"

export function hasAnyTruckCost(c: TruckCostInputs): boolean {
  return !!(
    (c.loanMonthly && c.loanMonthly > 0) ||
    (c.insuranceAnnual && c.insuranceAnnual > 0) ||
    (c.platesAnnual && c.platesAnnual > 0) ||
    (c.otherAnnual && c.otherAnnual > 0 && c.otherLabel?.trim())
  )
}

/** Is this allocation a single-truck allocation for the given truck? */
function isSingleTruckAlloc(a: TruckExpenseAllocationData | undefined, truckId: string): boolean {
  const ids = a?.truckIds ?? []
  return ids.length === 1 && ids[0] === truckId
}

/**
 * Read a truck's current per-truck recurring costs from already-fetched expense data,
 * for prefilling the edit form. Only single-truck allocations are considered "this
 * truck's" costs; the first OTHER cost is surfaced (extra ones stay in Expenses→Manage).
 */
export function readTruckCosts(
  truckId: string,
  recurring: RecurringExpenseData[],
  allocations: TruckExpenseAllocationData[],
  expenseTypes: ExpenseTypeData[],
): { inputs: TruckCostInputs; existing: ExistingTruckCost[] } {
  const allocById = new Map(allocations.map((a) => [a.id, a]))
  const typeById  = new Map(expenseTypes.map((t) => [t.id, t]))
  const inputs: TruckCostInputs = {}
  const existing: ExistingTruckCost[] = []

  for (const r of recurring) {
    if (!r.active) continue
    if (!isSingleTruckAlloc(allocById.get(r.allocationId), truckId)) continue
    const type = typeById.get(r.expenseTypeId)
    if (!type) continue
    const cat = type.category
    if (cat !== 'FINANCING' && cat !== 'INSURANCE' && cat !== 'PERMITS' && cat !== 'OTHER') continue
    if (existing.some((e) => e.category === cat)) continue   // first per category
    existing.push({ category: cat, recurringId: r.id, typeName: type.name, monthlyAmount: r.monthlyAmount })
    if (cat === 'FINANCING') inputs.loanMonthly = r.monthlyAmount
    else if (cat === 'INSURANCE') inputs.insuranceAnnual = round2(r.monthlyAmount * 12)
    else if (cat === 'PERMITS') inputs.platesAnnual = round2(r.monthlyAmount * 12)
    else { inputs.otherLabel = type.name; inputs.otherAnnual = round2(r.monthlyAmount * 12) }
  }
  return { inputs, existing }
}

/** Find-or-create the expense type, then create a single-truck allocation + recurring row. */
async function createCost(
  truckId: string, unitNumber: string,
  category: ExpenseCategory, name: string, monthly: number,
  types: ExpenseTypeData[], startMonth: string,
): Promise<void> {
  let type = types.find((t) => t.category === category && t.name.trim().toLowerCase() === name.toLowerCase())
  if (!type) {
    type = await createExpenseType({ name, category, defaultEntryMethod: 'FIXED', active: true })
    types.push(type)
  }
  const alloc = await createAllocation({
    expenseTypeId: type.id, allocationMethod: 'SPLIT_EVEN', truckIds: [truckId], notes: `Auto — unit ${unitNumber}`,
  })
  await createRecurringExpense({
    expenseTypeId: type.id, allocationId: alloc.id, monthlyAmount: round2(monthly), startMonth, active: true,
    notes: `Auto — truck ${unitNumber}`,
  })
}

function targetsFor(costs: TruckCostInputs): { category: CostCategory; name: string; monthly: number }[] {
  return [
    { category: 'FINANCING', name: CANONICAL_NAME.FINANCING, monthly: costs.loanMonthly || 0 },
    { category: 'INSURANCE', name: CANONICAL_NAME.INSURANCE, monthly: (costs.insuranceAnnual || 0) / 12 },
    { category: 'PERMITS',   name: CANONICAL_NAME.PERMITS,   monthly: (costs.platesAnnual || 0) / 12 },
    { category: 'OTHER',     name: costs.otherLabel?.trim() || 'Other', monthly: (costs.otherAnnual || 0) / 12 },
  ]
}

/**
 * Create recurring-expense records for a NEW truck from the captured costs.
 * Best-effort per item. Returns the count created.
 */
export async function provisionTruckCosts(
  truckId: string, unitNumber: string, costs: TruckCostInputs,
): Promise<number> {
  const items = targetsFor(costs).filter((t) => t.monthly > 0)
  if (items.length === 0) return 0
  const types = await listExpenseTypes()
  const startMonth = thisMonth()
  let created = 0
  for (const it of items) {
    try { await createCost(truckId, unitNumber, it.category, it.name, it.monthly, types, startMonth); created++ }
    catch (err) { console.error(`[provisionTruckCosts] ${it.category} failed for unit ${unitNumber}:`, err) }
  }
  return created
}

/**
 * Upsert an EXISTING truck's costs: update the amount when a per-truck recurring row
 * already exists, create one when newly entered, or deactivate it when cleared.
 */
export async function applyTruckCosts(
  truckId: string, unitNumber: string, costs: TruckCostInputs, existing: ExistingTruckCost[],
): Promise<void> {
  const types = await listExpenseTypes()
  const startMonth = thisMonth()
  const byCat = new Map(existing.map((e) => [e.category, e]))
  for (const tg of targetsFor(costs)) {
    try {
      const ex = byCat.get(tg.category)
      if (tg.monthly > 0) {
        if (ex) await updateRecurringExpense(ex.recurringId, { monthlyAmount: round2(tg.monthly) })
        else    await createCost(truckId, unitNumber, tg.category, tg.name, tg.monthly, types, startMonth)
      } else if (ex) {
        await updateRecurringExpense(ex.recurringId, { active: false })   // cleared → stop billing
      }
    } catch (err) {
      console.error(`[applyTruckCosts] ${tg.category} failed for unit ${unitNumber}:`, err)
    }
  }
}
