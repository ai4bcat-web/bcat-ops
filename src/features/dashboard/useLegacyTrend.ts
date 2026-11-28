import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { chicagoDateStr } from '@/lib/date'
import { trailingMonths } from '@/lib/brokerageRevenue'
import { readRollupRows, type RawRollupRow } from '@/lib/dashboardRollupClient'
import { LEGACY_SCHEMA_VERSION, reduceLegacy, type LegacyMonthPayload } from '@/lib/dashboardRollupLegacy'
import type { TrendPoint } from './Sparkline'

export interface LegacyTrend { loads: TrendPoint[]; revenue: TrendPoint[]; broker: TrendPoint[] }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const label = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`
const TREND_MONTHS = 6

/**
 * Loads, revenue and broker-covered per month for the last six months, from the same `LG:` rollup month rows the KPI
 * cards read (one cached read, no load window). A month with no row is left out; the month in progress is marked
 * partial. Uses the card's own arithmetic (`reduceLegacy`) so a month's point equals what that month's card would show.
 */
export function legacyTrendFrom(rows: RawRollupRow[], months: string[], current: string, drivers: Parameters<typeof reduceLegacy>[2], today?: string): LegacyTrend {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const out: LegacyTrend = { loads: [], revenue: [], broker: [] }
  for (const month of months) {
    const row = byId.get(`LG:${month}`)
    const p = row?.payload as Partial<LegacyMonthPayload> | null | undefined
    if (!row || row.schemaVersion !== LEGACY_SCHEMA_VERSION || !p || p.v !== 1 || typeof p.days !== 'object' || p.days === null) continue
    // The month in progress is drawn to date (the same days its card counts), a finished month in full.
    const range = { from: `${month}-01`, to: month === current && today ? today : `${month}-31`, prevFrom: '0000-00-00', prevTo: '0000-00-00' }
    const k = reduceLegacy([p as LegacyMonthPayload], range, drivers)
    const base = { month, label: label(month), partial: month === current }
    out.loads.push({ ...base, value: k.totalLoads })
    out.revenue.push({ ...base, value: k.revenueSplit.total })
    out.broker.push({ ...base, value: k.brokerLoads })
  }
  return out
}

/** `null` until the rows and the drivers are in; the cards draw no line until then. */
export function useLegacyTrend(): LegacyTrend | null {
  const drivers = useAppStore((s) => s.drivers)
  const [rows, setRows] = useState<RawRollupRow[] | null>(null)
  const today = chicagoDateStr(new Date())
  const current = today.slice(0, 7)
  const months = useMemo(() => trailingMonths(current, TREND_MONTHS), [current])

  useEffect(() => {
    let live = true
    const { value, fresh } = readRollupRows(months.map((m) => `LG:${m}`))
    if (value) void Promise.resolve().then(() => { if (live) setRows(value) })
    fresh.then((r) => { if (live) setRows(r) }).catch(() => { /* no line; the cards keep their figures */ })
    return () => { live = false }
  }, [months])

  return useMemo(() => (rows && drivers.length > 0 ? legacyTrendFrom(rows, months, current, drivers, today) : null), [rows, drivers, months, current, today])
}
