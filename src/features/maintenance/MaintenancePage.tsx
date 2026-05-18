import { useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table'
import {
  CheckCircle2, AlertTriangle, Clock, Wrench, FileText, Trash2, Pencil, X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { MaintenanceTask, TaskPriority, TaskStatus } from '@/types/equipment'

// ── Helpers ───────────────────────────────────────────────────────────────────

type DueState = 'overdue' | 'today' | 'soon' | 'ok' | 'none'

function dueState(dateStr?: string): DueState {
  if (!dateStr) return 'none'
  const days = Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86400000)
  if (days < 0)  return 'overdue'
  if (days === 0) return 'today'
  if (days <= 7) return 'soon'
  return 'ok'
}

function formatCents(cents: number) {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function priorityBadge(p: TaskPriority) {
  return p === 'high'
    ? <Badge variant="secondary" className="bg-red-50 text-red-700 border-red-200 text-xs">High</Badge>
    : p === 'med'
    ? <Badge variant="secondary" className="bg-amber-50 text-amber-700 border-amber-200 text-xs">Med</Badge>
    : <Badge variant="secondary" className="bg-slate-50 text-slate-600 border-slate-200 text-xs">Low</Badge>
}

function DueBadge({ date }: { date?: string }) {
  const state = dueState(date)
  if (!date) return <span className="text-xs text-slate-400">—</span>
  const styles: Record<DueState, string> = {
    overdue: 'text-red-700 bg-red-50 border-red-200',
    today:   'text-amber-700 bg-amber-50 border-amber-200',
    soon:    'text-amber-700 bg-amber-50 border-amber-200',
    ok:      'text-slate-600 bg-white border-slate-200',
    none:    '',
  }
  const icon: Record<DueState, React.ReactNode> = {
    overdue: <AlertTriangle className="size-3" />,
    today:   <Clock className="size-3" />,
    soon:    <Clock className="size-3" />,
    ok:      null,
    none:    null,
  }
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border', styles[state])}>
      {icon[state]}{date}
    </span>
  )
}

// ── Quick Edit Task Modal ──────────────────────────────────────────────────────

function EditTaskModal({ task, onSave, onClose }: { task: MaintenanceTask; onSave: (patch: Partial<MaintenanceTask>) => void; onClose: () => void }) {
  const [form, setForm] = useState({
    title:    task.title,
    dueDate:  task.dueDate ?? '',
    priority: task.priority as TaskPriority,
    status:   task.status as TaskStatus,
    assignee: task.assignee ?? '',
    notes:    task.notes ?? '',
  })
  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-slate-100">
          <h2 className="text-base font-semibold">Edit Task</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="size-4" /></button>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); onSave({ ...form, dueDate: form.dueDate || undefined, notes: form.notes || undefined, assignee: form.assignee || undefined }); onClose() }} className="px-6 py-5 space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Task</label>
            <Input value={form.title} onChange={(e) => set('title', e.target.value)} required className="h-9" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Due Date</label>
              <Input type="date" value={form.dueDate} onChange={(e) => set('dueDate', e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Priority</label>
              <select className="h-9 w-full rounded-md border border-slate-200 px-3 text-sm bg-white" value={form.priority} onChange={(e) => set('priority', e.target.value)}>
                <option value="high">High</option>
                <option value="med">Medium</option>
                <option value="low">Low</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Status</label>
              <select className="h-9 w-full rounded-md border border-slate-200 px-3 text-sm bg-white" value={form.status} onChange={(e) => set('status', e.target.value)}>
                <option value="upcoming">Upcoming</option>
                <option value="complete">Complete</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Assignee</label>
              <select className="h-9 w-full rounded-md border border-slate-200 px-3 text-sm bg-white" value={form.assignee} onChange={(e) => set('assignee', e.target.value)}>
                <option value="">— None —</option>
                <option value="jason">Jason</option>
                <option value="ryne">Ryne</option>
              </select>
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit">Save</Button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

type Tab = 'tasks' | 'invoices'

export function MaintenancePage() {
  const equipment            = useAppStore((s) => s.equipment)
  const maintenanceTasks     = useAppStore((s) => s.maintenanceTasks)
  const maintenanceInvoices  = useAppStore((s) => s.maintenanceInvoices)
  const updateMaintenanceTask   = useAppStore((s) => s.updateMaintenanceTask)
  const deleteMaintenanceTask   = useAppStore((s) => s.deleteMaintenanceTask)
  const deleteMaintenanceInvoice = useAppStore((s) => s.deleteMaintenanceInvoice)

  const [tab, setTab]               = useState<Tab>('tasks')
  const [statusFilter, setStatus]   = useState<'all' | 'upcoming' | 'complete'>('upcoming')
  const [priorityFilter, setPriority] = useState<'all' | TaskPriority>('all')
  const [equipFilter, setEquipFilter] = useState('')
  const [search, setSearch]         = useState('')
  const [editTask, setEditTask]     = useState<MaintenanceTask | null>(null)

  function equipName(id: string) {
    const e = equipment.find((eq) => eq.id === id)
    return e ? `#${e.unitNumber}${e.nickname ? ` · ${e.nickname}` : ''}` : id
  }

  // Tasks filtering
  const filteredTasks = maintenanceTasks.filter((t) => {
    if (statusFilter !== 'all' && t.status !== statusFilter) return false
    if (priorityFilter !== 'all' && t.priority !== priorityFilter) return false
    if (equipFilter && t.equipmentId !== equipFilter) return false
    if (search) {
      const q = search.toLowerCase()
      return t.title.toLowerCase().includes(q) || equipName(t.equipmentId).toLowerCase().includes(q)
    }
    return true
  }).sort((a, b) => {
    if (a.status !== b.status) return a.status === 'upcoming' ? -1 : 1
    return (a.dueDate ?? '') < (b.dueDate ?? '') ? -1 : 1
  })

  // Invoices filtering
  const filteredInvoices = maintenanceInvoices.filter((inv) => {
    if (equipFilter && inv.equipmentId !== equipFilter) return false
    if (search) {
      const q = search.toLowerCase()
      return (
        (inv.vendor ?? '').toLowerCase().includes(q) ||
        (inv.description ?? '').toLowerCase().includes(q) ||
        equipName(inv.equipmentId).toLowerCase().includes(q)
      )
    }
    return true
  }).sort((a, b) => ((b.date ?? '') < (a.date ?? '') ? -1 : 1))

  const overdueCount  = maintenanceTasks.filter((t) => t.status === 'upcoming' && dueState(t.dueDate) === 'overdue').length
  const upcomingCount = maintenanceTasks.filter((t) => t.status === 'upcoming').length
  const totalSpend    = maintenanceInvoices.reduce((s, i) => s + i.amount, 0)

  return (
    <div className="h-full overflow-auto">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-white border-b border-slate-200">
        <div className="flex items-center justify-between px-8 pt-5 pb-3">
          <div>
            <h1 className="text-2xl font-semibold text-foreground tracking-tight">Maintenance</h1>
            <p className="text-sm text-slate-500 mt-0.5">Tasks, compliance & repair history</p>
          </div>
        </div>

        {/* KPIs */}
        <div className="flex items-center gap-3 px-8 pb-4 overflow-x-auto">
          <div className="ds-kpi"><div className="ds-kpi-label">Open Tasks</div><div className="ds-kpi-value">{upcomingCount}</div></div>
          <div className="ds-kpi"><div className="ds-kpi-label">Overdue</div><div className="ds-kpi-value red">{overdueCount}</div></div>
          <div className="ds-kpi"><div className="ds-kpi-label">Completed</div><div className="ds-kpi-value green">{maintenanceTasks.filter((t) => t.status === 'complete').length}</div></div>
          <div className="ds-kpi"><div className="ds-kpi-label">Invoice Total</div><div className="ds-kpi-value">{formatCents(totalSpend)}</div></div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-200 px-8 gap-0">
          {([['tasks', 'Tasks', Wrench], ['invoices', 'Invoice History', FileText]] as [Tab, string, React.ElementType][]).map(([key, label, Icon]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={cn(
                'flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors',
                tab === key
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              )}
            >
              <Icon className="size-3.5" />{label}
            </button>
          ))}
        </div>
      </div>

      <div className="p-8 max-w-5xl space-y-5">
        {/* Filters */}
        <div className="flex items-center gap-3 flex-wrap">
          <Input
            placeholder="Search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 w-52"
          />
          <select
            className="h-9 rounded-md border border-slate-200 px-3 text-sm bg-white"
            value={equipFilter}
            onChange={(e) => setEquipFilter(e.target.value)}
          >
            <option value="">All Equipment</option>
            {equipment.map((e) => (
              <option key={e.id} value={e.id}>#{e.unitNumber}{e.nickname ? ` · ${e.nickname}` : ''}</option>
            ))}
          </select>
          {tab === 'tasks' && (
            <>
              <select className="h-9 rounded-md border border-slate-200 px-3 text-sm bg-white" value={statusFilter} onChange={(e) => setStatus(e.target.value as typeof statusFilter)}>
                <option value="all">All Statuses</option>
                <option value="upcoming">Upcoming</option>
                <option value="complete">Complete</option>
              </select>
              <select className="h-9 rounded-md border border-slate-200 px-3 text-sm bg-white" value={priorityFilter} onChange={(e) => setPriority(e.target.value as typeof priorityFilter)}>
                <option value="all">All Priorities</option>
                <option value="high">High</option>
                <option value="med">Medium</option>
                <option value="low">Low</option>
              </select>
            </>
          )}
        </div>

        {/* Tasks Tab */}
        {tab === 'tasks' && (
          <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm overflow-hidden">
            {filteredTasks.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-2 text-muted-foreground">
                <Wrench className="size-8 opacity-20" />
                <p className="text-sm">No tasks found.</p>
                <p className="text-xs text-slate-400">Add tasks from the Fleet page on individual equipment.</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-8"></TableHead>
                    <TableHead>Task</TableHead>
                    <TableHead>Equipment</TableHead>
                    <TableHead>Due</TableHead>
                    <TableHead>Priority</TableHead>
                    <TableHead>Assignee</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-20"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredTasks.map((t) => (
                    <TableRow key={t.id} className={cn(t.status === 'complete' && 'opacity-50')}>
                      <TableCell>
                        <button
                          onClick={() => updateMaintenanceTask(t.id, { status: t.status === 'complete' ? 'upcoming' : 'complete' })}
                          className={cn('transition-colors', t.status === 'complete' ? 'text-emerald-500' : 'text-slate-300 hover:text-emerald-400')}
                        >
                          <CheckCircle2 className="size-4" />
                        </button>
                      </TableCell>
                      <TableCell>
                        <span className={cn('text-sm font-medium', t.status === 'complete' && 'line-through')}>{t.title}</span>
                        {t.notes && <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-[200px]">{t.notes}</p>}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{equipName(t.equipmentId)}</TableCell>
                      <TableCell><DueBadge date={t.dueDate} /></TableCell>
                      <TableCell>{priorityBadge(t.priority)}</TableCell>
                      <TableCell className="text-sm text-muted-foreground capitalize">{t.assignee || '—'}</TableCell>
                      <TableCell>
                        {t.status === 'complete'
                          ? <Badge variant="secondary" className="bg-emerald-50 text-emerald-700 border-emerald-200 text-xs">Complete</Badge>
                          : <Badge variant="secondary" className="bg-blue-50 text-blue-700 border-blue-200 text-xs">Upcoming</Badge>}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setEditTask(t)}>
                            <Pencil className="size-3.5" />
                          </Button>
                          <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive hover:bg-destructive/5" onClick={() => deleteMaintenanceTask(t.id)}>
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        )}

        {/* Invoices Tab */}
        {tab === 'invoices' && (
          <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm overflow-hidden">
            {filteredInvoices.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-2 text-muted-foreground">
                <FileText className="size-8 opacity-20" />
                <p className="text-sm">No invoices found.</p>
                <p className="text-xs text-slate-400">Add invoices from the Fleet page on individual equipment.</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Date</TableHead>
                    <TableHead>Equipment</TableHead>
                    <TableHead>Vendor</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead>Invoice #</TableHead>
                    <TableHead>Payment</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="w-10"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredInvoices.map((inv) => (
                    <TableRow key={inv.id}>
                      <TableCell className="text-sm text-muted-foreground">{inv.date || '—'}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{equipName(inv.equipmentId)}</TableCell>
                      <TableCell className="text-sm font-medium">{inv.vendor || '—'}</TableCell>
                      <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate">{inv.description || '—'}</TableCell>
                      <TableCell className="text-xs font-mono text-muted-foreground">{inv.invoiceNumber || '—'}</TableCell>
                      <TableCell className="text-sm text-muted-foreground capitalize">
                        {inv.paymentMethod || '—'}
                        {inv.paymentDate && <span className="text-xs ml-1 text-slate-400">{inv.paymentDate}</span>}
                      </TableCell>
                      <TableCell className="text-right text-sm font-semibold text-foreground">{formatCents(inv.amount)}</TableCell>
                      <TableCell>
                        <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive hover:bg-destructive/5" onClick={() => deleteMaintenanceInvoice(inv.id)}>
                          <Trash2 className="size-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <tfoot>
                  <tr className="border-t border-slate-100 bg-slate-50/60">
                    <td colSpan={6} className="px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Total</td>
                    <td className="px-4 py-3 text-right text-sm font-bold text-foreground">
                      {formatCents(filteredInvoices.reduce((s, i) => s + i.amount, 0))}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </Table>
            )}
          </div>
        )}
      </div>

      {editTask && (
        <EditTaskModal
          task={editTask}
          onSave={(patch) => updateMaintenanceTask(editTask.id, patch)}
          onClose={() => setEditTask(null)}
        />
      )}
    </div>
  )
}
