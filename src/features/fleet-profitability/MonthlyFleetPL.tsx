import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, RotateCw, Scale, Pencil } from 'lucide-react'
import { useFleetProfitability } from '@/hooks/useFleetProfitability'
import { useAmazonProfitability, aggregateAmazon } from '@/hooks/useAmazonProfitability'
import { useFleetFixedCosts, type FleetFixedCostKey } from '@/hooks/useFleetFixedCosts'
import { useTrucks } from '@/hooks/useTrucks'
import { useAppStore } from '@/store/useAppStore'
import { FLEET_GROUPS, FLEET_GROUP_LABELS } from '@/lib/fleetGroups'
import type { FleetGroup } from '@/types/equipment'
import { computeFleetMonthlyLines } from '@/lib/fleetMonthlyPL'
import { monthRange, monthLabel } from './monthRange'
import { RevenueAuditPanel } from './RevenueAuditPanel'

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

/** A computed "− $X" cost line; muted "(none)" when zero. */
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

/** An editable "− $[input]" cost line — edits the fixed monthly amount in place. */
function EditableCostRow({ label, amount, onCommit }: { label: string; amount: number; onCommit: (n: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const value = draft ?? (amount ? String(amount) : '')
  const commit = () => {
    if (draft == null) return
    const n = Math.max(0, parseFloat(draft) || 0)
    setDraft(null)
    if (n !== amount) onCommit(n)
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 0', borderTop: '1px solid var(--ds-border)' }}>
      <span style={{ fontSize: 13, color: 'var(--ds-t2)', paddingLeft: 14, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        {label}<Pencil size={10} style={{ color: 'var(--ds-muted-soft)' }} />
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 13, color: 'var(--ds-t1)' }}>
        −
        <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
          <span style={{ position: 'absolute', left: 8, color: 'var(--ds-t3)', fontSize: 12.5, pointerEvents: 'none' }}>$</span>
          <input
            type="number" min="0" step="1" inputMode="decimal"
            value={value}
            placeholder="0"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
            aria-label={`${label} monthly amount`}
            style={{ width: 96, height: 28, padding: '0 8px 0 18px', textAlign: 'right', borderRadius: 7,
              border: '1px solid var(--ds-border)', background: 'var(--ds-bg)', color: 'var(--ds-t1)',
              fontSize: 13, fontVariantNumeric: 'tabular-nums', fontFamily: 'inherit', outline: 'none' }}
          />
        </span>
        <span style={{ fontSize: 11, color: 'var(--ds-t3)' }}>/mo</span>
      </span>
    </div>
  )
}

/**
 * Monthly fleet Profit & Loss — Revenue minus every cost category, for one fleet group
 * (defaults to Local / Ivan). Loan-Trailers, Trailer-Lease and Yard-Rent are fixed
 * monthly amounts editable in place; Loan-Trucks comes from each truck's own loan;
 * Maintenance is logged invoices for Ivan trucks + all trailers. Net includes them all.
 */
export function MonthlyFleetPL() {
  const [monthOffset, setMonthOffset] = useState(0)
  const [group, setGroup] = useState<FleetGroup>('LOCAL')

  const range = monthRange(monthOffset)
  const { data, members, loading, refresh } = useFleetProfitability(range, group)
  const { rows: amzRows, loading: amzLoading } = useAmazonProfitability()
  const amzAgg = useMemo(() => aggregateAmazon(amzRows, range.start, range.end), [amzRows, range.start, range.end])
  const amzDrivers = useMemo(() => new Set(amzAgg.rows.map((r) => r.driverId)).size, [amzAgg])
  const isAmazon = group === 'AMAZON'
  const { monthlyAmounts, contributionInRange, eldInRange, setMonthlyAmount } = useFleetFixedCosts()
  const { equipment } = useTrucks()
  const maintenanceInvoices = useAppStore((s) => s.maintenanceInvoices)
  const r = data?.rollup
  const c = r?.categories

  const isLocal = group === 'LOCAL'

  // All-trailer maintenance in range (cents → dollars). Ivan-truck maintenance is already
  // in c.maintenance via the engine; trailers aren't members so we add them here.
  const trailerMaintenance = useMemo(() => {
    const trailerIds = new Set(equipment.filter((e) => e.type === 'trailer').map((e) => e.id))
    return maintenanceInvoices
      .filter((inv) => inv.date && inv.date >= range.start && inv.date <= range.end && trailerIds.has(inv.equipmentId))
      .reduce((s, inv) => s + (inv.amount ?? 0), 0) / 100
  }, [equipment, maintenanceInvoices, range.start, range.end])

  const contrib = useMemo(() => contributionInRange(range), [contributionInRange, range])
  const eld = useMemo(() => eldInRange(range), [eldInRange, range])

  const handleEdit = (key: FleetFixedCostKey) => (n: number) => { void setMonthlyAmount(key, n) }

  // Derived P&L lines (only the LOCAL fleet has fixed-cost + trailer detail wired).
  const lines = useMemo(
    () => (r && c ? computeFleetMonthlyLines(r, c, contrib, eld, trailerMaintenance) : null),
    [r, c, contrib, eld, trailerMaintenance],
  )

  const margin = lines && r && r.revenue > 0 ? (lines.net / r.revenue) * 100 : null

  return (
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Scale size={16} style={{ color: 'var(--ds-blue)' }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>Monthly Profit &amp; Loss</div>
            <div style={{ fontSize: 12, color: 'var(--ds-t3)' }}>
              {isAmazon ? `${amzDrivers} driver${amzDrivers === 1 ? '' : 's'}` : `${members.length} truck${members.length === 1 ? '' : 's'}`} · {monthLabel(range)}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 2, background: 'var(--ds-bg)', borderRadius: 8, padding: 2 }}>
            {FLEET_GROUPS.map((g) => {
              const active = g === group
              return (
                <button key={g} onClick={() => setGroup(g)}
                  style={{ padding: '5px 12px', borderRadius: 6, border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                    background: active ? 'var(--ds-surface)' : 'transparent', color: active ? 'var(--ds-t1)' : 'var(--ds-t2)',
                    boxShadow: active ? 'var(--sh-sm)' : 'none' }}>
                  {FLEET_GROUP_LABELS[g]}
                </button>
              )
            })}
          </div>

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
        {isAmazon ? (
          amzLoading && amzAgg.rows.length === 0 ? (
            <div style={{ padding: '28px 0', textAlign: 'center', fontSize: 13, color: 'var(--ds-t3)' }}>Loading…</div>
          ) : amzAgg.rows.length === 0 ? (
            <div style={{ padding: '28px 0', textAlign: 'center', fontSize: 13, color: 'var(--ds-t3)' }}>No Amazon driver pay this month.</div>
          ) : (
            <div style={{ maxWidth: 520 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0 12px' }}>
                <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ds-t1)' }}>Revenue <span style={{ fontSize: 11.5, fontWeight: 500, color: 'var(--ds-t3)' }}>(gross billed)</span></span>
                <span style={{ fontSize: 15, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: 'var(--ds-t1)' }}>{money(amzAgg.revenue)}</span>
              </div>
              <CostRow label="Driver pay" value={amzAgg.driverPay} />
              <CostRow label="Operating expenses" value={amzAgg.expenses} hint="fuel + fixed" />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6, paddingTop: 9, borderTop: '1px solid var(--ds-border)' }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ds-t2)' }}>Total expenses</span>
                <span style={{ fontSize: 13, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: 'var(--ds-t1)' }}>− {money(amzAgg.driverPay + amzAgg.expenses)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, paddingTop: 11, borderTop: '2px solid var(--ds-border)' }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--ds-t1)' }}>
                  Profit to company
                  {amzAgg.revenue > 0 && <span style={{ fontSize: 11.5, fontWeight: 500, color: 'var(--ds-t3)', marginLeft: 8 }}>{((amzAgg.profit / amzAgg.revenue) * 100).toFixed(0)}% margin</span>}
                </span>
                <span style={{ fontSize: 18, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: netColor(amzAgg.profit) }}>{money(amzAgg.profit)}</span>
              </div>
            </div>
          )
        ) : loading && !r ? (
          <div style={{ padding: '28px 0', textAlign: 'center', fontSize: 13, color: 'var(--ds-t3)' }}>Loading…</div>
        ) : !r || !lines ? (
          <div style={{ padding: '28px 0', textAlign: 'center', fontSize: 13, color: 'var(--ds-t3)' }}>No data for this fleet.</div>
        ) : (
          <div style={{ maxWidth: 520 }}>
            {/* Revenue */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0 6px' }}>
              <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ds-t1)' }}>Revenue</span>
              <span style={{ fontSize: 15, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: 'var(--ds-t1)' }}>{money(r.revenue)}</span>
            </div>
            <RevenueAuditPanel range={range} group={group} expectedRevenue={r.revenue} />
            <div style={{ height: 12 }} />

            {/* Costs */}
            <CostRow label="Fuel" value={r.fuel} />
            <CostRow label="Driver pay" value={r.driverCost} />
            <CostRow label="Loan — trucks" value={lines.loanTrucks} hint="from each truck" />
            {isLocal && monthOffset === 0 ? <EditableCostRow label="Loan — trailers" amount={monthlyAmounts.loanTrailers} onCommit={handleEdit('loanTrailers')} /> : <CostRow label="Loan — trailers" value={lines.loanTrailers} />}
            {isLocal && monthOffset === 0 ? <EditableCostRow label="Trailer lease" amount={monthlyAmounts.trailerLease} onCommit={handleEdit('trailerLease')} /> : <CostRow label="Trailer lease" value={lines.trailerLease} />}
            {isLocal && monthOffset === 0 ? <EditableCostRow label="Yard rent" amount={monthlyAmounts.yardRent} onCommit={handleEdit('yardRent')} /> : <CostRow label="Yard rent" value={lines.yardRent} />}
            <CostRow label="ELD" value={lines.eld} hint="per-truck, set in Fleet" />
            <CostRow label="Maintenance" value={lines.maintenance} hint="trucks + all trailers" />
            <CostRow label="Insurance" value={c!.insurance} />
            {isLocal && monthOffset === 0 ? <EditableCostRow label="Tolls" amount={monthlyAmounts.tolls} onCommit={handleEdit('tolls')} /> : <CostRow label="Tolls" value={lines.tolls} />}
            <CostRow label="Permits" value={c!.permits} />
            <CostRow label="Other" value={lines.other} />

            {/* Total + Net */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6, paddingTop: 9, borderTop: '1px solid var(--ds-border)' }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ds-t2)' }}>Total expenses</span>
              <span style={{ fontSize: 13, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: 'var(--ds-t1)' }}>− {money(lines.totalExpenses)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, paddingTop: 11, borderTop: '2px solid var(--ds-border)' }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--ds-t1)' }}>
                Net profit
                {margin != null && <span style={{ fontSize: 11.5, fontWeight: 500, color: 'var(--ds-t3)', marginLeft: 8 }}>{margin.toFixed(0)}% margin</span>}
              </span>
              <span style={{ fontSize: 18, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: netColor(lines.net) }}>{money(lines.net)}</span>
            </div>

            <div style={{ marginTop: 14, fontSize: 11.5, color: 'var(--ds-t3)', lineHeight: 1.5 }}>
              Loan-trailers, trailer-lease and yard-rent are fixed monthly amounts — edit them above. Loan-trucks pulls from each truck's loan (Fleet → Operating Costs); maintenance is logged invoices for Ivan trucks + all trailers.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
