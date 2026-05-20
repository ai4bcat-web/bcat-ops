import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { ClipboardList, ArrowRight } from 'lucide-react'
import { useIntakeItems } from '@/hooks/useIntakeItems'
import { TEAM_MEMBERS, ACTIVE_STATUSES } from '@/features/intake/IntakePage'
import { cn } from '@/lib/utils'

export function OpenTasksWidget() {
  const { items, loading } = useIntakeItems()
  const navigate = useNavigate()

  const openTasks = useMemo(() =>
    items.filter((i) => ACTIVE_STATUSES.has(i.status)),
    [items],
  )

  const byAssignee = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const item of openTasks) {
      const key = item.assignedTo ?? '__unassigned__'
      counts[key] = (counts[key] ?? 0) + 1
    }
    return counts
  }, [openTasks])

  const rows = useMemo(() => {
    const result: { email: string; name: string; count: number }[] = TEAM_MEMBERS.map((m) => ({
      email: m.email as string,
      name:  m.name  as string,
      count: byAssignee[m.email] ?? 0,
    }))
    const unassigned = byAssignee['__unassigned__'] ?? 0
    if (unassigned > 0) result.push({ email: '__unassigned__', name: 'Unassigned', count: unassigned })
    return result.filter((r) => r.count > 0)
  }, [byAssignee])

  const total = openTasks.length

  return (
    <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm p-6 space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="size-10 rounded-lg flex items-center justify-center bg-violet-50 shrink-0">
          <ClipboardList className="size-5 text-violet-600" />
        </div>
        <button
          onClick={() => navigate('/tasks')}
          className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 font-medium transition-colors"
        >
          View all <ArrowRight className="size-3" />
        </button>
      </div>

      <div>
        <div className={cn(
          'text-3xl font-semibold tracking-tight',
          total > 0 ? 'text-foreground' : 'text-slate-400',
        )}>
          {loading ? '—' : total}
        </div>
        <div className="text-sm text-slate-500 mt-0.5">Open Tasks</div>
      </div>

      {/* Per-assignee rows */}
      {!loading && rows.length > 0 ? (
        <div className="space-y-1.5 pt-1 border-t border-slate-100">
          {rows.map(({ email, name, count }) => (
            <button
              key={email}
              onClick={() => navigate(email === '__unassigned__' ? '/tasks' : `/tasks?assignee=${encodeURIComponent(email as string)}`)}
              className="w-full flex items-center justify-between px-2 py-1.5 rounded-md hover:bg-slate-50 transition-colors group"
            >
              <span className="text-sm text-slate-600 group-hover:text-foreground transition-colors">
                {name}
              </span>
              <span className={cn(
                'text-xs font-bold rounded-full px-1.5 min-w-[20px] h-[20px] flex items-center justify-center',
                count > 0 ? 'bg-violet-100 text-violet-700' : 'bg-slate-100 text-slate-400',
              )}>
                {count}
              </span>
            </button>
          ))}
        </div>
      ) : !loading ? (
        <p className="text-xs text-slate-400 pt-1 border-t border-slate-100">
          No open tasks — all clear!
        </p>
      ) : null}
    </div>
  )
}
