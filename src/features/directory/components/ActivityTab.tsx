import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import {
  TmsBadge, TmsButton, TmsEmptyState, TmsField, TmsInput, TmsSelect, TmsTextarea, TmsTimeline,
} from '@/features/tms/kit'
import type { TmsTimelineItem } from '@/features/tms/kit/TmsTimeline'
import type { CrmAccountView, CrmTimelineEntry } from '@/lib/crm/types'
import type { AddActivityInput, AddTaskInput } from '@/features/crm/useCrmAccount'
import { dateInputToIso, isOverdue, kindLabel } from '@/features/crm/format'
import { formatCents } from '@/lib/tmsDirectory'
import { shipmentEditorPath } from '@/lib/shipmentLinks'

type Composer = 'NOTE' | 'CALL' | 'TEXT' | 'TASK'
const COMPOSER_KINDS: Composer[] = ['NOTE', 'CALL', 'TEXT', 'TASK']
const FILTERS: Array<{ key: string; label: string; match: (e: CrmTimelineEntry) => boolean }> = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'email', label: 'E-mail', match: (e) => e.kind === 'EMAIL_IN' || e.kind === 'EMAIL_OUT' },
  { key: 'quotes', label: 'Quotes', match: (e) => e.kind.startsWith('QUOTE') },
  { key: 'notes', label: 'Notes & calls', match: (e) => ['NOTE', 'CALL', 'TEXT', 'TASK'].includes(e.kind) },
  { key: 'system', label: 'Shipments & stage', match: (e) => e.kind === 'SHIPMENT_CREATED' || e.kind === 'STAGE_CHANGE' },
]

function entryTitle(e: CrmTimelineEntry): string {
  if (e.kind === 'EMAIL_IN' || e.kind === 'EMAIL_OUT') {
    if (e.restricted || !e.subject) return `E-mail ${e.kind === 'EMAIL_IN' ? 'from' : 'to'} a contact`
    return `${kindLabel(e.kind)} · ${e.subject}`
  }
  return kindLabel(e.kind)
}

function entryLink(e: CrmTimelineEntry): string | null {
  if (!e.derived) return null
  if (e.refs?.quoteId) return `/tms/rates/${encodeURIComponent(e.refs.quoteId)}`
  if (e.refs?.shipmentId) return shipmentEditorPath(e.refs.shipmentId)
  return null
}

interface ActivityTabProps {
  view: CrmAccountView | null
  loading: boolean
  error: string | null
  onAddActivity: (input: AddActivityInput) => Promise<unknown>
  onAddTask: (input: AddTaskInput) => Promise<unknown>
  onCompleteTask: (id: string) => Promise<unknown>
}

