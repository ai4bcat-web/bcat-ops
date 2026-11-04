/**
 * "Push to DAT" for a quote or a spot request that has no shipment yet.
 *
 * Posts through the same provider adapter and the same `ShipmentPosting` rows as a shipment's Postings
 * section: live when the DAT login exists, otherwise a STUB that is labelled as one and still records the
 * row. The status shown here is read back from those rows (`quote:<id>` / `spot:<id>` subjects), so what is
 * on screen is what was recorded, and Unpost is the same row flipped to UNPOSTED.
 */
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsCard } from '@/features/tms/kit'
import { graphqlErrorText, listShipmentPostings, postQuoteLoad, unpostQuoteLoad } from '@/lib/apiClient'
import type { PostQuoteLoadInput } from '@/lib/apiClient'
import { formatDateTime } from '@/lib/date'
import type { ShipmentPostingRecord } from '@/types/tms'

export interface PushToDatProps {
  quoteId?: string | null
  spotRequestId?: string | null
  /** The lane and load facts a spot request with no quote posts from. Ignored when a quote is given. */
  load?: Omit<PostQuoteLoadInput, 'quoteId' | 'spotRequestId' | 'providers'> | null
  disabled?: boolean
  disabledReason?: string | null
}

/** The subjects whose rows describe this card: the quote's, and the spot request's own. */
function postingSubjects(quoteId?: string | null, spotRequestId?: string | null): string[] {
  return [quoteId ? `quote:${quoteId}` : null, spotRequestId ? `spot:${spotRequestId}` : null].filter((k): k is string => !!k)
}

export function PushToDatCard({ quoteId, spotRequestId, load, disabled, disabledReason }: PushToDatProps) {
  const subjects = postingSubjects(quoteId, spotRequestId)
  const subjectKey = subjects.join('|')
  const [rows, setRows] = useState<ShipmentPostingRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const read = useCallback(
    () => Promise.all(subjectKey.split('|').filter(Boolean).map((k) => listShipmentPostings(k)))
      .then((lists) => lists.flat().filter((r) => r.provider === 'DAT')
        .sort((a, b) => String(b.updatedAt ?? b.postedAt ?? '').localeCompare(String(a.updatedAt ?? a.postedAt ?? '')))),
    [subjectKey],
  )

  useEffect(() => {
    let live = true
    read()
      .then((list) => { if (live) setRows(list) })
      .catch((err: unknown) => { if (live) toast.error(graphqlErrorText(err)) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [read])

  const act = (work: () => Promise<unknown>, done: string) => {
    setBusy(true)
    return work()
      .then(() => { toast.success(done); return read() })
      .then(setRows)
      .catch((err: unknown) => toast.error(graphqlErrorText(err)))
      .finally(() => setBusy(false))
  }

  const current = rows[0] ?? null
  const posted = current?.status === 'POSTED'
  const push = () => act(
    () => postQuoteLoad({ ...(quoteId ? {} : load ?? {}), quoteId: quoteId ?? null, spotRequestId: spotRequestId ?? null, providers: ['DAT'] }),
    'Posted to DAT',
  )
  const unpost = () => act(
    () => unpostQuoteLoad({ quoteId: current?.shipmentId.startsWith('quote:') ? quoteId : null, spotRequestId: current?.shipmentId.startsWith('spot:') ? spotRequestId : null, providers: ['DAT'] }),
    'Unposted from DAT',
  )

  return (
    <TmsCard title="DAT load board">
      <div data-testid="push-dat" className="tms-stack">
        {loading ? (
          <p className="tms-muted tms-flush">Reading posting status…</p>
        ) : current ? (
          <p className="tms-flush" data-testid="push-dat-status">
            <TmsBadge tone={posted ? 'green' : current.status === 'FAILED' ? 'red' : 'gray'}>{current.status}</TmsBadge>{' '}
            {current.mode === 'STUB' ? <TmsBadge tone="orange" data-testid="push-dat-stub">STUB</TmsBadge> : <TmsBadge tone="green" data-testid="push-dat-live">LIVE</TmsBadge>}{' '}
            <span className="tms-muted">
              {current.message ?? ''}
              {current.postedAt ? ` · posted ${formatDateTime(current.postedAt)}` : ''}
              {current.status === 'UNPOSTED' && current.unpostedAt ? ` · unposted ${formatDateTime(current.unpostedAt)}` : ''}
            </span>
          </p>
        ) : (
          <p className="tms-muted tms-flush">Not posted to DAT.</p>
        )}
        <div className="tms-spot-actions">
          {posted ? (
            <TmsButton data-testid="push-dat-unpost" disabled={busy} onClick={() => void unpost()}>Unpost</TmsButton>
          ) : null}
          <TmsButton
            variant="primary"
            data-testid="push-dat-post"
            disabled={busy || disabled}
            title={disabled ? disabledReason ?? undefined : undefined}
            onClick={() => void push()}
          >
            {posted ? 'Update posting' : current ? 'Push to DAT again' : 'Push to DAT'}
          </TmsButton>
        </div>
        {disabled && disabledReason ? <p className="tms-muted tms-flush">{disabledReason}</p> : null}
      </div>
    </TmsCard>
  )
}
