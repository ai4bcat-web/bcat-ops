/**
 * "Release from OTR" for a row whose invoice was deleted at OTR (Dead there, never funded). Admin only, reason required.
 * It sends nothing to OTR: the row goes back to Need to factor so Send to Factor can link the new bill, and the old
 * OTR invoice id stays on the row's history.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog } from '@/features/tms/kit'
import { releaseDeadOtrSubmission } from '@/lib/apiClient'
import { errorText } from '@/lib/errorText'
import type { FactoringItem } from '@/types'

export function ReleaseFromOtrDialog({ item, onClose, onDone }: { item: FactoringItem; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function release() {
    setBusy(true)
    setError(null)
    try {
      await releaseDeadOtrSubmission({ proNumber: item.id, reason: reason.trim() })
      toast.success(`PRO ${item.proNumber}: released from OTR invoice ${item.otrInvoiceId}. Send the new invoice to the factor from Receivables.`)
      onDone()
      onClose()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <TmsDialog
      open
      onOpenChange={(next) => { if (!next) onClose() }}
      title={`Release from OTR — PRO ${item.proNumber}`}
      footer={
        <>
          <TmsButton variant="ghost" size="sm" onClick={onClose} disabled={busy}>Cancel</TmsButton>
          <TmsButton variant="primary" size="sm" onClick={() => void release()} disabled={busy || !reason.trim()}>Release from OTR</TmsButton>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p>
          OTR holds invoice {item.otrInvoiceId} as <strong>Dead</strong> and never funded it. Releasing it puts this PRO back in Need to factor so the
          new invoice can be sent to the factor. <strong>Nothing is sent to OTR.</strong> The old OTR invoice id stays on this row's history.
        </p>
        <label className="block">
          <span className="tms-muted">Reason</span>
          <textarea
            id="release-otr-reason"
            className="mt-1 w-full rounded border border-[color:var(--tms-border)] bg-transparent p-2"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why this invoice was deleted at OTR"
          />
        </label>
        {error && <p role="alert" className="text-[color:var(--tms-badge-red)]">{error}</p>}
      </div>
    </TmsDialog>
  )
}
