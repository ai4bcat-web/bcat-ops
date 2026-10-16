/**
 * Changing a fixed monthly cost takes effect from today, never from the beginning.
 *
 * A recurring expense used to be one row, and editing its amount rewrote every month it
 * had ever covered: yard rent raised on Oct 15 made June's P&L move. Now an edit closes
 * the old row yesterday and opens a new one today, so each month keeps the amount that
 * was true at the time. An edit on the day a row was created just corrects that row.
 */
import type { RecurringExpenseData } from '@/lib/apiClient'

export type RecurringRevision =
  | { kind: 'update'; id: string; patch: Partial<RecurringExpenseData> }
  | { kind: 'end'; id: string; patch: { endMonth: string; endDate: string } }
  | { kind: 'split'; endId: string; endPatch: { endMonth: string; endDate: string }; create: Omit<RecurringExpenseData, 'id' | 'createdAt' | 'updatedAt'> }

const monthOf = (iso: string) => iso.slice(0, 7)
export function dayBefore(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/** True when the row took effect today (a same-day edit is a correction, not a change). */
export function startedToday(r: Pick<RecurringExpenseData, 'startDate' | 'startMonth' | 'createdAt'>, today: string): boolean {
  if (r.startDate) return r.startDate === today
  // A row from before effective dates existed: created today and starting this month.
  return (r.createdAt ?? '').slice(0, 10) === today && r.startMonth.replace(/^(\d{4})-(\d)$/, '$1-0$2') === monthOf(today)
}

/** What to write so `existing` reads `monthlyAmount` from `today` on, and its old amount before. */
export function reviseRecurringAmount(existing: RecurringExpenseData, monthlyAmount: number, today: string): RecurringRevision {
  if (startedToday(existing, today)) {
    return monthlyAmount > 0
      ? { kind: 'update', id: existing.id, patch: { monthlyAmount, active: true } }
      : { kind: 'update', id: existing.id, patch: { active: false } }
  }
  const yesterday = dayBefore(today)
  const endPatch = { endMonth: monthOf(yesterday), endDate: yesterday }
  if (monthlyAmount <= 0) return { kind: 'end', id: existing.id, patch: endPatch }
  return {
    kind: 'split',
    endId: existing.id,
    endPatch,
    create: {
      expenseTypeId: existing.expenseTypeId,
      allocationId: existing.allocationId,
      monthlyAmount,
      startMonth: monthOf(today),
      startDate: today,
      endMonth: null,
      endDate: null,
      active: true,
      notes: existing.notes ?? null,
    },
  }
}

/** Today's date, Chicago, as YYYY-MM-DD — the day a change takes effect. */
export function todayChicago(now: Date = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' })
}
