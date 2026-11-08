import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Wrench, ChevronRight } from 'lucide-react'
import { TmsBadge } from '@/features/tms/kit/TmsBadge'
import type { TmsTone } from '@/features/tms/kit/TmsBadge'
import { TmsEmptyState } from '@/features/tms/kit/TmsEmptyState'
import { useAppStore } from '@/store/useAppStore'
import { useAuth } from '@/hooks/useAuth'
import type { TaskPriority } from '@/types/equipment'

const PRIORITY_META: Record<TaskPriority, { label: string; tone: TmsTone; rank: number }> = {
  high: { label: 'High', tone: 'red', rank: 0 },
  med:  { label: 'Med',  tone: 'orange', rank: 1 },
  low:  { label: 'Low',  tone: 'blue', rank: 2 },
}

const todayStr = () => {
  const n = new Date()
  const pad = (x: number) => String(x).padStart(2, '0')
  return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`
}

function shortDate(d?: string): string {
  if (!d) return 'No due date'
  const dt = new Date(`${d}T12:00:00`)
  return isNaN(dt.getTime()) ? d : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/**
 * Open (upcoming) maintenance tasks across the fleet — high priority and overdue first.
 * Sources the same maintenanceTasks as the Maintenance page (not operations/intake tasks).
 */
export function MaintenanceTasksWidget() {
  const { hasPageAccess } = useAuth()
  const canMaintenance = hasPageAccess('maintenance')
  const tasks = useAppStore((s) => s.maintenanceTasks)
  const equipment = useAppStore((s) => s.equipment)
  const today = todayStr()

  const unitOf = useMemo(() => {
    const m = new Map(equipment.map((e) => [e.id, e]))
    return (id: string) => {
      const e = m.get(id)
      return e ? `#${e.unitNumber}` : '—'
    }
  }, [equipment])

  const open = useMemo(
    () => tasks
      .filter((t) => t.status === 'upcoming')
      .sort((a, b) => {
        const aOver = (a.dueDate ?? '9999') < today ? 0 : 1
        const bOver = (b.dueDate ?? '9999') < today ? 0 : 1
        return aOver - bOver
          || PRIORITY_META[a.priority].rank - PRIORITY_META[b.priority].rank
          || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999')
      }),
    [tasks, today],
  )
  const shown = open.slice(0, 7)

  return (
    <div style={{ background: 'var(--tms-card)', border: '1px solid var(--tms-border)', borderRadius: 12, boxShadow: 'var(--tms-shadow)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--tms-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Wrench size={16} style={{ color: 'var(--tms-muted)' }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--tms-text)' }}>Open Maintenance Tasks</div>
            <div style={{ fontSize: 12, color: 'var(--tms-muted)', marginTop: 1 }}>{open.length} open</div>
          </div>
        </div>
        {canMaintenance && (
          <Link to="/maintenance" style={{ fontSize: 12, color: 'var(--tms-primary)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
            View all <ChevronRight size={13} />
          </Link>
        )}
      </div>

      {shown.length === 0 ? (
        <TmsEmptyState compact title="No open maintenance tasks" message={null} />
      ) : (
        <div style={{ maxHeight: 320, overflowY: 'auto' }}>
          {shown.map((t) => {
            const meta = PRIORITY_META[t.priority]
            const overdue = (t.dueDate ?? '') !== '' && t.dueDate! < today
            const body = (
              <>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--tms-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--tms-text-2)' }}>{unitOf(t.equipmentId)}</span> · {t.title}
                  </div>
                  <div style={{ fontSize: 12, color: overdue ? 'var(--tms-badge-red)' : 'var(--tms-muted)', marginTop: 1, fontWeight: overdue ? 600 : 400 }}>
                    {overdue ? 'Overdue · ' : ''}{shortDate(t.dueDate)}
                  </div>
                </div>
                <TmsBadge tone={meta.tone} style={{ flexShrink: 0 }}>{meta.label}</TmsBadge>
              </>
            )
            return canMaintenance ? (
              <Link
                key={t.id}
                to="/maintenance"
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 20px', borderBottom: '1px solid var(--tms-border)', textDecoration: 'none' }}
              >
                {body}
              </Link>
            ) : (
              <div
                key={t.id}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 20px', borderBottom: '1px solid var(--tms-border)' }}
              >
                {body}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
