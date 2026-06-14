import { useState } from 'react'
import { ChevronLeft, ChevronRight, Plus, TrendingUp, AlertCircle, Trash2 } from 'lucide-react'
import { useFleetProfitability } from '@/hooks/useFleetProfitability'
import { useDriverPay } from '@/hooks/useDriverPay'
import { useDrivers } from '@/hooks/useDrivers'
import { FLEET_GROUPS, FLEET_GROUP_LABELS } from '@/lib/fleetGroups'
import type { FleetGroup } from '@/types/equipment'
import type { TruckProfitability } from '@/lib/fleetProfitability'
import { weekRange, weekLabel } from './weekRange'
import { DriverPayForm } from './DriverPayForm'

function money(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}
function money2(n: number | null): string {
  return n == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
}
function miles(n: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n)
}

const TH: React.CSSProperties = { fontSize: 10.5, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em', padding: '8px 10px', textAlign: 'right', whiteSpace: 'nowrap' }
const TD: React.CSSProperties = { fontSize: 13, color: 'var(--ds-t1)', padding: '10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }

function netColor(n: number): string {
  return n > 0 ? '#15803d' : n < 0 ? '#dc2626' : 'var(--ds-t2)'
}

export function FleetProfitabilitySection() {
  const [weekOffset, setWeekOffset] = useState(0)
  const [group, setGroup] = useState<FleetGroup>('LOCAL')
  const [showPayForm, setShowPayForm] = useState(false)

  const range = weekRange(weekOffset)
  const { data, loading } = useFleetProfitability(range, group)
  const { payPeriods, createPay, deletePay, refresh: refreshPay } = useDriverPay()
  const { drivers } = useDrivers()

  const r = data?.rollup
  const trucks = data?.trucks ?? []

  async function handleSavePay(input: Parameters<typeof createPay>[0]) {
    await createPay(input)
    // Re-fetch so the profitability calc picks up the new pay period.
    refreshPay()
  }

  const driverName = (id: string) => drivers.find((d) => d.id === id)?.name ?? id

  return (
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <TrendingUp size={16} style={{ color: 'var(--ds-blue)' }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>Weekly Profitability</div>
            <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 2 }}>Revenue, miles, fuel &amp; driver cost per truck</div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {/* Fleet group switcher (AMAZON stubbed) */}
          <div style={{ display: 'flex', gap: 2, background: 'var(--ds-bg)', borderRadius: 8, padding: 2 }}>
            {FLEET_GROUPS.map((g) => {
              const active = g === group
              const stub = g === 'AMAZON'
              return (
                <button
                  key={g}
                  onClick={() => !stub && setGroup(g)}
                  disabled={stub}
                  title={stub ? 'Amazon fleet — coming soon' : undefined}
                  style={{ padding: '5px 12px', borderRadius: 6, border: 'none', fontSize: 12, fontWeight: 600, cursor: stub ? 'not-allowed' : 'pointer',
                    background: active ? 'var(--ds-surface)' : 'transparent', color: stub ? 'var(--ds-t3)' : active ? 'var(--ds-t1)' : 'var(--ds-t2)',
                    boxShadow: active ? 'var(--sh-sm)' : 'none', opacity: stub ? 0.55 : 1 }}>
                  {FLEET_GROUP_LABELS[g]}{stub ? ' ·soon' : ''}
                </button>
              )
            })}
          </div>

          {/* Week navigation */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <button onClick={() => setWeekOffset((o) => o + 1)} style={navBtn}><ChevronLeft size={15} /></button>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ds-t2)', minWidth: 150, textAlign: 'center' }}>
              {weekOffset === 0 ? 'This week' : weekLabel(range)}
            </span>
            <button onClick={() => setWeekOffset((o) => Math.max(0, o - 1))} disabled={weekOffset === 0} style={{ ...navBtn, opacity: weekOffset === 0 ? 0.4 : 1 }}><ChevronRight size={15} /></button>
          </div>

          <button onClick={() => setShowPayForm(true)} style={{ display: 'flex', alignItems: 'center', gap: 5, height: 30, padding: '0 12px', background: 'var(--ds-blue)', border: 'none', borderRadius: 8, fontSize: 12.5, fontWeight: 600, color: '#fff', cursor: 'pointer' }}>
            <Plus size={13} /> Driver pay
          </button>
        </div>
      </div>

      {/* Roll-up strip */}
      {r && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 1, background: 'var(--ds-border)', borderBottom: '1px solid var(--ds-border)' }}>
          <Kpi label="Revenue" value={money(r.revenue)} />
          <Kpi label="Miles" value={miles(r.miles)} />
          <Kpi label="Fuel" value={money(r.fuel)} />
          <Kpi label="Other exp." value={money(r.otherExpenses)} />
          <Kpi label="Driver cost" value={money(r.driverCost)} />
          <Kpi label="Net" value={money(r.net)} color={netColor(r.net)} />
          <Kpi label="Rev / mi" value={money2(r.revenuePerMile)} />
          <Kpi label="Fuel / mi" value={money2(r.fuelPerMile)} />
        </div>
      )}

      {/* Per-truck table */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--ds-border)' }}>
              <th style={{ ...TH, textAlign: 'left' }}>Truck</th>
              <th style={{ ...TH, textAlign: 'left' }}>Driver</th>
              <th style={TH}>Revenue</th>
              <th style={TH}>Miles</th>
              <th style={TH}>Fuel</th>
              <th style={TH}>Other</th>
              <th style={TH}>Driver $</th>
              <th style={TH}>Net</th>
              <th style={TH}>Rev / mi</th>
              <th style={TH}>Fuel / mi</th>
            </tr>
          </thead>
          <tbody>
            {loading && trucks.length === 0 && (
              <tr><td colSpan={10} style={{ ...TD, textAlign: 'center', color: 'var(--ds-t3)', padding: '24px' }}>Loading…</td></tr>
            )}
            {!loading && trucks.length === 0 && (
              <tr><td colSpan={10} style={{ ...TD, textAlign: 'center', color: 'var(--ds-t3)', padding: '24px' }}>No trucks in this fleet group yet. Set a truck's fleet group to “{FLEET_GROUP_LABELS[group]}” in Fleet.</td></tr>
            )}
            {trucks.map((t) => <TruckRow key={t.truckId} t={t} />)}
          </tbody>
        </table>
      </div>

      {/* Driver-pay entries for context */}
      {payPeriods.length > 0 && (
        <div style={{ borderTop: '1px solid var(--ds-border)', padding: '12px 20px' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Driver pay periods</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {payPeriods.slice().sort((a, b) => b.periodStart.localeCompare(a.periodStart)).map((p) => (
              <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, color: 'var(--ds-t2)' }}>
                <span style={{ fontWeight: 600, color: 'var(--ds-t1)', minWidth: 120 }}>{driverName(p.driverId)}</span>
                <span style={{ color: 'var(--ds-t3)' }}>{p.periodStart} → {p.periodEnd}</span>
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>{money(p.grossPay)}</span>
                <span style={{ fontSize: 10, color: 'var(--ds-t3)', border: '1px solid var(--ds-border)', borderRadius: 4, padding: '1px 5px' }}>{p.source ?? 'MANUAL'}</span>
                <button onClick={() => deletePay(p.id)} style={{ marginLeft: 'auto', color: 'var(--ds-t3)', background: 'none', border: 'none', cursor: 'pointer' }} title="Delete"><Trash2 size={13} /></button>
              </div>
            ))}
          </div>
        </div>
      )}

      {showPayForm && (
        <DriverPayForm
          onSave={handleSavePay}
          onClose={() => setShowPayForm(false)}
          defaultStart={range.start}
          defaultEnd={range.end}
        />
      )}
    </div>
  )
}

