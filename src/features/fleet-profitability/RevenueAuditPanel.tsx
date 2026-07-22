import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ChevronDown, ChevronRight, Search, Wrench } from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'
import { auditFleetRevenue, type AuditBucket, type RevenueAudit } from '@/lib/revenueAudit'
import type { DateRange } from '@/lib/fleetProfitability'
import type { FleetGroup } from '@/types/equipment'
import { FLEET_GROUP_LABELS } from '@/lib/fleetGroups'

function money(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}
function money2(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
}
function shortDate(d: string): string {
  if (!d) return '—'
  return new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const editSelect: React.CSSProperties = {
  height: 26, maxWidth: 150, padding: '0 6px', borderRadius: 6, border: '1px solid var(--ds-border)',
  background: 'var(--ds-surface)', color: 'var(--ds-t1)', fontSize: 12, fontFamily: 'inherit',
}

/** Inline editable rate ($). Commits cents on blur / Enter; Esc reverts. */
function RateCell({ cents, onCommit }: { cents: number; onCommit: (cents: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const value = draft ?? (cents ? (cents / 100).toString() : '')
  const commit = () => {
    if (draft == null) return
    const dollars = parseFloat(draft)
    const nextCents = isNaN(dollars) || draft.trim() === '' ? 0 : Math.round(dollars * 100)
    setDraft(null)
    if (nextCents !== cents) onCommit(nextCents)
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, justifyContent: 'flex-end' }}>
      <span style={{ color: 'var(--ds-t3)', fontSize: 12 }}>$</span>
      <input
        type="number" step="0.01" min="0"
        value={value}
        placeholder="0.00"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setDraft(null); e.currentTarget.blur() } }}
        style={{ width: 82, height: 26, textAlign: 'right', padding: '0 6px', borderRadius: 6, border: '1px solid var(--ds-border)', background: cents ? 'var(--ds-surface)' : '#fffbeb', color: 'var(--ds-t1)', fontSize: 12, fontFamily: 'var(--font-mono)', fontWeight: 600 }}
      />
    </span>
  )
}

// Display order + labels/tones for each bucket.
const BUCKETS: { key: AuditBucket; label: string; hint: string; tone: string; countsToward: boolean }[] = [
  { key: 'counted',      label: 'Counted — on a fleet truck',     hint: 'Delivered this month on this fleet’s truck.',                          tone: '#15803d', countsToward: true },
  { key: 'zeroRate',     label: 'On a fleet truck, but $0 rate',  hint: 'Would count, but the load has no rate entered.',                       tone: '#b45309', countsToward: true },
  { key: 'unattributed', label: 'No truck assigned',              hint: 'A company driver delivered it but has no truck assigned (Drivers page).', tone: '#b45309', countsToward: false },
  { key: 'otherFleet',   label: 'On another fleet / no driver',   hint: 'Delivered on a truck in a different fleet, or with no resolvable driver/truck.', tone: 'var(--ds-t3)', countsToward: false },
  { key: 'broker',       label: 'Broker-covered (excluded)',      hint: 'Run by a broker / 3PL — intentionally excluded from truck revenue.',   tone: 'var(--ds-t3)', countsToward: false },
]

