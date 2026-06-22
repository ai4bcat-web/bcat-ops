import { useState, useEffect, useCallback, useMemo } from 'react'
import { listAmazonTrips, listDriverPaySettings, listDriverPayDeductions } from '@/lib/apiClient'
import type { AmazonTrip, DriverPaySetting, DriverPayDeduction } from '@/lib/apiClient'
import { useFuelTransactions } from './useFuelTransactions'
import { useDrivers } from './useDrivers'
import { normalizeCard, periodEnd } from './useAmazonPay'
import { calcDriverPay } from '@/lib/driverPay'

/** One driver's company economics for one pay week. */
export interface DriverWeekProfit {
  periodStart: string
  driverId:    string
  driverName:  string
  gross:       number   // freight billed (revenue this driver generated)
  expenses:    number   // fuel + fixed + one-off deductions
  driverPay:   number   // the driver's check this week
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
 * match) but rolled across all weeks.
 */
export function useAmazonProfitability(): AmazonProfitabilityState {
  const { drivers } = useDrivers()
  const { transactions: fuelTxs } = useFuelTransactions()

  const [trips, setTrips]           = useState<AmazonTrip[]>([])
  const [settings, setSettings]     = useState<DriverPaySetting[]>([])
  const [deductions, setDeductions] = useState<DriverPayDeduction[]>([])
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [t, s, d] = await Promise.all([listAmazonTrips(), listDriverPaySettings(), listDriverPayDeductions()])
      setTrips(t); setSettings(s); setDeductions(d)
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

        // Fuel for the window (tolerant card match — see useAmazonPay).
        let fuel = 0
        const wantCard = normalizeCard(setting.fuelCardNumber)
        if (wantCard) {
          for (const tx of fuelTxs) {
            if (normalizeCard(tx.cardNumber) !== wantCard) continue
            if ((tx.itemCategory ?? 'FUEL') !== 'FUEL') continue
            if (tx.transactionDate < periodStart || tx.transactionDate > end) continue
            fuel += tx.amount
          }
        }
        fuel = Math.round(fuel * 100) / 100

        const oneOffs = deductions.filter((x) => x.driverId === setting.driverId && x.periodStart === periodStart)
        const ded = [
          ...(setting.fixedExpenses ?? []).map((f) => ({ label: f.label, amount: f.amount })),
          ...(fuel > 0 ? [{ label: 'Fuel', amount: fuel }] : []),
          ...oneOffs.map((o) => ({ label: o.label, amount: o.amount })),
        ]

        const st = calcDriverPay(
          driverTrips.map((t) => ({ freightAmount: t.freightAmount, status: t.status })),
          { payPercent: setting.payPercent, expensesBeforePercent: setting.expensesBeforePercent },
          ded,
        )
        const profit = Math.round((st.gross - st.checkAmount - st.totalDeductions) * 100) / 100
        rows.push({
          periodStart,
          driverId:   setting.driverId,
          driverName: driverById.get(setting.driverId)?.name ?? 'Unknown driver',
          gross:      st.gross,
          expenses:   st.totalDeductions,
          driverPay:  st.checkAmount,
          profit,
        })
      }
    }
    rows.sort((a, b) => (a.periodStart !== b.periodStart ? (a.periodStart < b.periodStart ? 1 : -1) : a.driverName.localeCompare(b.driverName)))
    return { weeks, rows }
  }, [trips, settings, deductions, fuelTxs, drivers])

  return { loading, error, weeks, rows, refresh: load }
}
