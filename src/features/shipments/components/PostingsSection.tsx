/**
 * Step P6 — where this shipment is posted right now.
 *
 * The section lives on the Carrier tab because coverage (who might haul it) belongs
 * next to the carrier assignment (who is hauling it). It lists every board the
 * shipment was posted to, not only the live ones, so a person can see the full
 * coverage history in one place.
 *
 * Post / Unpost controls are always rendered, even while BUILDING: the server is
 * the gate, and hiding the button would invent a client-side rule. A refused post
 * surfaces the Lambda's own sentence in the toast.
 */
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsCard, TmsEmptyState } from '@/features/tms/kit'
import { listShipmentPostings, postLoad, unpostLoad, graphqlErrorText } from '@/lib/apiClient'
import { formatDateTime } from '@/lib/date'
import type { ShipmentBuildState, ShipmentPostingRecord } from '@/types/tms'

/** Boards the demo and the spec name. The registry is the source of truth for labels. */
const POSTABLE = ['DAT', 'TRUCKSTOP'] as const

export interface PostingsSectionProps {
  shipmentId: string
  loadId?: string | null
  buildState?: ShipmentBuildState | null
  onReload?: () => void | Promise<void>
}

export function PostingsSection({ shipmentId, loadId, onReload }: PostingsSectionProps) {
  const [postings, setPostings] = useState<ShipmentPostingRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const refresh = async () => {
    setLoading(true)
    try {
      const rows = await listShipmentPostings(shipmentId)
      setPostings(rows)
    } catch (err) {
      toast.error(graphqlErrorText(err))
    } finally {
      setLoading(false)
    }
  }

  // The first read is the only one driven by an effect; every later refresh is
  // kicked off by a user action (post, unpost) and owns its spinner.
  useEffect(() => {
    let live = true
    listShipmentPostings(shipmentId)
      .then((rows) => { if (live) setPostings(rows) })
      .catch((err) => { if (live) toast.error(graphqlErrorText(err)) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [shipmentId])

  const post = async (provider: string) => {
    setBusy(true)
    try {
      await postLoad({ shipmentId, loadId, providers: [provider] })
      toast.success(`Posted to ${provider}`)
      await refresh()
      await onReload?.()
    } catch (err) {
      toast.error(graphqlErrorText(err))
    } finally {
      setBusy(false)
    }
  }

  const unpost = async (provider: string) => {
    setBusy(true)
    try {
      await unpostLoad({ shipmentId, providers: [provider] })
      toast.success(`Unposted from ${provider}`)
      await refresh()
      await onReload?.()
    } catch (err) {
      toast.error(graphqlErrorText(err))
    } finally {
      setBusy(false)
    }
  }

  const liveByProvider: Record<string, ShipmentPostingRecord | undefined> = Object.fromEntries(
    postings.filter((p) => p.status === 'POSTED').map((p) => [p.provider, p]),
  )

  return (
    <TmsCard title="Postings">
      <div className="tms-postings-wrap">
        {loading ? (
          <p className="tms-muted text-sm">Loading postings…</p>
        ) : postings.length === 0 ? (
          <TmsEmptyState title="Not posted" message="Post to DAT or Truckstop to find a carrier." />
        ) : (
          <table className="tms-postings-table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Status</th>
                <th>Board ID</th>
                <th>Posted</th>
                <th>Message</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {postings.map((posting) => (
                <tr key={posting.id}>
                  <td className="tms-postings-provider">{posting.provider}</td>
                  <td><TmsBadge tone={posting.status === 'POSTED' ? 'green' : posting.status === 'FAILED' ? 'red' : 'gray'}>{posting.status}</TmsBadge></td>
                  <td>
                    <span className="tms-postings-board-id">
                      {posting.mode === 'STUB' && <TmsBadge tone="orange" className="tms-postings-stub">STUB</TmsBadge>}
                      {posting.boardPostingId ?? '—'}
                    </span>
                  </td>
                  <td className="tms-muted">{posting.postedAt ? formatDateTime(posting.postedAt) : '—'}</td>
                  <td className="tms-postings-message">{posting.message ?? '—'}</td>
                  <td>
                    {posting.status === 'POSTED' ? (
                      <TmsButton size="sm" disabled={busy} onClick={() => unpost(posting.provider)}>Unpost</TmsButton>
                    ) : (
                      <TmsButton size="sm" disabled={busy} onClick={() => post(posting.provider)}>Post</TmsButton>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="tms-postings-actions">
          {POSTABLE.map((provider) => {
            const live = liveByProvider[provider]
            return live ? (
              <TmsButton key={provider} size="sm" disabled={busy} onClick={() => unpost(provider)}>Unpost {provider}</TmsButton>
            ) : (
              <TmsButton key={provider} size="sm" disabled={busy} onClick={() => post(provider)}>Post {provider}</TmsButton>
            )
          })}
        </div>
      </div>
    </TmsCard>
  )
}
