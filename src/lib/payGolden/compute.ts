/**
 * Pay-math snapshot driver.
 *
 * Runs every pay / settlement path over the synthetic production-shaped fixture and returns
 * one JSON-able object. `golden.json` is that object as produced by the pure libs on
 * `origin/main` BEFORE the dev merge; payGolden.test.ts asserts the merged tree returns the
 * same numbers.
 *
 * The orchestration below mirrors the hooks it stands in for (useAmazonPay, useBoxTruckPay,
 * useOwnerOperatorPay, driver-app-api buildSettlement) — those hooks cannot run in a plain
 * module, but every number they show comes out of the functions called here. Relative
 * imports only: the golden run points this file at an extracted origin/main tree.
 */
import {
  calcDriverPay,
  tripPayAmount,
  effectivePayRate,
  effectiveFixedExpenses,
  fixedExpenseLineLabel,
  factoringFeePctFor,
  type PayDeductionInput,
  type PayDebitInput,
} from '../driverPay'
import { matchedFuelForCard, sumFuel, effectiveFuelCard } from '../driverFuel'
import { creditLineLabel } from '../payCredits'
import { creditCounts } from '../payCreditApproval'
import { splitPayableTrips } from '../payHold'
import {
  ownerOpTripsFor,
  ownerOpCarriesWeeklyCharges,
  ownerOpWeekAtOrAfterFirst,
  isOwnerOperatorGroup,
  ratePerMile,
} from '../ownerOperatorTrips'
import { aggregateOwnerOperator, ownerOperatorWeeksFromLoads } from '../ownerOperatorProfit'
import { revenueByFleet, loadsByFleet } from '../revenueByFleet'
import { payForPeriod, rateOn } from '../hoursPay'
import { parseBoxTruckRows } from '../boxTruckCsv'
import { buildSettlement, listWeekStarts } from '../../../amplify/functions/driver-app-api/settlement'

