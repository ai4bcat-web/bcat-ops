/**
 * Review before "Submit to OTR" on one factoring row (Ryne 2026-11-19): the button no longer submits. It opens the
 * same look the batch Factor review gives, the customer's rate confirmation and the POD, the two documents OTR
 * receives, and only the final "Factor 1 invoice" button calls the submit. Closing or cancelling sends nothing.
 */
import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { TmsButton, TmsDialog } from '@/features/tms/kit'
import { DocPane } from '@/features/ar/components/FactorDocPane'
import { missingDocs, type DocLook } from '@/features/ar/factorDocs'
import { previewOtrDocs } from '@/lib/otrClient'
import { invoiceAmountOf, money } from './factoringTotals'
import type { FactoringItem } from '@/types'

export function SubmitToOtrReviewDialog({ item, busy = false, onConfirm, onClose }: {
  item: FactoringItem
  busy?: boolean
  /** The only path to the submit. */
  onConfirm: () => void
  onClose: () => void
}) {
  const [look, setLook] = useState<DocLook>({ state: 'loading' })
  const amount = invoiceAmountOf(item)
  const missing = missingDocs(look)

  useEffect(() => {
    let alive = true
    previewOtrDocs({ id: item.id })
      .then((r) => { if (alive) setLook({ state: 'ready', pod: r.pod, rateCon: r.rateCon }) })
      .catch((err: unknown) => { if (alive) setLook({ state: 'error', message: err instanceof Error ? err.message : String(err) }) })
    return () => { alive = false }
  }, [item.id])

  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open && !busy) onClose() }}
      title={`Review before factoring — PRO ${item.proNumber}`}
      className="tms-dialog-wide send-review-dialog"
      footer={(
        <>
          <TmsButton variant="ghost" onClick={onClose} disabled={busy}>Cancel</TmsButton>
          <TmsButton variant="primary" onClick={onConfirm} disabled={busy || look.state === 'loading' || missing.length > 0} data-testid="factor-review-confirm">
            {busy ? 'Submitting…' : 'Factor 1 invoice'}
          </TmsButton>
        </>
      )}
    >
      <div className="flex flex-col gap-3 text-sm">
        <p><strong>PRO {item.proNumber}</strong> · {amount == null ? 'No rate yet' : money(amount)}</p>
        {look.state === 'error' && (
          <p role="alert" style={{ color: 'var(--tms-badge-orange)' }}>
            <AlertTriangle size={14} className="inline" /> Could not load the documents to preview ({look.message}). It was checked as ready, so it can still go.
          </p>
        )}
        {missing.length > 0 && (
          <div role="alert" aria-label="Cannot send" className="send-review-blockers">
            <AlertTriangle size={16} style={{ flex: 'none', marginTop: 1 }} />
            <span><strong>Will not be sent:</strong> no {missing.join(' or ')} on file. Add it first.</span>
          </div>
        )}
        <div className="send-review-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
          <DocPane title="Customer rate confirmation" look={look} pick={(l) => l.rateCon} />
          <DocPane title="POD" look={look} pick={(l) => l.pod} />
        </div>
        <p className="text-xs tms-muted">OTR receives these two documents only. Nothing leaves until you press Factor.</p>
      </div>
    </TmsDialog>
  )
}
