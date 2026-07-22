import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { useFuelTransactions } from '@/hooks/useFuelTransactions'
import {
  listBoxTruckTrips, listDriverPaySettings, listDriverPayDeductions,
  type BoxTruckTrip, type DriverPaySetting, type DriverPayDeduction,
} from '@/lib/apiClient'
import { aggregateBoxTruckMonth, BOX_TRUCK_UNITS, type BoxTruckMonth } from '@/lib/boxTruckProfit'
import type { DateRange } from '@/lib/fleetProfitability'

/** The box-truck unit this view covers (Zak / #3890). */
export const BOX_TRUCK_UNIT = [...BOX_TRUCK_UNITS][0] ?? '3890'

export interface BoxTruckMonthState {
  agg: BoxTruckMonth | null
  driverName: string | null
  payPercent: number | null   // the box-truck driver's settlement pay %
  loading: boolean
  configured: boolean   // a BOX_TRUCK settlement exists for #3890
}

/**
 * Monthly box-truck P&L for #3890, sourced from Box Truck Settlements. Shared by the
 * Box Truck P&L panel and the Ivan-vs-Box-Truck comparison summary.
 */
export function useBoxTruckMonth(range: DateRange): BoxTruckMonthState {
  const equipment = useAppStore((s) => s.equipment)
  const drivers = useAppStore((s) => s.drivers)
  const { transactions: fuelTxs } = useFuelTransactions()

  const [trips, setTrips] = useState<BoxTruckTrip[]>([])
  const [settings, setSettings] = useState<DriverPaySetting[]>([])
  const [deductions, setDeductions] = useState<DriverPayDeduction[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    Promise.all([listBoxTruckTrips(), listDriverPaySettings(), listDriverPayDeductions()])
      .then(([t, s, d]) => { if (alive) { setTrips(t); setSettings(s); setDeductions(d) } })
      .catch((e) => console.error('[box-truck month] load', e))
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [])

  // Box-truck driver = whoever is assigned to #3890 with a BOX_TRUCK setting; fall back
  // to the only BOX_TRUCK-configured driver if the truck link isn't set.
  const setting = useMemo(() => {
    const boxSettings = settings.filter((s) => s.payGroup === 'BOX_TRUCK' && s.active !== false)
    const truck = equipment.find((e) => e.type === 'truck' && e.unitNumber === BOX_TRUCK_UNIT)
    const assignedDriver = truck ? drivers.find((d) => d.assignedTruckId === truck.id) : undefined
    return (assignedDriver && boxSettings.find((s) => s.driverId === assignedDriver.id))
      ?? (boxSettings.length === 1 ? boxSettings[0] : undefined)
  }, [settings, equipment, drivers])

  const driverName = setting ? drivers.find((d) => d.id === setting.driverId)?.name ?? null : null
  const agg = useMemo(
    () => setting ? aggregateBoxTruckMonth({ trips, setting, fuelTxs, deductions, start: range.start, end: range.end }) : null,
    [setting, trips, fuelTxs, deductions, range.start, range.end],
  )

  return { agg, driverName, payPercent: setting?.payPercent ?? null, loading, configured: !!setting }
}
