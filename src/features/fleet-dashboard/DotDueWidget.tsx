import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { ClipboardCheck, ChevronRight, CheckCircle2, Truck, Container } from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'
import { TRUCK_DOC_SPECS, evaluateTruckDoc, addMonthsStr, statusFromExpiration, type DocState } from '@/lib/truckDocs'

const TRAILER_DOT_MONTHS = 12

// Only the states that mean "needs attention", ranked worst-first.
const STATE_META: Partial<Record<DocState, { label: string; bg: string; fg: string; rank: number }>> = {
  EXPIRED:       { label: 'Overdue',      bg: '#fef2f2', fg: '#b91c1c', rank: 0 },
  MISSING:       { label: 'No date',      bg: 'var(--ds-bg)', fg: 'var(--ds-t3)', rank: 1 },
  EXPIRING_SOON: { label: 'Due soon',     bg: '#fffbeb', fg: '#b45309', rank: 2 },
}

function shortDate(d?: string | null): string {
  if (!d) return '—'
  const dt = new Date(`${d}T12:00:00`)
  return isNaN(dt.getTime()) ? d : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

interface Row {
  id: string
  unit: string
  kind: 'truck' | 'trailer'
  state: 'EXPIRED' | 'MISSING' | 'EXPIRING_SOON'
  nextDue: string | null
}

/**
 * DOT inspections that are due soon or overdue across trucks AND trailers. Trucks use the
 * shared `evaluateTruckDoc` (Amazon every 2 mo · Ivan yearly); trailers run a fixed
 * 12-month cadence off their inspection date.
 */
export function DotDueWidget() {
  const equipment = useAppStore((s) => s.equipment)
  const dotSpec = useMemo(() => TRUCK_DOC_SPECS.find((s) => s.dot), [])

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const e of equipment) {
      if (e.active === false) continue
      if (e.type === 'truck' && dotSpec) {
        const { state, expiration } = evaluateTruckDoc(e, dotSpec, undefined)
        if (state === 'EXPIRED' || state === 'MISSING' || state === 'EXPIRING_SOON') {
          out.push({ id: e.id, unit: `#${e.unitNumber}`, kind: 'truck', state, nextDue: expiration })
        }
      } else if (e.type === 'trailer') {
        const nextDue = e.dotInspectionDate ? addMonthsStr(e.dotInspectionDate, TRAILER_DOT_MONTHS) : null
        const state: DocState = e.dotInspectionDate ? statusFromExpiration(nextDue) : 'MISSING'
        if (state === 'EXPIRED' || state === 'MISSING' || state === 'EXPIRING_SOON') {
          out.push({ id: e.id, unit: `#${e.unitNumber}`, kind: 'trailer', state, nextDue })
        }
      }
    }
    return out.sort((a, b) =>
      (STATE_META[a.state]!.rank - STATE_META[b.state]!.rank) ||
      (a.nextDue ?? '9999').localeCompare(b.nextDue ?? '9999'),
    )
  }, [equipment, dotSpec])

  const overdue = rows.filter((r) => r.state === 'EXPIRED').length

  return (
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ClipboardCheck size={16} style={{ color: rows.length ? '#b45309' : 'var(--ds-t3)' }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>DOT Inspections Due / Overdue</div>
            <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 1 }}>
              {rows.length === 0 ? 'All current' : `${rows.length} need${rows.length === 1 ? 's' : ''} attention${overdue ? ` · ${overdue} overdue` : ''}`}
            </div>
          </div>
        </div>
        <Link to="/truck-docs" style={{ fontSize: 12, color: 'var(--ds-blue)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
          Asset Documents <ChevronRight size={13} />
        </Link>
      </div>

      {rows.length === 0 ? (
        <div style={{ padding: '28px 20px', textAlign: 'center', color: 'var(--ds-t3)', fontSize: 13, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
          <CheckCircle2 size={22} style={{ color: '#15803d', opacity: 0.7 }} />
          No DOT inspections due or overdue
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10, padding: 16 }}>
          {rows.map((r) => {
            const meta = STATE_META[r.state]!
            const Icon = r.kind === 'truck' ? Truck : Container
            return (
              <Link key={r.id} to="/truck-docs" style={{ display: 'flex', alignItems: 'center', gap: 10, border: '1px solid var(--ds-border)', borderRadius: 10, padding: '10px 12px', background: 'var(--ds-bg)', textDecoration: 'none' }}>
                <Icon size={15} style={{ color: 'var(--ds-t3)', flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--ds-t1)', fontFamily: 'var(--font-mono)' }}>{r.unit}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--ds-t3)', marginTop: 1 }}>
                    {r.state === 'MISSING' ? 'No DOT on file' : `${r.state === 'EXPIRED' ? 'Was due' : 'Due'} ${shortDate(r.nextDue)}`}
                  </div>
                </div>
                <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 600, padding: '3px 9px', borderRadius: 999, background: meta.bg, color: meta.fg }}>{meta.label}</span>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
