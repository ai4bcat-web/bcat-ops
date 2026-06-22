import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ClipboardList, ArrowRight, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { useIntakeItems } from '@/hooks/useIntakeItems'
import { TEAM_MEMBERS, ACTIVE_STATUSES } from '@/features/intake/IntakePage'
import { createIntakeItem } from '@/lib/apiClient'
import { cn } from '@/lib/utils'

export function OpenTasksWidget() {
  const { items, loading, refresh } = useIntakeItems()
  const navigate = useNavigate()
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

  return (
    <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm p-6 space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="size-10 rounded-lg flex items-center justify-center bg-violet-50 shrink-0">
          <ClipboardList className="size-5 text-violet-600" />
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-1 text-xs font-medium text-primary hover:text-primary/80 transition-colors"
          >
            <Plus className="size-3.5" /> Add task
          </button>
          <button
            onClick={() => navigate('/tasks')}
            className="flex items-center gap-1 text-xs text-slate-500 hover:text-foreground font-medium transition-colors"
          >
            View all <ArrowRight className="size-3" />
          </button>
        </div>
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

  const inputCls = 'h-9 w-full rounded-md border border-input bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-100 px-6 pt-5 pb-4">
          <h2 className="text-base font-semibold">Add task</h2>
          <button aria-label="Close" onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="size-4" /></button>
        </div>
        <form onSubmit={submit} className="space-y-4 px-6 py-5">
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
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional details" rows={2} className="w-full rounded-md border border-input bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="h-9 rounded-md border border-input px-4 text-sm font-medium text-slate-600 hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={saving || !subject.trim()} className="h-9 rounded-md bg-primary px-4 text-sm font-semibold text-white disabled:opacity-50">
              {saving ? 'Adding…' : 'Add task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
