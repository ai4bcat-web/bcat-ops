/**
 * Default pay period for a driver-pay expense entered by hand on Finances → Expenses.
 *
 * Driver pay is booked once per biweekly period (the Wednesday → Tuesday cycle in
 * src/lib/biweekly.ts). When Ryne picks a driver-pay expense type, the form should
 * land on the period right after the last one already submitted for that type, so
 * nothing is double-booked or skipped. The record carries the period's start date
 * as its transaction date and the range in its notes.
 */
import { currentPeriodStart, periodLabelLong, periodStartOfISO, shiftPeriod } from './biweekly'

export interface PeriodicExpenseRecord {
  expenseTypeId: string
  transactionDate?: string | null
  periodMonth?: string | null
  createdAt?: string
}

/** Expense types that are booked per driver pay period. */
export function isDriverPayExpenseType(name: string | null | undefined): boolean {
  return /driver\s*pay|driver\s*settlement|payroll/i.test(name ?? '')
}

/** The latest period start already submitted for this type, or null when none. */
export function lastSubmittedPeriodStart(records: PeriodicExpenseRecord[], expenseTypeId: string): string | null {
  let latest: string | null = null
  for (const r of records) {
    if (r.expenseTypeId !== expenseTypeId || !r.transactionDate) continue
    const start = periodStartOfISO(r.transactionDate)
    if (!latest || start > latest) latest = start
  }
  return latest
}

/**
 * The period to pre-fill: the one after the last submitted, or the current one when
 * nothing has been booked yet.
 */
export function nextDriverPayPeriod(records: PeriodicExpenseRecord[], expenseTypeId: string, today: Date = new Date()): { periodStart: string; label: string; followsExisting: boolean } {
  const last = lastSubmittedPeriodStart(records, expenseTypeId)
  const periodStart = last ? shiftPeriod(last, 1) : currentPeriodStart(today)
  return { periodStart, label: periodLabelLong(periodStart), followsExisting: last !== null }
}

export function driverPayNotes(label: string): string {
  return `Pay period ${label}`
}