export function RevenueAuditPanel({ range, group, expectedRevenue }: {
  range: DateRange
  group: FleetGroup
  expectedRevenue: number
}) {
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<Set<AuditBucket>>(new Set(['unattributed']))
  const [q, setQ] = useState('')

  const loads = useAppStore((s) => s.loads)
  const drivers = useAppStore((s) => s.drivers)
  const equipment = useAppStore((s) => s.equipment)
  const assignTruckToDriver = useAppStore((s) => s.assignTruckToDriver)
  const updateLoad = useAppStore((s) => s.updateLoad)

  const loadById = useMemo(() => new Map(loads.map((l) => [l.id, l])), [loads])
  const driverOptions = useMemo(
    () => [...drivers].filter((d) => d.active !== false).sort((a, b) => a.name.localeCompare(b.name)),
    [drivers],
  )

  const audit: RevenueAudit = useMemo(
    () => auditFleetRevenue({ loads, drivers, equipment, range, group }),
    [loads, drivers, equipment, range, group],
  )

  // Trucks of THIS fleet, offered in the inline assign dropdown (so the reassigned
  // loads actually land in this fleet's revenue). Sorted by unit number.
  const fleetTrucks = useMemo(
    () => equipment
      .filter((e) => e.type === 'truck' && e.fleetGroup === group)
      .sort((a, b) => a.unitNumber.localeCompare(b.unitNumber, undefined, { numeric: true })),
    [equipment, group],
  )

  // Distinct drivers in the "no truck assigned" bucket → one assign control each.
  const unassignedDrivers = useMemo(() => {
    const m = new Map<string, { name: string; count: number; total: number }>()
    for (const r of audit.buckets.unattributed.rows) {
      if (!r.driverId) continue
      const cur = m.get(r.driverId) ?? { name: r.driverName ?? 'Unknown', count: 0, total: 0 }
      cur.count += 1; cur.total += r.rate
      m.set(r.driverId, cur)
    }
    return [...m.entries()].map(([driverId, v]) => ({ driverId, ...v })).sort((a, b) => b.total - a.total)
  }, [audit])

  async function assign(driverId: string, equipmentId: string) {
    const truck = equipment.find((e) => e.id === equipmentId)
    try {
      await assignTruckToDriver(equipmentId, driverId)
      toast.success(`Assigned to #${truck?.unitNumber ?? ''} — revenue reattributed`)
    } catch { toast.error('Could not assign truck') }
  }

  // Reconciliation check: counted total should equal the P&L revenue number.
  const delta = Math.round(audit.countedTotal - expectedRevenue)
  const reconciles = Math.abs(delta) < 1

  const toggle = (k: AuditBucket) =>
    setExpanded((prev) => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n })

  const filterRows = (rows: RevenueAudit['buckets'][AuditBucket]['rows']) => {
    if (!q.trim()) return rows
    const s = q.toLowerCase()
    return rows.filter((r) =>
      r.ref.toLowerCase().includes(s) || r.route.toLowerCase().includes(s) ||
      (r.driverName ?? '').toLowerCase().includes(s) || (r.customer ?? '').toLowerCase().includes(s) ||
      (r.truckLabel ?? '').toLowerCase().includes(s),
    )
  }

  return (
    <div style={{ marginTop: 10, border: '1px solid var(--ds-border)', borderRadius: 10, overflow: 'hidden' }}>
      {/* Toggle */}
      <button
        onClick={() => setOpen((v) => !v)}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: 'var(--ds-bg)', border: 'none', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}
      >
        {open ? <ChevronDown size={14} style={{ color: 'var(--ds-t3)' }} /> : <ChevronRight size={14} style={{ color: 'var(--ds-t3)' }} />}
        <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ds-t1)' }}>Revenue audit</span>
        <span style={{ fontSize: 11.5, color: 'var(--ds-t3)' }}>· what’s in {FLEET_GROUP_LABELS[group]}’s {money(expectedRevenue)}</span>
      </button>

      {open && (
        <div style={{ borderTop: '1px solid var(--ds-border)', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* Reconciliation + search */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: reconciles ? '#15803d' : '#b91c1c', fontWeight: 600 }}>
              {reconciles ? '✓ Reconciles with the Revenue line' : `⚠ Off by ${money(Math.abs(delta))} vs the Revenue line`}
            </span>
            <div style={{ position: 'relative', marginLeft: 'auto' }}>
              <Search size={12} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--ds-t3)', pointerEvents: 'none' }} />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter loads…"
                style={{ height: 28, width: 180, paddingLeft: 26, paddingRight: 8, boxSizing: 'border-box', background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 6, fontSize: 12, color: 'var(--ds-t1)', fontFamily: 'inherit', outline: 'none' }} />
            </div>
          </div>

          {/* "Delivered next month" note */}
          {audit.pickedUpThisMonthDeliveredLater.count > 0 && (
            <div style={{ fontSize: 11.5, color: 'var(--ds-t3)', background: 'var(--ds-bg)', borderRadius: 8, padding: '8px 10px' }}>
              Heads up: <b style={{ color: 'var(--ds-t2)' }}>{audit.pickedUpThisMonthDeliveredLater.count}</b> load{audit.pickedUpThisMonthDeliveredLater.count === 1 ? '' : 's'} picked up this month deliver next month
              (<b style={{ color: 'var(--ds-t2)' }}>{money(audit.pickedUpThisMonthDeliveredLater.total)}</b>) — revenue is booked on the <i>delivery</i> date, so it lands next month.
            </div>
          )}

          {/* Buckets */}
          {BUCKETS.map((b) => {
            const bucket = audit.buckets[b.key]
            if (bucket.rows.length === 0) return null
            const isOpen = expanded.has(b.key)
            const rows = filterRows(bucket.rows)
            return (
              <div key={b.key} style={{ border: '1px solid var(--ds-border)', borderRadius: 8, overflow: 'hidden' }}>
                <button
                  onClick={() => toggle(b.key)}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'var(--ds-surface)', border: 'none', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}
                >
                  {isOpen ? <ChevronDown size={13} style={{ color: 'var(--ds-t3)' }} /> : <ChevronRight size={13} style={{ color: 'var(--ds-t3)' }} />}
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: b.tone, flexShrink: 0 }} />
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ds-t1)' }}>{b.label}</span>
                  <span style={{ fontSize: 11, color: 'var(--ds-t3)' }}>· {bucket.rows.length}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: b.countsToward ? 'var(--ds-t1)' : 'var(--ds-t3)' }}>{money2(bucket.total)}</span>
                </button>
                {isOpen && (
                  <div style={{ borderTop: '1px solid var(--ds-border)', overflowX: 'auto' }}>
                    <div style={{ fontSize: 11, color: 'var(--ds-t3)', padding: '6px 12px', background: 'var(--ds-bg)' }}>{b.hint}</div>

                    {/* Inline fix: assign each unattributed driver a fleet truck → loads reattribute live. */}
                    {b.key === 'unattributed' && unassignedDrivers.length > 0 && (
                      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--ds-border)', display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {fleetTrucks.length === 0 ? (
                          <div style={{ fontSize: 11.5, color: '#b45309' }}>No {FLEET_GROUP_LABELS[group]} trucks to assign — add or tag a truck to this fleet on the Fleet page first.</div>
                        ) : unassignedDrivers.map((d) => (
                          <div key={d.driverId} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                            <Wrench size={13} style={{ color: 'var(--ds-t3)', flexShrink: 0 }} />
                            <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ds-t1)' }}>{d.name}</span>
                            <span style={{ fontSize: 11.5, color: 'var(--ds-t3)' }}>{d.count} load{d.count === 1 ? '' : 's'} · {money2(d.total)}</span>
                            <select
                              defaultValue=""
                              onChange={(e) => { if (e.target.value) assign(d.driverId, e.target.value) }}
                              style={{ marginLeft: 'auto', height: 28, padding: '0 8px', borderRadius: 6, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', color: 'var(--ds-t1)', fontSize: 12, fontFamily: 'inherit' }}
                            >
                              <option value="">Assign truck…</option>
                              {fleetTrucks.map((t) => (
                                <option key={t.id} value={t.id}>#{t.unitNumber}{t.nickname ? ` · ${t.nickname}` : ''}</option>
                              ))}
                            </select>
                          </div>
                        ))}
                      </div>
                    )}

                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 560 }}>
                      <thead>
                        <tr>
                          {['Ref', 'Route', 'Driver', 'Truck', 'Delivered', 'Rate'].map((h, i) => (
                            <th key={h} style={{ textAlign: i === 5 ? 'right' : 'left', padding: '6px 12px', fontSize: 10.5, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap', borderBottom: '1px solid var(--ds-border)' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r) => {
                          const load = loadById.get(r.id)
                          return (
                          <tr key={r.id} style={{ borderBottom: '1px solid var(--ds-border)' }}>
                            <td style={{ padding: '6px 12px', fontFamily: 'var(--font-mono)', color: 'var(--ds-t1)', whiteSpace: 'nowrap' }}>{r.ref}</td>
                            <td style={{ padding: '6px 12px', color: 'var(--ds-t2)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.route}</td>
                            {/* Driver — editable (fixes broker/no-driver misattribution) */}
                            <td style={{ padding: '5px 12px', whiteSpace: 'nowrap' }}>
                              <select
                                value={load?.deliveryDriverId ?? ''}
                                onChange={(e) => updateLoad(r.id, { deliveryDriverId: e.target.value || null })}
                                style={editSelect}
                              >
                                <option value="">— Unassigned —</option>
                                {driverOptions.map((d) => (
                                  <option key={d.id} value={d.id}>{d.name}{d.type === 'broker' ? ' (broker)' : ''}</option>
                                ))}
                              </select>
                            </td>
                            {/* Truck — editable; sets load.truckId (overrides the driver's truck) */}
                            <td style={{ padding: '5px 12px', whiteSpace: 'nowrap' }}>
                              <select
                                value={load?.truckId ?? ''}
                                onChange={(e) => updateLoad(r.id, { truckId: e.target.value || null })}
                                title={load?.truckId ? undefined : r.truckLabel ? `Inheriting ${r.truckLabel} from the driver` : undefined}
                                style={{ ...editSelect, color: load?.truckId ? 'var(--ds-t1)' : 'var(--ds-t3)' }}
                              >
                                <option value="">{r.truckLabel ? `(driver's ${r.truckLabel})` : '— none —'}</option>
                                {fleetTrucks.map((t) => (
                                  <option key={t.id} value={t.id}>#{t.unitNumber}{t.nickname ? ` · ${t.nickname}` : ''}</option>
                                ))}
                              </select>
                            </td>
                            <td style={{ padding: '6px 12px', fontFamily: 'var(--font-mono)', color: 'var(--ds-t3)', whiteSpace: 'nowrap' }}>{shortDate(r.deliveryDate)}</td>
                            {/* Rate — editable inline */}
                            <td style={{ padding: '5px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                              <RateCell cents={load?.rate ?? 0} onCommit={(c) => updateLoad(r.id, { rate: c })} />
                            </td>
                          </tr>
                          )
                        })}
                        {rows.length === 0 && (
                          <tr><td colSpan={6} style={{ padding: '10px 12px', textAlign: 'center', color: 'var(--ds-t3)' }}>No loads match “{q}”.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
