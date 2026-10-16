import { useMemo } from 'react'
import { startOfMonth, endOfMonth, addMonths, format, getDaysInMonth } from 'date-fns'
import { useFleetProfitability } from './useFleetProfitability'
import { useFleetFixedCosts } from './useFleetFixedCosts'
import { useTrucks } from './useTrucks'
import { useLoads } from './useLoads'
import { useDrivers } from './useDrivers'
import { useAppStore } from '@/store/useAppStore'
import { isPosted } from '@/lib/invoiceStatus'
import { computeFleetMonthlyLines } from '@/lib/fleetMonthlyPL'
import { localSubgroupOf } from '@/lib/localSubgroups'
import type { ReviewMonthInput, ReviewCustomer, ReviewUnitMaintenance } from '@/lib/profitReview'
import type { DateRange } from '@/lib/fleetProfitability'

export interface ProfitReviewData {
  months:  ReviewMonthInput[]
  loading: boolean
  error:   string | null
  /** FUEL rows in the window with no truck even after card lookup — left out of every figure. */
  unattributedFuel: { count: number; amount: number }
}

/**
 * One assembled review row per calendar month for the LOCAL (Ivan) fleet — the same
 * engine, fixed-cost and trailer-maintenance math the Monthly P&L card uses, plus the
 * detail the review needs (gallons, per-truck, per-customer, per-unit maintenance).
 */
