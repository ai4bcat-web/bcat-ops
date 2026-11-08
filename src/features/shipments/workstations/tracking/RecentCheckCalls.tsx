/**
 * The last five check calls, one line each: when · where · what it was · who logged it.
 * An open exception carries a Resolve action; the full history is the Timeline on the page.
 */
import type { ReactNode } from 'react'
import { TmsBadge, TmsButton } from '@/features/tms/kit'
import { CHECK_CALL_TYPE_LABELS, INCIDENT_TYPE_LABELS } from '@/lib/checkCalls'
import { formatBoardDateTime } from '@/lib/date'
import type { LoadCheckCallRecord } from '@/types/tms'

const RECENT_CHECK_CALLS = 5

const SOURCE_LABELS: Record<LoadCheckCallRecord['source'], string> = {
  MANUAL: 'by hand', DRIVER_APP: 'driver app', LINK: 'tracking link', SYSTEM: 'system',
}

/** Who a row credits: the person named on it, else what the `createdBy` marker says. */
function checkCallBy(event: Pick<LoadCheckCallRecord, 'personName' | 'createdBy' | 'source'>): string {
  const person = event.personName?.trim()
  if (person) return person
  const by = event.createdBy ?? ''
  if (by === 'system') return 'System'
  if (by.startsWith('driver:')) return 'Driver'
  if (by.startsWith('link:')) return 'Tracking link'
  return by || SOURCE_LABELS[event.source]
}

export function RecentCheckCalls({ events, busy, onResolve, actions }: {
  events: readonly LoadCheckCallRecord[]
  busy: boolean
  onResolve: (checkCallId: string) => void
  /** Buttons on the right of the heading (Log check call …). */
  actions?: ReactNode
}) {
  const rows = [...events].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, RECENT_CHECK_CALLS)
  return (
    <section className="tms-recent" data-testid="recent-check-calls" aria-label="Recent check calls">
      <div className="tms-recent-head">
        <h3 className="tms-recent-title">Recent check calls</h3>
        <div className="tms-recent-actions">{actions}</div>
      </div>
      {rows.length === 0 ? (
        <p className="tms-muted tms-recent-empty">No check calls logged yet.</p>
      ) : (
        <ul className="tms-recent-list">
          {rows.map((e) => {
            const place = [e.city, e.state].filter(Boolean).join(', ')
            const open = e.incidentOpen === 'OPEN'
            const by = checkCallBy(e)
            return (
              <li key={e.id} className="tms-recent-row" data-testid="recent-check-call">
                <span className="tms-recent-time">{formatBoardDateTime(e.at)}</span>
                <span className="tms-recent-place" title={place || undefined}>{place || '—'}</span>
                <span className="tms-recent-status">
                  {CHECK_CALL_TYPE_LABELS[e.type] ?? e.type}
                  {e.type === 'INCIDENT' && e.incidentType ? ` · ${INCIDENT_TYPE_LABELS[e.incidentType] ?? e.incidentType}` : ''}
                  {e.statusAfter ? <span className="tms-muted"> → {e.statusAfter.replace(/_/g, ' ').toLowerCase()}</span> : null}
                  {open ? <TmsBadge tone="red">open exception</TmsBadge> : null}
                </span>
                <span className="tms-recent-by tms-muted" title={`${by} · ${SOURCE_LABELS[e.source]}`}>{by}</span>
                {open ? (
                  <TmsButton size="sm" variant="ghost" disabled={busy} onClick={() => onResolve(e.id)}>Resolve</TmsButton>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
