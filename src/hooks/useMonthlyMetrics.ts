import { useMemo } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { isLoadVoided } from '@/lib/shipmentVoid'
import { deliveryDay } from '@/lib/dashboardRollupLegacy'
import { fleetBucketOf } from '@/lib/revenueByFleet'
import { useEnsureLoadRange } from './useLoads'
import type { Load } from '@/types'

export interface MonthBucket {
  key: string        // 'YYYY-MM'
  label: string      // 'Jul'
  fullLabel: string  // 'Jul 2026'
  year: number
  loads: number
  // The three-way split Finances uses, by the DELIVERY driver's fleet.
  loadsLocal: number        // loads delivered by Local (Ivan's own) drivers and box trucks
  loadsOwnerOp: number      // loads delivered by owner operators
  loadsOther: number        // loads covered by a broker, or with no delivery driver / an unknown one
  revenue: number           // cents — all loads
  revenueLocal: number      // cents — delivered by Local drivers and box trucks
  revenueOwnerOp: number    // cents — delivered by owner operators
  revenueOther: number      // cents — covered by a broker, or with no delivery driver / an unknown one
  miles: number             // total loaded miles
  revenuePerMile: number    // dollars per mile (revenue / miles), 0 when no miles
  readyToInvoice: number
  // Active-truck count as of this month, by fleet group
  trucks: number         // total = amazon + ivan
  trucksAmazon: number   // truck's fleetGroup is AMAZON
  trucksIvan: number     // everyone else (LOCAL/Ivan fleet, incl. untagged trucks)
  isCurrent: boolean
}

export interface MonthlyMetrics {
  months: MonthBucket[]         // oldest → newest, length = monthsBack (+ current)
  lastMonth: MonthBucket | null // the completed month before the current one
  monthBefore: MonthBucket | null // the month before lastMonth (for deltas)
  currentMonth: MonthBucket | null
  revenueConnected: boolean
}

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/**
 * Aggregates loads into calendar-month buckets for the trailing `monthsBack`
 * months plus the current month (so a 6 → 7 buckets, ending with the live month).
 * A load counts in the month it was DELIVERED (the first ten characters of `deliveryAppt`, the Finances
 * rule): one with no delivery date, or delivering after today, is in no bucket yet. Revenue is the sum of
 * `rate` (cents), split by the delivery driver's fleet.
 */
export function useMonthlyMetrics(monthsBack = 6): MonthlyMetrics {
  const allLoads  = useAppStore((s) => s.loads)
  // Metrics measure work that happened, so the voided loads come out before anything is
  // summed. The filter sits in its own memo: the selector must keep returning the store's
  // array, or useSyncExternalStore would see a new reference on every render.
  const loads     = useMemo(() => allLoads.filter((l) => !isLoadVoided(l)), [allLoads])
  const drivers   = useAppStore((s) => s.drivers)
  const equipment = useAppStore((s) => s.equipment)
  // One month earlier than the oldest bucket: a load delivered then was usually picked up the month before.
  useEnsureLoadRange(`${monthKey(new Date(new Date().getFullYear(), new Date().getMonth() - monthsBack - 1, 1))}-01`, `${monthKey(new Date())}-01`)

  return useMemo(() => {
    const now = new Date()
    const curKey = monthKey(now)

    const driversById = new Map(drivers.map((d) => [d.id, d]))
    // Finances caps the current month at today (UTC), so a load scheduled to deliver later is not revenue yet.
    const today = now.toISOString().slice(0, 10)

    // Classify each active truck once (fleet + when it entered the fleet). fleetGroup
    // is the source of truth; anything not tagged AMAZON counts as Ivan (LOCAL) fleet.
    // No dedicated acquired-date exists, so createdAt is used as the "in fleet since" proxy.
    type Seg = 'amazon' | 'ivan'
    const truckFleet = equipment
      .filter((e) => e.type === 'truck' && e.active !== false)
      .map((e) => {
        const seg: Seg = e.fleetGroup === 'AMAZON' ? 'amazon' : 'ivan'
        const addedMs = e.createdAt ? new Date(e.createdAt).getTime() : null
        return { seg, addedMs }
      })

    // Build empty ordered buckets: monthsBack completed months + current month.
    const buckets = new Map<string, MonthBucket>()
    for (let i = monthsBack; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      const key = monthKey(d)
      buckets.set(key, {
        key,
        label: d.toLocaleDateString('en-US', { month: 'short' }),
        fullLabel: d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
        year: d.getFullYear(),
        loads: 0,
        loadsLocal: 0,
        loadsOwnerOp: 0,
        loadsOther: 0,
        revenue: 0,
        revenueLocal: 0,
        revenueOwnerOp: 0,
        revenueOther: 0,
        miles: 0,
        revenuePerMile: 0,
        readyToInvoice: 0,
        trucks: 0,
        trucksAmazon: 0,
        trucksIvan: 0,
        isCurrent: key === curKey,
      })
    }

    const addLoad = (l: Load) => {
      const day = deliveryDay(l.deliveryAppt)
      if (!day || day > today) return
      const b = buckets.get(day.slice(0, 7)) // 'YYYY-MM'
      if (!b) return
      b.loads += 1
      const rate = l.rate ?? 0
      b.revenue += rate
      // Attribute by the delivery driver's fleet, the same split Finances makes.
      const bucket = fleetBucketOf(l.deliveryDriverId ? driversById.get(l.deliveryDriverId) : undefined)
      if (bucket === 'IVAN' || bucket === 'BOX_TRUCK') {
        b.loadsLocal += 1
        b.revenueLocal += rate
      } else if (bucket === 'OWNER_OP') {
        b.loadsOwnerOp += 1
        b.revenueOwnerOp += rate
      } else {
        b.loadsOther += 1
        b.revenueOther += rate
      }
      b.miles += l.miles ?? 0
      if (l.readyToInvoice) b.readyToInvoice += 1
    }
    loads.forEach(addLoad)

    for (const [key, b] of buckets) {
      // revenue is cents; miles are whole miles → dollars-per-mile
      b.revenuePerMile = b.miles > 0 ? b.revenue / 100 / b.miles : 0

      // Active trucks as of month-end: trucks whose createdAt is on/before then
      // (undated trucks are assumed to predate the window). Retirements aren't tracked
      // historically, so past months reflect today's active trucks that existed by then.
      const [y, m] = key.split('-').map(Number)
      const monthEndMs = new Date(y, m, 0, 23, 59, 59, 999).getTime()
      for (const t of truckFleet) {
        if (t.addedMs != null && t.addedMs > monthEndMs) continue
        if (t.seg === 'amazon') b.trucksAmazon += 1
        else                    b.trucksIvan += 1
      }
      b.trucks = b.trucksAmazon + b.trucksIvan
    }

    const months = [...buckets.values()]
    const currentMonth = months.find((m) => m.isCurrent) ?? null
    const completed = months.filter((m) => !m.isCurrent)
    const lastMonth = completed[completed.length - 1] ?? null
    const monthBefore = completed[completed.length - 2] ?? null

    return {
      months,
      lastMonth,
      monthBefore,
      currentMonth,
      revenueConnected: loads.some((l) => l.rate != null && l.rate > 0),
    }
  }, [loads, drivers, equipment, monthsBack])
}