/** The clock buildSettlement reads for its "not delivered yet" hold. */
const NOW = '2026-11-07T12:00:00.000Z'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>
export interface PayFixture {
  weeks: string[]
  drivers: Row[]
  settings: Row[]
  amazonTrips: Row[]
  boxTrips: Row[]
  loads: Row[]
  credits: Row[]
  deductions: Row[]
  fuel: Row[]
  hourly: { setting: Row; unrated: Row; days: { date: string; minutes: number }[] }
  csv: string
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** Run `fn` with `new Date()` / `Date.now()` pinned. */
function atFixedNow<T>(iso: string, fn: () => T): T {
  const Real = Date
  const fixed = new Real(iso).getTime()
  class Pinned extends Real {
    constructor(...args: any[]) {
      if (args.length === 0) super(fixed)
      else super(...(args as [any]))
    }
    static now() { return fixed }
  }
  ;(globalThis as any).Date = Pinned
  try { return fn() } finally { (globalThis as any).Date = Real }
}

const byCreated = (a: Row, b: Row) => (a.date ?? '').localeCompare(b.date ?? '') || a.createdAt.localeCompare(b.createdAt)

interface Charges {
  ded: PayDeductionInput[]
  fixedDebits: PayDebitInput[]
  fuel: number
}

function charges(fx: PayFixture, setting: Row, periodStart: string, end: string, carries = true): Charges {
  const card = effectiveFuelCard(setting as any, periodStart)
  const fuel = carries ? sumFuel(matchedFuelForCard(fx.fuel as any, card, periodStart, end)) : 0
  const oneOffs = carries ? fx.deductions.filter((x) => x.driverId === setting.driverId && x.periodStart === periodStart) : []
  const fixed = carries ? effectiveFixedExpenses(setting.fixedExpenses, periodStart, end) : []
  return {
    fuel,
    fixedDebits: fixed.filter((f) => f.afterPercent).map((f) => ({ label: fixedExpenseLineLabel(f), amount: f.amount })),
    ded: [
      ...fixed.filter((f) => !f.afterPercent).map((f) => ({ label: fixedExpenseLineLabel(f), amount: f.amount })),
      ...(fuel > 0 ? [{ label: `Fuel (card ${card ?? ''})`, amount: fuel }] : []),
      ...oneOffs.map((o) => ({ label: o.label, amount: o.amount })),
    ],
  }
}

const creditLine = (c: Row) => ({ label: creditLineLabel(c), amount: c.amount, reasonCode: c.reasonCode })

/** useAmazonPay: one statement per Amazon-group driver per week. */
function amazonStatements(fx: PayFixture) {
  const out: Row[] = []
  for (const periodStart of fx.weeks) {
    const end = addDays(periodStart, 6)
    for (const base of fx.settings.filter((s) => (s.payGroup ?? 'AMAZON') === 'AMAZON' && s.active !== false)) {
      const setting = { ...base, ...effectivePayRate(base as any, periodStart) }
      const trips = fx.amazonTrips.filter((t) => t.driverId === base.driverId && t.periodStart === periodStart && t.id !== 'at-future')
      const carries = !ownerOpCarriesWeeklyCharges(periodStart)
      const c = charges(fx, setting, periodStart, end, carries)
      const mine = fx.credits.filter((x) => carries && x.driverId === base.driverId && x.periodStart === periodStart).sort(byCreated)
      const statement = calcDriverPay(
        trips.map((t) => ({ freightAmount: t.freightAmount, status: t.status })),
        { payPercent: setting.payPercent, expensesBeforePercent: setting.expensesBeforePercent, factoringFeePct: factoringFeePctFor('AMAZON') },
        c.ded,
        mine.filter((x) => (x.kind ?? 'CREDIT') === 'CREDIT').map(creditLine),
        [...c.fixedDebits, ...mine.filter((x) => x.kind === 'DEBIT').map(creditLine)],
      )
      out.push({ driverId: base.driverId, periodStart, carries, fuel: c.fuel, deductions: c.ded, fixedDebits: c.fixedDebits, perTrip: trips.map((t) => tripPayAmount(t.freightAmount, setting as any)), statement })
    }
  }
  return out
}

/** useBoxTruckPay: BOX_TRUCK-group drivers, trip pay basis = grossProfit; PENDING credits stay off. */
function boxTruckStatements(fx: PayFixture) {
  const out: Row[] = []
  const periods = [...new Set(fx.boxTrips.map((t) => t.periodStart))].sort()
  for (const periodStart of periods) {
    const end = addDays(periodStart, 6)
    for (const base of fx.settings.filter((s) => s.payGroup === 'BOX_TRUCK' && s.active !== false)) {
      const setting = { ...base, ...effectivePayRate(base as any, periodStart) }
      const trips = fx.boxTrips.filter((t) => t.driverId === base.driverId && t.periodStart === periodStart)
      const c = charges(fx, setting, periodStart, end)
      const mine = fx.credits.filter((x) => x.driverId === base.driverId && x.periodStart === periodStart).sort(byCreated)
      const all = mine.filter((x) => (x.kind ?? 'CREDIT') === 'CREDIT')
      const statement = calcDriverPay(
        trips.map((t) => ({ freightAmount: t.grossProfit, status: t.status })),
        effectivePayRate(setting as any, periodStart),
        c.ded,
        all.filter(creditCounts as any).map(creditLine),
        [...c.fixedDebits, ...mine.filter((x) => x.kind === 'DEBIT').map(creditLine)],
      )
      out.push({
        driverId: base.driverId, periodStart, fuel: c.fuel, deductions: c.ded, statement,
        pendingCredits: all.filter((x) => !creditCounts(x as any)).map((x) => x.id),
      })
    }
  }
  return out
}

/** useOwnerOperatorPay: trips come from delivered Load rows; a load without a POD is held. */
function ownerOperatorStatements(fx: PayFixture) {
  const out: Row[] = []
  const drivers = new Map(fx.drivers.map((d) => [d.id, d]))
  for (const requested of fx.weeks) {
    const periodStart = ownerOpWeekAtOrAfterFirst(requested)
    const end = addDays(periodStart, 6)
    for (const base of fx.settings.filter((s) => isOwnerOperatorGroup(s.payGroup) && s.active !== false)) {
      const driver = drivers.get(base.driverId)
      if (!driver || driver.type === 'broker') continue
      const setting = { ...base, ...effectivePayRate(base as any, periodStart) }
      const trips = ownerOpTripsFor(fx.loads as any, base.driverId, periodStart).map((t, i) => ({
        ...t,
        // Deterministic stand-in for the POD index: every third trip has no POD yet.
        readiness: { missingDocuments: i % 3 === 2 ? (['POD'] as Array<'POD'>) : ([] as Array<'POD'>) },
      }))
      const c = charges(fx, setting, periodStart, end)
      const mine = fx.credits.filter((x) => x.driverId === base.driverId && x.periodStart === periodStart).sort(byCreated)
      const { payable, held, heldFreight } = splitPayableTrips(trips, { podsKnown: true })
      const statement = calcDriverPay(
        payable.map((t) => ({ freightAmount: t.freightAmount })),
        setting as any,
        c.ded,
        mine.filter((x) => (x.kind ?? 'CREDIT') === 'CREDIT').map(creditLine),
        [...c.fixedDebits, ...mine.filter((x) => x.kind === 'DEBIT').map(creditLine)],
      )
      const unknown = splitPayableTrips(trips, { podsKnown: false })
      out.push({
        driverId: base.driverId, requested, periodStart, trips, held: held.map((h) => ({ id: h.trip.id, reason: h.reason })), heldFreight,
        payableWhenPodsUnknown: unknown.payable.length, fuel: c.fuel, deductions: c.ded, statement,
      })
    }
  }
  return out
}

/** driver-app-api buildSettlement: what the driver sees on the phone. */
function driverAppSettlements(fx: PayFixture) {
  const out: Row[] = []
  for (const periodStart of fx.weeks) {
    for (const s of fx.settings.filter((x) => x.active !== false)) {
      const trips = fx.amazonTrips.filter((t) => t.driverId === s.driverId && t.periodStart === periodStart).map((t) => ({ ...t }))
      const credits = fx.credits.filter((c) => c.driverId === s.driverId && c.periodStart === periodStart && (c.kind ?? 'CREDIT') === 'CREDIT' && creditCounts(c as any))
      const debits = fx.credits.filter((c) => c.driverId === s.driverId && c.periodStart === periodStart && c.kind === 'DEBIT')
      const deds = fx.deductions.filter((d) => d.driverId === s.driverId && d.periodStart === periodStart)
      out.push({
        driverId: s.driverId, periodStart,
        settlement: atFixedNow(NOW, () => buildSettlement(periodStart, trips as any, s as any, deds as any, credits as any, debits as any, fx.fuel as any)),
      })
    }
  }
  return out
}

export function computePayGolden(fx: PayFixture): unknown {
  const periodGrid = fx.weeks.map((w) => [w, addDays(w, 6)] as const)
  const result = {
    amazon: amazonStatements(fx),
    boxTruck: boxTruckStatements(fx),
    ownerOperator: ownerOperatorStatements(fx),
    driverAppSettlement: driverAppSettlements(fx),
    weekStarts: atFixedNow(NOW, () => ({
      all: listWeekStarts(fx.amazonTrips as any, new Date()),
      floored: listWeekStarts(fx.amazonTrips as any, new Date(), '2026-09-27'),
      none: listWeekStarts([], new Date(), '2026-09-27'),
    })),
    tripPay: fx.settings.map((s) => ({ id: s.id, perThousand: tripPayAmount(1000, s as any), perOdd: tripPayAmount(1234.56, s as any) })),
    rateWindows: fx.settings.flatMap((s) => fx.weeks.map((w) => ({ id: s.id, w, rate: effectivePayRate(s as any, w) }))),
    fixedExpenses: fx.settings.flatMap((s) => periodGrid.map(([a, b]) => ({ id: s.id, a, lines: effectiveFixedExpenses(s.fixedExpenses, a, b) }))),
    ratePerMile: fx.loads.map((l) => ratePerMile(l.rate == null ? null : l.rate / 100, l.miles)),
    ownerOpWeeks: fx.drivers.map((d) => ({ id: d.id, weeks: ownerOperatorWeeksFromLoads(fx.loads as any, d.id) })),
    revenueByFleet: revenueByFleet(fx.loads as any, fx.drivers as any),
    loadsByFleet: loadsByFleet(fx.loads as any, fx.drivers as any),
    ownerOpProfit: (() => {
      const rows = ownerOperatorStatements(fx).map((r) => ({
        periodStart: r.periodStart,
        driverId: r.driverId,
        driverName: r.driverId,
        gross: r.statement.gross,
        expenses: Math.round((r.statement.totalDeductions + 0) * 100) / 100,
        driverPay: r.statement.checkAmount,
        profit: Math.round((r.statement.gross - r.statement.checkAmount - r.statement.totalDeductions) * 100) / 100,
      }))
      return {
        rows,
        week: aggregateOwnerOperator(rows, '2026-10-04', '2026-10-04'),
        range: aggregateOwnerOperator(rows, '2026-09-27', '2026-10-11'),
        prorated: aggregateOwnerOperator(rows, '2026-10-01', '2026-10-09', { prorate: true }),
      }
    })(),
    hourly: {
      rated: payForPeriod(fx.hourly.days, fx.hourly.setting),
      unrated: payForPeriod(fx.hourly.days, fx.hourly.unrated),
      firstWeek: payForPeriod(fx.hourly.days.slice(0, 7), fx.hourly.setting),
      rateOn: ['2026-09-14', '2026-09-15', '2026-10-09', '2026-10-10'].map((d) => rateOn(fx.hourly.setting, d)),
    },
    boxTruckCsv: parseBoxTruckRows(fx.csv),
  }
  // Normalise exactly like the golden file: JSON round trip (drops undefined, fixes -0).
  return JSON.parse(JSON.stringify(result))
}
