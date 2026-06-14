import {
  listExpenseTypes, createExpenseType, createAllocation, createRecurringExpense,
  type ExpenseCategory,
} from '@/lib/apiClient'

/**
 * Optional operating costs captured when a truck is created. Loan is a monthly
 * payment; insurance/plates/other are entered PER YEAR and converted to a monthly
 * recurring amount. Each becomes a RecurringExpense tied to this truck, so it shows
 * up automatically in Expenses and Weekly Profitability (insurance, loan, etc.).
 */
export interface TruckCostInputs {
  loanMonthly?:     number | null   // $/month
  insuranceAnnual?: number | null   // $/year
  platesAnnual?:    number | null   // $/year
  otherLabel?:      string | null
  otherAnnual?:     number | null   // $/year
}

// Canonical per-category expense types are reused across trucks (one "Insurance"
// type, etc.); each truck gets its own single-truck allocation + recurring row.
const CANONICAL_NAME: Record<'FINANCING' | 'INSURANCE' | 'PERMITS', string> = {
  FINANCING: 'Truck Loan',
  INSURANCE: 'Insurance',
  PERMITS:   'Plates / Registration',
}

const round2 = (n: number) => Math.round(n * 100) / 100

export function hasAnyTruckCost(c: TruckCostInputs): boolean {
  return !!(
    (c.loanMonthly && c.loanMonthly > 0) ||
    (c.insuranceAnnual && c.insuranceAnnual > 0) ||
    (c.platesAnnual && c.platesAnnual > 0) ||
    (c.otherAnnual && c.otherAnnual > 0 && c.otherLabel?.trim())
  )
}

/**
 * Create recurring-expense records for a newly-added truck from the captured costs.
 * Idempotent on the expense *type* (reuses an existing matching type); allocations +
 * recurring rows are created fresh for this truck. Best-effort: logs and continues on
 * a per-item failure so one bad field doesn't block the others.
 */
export async function provisionTruckCosts(
  truckId: string,
  unitNumber: string,
  costs: TruckCostInputs,
): Promise<number> {
  const items: { category: ExpenseCategory; name: string; monthly: number }[] = []
  if (costs.loanMonthly && costs.loanMonthly > 0)
    items.push({ category: 'FINANCING', name: CANONICAL_NAME.FINANCING, monthly: costs.loanMonthly })
  if (costs.insuranceAnnual && costs.insuranceAnnual > 0)
    items.push({ category: 'INSURANCE', name: CANONICAL_NAME.INSURANCE, monthly: costs.insuranceAnnual / 12 })
  if (costs.platesAnnual && costs.platesAnnual > 0)
    items.push({ category: 'PERMITS', name: CANONICAL_NAME.PERMITS, monthly: costs.platesAnnual / 12 })
  if (costs.otherAnnual && costs.otherAnnual > 0 && costs.otherLabel?.trim())
    items.push({ category: 'OTHER', name: costs.otherLabel.trim(), monthly: costs.otherAnnual / 12 })

  if (items.length === 0) return 0

  const existingTypes = await listExpenseTypes()
  const startMonth = new Date().toISOString().slice(0, 7)   // "YYYY-MM"
  let created = 0

  for (const it of items) {
    try {
      let type = existingTypes.find(
        (t) => t.category === it.category && t.name.trim().toLowerCase() === it.name.toLowerCase(),
      )
      if (!type) {
        type = await createExpenseType({ name: it.name, category: it.category, defaultEntryMethod: 'FIXED', active: true })
        existingTypes.push(type)
      }
      // Single-truck allocation — the recurring engine attributes the full amount to
      // this one truck (amount ÷ 1).
      const alloc = await createAllocation({
        expenseTypeId:    type.id,
        allocationMethod: 'SPLIT_EVEN',
        truckIds:         [truckId],
        notes:            `Auto — unit ${unitNumber}`,
      })
      await createRecurringExpense({
        expenseTypeId: type.id,
        allocationId:  alloc.id,
        monthlyAmount: round2(it.monthly),
        startMonth,
        active:        true,
        notes:         `Auto-created with truck ${unitNumber}`,
      })
      created++
    } catch (err) {
      console.error(`[provisionTruckCosts] failed for ${it.category} on unit ${unitNumber}:`, err)
    }
  }
  return created
}
