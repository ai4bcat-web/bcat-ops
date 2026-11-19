/**
 * Batch Factor: the review, the run, and what happened to each load.
 *
 * Review before sending (Ryne 2026-11-18), the same flow as reviewing invoices: one load per page, left and right
 * (buttons and arrow keys), each page showing the customer's rate confirmation and the POD, the two documents OTR
 * receives. A page with a document missing says so and is left out of the send; Skip takes a load out too. Only
 * then does "Send N to OTR" run the batch.
 *
 * Submitting to OTR is outward-facing (OTR advances money on it), so nothing leaves until
 * a person has read the count, the total and the factoring company and pressed Submit.
 * The run itself is `runBatchFactor` (../batchFactor): one load at a time through the
 * existing submit path, each reporting its own result. Only loads that reached OTR with
 * their documents move to Pending with OTR; the rest stay in Ready to invoice with the reason.
 */
import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Loader2, X } from 'lucide-react'
import { TmsBadge, TmsButton, TmsDialog } from '@/features/tms/kit'
import { batchGenerateInvoices, sendToFactor } from '@/lib/apiClient'
import { previewOtrDocs, submitToOtr, uploadOtrDocs, type OtrDocLink } from '@/lib/otrClient'
import { formatCents } from '@/lib/invoiceBuild'
import { BATCH_FACTOR_PAUSE_MS, runBatchFactor, sleep, type BatchFactorOutcome } from '../batchFactor'
import type { ArQueueRow } from '../arQueue'
import './invoiceEmail.css'

/** What the review found for one load: still looking, the two documents, or why it could not look. */
type DocLook = { state: 'loading' } | { state: 'ready'; pod: OtrDocLink | null; rateCon: OtrDocLink | null } | { state: 'error'; message: string }

