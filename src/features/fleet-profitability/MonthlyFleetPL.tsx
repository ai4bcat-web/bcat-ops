import { useState } from 'react'
import { ChevronLeft, ChevronRight, RotateCw, Scale } from 'lucide-react'
import { useFleetProfitability } from '@/hooks/useFleetProfitability'
import { FLEET_GROUPS, FLEET_GROUP_LABELS } from '@/lib/fleetGroups'
import type { FleetGroup } from '@/types/equipment'
import { monthRange, monthLabel } from './monthRange'

function money(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

const navBtn: React.CSSProperties = {
  width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 7,
  cursor: 'pointer', color: 'var(--ds-t2)',
}

function netColor(n: number): string {
  return n > 0 ? '#15803d' : n < 0 ? '#dc2626' : 'var(--ds-t2)'
}

/** One "− $X" cost line in the P&L; muted "(none)" when nothing is allocated. */
function CostRow({ label, value }: { label: string; value: number }) {
  const empty = value === 0
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 0', borderTop: '1px solid var(--ds-border-soft, var(--ds-border))' }}>
      <span style={{ fontSize: 13, color: 'var(--ds-t2)', paddingLeft: 14 }}>{label}</span>
      <span style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', color: empty ? 'var(--ds-muted-soft)' : 'var(--ds-t1)' }}>
        {empty ? '(none)' : `− ${money(value)}`}
      </span>
    </div>
  )
}

/**
 * Monthly fleet Profit & Loss — Revenue minus fuel, driver pay and every allocated
 * expense category, for one fleet group (defaults to Local / Ivan). Reuses the shared
 * profitability engine over a calendar-month range.
 */
export function MonthlyFleetPL() {
  const [monthOffset, setMonthOffset] = useState(0)
  const [group, setGroup] = useState<FleetGroup>('LOCAL')

  const range = monthRange(monthOffset)
  const { data, members, loading, refresh } = useFleetProfitability(range, group)
  const r = data?.rollup
  const c = r?.categories

  const margin = r && r.revenue > 0 ? (r.net / r.revenue) * 100 : null

  return (
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Scale size={16} style={{ color: 'var(--ds-blue)' }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>Monthly Profit &amp; Loss</div>
            <div style={{ fontSize: 12, color: 'var(--ds-t3)' }}>{members.length} truck{members.length === 1 ? '' : 's'} · {monthLabel(range)}</div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {/* Fleet group toggle */}
          <div style={{ display: 'flex', gap: 2, background: 'var(--ds-bg)', borderRadius: 8, padding: 2 }}>
            {FLEET_GROUPS.map((g) => {
              const active = g === group
              const stub = g === 'AMAZON'
              return (
                <button key={g} onClick={() => !stub && setGroup(g)} disabled={stub}
                  title={stub ? 'Amazon fleet — coming soon' : undefined}
                  style={{ padding: '5px 12px', borderRadius: 6, border: 'none', fontSize: 12, fontWeight: 600, cursor: stub ? 'not-allowed' : 'pointer',
                    background: active ? 'var(--ds-surface)' : 'transparent', color: stub ? 'var(--ds-t3)' : active ? 'var(--ds-t1)' : 'var(--ds-t2)',
                    boxShadow: active ? 'var(--sh-sm)' : 'none', opacity: stub ? 0.55 : 1 }}>
                  {FLEET_GROUP_LABELS[g]}{stub ? ' ·soon' : ''}
                </button>
              )
            })}
          </div>

          {/* Month navigation */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <button onClick={() => setMonthOffset((o) => o + 1)} style={navBtn} aria-label="Previous month"><ChevronLeft size={15} /></button>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ds-t2)', minWidth: 120, textAlign: 'center' }}>
              {monthOffset === 0 ? 'This month' : monthLabel(range)}
            </span>
            <button onClick={() => setMonthOffset((o) => Math.max(0, o - 1))} disabled={monthOffset === 0}
              style={{ ...navBtn, opacity: monthOffset === 0 ? 0.4 : 1 }} aria-label="Next month"><ChevronRight size={15} /></button>
          </div>

          <button onClick={() => refresh()} style={navBtn} aria-label="Refresh"><RotateCw size={14} /></button>
        </div>
      </div>

      {/* P&L body */}
      <div style={{ padding: '16px 20px' }}>
        {loading && !r ? (
          <div style={{ padding: '28px 0', textAlign: 'center', fontSize: 13, color: 'var(--ds-t3)' }}>Loading…</div>
        ) : !r ? (
          <div style={{ padding: '28px 0', textAlign: 'center', fontSize: 13, color: 'var(--ds-t3)' }}>No data for this fleet.</div>
        ) : (
          <>
            {/* Revenue */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0 12px' }}>
              <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ds-t1)' }}>Revenue</span>
              <span style={{ fontSize: 15, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: 'var(--ds-t1)' }}>{money(r.revenue)}</span>
            </div>

            {/* Costs */}
            <CostRow label="Fuel" value={r.fuel} />
            <CostRow label="Driver pay" value={r.driverCost} />
            <CostRow label="Maintenance" value={c!.maintenance} />
            <CostRow label="Insurance" value={c!.insurance} />
            <CostRow label="Loans — truck & trailer" value={c!.financing} />
            <CostRow label="Rent / lease — yard & trailer" value={c!.lease} />
            <CostRow label="Tolls" value={c!.tolls} />
            <CostRow label="Permits" value={c!.permits} />
            <CostRow label="Other" value={c!.other} />

            {/* Net */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, paddingTop: 14, borderTop: '2px solid var(--ds-border)' }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--ds-t1)' }}>
                Net Profit
                {margin != null && <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--ds-t3)', marginLeft: 8 }}>{margin.toFixed(1)}% margin</span>}
              </span>
              <span style={{ fontSize: 20, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: netColor(r.net) }}>{money(r.net)}</span>
            </div>

            <div style={{ marginTop: 14, fontSize: 11.5, color: 'var(--ds-t3)', lineHeight: 1.5 }}>
              Maintenance includes logged repair invoices. Trailer, yard-rent and toll costs appear here once allocated to the fleet in Expenses → Manage.
            </div>
          </>
        )}
      </div>
    </div>
  )
}
