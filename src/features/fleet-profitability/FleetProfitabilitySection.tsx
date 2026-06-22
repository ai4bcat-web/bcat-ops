import { useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, Plus, TrendingUp, AlertCircle, Trash2 } from 'lucide-react'
import { useFleetProfitability } from '@/hooks/useFleetProfitability'
import { useDriverPay } from '@/hooks/useDriverPay'
import { useDrivers } from '@/hooks/useDrivers'
import { FLEET_GROUPS, FLEET_GROUP_LABELS, isCombinedPayDriverId } from '@/lib/fleetGroups'
import type { FleetGroup } from '@/types/equipment'
import type { TruckProfitability, DateRange } from '@/lib/fleetProfitability'
import { weekRange, weekLabel } from './weekRange'
import { biweeklyPeriodOf } from '@/lib/payPeriods'
import { useFleetFixedCosts } from '@/hooks/useFleetFixedCosts'
import { DriverPayForm } from './DriverPayForm'
import { AmazonProfitPanel } from '@/features/finances/AmazonDriverProfit'

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

/**
 * Weekly fleet P&L. Revenue is shown per truck (attributed to the truck of each
 * load's DELIVERY driver); expenses are aggregated fleet-wide and broken out by
 * category (fuel, driver pay, maintenance, insurance, loans, rent/lease, tolls,
 * permits, other), then subtracted from revenue → weekly net profit for the fleet.
 *
 * Standalone (dashboard) it manages its own week navigation; when `externalRange` is
 * passed (e.g. embedded in the Expenses tab) it uses that range and hides the stepper.
 */
