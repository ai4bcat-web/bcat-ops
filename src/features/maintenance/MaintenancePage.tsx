import { useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table'
import {
  CheckCircle2, AlertTriangle, Clock, Wrench, FileText, Trash2, Pencil, X, Plus, Search,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Equipment, MaintenanceTask, MaintenanceInvoice, TaskPriority, TaskStatus } from '@/types/equipment'

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

function priorityDot(color: string) {
  return <span className="inline-block size-1.5 rounded-full mr-1 shrink-0" style={{ background: color }} />
}

function priorityBadge(p: TaskPriority) {
  return p === 'high'
    ? <Badge variant="secondary" className="bg-red-50 text-red-700 border-red-200 text-xs">{priorityDot('#dc2626')}High</Badge>
    : p === 'med'
    ? <Badge variant="secondary" className="bg-amber-50 text-amber-700 border-amber-200 text-xs">{priorityDot('#d97706')}Med</Badge>
    : <Badge variant="secondary" className="bg-slate-50 text-slate-600 border-slate-200 text-xs">{priorityDot('#94a3b8')}Low</Badge>
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
    <span className={cn('inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border', state === 'overdue' ? 'font-bold' : 'font-medium', styles[state])}>
      {icon[state]}{date}
    </span>
  )
}

// ── Task Modal (create + edit) ──────────────────────────────────────────────────

type TaskData = Omit<MaintenanceTask, 'id' | 'createdAt' | 'updatedAt'>

function TaskModal({ task, equipment, onSave, onClose }: { task: MaintenanceTask | null; equipment: Equipment[]; onSave: (data: TaskData) => void; onClose: () => void }) {
  const isEdit = task !== null
  const [form, setForm] = useState({
    equipmentId: task?.equipmentId ?? (equipment[0]?.id ?? ''),
    title:    task?.title ?? '',
    dueDate:  task?.dueDate ?? '',
    priority: (task?.priority ?? 'med') as TaskPriority,
    status:   (task?.status ?? 'upcoming') as TaskStatus,
    assignee: task?.assignee ?? '',
    notes:    task?.notes ?? '',
  })
  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }))

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.equipmentId) return
    onSave({
      equipmentId: form.equipmentId,
      title: form.title.trim(),
      dueDate: form.dueDate || undefined,
      priority: form.priority,
      status: form.status,
      assignee: form.assignee || undefined,
      notes: form.notes || undefined,
      autoDot: task?.autoDot ?? false,
    })
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-slate-100">
          <h2 className="text-base font-semibold">{isEdit ? 'Edit Task' : 'New Task'}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="size-4" /></button>
        </div>
        <form onSubmit={submit} className="px-6 py-5 space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Equipment</label>
            <select className="h-9 w-full rounded-md border border-slate-200 px-3 text-sm bg-white" value={form.equipmentId} onChange={(e) => set('equipmentId', e.target.value)} disabled={isEdit} required>
              <option value="" disabled>Select equipment…</option>
              {equipment.map((eq) => (
                <option key={eq.id} value={eq.id}>#{eq.unitNumber}{eq.nickname ? ` · ${eq.nickname}` : ''}</option>
              ))}
            </select>
          </div>
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
          <div className="flex justify-end gap-3 pt-4">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit">Save</Button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Invoice Modal (create) ──────────────────────────────────────────────────────

type InvoiceData = Omit<MaintenanceInvoice, 'id' | 'createdAt' | 'updatedAt'>

