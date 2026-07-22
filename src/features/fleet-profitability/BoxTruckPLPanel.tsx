import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { useFuelTransactions } from '@/hooks/useFuelTransactions'
import {
  listBoxTruckTrips, listDriverPaySettings, listDriverPayDeductions,
  type BoxTruckTrip, type DriverPaySetting, type DriverPayDeduction,
} from '@/lib/apiClient'
import { aggregateBoxTruckMonth } from '@/lib/boxTruckProfit'
import type { DateRange } from '@/lib/fleetProfitability'

const BOX_TRUCK_UNIT = '3890'

function money(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}
function netColor(n: number): string {
  return n > 0 ? '#15803d' : n < 0 ? '#dc2626' : 'var(--ds-t2)'
}

function CostRow({ label, value, hint }: { label: string; value: number; hint?: string }) {
  const empty = value === 0
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 0', borderTop: '1px solid var(--ds-border)' }}>
      <span style={{ fontSize: 13, color: 'var(--ds-t2)', paddingLeft: 14 }}>
        {label}{hint && <span style={{ fontSize: 11, color: 'var(--ds-t3)', marginLeft: 6 }}>{hint}</span>}
      </span>
      <span style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', color: empty ? 'var(--ds-muted-soft)' : 'var(--ds-t1)' }}>
        {empty ? '(none)' : `− ${money(value)}`}
      </span>
    </div>
  )
}

/**
 * Monthly P&L for the Box Truck (Zak / #3890), sourced from box-truck settlements —
 * customer rate − carrier cost = gross profit, then driver pay + fuel/expenses per the
 * driver's pay setting. Shown as its own toggle beside Local & Amazon; it does NOT alter
 * the Local number (3890's loads still roll into Local too, by design).
 */
export function BoxTruckPLPanel({ range }: { range: DateRange }) {
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
      .catch((e) => console.error('[box-truck P&L] load', e))
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [])

  // The box-truck driver = whoever is assigned to unit 3890 and has a BOX_TRUCK setting.
  // Fall back to the only BOX_TRUCK-configured driver if the truck link isn't set.
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

  if (loading && trips.length === 0) {
    return <div style={{ padding: '28px 0', textAlign: 'center', fontSize: 13, color: 'var(--ds-t3)' }}>Loading…</div>
  }
  if (!setting || !agg) {
    return (
      <div style={{ padding: '28px 0', textAlign: 'center', fontSize: 13, color: 'var(--ds-t3)' }}>
        No box-truck settlement set up for #{BOX_TRUCK_UNIT}. Configure it on the Box Truck Settlements page.
      </div>
    )
  }
  if (agg.tripCount === 0) {
    return <div style={{ padding: '28px 0', textAlign: 'center', fontSize: 13, color: 'var(--ds-t3)' }}>No box-truck shipments delivered this month.</div>
  }

  const margin = agg.revenue > 0 ? (agg.profit / agg.revenue) * 100 : null

  return (
    <div style={{ maxWidth: 520 }}>
      {/* Revenue → carrier cost → gross profit */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0 12px' }}>
        <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ds-t1)' }}>
          Revenue <span style={{ fontSize: 11.5, fontWeight: 500, color: 'var(--ds-t3)' }}>(customer billed)</span>
        </span>
        <span style={{ fontSize: 15, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: 'var(--ds-t1)' }}>{money(agg.revenue)}</span>
      </div>
      <CostRow label="Carrier cost" value={agg.carrierCost} hint="paid to the hauling carrier" />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 0', borderTop: '1px solid var(--ds-border)' }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ds-t2)' }}>Gross profit</span>
        <span style={{ fontSize: 13.5, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: 'var(--ds-t1)' }}>{money(agg.grossProfit)}</span>
      </div>

      {/* Costs against gross profit */}
      <CostRow label="Driver pay" value={agg.driverPay} hint={`${Math.round(setting.payPercent * 100)}%`} />
      <CostRow label="Fuel" value={agg.fuel} />
      <CostRow label="Other expenses" value={agg.otherExp} hint="fixed + one-off" />

      {/* Net */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, paddingTop: 11, borderTop: '2px solid var(--ds-border)' }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--ds-t1)' }}>
          Profit to company
          {margin != null && <span style={{ fontSize: 11.5, fontWeight: 500, color: 'var(--ds-t3)', marginLeft: 8 }}>{margin.toFixed(0)}% margin</span>}
        </span>
        <span style={{ fontSize: 18, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: netColor(agg.profit) }}>{money(agg.profit)}</span>
      </div>

      <div style={{ marginTop: 12, fontSize: 11, color: 'var(--ds-t3)' }}>
        {driverName ? `${driverName} · ` : ''}{agg.tripCount} shipment{agg.tripCount === 1 ? '' : 's'} · from Box Truck Settlements.
        Note: #{BOX_TRUCK_UNIT}’s freight also counts in the Local total — this is a standalone box-truck P&L.
      </div>
    </div>
  )
}
