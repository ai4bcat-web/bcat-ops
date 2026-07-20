import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Wrench, ChevronRight, CheckCircle2 } from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'
import type { TaskPriority } from '@/types/equipment'

const PRIORITY_META: Record<TaskPriority, { label: string; bg: string; fg: string; rank: number }> = {
  high: { label: 'High', bg: '#fef2f2', fg: '#b91c1c', rank: 0 },
  med:  { label: 'Med',  bg: '#fffbeb', fg: '#b45309', rank: 1 },
  low:  { label: 'Low',  bg: '#eff6ff', fg: '#1d4ed8', rank: 2 },
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
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Wrench size={16} style={{ color: 'var(--ds-t3)' }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>Open Maintenance Tasks</div>
            <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 1 }}>{open.length} open</div>
          </div>
        </div>
        <Link to="/maintenance" style={{ fontSize: 12, color: 'var(--ds-blue)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
          View all <ChevronRight size={13} />
        </Link>
      </div>

      {shown.length === 0 ? (
        <div style={{ padding: '32px 20px', textAlign: 'center', color: 'var(--ds-t3)', fontSize: 13, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
          <CheckCircle2 size={22} style={{ color: '#15803d', opacity: 0.7 }} />
          No open maintenance tasks
        </div>
      ) : (
        <div style={{ maxHeight: 320, overflowY: 'auto' }}>
          {shown.map((t) => {
            const meta = PRIORITY_META[t.priority]
            const overdue = (t.dueDate ?? '') !== '' && t.dueDate! < today
            return (
              <Link
                key={t.id}
                to="/maintenance"
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 20px', borderBottom: '1px solid var(--ds-border)', textDecoration: 'none' }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--ds-t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--ds-t2)' }}>{unitOf(t.equipmentId)}</span> · {t.title}
                  </div>
                  <div style={{ fontSize: 12, color: overdue ? '#dc2626' : 'var(--ds-t3)', marginTop: 1, fontWeight: overdue ? 600 : 400 }}>
                    {overdue ? 'Overdue · ' : ''}{shortDate(t.dueDate)}
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
