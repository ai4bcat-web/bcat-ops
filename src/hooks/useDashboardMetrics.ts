import { useMemo } from 'react'
import { useAppStore } from '@/store/useAppStore'
import type { Driver, Load } from '@/types'

export type DateRangeKey = 'today' | 'this-week' | 'this-month' | 'this-quarter' | 'this-year'

export interface DriverPerf {
  driver: Driver
  totalLoads: number
  readyToInvoice: number
  avgLoadsPerDay: number
  lastLoadDate: string | null
}

export interface DashboardMetrics {
  totalLoads: number
  totalLoadsDelta: number
  activeDrivers: number
  readyToInvoice: number
  needsInvoice: number     // shipments completed (non-TBD delivery) yesterday or earlier, still not ready to invoice
  needsAppt: number        // loads with at least one TBD appointment (all time)
  revenue: number          // sum of load.rate in cents
  revenueConnected: boolean // false when all rates are null
  loadsPerDriver: { driverId: string; name: string; count: number; colorKey: string }[]
  loadsByDay: { date: string; count: number }[]
  driverPerformance: DriverPerf[]
  rangeStart: string
  rangeEnd: string
  rangeDays: number
}

function getRange(key: DateRangeKey): { start: Date; end: Date } {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  switch (key) {
    case 'today':
      return { start: today, end: new Date(today.getTime() + 86_400_000 - 1) }

    case 'this-week': {
      const day = today.getDay() // 0=Sun
      const mon = new Date(today); mon.setDate(today.getDate() - (day === 0 ? 6 : day - 1))
      const sun = new Date(mon); sun.setDate(mon.getDate() + 6)
      return { start: mon, end: sun }
    }

    case 'this-month': {
      const start = new Date(today.getFullYear(), today.getMonth(), 1)
      const end   = new Date(today.getFullYear(), today.getMonth() + 1, 0)
      return { start, end }
    }

    case 'this-quarter': {
      const q = Math.floor(today.getMonth() / 3)
      const start = new Date(today.getFullYear(), q * 3, 1)
      const end   = new Date(today.getFullYear(), q * 3 + 3, 0)
      return { start, end }
    }

    case 'this-year': {
      const start = new Date(today.getFullYear(), 0, 1)
      const end   = new Date(today.getFullYear(), 11, 31)
      return { start, end }
    }
  }
}

function prevRange(key: DateRangeKey): { start: Date; end: Date } {
  const { start, end } = getRange(key)
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1
  return {
    start: new Date(start.getTime() - days * 86_400_000),
    end:   new Date(end.getTime()   - days * 86_400_000),
  }
}

function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function loadsInRange(loads: Load[], start: Date, end: Date): Load[] {
  const s = start.getTime()
  const e = end.getTime() + 86_400_000  // inclusive end
  return loads.filter((l) => {
    const t = new Date(l.pickupAppt).getTime()
    return t >= s && t < e
  })
}

export function useDashboardMetrics(rangeKey: DateRangeKey): DashboardMetrics {
  const loads   = useAppStore((s) => s.loads)
  const drivers = useAppStore((s) => s.drivers)

  return useMemo(() => {
    const { start, end } = getRange(rangeKey)
    const prev           = prevRange(rangeKey)
    const days           = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1

    const current  = loadsInRange(loads, start, end)
    const previous = loadsInRange(loads, prev.start, prev.end)

    // KPIs
    const totalLoads      = current.length
    const totalLoadsDelta = totalLoads - previous.length
    const readyToInvoice  = current.filter((l) => l.readyToInvoice).length

    // Uninvoiced backlog — shipments COMPLETED yesterday or earlier (a real, non-TBD
    // delivery dated before today) that are still not marked ready to invoice. A still-TBD
    // delivery isn't "completed", so it's excluded here (it shows under Appts to Book).
    const todayMidnight = new Date(); todayMidnight.setHours(0, 0, 0, 0)
    const needsInvoice = loads.filter(
      (l) =>
        l.deliveryApptType !== 'tbd' &&
        new Date(l.deliveryAppt) < todayMidnight &&
        !l.readyToInvoice
    ).length

    // Appt booking backlog — all loads with at least one TBD appointment
    const needsAppt = loads.filter(
      (l) => l.pickupApptType === 'tbd' || l.deliveryApptType === 'tbd'
    ).length

    const activeDriverSet = new Set<string>()
    current.forEach((l) => {
      if (l.pickupDriverId)   activeDriverSet.add(l.pickupDriverId)
      if (l.deliveryDriverId) activeDriverSet.add(l.deliveryDriverId)
    })
    const activeDrivers = activeDriverSet.size

    const revenue          = current.reduce((sum, l) => sum + (l.rate ?? 0), 0)
    const prevRevenue      = previous.reduce((sum, l) => sum + (l.rate ?? 0), 0)
    const revenueConnected = current.some((l) => l.rate != null && l.rate > 0)
    const revenueConnectedPrev = previous.some((l) => l.rate != null && l.rate > 0)
    const revenueDelta     = revenueConnected || revenueConnectedPrev ? revenue - prevRevenue : 0

    // Loads per driver
    const countByDriver: Record<string, number> = {}
    current.forEach((l) => {
      if (l.pickupDriverId) countByDriver[l.pickupDriverId] = (countByDriver[l.pickupDriverId] ?? 0) + 1
    })
    const loadsPerDriver = Object.entries(countByDriver)
      .map(([driverId, count]) => {
        const d = drivers.find((dr) => dr.id === driverId)
        return { driverId, name: d?.name ?? 'Unknown', count, colorKey: d?.colorKey ?? 'driver-1' }
      })
      .sort((a, b) => b.count - a.count)

    // Loads by day
    const dayMap: Record<string, number> = {}
    const cursor = new Date(start)
    while (cursor <= end) {
      dayMap[dateStr(cursor)] = 0
      cursor.setDate(cursor.getDate() + 1)
    }
    current.forEach((l) => {
      const day = l.pickupAppt.slice(0, 10)
      if (day in dayMap) dayMap[day] = (dayMap[day] ?? 0) + 1
    })
    const loadsByDay = Object.entries(dayMap).map(([date, count]) => ({ date, count }))

    // Driver performance
    const activeDriversList = drivers.filter((d) => d.active && d.type !== 'broker')
    const driverPerformance: DriverPerf[] = activeDriversList.map((driver) => {
      const dLoads = current.filter((l) => l.pickupDriverId === driver.id)
      const dates  = dLoads.map((l) => l.pickupAppt.slice(0, 10)).sort()
      return {
        driver,
        totalLoads:     dLoads.length,
        readyToInvoice: dLoads.filter((l) => l.readyToInvoice).length,
        avgLoadsPerDay: days > 0 ? Math.round((dLoads.length / days) * 100) / 100 : 0,
        lastLoadDate:   dates[dates.length - 1] ?? null,
      }
    }).sort((a, b) => b.totalLoads - a.totalLoads)

    return {
      totalLoads,
      totalLoadsDelta,
      activeDrivers,
      readyToInvoice,
      needsInvoice,
      needsAppt,
      revenue,
      revenueConnected,
      loadsPerDriver,
      loadsByDay,
      driverPerformance,
      rangeStart: dateStr(start),
      rangeEnd:   dateStr(end),
      rangeDays:  days,
      // expose delta for revenue too
      ...{ revenueDelta },
    } as DashboardMetrics & { revenueDelta: number }
  }, [loads, drivers, rangeKey])
}