/** Customer card › Activity: composer, kind filter, merged timeline and open tasks. */
export function ActivityTab({ view, loading, error, onAddActivity, onAddTask, onCompleteTask }: ActivityTabProps) {
  const [kind, setKind] = useState<Composer>('NOTE')
  const [summary, setSummary] = useState('')
  const [date, setDate] = useState('')
  const [contact, setContact] = useState('')
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState('all')

  const entries = useMemo(() => {
    const f = FILTERS.find((x) => x.key === filter) ?? FILTERS[0]
    return (view?.timeline ?? []).filter(f.match)
  }, [view, filter])

  if (loading && !view) return <p className="tms-muted" data-testid="crm-activity-tab">Loading activity…</p>
  if (error && !view) return <p className="tms-field-error" data-testid="crm-activity-tab">{error}</p>
  if (!view) return null
  if (!view.visible) {
    return (
      <div data-testid="crm-activity-tab">
        <TmsEmptyState title="Activity is limited" message="This account's activity is visible to its owner and to managers." />
      </div>
    )
  }

  const isTask = kind === 'TASK'
  const canSubmit = summary.trim().length > 0 && (!isTask || dateInputToIso(date) !== undefined)

  const submit = async () => {
    setBusy(true)
    try {
      if (isTask) await onAddTask({ summary: summary.trim(), dueAt: dateInputToIso(date)! })
      else await onAddActivity({ kind, summary: summary.trim(), at: dateInputToIso(date), contactEmail: contact || undefined })
      setSummary('')
      setDate('')
      setContact('')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  const complete = async (id: string) => {
    try { await onCompleteTask(id) } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not complete task') }
  }

  const items: TmsTimelineItem[] = entries.map((e) => {
    const link = entryLink(e)
    const title = entryTitle(e)
    return {
      id: e.id,
      testId: `crm-timeline-${e.id}`,
      title: link ? <Link to={link}>{title}</Link> : title,
      tag: e.derived ? 'linked' : undefined,
      at: e.at.slice(0, 16).replace('T', ' '),
      description: [e.summary, e.amountCents != null ? formatCents(e.amountCents) : null].filter(Boolean).join(' · ') || undefined,
    }
  })

  return (
    <div style={{ display: 'grid', gap: 16 }} data-testid="crm-activity-tab">
      <div style={{ display: 'grid', gap: 10 }} data-testid="crm-composer">
        <div role="tablist" aria-label="Activity type" style={{ display: 'flex', gap: 6 }}>
          {COMPOSER_KINDS.map((k) => (
            <TmsButton key={k} size="sm" variant={k === kind ? 'primary' : undefined} onClick={() => setKind(k)} data-testid={`crm-composer-${k}`}>
              {kindLabel(k)}
            </TmsButton>
          ))}
        </div>
        <TmsTextarea value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={2000} placeholder={isTask ? 'What needs doing' : 'What happened'} aria-label="Activity summary" data-testid="crm-composer-summary" />
        <div className="tms-grid tms-grid-3" style={{ alignItems: 'end' }}>
          <TmsField label={isTask ? 'Due date' : 'Date (optional)'}>
            <TmsInput type="date" value={date} onChange={(e) => setDate(e.target.value)} data-testid="crm-composer-date" />
          </TmsField>
          {!isTask && (
            <TmsField label="Contact">
              <TmsSelect
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                placeholder="— none —"
                options={view.contacts.map((c) => ({ value: c.id, label: c.name || c.id }))}
                data-testid="crm-composer-contact"
              />
            </TmsField>
          )}
          <TmsButton variant="primary" onClick={() => void submit()} disabled={busy || !canSubmit} data-testid="crm-composer-submit">
            {isTask ? 'Add task' : `Log ${kindLabel(kind).toLowerCase()}`}
          </TmsButton>
        </div>
      </div>

      {view.openTasks.length > 0 && (
        <div style={{ display: 'grid', gap: 6 }} data-testid="crm-open-tasks">
          <div style={{ fontWeight: 600, fontSize: 13 }}>Open tasks</div>
          {view.openTasks.map((t) => (
            <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }} data-testid={`crm-task-${t.id}`}>
              <span>{t.summary}</span>
              {t.dueAt && <span className="tms-muted">due {t.dueAt.slice(0, 10)}</span>}
              {isOverdue(t.dueAt) && <TmsBadge tone="red">overdue</TmsBadge>}
              <TmsButton size="sm" onClick={() => void complete(t.id)} data-testid={`crm-task-complete-${t.id}`}>Complete</TmsButton>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }} data-testid="crm-filters">
        {FILTERS.map((f) => (
          <TmsButton key={f.key} size="sm" variant={f.key === filter ? 'primary' : undefined} aria-pressed={f.key === filter} onClick={() => setFilter(f.key)} data-testid={`crm-filter-${f.key}`}>
            {f.label}
          </TmsButton>
        ))}
      </div>

      <TmsTimeline
        items={items}
        ariaLabel="Account activity"
        data-testid="crm-timeline"
        empty={<p className="tms-muted" style={{ fontSize: 13 }}>No activity yet.</p>}
      />
    </div>
  )
}
