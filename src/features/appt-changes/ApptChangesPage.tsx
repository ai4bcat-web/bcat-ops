import { useMemo, useState } from 'react'
import { CheckCircle2, CircleAlert, ExternalLink, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { useIntakeItems } from '@/hooks/useIntakeItems'
import { useAppStore } from '@/store/useAppStore'
import { useIsMobile } from '@/hooks/useIsMobile'
import { LoadDrawer } from '@/features/loads/LoadDrawer'
import { updateIntakeItem, APPT_MOVE_PREFIX, APPT_TASK_PREFIX, APPT_MOVE_ASSIGNEE } from '@/lib/apiClient'
import { formatDateTime } from '@/lib/date'
import type { IntakeItem } from '@/types'

/**
 * Appt Changes — the worklist of booked appointments flagged NEEDS TO BE MOVED.
 *
 * Every flag creates one of these tasks (an IntakeItem with an appt-move externalId),
 * auto-assigned to Dennis, and #appts-ivan is alerted. Rebooking the appointment from
 * any editor closes the task automatically and replies in the Slack thread; the Done
 * button here is the manual fallback for a request resolved outside the app.
 */

const isApptMove = (i: IntakeItem) =>
  (i.externalId ?? '').startsWith(APPT_MOVE_PREFIX) || (i.externalId ?? '').startsWith(APPT_TASK_PREFIX)
const loadIdOf = (i: IntakeItem) => i.builtLoadId || null

export function ApptChangesPage() {
  const isMobile = useIsMobile()
  const { items, loading, refresh, patchLocal } = useApptMoveItems()
  const setSelectedLoad = useAppStore((s) => s.setSelectedLoad)
  const [showDone, setShowDone] = useState(false)

  const open = items.filter((i) => i.status !== 'DONE' && i.status !== 'ARCHIVED')
  const done = items.filter((i) => i.status === 'DONE' || i.status === 'ARCHIVED')

  const markDone = async (item: IntakeItem) => {
    try {
      await updateIntakeItem(item.id, { status: 'DONE' })
      patchLocal(item.id, { status: 'DONE' })
      toast.success('Marked done')
    } catch (e) { toast.error(`Couldn't mark it done: ${e instanceof Error ? e.message : 'unknown error'}`) }
  }

  const Card = ({ item }: { item: IntakeItem }) => {
    const doneItem = item.status === 'DONE' || item.status === 'ARCHIVED'
    const loadId = loadIdOf(item)
    return (
      <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12,
        boxShadow: 'var(--sh-sm)', padding: '12px 16px', display: 'flex', gap: 12, alignItems: 'flex-start',
        borderLeft: `3px solid ${doneItem ? '#15803d' : '#b45309'}` }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ds-t1)' }}>{item.subject}</span>
            <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 6px', borderRadius: 5,
              background: doneItem ? 'var(--ds-green-bg)' : 'var(--ds-amber-soft)',
              color: doneItem ? '#15803d' : '#b45309', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              {doneItem ? <CheckCircle2 size={11} /> : <CircleAlert size={11} />}
              {doneItem ? 'Done' : 'Needs to be moved'}
            </span>
          </div>
          {item.bodyText && (
            <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 4, whiteSpace: 'pre-line' }}>{item.bodyText}</div>
          )}
          <div style={{ fontSize: 11, color: 'var(--ds-t3)', marginTop: 6 }}>
            Assigned to {item.assignedTo === APPT_MOVE_ASSIGNEE ? 'Dennis' : item.assignedTo || '—'} · {formatDateTime(item.receivedAt)}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          {loadId && (
            <button onClick={() => setSelectedLoad(loadId, 'edit')}
              title="Open the load to rebook the appointment — booking it closes this task automatically"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 30, padding: '0 10px', borderRadius: 8,
                border: '1px solid var(--ds-border)', background: 'var(--ds-bg)', color: 'var(--ds-t2)', fontSize: 12,
                cursor: 'pointer', fontFamily: 'inherit' }}>
              <ExternalLink size={12} /> Open load
            </button>
          )}
          {!doneItem && (
            <button onClick={() => markDone(item)}
              title="Mark done without rebooking in the app (resolved outside bcat-ops)"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 30, padding: '0 10px', borderRadius: 8,
                border: '1px solid #86efac', background: 'var(--ds-surface)', color: '#15803d', fontSize: 12,
                fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
              <CheckCircle2 size={13} /> Done
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div style={{ maxWidth: 1000, margin: '0 auto', padding: isMobile ? '16px 12px' : '24px 32px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--ds-t1)', margin: 0 }}>Appt Changes</h1>
            <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 3 }}>
              Booked appointments flagged “needs to be moved” — auto-assigned to Dennis, alerted in #appts-ivan.
              Rebooking the appointment closes the task by itself.
            </p>
          </div>
          <button onClick={refresh} title="Refresh"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 32, padding: '0 12px', borderRadius: 8,
              border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', color: 'var(--ds-t2)', fontSize: 12.5,
              cursor: 'pointer', fontFamily: 'inherit' }}>
            <RefreshCw size={13} /> Refresh
          </button>
        </div>

        {loading && items.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', fontSize: 12.5, color: 'var(--ds-t3)' }}>Loading…</div>
        ) : open.length === 0 ? (
          <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12,
            padding: '28px 18px', textAlign: 'center', fontSize: 12.5, color: 'var(--ds-t3)' }}>
            Nothing to move — no open appointment-change requests.
          </div>
        ) : open.map((i) => <Card key={i.id} item={i} />)}

        {done.length > 0 && (
          <>
            <button onClick={() => setShowDone((v) => !v)}
              style={{ alignSelf: 'center', background: 'none', border: 'none', padding: '2px 0', cursor: 'pointer',
                font: 'inherit', fontSize: 12.5, color: 'var(--ds-t3)' }}>
              {showDone ? `Hide ${done.length} completed` : `Show ${done.length} completed`}
            </button>
            {showDone && done.map((i) => <Card key={i.id} item={i} />)}
          </>
        )}
      </div>
      <LoadDrawer />
    </div>
  )
}

/** The intake feed filtered down to appt-move tasks, with a local patch for optimism. */
function useApptMoveItems() {
  const { items: all, loading, refresh } = useIntakeItems()
  const [patches, setPatches] = useState<Map<string, Partial<IntakeItem>>>(new Map())
  const items = useMemo(() =>
    all.filter(isApptMove)
      .map((i) => ({ ...i, ...(patches.get(i.id) ?? {}) }))
      .sort((a, b) => (b.receivedAt ?? '').localeCompare(a.receivedAt ?? '')),
    [all, patches])
  const patchLocal = (id: string, p: Partial<IntakeItem>) =>
    setPatches((m) => new Map(m).set(id, { ...(m.get(id) ?? {}), ...p }))
  return { items, loading, refresh, patchLocal }
}
