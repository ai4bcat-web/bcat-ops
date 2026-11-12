/**
 * Email aging report: shows exactly what will go out (To, CC, subject, attachment, body and the
 * statement PDF) before anything is sent, then sends it. Built from AGING_STATEMENT's preview,
 * so the dialog never guesses at recipients or wording.
 */
import { useEffect, useState } from 'react'
import { Eye, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog } from '@/features/tms/kit'
import { agingStatement, graphqlErrorText, type AgingStatementResult } from '@/lib/apiClient'
import { formatCents } from '@/lib/invoiceBuild'

export function AgingStatementDialog({ customerId, customerName, onClose, onSent }: {
  customerId: string
  customerName: string
  onClose: () => void
  onSent: () => void
}) {
  const [preview, setPreview] = useState<AgingStatementResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  useEffect(() => {
    let alive = true
    agingStatement({ customerId })
      .then((row) => { if (alive) setPreview(row) })
      .catch((err: unknown) => { if (alive) setError(graphqlErrorText(err)) })
    return () => { alive = false }
  }, [customerId])

  const send = () => {
    setSending(true)
    setError(null)
    agingStatement({ customerId, send: true })
      .then((row) => {
        if (row.emailStatus === 'SENT') {
          toast.success(`Aging report sent to ${row.to.join(', ')}`)
          onSent()
        } else {
          setError(row.emailError || `Not sent (${row.emailStatus ?? 'unknown'})`)
        }
      })
      .catch((err: unknown) => setError(graphqlErrorText(err)))
      .finally(() => setSending(false))
  }

  const noTo = preview != null && preview.to.length === 0
  const nothingOpen = preview != null && preview.statement.rows === 0
  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title={`Email aging report — ${customerName}`}
      className="tms-dialog-wide"
      footer={
        <>
          <TmsButton variant="ghost" onClick={onClose} disabled={sending}>Cancel</TmsButton>
          <TmsButton variant="primary" onClick={send} disabled={!preview || sending || noTo || nothingOpen}>
            {sending ? 'Sending…' : 'Send'}
          </TmsButton>
        </>
      }
    >
      {!preview && !error && <p className="flex items-center gap-2 tms-muted"><Loader2 size={14} className="animate-spin" /> Building the statement…</p>}
      {preview && (
        <dl className="grid gap-2 text-sm" style={{ gridTemplateColumns: 'max-content 1fr' }}>
          <dt className="tms-muted">To</dt>
          <dd aria-label="Statement to">{preview.to.join(', ') || <span style={{ color: 'var(--tms-badge-red)' }}>No AP e-mail on file</span>}</dd>
          <dt className="tms-muted">CC</dt>
          <dd aria-label="Statement cc">{preview.cc.join(', ')}</dd>
          <dt className="tms-muted">Subject</dt>
          <dd aria-label="Statement subject">{preview.subject}</dd>
          <dt className="tms-muted">Attachment</dt>
          <dd>
            <a href={preview.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1">
              <Eye size={13} aria-hidden="true" /> {preview.filename}
            </a>
            <span className="tms-muted"> · {preview.statement.rows} open invoice{preview.statement.rows === 1 ? '' : 's'} · {formatCents(preview.statement.totalCents)}</span>
          </dd>
          <dt className="tms-muted">Body</dt>
          <dd aria-label="Statement body" style={{ whiteSpace: 'pre-wrap' }}>{preview.body}</dd>
        </dl>
      )}
      {nothingOpen && <p className="text-xs tms-muted">Nothing is open for this customer.</p>}
      {error && <p className="text-xs" style={{ color: 'var(--tms-badge-red)' }}>{error}</p>}
    </TmsDialog>
  )
}
