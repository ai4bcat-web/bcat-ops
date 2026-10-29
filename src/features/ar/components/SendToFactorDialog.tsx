/**
 * Handing an issued invoice to the factor — which, precisely, means writing a row in the
 * OTR queue and nothing else.
 *
 * Submission to OTR is a separate, human action on `/factoring`, and this dialog says so
 * rather than implying the bill has gone anywhere. On dev the OTR secrets are neutered,
 * so the queue row is the entire observable outcome; even on prod it would be, because
 * SEND_TO_FACTOR never calls OTR.
 *
 * The eleven fields are shown read-only. They are prefilled from the invoice snapshot —
 * a human-reviewed document, not a guess — and every one of them stays editable on the
 * queue row, which is the one place that owns them.
 */
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, ArrowRight, CheckCircle2, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog } from '@/features/tms/kit'
import { graphqlErrorText, previewFactor, sendToFactor } from '@/lib/apiClient'
import { OTR_FIELD_LABEL, OTR_REQUIRED_FIELDS } from '@/lib/otrInvoice'
import type { ReleaseGateResult } from '@/lib/releaseGate'

/**
 * What PREVIEW_FACTOR answers. Declared here rather than imported because the client
 * wrapper exports no name for it; a refusal and the eleven prefilled fields are the
 * whole of the contract this dialog needs.
 */
interface FactorPreview {
  ready: boolean
  refusal: string | null
  /** The release gate's verdict, so each thing that is missing is listed on its own. */
  releaseGate?: ReleaseGateResult
  proNumber?: string
  fields?: Record<string, string>
  existing?: { id: string; status: string } | null
}

export function SendToFactorDialog({ invoiceId, busy, onClose, onDone }: {
  invoiceId: string
  busy?: boolean
  onClose: () => void
  onDone: () => void
}) {
  const [preview, setPreview] = useState<FactorPreview | null>(null)
  const [queuedPro, setQueuedPro] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [posting, setPosting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Non-async on purpose: `react-hooks/set-state-in-effect` cannot see through an
  // `async` function, so every state write lives in an explicit promise chain.
  const load = useCallback(() =>
    previewFactor({ invoiceId })
      .then((result) => { setPreview(result); setError(null) })
      .catch((err: unknown) => { setError(graphqlErrorText(err)) })
      .finally(() => setLoading(false)),
  [invoiceId])

  useEffect(() => { load() }, [load])

  const fields = preview?.fields ?? {}
  const disabled = busy === true || posting || loading

  const submit = () => {
    setPosting(true)
    setError(null)
    sendToFactor({ invoiceId })
      .then((result) => {
        setQueuedPro(result.factoringItem.proNumber ?? result.factoringItem.id)
        toast.success(result.reused ? 'Updated the existing queue row' : 'Queue row created')
      })
      .catch((err: unknown) => {
        const text = graphqlErrorText(err)
        setError(text)
        toast.error(text)
      })
      .finally(() => setPosting(false))
  }

  const missing = preview?.releaseGate && !preview.releaseGate.ok ? preview.releaseGate.missing : []

  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title="Send to factor"
      className="tms-dialog-wide"
      footer={
        <>
          <TmsButton variant="ghost" onClick={queuedPro ? onDone : onClose} disabled={posting}>
            {queuedPro ? 'Done' : 'Cancel'}
          </TmsButton>
          {!queuedPro && (
            <TmsButton variant="primary" onClick={submit} disabled={disabled || preview?.ready !== true}>
              {posting ? 'Creating…' : 'Create queue row'}
            </TmsButton>
          )}
        </>
      }
    >
      {loading && (
        <p className="flex items-center gap-2 tms-muted">
          <Loader2 size={14} className="animate-spin" /> Checking the invoice…
        </p>
      )}

      {!loading && preview && !preview.ready && (
        <div
          className="p-2 text-xs"
          style={{ border: '1px solid var(--tms-badge-orange)', borderRadius: 'var(--tms-radius)' }}
        >
          <p className="flex items-start gap-2">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--tms-badge-orange)' }} />
            {preview.refusal ?? 'This invoice cannot be factored.'}
          </p>
          {missing.length > 0 && (
            <ul className="mt-1 list-disc pl-6">
              {missing.map((reason) => <li key={reason.code + (reason.detail ?? '')}>{reason.message}</li>)}
            </ul>
          )}
        </div>
      )}

      {!loading && preview?.ready && (
        <div className="flex flex-col gap-3">
          {queuedPro ? (
            <p
              className="flex items-start gap-2 p-2 text-xs"
              style={{ border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)' }}
            >
              <CheckCircle2 size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--tms-badge-green)' }} />
              Queue row {queuedPro} is ready. Nothing has been submitted to OTR — that is a
              separate step a person takes on the factoring queue.
            </p>
          ) : (
            <p
              className="p-2 text-xs"
              style={{ border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)' }}
            >
              This writes a queue row for PRO <strong>{preview.proNumber}</strong> with the
              fields below. It does not submit anything to OTR.
              {preview.existing && ` A row already exists for this PRO (${preview.existing.status.toLowerCase()}); it will be updated.`}
            </p>
          )}

          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider tms-muted">
              OTR fields — edit these on the queue row
            </p>
            <dl
              className="tms-grid tms-grid-2 mt-1 p-2"
              style={{ border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)' }}
            >
              {OTR_REQUIRED_FIELDS.map((field) => (
                <div key={field} className="flex justify-between gap-2">
                  <dt className="text-xs tms-muted">{OTR_FIELD_LABEL[field]}</dt>
                  <dd className={fields[field] ? 'font-medium' : 'tms-muted'}>
                    {fields[field] || '—'}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          {queuedPro && (
            <Link to="/tms/factors" className="inline-flex items-center gap-1 font-medium">
              Open the factoring queue to submit it to OTR <ArrowRight size={14} />
            </Link>
          )}
        </div>
      )}

      {error && <p className="text-xs" style={{ color: 'var(--tms-badge-red)' }}>{error}</p>}
    </TmsDialog>
  )
}
