import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { ClipboardCheck, ChevronRight, Truck, Container } from 'lucide-react'
import { TmsBadge } from '@/features/tms/kit/TmsBadge'
import type { TmsTone } from '@/features/tms/kit/TmsBadge'
import { TmsEmptyState } from '@/features/tms/kit/TmsEmptyState'
import { useAppStore } from '@/store/useAppStore'
import { useAuth } from '@/hooks/useAuth'
import { TRUCK_DOC_SPECS, evaluateTruckDoc, addMonthsStr, statusFromExpiration, type DocState } from '@/lib/truckDocs'

const TRAILER_DOT_MONTHS = 12

// Only the states that mean "needs attention", ranked worst-first.
const STATE_META: Partial<Record<DocState, { label: string; tone: TmsTone; rank: number }>> = {
  EXPIRED:       { label: 'Overdue',      tone: 'red', rank: 0 },
  MISSING:       { label: 'No date',      tone: 'gray', rank: 1 },
  EXPIRING_SOON: { label: 'Due soon',     tone: 'orange', rank: 2 },
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
  const { hasPageAccess } = useAuth()
  const canTruckDocs = hasPageAccess('truckDocs')
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
    <div style={{ background: 'var(--tms-card)', border: '1px solid var(--tms-border)', borderRadius: 12, boxShadow: 'var(--tms-shadow)', overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--tms-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ClipboardCheck size={16} style={{ color: rows.length ? 'var(--tms-badge-orange)' : 'var(--tms-muted)' }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--tms-text)' }}>DOT Inspections Due / Overdue</div>
            <div style={{ fontSize: 12, color: 'var(--tms-muted)', marginTop: 1 }}>
              {rows.length === 0 ? 'All current' : `${rows.length} need${rows.length === 1 ? 's' : ''} attention${overdue ? ` · ${overdue} overdue` : ''}`}
            </div>
          </div>
        </div>
        {canTruckDocs && (
          <Link to="/truck-docs" style={{ fontSize: 12, color: 'var(--tms-primary)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
            Asset Documents <ChevronRight size={13} />
          </Link>
        )}
      </div>

      {rows.length === 0 ? (
        <TmsEmptyState compact title="No DOT inspections due or overdue" message={null} />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10, padding: 16 }}>
          {rows.map((r) => {
            const meta = STATE_META[r.state]!
            const Icon = r.kind === 'truck' ? Truck : Container
            const row = (
              <>
                <Icon size={15} style={{ color: 'var(--tms-muted)', flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--tms-text)', fontFamily: 'var(--font-mono)' }}>{r.unit}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--tms-muted)', marginTop: 1 }}>
                    {r.state === 'MISSING' ? 'No DOT on file' : `${r.state === 'EXPIRED' ? 'Was due' : 'Due'} ${shortDate(r.nextDue)}`}
                  </div>
                </div>
                <TmsBadge tone={meta.tone} style={{ flexShrink: 0 }}>{meta.label}</TmsBadge>
              </>
            )
            return canTruckDocs ? (
              <Link key={r.id} to="/truck-docs" style={{ display: 'flex', alignItems: 'center', gap: 10, border: '1px solid var(--tms-border)', borderRadius: 10, padding: '10px 12px', background: 'var(--tms-bg)', textDecoration: 'none' }}>
                {row}
              </Link>
            ) : (
              <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, border: '1px solid var(--tms-border)', borderRadius: 10, padding: '10px 12px', background: 'var(--tms-bg)' }}>
                {row}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