export function FleetProfitabilitySection({ externalRange }: { externalRange?: DateRange } = {}) {
  const [weekOffset, setWeekOffset] = useState(0)
  const [group, setGroup] = useState<FleetGroup>('LOCAL')
  const [showPayForm, setShowPayForm] = useState(false)

  const range = externalRange ?? weekRange(weekOffset)
  // Driver pay is entered per 14-day pay period (anchored to 6/8–6/21), independent of
  // the viewed profitability week — so the entry form defaults to the current period.
  const payPeriod = biweeklyPeriodOf()
  const { eldInRange } = useFleetFixedCosts()
  const eld = eldInRange(range)
  const { data, loading, refresh: refreshProfitability } = useFleetProfitability(range, group)
  const { payPeriods, createPay, deletePay, refresh: refreshPay } = useDriverPay()
  const { drivers } = useDrivers()

  const r = data?.rollup
  const trucks = data?.trucks ?? []
  const totalExpenses = r ? r.revenue - r.net : 0

  async function handleSavePay(input: Parameters<typeof createPay>[0]) {
    await createPay(input)
    // Re-fetch both this list and the profitability calc's own pay data.
    refreshPay()
    refreshProfitability()
  }

  async function handleDeletePay(id: string) {
    await deletePay(id)
    refreshProfitability()
  }

  const driverName = (id: string) =>
    isCombinedPayDriverId(id) ? `All ${FLEET_GROUP_LABELS[group]} drivers (combined)` : (drivers.find((d) => d.id === id)?.name ?? id)

  return (
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <TrendingUp size={16} style={{ color: 'var(--ds-blue)' }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>{externalRange ? 'Profitability' : 'Weekly Profitability'}</div>
            <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 2 }}>
              {group === 'AMAZON' ? 'Per driver · gross, expenses & profit to the company by week' : 'Revenue per truck · expenses by category · net for the week'}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {/* Fleet group switcher (AMAZON stubbed) */}
          <div style={{ display: 'flex', gap: 2, background: 'var(--ds-bg)', borderRadius: 8, padding: 2 }}>
            {FLEET_GROUPS.map((g) => {
              const active = g === group
              return (
                <button
                  key={g}
                  onClick={() => setGroup(g)}
                  style={{ padding: '5px 12px', borderRadius: 6, border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                    background: active ? 'var(--ds-surface)' : 'transparent', color: active ? 'var(--ds-t1)' : 'var(--ds-t2)',
                    boxShadow: active ? 'var(--sh-sm)' : 'none' }}>
                  {FLEET_GROUP_LABELS[g]}
                </button>
              )
            })}
          </div>

          {/* Week navigation — LOCAL only (Amazon tab shows all weeks) */}
          {!externalRange && group !== 'AMAZON' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <button onClick={() => setWeekOffset((o) => o + 1)} style={navBtn} aria-label="Previous week"><ChevronLeft size={15} /></button>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ds-t2)', minWidth: 150, textAlign: 'center' }}>
                {weekOffset === 0 ? 'This week' : weekLabel(range)}
              </span>
              <button onClick={() => setWeekOffset((o) => Math.max(0, o - 1))} disabled={weekOffset === 0} style={{ ...navBtn, opacity: weekOffset === 0 ? 0.4 : 1 }} aria-label="Next week"><ChevronRight size={15} /></button>
            </div>
          )}

          {group !== 'AMAZON' && (
            <button onClick={() => setShowPayForm(true)} style={{ display: 'flex', alignItems: 'center', gap: 5, height: 30, padding: '0 12px', background: 'var(--ds-blue)', border: 'none', borderRadius: 8, fontSize: 12.5, fontWeight: 600, color: '#fff', cursor: 'pointer' }}>
              <Plus size={13} /> Driver pay
            </button>
          )}
        </div>
      </div>

      {group === 'AMAZON' && <AmazonProfitPanel />}

      {group !== 'AMAZON' && (<>
      {/* Roll-up strip */}
      {r && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 1, background: 'var(--ds-border)', borderBottom: '1px solid var(--ds-border)' }}>
          <Kpi label="Revenue" value={money(r.revenue)} />
          <Kpi label="Total expenses" value={money(totalExpenses)} />
          <Kpi label="Net profit" value={money(r.net)} color={netColor(r.net)} />
          <Kpi label="Rev / mi" value={money2(r.revenuePerMile)} />
        </div>
      )}

      {/* Revenue by truck */}
      <SectionTitle>Revenue by truck</SectionTitle>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--ds-border)' }}>
              <th style={{ ...TH, textAlign: 'left' }}>Truck</th>
              <th style={{ ...TH, textAlign: 'left' }}>Driver</th>
              <th style={TH}>Revenue</th>
              <th style={TH}>Miles</th>
              <th style={TH}>Rev / mi</th>
            </tr>
          </thead>
          <tbody>
            {loading && trucks.length === 0 && (
              <tr><td colSpan={5} style={{ ...TD, textAlign: 'center', color: 'var(--ds-t3)', padding: '24px' }}>Loading…</td></tr>
            )}
            {!loading && trucks.length === 0 && (
              <tr><td colSpan={5} style={{ ...TD, textAlign: 'center', color: 'var(--ds-t3)', padding: '24px' }}>No trucks in this fleet group yet. Set a truck's fleet group to “{FLEET_GROUP_LABELS[group]}” in Fleet.</td></tr>
            )}
            {trucks.map((t) => <RevenueRow key={t.truckId} t={t} />)}
            {r && trucks.length > 0 && (
              <tr style={{ borderTop: '2px solid var(--ds-border)', background: 'var(--ds-bg)' }}>
                <td style={{ ...TD, textAlign: 'left', fontWeight: 700 }} colSpan={2}>Fleet total</td>
                <td style={{ ...TD, fontWeight: 700 }}>{money(r.revenue)}</td>
                <td style={{ ...TD, fontWeight: 700 }}>{miles(r.miles)}</td>
                <td style={{ ...TD, fontWeight: 700 }}>{money2(r.revenuePerMile)}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Revenue that didn't land on a truck — broker-covered (excluded) + unassigned */}
      {data?.revenueLeakage && (data.revenueLeakage.unattributed > 0 || data.revenueLeakage.broker > 0) && (
        <div style={{ padding: '8px 18px', borderTop: '1px solid var(--ds-border)', display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 12, color: 'var(--ds-t3)' }}>
          {data.revenueLeakage.unattributed > 0 && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }} title="Delivered by a company driver who has no assigned truck — assign a truck in Drivers to capture this.">
              <AlertCircle size={12} style={{ color: '#b45309' }} />
              Unattributed (no truck assigned): <strong style={{ color: '#b45309', fontVariantNumeric: 'tabular-nums' }}>{money(data.revenueLeakage.unattributed)}</strong>
            </span>
          )}
          {data.revenueLeakage.broker > 0 && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }} title="Loads covered by a broker / 3PL — intentionally excluded from truck revenue.">
              Broker-covered (excluded): <strong style={{ color: 'var(--ds-t2)', fontVariantNumeric: 'tabular-nums' }}>{money(data.revenueLeakage.broker)}</strong>
            </span>
          )}
        </div>
      )}

      {/* Weekly P&L — expenses aggregated by category, subtracted from revenue */}
      <div style={{ borderTop: '1px solid var(--ds-border)' }}>
        <SectionTitle>Expenses by category · weekly P&amp;L</SectionTitle>
        {r && (
          <div style={{ padding: '4px 18px 18px', maxWidth: 480 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0 10px' }}>
              <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ds-t1)' }}>Revenue</span>
              <span style={{ fontSize: 14, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: 'var(--ds-t1)' }}>{money(r.revenue)}</span>
            </div>
            <CostRow label="Fuel" value={r.fuel} />
            <CostRow label="Driver pay" value={r.driverCost} />
            <CostRow label="Maintenance" value={r.categories.maintenance} />
            <CostRow label="Insurance" value={r.categories.insurance} />
            <CostRow label="Loans — truck & trailer" value={r.categories.financing} />
            <CostRow label="Rent / lease — yard & trailer" value={r.categories.lease} />
            <CostRow label="Tolls" value={r.categories.tolls} />
            <CostRow label="Permits" value={r.categories.permits} />
            <CostRow label="ELD" value={eld} />
            <CostRow label="Other" value={Math.max(0, r.categories.other - eld)} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6, paddingTop: 9, borderTop: '1px solid var(--ds-border)' }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ds-t2)' }}>Total expenses</span>
              <span style={{ fontSize: 13, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: 'var(--ds-t1)' }}>− {money(totalExpenses)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, paddingTop: 11, borderTop: '2px solid var(--ds-border)' }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--ds-t1)' }}>
                Net profit
                {r.revenue > 0 && <span style={{ fontSize: 11.5, fontWeight: 500, color: 'var(--ds-t3)', marginLeft: 8 }}>{((r.net / r.revenue) * 100).toFixed(0)}% margin</span>}
              </span>
              <span style={{ fontSize: 18, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: netColor(r.net) }}>{money(r.net)}</span>
            </div>
          </div>
        )}
      </div>

      {/* Driver-pay entries for context (entered per driver, aggregated above) */}
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
                <button onClick={() => handleDeletePay(p.id)} style={{ marginLeft: 'auto', color: 'var(--ds-t3)', background: 'none', border: 'none', cursor: 'pointer' }} aria-label="Delete pay period"><Trash2 size={13} /></button>
              </div>
            ))}
          </div>
        </div>
      )}
      </>)}

      {showPayForm && (
        <DriverPayForm
          onSave={handleSavePay}
          onClose={() => setShowPayForm(false)}
          defaultStart={payPeriod.start}
          defaultEnd={payPeriod.end}
          fleetGroup={group}
        />
      )}
    </div>
  )
}

