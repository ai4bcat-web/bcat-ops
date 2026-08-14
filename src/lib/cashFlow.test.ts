import { describe, it, expect } from 'vitest'
import {
  project, monthLabels, totalCashCents, totalPayablesCents, dollarsToCents,
  fmtCents, runway, runwayLabel, RUNWAY_CAP_MONTHS, suggestedPayablesSpread,
  SEED_INPUTS, type CashFlowInputs,
} from './cashFlow'

const inputs = (over: Partial<CashFlowInputs> = {}): CashFlowInputs => ({
  ...SEED_INPUTS, weekOf: '2026-08-12', ...over,
})

describe('totals', () => {
  it('sums the two cash accounts', () => {
    expect(totalCashCents(inputs())).toBe(7_611_400) // $76,114
  })

  it('sums all five payable buckets', () => {
    expect(totalPayablesCents(inputs())).toBe(9_050_200) // $90,502
  })
})

describe('project — the seeded model', () => {
  // The sanity check from the spec: with the starter values, M1 closes at $612 and
  // M6 ends at $138,612. If either drifts, the timing rules have changed.
  const p = project(inputs())

  it('matches the reference M1 closing of $612', () => {
    expect(p.months[0].closingCents).toBe(61_200)
  })

  it('matches the reference M6 ending of $138,612', () => {
    expect(p.endingClosingCents).toBe(13_861_200)
  })

  it('reports the lowest closing balance across all six months', () => {
    expect(p.lowestClosingCents).toBe(61_200) // M1 is the trough
  })

  it('walks opening → closing without gaps', () => {
    expect(p.months[0].openingCents).toBe(7_611_400)
    for (let i = 1; i < p.months.length; i++) {
      expect(p.months[i].openingCents).toBe(p.months[i - 1].closingCents)
      expect(p.months[i].closingCents).toBe(p.months[i].openingCents + p.months[i].netCents)
    }
  })
})

describe('project — timing rules', () => {
  const p = project(inputs())

  it('collects 30-day AR in M1 only', () => {
    expect(p.months[0].ar30Cents).toBe(22_000_000)
    expect(p.months.slice(1).every((m) => m.ar30Cents === 0)).toBe(true)
  })

  it('collects 120-day AR in M2 only, net of the rate', () => {
    expect(p.months[1].ar120Cents).toBe(6_300_000) // 70,000 × 90%
    expect(p.months.filter((m) => m.index !== 2).every((m) => m.ar120Cents === 0)).toBe(true)
  })

  it('starts recurring revenue in M2 so M1 does not double-count the 30-day AR', () => {
    expect(p.months[0].revenueCents).toBe(0)
    expect(p.months.slice(1).every((m) => m.revenueCents === 22_000_000)).toBe(true)
  })

  it('clears payables in M1 only', () => {
    expect(p.months[0].payablesCents).toBe(9_050_200)
    expect(p.months.slice(1).every((m) => m.payablesCents === 0)).toBe(true)
  })

  it('runs operating expenses every month', () => {
    expect(p.months.every((m) => m.expensesCents === 20_500_000)).toBe(true)
  })

  it('keeps payables out of the operating-expense figure', () => {
    // Separate inputs, separate outflow lines — month 1 charges both, once each.
    expect(p.months[0].totalOutflowCents).toBe(20_500_000 + 9_050_200)
  })
})

describe('project — guards', () => {
  it('treats blank/NaN fields as zero rather than producing NaN', () => {
    const blank = project(inputs({
      cashBcatCents: NaN, ar30Cents: undefined as unknown as number, recurringRevenueCents: NaN,
    }))
    expect(blank.months.every((m) => Number.isFinite(m.closingCents))).toBe(true)
  })

  it('clamps a collection rate above 100% or below 0', () => {
    expect(project(inputs({ ar120CollectionRate: 3 })).months[1].ar120Cents).toBe(7_000_000)
    expect(project(inputs({ ar120CollectionRate: -1 })).months[1].ar120Cents).toBe(0)
  })

  it('rounds the collection-rate multiply so no sub-cent dust enters the balance', () => {
    const p = project(inputs({ ar120Cents: 3_333_333, ar120CollectionRate: 0.333 }))
    expect(Number.isInteger(p.months[1].ar120Cents)).toBe(true)
    expect(p.months.every((m) => Number.isInteger(m.closingCents))).toBe(true)
  })

  it('flags a breach against the minimum-cash threshold', () => {
    expect(project(inputs()).breachesThreshold).toBe(false)
    expect(project(inputs({ minCashThresholdCents: 10_000_000 })).breachesThreshold).toBe(true)
  })

  it('goes negative rather than clamping when the model says you run out', () => {
    const broke = project(inputs({ cashBcatCents: 0, cashIvanCents: 0, ar30Cents: 0 }))
    expect(broke.lowestClosingCents).toBeLessThan(0)
    expect(broke.breachesThreshold).toBe(true)
  })
})