/** A document the review positively found missing: that load is left out of the send. */
const missingDocs = (look: DocLook | undefined): string[] =>
  look?.state === 'ready' ? [...(look.rateCon ? [] : ['Rate confirmation']), ...(look.pod ? [] : ['POD'])] : []

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
  const [batch, setBatch] = useState<ArQueueRow[]>(rows)
  const [index, setIndex] = useState(0)
  const [looks, setLooks] = useState<Record<string, DocLook>>({})
  const current = batch[Math.min(index, batch.length - 1)]
  const lookOf = (r: ArQueueRow) => looks[r.key]
  const blocked = batch.filter((r) => missingDocs(lookOf(r)).length > 0)
  const sendable = batch.filter((r) => missingDocs(lookOf(r)).length === 0)
  const total = sendable.reduce((sum, r) => sum + r.amountCents, 0)

  // The page being looked at fetches its two documents once (the links last ten minutes; Back-and-forth reuses them).
  const currentKey = current?.key
  useEffect(() => {
    if (!current || looks[current.key]) return
    let alive = true
    const key = current.key
    const ref = current.factorItem ? { id: current.factorItem.id } : { pro: current.shipmentNumber ?? '' }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLooks((prev) => ({ ...prev, [key]: { state: 'loading' } }))
    previewOtrDocs(ref)
      .then((r) => { if (alive) setLooks((prev) => ({ ...prev, [key]: { state: 'ready', pod: r.pod, rateCon: r.rateCon } })) })
      .catch((err: unknown) => { if (alive) setLooks((prev) => ({ ...prev, [key]: { state: 'error', message: err instanceof Error ? err.message : String(err) } })) })
    return () => { alive = false }
    // current is read for its key and PRO only; the look is cached per key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey])

  const go = useCallback((delta: number) => setIndex((i) => Math.max(0, Math.min(batch.length - 1, i + delta))), [batch.length])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.tagName === 'SELECT') return
      if (e.key === 'ArrowLeft') go(-1)
      if (e.key === 'ArrowRight') go(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go])
  const skip = () => {
    setBatch((list) => list.filter((r) => r.key !== current?.key))
    setIndex((i) => Math.max(0, Math.min(i, batch.length - 2)))
  }

  const start = () => {
    setRunning(true)
    runBatchFactor(sendable.map((r) => ({
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
      title={results ? 'Batch factor results' : 'Review and send to OTR'}
      className="tms-dialog-wide send-review-dialog"
      footer={results ? (
        <TmsButton variant="primary" onClick={onDone}>Done</TmsButton>
      ) : (
        <>
          <TmsButton variant="ghost" onClick={onClose} disabled={running}>Cancel</TmsButton>
          <TmsButton variant="primary" onClick={start} disabled={running || sendable.length === 0 || !factorName} data-testid="batch-factor-submit">
            {running ? `Submitting ${progress} of ${sendable.length}…` : `Send ${sendable.length} to OTR`}
          </TmsButton>
        </>
      )}
    >
      {!results && (
        <div className="flex flex-col gap-3 text-sm" data-testid="batch-factor-confirm">
          <dl className="tms-grid tms-grid-3 p-2" style={{ border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)' }}>
            <div><dt className="text-xs tms-muted">Loads</dt><dd className="font-semibold tabular-nums">{sendable.length}</dd></div>
            <div><dt className="text-xs tms-muted">Total</dt><dd className="font-semibold tabular-nums">{formatCents(total)}</dd></div>
            <div><dt className="text-xs tms-muted">Factoring company</dt><dd className="font-semibold">{factorName ?? 'Not set up in AR settings'}</dd></div>
          </dl>
          {blocked.length > 0 && (
            <p role="status" style={{ color: 'var(--tms-badge-red)' }}>
              <TmsBadge tone="red">{blocked.length} missing a document</TmsBadge> {blocked.map((r) => r.shipmentNumber ?? r.orderId).join(', ')} — left out of the send.
            </p>
          )}
          {!current ? <p className="tms-muted">Nothing left in this batch.</p> : (
            <div className="flex flex-col gap-3">
              <div className="send-review-head">
                <span className="send-review-nav">
                  <TmsButton size="sm" variant="ghost" aria-label="Previous load" disabled={index === 0 || running} onClick={() => go(-1)}><ChevronLeft size={16} /></TmsButton>
                  <span aria-label="Page" className="send-review-page">{index + 1} of {batch.length}</span>
                  <TmsButton size="sm" variant="ghost" aria-label="Next load" disabled={index >= batch.length - 1 || running} onClick={() => go(1)}><ChevronRight size={16} /></TmsButton>
                </span>
                <span className="send-review-id">
                  <span className="send-review-number">PRO {current.shipmentNumber ?? current.orderId}</span>
                  <span className="send-review-meta">
                    <span>{current.customerName}</span>
                    <span aria-hidden="true">·</span>
                    <span className="send-review-amount">{formatCents(current.amountCents)}</span>
                  </span>
                </span>
                <span className="send-review-actions">
                  <TmsButton size="sm" variant="ghost" aria-label={`Skip ${current.shipmentNumber ?? current.orderId}`} disabled={running} onClick={skip}><X size={13} /> Skip this one</TmsButton>
                </span>
              </div>
              {lookOf(current)?.state === 'error' && (
                <p role="alert" style={{ color: 'var(--tms-badge-orange)' }}>
                  <AlertTriangle size={14} className="inline" /> Could not load the documents to preview ({(lookOf(current) as { message: string }).message}). It was checked as ready to factor, so it can still go.
                </p>
              )}
              {missingDocs(lookOf(current)).length > 0 && (
                <div role="alert" aria-label="Cannot send" className="send-review-blockers">
                  <AlertTriangle size={16} style={{ flex: 'none', marginTop: 1 }} />
                  <span><strong>Will not be sent:</strong> no {missingDocs(lookOf(current)).join(' or ')} on file. Add it, or Skip it — the rest still go.</span>
                </div>
              )}
              <div className="send-review-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
                <DocPane title="Customer rate confirmation" look={lookOf(current)} pick={(l) => l.rateCon} />
                <DocPane title="POD" look={lookOf(current)} pick={(l) => l.pod} />
              </div>
              <p className="text-xs tms-muted">
                OTR receives these two documents only. Nothing leaves until you press Send; each load is then submitted one at a time and moves to Pending with OTR.
              </p>
            </div>
          )}
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

/** One document of the pair OTR receives, shown as the file itself. */
function DocPane({ title, look, pick }: {
  title: string
  look: DocLook | undefined
  pick: (look: Extract<DocLook, { state: 'ready' }>) => OtrDocLink | null
}) {
  const doc = look?.state === 'ready' ? pick(look) : null
  return (
    <section className="send-review-col" aria-label={title}>
      <div className="flex items-center gap-2 text-sm">
        <strong>{title}</strong>
        {look?.state === 'ready' && (doc ? <TmsBadge tone="green">On file</TmsBadge> : <TmsBadge tone="red">Missing</TmsBadge>)}
        {doc && <span className="tms-muted truncate">{doc.name}</span>}
      </div>
      {(!look || look.state === 'loading') && <p className="flex items-center gap-2 text-sm tms-muted"><Loader2 size={14} className="animate-spin" /> Loading…</p>}
      {doc && <iframe title={`${title} preview`} src={doc.url} style={{ width: '100%', height: 560, border: '1px solid var(--tms-border)' }} />}
      {look?.state === 'ready' && !doc && <p className="text-sm tms-muted">Nothing on file to send.</p>}
    </section>
  )
}
