import { useBoxTruckMonth, BOX_TRUCK_UNIT } from '@/hooks/useBoxTruckMonth'
import type { DateRange } from '@/lib/fleetProfitability'

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
  const { agg, driverName, payPercent, loading, configured } = useBoxTruckMonth(range)

  if (loading && !agg) {
    return <div style={{ padding: '28px 0', textAlign: 'center', fontSize: 13, color: 'var(--ds-t3)' }}>Loading…</div>
  }
  if (!configured || !agg) {
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
      <CostRow label="Driver pay" value={agg.driverPay} hint={payPercent != null ? `${Math.round(payPercent * 100)}%` : undefined} />
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
        {driverName ? `${driverName} · ` : ''}{agg.tripCount} shipment{agg.tripCount === 1 ? '' : 's'} · pulled from Box Truck Settlements.
      </div>
    </div>
  )
}
