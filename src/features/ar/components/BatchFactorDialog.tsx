/**
 * Batch Factor: the confirmation, the run, and what happened to each load.
 *
 * Submitting to OTR is outward-facing (OTR advances money on it), so nothing leaves until
 * a person has read the count, the total and the factoring company and pressed Submit.
 * The run itself is `runBatchFactor` (../batchFactor): one load at a time through the
 * existing submit path, each reporting its own result. Only loads that reached OTR with
 * their documents move to Pending with OTR; the rest stay in Ready to invoice with the reason.
 */
import { useState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react'
import { TmsButton, TmsDialog } from '@/features/tms/kit'
import { batchGenerateInvoices, sendToFactor } from '@/lib/apiClient'
import { submitToOtr, uploadOtrDocs } from '@/lib/otrClient'
import { formatCents } from '@/lib/invoiceBuild'
import { BATCH_FACTOR_PAUSE_MS, runBatchFactor, sleep, type BatchFactorOutcome } from '../batchFactor'
import type { ArQueueRow } from '../arQueue'

export function BatchFactorDialog({ rows, factorName, onClose, onDone }: {
  rows: ArQueueRow[]
  /** The factor's remit-to name from AR settings; null when none is configured. */
  factorName: string | null
  onClose: () => void
  /** After a run, whatever happened: the page refreshes. */
  onDone: () => void
}) {
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(0)
  const [results, setResults] = useState<BatchFactorOutcome[] | null>(null)
  const total = rows.reduce((sum, r) => sum + r.amountCents, 0)

  const start = () => {
    setRunning(true)
    runBatchFactor(rows.map((r) => ({
      key: r.key,
      orderId: r.factorItem ? null : r.orderId,
      label: r.shipmentNumber ?? r.orderId,
      invoiceId: r.invoiceId,
      factoringItemId: r.factorItem?.id ?? r.invoice?.factoringItemId ?? null,
      queueStatus: r.factorItem?.status ?? null,
      otrInvoiceId: r.factorItem?.otrInvoiceId ?? null,
    })), {
      generate: (orderIds) => batchGenerateInvoices({ orderIds }),
      sendToFactor: (invoiceId) => sendToFactor({ invoiceId }),
      submit: submitToOtr,
      uploadDocs: uploadOtrDocs,
      pause: sleep(BATCH_FACTOR_PAUSE_MS),
      onProgress: (done) => setProgress(done),
    })
      .then(setResults)
      .finally(() => setRunning(false))
  }

  const sent = results?.filter((r) => r.ok).length ?? 0
  const failed = results?.filter((r) => !r.ok && !('skipped' in r && r.skipped)).length ?? 0

  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open && !running) (results ? onDone : onClose)() }}
      title={results ? 'Batch factor results' : 'Factor loads with OTR'}
      className="tms-dialog-wide"
      footer={results ? (
        <TmsButton variant="primary" onClick={onDone}>Done</TmsButton>
      ) : (
        <>
          <TmsButton variant="ghost" onClick={onClose} disabled={running}>Cancel</TmsButton>
          <TmsButton variant="primary" onClick={start} disabled={running || rows.length === 0 || !factorName} data-testid="batch-factor-submit">
            {running ? `Submitting ${progress} of ${rows.length}…` : `Submit ${rows.length} to OTR`}
          </TmsButton>
        </>
      )}
    >
      {!results && (
        <div className="flex flex-col gap-3 text-sm" data-testid="batch-factor-confirm">
          <dl className="tms-grid tms-grid-3 p-2" style={{ border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)' }}>
            <div><dt className="text-xs tms-muted">Loads</dt><dd className="font-semibold tabular-nums">{rows.length}</dd></div>
            <div><dt className="text-xs tms-muted">Total</dt><dd className="font-semibold tabular-nums">{formatCents(total)}</dd></div>
            <div><dt className="text-xs tms-muted">Factoring company</dt><dd className="font-semibold">{factorName ?? 'Not set up in AR settings'}</dd></div>
          </dl>
          <p>
            Each load gets its invoice (if it has none yet), goes on the OTR queue and is submitted to OTR with its POD and rate
            confirmation, one at a time. Loads that reach OTR move to Pending with OTR. A load that fails stays here with the reason.
          </p>
          <p className="text-xs tms-muted">{rows.map((r) => r.shipmentNumber ?? r.orderId).join(', ')}</p>
          {running && <p className="flex items-center gap-2 tms-muted"><Loader2 size={14} className="animate-spin" /> Sending to OTR — keep this open.</p>}
        </div>
      )}
      {results && (
        <div className="flex flex-col gap-2 text-sm" data-testid="batch-factor-results">
          <p>{sent} sent to OTR{failed ? `, ${failed} failed` : ''}{results.length - sent - failed ? `, ${results.length - sent - failed} skipped` : ''}.</p>
          <ul className="flex flex-col gap-1">
            {results.map((r) => (
              <li key={r.key} className="flex items-start gap-2">
                {r.ok
                  ? <CheckCircle2 size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--tms-badge-green)' }} />
                  : <AlertTriangle size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--tms-badge-red)' }} />}
                <span><strong>{r.label}</strong> — {r.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </TmsDialog>
  )
}