const navBtn: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 7, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', color: 'var(--ds-t2)', cursor: 'pointer' }

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div style={{ padding: '12px 18px 6px', fontSize: 11, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{children}</div>
  )
}

function Kpi({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ background: 'var(--ds-surface)', padding: '12px 14px' }}>
      <div style={{ fontSize: 10.5, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, marginTop: 3, color: color ?? 'var(--ds-t1)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  )
}

/** One "− $X" expense line in the P&L; muted "(none)" when a category has no cost. */
function CostRow({ label, value }: { label: string; value: number }) {
  const empty = value === 0
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderTop: '1px solid var(--ds-border)' }}>
      <span style={{ fontSize: 13, color: 'var(--ds-t2)', paddingLeft: 12 }}>{label}</span>
      <span style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', color: empty ? 'var(--ds-muted-soft)' : 'var(--ds-t1)' }}>
        {empty ? '(none)' : `− ${money(value)}`}
      </span>
    </div>
  )
}

function RevenueRow({ t }: { t: TruckProfitability }) {
  return (
    <tr style={{ borderBottom: '1px solid var(--ds-border)' }}>
      <td style={{ ...TD, textAlign: 'left' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>#{t.unitNumber}</span>
          {!t.hasEquipment && <Flag text="not in truck details" />}
        </div>
      </td>
      <td style={{ ...TD, textAlign: 'left', color: t.driverName ? 'var(--ds-t1)' : 'var(--ds-t3)' }}>{t.driverName ?? '—'}</td>
      <td style={{ ...TD, fontWeight: 600 }}>{money(t.revenue)}</td>
      <td style={TD}>{miles(t.miles)}</td>
      <td style={TD}>{money2(t.revenuePerMile)}</td>
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
