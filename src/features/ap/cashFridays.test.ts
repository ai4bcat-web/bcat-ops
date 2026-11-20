import { describe, expect, it } from 'vitest'
import { addDays, cashRequirements, dayInZone, fridayOnOrAfter, nextFridays, type CashBill } from './cashFridays'

function bill(over: Partial<CashBill> & { id: string }): CashBill {
  return { status: 'TO_BE_PAID', datesPending: false, dueAt: '2026-11-20', balanceCents: 100_00, ...over }
}

describe('pay Fridays', () => {
  it('starts with today when today is a Friday, otherwise the next one, and lists five', () => {
    expect(nextFridays('2026-11-20')).toEqual(['2026-11-20', '2026-11-27', '2026-12-04', '2026-12-11', '2026-12-18'])
    expect(nextFridays('2026-11-16')[0]).toBe('2026-11-20') // a Monday
    expect(fridayOnOrAfter('2026-11-21')).toBe('2026-11-27') // a Saturday rolls to the next Friday
    expect(fridayOnOrAfter('2026-11-22')).toBe('2026-11-27') // a Sunday
  })

  it('adds days across the November daylight-saving change without drifting', () => {
    expect(addDays('2026-11-01', 7)).toBe('2026-11-08')
    expect(nextFridays('2026-10-30', 3)).toEqual(['2026-10-30', '2026-11-06', '2026-11-13'])
  })

  it('reads today in Chicago, so a Friday evening there is still Friday (and 1 a.m. Saturday UTC is not Saturday)', () => {
    expect(dayInZone('2026-11-21T03:30:00Z')).toBe('2026-11-20')
    expect(dayInZone('2026-11-20T12:00:00Z')).toBe('2026-11-20')
  })
})

describe('cash requirements', () => {
  const today = '2026-11-16'

  it('puts a bill on the Friday on or after its due date', () => {
    const cash = cashRequirements([
      bill({ id: 'fri', dueAt: '2026-11-20' }),
      bill({ id: 'sat', dueAt: '2026-11-21' }),
      bill({ id: 'thu', dueAt: '2026-11-26' }),
    ], today)
    expect(cash.weeks[0].bills.map((b) => b.id)).toEqual(['fri'])
    expect(cash.weeks[1].bills.map((b) => b.id)).toEqual(['sat', 'thu'])
  })

  it('puts anything already past due on its own line, and starts the running total with it', () => {
    const cash = cashRequirements([
      bill({ id: 'old', dueAt: '2026-10-01', balanceCents: 500_00 }),
      bill({ id: 'yesterday', dueAt: '2026-11-15', balanceCents: 200_00 }),
      bill({ id: 'today', dueAt: '2026-11-16', balanceCents: 150_00 }), // due today is not past due: pay it Friday
      bill({ id: 'wk1', dueAt: '2026-11-20', balanceCents: 300_00 }),
    ], today)
    expect(cash.pastDue.bills.map((b) => b.id).sort()).toEqual(['old', 'yesterday'])
    expect(cash.pastDue.totalCents).toBe(700_00)
    expect(cash.weeks[0].bills.map((b) => b.id).sort()).toEqual(['today', 'wk1'])
    expect(cash.weeks[0].totalCents).toBe(450_00)
    expect(cash.pastDue.runningCents).toBe(700_00)
    expect(cash.weeks[0].runningCents).toBe(1150_00)
  })

  it('sends a bill due after the fifth Friday to Later, and an undated Expected bill to Not scheduled only', () => {
    const cash = cashRequirements([
      bill({ id: 'far', dueAt: '2027-01-15', balanceCents: 400_00 }),
      bill({ id: 'last', dueAt: '2026-12-18', balanceCents: 100_00 }),
      bill({ id: 'none', status: 'IN_REVIEW', datesPending: true, dueAt: '2026-11-30', balanceCents: 250_00 }),
    ], today)
    expect(cash.later.bills.map((b) => b.id)).toEqual(['far'])
    expect(cash.weeks[4].bills.map((b) => b.id)).toEqual(['last'])
    expect(cash.notScheduled.bills.map((b) => b.id)).toEqual(['none'])
    expect(cash.weeks.flatMap((w) => w.bills).some((b) => b.id === 'none')).toBe(false)
  })

  it('counts the remaining balance of a part-paid bill, the quick-pay due date and discounted amount, and leaves out paid and void', () => {
    const cash = cashRequirements([
      bill({ id: 'part', status: 'PARTIAL', dueAt: '2026-11-27', balanceCents: 60_00 }),
      // Quick pay: due 2 days after the invoice date, balance already net of the 6% discount.
      bill({ id: 'qp', status: 'TO_BE_PAID', dueAt: '2026-11-18', balanceCents: 94_00 }),
      bill({ id: 'paid', status: 'PAID', dueAt: '2026-11-20', balanceCents: 0 }),
      bill({ id: 'void', status: 'VOID', dueAt: '2026-11-20', balanceCents: 99_00 }),
    ], today)
    expect(cash.weeks[0].bills.map((b) => b.id)).toEqual(['qp'])
    expect(cash.weeks[0].totalCents).toBe(94_00)
    expect(cash.weeks[1].totalCents).toBe(60_00)
    expect(cash.openCents).toBe(154_00)
  })

  it('counts every dated bill as payable (no review step), and finds the largest week', () => {
    const cash = cashRequirements([
      bill({ id: 'a', dueAt: '2026-11-27', balanceCents: 100_00 }),
      bill({ id: 'b', status: 'IN_REVIEW', dueAt: '2026-11-27', balanceCents: 40_00 }),
      bill({ id: 'c', dueAt: '2026-12-04', balanceCents: 90_00 }),
    ], today)
    expect(cash.weeks[1]).toMatchObject({ approvedCents: 140_00, totalCents: 140_00 })
    expect(cash.largestWeek?.friday).toBe('2026-11-27')
    expect(cash.scheduledCents).toBe(230_00)
  })

  it('reconciles to open AP: every open bill is on exactly one line', () => {
    const bills = [
      bill({ id: '1', dueAt: '2026-09-01', balanceCents: 11_11 }),
      bill({ id: '2', dueAt: '2026-11-20', balanceCents: 22_22 }),
      bill({ id: '3', status: 'IN_REVIEW', dueAt: '2026-12-11', balanceCents: 33_33 }),
      bill({ id: '4', dueAt: '2027-03-01', balanceCents: 44_44 }),
      bill({ id: '5', status: 'IN_REVIEW', datesPending: true, balanceCents: 55_55 }),
      bill({ id: '6', status: 'PAID', balanceCents: 0 }),
    ]
    const cash = cashRequirements(bills, today)
    const lines = [cash.pastDue, ...cash.weeks, cash.later, cash.notScheduled]
    expect(lines.reduce((n, l) => n + l.count, 0)).toBe(5)
    expect(lines.reduce((n, l) => n + l.totalCents, 0)).toBe(11_11 + 22_22 + 33_33 + 44_44 + 55_55)
    expect(cash.openCents).toBe(166_65)
  })
})