describe('monthLabels', () => {
  it('starts at the month of weekOf and runs six consecutive months', () => {
    expect(monthLabels('2026-08-12')).toEqual([
      'Aug 2026', 'Sep 2026', 'Oct 2026', 'Nov 2026', 'Dec 2026', 'Jan 2027',
    ])
  })

  it('does not shift a month across the timezone boundary on the 1st', () => {
    expect(monthLabels('2026-08-01')[0]).toBe('Aug 2026')
  })

  it('falls back to today rather than throwing on an unparseable date', () => {
    expect(monthLabels('')).toHaveLength(6)
    expect(monthLabels('not-a-date')).toHaveLength(6)
  })
})

describe('money conversion', () => {
  it('converts typed dollars to integer cents without float dust', () => {
    expect(dollarsToCents('24350.55')).toBe(2_435_055)
    // The float trap: 1.005 * 100 is 100.49999… so Math.round would give 100 cents.
    // Parsing the string exactly gets the cent the user actually typed.
    expect(dollarsToCents('1.005')).toBe(100) // third decimal truncated, not rounded up
    expect(dollarsToCents('0.07')).toBe(7)
    expect(dollarsToCents('1.1')).toBe(110)
    expect(dollarsToCents('-1.25')).toBe(-125)
    expect(dollarsToCents('')).toBe(0)
    expect(dollarsToCents('abc')).toBe(0)
  })

  it('formats cents as whole dollars', () => {
    expect(fmtCents(2_435_000)).toBe('$24,350')
    expect(fmtCents(-120_000)).toBe('-$1,200')
  })
})

describe('runway', () => {
  const burning = (over: Partial<CashFlowInputs> = {}) =>
    // Expenses above revenue → the balance falls every steady month.
    inputs({ recurringRevenueCents: 10_000_000, recurringExpensesCents: 20_500_000, ...over })

  it('reports no limit when a steady month breaks even or better', () => {
    // Seeded: 220k in, 205k out — +15k a month, so it never runs out.
    const r = runway(inputs())
    expect(r.sustainable).toBe(true)
    expect(r.monthsRemaining).toBeNull()
    expect(r.runsOutLabel).toBeNull()
    expect(runwayLabel(r)).toBe('No limit')
  })

  it('reports the steady monthly net, which is what decides if runway is finite', () => {
    expect(runway(inputs()).steadyNetCents).toBe(1_500_000)          // +$15,000
    expect(runway(burning()).steadyNetCents).toBe(-10_500_000)       // −$105,000
  })

  it('counts the months you get through before the balance breaks', () => {
    const r = runway(burning())
    expect(r.sustainable).toBe(false)
    expect(r.monthsRemaining).not.toBeNull()
    // The month it runs out is the first closing below the floor.
    const broke = r.months[r.months.length - 1]
    expect(broke.closingCents).toBeLessThan(0)
    expect(r.runsOutLabel).toBe(broke.label)
    // Every earlier month stayed above.
    expect(r.months.slice(0, -1).every((m) => m.closingCents >= 0)).toBe(true)
  })

  it('keeps one month past the break so the decline is visible, not truncated', () => {
    const r = runway(burning())
    expect(r.months).toHaveLength((r.monthsRemaining ?? 0) + 1)
  })

  it('reports "under a month" when month 1 already closes below the floor', () => {
    const r = runway(burning({ cashBcatCents: 0, cashIvanCents: 0, ar30Cents: 0 }))
    expect(r.monthsRemaining).toBe(0)
    expect(runwayLabel(r)).toBe('Under a month')
  })

  it('measures against the minimum-cash threshold, not zero', () => {
    // Seeded model dips to $612 in M1, so a $50k floor is breached there — but it recovers
    // to $78,612 in M2 and keeps climbing, so it's a dip to act on, not the end of runway.
    const r = runway(inputs({ minCashThresholdCents: 5_000_000 }))
    expect(r.temporaryDipLabel).toBe('Aug 2026')
    expect(r.monthsRemaining).toBeNull()

    // Raise the floor above the whole trajectory and it really is out of runway.
    const hard = runway(inputs({ minCashThresholdCents: 100_000_000 }))
    expect(hard.monthsRemaining).toBe(0)
    expect(hard.sustainable).toBe(false)
  })

  it('flags when you are already under the floor today', () => {
    expect(runway(inputs()).alreadyBelow).toBe(false)
    expect(runway(inputs({ minCashThresholdCents: 20_000_000 })).alreadyBelow).toBe(true)
  })

  it('pluralises the label', () => {
    expect(runwayLabel({ ...runway(burning()), monthsRemaining: 1 })).toBe('1 month')
    expect(runwayLabel({ ...runway(burning()), monthsRemaining: 8 })).toBe('8 months')
  })

  it('stops at the cap rather than walking forever on a tiny burn', () => {
    // A burn so small it would take centuries — capped, and reported as no limit.
    const r = runway(inputs({ recurringExpensesCents: 22_000_100 }))
    expect(r.months.length).toBeLessThanOrEqual(RUNWAY_CAP_MONTHS)
  })

  it('starts from total cash on hand', () => {
    expect(runway(inputs()).startingCashCents).toBe(7_611_400)
  })
})

