import { useCallback, useEffect, useMemo, useState } from 'react'
import { listInsurancePeriods, listInsuranceLineItems, type InsuranceLineItem } from '@/lib/insuranceClient'
import { listDriverPaySettings, type DriverPaySetting } from '@/lib/apiClient'
import { useAppStore } from '@/store/useAppStore'
import { computeInsuranceAllocation, type InsItem, type TruckLite, type DriverLite } from '@/lib/insuranceAllocation'

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

  const refresh = useCallback(async () => {
    const [periods, all, settings] = await Promise.all([listInsurancePeriods(), listInsuranceLineItems(), listDriverPaySettings()])
    const cur = periods.find((p) => p.isCurrent) ?? periods[0] ?? null
    setPeriodLabel(cur?.label ?? null)
    setItems(cur ? all.filter((i) => i.periodId === cur.id) : [])
    setPaySettings(settings)
  }, [])

  useEffect(() => {
    let active = true
    setLoading(true)
    refresh().catch((e) => console.error('[current-insurance]', e)).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [refresh])

  const allocation = useMemo(() => {
    const insItems: InsItem[] = items.map((i) => ({ kind: i.kind, equipmentId: i.equipmentId, annualCents: i.annualCents }))
    const trucks: TruckLite[] = equipment.filter((e) => e.type === 'truck').map((e) => ({ id: e.id, active: e.active !== false }))
    // Drivers on the BOX_TRUCK pay group run box trucks — they share the trailer/WC split
    // but their portion is recouped from settlements, not placed on a Fleet truck.
    const boxTruckDriverIds = new Set(paySettings.filter((s) => s.payGroup === 'BOX_TRUCK' && s.active !== false).map((s) => s.driverId))
    // Brokers aren't employees — exclude them from the workmans-comp headcount.
    const drv: DriverLite[] = drivers.map((d) => ({
      id: d.id, assignedTruckId: d.assignedTruckId, active: d.active && d.type !== 'broker', boxTruck: boxTruckDriverIds.has(d.id),
    }))
    return computeInsuranceAllocation(insItems, trucks, drv)
  }, [items, equipment, drivers, paySettings])

  return { items, allocation, periodLabel, loading, refresh }
}
