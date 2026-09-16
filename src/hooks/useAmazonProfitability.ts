import { useState, useEffect, useCallback, useMemo } from 'react'
import { listAmazonTrips, listDriverPaySettings, listDriverPayDeductions, listDriverPayCredits } from '@/lib/apiClient'
import type { AmazonTrip, DriverPaySetting, DriverPayDeduction, DriverPayCredit } from '@/lib/apiClient'
import { useFuelTransactions } from './useFuelTransactions'
import { useDrivers } from './useDrivers'
import { periodEnd } from './useAmazonPay'
import { matchedFuelForCard, sumFuel } from '@/lib/driverFuel'
import { calcDriverPay, effectivePayRate, effectiveFixedExpenses, fixedExpenseLineLabel, type PayDebitInput } from '@/lib/driverPay'
import { creditLineLabel } from '@/lib/payCredits'

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/** Inclusive day count between two YYYY-MM-DD dates (UTC, calendar days). */
function inclusiveDays(start: string, end: string): number {
  const s = Date.UTC(+start.slice(0, 4), +start.slice(5, 7) - 1, +start.slice(8, 10))
  const e = Date.UTC(+end.slice(0, 4), +end.slice(5, 7) - 1, +end.slice(8, 10))
  return Math.floor((e - s) / 86_400_000) + 1
}

/** Aggregate of driver-week rows whose pay week falls in [startIso, endIso]. */
export interface AmazonAgg {
  revenue:   number   // gross billed
  driverPay: number
  expenses:  number   // fuel + fixed + one-offs
  profit:    number   // to the company
  rows:      DriverWeekProfit[]
}
export function aggregateAmazon(
  rows: DriverWeekProfit[],
  startIso: string,
  endIso: string,
  opts?: { prorate?: boolean },
): AmazonAgg {
  const prorate = opts?.prorate ?? false
  if (!prorate) {
    const inRange = rows.filter((r) => r.periodStart >= startIso && r.periodStart <= endIso)
    return {
      revenue:   round2(inRange.reduce((s, r) => s + r.gross, 0)),
      driverPay: round2(inRange.reduce((s, r) => s + r.driverPay, 0)),
      expenses:  round2(inRange.reduce((s, r) => s + r.expenses, 0)),
      profit:    round2(inRange.reduce((s, r) => s + r.profit, 0)),
      rows:      inRange,
    }
  }

  // Monthly / multi-week view: prorate each weekly row by the days that overlap
  // [startIso, endIso]. Matches the fleet profitability engine's pay proration.
  const scaled: DriverWeekProfit[] = []
  for (const r of rows) {
    const rEnd = periodEnd(r.periodStart)
    const oStart = r.periodStart > startIso ? r.periodStart : startIso
    const oEnd = rEnd < endIso ? rEnd : endIso
    if (oStart > oEnd) continue
    const overlapDays = inclusiveDays(oStart, oEnd)
    const totalDays = inclusiveDays(r.periodStart, rEnd)
    const f = overlapDays / totalDays
    const gross = round2(r.gross * f)
    const driverPay = round2(r.driverPay * f)
    const expenses = round2(r.expenses * f)
    scaled.push({
      ...r,
      gross,
      driverPay,
      expenses,
      profit: round2(gross - driverPay - expenses),
    })
  }
  return {
    revenue:   round2(scaled.reduce((s, r) => s + r.gross, 0)),
    driverPay: round2(scaled.reduce((s, r) => s + r.driverPay, 0)),
    expenses:  round2(scaled.reduce((s, r) => s + r.expenses, 0)),
    profit:    round2(scaled.reduce((s, r) => s + r.profit, 0)),
    rows:      scaled,
  }
}

/** One driver's company economics for one pay week. */
export interface DriverWeekProfit {
  periodStart: string
  driverId:    string
  driverName:  string
  gross:       number   // freight billed (revenue this driver generated)
  expenses:    number   // fuel + fixed + one-off deductions + costs recovered via debits
  driverPay:   number   // the driver's check this week (after credits and debits)
  profit:      number   // to the company = gross − driverPay − expenses
}

export interface AmazonProfitabilityState {
  loading: boolean
  error:   string | null
  weeks:   string[]              // week starts that have trips, newest first
  rows:    DriverWeekProfit[]    // one per (week, driver), newest week first
  refresh: () => void
}

