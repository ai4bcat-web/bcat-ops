import { useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { TmsButton } from '@/features/tms/kit/TmsButton'
import { TmsEmptyState } from '@/features/tms/kit/TmsEmptyState'
import { TmsScrollPage } from '@/features/tms/kit/TmsScrollPage'
import { TmsStatRow } from '@/features/tms/kit/TmsStatRow'
import type { TmsStat } from '@/features/tms/kit/TmsStatRow'
import { Avatar } from '@/components/ui/avatar'
import { AlertTriangle, Wrench, CheckCircle2, Trash2, Pencil, Plus, Search, ArrowUp, ArrowDown, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import type { Equipment, MaintenanceTask, TaskPriority, TaskStatus } from '@/types/equipment'
import {
  isOverdue, thBase, tdBase, equipChipStyle, iconBtnStyle,
  Pill, type PillTone, inputStyle, btnGhost, btnPrimary, btnDanger, Field, FormSection, Seg, Modal,
} from './maintenanceUi'

const PRIORITY_TONE: Record<TaskPriority, PillTone> = { high: 'bad', med: 'warn', low: 'neutral' }
const PRIORITY_LABEL: Record<TaskPriority, string> = { high: 'High', med: 'Med', low: 'Low' }
const PRIORITY_RANK: Record<TaskPriority, number> = { high: 0, med: 1, low: 2 }

// ── Task Modal (create + edit) ───────────────────────────────────────────────────

type TaskData = Omit<MaintenanceTask, 'id' | 'createdAt' | 'updatedAt'>

function TaskModal({ task, equipment, onSave, onDelete, onClose }: {
  task: MaintenanceTask | null
  equipment: Equipment[]
  onSave: (data: TaskData) => void
  onDelete?: () => void
  onClose: () => void
}) {
  const isEdit = task !== null
  const [form, setForm] = useState({
    equipmentId: task?.equipmentId ?? (equipment[0]?.id ?? ''),
    title:    task?.title ?? '',
    notes:    task?.notes ?? '',
    dueDate:  task?.dueDate ?? '',
    priority: (task?.priority ?? 'med') as TaskPriority,
    status:   (task?.status ?? 'upcoming') as TaskStatus,
    assignee: task?.assignee ?? '',
  })
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }))

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.equipmentId || !form.title.trim()) return
    onSave({
      equipmentId: form.equipmentId,
      title: form.title.trim(),
      dueDate: form.dueDate || undefined,
      priority: form.priority,
      status: form.status,
      assignee: form.assignee || undefined,
      notes: form.notes.trim() || undefined,
      autoDot: task?.autoDot ?? false,
    })
    onClose()
  }

  return (
    <Modal
      title={isEdit ? 'Edit Task' : 'New Task'}
      onClose={onClose}
      footer={
        <>
          {isEdit && onDelete ? (
            <button type="button" onClick={() => { onDelete(); onClose() }} style={btnDanger}><Trash2 size={14} /> Delete</button>
          ) : <span />}
          <div style={{ display: 'flex', gap: 10 }}>
            <button type="button" onClick={onClose} style={btnGhost}>Cancel</button>
            <button type="submit" form="task-form" style={btnPrimary}>{isEdit ? 'Save Changes' : <><Plus size={14} /> Create Task</>}</button>
          </div>
        </>
      }
    >
      <form id="task-form" onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        <FormSection title="Task Details">
          <Field label="Equipment" required>
            <select style={{ ...inputStyle, opacity: isEdit ? 0.6 : 1 }} value={form.equipmentId} onChange={(e) => set('equipmentId', e.target.value)} disabled={isEdit} required>
              <option value="" disabled>Select equipment…</option>
              {equipment.map((eq) => (
                <option key={eq.id} value={eq.id}>#{eq.unitNumber}{eq.nickname ? ` · ${eq.nickname}` : ''}</option>
              ))}
            </select>
          </Field>
          <Field label="Task Title" required>
            <input style={inputStyle} value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="What needs doing?" required autoFocus />
          </Field>
          <Field label="Description">
            <textarea rows={3} style={{ ...inputStyle, resize: 'vertical', minHeight: 76, lineHeight: 1.5 }} value={form.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Optional details / notes" />
          </Field>
        </FormSection>

        <FormSection title="Scheduling">
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 14 }}>
            <Field label="Due Date">
              <input type="date" style={inputStyle} value={form.dueDate} onChange={(e) => set('dueDate', e.target.value)} />
            </Field>
            <Field label="Assignee">
              <select style={inputStyle} value={form.assignee} onChange={(e) => set('assignee', e.target.value)}>
                <option value="">— None —</option>
                <option value="jason">Jason</option>
                <option value="ryne">Ryne</option>
              </select>
            </Field>
          </div>
          <Field label="Priority">
            <Seg value={form.priority} onChange={(v) => set('priority', v)} options={[{ value: 'low', label: 'Low' }, { value: 'med', label: 'Medium' }, { value: 'high', label: 'High' }]} />
          </Field>
          <Field label="Status">
            <Seg value={form.status} onChange={(v) => set('status', v)} options={[{ value: 'upcoming', label: 'Upcoming' }, { value: 'complete', label: 'Completed' }]} />
          </Field>
        </FormSection>
      </form>
    </Modal>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────


