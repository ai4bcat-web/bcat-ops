/**
 * "Send to OTR again" for a row OTR turned down. The confirmation says exactly what will be
 * resent and what that does at OTR, because a new submission is something OTR sees.
 *
 *   - never reached OTR (a refused submit): the ordinary submit runs again;
 *   - OTR holds it as Dead: a new invoice is created and the old invoice id is kept on the row;
 *   - OTR holds it as anything else: nothing is created; the status is refreshed and any
 *     document OTR is missing is resent.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog } from '@/features/tms/kit'
import { decideResubmit } from '@/lib/factoringResubmit'
import { invoiceAmountOf, money } from './factoringTotals'
import { resubmitToOtr, submitToOtr } from '@/lib/otrClient'
import { errorText } from '@/lib/errorText'
import { otrStatusMeta } from '@/lib/otrInvoiceStatus'
import { otrDocsErrorMessage } from '@/lib/otrSubmitOutcome'
import type { FactoringItem } from '@/types'

export function ResendToOtrDialog({ item, onClose, onDone }: { item: FactoringItem; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const decision = decideResubmit(item)
  const kind = decision.ok ? decision.kind : null
  const amount = invoiceAmountOf(item)
  const meta = otrStatusMeta(item.otrStatus)

  async function send() {
    setBusy(true)
    setError(null)
    try {
      if (kind === 'SUBMIT') {
        const r = await submitToOtr(item.id)
        if (r.documentErrors.length) toast.error(otrDocsErrorMessage(r.documentErrors))
        else toast.success(`PRO ${item.proNumber}: sent to OTR with its documents`)
      } else {
        const r = await resubmitToOtr(item.id)
        if (r.documentErrors.length) toast.error(otrDocsErrorMessage(r.documentErrors))
        else if (r.outcome === 'REPLACED') toast.success(`PRO ${item.proNumber}: new OTR invoice ${r.invoiceId} (replaces ${r.oldInvoiceId})`)
        else toast.success(`PRO ${item.proNumber}: refreshed from OTR${r.otrStatus ? ` (${otrStatusMeta(r.otrStatus)?.label ?? r.otrStatus})` : ''}`)
      }
      onDone()
      onClose()
    } catch (e) {
      setError(errorText(e))
      onDone()
    } finally {
      setBusy(false)
    }
  }

  return (
    <TmsDialog
      open
      onOpenChange={(next) => { if (!next) onClose() }}
      title={`Send to OTR again — PRO ${item.proNumber}`}
      footer={
        <>
          <TmsButton variant="ghost" size="sm" onClick={onClose} disabled={busy}>Cancel</TmsButton>
          <TmsButton variant="primary" size="sm" onClick={() => void send()} disabled={busy || !decision.ok}>
            {kind === 'REFRESH' ? 'Refresh from OTR' : 'Send to OTR again'}
          </TmsButton>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        {!decision.ok && <p role="alert" className="text-[color:var(--tms-badge-red)]">{decision.reason}</p>}
        {item.otrError?.trim() && <p><strong>OTR said:</strong> {item.otrError}</p>}
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="tms-muted">PRO</dt><dd>{item.proNumber}</dd>
          <dt className="tms-muted">Amount</dt><dd>{amount == null ? 'No rate yet' : money(amount)}</dd>
          {item.otrInvoiceId && <><dt className="tms-muted">OTR invoice</dt><dd>{item.otrInvoiceId}{meta ? ` (${meta.label} at OTR)` : ''}</dd></>}
        </dl>
        {kind === 'SUBMIT' && <p>This invoice never reached OTR. It will be submitted again with its POD and rate confirmation, the same as the first time.</p>}
        {kind === 'REPLACE_DEAD' && (
          <>
            <p>
              OTR holds invoice {item.otrInvoiceId} as <strong>Dead</strong>, so it will not be funded. This reads OTR's status again first, and
              only if it is still Dead it creates a <strong>new invoice at OTR</strong> for this PRO with its POD and rate confirmation. The old invoice
              id stays on this row's history.
            </p>
            <p className="tms-muted">If OTR answers with the same invoice again, nothing is created and nothing changes here. OTR would then have to reopen or void the Dead one.</p>
          </>
        )}
        {kind === 'REFRESH' && (
          <p>OTR is still holding invoice {item.otrInvoiceId}, so nothing new is created. This pulls its current status and resends any document OTR is missing.</p>
        )}
        {error && <p role="alert" className="text-[color:var(--tms-badge-red)]">{error}</p>}
      </div>
    </TmsDialog>
  )
}