const navBtn: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 7, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', color: 'var(--ds-t2)', cursor: 'pointer' }

function Kpi({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ background: 'var(--ds-surface)', padding: '12px 14px' }}>
      <div style={{ fontSize: 10.5, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, marginTop: 3, color: color ?? 'var(--ds-t1)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  )
}

function TruckRow({ t }: { t: TruckProfitability }) {
  return (
    <tr style={{ borderBottom: '1px solid var(--ds-border)' }}>
      <td style={{ ...TD, textAlign: 'left' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>#{t.unitNumber}</span>
          {!t.hasEquipment && <Flag text="not in truck details" />}
          {t.hasEquipment && !t.hasFuelCard && <Flag text="no fuel card" />}
        </div>
      </td>
      <td style={{ ...TD, textAlign: 'left', color: t.driverName ? 'var(--ds-t1)' : 'var(--ds-t3)' }}>{t.driverName ?? '—'}</td>
      <td style={TD}>{money(t.revenue)}</td>
      <td style={TD}>{miles(t.miles)}</td>
      <td style={{ ...TD, color: t.hasFuelCard ? 'var(--ds-t1)' : 'var(--ds-t3)' }}>{t.hasFuelCard ? money(t.fuel) : '—'}</td>
      <td style={TD}>{money(t.otherExpenses)}</td>
      <td style={TD}>{money(t.driverCost)}</td>
      <td style={{ ...TD, fontWeight: 700, color: netColor(t.net) }}>{money(t.net)}</td>
      <td style={TD}>{money2(t.revenuePerMile)}</td>
      <td style={TD}>{money2(t.fuelPerMile)}</td>
    </tr>
  )
}

function Flag({ text }: { text: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 9.5, fontWeight: 600, color: '#b45309', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 4, padding: '1px 5px', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
      <AlertCircle size={9} /> {text}
    </span>
  )
}
