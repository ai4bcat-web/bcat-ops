import { useCallback, useEffect, useMemo, useState } from 'react'
import { listInsurancePeriods, listInsuranceLineItems, type InsuranceLineItem } from '@/lib/insuranceClient'
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
  const [periodLabel, setPeriodLabel] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    const [periods, all] = await Promise.all([listInsurancePeriods(), listInsuranceLineItems()])
    const cur = periods.find((p) => p.isCurrent) ?? periods[0] ?? null
    setPeriodLabel(cur?.label ?? null)
    setItems(cur ? all.filter((i) => i.periodId === cur.id) : [])
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
    // Brokers aren't employees — exclude them from the workmans-comp headcount.
    const drv: DriverLite[] = drivers.map((d) => ({ id: d.id, assignedTruckId: d.assignedTruckId, active: d.active && d.type !== 'broker' }))
    return computeInsuranceAllocation(insItems, trucks, drv)
  }, [items, equipment, drivers])

  return { items, allocation, periodLabel, loading, refresh }
}