describe('runway — a dip is not the end', () => {
  // Month 1 clears every payable at once BEFORE recurring revenue starts, so the balance
  // can trough there and recover in month 2. Ending the runway at that first dip would
  // report "under a month" for a business with years of cash — the bug these pin down.
  const dipping = (opex: number) =>
    inputs({ recurringRevenueCents: 22_000_000, recurringExpensesCents: opex })

  it('does not end the runway on a dip that recovers', () => {
    // Break-even steady state: dips in Aug, recovers, never permanently short.
    const r = runway(dipping(22_000_000))
    expect(r.monthsRemaining).toBeNull()
    expect(runwayLabel(r)).toBe('No limit')
    expect(r.temporaryDipLabel).toBe('Aug 2026')
  })

  it('counts the months you get through, past a temporary dip', () => {
    // −$15k a month: troughs in Aug, recovers Sep, permanently short from Dec.
    const r = runway(dipping(23_500_000))
    expect(r.monthsRemaining).toBe(3)
    expect(runwayLabel(r)).toBe('3 months')
    expect(r.temporaryDipLabel).toBe('Aug 2026')
    expect(r.runsOutLabel).toBe('Nov 2026')
  })

  it('reports the last month above the floor, not the first below it', () => {
    const r = runway(dipping(23_500_000))
    const kept = r.months.slice(0, r.monthsRemaining ?? 0)
    // The final month shown is the one that breaks; everything before it is the runway.
    expect(kept[kept.length - 1].closingCents).toBeGreaterThanOrEqual(0)
    expect(r.months[r.months.length - 1].closingCents).toBeLessThan(0)
  })

  it('leaves temporaryDipLabel null when the balance never recovers', () => {
    const r = runway(dipping(30_000_000)) // straight down, no recovery
    expect(r.monthsRemaining).toBe(0)
    expect(r.temporaryDipLabel).toBeNull()
  })

  it('leaves temporaryDipLabel null when there is no dip at all', () => {
    expect(runway(inputs()).temporaryDipLabel).toBeNull()
  })
})

describe('staggering payables', () => {
  it('pays the whole backlog in month 1 by default', () => {
    const p = project(inputs())
    expect(p.months[0].payablesCents).toBe(9_050_200)
    expect(p.months.slice(1).every((m) => m.payablesCents === 0)).toBe(true)
  })

  it('lifts the month-1 trough when spread over two months', () => {
    const one = project(inputs())
    const two = project(inputs({ payablesSpreadMonths: 2 }))
    expect(two.months[0].closingCents).toBeGreaterThan(one.months[0].closingCents)
    expect(two.lowestClosingCents).toBe(4_586_300)  // $45,863, up from $612
  })

  it('does not change where you end up — the money still goes out', () => {
    // Deferring is a timing lever, not a saving. M6 must be identical.
    const one = project(inputs())
    for (const spread of [2, 3, 4]) {
      expect(project(inputs({ payablesSpreadMonths: spread })).endingClosingCents)
        .toBe(one.endingClosingCents)
    }
  })

  it('pays out exactly the payables total, whatever the spread', () => {
    for (const spread of [1, 2, 3, 4, 5, 6]) {
      const paid = project(inputs({ payablesSpreadMonths: spread }))
        .months.reduce((s, m) => s + m.payablesCents, 0)
      expect(paid).toBe(9_050_200) // no cents lost to rounding
    }
  })

  it('puts the rounding remainder on month 1 rather than dropping it', () => {
    // 3 doesn't divide evenly into the seeded total.
    const p = project(inputs({ payablesSpreadMonths: 3 }))
    const [m1, m2, m3] = p.months
    expect(m1.payablesCents).toBeGreaterThanOrEqual(m2.payablesCents)
    expect(m2.payablesCents).toBe(m3.payablesCents)
    expect(m1.payablesCents + m2.payablesCents + m3.payablesCents).toBe(9_050_200)
  })

  it('clamps a nonsense spread rather than dividing by zero', () => {
    expect(project(inputs({ payablesSpreadMonths: 0 })).months[0].payablesCents).toBe(9_050_200)
    expect(project(inputs({ payablesSpreadMonths: -3 })).months[0].payablesCents).toBe(9_050_200)
    const wide = project(inputs({ payablesSpreadMonths: 99 }))
    expect(wide.months.every((m) => m.payablesCents > 0)).toBe(true) // capped at the horizon
  })
})

describe('suggestedPayablesSpread', () => {
  it('says 1 when nothing needs staggering', () => {
    expect(suggestedPayablesSpread(inputs())).toBe(1)
  })

  it('finds the smallest spread that clears the floor', () => {
    // A $50k floor breaks the $612 August trough; two months lifts it to $45,863,
    // three to $60,947 — so three is the smallest that works.
    expect(suggestedPayablesSpread(inputs({ minCashThresholdCents: 5_000_000 }))).toBe(3)
  })

  it('returns null when deferring cannot fix it', () => {
    // Deferring moves money, it doesn't create it — a floor above the whole trajectory
    // is unreachable no matter how the payables are staggered.
    expect(suggestedPayablesSpread(inputs({ minCashThresholdCents: 100_000_000 }))).toBeNull()
  })
})