/**
 * Per-driver, per-week Amazon profitability: how much each driver grosses, what the
 * expenses are, and the resulting profit to the company. Covers every pay week that
 * has trips. Mirrors useAmazonPay's statement math (calcDriverPay + tolerant fuel-card
 * match + credits/debits) but rolled across all weeks.
 *
 * Credits (detention, bonus…) are money the company pays on top of the % model, so
 * they reduce profit. Debits recover, at 100%, a cost the company already paid on the
 * driver's behalf (lease mileage, IFTA, a cash advance…) — that cost is not booked
 * anywhere else in the Amazon P&L, so it is counted as an expense here and the debit
 * takes it back out of the check: profit is unchanged, driver pay is the real check.
 * A fixed charge may also carry a `companyAmount` — the company's own share of a split
 * charge (e.g. its half of a truck lease). It is a real cost that never appears on the
 * statement, so it is added to expenses here whether the driver's side is pre- or after-split.
 */
export function useAmazonProfitability(): AmazonProfitabilityState {
  const { drivers } = useDrivers()
  const { transactions: fuelTxs } = useFuelTransactions()

  const [trips, setTrips]           = useState<AmazonTrip[]>([])
  const [settings, setSettings]     = useState<DriverPaySetting[]>([])
  const [deductions, setDeductions] = useState<DriverPayDeduction[]>([])
  const [credits, setCredits]       = useState<DriverPayCredit[]>([])
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [t, s, d, c] = await Promise.all([listAmazonTrips(), listDriverPaySettings(), listDriverPayDeductions(), listDriverPayCredits()])
      setTrips(t); setSettings(s); setDeductions(d); setCredits(c)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const { weeks, rows } = useMemo(() => {
    const driverById = new Map(drivers.map((d) => [d.id, d]))
    const amazon = settings.filter((s) => (s.payGroup ?? 'AMAZON') === 'AMAZON' && s.active !== false)
    const amazonIds = new Set(amazon.map((s) => s.driverId))

    // Weeks that actually have trips for an Amazon driver.
    const weekSet = new Set<string>()
    for (const t of trips) if (amazonIds.has(t.driverId)) weekSet.add(t.periodStart)
    const weeks = [...weekSet].sort((a, b) => (a < b ? 1 : -1))

    const rows: DriverWeekProfit[] = []
    for (const periodStart of weeks) {
      const end = periodEnd(periodStart)
      for (const setting of amazon) {
        const driverTrips = trips.filter((t) => t.driverId === setting.driverId && t.periodStart === periodStart)
        if (driverTrips.length === 0) continue

        // Fuel for the window — real fuel only, de-duplicated (shared helper).
        const fuel = sumFuel(matchedFuelForCard(fuelTxs, setting.fuelCardNumber, periodStart, end))

        const oneOffs = deductions.filter((x) => x.driverId === setting.driverId && x.periodStart === periodStart)

        const fixed = effectiveFixedExpenses(setting.fixedExpenses, periodStart, end)
        const fixedDebits: PayDebitInput[] = fixed
          .filter((f) => f.afterPercent)
          .map((f) => ({ label: fixedExpenseLineLabel(f), amount: f.amount }))

        const ded = [
          ...fixed.filter((f) => !f.afterPercent).map((f) => ({ label: fixedExpenseLineLabel(f), amount: f.amount })),
          ...(fuel > 0 ? [{ label: 'Fuel', amount: fuel }] : []),
          ...oneOffs.map((o) => ({ label: o.label, amount: o.amount })),
        ]

        const mine = credits.filter((c) => c.driverId === setting.driverId && c.periodStart === periodStart)
        // null kind = CREDIT: rows written before debits existed are credits (same as useAmazonPay).
        const driverCredits = mine.filter((c) => (c.kind ?? 'CREDIT') === 'CREDIT').map((c) => ({ label: creditLineLabel(c), amount: c.amount, reasonCode: c.reasonCode }))
        const driverDebits  = mine.filter((c) => c.kind === 'DEBIT').map((c) => ({ label: creditLineLabel(c), amount: c.amount, reasonCode: c.reasonCode }))

        const st = calcDriverPay(
          driverTrips.map((t) => ({ freightAmount: t.freightAmount, status: t.status })),
          effectivePayRate(setting, periodStart), // pinned window if one covers this week
          ded,
          driverCredits,
          [...fixedDebits, ...driverDebits],
        )
        const companyExpense = round2(fixed.reduce((s, f) => s + (f.companyAmount ?? 0), 0))
        const expenses = round2(st.totalDeductions + st.totalDebits + companyExpense)
        const profit = round2(st.gross - st.checkAmount - expenses)
        rows.push({
          periodStart,
          driverId:   setting.driverId,
          driverName: driverById.get(setting.driverId)?.name ?? 'Unknown driver',
          gross:      st.gross,
          expenses,
          driverPay:  st.checkAmount,
          profit,
        })
      }
    }
    rows.sort((a, b) => (a.periodStart !== b.periodStart ? (a.periodStart < b.periodStart ? 1 : -1) : a.driverName.localeCompare(b.driverName)))
    return { weeks, rows }
  }, [trips, settings, deductions, credits, fuelTxs, drivers])

  return { loading, error, weeks, rows, refresh: load }
}
