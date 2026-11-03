/**
 * Everything the Financial operations page shows, assembled from existing reads:
 * the brokerage dashboard bundle (one wide window, memoised 5 minutes), the AR/AP cash
 * windows, and the customer / carrier directories for names. All figures come from
 * `lib/financeOps`; this hook only wires reads to it. Read-only — no mutation exists here.
 *
 * One bundle covers the selected window, its previous equal window (for the deltas), the
 * eight chart weeks and the three prior months the revenue target averages, so the
 * previous-window deltas need no second dashboard read.
 */
import { useEffect, useMemo, useState } from 'react'
import { useBrokerageDashboard } from '@/features/tms/dashboard/useBrokerageDashboard'
import { useCarriers } from '@/hooks/useCarriers'
import { useDirectory } from '@/hooks/useDirectory'
import { chicagoDateStr } from '@/lib/date'
import {
  kpiDeltas, kpis, loadRangeFor, monthKey, monthlyRevenue, paymentRows, revenueByDivision, revenueTarget,
  weeklyRevenueByDivision, windowFilters, windowFor,
  type ApPaymentLine, type ArPaymentLine, type FinanceDeltas, type FinanceKpis, type FinancePeriod,
  type PaymentRow, type RevenueTarget, type WeeklyRevenue,
} from '@/lib/financeOps'
import type { DivisionRevenue } from '@/lib/financeOps'
import { listApPaymentsInWindow, listArPaymentsInWindow } from '@/lib/paymentsClient'
import type { FailedMonth } from '@/lib/reportsClient'

interface CashWindow {
  key: string
  ar: ArPaymentLine[]
  ap: ApPaymentLine[]
  error: string | null
}

const messageOf = (err: unknown, fallback: string) => (err instanceof Error && err.message ? err.message : fallback)

export interface FinancialOps {
  loading: boolean
  /** Named read failures; the page shows each, never an empty page. */
  errors: string[]
  failedMonths: FailedMonth[]
  window: { from: string; to: string; previous: { from: string; to: string } }
  kpis: FinanceKpis | null
  deltas: FinanceDeltas | null
  divisions: DivisionRevenue[]
  weekly: WeeklyRevenue | null
  target: RevenueTarget | null
  payments: PaymentRow[]
  /** `false` when the AR/AP cash read failed: credits and the payments table are unknown. */
  paymentsLoaded: boolean
  refresh: () => void
}

export function useFinancialOps(period: FinancePeriod): FinancialOps {
  const [today] = useState(() => chicagoDateStr(new Date()))
  const win = useMemo(() => windowFor(period, today), [period, today])
  const range = useMemo(() => loadRangeFor(win, today), [win, today])
  const rangeFilters = useMemo(() => windowFilters(range.from, range.to), [range])

  const dash = useBrokerageDashboard(rangeFilters)
  const directory = useDirectory()
  const carriers = useCarriers()

  const [reloadToken, setReloadToken] = useState(0)
  const cashKey = `${range.from}|${range.to}|${reloadToken}`
  const [cash, setCash] = useState<CashWindow | null>(null)
  useEffect(() => {
    let live = true
    Promise.all([listArPaymentsInWindow(range.from, range.to), listApPaymentsInWindow(range.from, range.to)]).then(
      ([ar, ap]) => { if (live) setCash({ key: cashKey, ar, ap, error: null }) },
      (err: unknown) => {
        if (live) setCash({ key: cashKey, ar: [], ap: [], error: messageOf(err, 'The payment ledgers could not be read') })
      },
    )
    return () => { live = false }
  }, [range, cashKey])
  const cashSettled = cash?.key === cashKey ? cash : null

  const derived = useMemo(() => {
    const data = dash.data
    if (!data) return null
    const ar = cashSettled?.ar ?? []
    const ap = cashSettled?.ap ?? []
    const paymentsLoaded = cashSettled != null && cashSettled.error == null
    const filters = windowFilters(win.from, win.to)
    const current = kpis(data, filters, ar)
    const previous = kpis(data, windowFilters(win.previous.from, win.previous.to), ar)
    // Unknown, not zero: a failed ledger read cannot say how many credits there were.
    if (!paymentsLoaded) {
      current.creditsCents = null
      previous.creditsCents = null
    }
    const months = [-1, -2, -3].map((offset) => monthKey(win.from, offset))
    const names = {
      customers: new Map(directory.customers.map((c) => [c.id, c.name])),
      carriers: new Map(carriers.carriers.map((c) => [c.id, c.name])),
    }
    return {
      kpis: current,
      deltas: kpiDeltas(current, previous),
      divisions: revenueByDivision(data, filters),
      weekly: weeklyRevenueByDivision(data, today),
      target: revenueTarget(monthlyRevenue(data, months), win),
      payments: paymentsLoaded ? paymentRows(ar, ap, names, win) : [],
      paymentsLoaded,
    }
  }, [dash.data, cashSettled, win, today, directory.customers, carriers.carriers])

  const errors = [
    dash.error,
    cashSettled?.error ? `Payments: ${cashSettled.error}` : null,
    directory.error ? `Customers: ${directory.error}` : null,
    carriers.error ? `Carriers: ${carriers.error}` : null,
  ].filter((e): e is string => e != null)

  return {
    loading: dash.loading || cashSettled == null || directory.loading || carriers.loading,
    errors,
    failedMonths: dash.failedMonths,
    window: { from: win.from, to: win.to, previous: win.previous },
    kpis: derived?.kpis ?? null,
    deltas: derived?.deltas ?? null,
    divisions: derived?.divisions ?? [],
    weekly: derived?.weekly ?? null,
    target: derived?.target ?? null,
    payments: derived?.payments ?? [],
    paymentsLoaded: derived?.paymentsLoaded ?? false,
    refresh: () => {
      dash.refresh()
      setReloadToken((t) => t + 1)
    },
  }
}
