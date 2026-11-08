import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ClipboardList, ArrowRight, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { useIntakeItems } from '@/hooks/useIntakeItems'
import { TEAM_MEMBERS, ACTIVE_STATUSES } from '@/lib/intake'
import { createIntakeItem } from '@/lib/apiClient'
import { cn } from '@/lib/utils'
import { useAuth } from '@/hooks/useAuth'
import { TmsDialog } from '@/features/tms/kit/TmsDialog'

export function OpenTasksWidget() {
  const { items, loading, refresh } = useIntakeItems()
  const navigate = useNavigate()
  const { hasPageAccess } = useAuth()
  const [showAdd, setShowAdd] = useState(false)

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

  const canTasks = hasPageAccess('tasks')

  return (
    <div className="rounded-xl border border-border bg-card shadow-sm p-6 space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="size-10 rounded-lg flex items-center justify-center bg-[color:var(--tms-badge-purple-tint)] shrink-0">
          <ClipboardList className="size-5 text-[color:var(--tms-badge-purple)]" />
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-1 text-xs font-medium text-primary hover:text-primary/80 transition-colors"
          >
            <Plus className="size-3.5" /> Add task
          </button>
          {canTasks && (
            <button
              onClick={() => navigate('/tasks')}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground font-medium transition-colors"
            >
              View all <ArrowRight className="size-3" />
            </button>
          )}
        </div>
      </div>

      <div>
        <div className={cn(
          'text-3xl font-semibold tracking-tight',
          total > 0 ? 'text-foreground' : 'text-muted-foreground',
        )}>
          {loading ? '—' : total}
        </div>
        <div className="text-sm text-muted-foreground mt-0.5">Open Tasks</div>
      </div>

      {/* Per-assignee rows */}
      {!loading && rows.length > 0 ? (
        <div className="space-y-1.5 pt-1 border-t border-border">
          {rows.map(({ email, name, count }) => {
            const label = (
              <>
                <span className={cn(
                  'text-sm transition-colors',
                  canTasks ? 'text-muted-foreground group-hover:text-foreground' : 'text-muted-foreground',
                )}>
                  {name}
                </span>
                <span className={cn(
                  'text-xs font-bold rounded-full px-1.5 min-w-[20px] h-[20px] flex items-center justify-center',
                  count > 0 ? 'bg-[color:var(--tms-badge-purple-tint)] text-[color:var(--tms-badge-purple)]' : 'bg-muted text-muted-foreground',
                )}>
                  {count}
                </span>
              </>
            )
            return canTasks ? (
              <button
                key={email}
                onClick={() => navigate(email === '__unassigned__' ? '/tasks' : `/tasks?assignee=${encodeURIComponent(email as string)}`)}
                className="w-full flex items-center justify-between px-2 py-1.5 rounded-md hover:bg-muted transition-colors group"
              >
                {label}
              </button>
            ) : (
              <div
                key={email}
                className="w-full flex items-center justify-between px-2 py-1.5 rounded-md"
              >
                {label}
              </div>
            )
          })}
        </div>
      ) : !loading ? (
        <p className="text-xs text-muted-foreground pt-1 border-t border-border">
          No open tasks — all clear!
        </p>
      ) : null}

      {showAdd && <AddTaskModal onClose={() => setShowAdd(false)} onCreated={refresh} />}
    </div>
  )
}

const SOURCES = [
  { value: 'IVAN_CARTAGE', label: 'Ivan Cartage' },
  { value: 'BCAT_LOGISTICS', label: 'BCAT Logistics' },
] as const

function AddTaskModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [subject, setSubject] = useState('')
  const [source, setSource] = useState<'IVAN_CARTAGE' | 'BCAT_LOGISTICS'>('IVAN_CARTAGE')
  const [assignedTo, setAssignedTo] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!subject.trim()) return
    setSaving(true)
    try {
      await createIntakeItem({ source, subject: subject.trim(), assignedTo: assignedTo || null, bodyText: notes.trim() || null })
      toast.success('Task added')
      onCreated()
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not add task')
      setSaving(false)
    }
  }

  const inputCls = 'h-9 w-full rounded-md border border-input bg-card px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20'

  return (
    <TmsDialog open onOpenChange={(o) => { if (!o) onClose() }} title="Add task">
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Task *</label>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="What needs doing?" required autoFocus className={inputCls} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Source</label>
            <select value={source} onChange={(e) => setSource(e.target.value as typeof source)} className={inputCls}>
              {SOURCES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Assignee</label>
            <select value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)} className={inputCls}>
              <option value="">— Unassigned —</option>
              {TEAM_MEMBERS.map((m) => <option key={m.email} value={m.email}>{m.name}</option>)}
            </select>
          </div>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Notes</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional details" rows={2} className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="h-9 rounded-md border border-input px-4 text-sm font-medium text-muted-foreground hover:bg-muted">Cancel</button>
          <button type="submit" disabled={saving || !subject.trim()} className="h-9 rounded-md bg-primary px-4 text-sm font-semibold text-[color:var(--tms-on-primary)] disabled:opacity-50">
            {saving ? 'Adding…' : 'Add task'}
          </button>
        </div>
      </form>
    </TmsDialog>
  )
}
