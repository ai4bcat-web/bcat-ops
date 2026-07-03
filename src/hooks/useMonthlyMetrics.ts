import { useMemo } from 'react'
import { useAppStore } from '@/store/useAppStore'
import type { Load } from '@/types'

export interface MonthBucket {
  key: string        // 'YYYY-MM'
  label: string      // 'Jul'
  fullLabel: string  // 'Jul 2026'
  year: number
  loads: number
  loadsBroker: number       // loads covered by a broker-type driver
  loadsIvan: number         // loads run by Ivan's own (non-broker) drivers
  loadsUnassigned: number   // loads with no pickup driver / unknown driver
  revenue: number           // cents — all loads
  revenueBroker: number     // cents — loads covered by a broker-type driver
  revenueIvan: number       // cents — loads run by Ivan's own (non-broker) drivers
  revenueUnassigned: number // cents — loads with a rate but no pickup driver / unknown driver
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
 * Load date is `pickupAppt`; revenue is the sum of `rate` (cents).
 */
export function useMonthlyMetrics(monthsBack = 6): MonthlyMetrics {
  const loads     = useAppStore((s) => s.loads)
  const drivers   = useAppStore((s) => s.drivers)
  const equipment = useAppStore((s) => s.equipment)

  return useMemo(() => {
    const now = new Date()
    const curKey = monthKey(now)

    // Which driver IDs are brokers (outsourced carriers) vs Ivan's own drivers.
    const brokerIds = new Set(drivers.filter((d) => d.type === 'broker').map((d) => d.id))
    const knownIds  = new Set(drivers.map((d) => d.id))

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
        loadsBroker: 0,
        loadsIvan: 0,
        loadsUnassigned: 0,
        revenue: 0,
        revenueBroker: 0,
        revenueIvan: 0,
        revenueUnassigned: 0,
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
      const key = l.pickupAppt.slice(0, 7) // 'YYYY-MM'
      const b = buckets.get(key)
      if (!b) return
      b.loads += 1
      const rate = l.rate ?? 0
      b.revenue += rate
      // Attribute loads & revenue by the pickup driver's type (same convention as loads-per-driver).
      const did = l.pickupDriverId
      if (did && brokerIds.has(did)) {
        b.loadsBroker += 1
        b.revenueBroker += rate
      } else if (did && knownIds.has(did)) {
        b.loadsIvan += 1
        b.revenueIvan += rate
      } else {
        b.loadsUnassigned += 1
        b.revenueUnassigned += rate
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
