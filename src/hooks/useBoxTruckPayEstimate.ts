import { useEffect, useMemo, useState } from 'react'
import { listDriverPaySettings, type DriverPaySetting } from '@/lib/apiClient'
import { boxTruckPayEstimate } from '@/lib/profitReview'
import { localSubgroupOf } from '@/lib/localSubgroups'
import type { DateRange, TruckProfitability } from '@/lib/fleetProfitability'

let cached: Promise<DriverPaySetting[]> | null = null
function paySettingsOnce(): Promise<DriverPaySetting[]> {
  if (!cached) cached = listDriverPaySettings().catch(() => { cached = null; return [] })
  return cached
}

/**
 * The box truck's driver pay for a range, from the BOX_TRUCK pay setting (pay % of revenue
 * after the fixed charges each 14-day period carries). It is settled on its own page and is
 * not in the fleet's combined driver-pay entry, so the Finances P&L and the Profit Review
 * both add it from this one rule. Revenue is what the engine put on the box truck(s).
 */
export function useBoxTruckPayEstimate(range: DateRange, trucks: readonly TruckProfitability[] | undefined, today: Date = new Date()): number {
  const [settings, setSettings] = useState<DriverPaySetting[] | null>(null)
  useEffect(() => {
    let live = true
    void paySettingsOnce().then((rows) => { if (live) setSettings(rows) })
    return () => { live = false }
  }, [])
  return useMemo(() => {
    const rule = (settings ?? []).find((r) => r.payGroup === 'BOX_TRUCK' && r.active !== false)
    if (!rule || !trucks) return 0
    const revenue = trucks.filter((t) => localSubgroupOf(t.unitNumber) === 'BOX_TRUCK').reduce((s, t) => s + t.revenue, 0)
    if (revenue <= 0) return 0
    const todayKey = today.toISOString().slice(0, 10)
    const end = range.end < todayKey ? range.end : todayKey
    const days = Math.max(0, Math.round((Date.parse(`${end}T12:00:00Z`) - Date.parse(`${range.start}T12:00:00Z`)) / 86_400_000) + 1)
    const fixedPerPeriod = (rule.fixedExpenses ?? []).reduce((s, f) => s + (Number(f.amount) || 0), 0)
    return boxTruckPayEstimate(revenue, days, { payPercent: Number(rule.payPercent) || 0, fixedPerPeriod, expensesBeforePercent: !!rule.expensesBeforePercent })
  }, [settings, trucks, range.start, range.end, today])
}
