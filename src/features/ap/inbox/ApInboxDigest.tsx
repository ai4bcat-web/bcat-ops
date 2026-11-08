/**
 * The one calm line above every AP tab (plan §7.2). Text comes from `formatDigest`, so the
 * Settings card and the page always agree.
 */
import { Link } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { TmsButton } from '@/features/tms/kit'
import { formatDigest } from '@/lib/apInbox/digest'
import type { ApInboxStatusView } from './apInboxClient'
import type { SyncProgress } from './useApInbox'

const TONE_COLOR = { ok: 'var(--tms-muted)', info: 'var(--tms-muted)', warn: 'var(--tms-badge-orange)' } as const

export function ApInboxDigest({ status, syncing, progress, isAdmin, onReviewNow, onOpenQueue, now = new Date() }: {
  status: ApInboxStatusView | null
  syncing: boolean
  progress: SyncProgress | null
  isAdmin: boolean
  onReviewNow: () => void
  onOpenQueue: () => void
  now?: Date
}) {
  if (!status) return null
  const line = formatDigest({
    connection: status.connection.status,
    run: status.runs[0] ?? null,
    openCount: status.openCount,
    now,
    runHourChicago: status.config.runHourChicago,
  })
  const connected = status.connection.status === 'CONNECTED' || status.connection.status === 'SIMULATED'
  const notConnected = status.connection.status === 'NOT_CONNECTED' || status.connection.status === 'PENDING'

  return (
    <div
      data-testid="ap-inbox-digest"
      className="flex flex-wrap items-center gap-2 px-4 py-2 text-xs"
      style={{ color: TONE_COLOR[line.tone], borderBottom: '1px solid var(--tms-border)' }}
    >
      <span>
        {syncing && progress
          ? `Reviewed ${progress.reviewed}${progress.remaining > 0 ? ` · ${progress.remaining} left` : ''}…`
          : line.text}
      </span>
      {status.openCount > 0 && connected && (
        <button type="button" data-testid="ap-inbox-open-link" className="underline" onClick={onOpenQueue}>
          Open the queue
        </button>
      )}
      {notConnected && isAdmin && <Link to="/tms/brokerage" className="underline">Open settings</Link>}
      {connected && (
        <TmsButton size="sm" data-testid="ap-inbox-review-now" disabled={syncing} onClick={onReviewNow}>
          {syncing ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : null} Review now
        </TmsButton>
      )}
    </div>
  )
}