type Tab = 'tasks' | 'completed'
type SortKey = 'title' | 'equipment' | 'dueDate' | 'completedDate' | 'createdAt' | 'priority' | 'status'

export function MaintenancePage() {
  const equipment            = useAppStore((s) => s.equipment)
  const maintenanceTasks     = useAppStore((s) => s.maintenanceTasks)
  const addMaintenanceTask       = useAppStore((s) => s.addMaintenanceTask)
  const updateMaintenanceTask    = useAppStore((s) => s.updateMaintenanceTask)
  const deleteMaintenanceTask    = useAppStore((s) => s.deleteMaintenanceTask)

  const [tab, setTab]                 = useState<Tab>('tasks')
  const [timeFilter, setTimeFilter]   = useState<'upcoming' | 'overdue' | 'all'>('all')
  const [priorityFilter, setPriority] = useState<'all' | TaskPriority>('all')
  const [equipFilter, setEquipFilter] = useState('')
  const [search, setSearch]           = useState('')
  const [sortKey, setSortKey]         = useState<SortKey>('dueDate')
  const [sortDir, setSortDir]         = useState<'asc' | 'desc'>('asc')
  const [editTask, setEditTask]       = useState<MaintenanceTask | null>(null)
  const [newTaskOpen, setNewTaskOpen] = useState(false)

  const isCompletedTab = tab === 'completed'

  function equipName(id: string) {
    const e = equipment.find((eq) => eq.id === id)
    return e ? `#${e.unitNumber}${e.nickname ? ` · ${e.nickname}` : ''}` : id
  }
  function equipUnit(id: string) {
    const e = equipment.find((eq) => eq.id === id)
    return e ? `#${e.unitNumber}` : id
  }

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(k); setSortDir('asc') }
  }

  const visibleTasks = maintenanceTasks
    .filter((t) => (isCompletedTab ? t.status === 'complete' : t.status !== 'complete'))
    .filter((t) => {
      const over = t.status !== 'complete' && isOverdue(t.dueDate)
      if (!isCompletedTab) {
        if (timeFilter === 'upcoming' && over) return false   // upcoming = open, not overdue
        if (timeFilter === 'overdue' && !over) return false
      }
      if (priorityFilter !== 'all' && t.priority !== priorityFilter) return false
      if (equipFilter && t.equipmentId !== equipFilter) return false
      if (search) {
        const q = search.toLowerCase()
        return t.title.toLowerCase().includes(q) || (t.notes ?? '').toLowerCase().includes(q) || equipName(t.equipmentId).toLowerCase().includes(q)
      }
      return true
    })
    .sort((a, b) => {
      const dir = sortDir === 'asc' ? 1 : -1
      let cmp = 0
      switch (sortKey) {
        case 'title':     cmp = a.title.localeCompare(b.title); break
        case 'equipment': cmp = equipUnit(a.equipmentId).localeCompare(equipUnit(b.equipmentId), undefined, { numeric: true }); break
        case 'dueDate':   cmp = (a.dueDate ?? '').localeCompare(b.dueDate ?? ''); break
        case 'completedDate': cmp = (a.completedDate ?? '').localeCompare(b.completedDate ?? ''); break
        case 'createdAt': cmp = (a.createdAt ?? '').localeCompare(b.createdAt ?? ''); break
        case 'priority':  cmp = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]; break
        case 'status':    cmp = a.status.localeCompare(b.status); break
      }
      return cmp * dir
    })

  const overdueCount   = maintenanceTasks.filter((t) => t.status === 'upcoming' && isOverdue(t.dueDate)).length
  const upcomingCount  = maintenanceTasks.filter((t) => t.status === 'upcoming').length
  const completedCount = maintenanceTasks.filter((t) => t.status === 'complete').length
  const highOpenCount  = maintenanceTasks.filter((t) => t.status !== 'complete' && t.priority === 'high').length

  // Each KPI applies the matching tab + filters when clicked.
  const MAINT_KPIS: TmsStat[] = [
    { label: 'Open Tasks',    value: String(upcomingCount),  tone: 'default', ariaLabel: 'Filter to open tasks',    onClick: () => { setTab('tasks'); setTimeFilter('all'); setPriority('all') } },
    { label: 'Overdue',       value: String(overdueCount),   tone: 'bad',     ariaLabel: 'Filter to overdue',       onClick: () => { setTab('tasks'); setTimeFilter('overdue'); setPriority('all') } },
    { label: 'Completed',     value: String(completedCount), tone: 'good',    ariaLabel: 'Filter to completed',     onClick: () => { setTab('completed'); setPriority('all') } },
    { label: 'High Priority', value: String(highOpenCount),  tone: 'warn',    ariaLabel: 'Filter to high priority', onClick: () => { setTab('tasks'); setTimeFilter('all'); setPriority('high') } },
  ]

  const TABS_LIST = [
    { key: 'tasks' as const,     label: 'Tasks',           Icon: Wrench },
    { key: 'completed' as const, label: 'Completed Tasks', Icon: CheckCircle2 },
  ]

  const selectStyle: React.CSSProperties = {
    height: 34, padding: '0 10px', background: 'var(--tms-card)',
    border: '1px solid var(--tms-border)', borderRadius: 7,
    fontSize: 12.5, color: 'var(--tms-text)', fontFamily: 'inherit', outline: 'none',
  }

  // Sortable header cell — plain render function (not a component) so it doesn't remount.
  const sortTh = (label: string, k: SortKey) => {
    const active = sortKey === k
    return (
      <th key={k} style={{ ...thBase, cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort(k)}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: active ? 'var(--tms-text)' : undefined }}>
          {label}
          {active && (sortDir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
        </span>
      </th>
    )
  }

  return (
    <TmsScrollPage
      title="Maintenance"
      subtitle="Fleet maintenance tasks"
      stickyHead
      actions={
        <>
          <TmsButton variant="secondary">Export</TmsButton>
          <TmsButton
            variant="primary"
            onClick={() => setNewTaskOpen(true)}
            disabled={equipment.length === 0}
            title={equipment.length === 0 ? 'Add equipment in Fleet first' : undefined}
          >
            <Plus size={14} /> New Task
          </TmsButton>
        </>
      }
      toolbar={
        <div style={{ display: 'flex', gap: 0 }}>
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
                  borderBottom: `2px solid ${active ? 'var(--tms-primary)' : 'transparent'}`,
                  color: active ? 'var(--tms-primary)' : 'var(--tms-muted)',
                  marginBottom: -1,
                }}
              >
                <Icon size={13} />{label}
              </button>
            )
          })}
        </div>
      }
    >
      <TmsStatRow items={MAINT_KPIS} columns={4} />

      <div style={{ marginTop: 16 }}>
        {/* Filters */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
          <div style={{ position: 'relative' }}>
            <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--tms-muted)', pointerEvents: 'none' }} />
            <input
              type="text"
              placeholder="Search…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{
                width: 220, height: 34, paddingLeft: 30, paddingRight: 10, boxSizing: 'border-box',
                background: 'var(--tms-card)', border: '1px solid var(--tms-border)', borderRadius: 7,
                fontSize: 12.5, color: 'var(--tms-text)', fontFamily: 'inherit', outline: 'none',
              }}
            />
          </div>
          <select value={equipFilter} onChange={(e) => setEquipFilter(e.target.value)} style={selectStyle}>
            <option value="">All Equipment</option>
            {equipment.map((e) => (
              <option key={e.id} value={e.id}>#{e.unitNumber}{e.nickname ? ` · ${e.nickname}` : ''}</option>
            ))}
          </select>
          {!isCompletedTab && (
            <select value={timeFilter} onChange={(e) => setTimeFilter(e.target.value as typeof timeFilter)} style={selectStyle}>
              <option value="all">All Open</option>
              <option value="upcoming">Upcoming</option>
              <option value="overdue">Overdue</option>
            </select>
          )}
          <select value={priorityFilter} onChange={(e) => setPriority(e.target.value as typeof priorityFilter)} style={selectStyle}>
            <option value="all">All Priorities</option>
            <option value="high">High</option>
            <option value="med">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>

        <div style={{ borderRadius: 12, border: '1px solid var(--tms-border)', background: 'var(--tms-card)', boxShadow: 'var(--tms-shadow)', overflow: 'hidden' }}>
          {visibleTasks.length === 0 ? (
            <TmsEmptyState
              compact
              title={isCompletedTab ? 'No completed tasks yet.' : 'No tasks found.'}
              message={isCompletedTab ? 'Tasks you mark complete show up here.' : 'Add a task with the New Task button, or from the Fleet page.'}
            />
          ) : (
            <div style={{ maxHeight: 'calc(100vh - 340px)', overflowY: 'auto', overflowX: 'auto' }}>
              <table style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', minWidth: isCompletedTab ? 1040 : 940 }}>
                <colgroup>
                  <col style={{ width: 44 }} />
                  <col style={{ width: 180 }} />
                  <col />
                  <col style={{ width: 112 }} />
                  <col style={{ width: 104 }} />
                  <col style={{ width: 110 }} />
                  {isCompletedTab && <col style={{ width: 118 }} />}
                  <col style={{ width: 112 }} />
                  <col style={{ width: 120 }} />
                  <col style={{ width: isCompletedTab ? 120 : 112 }} />
                  <col style={{ width: 76 }} />
                </colgroup>
                <thead>
                  <tr>
                    <th style={{ ...thBase }}></th>
                    {sortTh('Task', 'title')}
                    <th style={{ ...thBase }}>Description</th>
                    {sortTh('Equipment', 'equipment')}
                    {sortTh('Created', 'createdAt')}
                    {sortTh('Due', 'dueDate')}
                    {isCompletedTab && sortTh('Completed', 'completedDate')}
                    {sortTh('Priority', 'priority')}
                    <th style={{ ...thBase }}>Assignee</th>
                    {sortTh('Status', 'status')}
                    <th style={{ ...thBase, textAlign: 'right' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {visibleTasks.map((t) => {
                    const over = t.status !== 'complete' && isOverdue(t.dueDate)
                    const accent = over ? 'var(--tms-badge-red)' : t.priority === 'high' ? 'var(--tms-badge-orange)' : 'transparent'
                    const done = t.status === 'complete'
                    return (
                      <tr key={t.id} className="maint-row" style={{ opacity: done && !isCompletedTab ? 0.55 : 1 }}>
                        <td style={{ ...tdBase, boxShadow: `inset 3px 0 0 ${accent}`, textAlign: 'center' }}>
                          <input
                            type="checkbox"
                            checked={done}
                            onChange={() => { const next = done ? 'upcoming' : 'complete'; updateMaintenanceTask(t.id, { status: next }); toast.success(next === 'complete' ? 'Task marked complete' : 'Task reopened') }}
                            aria-label={done ? 'Unmark — reopen task' : 'Mark task complete'}
                            title={done ? 'Unmark — reopen task' : 'Mark complete'}
                            style={{ width: 16, height: 16, borderRadius: 4, accentColor: 'var(--tms-primary)', cursor: 'pointer', verticalAlign: 'middle' }}
                          />
                        </td>
                        <td style={tdBase}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--tms-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</div>
                        </td>
                        <td style={{ ...tdBase, fontSize: 12.5, color: 'var(--tms-muted)', lineHeight: 1.45 }}>
                          {t.notes ? t.notes : <span style={{ color: 'var(--tms-disabled)' }}>—</span>}
                        </td>
                        <td style={tdBase}><span style={equipChipStyle}>{equipUnit(t.equipmentId)}</span></td>
                        <td style={{ ...tdBase, fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--tms-muted)', whiteSpace: 'nowrap' }}>
                          {t.createdAt ? t.createdAt.slice(0, 10) : <span style={{ color: 'var(--tms-disabled)' }}>—</span>}
                        </td>
                        <td style={{ ...tdBase, fontFamily: 'var(--font-mono)', fontSize: 12.5, color: over ? 'var(--tms-badge-red)' : 'var(--tms-text-2)', fontWeight: over ? 600 : 400, whiteSpace: 'nowrap' }}>
                          {t.dueDate ? (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              {over && <AlertTriangle size={11} />}{t.dueDate}
                            </span>
                          ) : <span style={{ color: 'var(--tms-disabled)' }}>—</span>}
                        </td>
                        {isCompletedTab && (
                          <td style={{ ...tdBase, fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--tms-badge-green)', fontWeight: 500, whiteSpace: 'nowrap' }}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              <CheckCircle2 size={11} />{t.completedDate ?? <span style={{ color: 'var(--tms-disabled)' }}>—</span>}
                            </span>
                          </td>
                        )}
                        <td style={tdBase}><Pill tone={PRIORITY_TONE[t.priority]} dot>{PRIORITY_LABEL[t.priority]}</Pill></td>
                        <td style={tdBase}>
                          {t.assignee ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                              <Avatar initials={t.assignee[0].toUpperCase()} size="sm" style={{ background: 'var(--tms-badge-orange)', color: 'var(--tms-on-primary)' }} />
                              <span style={{ fontSize: 12.5, textTransform: 'capitalize', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.assignee}</span>
                            </div>
                          ) : (
                            <button
                              onClick={() => setEditTask(t)}
                              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--tms-muted)', border: '1px dashed var(--tms-input-border)', borderRadius: 6, padding: '4px 9px', background: 'transparent', cursor: 'pointer', fontFamily: 'inherit' }}
                            >
                              <Plus size={12} /> Assign
                            </button>
                          )}
                        </td>
                        <td style={tdBase}>
                          {done ? (
                            <button
                              onClick={() => { updateMaintenanceTask(t.id, { status: 'upcoming' }); toast.success('Task reopened') }}
                              title="Unmark — move back to open tasks"
                              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'var(--tms-badge-green-tint)', color: 'var(--tms-badge-green)', border: 'none', borderRadius: 999, padding: '3px 9px', fontSize: 11.5, fontWeight: 500, fontFamily: 'inherit', cursor: 'pointer' }}
                            >
                              Completed <RotateCcw size={11} />
                            </button>
                          ) : over ? <Pill tone="bad">Overdue</Pill> : <Pill tone="blue">Upcoming</Pill>}
                        </td>
                        <td style={{ ...tdBase, textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <button aria-label="Edit task" onClick={() => setEditTask(t)} style={{ ...iconBtnStyle, color: 'var(--tms-muted)' }}><Pencil size={13} /></button>
                          <button aria-label="Delete task" onClick={() => { deleteMaintenanceTask(t.id); toast.success('Task deleted') }} style={{ ...iconBtnStyle, color: 'var(--tms-badge-red)' }}><Trash2 size={13} /></button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {editTask && (
        <TaskModal
          task={editTask}
          equipment={equipment}
          onSave={(data) => { updateMaintenanceTask(editTask.id, data); toast.success('Task updated') }}
          onDelete={() => { deleteMaintenanceTask(editTask.id); toast.success('Task deleted') }}
          onClose={() => setEditTask(null)}
        />
      )}
      {newTaskOpen && (
        <TaskModal
          task={null}
          equipment={equipment}
          onSave={(data) => { addMaintenanceTask(data); toast.success('Task created') }}
          onClose={() => setNewTaskOpen(false)}
        />
      )}
    </TmsScrollPage>
  )
}
