/**
 * The one way a single shipment heads for billing from the shipment pages: push it into
 * Load Review. Release happens there and nowhere else (the server refuses a release
 * without the Load Review marker), so this never moves a load to billing itself.
 *
 * It runs the same `PUSH_TO_LOAD_REVIEW` the boards use, so the customer's review
 * requirements apply and a refusal comes back with one sentence per reason, printed as
 * written. A push that lands (or was already there) turns into a link to the load in
 * Load Review.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton } from '@/features/tms/kit'
import { pushToLoadReview } from '@/lib/apiClient'
import { loadReviewHref } from './releaseGateView'

export function PushToLoadReview({ shipmentId, onPushed }: { shipmentId: string; onPushed?: () => void }) {
  const [busy, setBusy] = useState(false)
  const [pushed, setPushed] = useState(false)
  const [reasons, setReasons] = useState<string[] | null>(null)

  const push = async () => {
    setBusy(true)
    setReasons(null)
    try {
      const { results } = await pushToLoadReview([shipmentId])
      const row = results[0]
      if (row?.ok) {
        setPushed(true)
        toast.success(row.message ?? 'Pushed to Load Review')
        onPushed?.()
      } else {
        const list = row?.reasons?.length ? row.reasons : [row?.message ?? 'The push was refused']
        setReasons(list)
      }
    } catch (err) {
      setReasons([err instanceof Error ? err.message : 'The push failed'])
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2" data-testid="push-to-load-review">
      <div className="flex flex-wrap items-center gap-2">
        {pushed ? (
          <Link to={loadReviewHref(shipmentId)} className="tms-btn tms-btn-primary tms-btn-sm">
            Open in Load Review
          </Link>
        ) : (
          <TmsButton variant="primary" size="sm" disabled={busy} onClick={() => { void push() }}>
            {busy ? 'Pushing…' : 'Push to Load Review'}
          </TmsButton>
        )}
        <span className="tms-muted text-xs">Billing release happens in Load Review.</span>
      </div>
      {reasons && (
        <ul className="space-y-1 text-sm" data-testid="push-to-load-review-reasons">
          {reasons.map((reason) => (
            <li key={reason} className="flex items-start gap-2">
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[color:var(--tms-badge-orange)]" />
              <span>{reason}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
