import { useEffect, useMemo, useState } from 'react'
import { truckInFleet } from '@/lib/fleetGroups'
import { Link } from 'react-router-dom'
import { Gauge, ChevronRight, Pencil } from 'lucide-react'
import { TmsButton } from '@/features/tms/kit/TmsButton'
import { TmsDialog } from '@/features/tms/kit/TmsDialog'
import { TmsEmptyState } from '@/features/tms/kit/TmsEmptyState'
import { useAppStore } from '@/store/useAppStore'
import { useAuth } from '@/hooks/useAuth'
import { listTruckLocations, type TruckLocation } from '@/lib/apiClient'
import type { Equipment } from '@/types/equipment'
import { PM_INTERVAL_MI, PM_DUE_SOON_MI } from '@/lib/pmDue'

// The interval and the due-soon window live in src/lib/pmDue.ts, shared with the Ivan
// driver app so the number on a driver's phone is the number the office is reading.
const PM_INTERVAL = PM_INTERVAL_MI
const DUE_SOON_MI = PM_DUE_SOON_MI

const nf = new Intl.NumberFormat('en-US')
const miles = (n: number) => `${nf.format(Math.round(n))} mi`

function shortDate(d?: string): string {
  if (!d) return '—'
  const dt = new Date(`${d}T12:00:00`)
  return isNaN(dt.getTime()) ? d : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

interface PmRow {
  truck: Equipment
  current: number | null      // Motive odometer, or null when Motive hasn't reported one
  lastMileage: number
  lastDate?: string
  nextDue: number
  remaining: number | null    // null when current mileage unknown
}

/**
 * Miles-until-next-PM tracker for the Ivan (LOCAL) fleet. Each truck's next PM is due
 * 25,000 mi after its last PM odometer. The current odometer comes SOLELY from Motive
 * (TruckLocation.odometer, refreshed by the location-sync); it is never entered manually.
 * Last PM date + odometer are the only editable (manual) values here.
 */
export function PmDueWidget() {
  const { hasPageAccess } = useAuth()
  const canMaintenance = hasPageAccess('maintenance')
  const equipment = useAppStore((s) => s.equipment)
  const updateEquipment = useAppStore((s) => s.updateEquipment)
  const [locations, setLocations] = useState<TruckLocation[]>([])
  const [editing, setEditing] = useState<Equipment | null>(null)

  useEffect(() => {
    let alive = true
    listTruckLocations().then((l) => { if (alive) setLocations(l) }).catch(() => {})
    return () => { alive = false }
  }, [])

  const locByTruck = useMemo(() => {
    const m = new Map<string, TruckLocation>()
    for (const l of locations) m.set(l.truckId, l)
    return m
  }, [locations])

  const rows = useMemo<PmRow[]>(() => {
    return equipment
      .filter((e) => e.type === 'truck' && e.active !== false && truckInFleet(e.fleetGroup, 'LOCAL'))
      .map((truck) => {
        // Current odometer is ALWAYS the Motive reading — never a manual/fuel value.
        const motive = locByTruck.get(truck.id)?.odometer
        const current = typeof motive === 'number' && motive > 0 ? motive : null
        const lastMileage = truck.lastPmMileage ?? 0
        const nextDue = lastMileage + PM_INTERVAL
        const remaining = current != null ? nextDue - current : null
        return { truck, current, lastMileage, lastDate: truck.lastPmDate, nextDue, remaining }
      })
      // Configured PMs first (has a last-PM reading), then most urgent (least remaining).
      .sort((a, b) => {
        const aCfg = a.truck.lastPmMileage != null ? 0 : 1
        const bCfg = b.truck.lastPmMileage != null ? 0 : 1
        return aCfg - bCfg || (a.remaining ?? Infinity) - (b.remaining ?? Infinity)
      })
  }, [equipment, locByTruck])

  const dueSoon = rows.filter((r) => r.remaining != null && r.remaining <= DUE_SOON_MI).length

  return (
    <div style={{ background: 'var(--tms-card)', border: '1px solid var(--tms-border)', borderRadius: 12, boxShadow: 'var(--tms-shadow)', overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--tms-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Gauge size={16} style={{ color: 'var(--tms-muted)' }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--tms-text)' }}>Miles Until Next PM · Ivan Fleet</div>
            <div style={{ fontSize: 12, color: 'var(--tms-muted)', marginTop: 1 }}>
              Every {nf.format(PM_INTERVAL)} mi{dueSoon > 0 ? ` · ${dueSoon} due soon` : ''}
            </div>
          </div>
        </div>
        {canMaintenance && (
          <Link to="/maintenance" style={{ fontSize: 12, color: 'var(--tms-primary)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
            Maintenance <ChevronRight size={13} />
          </Link>
        )}
      </div>

      {rows.length === 0 ? (
        <TmsEmptyState compact title="No active Ivan-fleet trucks." message={null} />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12, padding: 16 }}>
          {rows.map((r) => {
            const notSet = r.truck.lastPmMileage == null
            const overdue = r.remaining != null && r.remaining < 0
            const soon = r.remaining != null && r.remaining >= 0 && r.remaining <= DUE_SOON_MI
            const accent = notSet || r.remaining == null ? 'var(--tms-muted)' : overdue ? 'var(--tms-badge-red)' : soon ? 'var(--tms-badge-orange)' : 'var(--tms-badge-green)'
            const pct = r.remaining == null ? 0 : Math.max(0, Math.min(100, ((PM_INTERVAL - r.remaining) / PM_INTERVAL) * 100))
            return (
              <div key={r.truck.id} style={{ border: '1px solid var(--tms-border)', borderRadius: 10, padding: '12px 14px', background: 'var(--tms-bg)' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--tms-text)', fontFamily: 'var(--font-mono)' }}>
                    #{r.truck.unitNumber}{r.truck.nickname ? <span style={{ fontFamily: 'inherit', fontWeight: 500, color: 'var(--tms-muted)', fontSize: 12 }}> · {r.truck.nickname}</span> : ''}
                  </span>
                  <span style={{ fontSize: 15, fontWeight: 700, color: accent, fontVariantNumeric: 'tabular-nums' }}>
                    {notSet || r.remaining == null ? '—' : overdue ? `${miles(Math.abs(r.remaining))} over` : miles(r.remaining)}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--tms-muted)', marginTop: 1 }}>
                  {notSet ? 'Set last PM to enable' : r.current == null ? 'awaiting Motive odometer' : overdue ? 'overdue' : 'until next PM'}
                </div>

                {/* Progress toward next PM */}
                <div style={{ height: 6, borderRadius: 999, background: 'var(--tms-surface-hover)', overflow: 'hidden', marginTop: 10 }}>
                  <div style={{ width: `${pct}%`, height: '100%', borderRadius: 999, background: accent }} />
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 10, fontSize: 11.5, color: 'var(--tms-text-2)' }}>
                  <Line label="Last PM" value={r.lastDate ? `${shortDate(r.lastDate)}${r.truck.lastPmMileage != null ? ` · ${miles(r.lastMileage)}` : ''}` : (r.truck.lastPmMileage != null ? miles(r.lastMileage) : 'Not recorded')} />
                  <Line label="Current" value={r.current != null ? `${miles(r.current)} · Motive` : 'Awaiting Motive sync'} />
                  <Line label="Next due" value={notSet ? '—' : miles(r.nextDue)} />
                </div>

                <button
                  onClick={() => setEditing(r.truck)}
                  style={{ marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', padding: 0, color: 'var(--tms-primary)', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
                >
                  <Pencil size={11} /> Edit last PM
                </button>
              </div>
            )
          })}
        </div>
      )}

      {editing && (
        <PmEditModal
          truck={editing}
          onClose={() => setEditing(null)}
          onSave={(patch) => { updateEquipment(editing.id, patch); setEditing(null) }}
        />
      )}
    </div>
  )
}

/** Inline editor for a truck's last-PM date + odometer. Current odometer is Motive-only. */
function PmEditModal({ truck, onClose, onSave }: {
  truck: Equipment
  onClose: () => void
  onSave: (patch: { lastPmDate?: string; lastPmMileage?: number }) => void
}) {
  const [lastPmDate, setLastPmDate] = useState(truck.lastPmDate ?? '')
  const [lastPmMileage, setLastPmMileage] = useState(truck.lastPmMileage?.toString() ?? '')

  function submit(e: React.FormEvent) {
    e.preventDefault()
    onSave({
      lastPmDate: lastPmDate || undefined,
      lastPmMileage: lastPmMileage ? parseInt(lastPmMileage, 10) : undefined,
    })
  }

  const field: React.CSSProperties = { height: 36, padding: '0 10px', borderRadius: 6, border: '1px solid var(--tms-border)', background: 'var(--tms-bg)', color: 'var(--tms-text)', fontSize: 13, fontFamily: 'inherit', width: '100%' }
  const label: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: 'var(--tms-text-2)', textTransform: 'uppercase', letterSpacing: '0.05em' }

  return (
    <TmsDialog open onOpenChange={(o) => { if (!o) onClose() }} title={`Preventive maintenance · #${truck.unitNumber}`}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <label style={label}>Last PM date</label>
          <input type="date" value={lastPmDate} onChange={(e) => setLastPmDate(e.target.value)} style={field} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <label style={label}>Last PM odometer (mi)</label>
          <input type="number" value={lastPmMileage} onChange={(e) => setLastPmMileage(e.target.value)} placeholder="e.g. 512000" style={field} />
        </div>
        <span style={{ fontSize: 11, color: 'var(--tms-muted)' }}>Current odometer comes from Motive automatically and isn’t set here.</span>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <TmsButton type="button" variant="secondary" onClick={onClose}>Cancel</TmsButton>
          <TmsButton type="submit" variant="primary">Save</TmsButton>
        </div>
      </form>
    </TmsDialog>
  )
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
      <span style={{ color: 'var(--tms-muted)' }}>{label}</span>
      <span style={{ color: 'var(--tms-text)', textAlign: 'right' }}>{value}</span>
    </div>
  )
}
