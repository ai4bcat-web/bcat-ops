import { useState, useEffect, useCallback, useMemo } from 'react'
import { listLoads, listDriverPaySettings, listDriverPayDeductions, listDriverPayCredits } from '@/lib/apiClient'
import type { DriverPaySetting, DriverPayDeduction, DriverPayCredit } from '@/lib/apiClient'
import type { Load } from '@/types'
import { useFuelTransactions } from './useFuelTransactions'
import { useDrivers } from './useDrivers'
import { periodEnd } from './useAmazonPay'
import { matchedFuelForCard, sumFuel } from '@/lib/driverFuel'
import { calcDriverPay, effectivePayRate, effectiveFixedExpenses, fixedExpenseLineLabel, type PayDebitInput } from '@/lib/driverPay'
import { creditLineLabel } from '@/lib/payCredits'
import { ownerOpTripsFor, isOwnerOperatorGroup } from '@/lib/ownerOperatorTrips'
import { aggregateOwnerOperator, type OwnerOpWeekProfit, ownerOperatorWeeksFromLoads } from '@/lib/ownerOperatorProfit'
import { errorText } from '@/lib/errorText'

export type { OwnerOpWeekProfit }
export { aggregateOwnerOperator }

export interface OwnerOperatorProfitabilityState {
  loading: boolean
  error:   string | null
  weeks:   string[]
  rows:    OwnerOpWeekProfit[]
  refresh: () => void
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/**
 * Per-driver, per-week owner-operator profitability: how much each driver grosses on
 * brokerage loads, what the expenses are, and the resulting profit to the company.
 * Covers every pay week on or after OWNER_OP_FIRST_PERIOD that has delivered loads.
 *
 * Mirrors useAmazonProfitability but derives trips from Load.deliveryAppt via
 * ownerOpTripsFor instead of reading AmazonTrip rows. Reuses calcDriverPay and the
 * same fixed/fuel/credit assembly as the owner-operator statement page.
 */
export function useOwnerOperatorProfitability(): OwnerOperatorProfitabilityState {
  const { drivers } = useDrivers()
  const { transactions: fuelTxs } = useFuelTransactions()

  const [loads, setLoads]             = useState<Load[]>([])
  const [settings, setSettings]       = useState<DriverPaySetting[]>([])
  const [deductions, setDeductions]   = useState<DriverPayDeduction[]>([])
  const [credits, setCredits]         = useState<DriverPayCredit[]>([])
  const [loading, setLoading]         = useState(true)
  const [error, setError]             = useState<string | null>(null)

  const load = useCallback(() =>
    Promise.all([listLoads(), listDriverPaySettings(), listDriverPayDeductions(), listDriverPayCredits()])
      .then(([l, s, d, c]) => { setLoads(l); setSettings(s); setDeductions(d); setCredits(c); setError(null) })
      .catch((err: unknown) => { setError(errorText(err)) })
      .finally(() => setLoading(false)),
  [])
  const refresh = useCallback(() => { setLoading(true); return load() }, [load])
  useEffect(() => { void load() }, [load])

  const { weeks, rows } = useMemo(() => {
    const driverById = new Map(drivers.map((d) => [d.id, d]))
    const ownerOpSettings = settings.filter((s) => isOwnerOperatorGroup(s.payGroup) && s.active !== false)

    const rows: OwnerOpWeekProfit[] = []
    for (const setting of ownerOpSettings) {
      const weeks = ownerOperatorWeeksFromLoads(loads, setting.driverId)
      for (const periodStart of weeks) {
        const driverTrips = ownerOpTripsFor(loads, setting.driverId, periodStart)
        if (driverTrips.length === 0) continue
        const end = periodEnd(periodStart)

        const fuel = sumFuel(matchedFuelForCard(fuelTxs, setting.fuelCardNumber, periodStart, end))
        const oneOffs = deductions.filter((x) => x.driverId === setting.driverId && x.periodStart === periodStart)

        const fixed = effectiveFixedExpenses(setting.fixedExpenses, periodStart, end)
        const fixedDebits: PayDebitInput[] = fixed
          .filter((f) => f.afterPercent)
          .map((f) => ({ label: fixedExpenseLineLabel(f), amount: f.amount }))

        const ded = [
          ...fixed.filter((f) => !f.afterPercent).map((f) => ({ label: fixedExpenseLineLabel(f), amount: f.amount })),
          ...(fuel > 0 ? [{ label: `Fuel (card ${setting.fuelCardNumber})`, amount: fuel }] : []),
          ...oneOffs.map((o) => ({ label: o.label, amount: o.amount })),
        ]

        const mine = credits.filter((c) => c.driverId === setting.driverId && c.periodStart === periodStart)
        const driverCredits = mine
          .filter((c) => (c.kind ?? 'CREDIT') === 'CREDIT')
          .map((c) => ({ label: creditLineLabel(c), amount: c.amount, reasonCode: c.reasonCode }))
        const driverDebits = mine
          .filter((c) => c.kind === 'DEBIT')
          .map((c) => ({ label: creditLineLabel(c), amount: c.amount, reasonCode: c.reasonCode }))

        const st = calcDriverPay(
          driverTrips.map((t) => ({ freightAmount: t.freightAmount })),
          effectivePayRate(setting, periodStart),
          ded,
          driverCredits,
          [...fixedDebits, ...driverDebits],
        )
        const companyExpense = round2(fixed.reduce((s, f) => s + (f.companyAmount ?? 0), 0))
        const expenses = round2(st.totalDeductions + st.totalDebits + companyExpense)
        rows.push({
          periodStart,
          driverId:   setting.driverId,
          driverName: driverById.get(setting.driverId)?.name ?? 'Unknown driver',
          gross:      st.gross,
          expenses,
          driverPay:  st.checkAmount,
          profit:     round2(st.gross - st.checkAmount - expenses),
        })
      }
    }
    rows.sort((a, b) => (a.periodStart !== b.periodStart ? (a.periodStart < b.periodStart ? 1 : -1) : a.driverName.localeCompare(b.driverName)))
    const weekSet = new Set(rows.map((r) => r.periodStart))
    const weeks = [...weekSet].sort((a, b) => (a < b ? 1 : -1))
    return { weeks, rows }
  }, [loads, settings, deductions, credits, fuelTxs, drivers])

  return { loading, error, weeks, rows, refresh }
}
