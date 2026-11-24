/**
 * One-time expenses entered by hand: costs the fuel cards do not capture (a driver reimbursed over Zelle for fuel,
 * a repair paid in cash, a toll, a lumper). Fuel is stored as a FuelTransaction so it flows into every fuel total
 * (spend, by truck, by fleet, profit review) with the card imports; the rest are ExpenseRecords on a truck.
 *
 * No schema change: a manual fuel row is marked by `sourceFile` ("manual-entry:<method>") and carries the payee in
 * `locationName`, the reference in `invoiceNumber`, and zero gallons. Gallon-based figures must skip those rows.
 *
 * Pure: no store, no network.
 */
import { OWNER_EMAIL } from './auth/admin'
import { isFleetProfilesOnly } from './profileAccess'

export type ManualCategory = 'fuel' | 'maintenance' | 'tolls' | 'lumper' | 'scale' | 'parking' | 'other'

export const MANUAL_CATEGORIES: readonly { key: ManualCategory; label: string }[] = [
  { key: 'fuel', label: 'Fuel' },
  { key: 'maintenance', label: 'Maintenance / repair' },
  { key: 'tolls', label: 'Tolls' },
  { key: 'lumper', label: 'Lumper' },
  { key: 'scale', label: 'Scale' },
  { key: 'parking', label: 'Parking' },
  { key: 'other', label: 'Other' },
]

export const MANUAL_METHODS = ['Zelle', 'ACH', 'Check', 'Cash', 'Card', 'Other'] as const
export type ManualMethod = (typeof MANUAL_METHODS)[number]

/** `sourceFile` / `ExpenseRecord.source` marker for a hand-entered row. */
export const MANUAL_SOURCE = 'manual-entry'

export function manualFuelSourceFile(method: string): string {
  return `${MANUAL_SOURCE}:${method}`
}

/** True for a fuel row typed in by hand (it has no gallons or price per gallon). */
export function isManualFuelTx(tx: { sourceFile?: string | null }): boolean {
  const s = tx.sourceFile ?? ''
  return s === MANUAL_SOURCE || s.startsWith(`${MANUAL_SOURCE}:`)
}

export function manualMethodOf(tx: { sourceFile?: string | null }): string {
  const s = tx.sourceFile ?? ''
  return s.startsWith(`${MANUAL_SOURCE}:`) ? s.slice(MANUAL_SOURCE.length + 1) : ''
}

export function categoryLabel(key: string): string {
  return MANUAL_CATEGORIES.find((c) => c.key === key)?.label ?? key
}

export interface ManualExpenseInput {
  category: ManualCategory
  date: string            // YYYY-MM-DD
  amount: number          // dollars
  payee: string
  method: string
  reference: string
  note: string
  truckId: string
  unitNumber: string
  driverName: string
  proNumber: string
}

export interface ManualExpenseProblem { field: string; message: string }

export function validateManualExpense(i: ManualExpenseInput): ManualExpenseProblem | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(i.date)) return { field: 'date', message: 'Enter the date the money was spent.' }
  if (!(i.amount > 0) || !Number.isFinite(i.amount)) return { field: 'amount', message: 'Enter an amount greater than zero.' }
  if (!i.truckId) return { field: 'truck', message: 'Pick a truck, or a driver who has a truck assigned.' }
  return null
}

/** The amount in dollars from what was typed ("$1,234.50" -> 1234.5); NaN when it is not a number. */
export function parseDollars(raw: string): number {
  const n = Number(raw.replace(/[$,\s]/g, ''))
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN
}

/** The one-line description kept on an ExpenseRecord: what it was, who was paid, how, and the reference. */
export function manualNotes(i: Pick<ManualExpenseInput, 'category' | 'payee' | 'method' | 'reference' | 'note' | 'driverName' | 'proNumber'>): string {
  const parts = [
    categoryLabel(i.category),
    i.payee.trim() ? `Paid to ${i.payee.trim()}` : '',
    i.method.trim(),
    i.reference.trim() ? `Ref ${i.reference.trim()}` : '',
    i.driverName.trim() ? `Driver ${i.driverName.trim()}` : '',
    i.proNumber.trim() ? `PRO ${i.proNumber.trim()}` : '',
    i.note.trim(),
  ].filter(Boolean)
  return parts.join(' · ')
}

/** The FuelTransaction fields for a manual fuel entry (card "MANUAL", no gallons, no price per gallon). */
export function manualFuelFields(i: ManualExpenseInput) {
  const payee = i.payee.trim()
  const note = i.note.trim()
  return {
    transactionDate: i.date,
    cardNumber: 'MANUAL',
    invoiceNumber: i.reference.trim() || undefined,
    unitNumber: i.unitNumber || undefined,
    truckId: i.truckId,
    driverName: i.driverName.trim() || undefined,
    locationName: [payee, note].filter(Boolean).join(' — ') || undefined,
    fees: 0,
    fuelType: 'FUEL',
    itemCategory: 'FUEL',
    pricePerUnit: 0,
    quantity: 0,
    amount: i.amount,
    currency: 'USD',
    sourceFile: manualFuelSourceFile(i.method || 'Other'),
  }
}

/** The ExpenseType category a manual category books to (the types catalog has no lumper/scale/parking). */
export function expenseTypeCategoryFor(c: ManualCategory): 'MAINTENANCE' | 'TOLLS' | 'OTHER' {
  if (c === 'maintenance') return 'MAINTENANCE'
  if (c === 'tolls') return 'TOLLS'
  return 'OTHER'
}

interface AccessUser { email?: string | null; groups?: readonly string[] | null }

/**
 * Who may add and edit one-time expenses: the owner, the ADMIN group, or anyone holding the Finances page grant.
 * Jason (Profiles limited to Assets and Drivers) is never one of them: this is money data.
 */
export function canManageManualExpenses(user: AccessUser | null | undefined, isOwnerOrAdmin: boolean, hasFinances: boolean): boolean {
  if (!user) return false
  if (isFleetProfilesOnly(user.email, user.groups)) return false
  return isOwnerOrAdmin || hasFinances
}

/** Delete is the owner and the ADMIN group only. */
export function canDeleteManualExpenses(user: AccessUser | null | undefined, isOwnerOrAdmin: boolean): boolean {
  if (!user) return false
  if ((user.email ?? '').trim().toLowerCase() === OWNER_EMAIL) return true
  return isOwnerOrAdmin && !isFleetProfilesOnly(user.email, user.groups)
}