function InvoiceModal({ equipment, onSave, onClose }: { equipment: Equipment[]; onSave: (data: InvoiceData) => void; onClose: () => void }) {
  const [form, setForm] = useState({
    equipmentId: equipment[0]?.id ?? '',
    date: '', vendor: '', description: '', amount: '',
    invoiceNumber: '', paymentMethod: '', paymentDate: '', assignee: '',
  })
  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }))

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.equipmentId) return
    onSave({
      equipmentId: form.equipmentId,
      date: form.date || undefined,
      vendor: form.vendor.trim() || undefined,
      description: form.description.trim() || undefined,
      amount: Math.round(parseFloat(form.amount || '0') * 100),
      invoiceNumber: form.invoiceNumber.trim() || undefined,
      paymentMethod: form.paymentMethod || undefined,
      paymentDate: form.paymentDate || undefined,
      assignee: form.assignee || undefined,
    })
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-slate-100">
          <h2 className="text-base font-semibold">New Invoice</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="size-4" /></button>
        </div>
        <form onSubmit={submit} className="px-6 py-5 space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Equipment</label>
            <select className="h-9 w-full rounded-md border border-slate-200 px-3 text-sm bg-white" value={form.equipmentId} onChange={(e) => set('equipmentId', e.target.value)} required>
              <option value="" disabled>Select equipment…</option>
              {equipment.map((eq) => (
                <option key={eq.id} value={eq.id}>#{eq.unitNumber}{eq.nickname ? ` · ${eq.nickname}` : ''}</option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Date</label>
              <Input type="date" value={form.date} onChange={(e) => set('date', e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Amount ($)</label>
              <Input type="number" step="0.01" min="0" value={form.amount} onChange={(e) => set('amount', e.target.value)} placeholder="0.00" required className="h-9" />
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Vendor</label>
            <Input value={form.vendor} onChange={(e) => set('vendor', e.target.value)} placeholder="Shop / vendor name" className="h-9" />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Description</label>
            <Input value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="What was done" className="h-9" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Invoice #</label>
              <Input value={form.invoiceNumber} onChange={(e) => set('invoiceNumber', e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Payment Method</label>
              <Input value={form.paymentMethod} onChange={(e) => set('paymentMethod', e.target.value)} placeholder="Card / check / cash" className="h-9" />
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-4">
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
  const addMaintenanceTask       = useAppStore((s) => s.addMaintenanceTask)
  const updateMaintenanceTask    = useAppStore((s) => s.updateMaintenanceTask)
  const deleteMaintenanceTask    = useAppStore((s) => s.deleteMaintenanceTask)
  const addMaintenanceInvoice    = useAppStore((s) => s.addMaintenanceInvoice)
  const deleteMaintenanceInvoice = useAppStore((s) => s.deleteMaintenanceInvoice)

  const [tab, setTab]                 = useState<Tab>('tasks')
  const [statusFilter, setStatus]     = useState<'all' | 'upcoming' | 'complete'>('upcoming')
  const [priorityFilter, setPriority] = useState<'all' | TaskPriority>('all')
  const [equipFilter, setEquipFilter] = useState('')
  const [search, setSearch]           = useState('')
  const [editTask, setEditTask]       = useState<MaintenanceTask | null>(null)
  const [newTaskOpen, setNewTaskOpen] = useState(false)
  const [newInvoiceOpen, setNewInvoiceOpen] = useState(false)

  function equipName(id: string) {
    const e = equipment.find((eq) => eq.id === id)
    return e ? `#${e.unitNumber}${e.nickname ? ` · ${e.nickname}` : ''}` : id
  }

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

  const overdueCount   = maintenanceTasks.filter((t) => t.status === 'upcoming' && dueState(t.dueDate) === 'overdue').length
  const upcomingCount  = maintenanceTasks.filter((t) => t.status === 'upcoming').length
  const completedCount = maintenanceTasks.filter((t) => t.status === 'complete').length
  const totalSpend     = maintenanceInvoices.reduce((s, i) => s + i.amount, 0)

  const MAINT_KPIS = [
    { label: 'Open Tasks',    value: upcomingCount,           color: '#1ea8f3' },
    { label: 'Overdue',       value: overdueCount,            color: '#ef4444' },
    { label: 'Completed',     value: completedCount,          color: '#22c55e' },
    { label: 'Invoice Total', value: formatCents(totalSpend), color: '#a78bfa' },
  ]

  const TABS_LIST = [
    { key: 'tasks' as const,    label: 'Tasks',           Icon: Wrench },
    { key: 'invoices' as const, label: 'Invoice History', Icon: FileText },
  ]

  const selectStyle: React.CSSProperties = {
    height: 34, padding: '0 10px', background: 'var(--ds-surface)',
    border: '1px solid var(--ds-border)', borderRadius: 7,
    fontSize: 12.5, color: 'var(--ds-t1)', fontFamily: 'inherit', outline: 'none',
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--ds-bg)' }}>

      {/* ── Page header ──────────────────────────────────────────────────── */}
      <div style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--ds-surface)', borderBottom: '1px solid var(--ds-border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 32px 12px' }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--ds-t1)', margin: 0 }}>Maintenance</h1>
            <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 2 }}>Tasks, compliance &amp; repair history</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={{ display: 'flex', alignItems: 'center', gap: 6, height: 34, padding: '0 14px', background: 'var(--ds-bg)', border: '1px solid var(--ds-border)', borderRadius: 8, fontSize: 13, fontWeight: 500, color: 'var(--ds-t2)', cursor: 'pointer', fontFamily: 'inherit' }}>
              Export
            </button>
            <button
              onClick={() => (tab === 'tasks' ? setNewTaskOpen(true) : setNewInvoiceOpen(true))}
              disabled={equipment.length === 0}
              title={equipment.length === 0 ? 'Add equipment in Fleet first' : undefined}
              style={{ display: 'flex', alignItems: 'center', gap: 6, height: 34, padding: '0 14px', background: 'var(--ds-blue)', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, color: '#fff', cursor: equipment.length === 0 ? 'not-allowed' : 'pointer', opacity: equipment.length === 0 ? 0.5 : 1, fontFamily: 'inherit' }}
            >
              <Plus size={14} /> {tab === 'tasks' ? 'New Task' : 'New Invoice'}
            </button>
          </div>
        </div>

        {/* KPI strip — left-border accent */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, padding: '0 32px 12px' }}>
          {MAINT_KPIS.map((k) => (
            <div key={k.label} style={{ position: 'relative', overflow: 'hidden', background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 10, padding: '12px 16px' }}>
              <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: k.color }} />
              <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--ds-t3)', letterSpacing: '0.03em', textTransform: 'uppercase', marginLeft: 4 }}>{k.label}</div>
              <div style={{ fontSize: 28, fontWeight: 600, color: k.color, letterSpacing: '-0.02em', marginTop: 4, marginLeft: 4, fontVariantNumeric: 'tabular-nums' }}>{k.value}</div>
            </div>
          ))}
        </div>

        {/* Tab bar */}
        <div style={{ display: 'flex', padding: '0 32px', gap: 0 }}>
          {TABS_LIST.map(({ key, label, Icon }) => {
            const active = tab === key
            return (
              <button
                key={key}
                onClick={() => setTab(key)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '10px 16px', fontSize: 13, fontWeight: 500, cursor: 'pointer',
                  background: 'none', border: 'none', fontFamily: 'inherit',
                  borderBottom: `2px solid ${active ? 'var(--ds-blue)' : 'transparent'}`,
                  color: active ? 'var(--ds-blue)' : 'var(--ds-t3)',
                  marginBottom: -1,
                }}
              >
                <Icon size={13} />{label}
              </button>
            )
          })}
        </div>
      </div>

      <div style={{ padding: '24px 32px', maxWidth: 1100 }}>
        {/* Filters */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
          <div style={{ position: 'relative' }}>
            <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--ds-t3)', pointerEvents: 'none' }} />
            <input
              type="text"
              placeholder="Search…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{
                width: 200, height: 34, paddingLeft: 30, paddingRight: 10, boxSizing: 'border-box',
                background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 7,
                fontSize: 12.5, color: 'var(--ds-t1)', fontFamily: 'inherit', outline: 'none',
              }}
            />
          </div>
          <select value={equipFilter} onChange={(e) => setEquipFilter(e.target.value)} style={selectStyle}>
            <option value="">All Equipment</option>
            {equipment.map((e) => (
              <option key={e.id} value={e.id}>#{e.unitNumber}{e.nickname ? ` · ${e.nickname}` : ''}</option>
            ))}
          </select>
          {tab === 'tasks' && (
            <>
              <select value={statusFilter} onChange={(e) => setStatus(e.target.value as typeof statusFilter)} style={selectStyle}>
                <option value="all">All Statuses</option>
                <option value="upcoming">Upcoming</option>
                <option value="complete">Complete</option>
              </select>
              <select value={priorityFilter} onChange={(e) => setPriority(e.target.value as typeof priorityFilter)} style={selectStyle}>
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
          <div style={{ borderRadius: 12, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
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
                  {filteredTasks.map((t) => {
                    const over = t.status !== 'complete' && dueState(t.dueDate) === 'overdue'
                    // Left-accent bar: red for overdue, amber for High priority, else none.
                    const accent = over ? 'var(--ds-red)' : t.priority === 'high' ? 'var(--ds-amber)' : 'transparent'
                    return (
                    <TableRow key={t.id} className={cn(t.status === 'complete' && 'opacity-50')}>
                      <TableCell className="py-4" style={{ boxShadow: `inset 3px 0 0 ${accent}` }}>
                        <button
                          onClick={() => updateMaintenanceTask(t.id, { status: t.status === 'complete' ? 'upcoming' : 'complete' })}
                          className={cn('transition-colors', t.status === 'complete' ? 'text-emerald-500' : 'text-slate-300 hover:text-emerald-400')}
                        >
                          <CheckCircle2 className="size-4" />
                        </button>
                      </TableCell>
                      <TableCell className="py-4">
                        <span className={cn('text-sm font-medium', t.status === 'complete' && 'line-through')}>{t.title}</span>
                        {t.notes && <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-[200px]">{t.notes}</p>}
                      </TableCell>
                      <TableCell className="py-4">
                        <span className="inline-flex items-center font-mono text-xs bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded">
                          {equipName(t.equipmentId)}
                        </span>
                      </TableCell>
                      <TableCell className="py-4"><DueBadge date={t.dueDate} /></TableCell>
                      <TableCell className="py-4">{priorityBadge(t.priority)}</TableCell>
                      <TableCell className="py-4">
                        {t.assignee
                          ? <span className="text-sm text-muted-foreground capitalize">{t.assignee}</span>
                          : (
                            <button
                              onClick={() => setEditTask(t)}
                              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:border-slate-400 border border-dashed border-slate-300 rounded px-2 py-1 transition-colors"
                            >
                              <Plus className="size-3" /> Assign
                            </button>
                          )}
                      </TableCell>
                      <TableCell className="py-4">
                        {t.status === 'complete'
                          ? <Badge variant="secondary" className="bg-emerald-50 text-emerald-700 border-emerald-200 text-xs">Complete</Badge>
                          : <Badge variant="secondary" className="bg-blue-50 text-blue-700 border-blue-200 text-xs">Upcoming</Badge>}
                      </TableCell>
                      <TableCell className="py-4">
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
                  )})}
                </TableBody>
              </Table>
            )}
          </div>
        )}

        {/* Invoices Tab */}
        {tab === 'invoices' && (
          <div style={{ borderRadius: 12, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
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
        <TaskModal
          task={editTask}
          equipment={equipment}
          onSave={(data) => updateMaintenanceTask(editTask.id, data)}
          onClose={() => setEditTask(null)}
        />
      )}
      {newTaskOpen && (
        <TaskModal
          task={null}
          equipment={equipment}
          onSave={(data) => addMaintenanceTask(data)}
          onClose={() => setNewTaskOpen(false)}
        />
      )}
      {newInvoiceOpen && (
        <InvoiceModal
          equipment={equipment}
          onSave={(data) => addMaintenanceInvoice(data)}
          onClose={() => setNewInvoiceOpen(false)}
        />
      )}
    </div>
  )
}
