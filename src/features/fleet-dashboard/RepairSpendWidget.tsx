import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { DollarSign, ChevronRight } from 'lucide-react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { useAppStore } from '@/store/useAppStore'
import { FLEET_GROUPS, FLEET_GROUP_LABELS } from '@/lib/fleetGroups'
import type { FleetGroup } from '@/types/equipment'

function money(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(cents / 100)
}

/** Compact axis money — $850, $1.2k, $14k */
function moneyShort(cents: number): string {
  const d = cents / 100
  if (d >= 1000) return `$${(d / 1000).toFixed(d >= 10000 ? 0 : 1)}k`
  return `$${Math.round(d)}`
}

/** 'YYYY-MM' → 'Mon 'YY' */
function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
}

const ymIndex = (ym: string) => { const [y, m] = ym.split('-').map(Number); return y * 12 + (m - 1) }
const indexYm = (idx: number) => `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`
const currentYm = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}` }

const inputStyle: React.CSSProperties = {
  height: 32, borderRadius: 8, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)',
  color: 'var(--ds-t1)', fontSize: 12.5, padding: '0 8px', fontFamily: 'inherit',
}
const labelStyle: React.CSSProperties = { fontSize: 10.5, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.04em' }

const FLEET_COLOR: Record<'all' | FleetGroup, string> = { all: '#1ea8f3', LOCAL: '#1ea8f3', AMAZON: '#f59e0b' }

// Cap the timeline so an all-time range stays readable.
const MAX_BARS = 24

/**
 * Repair spend by month as a bar chart, filterable by fleet (Ivan/Local vs Amazon),
 * by equipment, and by a specific date range. Sources the same maintenance invoices as
 * the Maintenance page; fleet is resolved from each truck's Equipment.fleetGroup.
 */
export function RepairSpendWidget() {
  const invoices = useAppStore((s) => s.maintenanceInvoices)
  const equipment = useAppStore((s) => s.equipment)

  const [fleet, setFleet] = useState<'all' | FleetGroup>('all')
  const [equipId, setEquipId] = useState<string>('all')
  const [from, setFrom] = useState<string>('')
  const [to, setTo] = useState<string>('')

  const equipMap = useMemo(() => new Map(equipment.map((e) => [e.id, e])), [equipment])

  // Equipment options scoped to the chosen fleet.
  const equipOptions = useMemo(
    () => [...equipment]
      .filter((e) => fleet === 'all' || e.fleetGroup === fleet)
      .sort((a, b) => a.unitNumber.localeCompare(b.unitNumber, undefined, { numeric: true })),
    [equipment, fleet],
  )

  function changeFleet(f: 'all' | FleetGroup) {
    setFleet(f)
    // Drop an equipment selection that no longer belongs to the chosen fleet.
    if (equipId !== 'all' && f !== 'all' && equipMap.get(equipId)?.fleetGroup !== f) setEquipId('all')
  }

  const filtered = useMemo(
    () => invoices.filter((i) => {
      if (fleet !== 'all' && (equipMap.get(i.equipmentId)?.fleetGroup ?? null) !== fleet) return false
      if (equipId !== 'all' && i.equipmentId !== equipId) return false
      const d = i.date ?? ''
      if (from && d < from) return false
      if (to && d > to) return false
      return true
    }),
    [invoices, fleet, equipId, from, to, equipMap],
  )

  const total = useMemo(() => filtered.reduce((s, i) => s + i.amount, 0), [filtered])

  // Continuous month timeline (fills gaps with zero) so the bars read as a timeline.
  const data = useMemo(() => {
    const buckets = new Map<string, { total: number; count: number }>()
    for (const i of filtered) {
      const d = i.date ?? i.createdAt.slice(0, 10)
      const ym = d.slice(0, 7)
      if (!/^\d{4}-\d{2}$/.test(ym)) continue
      const cur = buckets.get(ym) ?? { total: 0, count: 0 }
      cur.total += i.amount; cur.count += 1
      buckets.set(ym, cur)
    }
    if (buckets.size === 0) return [] as { ym: string; label: string; total: number; count: number }[]

    const idxs = [...buckets.keys()].map(ymIndex)
    let start = Math.min(...idxs)
    // Default (no explicit From): show the last 12 months of activity ending at the latest.
    const end = to ? ymIndex(to.slice(0, 7)) : Math.max(...idxs, ymIndex(currentYm()))
    if (!from) start = Math.max(start, end - 11)
    if (from) start = ymIndex(from.slice(0, 7))
    if (end - start + 1 > MAX_BARS) start = end - (MAX_BARS - 1)

    const out: { ym: string; label: string; total: number; count: number }[] = []
    for (let idx = start; idx <= end; idx++) {
      const ym = indexYm(idx)
      const b = buckets.get(ym)
      out.push({ ym, label: monthLabel(ym), total: b?.total ?? 0, count: b?.count ?? 0 })
    }
    return out
  }, [filtered, from, to])

  const hasFilter = fleet !== 'all' || equipId !== 'all' || !!from || !!to
  const barColor = FLEET_COLOR[fleet]

  return (
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <DollarSign size={16} style={{ color: 'var(--ds-t3)' }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>Repair Spend by Month</div>
            <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 1 }}>
              {money(total)} total{hasFilter ? ' · filtered' : ''} · {filtered.length} {filtered.length === 1 ? 'invoice' : 'invoices'}
            </div>
          </div>
        </div>
        <Link to="/invoices" style={{ fontSize: 12, color: 'var(--ds-blue)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
          Invoices <ChevronRight size={13} />
        </Link>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 8, padding: '12px 20px', borderBottom: '1px solid var(--ds-border)', background: 'var(--ds-bg)' }}>
        {/* Fleet segmented control */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={labelStyle}>Fleet</span>
          <div style={{ display: 'flex', gap: 2, background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 8, padding: 2 }}>
            {([['all', 'All'], ...FLEET_GROUPS.map((g) => [g, FLEET_GROUP_LABELS[g].replace(' (Ivan)', '').replace('Local', 'Ivan')] as [string, string])] as [string, string][]).map(([key, lbl]) => {
              const active = fleet === key
              return (
                <button
                  key={key}
                  onClick={() => changeFleet(key as 'all' | FleetGroup)}
                  style={{ padding: '4px 11px', height: 24, borderRadius: 6, border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                    background: active ? (key === 'all' ? 'var(--ds-blue)' : FLEET_COLOR[key as FleetGroup]) : 'transparent',
                    color: active ? '#fff' : 'var(--ds-t2)' }}
                >
                  {lbl}
                </button>
              )
            })}
          </div>
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={labelStyle}>Equipment</span>
          <select value={equipId} onChange={(e) => setEquipId(e.target.value)} style={{ ...inputStyle, minWidth: 150 }}>
            <option value="all">All equipment</option>
            {equipOptions.map((e) => (
              <option key={e.id} value={e.id}>#{e.unitNumber}{e.nickname ? ` · ${e.nickname}` : ''}</option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={labelStyle}>From</span>
          <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} style={inputStyle} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={labelStyle}>To</span>
          <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} style={inputStyle} />
        </label>
        {hasFilter && (
          <button
            onClick={() => { setFleet('all'); setEquipId('all'); setFrom(''); setTo('') }}
            style={{ height: 32, padding: '0 10px', borderRadius: 8, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', color: 'var(--ds-t2)', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}
          >
            Clear
          </button>
        )}
      </div>

      {/* Bar chart */}
      <div style={{ padding: '14px 12px 8px' }}>
        {data.length === 0 ? (
          <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ds-t3)', fontSize: 13 }}>
            No repair spend for this selection.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
              <CartesianGrid stroke="rgba(15,23,42,0.05)" strokeDasharray="3 4" vertical={false} />
              <XAxis dataKey="label" tick={{ fill: '#6b7588', fontSize: 11 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
              <YAxis tickFormatter={(v) => moneyShort(Number(v))} tick={{ fill: '#6b7588', fontSize: 11 }} axisLine={false} tickLine={false} width={52} />
              <Tooltip
                cursor={{ fill: 'rgba(15,23,42,0.04)' }}
                formatter={(v, _n, item) => {
                  const count = (item as { payload?: { count?: number } })?.payload?.count ?? 0
                  return [`${money(Number(v))} · ${count} ${count === 1 ? 'invoice' : 'invoices'}`, 'Repair spend']
                }}
                contentStyle={{ background: 'white', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 12, boxShadow: 'var(--sh-md)' }}
              />
              <Bar dataKey="total" radius={[4, 4, 0, 0]} maxBarSize={54}>
                {data.map((d) => <Cell key={d.ym} fill={barColor} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
}