export function useProfitReview(monthsBack: number, today: Date = new Date()): ProfitReviewData {
  const { computeForRange, members, loading, error, fuelTxs } = useFleetProfitability(
    { start: format(startOfMonth(today), 'yyyy-MM-dd'), end: format(endOfMonth(today), 'yyyy-MM-dd') },
    'LOCAL',
  )
  const { contributionInRange, eldInRange } = useFleetFixedCosts()
  const { equipment } = useTrucks()
  const { loads } = useLoads()
  const { drivers } = useDrivers()
  const maintenanceInvoices = useAppStore((s) => s.maintenanceInvoices)

  const months = useMemo<ReviewMonthInput[]>(() => {
    const memberIds = new Set(members.map((m) => m.truckId))
    const unitById = new Map(members.map((m) => [m.truckId, m.unitNumber]))
    for (const e of equipment) if (!unitById.has(e.id)) unitById.set(e.id, e.unitNumber)
    const trailerIds = new Set(equipment.filter((e) => e.type === 'trailer').map((e) => e.id))
    const truckForDriver = new Map<string, string | null>()
    const brokers = new Set<string>()
    for (const d of drivers) {
      truckForDriver.set(d.id, d.assignedTruckId ?? null)
      if (d.type === 'broker') brokers.add(d.id)
    }
    const todayKey = format(today, 'yyyy-MM-dd')

    const out: ReviewMonthInput[] = []
    for (let offset = monthsBack - 1; offset >= 0; offset--) {
      const base = addMonths(today, -offset)
      const range: DateRange = { start: format(startOfMonth(base), 'yyyy-MM-dd'), end: format(endOfMonth(base), 'yyyy-MM-dd') }
      const key = format(base, 'yyyy-MM')
      const daysInMonth = getDaysInMonth(base)
      const daysElapsed = offset === 0 ? Math.min(daysInMonth, today.getDate()) : daysInMonth

      const res = computeForRange(range)
      const r = res.rollup
      const c = r.categories
      const inRange = (d: string | undefined | null) => !!d && d >= range.start && d <= range.end

      const trailerMaintenance = maintenanceInvoices
        .filter((inv) => inRange(inv.date) && trailerIds.has(inv.equipmentId) && isPosted(inv))
        .reduce((s, inv) => s + (inv.amount ?? 0), 0) / 100
      const lines = computeFleetMonthlyLines(r, c, contributionInRange(range), eldInRange(range), trailerMaintenance)
      const fixed = lines.loanTrucks + lines.loanTrailers + lines.trailerLease + lines.yardRent + lines.tolls + lines.eld + c.permits + lines.other

      // Loads delivered by this fleet's drivers in the month (same attribution as revenue).
      const monthLoads = loads.filter((l) => {
        if (!inRange(l.deliveryAppt?.slice(0, 10))) return false
        if (l.deliveryDriverId && brokers.has(l.deliveryDriverId)) return false
        const truckId = (l.deliveryDriverId ? truckForDriver.get(l.deliveryDriverId) : null) ?? l.truckId ?? null
        return !!truckId && memberIds.has(truckId)
      })
      const custMap = new Map<string, ReviewCustomer>()
      for (const l of monthLoads) {
        const name = (l.customer ?? '').trim().toUpperCase() || 'UNKNOWN'
        const row = custMap.get(name) ?? { name, loads: 0, revenue: 0 }
        row.loads += 1
        row.revenue += (l.rate ?? 0) / 100
        custMap.set(name, row)
      }

      // Gallons per truck from the resolved fuel rows.
      const galByTruck = new Map<string, number>()
      let gallons = 0
      for (const t of fuelTxs) {
        if ((t.itemCategory ?? '') !== 'FUEL' || !inRange(t.transactionDate) || !t.truckId || !memberIds.has(t.truckId)) continue
        const q = t.quantity ?? 0
        gallons += q
        galByTruck.set(t.truckId, (galByTruck.get(t.truckId) ?? 0) + q)
      }

      // Posted maintenance invoices on member trucks and trailers, by unit.
      const unitMaint = new Map<string, ReviewUnitMaintenance>()
      for (const inv of maintenanceInvoices) {
        if (!inRange(inv.date) || !isPosted(inv)) continue
        if (!memberIds.has(inv.equipmentId) && !trailerIds.has(inv.equipmentId)) continue
        const unitNumber = unitById.get(inv.equipmentId) ?? inv.equipmentId
        const amount = (inv.amount ?? 0) / 100
        const row = unitMaint.get(unitNumber) ?? { unitNumber, amount: 0, biggest: null }
        row.amount += amount
        if (!row.biggest || amount > row.biggest.amount) {
          row.biggest = { description: (inv.description ?? inv.vendor ?? 'repair').split('\n')[0].slice(0, 60), amount }
        }
        unitMaint.set(unitNumber, row)
      }

      out.push({
        key,
        label: format(base, 'MMM yyyy'),
        daysInMonth,
        daysElapsed: range.start > todayKey ? 0 : daysElapsed,
        revenue: r.revenue,
        fuel: r.fuel,
        driverPay: r.driverCost,
        maintenance: lines.maintenance,
        insurance: c.insurance,
        fixed,
        miles: r.miles,
        loads: monthLoads.length,
        gallons,
        trucks: res.trucks.map((t) => ({
          unitNumber: t.unitNumber,
          bucket: localSubgroupOf(t.unitNumber),
          revenue: t.revenue,
          miles: t.miles,
          fuel: t.fuel,
          gallons: galByTruck.get(t.truckId) ?? 0,
        })),
        customers: [...custMap.values()].sort((a, b) => b.revenue - a.revenue),
        unitMaintenance: [...unitMaint.values()].sort((a, b) => b.amount - a.amount),
      })
    }
    return out
  }, [computeForRange, members, equipment, drivers, loads, fuelTxs, maintenanceInvoices, contributionInRange, eldInRange, monthsBack, today])

  const unattributedFuel = useMemo(() => {
    const first = months[0]?.key
    if (!first) return { count: 0, amount: 0 }
    let count = 0, amount = 0
    for (const t of fuelTxs) {
      if ((t.itemCategory ?? '') !== 'FUEL' || t.truckId || (t.transactionDate ?? '') < `${first}-01`) continue
      count += 1; amount += t.amount ?? 0
    }
    return { count, amount }
  }, [fuelTxs, months])

  return { months, loading, error, unattributedFuel }
}
