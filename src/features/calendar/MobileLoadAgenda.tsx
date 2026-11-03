import { useMemo } from 'react'
import { useAppStore } from '@/store/useAppStore'
import type { Load, Driver } from '@/types'
import { isLoadCanceled, isLoadVoided } from '@/lib/shipmentVoid'

/**
 * Mobile replacement for the resource-timeline calendar: a day-grouped agenda list
 * of loads. Tapping a load opens the same LoadDrawer the desktop views use.
 */

function fmtTime(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

function dayKey(iso?: string): string {
  if (!iso) return 'No date'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? 'No date' : d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
}

function statusOf(l: Load): { label: string; color: string } {
  if (l.readyToInvoice) return { label: 'Ready', color: 'var(--tms-primary)' }
  if (l.pickupDriverId) return { label: 'In progress', color: 'var(--tms-primary)' }
  return { label: 'Unassigned', color: 'var(--tms-badge-orange)' }
}

export function MobileLoadAgenda({ loads: allLoads, drivers }: { loads: Load[]; drivers: Driver[] }) {
  // Same working-set rule the desktop calendar follows: a voided shipment's load
  // is history, and history does not open the day's agenda.
  const loads = useMemo(() => allLoads.filter((l) => !isLoadVoided(l)), [allLoads])
  const driverName = useMemo(() => new Map(drivers.map((d) => [d.id, d.name])), [drivers])

  const groups = useMemo(() => {
    const ORPHAN = 'Unscheduled'
    const sorted = [...loads].sort((a, b) => (a.pickupAppt ?? '').localeCompare(b.pickupAppt ?? ''))
    const m = new Map<string, Load[]>()
    for (const l of sorted) {
      // The Unscheduled group is a work list; canceled freight is not work.
      const k = l.unscheduled && !isLoadCanceled(l) ? ORPHAN : dayKey(l.pickupAppt)
      const arr = m.get(k)
      if (arr) arr.push(l)
      else m.set(k, [l])
    }
    // Unscheduled group always first.
    return [...m.entries()].sort((a, b) => (a[0] === ORPHAN ? -1 : b[0] === ORPHAN ? 1 : 0))
  }, [loads])

  if (loads.length === 0) {
    return <div style={{ padding: 24, textAlign: 'center', color: 'var(--tms-muted)', fontSize: 13 }}>No loads in this period.</div>
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto' }}>
      {groups.map(([day, ls]) => (
        <div key={day}>
          <div style={{ position: 'sticky', top: 0, zIndex: 1, background: 'var(--tms-bg)', padding: '8px 16px', fontSize: 12, fontWeight: 600, color: 'var(--tms-text-2)', borderBottom: '1px solid var(--tms-border)' }}>
            {day} · {ls.length}
          </div>
          {ls.map((l) => {
            const s = statusOf(l)
            return (
              <button
                key={l.id}
                onClick={() => useAppStore.getState().setSelectedLoad(l.id, 'view')}
                style={{ display: 'block', width: '100%', textAlign: 'left', background: 'var(--tms-card)', border: 'none', borderBottom: '1px solid var(--tms-border)', padding: '12px 16px', cursor: 'pointer' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color, flexShrink: 0 }} />
                  <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--tms-muted)' }}>{fmtTime(l.pickupAppt)}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: s.color }}>{s.label}</span>
                </div>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--tms-text)', marginTop: 4 }}>
                  {l.originCity || l.originName || '—'} → {l.destinationCity || l.destinationName || '—'}
                </div>
                <div style={{ fontSize: 12, color: 'var(--tms-muted)', marginTop: 2 }}>
                  {l.customer || ''}{l.pickupDriverId ? ` · ${driverName.get(l.pickupDriverId) ?? 'Driver'}` : ''}
                </div>
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}
