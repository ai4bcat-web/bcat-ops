import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { useStaff } from '@/hooks/useStaff'
import { TmsBadge, TmsCard, TmsEmptyState, TmsPage, TmsSelect } from '@/features/tms/kit'
import { useFollowUps } from '@/features/crm/useFollowUps'
import { isCrmManager, isOverdue } from '@/features/crm/format'
import type { CrmFollowUpRow } from '@/lib/crm/types'

const sortOverdueFirst = (a: string | null, b: string | null) => (a ?? '9999').localeCompare(b ?? '9999')

/** Customers › Follow-ups: next steps due within a week and the caller's open tasks, overdue first. */
export function FollowUpsPage() {
  const auth = useAuth()
  const isManager = isCrmManager(auth)
  const [scope, setScope] = useState<'mine' | 'all'>('mine')
  const [owner, setOwner] = useState('')
  const { rows, loading, error } = useFollowUps(isManager ? scope : 'mine')
  const { nameOf } = useStaff(auth.user?.email)

  const filtered = useMemo(() => rows.filter((r) => !owner || r.ownerId === owner), [rows, owner])
  const nextSteps = useMemo(
    () => filtered.filter((r) => r.nextStep).sort((a, b) => sortOverdueFirst(a.nextStepDueAt, b.nextStepDueAt)),
    [filtered],
  )
  const tasks = useMemo(
    () => filtered
      .flatMap((r) => r.openTasks.map((t) => ({ row: r, task: t })))
      .sort((a, b) => sortOverdueFirst(a.task.dueAt ?? null, b.task.dueAt ?? null)),
    [filtered],
  )
  const owners = useMemo(() => [...new Set(rows.map((r) => r.ownerId).filter((o): o is string => !!o))], [rows])

  const customerLink = (r: CrmFollowUpRow) => (
    <Link to={`/tms/customers?customer=${encodeURIComponent(r.customerId)}`} data-testid={`followup-link-${r.customerId}`}>
      {r.customerName ?? r.customerId}
    </Link>
  )

  return (
    <TmsPage
      title="Follow-ups"
      actions={isManager ? (
        <span style={{ display: 'inline-flex', gap: 8 }}>
          <TmsSelect value={scope} onChange={(e) => setScope(e.target.value as 'mine' | 'all')} options={[{ value: 'mine', label: 'Mine' }, { value: 'all', label: 'Everyone' }]} aria-label="Scope" data-testid="followups-scope" />
          {scope === 'all' && (
            <TmsSelect value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Any owner" options={owners.map((o) => ({ value: o, label: nameOf(o) }))} aria-label="Owner" data-testid="followups-owner" />
          )}
        </span>
      ) : undefined}
    >
      {error && <p className="tms-field-error">{error}</p>}
      <div style={{ display: 'grid', gap: 16 }}>
        <TmsCard title="Next steps due">
          {loading ? <p className="tms-muted">Loading…</p> : nextSteps.length === 0 ? (
            <TmsEmptyState title="Nothing due" message="No next step is due in the coming week." />
          ) : (
            <div style={{ display: 'grid', gap: 8 }} data-testid="followups-next-steps">
              {nextSteps.map((r) => (
                <div key={r.customerId} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }} data-testid={`followup-step-${r.customerId}`}>
                  {customerLink(r)}
                  <span>{r.nextStep}</span>
                  <span className="tms-muted">{r.nextStepDueAt ? `due ${r.nextStepDueAt.slice(0, 10)}` : 'no date'}</span>
                  {(r.overdue || isOverdue(r.nextStepDueAt)) && <TmsBadge tone="red">overdue</TmsBadge>}
                  {isManager && r.ownerId && <span className="tms-muted">{nameOf(r.ownerId)}</span>}
                </div>
              ))}
            </div>
          )}
        </TmsCard>
        <TmsCard title="My tasks">
          {loading ? <p className="tms-muted">Loading…</p> : tasks.length === 0 ? (
            <TmsEmptyState title="No open tasks" message="Tasks assigned to you appear here." />
          ) : (
            <div style={{ display: 'grid', gap: 8 }} data-testid="followups-tasks">
              {tasks.map(({ row, task }) => (
                <div key={task.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }} data-testid={`followup-task-${task.id}`}>
                  {customerLink(row)}
                  <span>{task.summary}</span>
                  <span className="tms-muted">{task.dueAt ? `due ${task.dueAt.slice(0, 10)}` : 'no date'}</span>
                  {isOverdue(task.dueAt) && <TmsBadge tone="red">overdue</TmsBadge>}
                </div>
              ))}
            </div>
          )}
        </TmsCard>
      </div>
    </TmsPage>
  )
}
