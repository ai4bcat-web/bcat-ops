import { calculateMileageExpense } from './fixedExpenseHistory'

/** The one-off weekly deduction line for entered miles × rate, e.g.
 *  { label: 'Lease mileage — 2494 mi @ $0.086/mi', amount: 214.48 }.
 *  `note` replaces the "Lease mileage" prefix when supplied. Throws on invalid input
 *  (delegates validation/rounding to calculateMileageExpense). */
export function mileageDeductionLine(
  miles: number,
  costPerMile: number,
  note?: string,
): { label: string; amount: number } {
  const amount = calculateMileageExpense({ miles, costPerMile })
  const basis = `${miles} mi @ $${costPerMile}/mi`
  const label = note ? `${note} — ${basis}` : `Lease mileage — ${basis}`
  return { label, amount }
}
