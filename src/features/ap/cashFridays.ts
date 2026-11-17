/**
 * Cash requirements by pay Friday: what has to be paid on each of the next five Fridays.
 *
 * The rule (Ryne, 2026-11-16): a bill is paid on the Friday on or after its due date. Anything due before the first
 * Friday is past due or due now and sits on its own line in front of it, so it is never hidden inside a week.
 * A bill due after the fifth Friday goes in "Later". A bill still waiting on its invoice date (Expected) has no due
 * date, so it is counted apart as "Not scheduled" and in no Friday. Paid and void bills are not owed. A part-paid bill
 * counts its remaining balance, and a quick-pay bill its quick-pay due date and the discounted balance, because both
 * are what the bill row already carries. Today is read in the company time zone, so a Friday evening in Chicago is
 * still that Friday.
 *
 * The lines add up to the open AP total (IN_REVIEW, TO_BE_PAID and PARTIAL), the same bills `useOpenBills` ages.
 */
import type { CarrierBillRecord } from '@/types/tms'

export const CASH_FRIDAYS = 5
export const CASH_ZONE = 'America/Chicago'

const DAY_MS = 86_400_000
const parse = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)))
const format = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** The calendar day it is in `zone` at this moment, as YYYY-MM-DD. */
export function dayInZone(at: Date | string, zone: string = CASH_ZONE): string {
  return new Date(at).toLocaleDateString('en-CA', { timeZone: zone })
}

/** Add whole calendar days to a YYYY-MM-DD day. Date maths is done in UTC, so a daylight-saving change cannot move it. */
export function addDays(day: string, days: number): string {
  return format(parse(day) + days * DAY_MS)
}

/** The first Friday on or after `day`. */
export function fridayOnOrAfter(day: string): string {
  const dow = new Date(parse(day)).getUTCDay() // 0 Sunday … 5 Friday
  return addDays(day, (5 - dow + 7) % 7)
}

/** The next `count` pay Fridays, the first being today when today is a Friday. */
export function nextFridays(today: string, count: number = CASH_FRIDAYS): string[] {
  const first = fridayOnOrAfter(today)
  return Array.from({ length: count }, (_, i) => addDays(first, i * 7))
}

export type CashBill = Pick<CarrierBillRecord, 'id' | 'status' | 'datesPending' | 'dueAt' | 'balanceCents'>

export interface CashLine<B extends CashBill = CashBill> {
  key: string
  label: string
  /** The Friday this line is paid on; null for Later and Not scheduled. */
  friday: string | null
  bills: B[]
  count: number
  totalCents: number
  approvedCents: number
  /** IN_REVIEW money: owed but not yet approved to pay. */
  unapprovedCents: number
  /** Cumulative total through this line, in the order shown. 0 for lines outside the schedule. */
  runningCents: number
}

export interface CashRequirements<B extends CashBill = CashBill> {
  fridays: string[]
  pastDue: CashLine<B>
  weeks: CashLine<B>[]
  later: CashLine<B>
  notScheduled: CashLine<B>
  /** Past due plus the five Fridays. */
  scheduledCents: number
  /** Everything open: the scheduled lines, Later and Not scheduled. Equals open AP. */
  openCents: number
  largestWeek: CashLine<B> | null
}

const isOpen = (b: CashBill) => b.status === 'IN_REVIEW' || b.status === 'TO_BE_PAID' || b.status === 'PARTIAL'

function line<B extends CashBill>(key: string, label: string, friday: string | null, bills: B[]): CashLine<B> {
  let totalCents = 0
  let approvedCents = 0
  for (const b of bills) {
    totalCents += b.balanceCents
    if (b.status !== 'IN_REVIEW') approvedCents += b.balanceCents
  }
  return { key, label, friday, bills, count: bills.length, totalCents, approvedCents, unapprovedCents: totalCents - approvedCents, runningCents: 0 }
}

export function cashRequirements<B extends CashBill>(bills: readonly B[], today: string, count: number = CASH_FRIDAYS): CashRequirements<B> {
  const fridays = nextFridays(today, count)
  const first = fridays[0]
  const last = fridays[fridays.length - 1]
  const pastDue: B[] = []
  const later: B[] = []
  const notScheduled: B[] = []
  const byFriday = new Map<string, B[]>(fridays.map((f) => [f, []]))

  for (const bill of bills) {
    if (!isOpen(bill)) continue
    if (bill.status === 'IN_REVIEW' && bill.datesPending === true) { notScheduled.push(bill); continue }
    const due = (bill.dueAt || '').slice(0, 10)
    if (!due) { notScheduled.push(bill); continue }
    if (due < today) { pastDue.push(bill); continue }
    const payOn = fridayOnOrAfter(due)
    if (payOn > last) later.push(bill)
    else byFriday.get(payOn)!.push(bill)
  }

  const pastLine = line('past-due', `Past due (pay by ${first})`, first, pastDue)
  const weeks = fridays.map((f) => line(f, f, f, byFriday.get(f)!))
  let running = pastLine.totalCents
  pastLine.runningCents = running
  for (const w of weeks) { running += w.totalCents; w.runningCents = running }
  const laterLine = line('later', 'Later (after the fifth Friday)', null, later)
  const notLine = line('not-scheduled', 'Not scheduled (no invoice date)', null, notScheduled)
  const largest = weeks.reduce<CashLine<B> | null>((best, w) => (w.totalCents > (best?.totalCents ?? 0) ? w : best), null)

  return {
    fridays,
    pastDue: pastLine,
    weeks,
    later: laterLine,
    notScheduled: notLine,
    scheduledCents: running,
    openCents: running + laterLine.totalCents + notLine.totalCents,
    largestWeek: largest,
  }
}
