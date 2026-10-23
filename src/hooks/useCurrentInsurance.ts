import { useCallback, useEffect, useMemo, useState } from 'react'
import { listInsurancePeriods, listInsuranceLineItems, type InsuranceLineItem } from '@/lib/insuranceClient'
import { listDriverPaySettings, type DriverPaySetting } from '@/lib/apiClient'
import { useAppStore } from '@/store/useAppStore'
import { computeInsuranceAllocation, insuranceRangeByTruckDated, truckActiveOn, type InsItem, type TruckLite, type DriverLite } from '@/lib/insuranceAllocation'
import { todayChicago } from '@/lib/recurringRevision'

/**
 * Loads the CURRENT insurance period's line items and derives the per-truck annual
 * allocation the P&L needs. Lightweight (no mutations) so it can be composed into
 * profitability hooks without pulling in the full editor surface of useInsurance.
 */
export function useCurrentInsurance() {
  const equipment = useAppStore((s) => s.equipment)
  const drivers = useAppStore((s) => s.drivers)
  const [items, setItems] = useState<InsuranceLineItem[]>([])
  const [paySettings, setPaySettings] = useState<DriverPaySetting[]>([])
  const [periodLabel, setPeriodLabel] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(() =>
    Promise.all([listInsurancePeriods(), listInsuranceLineItems(), listDriverPaySettings()])
      .then(([periods, all, settings]) => {
        const cur = periods.find((p) => p.isCurrent) ?? periods[0] ?? null
        setPeriodLabel(cur?.label ?? null)
        setItems(cur ? all.filter((i) => i.periodId === cur.id) : [])
        setPaySettings(settings)
      }),
  [])

  useEffect(() => {
    let active = true
    refresh().catch((e) => console.error('[current-insurance]', e)).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [refresh])

  const inputs = useMemo(() => {
    const insItems: InsItem[] = items.map((i) => ({ kind: i.kind, equipmentId: i.equipmentId, annualCents: i.annualCents }))
    const trucks: TruckLite[] = equipment.filter((e) => e.type === 'truck').map((e) => ({ id: e.id, active: e.active !== false, inactiveSince: e.inactiveSince ?? null }))
    // Drivers on the BOX_TRUCK pay group run box trucks — they share the trailer split
    // but their WC lands on their assigned truck (or spreads if unassigned) like any driver's.
    const boxTruckDriverIds = new Set(paySettings.filter((s) => s.payGroup === 'BOX_TRUCK' && s.active !== false).map((s) => s.driverId))
    // Brokers aren't employees — exclude them from the workmans-comp headcount.
    const drv: DriverLite[] = drivers.map((d) => ({
      id: d.id, assignedTruckId: d.assignedTruckId, active: d.active && d.type !== 'broker', boxTruck: boxTruckDriverIds.has(d.id),
    }))
    return { insItems, trucks, drv }
  }, [items, equipment, drivers, paySettings])

  /** Today's picture: trucks parked as of today carry no insurance. */
  const allocation = useMemo(() => {
    const today = todayChicago()
    const live = inputs.trucks.map((t) => ({ id: t.id, active: truckActiveOn(t, today) }))
    return computeInsuranceAllocation(inputs.insItems, live, inputs.drv)
  }, [inputs])

  /** Insurance $ per truck over a range, stopping on each truck's inactive date. */
  const rangeByTruck = useCallback(
    (range: { start: string; end: string }) => insuranceRangeByTruckDated(inputs.insItems, inputs.trucks, inputs.drv, range),
    [inputs],
  )

  return { items, allocation, rangeByTruck, periodLabel, loading, refresh }
}
